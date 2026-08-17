import { mkdir } from "node:fs/promises"
import path from "node:path"

type SqliteStatement = {
  all: (...params: unknown[]) => unknown[]
  run: (...params: unknown[]) => unknown
}

type SqliteDatabase = {
  exec: (sql: string) => void
  prepare: (sql: string) => SqliteStatement
  close: () => void
}

export type MemoryFtsEntry = {
  id: string
  kind: string
  sessionID?: string
  sourcePath?: string
  title: string
  body: string
  keywords: string[]
}

export type MemoryFtsHit = {
  id: string
  snippet?: string
  score: number
}

const CREATE_MEMORY_FTS = `
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    id UNINDEXED,
    kind UNINDEXED,
    session_id UNINDEXED,
    source_path UNINDEXED,
    title,
    body,
    keywords
  );
`

const rebuildLocks = new Map<string, Promise<void>>()

function databasePath(directory: string | undefined) {
  if (!directory?.trim()) return
  return path.join(path.resolve(directory), ".deveagent", "memory", "index.sqlite")
}

function isBunRuntime() {
  return Boolean((process.versions as Record<string, string | undefined>).bun)
}

async function openDatabase(file: string): Promise<SqliteDatabase | undefined> {
  try {
    await mkdir(path.dirname(file), { recursive: true })
    if (isBunRuntime()) {
      const moduleName = ["bun", "sqlite"].join(":")
      const sqlite = await import(moduleName) as unknown as {
        Database?: new (file: string) => { exec: (sql: string) => void; query: (sql: string) => { all: (...params: unknown[]) => unknown[]; run: (...params: unknown[]) => unknown }; close: () => void }
      }
      if (!sqlite.Database) return
      const database = new sqlite.Database(file)
      database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;")
      database.exec(CREATE_MEMORY_FTS)
      return {
        exec: database.exec.bind(database),
        prepare: (sql) => database.query(sql),
        close: database.close.bind(database),
      }
    }

    const moduleName = ["node", "sqlite"].join(":")
    const sqlite = await import(moduleName) as unknown as { DatabaseSync?: new (file: string) => SqliteDatabase }
    if (!sqlite.DatabaseSync) return
    const database = new sqlite.DatabaseSync(file)
    database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;")
    database.exec(CREATE_MEMORY_FTS)
    return database
  } catch {
    // ponytail: search must keep working when an older packaged Node lacks SQLite.
    return
  }
}

async function rebuildNow(file: string, entries: MemoryFtsEntry[]) {
  const database = await openDatabase(file)
  if (!database) return
  try {
    database.exec("BEGIN IMMEDIATE; DELETE FROM memory_fts;")
    const insert = database.prepare(
      "INSERT INTO memory_fts(id, kind, session_id, source_path, title, body, keywords) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    for (const entry of entries) {
      insert.run(
        entry.id,
        entry.kind,
        entry.sessionID ?? "",
        entry.sourcePath ?? "",
        entry.title,
        entry.body,
        entry.keywords.join(" "),
      )
    }
    database.exec("COMMIT;")
  } catch {
    try { database.exec("ROLLBACK;") } catch { /* ignore a failed transaction */ }
  } finally {
    database.close()
  }
}

export async function rebuildDeveAgentMemoryFts(directory: string | undefined, entries: MemoryFtsEntry[]) {
  const file = databasePath(directory)
  if (!file) return
  const previous = rebuildLocks.get(file) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(() => rebuildNow(file, entries))
  rebuildLocks.set(file, current)
  try {
    await current
  } finally {
    if (rebuildLocks.get(file) === current) rebuildLocks.delete(file)
  }
}

function ftsTokens(query: string) {
  const words = query
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}_]+/gu)
    ?.map((token) => token.trim())
    .filter(Boolean) ?? []
  return words.flatMap((word) => {
    if (/\p{Script=Han}/u.test(word)) {
      const bigrams = Array.from({ length: Math.max(0, word.length - 1) }, (_, index) => word.slice(index, index + 2))
      return bigrams.length > 0 ? bigrams : [word]
    }
    return word.length >= 2 ? [word] : []
  }).slice(0, 32)
}

export async function searchDeveAgentMemoryFts(directory: string | undefined, query: string, limit: number): Promise<MemoryFtsHit[] | undefined> {
  const file = databasePath(directory)
  const tokens = ftsTokens(query)
  if (!file || tokens.length === 0) return
  await rebuildLocks.get(file)?.catch(() => undefined)
  const database = await openDatabase(file)
  if (!database) return
  try {
    const expression = tokens.map((token) => `"${token.replaceAll('"', "")}"`).join(" OR ")
    const rows = database.prepare(
      "SELECT id, snippet(memory_fts, 5, '<<', '>>', '...', 32) AS snippet, bm25(memory_fts, 0, 0, 0, 0, 5, 1, 2) AS score FROM memory_fts WHERE memory_fts MATCH ? ORDER BY score LIMIT ?",
    ).all(expression, Math.max(1, Math.min(limit, 400))) as Record<string, unknown>[]
    const hits = rows.flatMap((row) => typeof row.id === "string" ? [{
      id: row.id,
      snippet: typeof row.snippet === "string" ? row.snippet : undefined,
      score: typeof row.score === "number" ? Math.max(0, -row.score) : 0,
    }] : [])
    if (hits.length === 0) return []
    const topScore = hits[0].score
    if (topScore <= 0) return hits
    const cutoff = topScore * 0.15
    return hits.filter((hit, index) => index === 0 || hit.score >= cutoff)
  } catch {
    return
  } finally {
    database.close()
  }
}

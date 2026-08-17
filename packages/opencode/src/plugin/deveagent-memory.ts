import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { rebuildDeveAgentMemoryFts, searchDeveAgentMemoryFts } from "./deveagent-memory-fts"

export type DeveAgentMemoryKind =
  | "task"
  | "decision"
  | "bug"
  | "summary"
  | "skill-candidate"
  | "project"
  | "checkpoint"
  | "notes"
  | "progress"

export type DeveAgentMemoryScope = "workspace" | "session" | "task"

export type DeveAgentMemoryEntry = {
  id: string
  kind: DeveAgentMemoryKind
  title: string
  summary: string
  snippet?: string
  keywords: string[]
  sessionID?: string
  sourcePath?: string
  createdAt: number
  updatedAt: number
}

export type DeveAgentMemoryTree = {
  entries: DeveAgentMemoryEntry[]
  groups: { kind: DeveAgentMemoryKind; label: string; entries: DeveAgentMemoryEntry[] }[]
}

export type DeveAgentMemoryContext = {
  context: string
  entries: number
  tokenEstimate: number
  retainedMessages: number
}

export type DeveAgentMemoryTranscriptMessage = {
  role: string
  text: string
}

const MAX_ENTRIES = 400
const GROUPS: { kind: DeveAgentMemoryKind; label: string }[] = [
  { kind: "decision", label: "Decisions" },
  { kind: "bug", label: "Bug History" },
  { kind: "summary", label: "Session Summaries" },
  { kind: "task", label: "Task Notes" },
  { kind: "project", label: "Project Memory" },
  { kind: "checkpoint", label: "Session Checkpoints" },
  { kind: "notes", label: "Session Notes" },
  { kind: "progress", label: "Task Progress" },
  { kind: "skill-candidate", label: "Skill Candidates (review required)" },
]

const MEMORY_DOCUMENT_MAX_BYTES = 48 * 1024
const MEMORY_DOCUMENT_TOTAL_BYTES = 160 * 1024
const MEMORY_DOCUMENT_MAX_COUNT = 96
const MEMORY_QUERY_DEFAULT_TOKEN_BUDGET = 1_200
const MEMORY_CONSOLIDATION_DEFAULT_LIMIT = 24

const PROJECT_MEMORY_TEMPLATE = `# Project memory

## Project context

## Rules

## Architecture decisions

## Discovered durable knowledge
`

const NOTES_TEMPLATE = `# Session notes
`

function memoryFile(directory?: string) {
  if (!directory?.trim()) return
  return path.join(path.resolve(directory.trim()), ".deveagent", "memory", "index.json")
}

function memoryRoot(directory?: string) {
  if (!directory?.trim()) return
  return path.join(path.resolve(directory.trim()), ".deveagent", "memory")
}

function safeSessionID(sessionID?: string) {
  return (sessionID || "session").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120) || "session"
}

function sessionMemoryRoot(directory: string | undefined, sessionID?: string) {
  const root = memoryRoot(directory)
  return root ? path.join(root, "sessions", safeSessionID(sessionID)) : undefined
}

function taskMemoryRoot(directory: string | undefined, sessionID: string | undefined, taskID: string) {
  const root = sessionMemoryRoot(directory, sessionID)
  return root ? path.join(root, "tasks", safeSessionID(taskID)) : undefined
}

function compactMarkdown(value: string, limit: number) {
  return value
    .replace(/\u0000/g, "")
    .replace(/^\s*```[\s\S]*?```\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit)
}

type MemoryDocumentSpec = {
  filePath: string
  kind: Extract<DeveAgentMemoryKind, "project" | "checkpoint" | "notes" | "progress">
  title: string
  sessionID?: string
}

async function readMemoryDocuments(directory?: string): Promise<DeveAgentMemoryEntry[]> {
  const root = memoryRoot(directory)
  if (!root) return []
  const specs: MemoryDocumentSpec[] = []
  const seen = new Set<string>()
  const addSpec = (filePath: string) => {
    if (specs.length >= MEMORY_DOCUMENT_MAX_COUNT || seen.has(filePath)) return
    const relative = path.relative(root, filePath)
    const parts = relative.split(path.sep)
    const sessionID = parts[0] === "sessions" && parts[1] ? parts[1] : undefined
    let kind: MemoryDocumentSpec["kind"] = "project"
    let title = `Memory ${relative}`
    if (relative === "MEMORY.md") {
      title = "Project memory"
    } else if (parts[0] === "sessions" && parts[2] === "checkpoint.md") {
      kind = "checkpoint"
      title = `Checkpoint ${sessionID}`
    } else if (parts[0] === "sessions" && parts[2] === "notes.md") {
      kind = "notes"
      title = `Notes ${sessionID}`
    } else if (parts[0] === "sessions" && parts[2] === "tasks" && parts[4] === "progress.md") {
      kind = "progress"
      title = `Task progress ${parts[3]}`
    }
    seen.add(filePath)
    specs.push({ filePath, kind, title, sessionID })
  }

  // MiMo-style memory is a Markdown tree, not only a fixed set of filenames.
  // Keep the walk bounded and ignore symlinks so user-added notes are searchable
  // without turning memory retrieval into an unbounded filesystem scan.
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > 5 || specs.length >= MEMORY_DOCUMENT_MAX_COUNT) return
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (specs.length >= MEMORY_DOCUMENT_MAX_COUNT || entry.isSymbolicLink()) break
      const filePath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(filePath, depth + 1)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        addSpec(filePath)
      }
    }
  }
  await walk(root, 0)

  let totalBytes = 0
  const entries: DeveAgentMemoryEntry[] = []
  for (const spec of specs) {
    try {
      const metadata = await stat(spec.filePath)
      if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MEMORY_DOCUMENT_MAX_BYTES) continue
      if (totalBytes + metadata.size > MEMORY_DOCUMENT_TOTAL_BYTES) continue
      const body = await readFile(spec.filePath, "utf8")
      // The JSON index owns generated durable bullets; keep MEMORY.md here for
      // human-authored project context so consolidation cannot double-inject it.
      const documentBody = spec.kind === "project" ? body.replace(/\n## Discovered durable knowledge[\s\S]*$/i, "") : body
      const summary = compactMarkdown(documentBody.replace(/^#.*$/m, ""), 500)
      if (!summary || /^(none yet|none)$/i.test(summary)) continue
      totalBytes += metadata.size
      entries.push({
        id: `memory-document-${spec.kind}-${spec.filePath}`,
        kind: spec.kind,
        title: spec.title,
        summary,
        keywords: keywords(`${spec.title} ${documentBody}`, 8_000),
        sessionID: spec.sessionID,
        sourcePath: path.relative(path.resolve(directory!), spec.filePath).replace(/\\/g, "/"),
        createdAt: metadata.birthtimeMs || metadata.mtimeMs,
        updatedAt: metadata.mtimeMs,
      })
    } catch {
      // ponytail: a missing optional Markdown source must not block the main turn
    }
  }
  return entries
}

async function writeMemoryDocument(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temp, content.slice(0, MEMORY_DOCUMENT_MAX_BYTES), "utf8")
  await rename(temp, filePath)
}

function replaceMarkdownSection(content: string, heading: string, replacement: string) {
  const start = content.indexOf(heading)
  if (start === -1) return `${content.trimEnd()}\n\n${replacement}\n`
  const bodyStart = start + heading.length
  const nextHeading = content.indexOf("\n## ", bodyStart)
  return `${content.slice(0, start)}${replacement}${nextHeading === -1 ? "\n" : content.slice(nextHeading)}`
}

/**
 * Consolidate reviewed index entries into the human-readable project memory.
 * The JSON index remains the source of truth, so this operation is repeatable.
 */
export async function consolidateDeveAgentMemory(input: { directory?: string; limit?: number }) {
  const root = memoryRoot(input.directory)
  if (!root) return { consolidated: false as const, reason: "workspace-required" as const }
  await ensureDeveAgentMemoryScaffold(input.directory)
  const file = path.join(root, "MEMORY.md")
  const current = await readFile(file, "utf8").catch(() => PROJECT_MEMORY_TEMPLATE)
  const limit = Math.max(1, Math.min(input.limit ?? MEMORY_CONSOLIDATION_DEFAULT_LIMIT, 40))
  const durableKinds = new Set<DeveAgentMemoryKind>(["decision", "bug", "project", "summary"])
  const entries = (await readEntries(input.directory))
    .filter((entry) => durableKinds.has(entry.kind))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, limit)
  const section = [
    "## Discovered durable knowledge",
    "",
    entries.length > 0
      ? entries.map((entry) => `- [${entry.kind}] ${entry.title}: ${entry.summary}`).join("\n")
      : "- No reviewed durable entries yet.",
  ].join("\n")
  const next = replaceMarkdownSection(current, "## Discovered durable knowledge", section)
  await writeMemoryDocument(file, next)
  return {
    consolidated: true as const,
    path: file,
    entries: entries.length,
    sourceIDs: entries.map((entry) => entry.id),
  }
}

export async function ensureDeveAgentMemoryScaffold(directory?: string) {
  const root = memoryRoot(directory)
  if (!root) return { created: false as const }
  const file = path.join(root, "MEMORY.md")
  try {
    if (await stat(file).then((value) => value.isFile()).catch(() => false)) return { created: false as const, path: file }
    await writeMemoryDocument(file, PROJECT_MEMORY_TEMPLATE)
    return { created: true as const, path: file }
  } catch {
    return { created: false as const }
  }
}

export async function writeDeveAgentMemoryCheckpoint(input: {
  directory?: string
  sessionID: string
  summary: string
  nextAction?: string
}) {
  const root = sessionMemoryRoot(input.directory, input.sessionID)
  if (!root || !input.summary.trim()) return { written: false as const }
  const content = [
    "# Session checkpoint",
    "",
    "## Active intent",
    input.nextAction?.trim() || "Continue the current task.",
    "",
    "## Current summary",
    input.summary.trim(),
    "",
    "## Next action",
    input.nextAction?.trim() || "Inspect the checkpoint and continue with the next verifiable step.",
    "",
    "## Updated",
    new Date().toISOString(),
    "",
  ].join("\n")
  await writeMemoryDocument(path.join(root, "checkpoint.md"), content)
  return { written: true as const, path: path.join(root, "checkpoint.md") }
}

export async function appendDeveAgentMemoryNote(input: { directory?: string; sessionID: string; text: string }) {
  const root = sessionMemoryRoot(input.directory, input.sessionID)
  const text = compactMarkdown(input.text, 2_000)
  if (!root || !text) return { written: false as const }
  const file = path.join(root, "notes.md")
  let current = NOTES_TEMPLATE
  try { current = await readFile(file, "utf8") } catch { /* create on first note */ }
  const next = `${current.trimEnd()}\n\n## ${new Date().toISOString()}\n${text}\n`
  const body = next.length > MEMORY_DOCUMENT_MAX_BYTES ? `${NOTES_TEMPLATE}\n${next.slice(-MEMORY_DOCUMENT_MAX_BYTES + NOTES_TEMPLATE.length)}` : next
  await writeMemoryDocument(file, body)
  return { written: true as const, path: file }
}

export async function writeDeveAgentMemoryProgress(input: {
  directory?: string
  sessionID: string
  taskID: string
  status: "in_progress" | "completed" | "failed" | "blocked"
  summary: string
  nextAction?: string
  criteria?: string[]
}) {
  const root = taskMemoryRoot(input.directory, input.sessionID, input.taskID)
  const summary = compactMarkdown(input.summary, 2_000)
  if (!root || !summary) return { written: false as const }
  const file = path.join(root, "progress.md")
  const previous = await readFile(file, "utf8").catch(() => "")
  const previousCriteria = previous.match(/\n## Task tree\n([\s\S]*?)(?=\n## Step history|$)/)?.[1]
    ?.split("\n")
    .map((line) => line.match(/^- \[[ x]\] (.+)$/)?.[1])
    .filter((value): value is string => Boolean(value)) ?? []
  const criteria = (input.criteria?.length ? input.criteria : previousCriteria)
    .map((value) => compactMarkdown(value, 240))
    .filter(Boolean)
    .slice(0, 10)
  const previousHistory = previous.match(/\n## Step history\n([\s\S]*)$/)?.[1]
    ?.split("\n")
    .filter((line) => line.startsWith("- "))
    .slice(-7) ?? []
  const history = [...previousHistory, `- ${new Date().toISOString()} [${input.status}] ${summary}`].slice(-8)
  const content = [
    "# Task progress",
    "",
    `- Status: ${input.status}`,
    `- Updated: ${new Date().toISOString()}`,
    "",
    "## Summary",
    summary,
    "",
    "## Next action",
    compactMarkdown(input.nextAction || "Inspect the current result and continue with the next verifiable step.", 500),
    "",
    "## Task tree",
    ...(criteria.length > 0
      ? criteria.map((criterion) => `- [${input.status === "completed" ? "x" : " "}] ${criterion}`)
      : ["- No acceptance criteria recorded."]),
    "",
    "## Step history",
    ...history,
    "",
  ].join("\n")
  await writeMemoryDocument(file, content)
  return { written: true as const, path: file }
}

function compact(value: string, limit: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, limit)
}

function keywords(value: string, sourceLimit = 800) {
  const text = compact(value.toLocaleLowerCase(), sourceLimit)
  const output = new Set<string>()
  for (const word of text.match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(word)) {
      for (let index = 0; index < word.length - 1; index++) output.add(word.slice(index, index + 2))
      if (word.length === 1) output.add(word)
    } else if (word.length >= 2) {
      output.add(word)
    }
  }
  return [...output].slice(0, 32)
}

function memorySourceFile(directory: string | undefined, sourcePath: string | undefined) {
  if (!directory?.trim() || !sourcePath) return
  const workspace = path.resolve(directory)
  const memory = path.join(workspace, ".deveagent", "memory")
  const file = path.resolve(workspace, sourcePath)
  return file.startsWith(`${memory}${path.sep}`) && file.toLowerCase().endsWith(".md") ? file : undefined
}

async function withMemorySnippet(entry: DeveAgentMemoryEntry, directory: string | undefined, query: string) {
  const file = memorySourceFile(directory, entry.sourcePath)
  if (!file || !query.trim()) return entry
  try {
    const body = await readFile(file, "utf8")
    const lower = body.toLocaleLowerCase()
    const position = keywords(query, 800)
      .map((term) => lower.indexOf(term.toLocaleLowerCase()))
      .filter((value) => value >= 0)
      .sort((left, right) => left - right)[0]
    if (position === undefined) return entry
    const start = Math.max(0, position - 120)
    const end = Math.min(body.length, position + 300)
    const snippet = compactMarkdown(body.slice(start, end), 360)
    if (!snippet) return entry
    return { ...entry, snippet: `${start > 0 ? "... " : ""}${snippet}${end < body.length ? " ..." : ""}` }
  } catch {
    // ponytail: a deleted or unreadable note falls back to its indexed summary.
    return entry
  }
}

function validKind(value: unknown): value is DeveAgentMemoryKind {
  return value === "task" || value === "decision" || value === "bug" || value === "summary" || value === "skill-candidate" || value === "project" || value === "checkpoint" || value === "notes" || value === "progress"
}

function memoryScope(entry: DeveAgentMemoryEntry): DeveAgentMemoryScope {
  if (entry.kind === "progress") return "task"
  if (entry.sessionID) return "session"
  return "workspace"
}

function normalizeEntry(value: unknown): DeveAgentMemoryEntry | undefined {
  if (!value || typeof value !== "object") return
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== "string" || !validKind(raw.kind) || typeof raw.title !== "string" || typeof raw.summary !== "string") return
  const createdAt = typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now()
  const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt
  return {
    id: raw.id.slice(0, 100),
    kind: raw.kind,
    title: compact(raw.title, 120),
    summary: compact(raw.summary, 500),
    keywords: Array.isArray(raw.keywords) ? raw.keywords.filter((item): item is string => typeof item === "string").map((item) => compact(item, 40)).slice(0, 32) : keywords(`${raw.title} ${raw.summary}`),
    sessionID: typeof raw.sessionID === "string" ? raw.sessionID.slice(0, 160) : undefined,
    sourcePath: typeof raw.sourcePath === "string" ? raw.sourcePath.slice(0, 240) : undefined,
    createdAt,
    updatedAt,
  }
}

async function readEntries(directory?: string) {
  const file = memoryFile(directory)
  if (!file) return []
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { entries?: unknown }
    return Array.isArray(parsed.entries) ? parsed.entries.flatMap((entry) => {
      const normalized = normalizeEntry(entry)
      return normalized ? [normalized] : []
    }) : []
  } catch {
    return []
  }
}

async function writeEntries(directory: string | undefined, entries: DeveAgentMemoryEntry[]) {
  const file = memoryFile(directory)
  if (!file) return
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify({ version: 1, entries: entries.slice(0, MAX_ENTRIES) }), "utf8")
  await rename(temp, file)
}

/**
 * Reconcile editable Markdown memory into the bounded JSON read model.
 * Markdown remains the user-visible source; the index only serves search/UI.
 */
export async function reconcileDeveAgentMemory(directory?: string) {
  const root = memoryRoot(directory)
  if (!root) return { reconciled: false as const, reason: "workspace-required" as const }
  await ensureDeveAgentMemoryScaffold(directory)
  const [documents, existing] = await Promise.all([
    readMemoryDocuments(directory),
    readEntries(directory),
  ])
  const documentIDs = new Set(documents.map((document) => document.id))
  const pruned = existing.filter((entry) => entry.id.startsWith("memory-document-") && !documentIDs.has(entry.id)).length
  const merged = [...documents, ...existing.filter((entry) => !entry.id.startsWith("memory-document-"))]
    .sort((left, right) => right.updatedAt - left.updatedAt)
  await writeEntries(directory, merged)
  await rebuildDeveAgentMemoryFts(directory, merged.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    sessionID: entry.sessionID,
    sourcePath: entry.sourcePath,
    title: entry.title,
    body: entry.summary,
    keywords: entry.keywords,
  })))
  return { reconciled: true as const, indexed: documents.length, pruned }
}

function overlap(left: string[], right: string[]) {
  const set = new Set(left)
  return right.reduce((count, item) => count + (set.has(item) ? 1 : 0), 0)
}

function candidateFor(entry: DeveAgentMemoryEntry, entries: DeveAgentMemoryEntry[]) {
  if (entry.kind !== "task") return
  const similar = entries.filter((item) => item.kind === "task" && item.id !== entry.id && overlap(entry.keywords, item.keywords) >= 2)
  if (similar.length < 2) return
  const title = `Recurring workflow: ${entry.keywords.slice(0, 3).join(", ") || entry.title}`
  if (entries.some((item) => item.kind === "skill-candidate" && item.title === title)) return
  return {
    id: `memory-${randomUUID()}`,
    kind: "skill-candidate" as const,
    title: compact(title, 120),
    summary: "Repeated task pattern detected. Review this candidate before creating or enabling a Skill.",
    keywords: entry.keywords.slice(0, 12),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

export async function rememberDeveAgentMemory(input: {
  directory?: string
  sessionID?: string
  kind?: DeveAgentMemoryKind
  title?: string
  summary: string
}) {
  const summary = compact(input.summary, 500)
  if (!summary || !memoryFile(input.directory)) return { stored: false as const }
  await ensureDeveAgentMemoryScaffold(input.directory)
  const kind = input.kind && validKind(input.kind) ? input.kind : "task"
  const title = compact(input.title || summary, 120)
  const entries = await readEntries(input.directory)
  const existing = entries.find((entry) => entry.kind === kind && entry.sessionID === input.sessionID && entry.summary === summary)
  if (existing) {
    existing.updatedAt = Date.now()
    await writeEntries(input.directory, entries)
    return { stored: true as const, entry: existing, candidate: undefined }
  }
  const entry: DeveAgentMemoryEntry = {
    id: `memory-${randomUUID()}`,
    kind,
    title,
    summary,
    keywords: keywords(`${title} ${summary}`),
    sessionID: input.sessionID?.slice(0, 160),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  entries.unshift(entry)
  const candidate = candidateFor(entry, entries)
  if (candidate) entries.unshift(candidate)
  entries.sort((left, right) => right.updatedAt - left.updatedAt)
  await writeEntries(input.directory, entries)
  return { stored: true as const, entry, candidate }
}

export async function queryDeveAgentMemory(input: { directory?: string; query?: string; sessionID?: string; scope?: DeveAgentMemoryScope; kind?: DeveAgentMemoryKind; limit?: number; tokenBudget?: number }) {
  const query = compact(input.query || "", 800)
  const queryKeywords = keywords(query)
  await reconcileDeveAgentMemory(input.directory)
  const entries = await readEntries(input.directory)
  const ftsHits = queryKeywords.length > 0
    // Scope/session/kind filtering stays in the canonical read model, so rank
    // every bounded entry before applying those filters rather than dropping a
    // valid match that fell outside a small FTS window.
    ? await searchDeveAgentMemoryFts(input.directory, query, Math.max(1, entries.length))
    : undefined
  const ftsRanks = new Map(ftsHits?.map((hit, index) => [hit.id, index]))
  const candidates = entries
    .filter((entry) => (!input.scope || memoryScope(entry) === input.scope) && (!input.kind || entry.kind === input.kind))
    .filter((entry) => !input.sessionID || entry.sessionID !== input.sessionID || entry.kind === "checkpoint" || entry.kind === "project")
    .map((entry) => {
      const matches = overlap(queryKeywords, entry.keywords)
      return {
        entry,
        matches,
        ftsRank: ftsRanks.get(entry.id) ?? Number.POSITIVE_INFINITY,
        score: queryKeywords.length === 0 ? 0 : matches * 100 + Math.max(0, 20 - Math.floor((Date.now() - entry.updatedAt) / 86_400_000)),
      }
    })
    // ponytail: recency breaks ties only; it must never turn an unrelated note into prompt context.
    .filter((item) => queryKeywords.length === 0 || item.matches > 0)
    .sort((left, right) => left.ftsRank - right.ftsRank || right.score - left.score || right.entry.updatedAt - left.entry.updatedAt)
  const limit = Math.max(1, Math.min(input.limit ?? 8, 20))
  const budgetChars = Math.max(512, Math.min(input.tokenBudget ?? MEMORY_QUERY_DEFAULT_TOKEN_BUDGET, 8_000)) * 4
  const selected: DeveAgentMemoryEntry[] = []
  let usedChars = 0
  for (const item of candidates) {
    if (selected.length >= limit) break
    const entry = await withMemorySnippet(item.entry, input.directory, query)
    const size = entry.title.length + (entry.snippet ?? entry.summary).length + 32
    if (selected.length > 0 && usedChars + size > budgetChars) continue
    selected.push(entry)
    usedChars += size
  }
  return selected
}

/**
 * Rebuild a bounded context from durable workspace memory and the active session.
 * This is deterministic and local; it does not claim to reconstruct the full
 * provider transcript or replace OpenCode's native compaction. When recent
 * session messages are supplied, they are retained as a small tail of the
 * real OpenCode history rather than reconstructed from memory entries.
 */
export async function rebuildDeveAgentMemoryContext(input: {
  directory?: string
  sessionID?: string
  query?: string
  tokenBudget?: number
  recentMessages?: DeveAgentMemoryTranscriptMessage[]
}): Promise<DeveAgentMemoryContext> {
  await reconcileDeveAgentMemory(input.directory)
  const entries = await readEntries(input.directory)
  const query = compact(input.query || "", 800)
  const queryMatches = query
    ? await queryDeveAgentMemory({ directory: input.directory, query, limit: 20, tokenBudget: input.tokenBudget })
    : []
  const selected = new Map<string, DeveAgentMemoryEntry>()
  const add = (entry: DeveAgentMemoryEntry) => {
    if (!selected.has(entry.id)) selected.set(entry.id, entry)
  }
  entries
    .filter((entry) => Boolean(input.sessionID) && entry.sessionID === input.sessionID)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 12)
    .forEach(add)
  queryMatches.forEach(add)
  entries
    .filter((entry) => !entry.sessionID && (entry.kind === "decision" || entry.kind === "bug" || entry.kind === "project" || entry.kind === "summary"))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 12)
    .forEach(add)

  const budgetChars = Math.max(256, Math.min(input.tokenBudget ?? 2_000, 8_000)) * 4
  let usedChars = 0
  let renderedEntries = 0
  const recentMessages = (input.recentMessages ?? [])
    .filter((message) => message && typeof message.text === "string" && message.text.trim())
    .slice(-12)
  // Keep a small tail of the real session visible even when durable memory is
  // crowded; compaction without recent intent is worse than fewer old notes.
  const recentReserve = recentMessages.length > 0
    ? Math.min(4_096, Math.max(512, Math.floor(budgetChars * 0.4)))
    : 0
  const memoryBudgetChars = Math.max(256, budgetChars - recentReserve)
  const lines: string[] = [
    "# DeveAgent rebuilt memory context",
    "",
    `- Source: bounded workspace Markdown/JSON memory${recentMessages.length > 0 ? " plus retained recent OpenCode session messages" : ""}; not a full transcript reconstruction.`,
  ]
  let retainedMessages = 0
  const sections: Array<[string, DeveAgentMemoryEntry[]]> = [
    ["Current session memory", [...selected.values()].filter((entry) => Boolean(input.sessionID) && entry.sessionID === input.sessionID)],
    ["Relevant memory", queryMatches.filter((entry) => selected.has(entry.id) && (!input.sessionID || entry.sessionID !== input.sessionID))],
    ["Workspace durable memory", [...selected.values()].filter((entry) => !entry.sessionID && (entry.kind === "decision" || entry.kind === "bug" || entry.kind === "project" || entry.kind === "summary"))],
  ]
  for (const [heading, sectionEntries] of sections) {
    const unique = [...new Map(sectionEntries.map((entry) => [entry.id, entry])).values()]
    if (unique.length === 0) continue
    const sectionLines = [`## ${heading}`]
    usedChars += sectionLines[0].length + 1
    for (const entry of unique) {
      const line = `- [${entry.kind}] ${entry.title}: ${compact(entry.snippet ?? entry.summary, 260)}`
      if (usedChars + line.length + 1 > memoryBudgetChars) break
      sectionLines.push(line)
      usedChars += line.length + 1
      renderedEntries += 1
    }
    if (sectionLines.length > 1) lines.push("", ...sectionLines)
  }
  if (recentMessages.length > 0) {
    const sectionLines = ["## Retained recent session messages"]
    usedChars += sectionLines[0].length + 1
    const recentBudgetChars = Math.max(0, budgetChars - usedChars)
    let recentUsedChars = sectionLines[0].length + 1
    for (const message of recentMessages) {
      const line = `- [${compact(message.role || "message", 32)}] ${compact(message.text, 420)}`
      if (recentUsedChars + line.length + 1 > recentBudgetChars) break
      sectionLines.push(line)
      usedChars += line.length + 1
      recentUsedChars += line.length + 1
      retainedMessages += 1
    }
    if (sectionLines.length > 1) lines.push("", ...sectionLines)
  }
  const context = lines.length > 1 ? `${lines.join("\n").slice(0, Math.max(0, budgetChars - 1))}\n` : ""
  return { context, entries: renderedEntries, tokenEstimate: Math.ceil(context.length / 4), retainedMessages }
}

export async function getDeveAgentMemoryTree(input: { directory?: string; query?: string }) : Promise<DeveAgentMemoryTree> {
  await reconcileDeveAgentMemory(input.directory)
  const entries = input.query?.trim()
    ? await queryDeveAgentMemory({ directory: input.directory, query: input.query, limit: 50 })
    : (await readEntries(input.directory))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 100)
  return {
    entries,
    groups: GROUPS.map((group) => ({ ...group, entries: entries.filter((entry) => entry.kind === group.kind) })),
  }
}

export async function getDeveAgentMemoryCandidate(input: { directory?: string; id?: string }) {
  const id = compact(input.id || "", 100)
  if (!id) return
  return (await readEntries(input.directory)).find((entry) => entry.id === id && entry.kind === "skill-candidate")
}

export async function dismissDeveAgentMemoryCandidate(input: { directory?: string; id?: string }) {
  const id = compact(input.id || "", 100)
  if (!id) return { dismissed: false }
  const entries = await readEntries(input.directory)
  const candidate = entries.find((entry) => entry.id === id && entry.kind === "skill-candidate")
  if (!candidate) return { dismissed: false }
  await writeEntries(input.directory, entries.filter((entry) => entry.id !== id))
  return { dismissed: true }
}

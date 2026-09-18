// DeveAgentRun — unified run records (Plan.2026.7.29 Core Interfaces). Every
// long-running DeveAgent execution (goal | loop | team | moa) gets one record
// with its kind, session, workspace, description, lifecycle status and real
// timestamps, persisted as bounded JSONL in `.deveagent/deveagent-runs.log`
// and readable through POST /api/deveagent/runs.
//
// Slice 1 covers goal runs; loop/team/moa hooks plug into the same recorder.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { readJsonlTolerant } from "./deveagent-jsonl"
import { join } from "node:path"

const RUNS_MAX_BYTES = 512 * 1024
const RUNS_KEEP_BYTES = 256 * 1024
export const DEVEAGENT_RUNS_MAX = 200
const DESCRIPTION_CHARS = 300
const STOP_REASON_CHARS = 200

export type DeveAgentRunKind = "goal" | "loop" | "team" | "moa"

export type DeveAgentRunStatus = "running" | "completed" | "failed" | "stopped"

export type DeveAgentRun = {
  id: string
  kind: DeveAgentRunKind
  sessionID?: string
  directory: string
  description: string
  status: DeveAgentRunStatus
  startedAt: number
  finishedAt?: number
  stopReason?: string
  // S2 provenance: which child sessions this run produced, and the real usage
  // it accumulated. Usage fields are undefined when the provider never
  // returned numbers — unknown is never rewritten to 0.
  parentSessionID?: string
  childSessionIDs?: string[]
  tokens?: number
  cost?: number
}

function runsPath(directory: string | undefined) {
  if (!directory) return undefined
  return join(directory, ".deveagent", "deveagent-runs.log")
}

function clampText(value: unknown, max: number) {
  return typeof value === "string" ? value.slice(0, max) : undefined
}

export function normalizeRun(value: Record<string, unknown>): DeveAgentRun | undefined {
  if (!value || typeof value !== "object") return undefined
  const id = typeof value.id === "string" ? value.id.slice(0, 80) : ""
  const kind = value.kind
  const directory = typeof value.directory === "string" ? value.directory : ""
  if (!id || (kind !== "goal" && kind !== "loop" && kind !== "team" && kind !== "moa") || !directory) return undefined
  const status = value.status
  if (status !== "running" && status !== "completed" && status !== "failed" && status !== "stopped") return undefined
  const startedAt = typeof value.startedAt === "number" && Number.isFinite(value.startedAt) ? value.startedAt : 0
  if (!startedAt) return undefined
  const children = Array.isArray(value.childSessionIDs)
    ? [...new Set(value.childSessionIDs.filter((item): item is string => typeof item === "string" && item.length > 0).map((item) => item.slice(0, 80)))].slice(0, 20)
    : undefined
  const usage = (raw: unknown) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : undefined)
  return {
    id,
    kind,
    sessionID: clampText(value.sessionID, 80),
    directory,
    description: clampText(value.description, DESCRIPTION_CHARS) ?? "",
    status,
    startedAt,
    finishedAt: typeof value.finishedAt === "number" && Number.isFinite(value.finishedAt) ? value.finishedAt : undefined,
    stopReason: clampText(value.stopReason, STOP_REASON_CHARS),
    parentSessionID: clampText(value.parentSessionID, 80),
    ...(children && children.length > 0 ? { childSessionIDs: children } : {}),
    tokens: usage(value.tokens),
    cost: usage(value.cost),
  }
}

/** In-process mirror so the API can answer without re-reading the log. */
const runIndexByDirectory = new Map<string, DeveAgentRun[]>()
const MAX_INDEX = 200
// Workspaces come and go; evict the oldest directory mirror so long-lived
// processes cannot accumulate one array per workspace forever.
const MAX_INDEX_DIRECTORIES = 64

function indexFor(directory: string) {
  let index = runIndexByDirectory.get(directory)
  if (!index) {
    index = []
    runIndexByDirectory.set(directory, index)
    while (runIndexByDirectory.size > MAX_INDEX_DIRECTORIES) {
      const oldest = runIndexByDirectory.keys().next().value
      if (oldest === undefined) break
      runIndexByDirectory.delete(oldest)
    }
  }
  return index
}

export async function readDeveAgentRuns(directory: string | undefined, limit = 50): Promise<DeveAgentRun[]> {
  const file = runsPath(directory)
  if (!file) return []
  const index = runIndexByDirectory.get(directory ?? "")
  if (index && index.length > 0) {
    const byId = new Map<string, DeveAgentRun>()
    for (let i = index.length - 1; i >= 0 && byId.size < Math.min(limit, DEVEAGENT_RUNS_MAX); i--) {
      const run = index[i]
      if (run && !byId.has(run.id)) byId.set(run.id, run)
    }
    return [...byId.values()]
  }
  try {
    const data = await readFile(file, "utf8")
    // A crash can leave a torn line; the tolerant walker skips damaged records
    // and keeps reading instead of losing everything written after them.
    const { records } = readJsonlTolerant({ text: data, parse: (value) => normalizeRun(value as Record<string, unknown>), max: Math.min(limit, DEVEAGENT_RUNS_MAX) })
    // The log is append-only; the newest record per run id wins (a run's status
    // transitions overwrite its older states in the read view).
    const byId = new Map<string, DeveAgentRun>()
    for (const run of records) {
      if (!byId.has(run.id)) byId.set(run.id, run)
    }
    return [...byId.values()]
  } catch {
    return []
  }
}

export async function recordDeveAgentRun(directory: string | undefined, entry: Record<string, unknown>) {
  const file = runsPath(directory)
  if (!file) return
  const run = normalizeRun(entry)
  if (!run) return
  const index = indexFor(directory ?? "")
  index.push(run)
  if (index.length > MAX_INDEX) index.splice(0, index.length - MAX_INDEX)
  try {
    await mkdir(join(file, ".."), { recursive: true })
    const line = `${JSON.stringify(run)}\n`
    let size = 0
    try {
      size = (await readFile(file)).byteLength
    } catch {}
    if (size + Buffer.byteLength(line) > RUNS_MAX_BYTES) {
      const data = await readFile(file)
      await writeFile(file, data.subarray(Math.max(0, data.byteLength - RUNS_KEEP_BYTES)))
    }
    await appendFile(file, line, "utf8")
  } catch {}
}

export function clearDeveAgentRunIndexForTest() {
  runIndexByDirectory.clear()
}

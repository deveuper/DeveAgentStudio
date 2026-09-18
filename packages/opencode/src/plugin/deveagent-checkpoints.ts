// DeveAgent session checkpoints (Plan.2026.7.29 R133: Rewind). One JSONL line
// per user turn in `.deveagent/checkpoints.log`: the snapshot hash captured
// BEFORE the agent acts on that turn, so a later rewind can restore both the
// conversation position and the exact file bytes. The file is bounded like the
// CU audit (512 KiB cap, keep the newest 256 KiB) and read back through the
// product API. The hash itself is produced by Snapshot.Service.track() in the
// httpapi route — this module only owns the durable record.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

const CHECKPOINTS_MAX_BYTES = 512 * 1024
const CHECKPOINTS_KEEP_BYTES = 256 * 1024
export const CHECKPOINTS_MAX_ENTRIES = 400
const SESSION_CHARS = 80
const MESSAGE_CHARS = 80
const HASH_CHARS = 120

export type DeveAgentCheckpoint = {
  at: string
  sessionID?: string
  messageID?: string
  snapshotHash: string
}

function checkpointPath(directory: string | undefined) {
  if (!directory) return undefined
  return join(directory, ".deveagent", "checkpoints.log")
}

/** Normalize + clamp a raw record; drops entries without a snapshot hash. */
export function normalizeCheckpoint(entry: unknown): DeveAgentCheckpoint | undefined {
  if (!entry || typeof entry !== "object") return undefined
  const raw = entry as Record<string, unknown>
  const snapshotHash = typeof raw.snapshotHash === "string" ? raw.snapshotHash.trim().slice(0, HASH_CHARS) : ""
  if (!snapshotHash) return undefined
  const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) || undefined : undefined)
  return {
    at: typeof raw.at === "string" && raw.at ? raw.at : new Date().toISOString(),
    sessionID: text(raw.sessionID, SESSION_CHARS),
    messageID: text(raw.messageID, MESSAGE_CHARS),
    snapshotHash,
  }
}

export async function recordCheckpoint(
  directory: string | undefined,
  entry: Record<string, unknown>,
): Promise<DeveAgentCheckpoint | undefined> {
  const file = checkpointPath(directory)
  const normalized = normalizeCheckpoint(entry)
  if (!file || !normalized) return undefined
  try {
    await mkdir(join(file, ".."), { recursive: true })
    const line = `${JSON.stringify(normalized)}\n`
    let size = 0
    try {
      size = (await readFile(file)).byteLength
    } catch {}
    if (size + Buffer.byteLength(line) > CHECKPOINTS_MAX_BYTES) {
      const data = await readFile(file)
      let kept = data.subarray(Math.max(0, data.byteLength - CHECKPOINTS_KEEP_BYTES))
      // The byte offset can land mid-line (or mid-UTF-8); drop everything up
      // to the first newline so the reader never sees a torn record.
      const newline = kept.indexOf(10)
      if (newline !== -1) kept = kept.subarray(newline + 1)
      await writeFile(file, kept)
    }
    await appendFile(file, line, "utf8")
    return normalized
  } catch {
    return undefined
  }
}

export async function readCheckpoints(
  directory: string | undefined,
  sessionID?: string,
  limit = 100,
): Promise<DeveAgentCheckpoint[]> {
  const file = checkpointPath(directory)
  if (!file) return []
  const requested = Math.floor(limit)
  if (!Number.isFinite(requested) || requested <= 0) return []
  const bounded = Math.min(requested, CHECKPOINTS_MAX_ENTRIES)
  try {
    const data = await readFile(file, "utf8")
    const lines = data.split("\n").filter(Boolean)
    const out: DeveAgentCheckpoint[] = []
    const seenMessage = new Set<string>()
    for (let i = lines.length - 1; i >= 0 && out.length < bounded; i--) {
      // Newest wins per messageID: a re-recorded checkpoint supersedes the
      // older hash for the same turn.
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(lines[i]!) as Record<string, unknown>
      } catch {
        continue
      }
      const normalized = normalizeCheckpoint(parsed)
      if (!normalized) continue
      if (sessionID && normalized.sessionID !== sessionID) continue
      const key = normalized.messageID ?? `at:${normalized.at}`
      if (seenMessage.has(key)) continue
      seenMessage.add(key)
      out.push(normalized)
    }
    return out
  } catch {
    return []
  }
}

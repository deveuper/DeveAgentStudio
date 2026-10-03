// ProviderFallback ledger (audit Q5 / E-3 follow-up).
//
// A fallback used to exist only as a transient event: the app toasted it, and
// the toast died with the page. "A switch must never happen silently" cuts both
// ways — it must also be findable AFTER the fact, which is what this ledger is
// for. One bounded JSONL per workspace (`.deveagent/deveagent-fallbacks.log`),
// same crash-tolerant read and size bounds as the runs ledger, queryable through
// POST /api/deveagent/fallbacks.
//
// Import discipline: node builtins + the tolerant JSONL reader only, so the
// module stays unit-testable without a session or a provider.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { readJsonlTolerant } from "./deveagent-jsonl"
import { dirname, join } from "node:path"

const FALLBACKS_MAX_BYTES = 256 * 1024
const FALLBACKS_KEEP_BYTES = 128 * 1024
export const DEVEAGENT_FALLBACKS_MAX = 200
const ID_CHARS = 120
const MESSAGE_CHARS = 300

export type ProviderFallbackEntry = {
  at: number
  sessionID?: string
  directory: string
  failedProviderID: string
  failedModelID: string
  fallbackProviderID: string
  fallbackModelID: string
  fallbackPaid: boolean
  message?: string
}

function fallbacksPath(directory: string | undefined) {
  if (!directory) return undefined
  return join(directory, ".deveagent", "deveagent-fallbacks.log")
}

function clamp(value: unknown, max: number) {
  return typeof value === "string" ? value.slice(0, max) : undefined
}

export function normalizeFallbackEntry(value: Record<string, unknown>): ProviderFallbackEntry | undefined {
  if (!value || typeof value !== "object") return undefined
  const directory = typeof value.directory === "string" ? value.directory : ""
  const failedProviderID = typeof value.failedProviderID === "string" ? value.failedProviderID.slice(0, ID_CHARS) : ""
  const failedModelID = typeof value.failedModelID === "string" ? value.failedModelID.slice(0, ID_CHARS) : ""
  const fallbackProviderID = typeof value.fallbackProviderID === "string" ? value.fallbackProviderID.slice(0, ID_CHARS) : ""
  const fallbackModelID = typeof value.fallbackModelID === "string" ? value.fallbackModelID.slice(0, ID_CHARS) : ""
  // All four identifiers are required: a fallback row that cannot name both
  // sides of the switch is not auditable and must not be stored.
  if (!directory || !failedProviderID || !failedModelID || !fallbackProviderID || !fallbackModelID) return undefined
  return {
    at: typeof value.at === "number" && Number.isFinite(value.at) && value.at > 0 ? value.at : Date.now(),
    sessionID: clamp(value.sessionID, 80),
    directory,
    failedProviderID,
    failedModelID,
    fallbackProviderID,
    fallbackModelID,
    fallbackPaid: value.fallbackPaid === true,
    message: clamp(value.message, MESSAGE_CHARS),
  }
}

export async function recordProviderFallback(directory: string | undefined, entry: Omit<ProviderFallbackEntry, "at" | "directory"> & { at?: number; directory?: string }) {
  const file = fallbacksPath(directory)
  if (!file) return
  const normalized = normalizeFallbackEntry({ ...entry, at: entry.at ?? Date.now(), directory: directory ?? "" })
  if (!normalized) return
  try {
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, JSON.stringify(normalized) + "\n", "utf8")
    // Keep the file bounded: the newest events matter, a two-year-old switch
    // has no operational value.
    const stat = await readFile(file, "utf8").then(
      (text) => Buffer.byteLength(text, "utf8"),
      () => 0,
    )
    if (stat > FALLBACKS_MAX_BYTES) {
      const text = await readFile(file, "utf8")
      const kept = text.split("\n").slice(-Math.ceil(FALLBACKS_KEEP_BYTES / 200))
      await writeFile(file, kept.join("\n"), "utf8")
    }
  } catch (error) {
    console.error("[fallback-ledger] write failed:", String(error))
  }
}

export async function readProviderFallbacks(input: {
  directory: string | undefined
  sessionID?: string
  limit?: number
}): Promise<ProviderFallbackEntry[]> {
  const file = fallbacksPath(input.directory)
  if (!file) return []
  const limit = Math.max(1, Math.min(input.limit ?? 50, DEVEAGENT_FALLBACKS_MAX))
  try {
    const text = await readFile(file, "utf8")
    const { records } = readJsonlTolerant({
      text,
      // The reader parses the line itself and hands the VALUE here; parsing it
      // again threw on every line and the ledger silently read as empty.
      parse: (value) => normalizeFallbackEntry(value as Record<string, unknown>),
      max: DEVEAGENT_FALLBACKS_MAX,
    })
    const filtered = input.sessionID ? records.filter((entry) => entry.sessionID === input.sessionID) : records
    return filtered.sort((a, b) => b.at - a.at).slice(0, limit)
  } catch {
    return []
  }
}

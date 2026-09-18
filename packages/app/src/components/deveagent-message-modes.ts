// P0-4: per-turn composer-mode snapshots. The plugin stamps the mode onto the
// user message at submit time; the transcript reads these snapshots so a plan
// badge reflects the mode the turn ran in instead of the composer's current
// state (which used to re-label historical messages on every switch).
import { createSignal } from "solid-js"

const CACHE_MAX_SESSIONS = 12
const cache = new Map<string, Record<string, string>>()
const inflight = new Map<string, Promise<void>>()
const [version, setVersion] = createSignal(0)

export async function loadMessageModes(sessionID: string | undefined) {
  if (!sessionID?.startsWith("ses_")) return
  const pending = inflight.get(sessionID)
  if (pending) return pending
  const task = (async () => {
    const target = window as typeof window & { __deveagentBaseUrl?: string; __deveagentFetch?: typeof fetch }
    const base = String(target.__deveagentBaseUrl ?? "").replace(/\/+$/, "")
    const request = target.__deveagentFetch ?? fetch
    try {
      const response = await request(`${base}/api/deveagent/message-modes?sessionID=${encodeURIComponent(sessionID)}`)
      if (!response.ok) return
      const data = (await response.json()) as { modes?: Record<string, string> }
      if (!data?.modes || typeof data.modes !== "object") return
      if (cache.size >= CACHE_MAX_SESSIONS) {
        const oldest = cache.keys().next().value
        if (oldest) cache.delete(oldest)
      }
      cache.set(sessionID, data.modes)
      setVersion((value) => value + 1)
    } catch {
      // Without a snapshot the badge simply stays hidden; never block the timeline.
    }
  })()
  inflight.set(sessionID, task)
  try {
    await task
  } finally {
    inflight.delete(sessionID)
  }
}

export function messageMode(sessionID: string | undefined, messageID: string | undefined): string | undefined {
  // Read the version signal so memories re-evaluate after a load lands.
  void version()
  if (!sessionID || !messageID) return undefined
  return cache.get(sessionID)?.[messageID]
}

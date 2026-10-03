import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { normalizeFallbackEntry, readProviderFallbacks, recordProviderFallback } from "./deveagent-fallbacks"

// The fallback ledger is the "事后可查" half of the E-3 red line: a switch that
// only toasted was invisible after a refresh. These tests pin the persistence
// contract — write, read back, filter by session, and refuse rows that cannot
// name both sides of the switch.

function withWorkspace(run: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(path.join(tmpdir(), "fallbacks-"))
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
}

const base = {
  sessionID: "ses_fb",
  failedProviderID: "zen",
  failedModelID: "grok-code",
  fallbackProviderID: "zen",
  fallbackModelID: "nemotron-free",
  fallbackPaid: false,
  message: "provider exploded",
}

describe("provider fallback ledger", () => {
  test("records and reads back an entry newest-first", async () => {
    await withWorkspace(async (dir) => {
      await recordProviderFallback(dir, { ...base, at: 1000 })
      await recordProviderFallback(dir, { ...base, sessionID: "ses_fb2", at: 2000 })
      const rows = await readProviderFallbacks({ directory: dir })
      expect(rows).toHaveLength(2)
      expect(rows[0]?.at).toBe(2000)
      expect(rows[1]?.failedModelID).toBe("grok-code")
    })
  })

  test("filters by sessionID", async () => {
    await withWorkspace(async (dir) => {
      await recordProviderFallback(dir, { ...base, sessionID: "ses_a", at: 1000 })
      await recordProviderFallback(dir, { ...base, sessionID: "ses_b", at: 2000 })
      const rows = await readProviderFallbacks({ directory: dir, sessionID: "ses_a" })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.sessionID).toBe("ses_a")
    })
  })

  test("normalizes away rows that cannot name both sides of the switch", () => {
    expect(normalizeFallbackEntry({ directory: "/w", failedProviderID: "a" })).toBeUndefined()
    const ok = normalizeFallbackEntry({ ...base, directory: "/w" })
    expect(ok?.fallbackPaid).toBe(false)
    expect(ok?.message).toBe("provider exploded")
  })

  test("is fail-soft without a directory, and bounds the limit", async () => {
    expect(await readProviderFallbacks({ directory: undefined })).toEqual([])
    await withWorkspace(async (dir) => {
      for (let index = 0; index < 8; index++) await recordProviderFallback(dir, { ...base, at: index + 1 })
      const rows = await readProviderFallbacks({ directory: dir, limit: 3 })
      expect(rows).toHaveLength(3)
      // Newest three of eight.
      expect(rows[0]?.at).toBe(8)
    })
  })

  test("writes bounded JSONL into the workspace .deveagent directory", async () => {
    await withWorkspace(async (dir) => {
      await recordProviderFallback(dir, { ...base, at: 1234 })
      const file = path.join(dir, ".deveagent", "deveagent-fallbacks.log")
      const text = readFileSync(file, "utf8")
      expect(text).toContain('"failedModelID":"grok-code"')
      expect(text).toContain('"at":1234')
    })
  })
})

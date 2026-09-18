import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadRecapConfig, normalizeAwayTexts, summarizeAway } from "./deveagent-recap"

function chatResponse(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
}

describe("deveagent-recap", () => {
  test("normalizeAwayTexts caps count and length, drops non-strings", () => {
    expect(normalizeAwayTexts(["a", 5, "  ", "b".repeat(400)])).toHaveLength(2)
    const out = normalizeAwayTexts(["x".repeat(400)])
    expect(out[0]!.endsWith("…")).toBe(true)
    expect(normalizeAwayTexts("nope")).toEqual([])
  })

  test("loadRecapConfig prefers recap.json and falls back to guardian.json", () => {
    const ws = mkdtempSync(join(tmpdir(), "recap-cfg-"))
    try {
      expect(loadRecapConfig(ws)).toBeNull()
      mkdirSync(join(ws, ".deveagent"), { recursive: true })
      writeFileSync(join(ws, ".deveagent", "guardian.json"), JSON.stringify({ baseUrl: "http://g/v1", apiKey: "k", model: "guardian-m" }))
      expect(loadRecapConfig(ws)?.model).toBe("guardian-m")
      writeFileSync(join(ws, ".deveagent", "recap.json"), JSON.stringify({ baseUrl: "http://r/v1", model: "recap-m" }))
      expect(loadRecapConfig(ws)?.model).toBe("recap-m")
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("summarizeAway parses strict JSON and falls back to bare text", async () => {
    const ws = mkdtempSync(join(tmpdir(), "recap-sum-"))
    try {
      mkdirSync(join(ws, ".deveagent"), { recursive: true })
      writeFileSync(join(ws, ".deveagent", "recap.json"), JSON.stringify({ baseUrl: "http://r/v1", apiKey: "k", model: "m" }))
      const seen: string[] = []
      const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
        seen.push(String(init?.body))
        const asked = JSON.parse(init?.body ?? "{}").messages.at(-1).content as string
        return asked.includes("t1") ? chatResponse('{"summary":"Refactored auth module."}') : chatResponse("Wrote tests and fixed a bug.")
      }) as typeof fetch
      expect((await summarizeAway({ directory: ws, awayMinutes: 12, texts: ["t1"], fetchImpl })).summary).toBe("Refactored auth module.")
      expect(seen[0]).toContain("Away for 12 minutes")
      expect((await summarizeAway({ directory: ws, awayMinutes: 5, texts: ["t2"], fetchImpl })).summary).toBe("Wrote tests and fixed a bug.")
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("summarizeAway fails soft: no config, empty texts, HTTP error", async () => {
    expect((await summarizeAway({ directory: undefined, awayMinutes: 5, texts: ["a"] }))).toEqual({ summary: null })
    const ws = mkdtempSync(join(tmpdir(), "recap-empty-"))
    try {
      expect((await summarizeAway({ directory: ws, awayMinutes: 5, texts: [] }))).toEqual({ summary: null })
      mkdirSync(join(ws, ".deveagent"), { recursive: true })
      writeFileSync(join(ws, ".deveagent", "recap.json"), JSON.stringify({ baseUrl: "http://r/v1", model: "m" }))
      const failing = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch
      expect((await summarizeAway({ directory: ws, awayMinutes: 5, texts: ["a"], fetchImpl: failing }))).toEqual({ summary: null })
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })
})

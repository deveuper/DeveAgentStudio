import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildVerifierPrompt, loadVerifierConfig, parseVerifierVerdict, verifyGoalIndependently } from "./deveagent-verifier"

function chatResponse(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
}

function workspaceWith(config: Record<string, unknown> | null, file = "verifier.json") {
  const ws = mkdtempSync(join(tmpdir(), "verifier-cfg-"))
  mkdirSync(join(ws, ".deveagent"), { recursive: true })
  if (config) writeFileSync(join(ws, ".deveagent", file), JSON.stringify(config))
  return ws
}

describe("deveagent-verifier", () => {
  test("loadVerifierConfig prefers verifier.json, then guardian.json, then recap.json", () => {
    const ws = mkdtempSync(join(tmpdir(), "verifier-pick-"))
    try {
      expect(loadVerifierConfig(ws)).toBeNull()
      expect(loadVerifierConfig(undefined)).toBeNull()
      mkdirSync(join(ws, ".deveagent"), { recursive: true })
      writeFileSync(join(ws, ".deveagent", "recap.json"), JSON.stringify({ baseUrl: "http://r/v1", model: "recap-m" }))
      expect(loadVerifierConfig(ws)?.model).toBe("recap-m")
      writeFileSync(join(ws, ".deveagent", "guardian.json"), JSON.stringify({ baseUrl: "http://g/v1", model: "guardian-m" }))
      expect(loadVerifierConfig(ws)?.model).toBe("guardian-m")
      writeFileSync(join(ws, ".deveagent", "verifier.json"), JSON.stringify({ baseUrl: "http://v/v1", model: "verifier-m" }))
      expect(loadVerifierConfig(ws)?.model).toBe("verifier-m")
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("loadVerifierConfig ignores incomplete or corrupt config files", () => {
    const incomplete = workspaceWith({ baseUrl: "http://v/v1" })
    const corrupt = mkdtempSync(join(tmpdir(), "verifier-corrupt-"))
    try {
      expect(loadVerifierConfig(incomplete)).toBeNull()
      mkdirSync(join(corrupt, ".deveagent"), { recursive: true })
      writeFileSync(join(corrupt, ".deveagent", "verifier.json"), "{not json")
      expect(loadVerifierConfig(corrupt)).toBeNull()
    } finally {
      rmSync(incomplete, { recursive: true, force: true })
      rmSync(corrupt, { recursive: true, force: true })
    }
  })

  test("parseVerifierVerdict derives allMet from per-criterion flags, not the model's summary", () => {
    const verdict = parseVerifierVerdict(
      JSON.stringify({
        criteria: [
          { index: 2, met: true, reason: "tests pass" },
          { index: 1, met: false, reason: "no evidence of the file change" },
        ],
        allMet: true,
        rationale: "one criterion lacks evidence",
      }),
      2,
    )
    expect(verdict.available).toBe(true)
    if (!verdict.available) return
    expect(verdict.allMet).toBe(false)
    expect(verdict.perCriterion.map((item) => item.index)).toEqual([1, 2])
    expect(verdict.rationale).toBe("one criterion lacks evidence")
  })

  test("parseVerifierVerdict accepts a fenced JSON block and rejects partial coverage", () => {
    const fenced = parseVerifierVerdict('```json\n{"criteria":[{"index":1,"met":true,"reason":"ok"}],"allMet":true}\n```', 1)
    expect(fenced.available).toBe(true)
    expect(fenced.available && fenced.allMet).toBe(true)

    // The verifier must judge every criterion; a partial answer is unusable.
    expect(parseVerifierVerdict(JSON.stringify({ criteria: [{ index: 1, met: true }] }), 3).available).toBe(false)
    expect(parseVerifierVerdict("not json at all", 2).available).toBe(false)
    expect(parseVerifierVerdict(JSON.stringify({ criteria: [] }), 1).available).toBe(false)
    expect(parseVerifierVerdict(JSON.stringify({ criteria: [{ index: 0, met: true }] }), 1).available).toBe(false)
  })

  test("buildVerifierPrompt includes the goal, criteria and a bounded transcript", () => {
    const prompt = buildVerifierPrompt({
      description: "Ship the login page",
      criteria: ["page renders", "tests pass"],
      transcript: Array.from({ length: 14 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", text: `m${index}` })),
    })
    expect(prompt.system).toContain("independent acceptance verifier")
    expect(prompt.user).toContain("Ship the login page")
    expect(prompt.user).toContain("1. page renders")
    expect(prompt.user).toContain("2. tests pass")
    expect(prompt.user).not.toContain("m0")
    expect(prompt.user).toContain("m13")
  })

  test("verifyGoalIndependently is fail-soft without a config or criteria", async () => {
    const ws = mkdtempSync(join(tmpdir(), "verifier-none-"))
    try {
      let called = false
      const fetchImpl = (async () => {
        called = true
        return chatResponse("{}")
      }) as unknown as typeof fetch
      expect((await verifyGoalIndependently({ directory: ws, description: "g", criteria: ["a"], transcript: [], fetchImpl })).available).toBe(false)
      expect(called).toBe(false)
      const configured = workspaceWith({ baseUrl: "http://v/v1", apiKey: "k", model: "m" })
      try {
        expect((await verifyGoalIndependently({ directory: configured, description: "g", criteria: [], transcript: [], fetchImpl })).available).toBe(false)
        expect(called).toBe(false)
      } finally {
        rmSync(configured, { recursive: true, force: true })
      }
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("verifyGoalIndependently posts to the configured endpoint and returns verdicts", async () => {
    const ws = workspaceWith({ baseUrl: "http://v/v1/", apiKey: "secret", model: "verifier-m" })
    try {
      const seen: { url: string; body: Record<string, unknown>; auth?: string }[] = []
      const fetchImpl = (async (url: unknown, init?: { body?: string; headers?: Record<string, string> }) => {
        seen.push({
          url: String(url),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          auth: init?.headers?.authorization,
        })
        return chatResponse(JSON.stringify({ criteria: [{ index: 1, met: true, reason: "file exists" }], allMet: true, rationale: "ok" }))
      }) as unknown as typeof fetch
      const verdict = await verifyGoalIndependently({
        directory: ws,
        description: "goal",
        criteria: ["file exists"],
        transcript: [{ role: "assistant", text: "wrote src/a.ts" }],
        fetchImpl,
      })
      expect(verdict.available).toBe(true)
      expect(verdict.available && verdict.allMet).toBe(true)
      expect(seen).toHaveLength(1)
      expect(seen[0]!.url).toBe("http://v/v1/chat/completions")
      expect(seen[0]!.auth).toBe("Bearer secret")
      expect(seen[0]!.body.model).toBe("verifier-m")
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("verifyGoalIndependently fails soft on HTTP errors, throws and empty content", async () => {
    const ws = workspaceWith({ baseUrl: "http://v/v1", model: "m" })
    try {
      const cases: (() => Promise<Response>)[] = [
        async () => new Response("nope", { status: 500 }),
        async () => {
          throw new Error("network down")
        },
        async () => chatResponse(""),
        async () => new Response("not json", { status: 200 }),
      ]
      for (const handler of cases) {
        const fetchImpl = (async () => await handler()) as unknown as typeof fetch
        const verdict = await verifyGoalIndependently({ directory: ws, description: "g", criteria: ["a"], transcript: [], fetchImpl })
        expect(verdict.available).toBe(false)
      }
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })
})

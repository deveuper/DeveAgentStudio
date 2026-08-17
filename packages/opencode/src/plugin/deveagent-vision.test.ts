import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  clearVisionConfig,
  loadVisionConfig,
  newVisionTelemetry,
  resetVisionTelemetry,
  runVisionChain,
  saveVisionConfig,
  testVisionConnection,
  validateVisionConfig,
  visionStatus,
  visionTelemetry,
} from "./deveagent-vision"

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "deveagent-vision-test-"))
}

describe("deveagent vision config", () => {
  test("save + load round-trips a workspace config", () => {
    const ws = tempWorkspace()
    try {
      saveVisionConfig(
        { provider: "mimo-token-plan", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1", apiKey: "tp-test", model: "mimo-v2.5" },
        ws,
      )
      const loaded = loadVisionConfig(ws)
      expect(loaded?.provider).toBe("mimo-token-plan")
      expect(loaded?.apiKey).toBe("tp-test")
      expect(existsSync(join(ws, ".deveagent", "vision.json"))).toBe(true)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("workspace config overrides global", () => {
    const ws = tempWorkspace()
    const global = join(tmpdir(), `deveagent-vision-global-${Date.now()}.json`)
    try {
      saveVisionConfig({ provider: "glm", baseUrl: "https://global", apiKey: "g", model: "m" }, undefined)
      saveVisionConfig({ provider: "ark", baseUrl: "https://local", apiKey: "l", model: "m2" }, ws)
      // NOTE: loadVisionConfig prefers workspace when it exists.
      const loaded = loadVisionConfig(ws)
      expect(loaded?.provider).toBe("ark")
    } finally {
      rmSync(ws, { recursive: true, force: true })
      clearVisionConfig(undefined)
      void global
    }
  })

  test("status masks the api key", () => {
    const ws = tempWorkspace()
    try {
      saveVisionConfig({ provider: "openai", baseUrl: "https://x/v1", apiKey: "sk-abcdef123456", model: "gpt-4o-mini" }, ws)
      const status = visionStatus(ws)
      expect(status.configured).toBe(true)
      expect(status.config?.apiKey).not.toContain("abcdef")
      expect(status.config?.apiKeySet).toBe(true)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("validate requires baseUrl/apiKey/model except for windows-ocr", () => {
    expect(validateVisionConfig({ provider: "openai", baseUrl: "", apiKey: "k", model: "m" })).toBeTruthy()
    expect(validateVisionConfig({ provider: "openai", baseUrl: "https://x", apiKey: "", model: "m" })).toBeTruthy()
    expect(validateVisionConfig({ provider: "openai", baseUrl: "https://x", apiKey: "k", model: "" })).toBeTruthy()
    expect(validateVisionConfig({ provider: "openai", baseUrl: "https://x", apiKey: "k", model: "m" })).toBeNull()
    expect(validateVisionConfig({ provider: "windows-ocr", baseUrl: "", apiKey: "", model: "" })).toBeNull()
  })
})

describe("deveagent vision chain", () => {
  test("no config -> OCR fallback reports missing local file gracefully", async () => {
    const ws = tempWorkspace()
    try {
      const result = await runVisionChain(join(ws, "missing.png"), "describe", ws)
      expect(result.source).toBe("none")
      expect(result.error).toContain("image not found")
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("testVisionConnection with missing pieces reports clear reasons", async () => {
    const ws = tempWorkspace()
    try {
      const noUrl = await testVisionConnection({ provider: "openai", baseUrl: "", apiKey: "k", model: "m" }, ws)
      expect(noUrl.ok).toBe(false)
      expect(noUrl.detail).toContain("base URL")

      const noKey = await testVisionConnection({ provider: "openai", baseUrl: "https://x/v1", apiKey: "", model: "m" }, ws)
      expect(noKey.ok).toBe(false)
      expect(noKey.detail).toContain("API key")

      const ocr = await testVisionConnection({ provider: "windows-ocr", baseUrl: "", apiKey: "", model: "" }, ws)
      expect(ocr.ok).toBe(true)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })
})

describe("deveagent vision telemetry", () => {
  test("telemetry stays bounded and records failures", async () => {
    resetVisionTelemetry()
    const ws = tempWorkspace()
    try {
      // Missing local image is an input error: no API call, no failure count.
      saveVisionConfig({ provider: "openai", baseUrl: "https://invalid-host-xyz.example.com/v1", apiKey: "k", model: "m" }, ws)
      const result = await runVisionChain(join(ws, "missing.png"), "describe", ws)
      expect(result.source).toBe("none")
      let t = visionTelemetry()
      expect(t.apiCalls).toBe(0)
      expect(t.apiFailures).toBe(0)
      expect(t.lastError).toContain("invalid image input")

      // A real image with an unreachable API: apiCalls/apiFailures bump, error
      // surfaces, and the OS OCR fallback actually runs (verified live on win32).
      const png = join(ws, "pixel.png")
      writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"))
      const failed = await runVisionChain(png, "describe", ws)
      if (process.platform === "win32") {
        expect(failed.source).toBe("windows-ocr")
      } else {
        expect(failed.source).toBe("none")
      }
      t = visionTelemetry()
      expect(t.apiCalls).toBe(1)
      expect(t.apiFailures).toBe(1)
      expect(t.lastError).toContain("vision API failed")
      expect(t.lastHttpStatus).toBeNull()
      // Bounded shape: only scalar summary fields, no arrays/logs.
      expect(Object.keys(t).sort()).toEqual(["apiCalls", "apiFailures", "lastAt", "lastError", "lastHttpStatus", "lastSource", "ocrFallbacks"])
      // visionStatus exposes the same telemetry.
      const status = visionStatus(ws)
      expect(status.telemetry.apiFailures).toBe(1)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("reset clears counters", () => {
    resetVisionTelemetry()
    const t = resetVisionTelemetry()
    expect(t.apiCalls).toBe(0)
    expect(t.apiFailures).toBe(0)
    expect(t.lastError).toBeNull()
  })

  test("scoped sink isolates manual calls from production telemetry", async () => {
    resetVisionTelemetry()
    const ws = tempWorkspace()
    try {
      // A real image with an unreachable API: the failure lands in the throwaway
      // sink while the production counters stay untouched.
      saveVisionConfig({ provider: "openai", baseUrl: "https://invalid-host-xyz.example.com/v1", apiKey: "k", model: "m" }, ws)
      const png = join(ws, "pixel.png")
      writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"))
      const sink = newVisionTelemetry()
      const result = await runVisionChain(png, "describe", ws, sink)
      expect(["windows-ocr", "none"]).toContain(result.source)
      // The manual call is recorded in the sink...
      expect(sink.apiCalls).toBe(1)
      expect(sink.apiFailures).toBe(1)
      expect(sink.lastError).toContain("vision API failed")
      expect(sink.lastAt).toBeTypeOf("number")
      // ...and the production counters stay clean.
      const global = visionTelemetry()
      expect(global.apiCalls).toBe(0)
      expect(global.apiFailures).toBe(0)
      expect(global.ocrFallbacks).toBe(0)
      expect(global.lastError).toBeNull()
      expect(global.lastSource).toBeNull()
      expect(global.lastAt).toBeNull()
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("testVisionConnection with a sink keeps diagnostic probes out of production telemetry", async () => {
    resetVisionTelemetry()
    const sink = newVisionTelemetry()
    // Unreachable host: the probe fails and must land in the throwaway sink
    // only — the dashboard counters stay untouched.
    const result = await testVisionConnection(
      { provider: "openai", baseUrl: "https://invalid-host-xyz.example.com/v1", apiKey: "k", model: "m" },
      undefined,
      sink,
    )
    expect(result.ok).toBe(false)
    expect(sink.apiCalls).toBe(1)
    expect(sink.apiFailures).toBe(1)
    expect(sink.lastError).toBeTruthy()
    const global = visionTelemetry()
    expect(global.apiCalls).toBe(0)
    expect(global.apiFailures).toBe(0)
    expect(global.lastHttpStatus).toBeNull()
    expect(global.lastError).toBeNull()
    expect(global.lastAt).toBeNull()
  })
})

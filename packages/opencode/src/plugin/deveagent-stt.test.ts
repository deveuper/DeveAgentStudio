import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  STT_PROVIDER_PRESETS,
  clearSttConfig,
  loadSttConfig,
  saveSttConfig,
  sttStatus,
  testSttConnection,
  validateSttConfig,
} from "./deveagent-stt"
import { voiceTranscriptionUrl } from "./deveagent"

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "deveagent-stt-test-"))
}

describe("deveagent stt config", () => {
  test("save + load round-trips a workspace config", () => {
    const ws = tempWorkspace()
    try {
      saveSttConfig(
        { provider: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "stt-test-key", model: "whisper-1" },
        ws,
      )
      const loaded = loadSttConfig(ws)
      expect(loaded?.provider).toBe("openai")
      expect(loaded?.apiKey).toBe("stt-test-key")
      expect(loaded?.model).toBe("whisper-1")
      expect(existsSync(join(ws, ".deveagent", "stt.json"))).toBe(true)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("global config round-trips through XDG_CONFIG_HOME isolation", () => {
    const home = tempWorkspace()
    const previous = process.env.XDG_CONFIG_HOME
    try {
      process.env.XDG_CONFIG_HOME = home
      saveSttConfig({ provider: "dashscope", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "k", model: "paraformer-v2" })
      const loaded = loadSttConfig()
      expect(loaded?.provider).toBe("dashscope")
      expect(loaded?.baseUrl).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1")
      expect(existsSync(join(home, "opencode", "deveagent-stt.json"))).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("workspace config overrides global", () => {
    const ws = tempWorkspace()
    const home = tempWorkspace()
    const previous = process.env.XDG_CONFIG_HOME
    try {
      process.env.XDG_CONFIG_HOME = home
      saveSttConfig({ provider: "openai", baseUrl: "https://global", apiKey: "g", model: "m" })
      saveSttConfig({ provider: "moonshot", baseUrl: "https://local", apiKey: "l", model: "m2" }, ws)
      const loaded = loadSttConfig(ws)
      expect(loaded?.provider).toBe("moonshot")
      expect(loaded?.baseUrl).toBe("https://local")
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous
      rmSync(ws, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("clearSttConfig removes a workspace config", () => {
    const ws = tempWorkspace()
    try {
      saveSttConfig({ provider: "openai", baseUrl: "https://x/v1", apiKey: "k", model: "m" }, ws)
      expect(existsSync(join(ws, ".deveagent", "stt.json"))).toBe(true)
      const result = clearSttConfig(ws)
      expect(result.cleared).toBe(true)
      expect(loadSttConfig(ws)).toBeNull()
      expect(clearSttConfig(ws).cleared).toBe(false)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("status masks the api key", () => {
    const ws = tempWorkspace()
    try {
      saveSttConfig({ provider: "openai", baseUrl: "https://x/v1", apiKey: "sk-abcdef123456", model: "whisper-1" }, ws)
      const status = sttStatus(ws)
      expect(status.configured).toBe(true)
      expect(status.config?.apiKey).not.toContain("abcdef")
      expect(status.config?.apiKeySet).toBe(true)
      expect(status.config?.provider).toBe("openai")
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("validate requires baseUrl/apiKey/model except for the browser fallback marker", () => {
    expect(validateSttConfig({ provider: "openai", baseUrl: "", apiKey: "k", model: "m" })).toBeTruthy()
    expect(validateSttConfig({ provider: "openai", baseUrl: "https://x", apiKey: "", model: "m" })).toBeTruthy()
    expect(validateSttConfig({ provider: "openai", baseUrl: "https://x", apiKey: "k", model: "" })).toBeTruthy()
    expect(validateSttConfig({ provider: "", baseUrl: "https://x", apiKey: "k", model: "m" })).toBeTruthy()
    expect(validateSttConfig({ provider: "openai", baseUrl: "https://x", apiKey: "k", model: "m" })).toBeNull()
    // The `browser` marker needs no API fields.
    expect(validateSttConfig({ provider: "browser", baseUrl: "", apiKey: "", model: "" })).toBeNull()
  })
})

describe("deveagent stt presets", () => {
  test("presets have non-empty id/name and (baseUrl+model), builtin, or custom slot", () => {
    expect(STT_PROVIDER_PRESETS.length).toBeGreaterThan(0)
    for (const preset of STT_PROVIDER_PRESETS) {
      expect(preset.id.trim().length).toBeGreaterThan(0)
      expect(preset.name.trim().length).toBeGreaterThan(0)
      const complete = Boolean(preset.baseUrl.trim()) && Boolean(preset.model.trim())
      expect(complete || preset.builtin === true || preset.id === "custom").toBe(true)
    }
  })

  test("browser built-in marker is present and needs no API fields", () => {
    const browser = STT_PROVIDER_PRESETS.find((preset) => preset.builtin === true)
    expect(browser).toBeTruthy()
    expect(browser?.baseUrl).toBe("")
    expect(browser?.model).toBe("")
    expect(validateSttConfig({ provider: browser!.id, baseUrl: "", apiKey: "", model: "" })).toBeNull()
  })
})

describe("deveagent stt transcription url", () => {
  test("voiceTranscriptionUrl derives /audio/transcriptions from a chat-completions style base", () => {
    expect(voiceTranscriptionUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1/audio/transcriptions")
    expect(voiceTranscriptionUrl("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1/audio/transcriptions")
    expect(voiceTranscriptionUrl("https://api.openai.com/v1/chat/completions")).toBe(
      "https://api.openai.com/v1/audio/transcriptions",
    )
    expect(voiceTranscriptionUrl("https://api.openai.com/v1/responses")).toBe(
      "https://api.openai.com/v1/audio/transcriptions",
    )
    expect(voiceTranscriptionUrl("http://127.0.0.1:1234/v1")).toBe("http://127.0.0.1:1234/v1/audio/transcriptions")
    expect(() => voiceTranscriptionUrl("ftp://example.com/v1")).toThrow()
  })
})

describe("deveagent stt connection", () => {
  test("testSttConnection short-circuits on invalid config before any probe", async () => {
    const missingUrl = await testSttConnection({ provider: "openai", baseUrl: "", apiKey: "k", model: "m" })
    expect(missingUrl.ok).toBe(false)
    const missingKey = await testSttConnection({ provider: "openai", baseUrl: "https://x/v1", apiKey: "", model: "m" })
    expect(missingKey.ok).toBe(false)
    const browser = await testSttConnection({ provider: "browser", baseUrl: "", apiKey: "", model: "" })
    expect(browser.ok).toBe(true)
  })

  test("testSttConnection performs a real network probe", async () => {
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = (async () => new Response('{"text": ""}', { status: 200 })) as unknown as typeof fetch
      const ok = await testSttConnection({ provider: "openai", baseUrl: "https://stt.example.com/v1", apiKey: "k", model: "whisper-1" })
      expect(ok.ok).toBe(true)
      expect(ok.detail).toContain("探测成功")
      expect(ok.status).toBe(200)

      globalThis.fetch = (async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch
      const denied = await testSttConnection({ provider: "openai", baseUrl: "https://stt.example.com/v1", apiKey: "k", model: "whisper-1" })
      expect(denied.ok).toBe(false)
      expect(denied.status).toBe(401)
      expect(denied.detail).toContain("bad key")

      globalThis.fetch = (async () => {
        throw new Error("fetch failed")
      }) as unknown as typeof fetch
      const down = await testSttConnection({ provider: "openai", baseUrl: "https://stt.example.com/v1", apiKey: "k", model: "whisper-1" })
      expect(down.ok).toBe(false)
      expect(down.detail).toContain("网络探测失败")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

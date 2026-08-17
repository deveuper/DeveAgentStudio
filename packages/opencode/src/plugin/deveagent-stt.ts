// DeveAgent independent speech-to-text (STT) backend.
//
// Mirrors the independent vision config (deveagent-vision.ts): a separately
// configured, OpenAI-compatible /audio/transcriptions API that does not depend
// on the primary provider registry. When configured it takes precedence over
// the auxiliary `speech` provider in the voice/transcribe route.
//
// Config precedence: workspace `.deveagent/stt.json` overrides the global
// `~/.config/opencode/deveagent-stt.json`.
//
// ponytail: presets stay conservative — only providers with a real
// OpenAI-compatible /audio/transcriptions endpoint are listed. Unknown or
// unverified endpoints are omitted rather than guessed.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface DeveAgentSttConfig {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  /** Optional language hint forwarded to the transcription model (e.g. "zh", "en"). */
  language?: string
}

const GLOBAL_STT_CONFIG_REL = join("opencode", "deveagent-stt.json")
const WORKSPACE_REL = join(".deveagent", "stt.json")

/**
 * Provider presets shared with the dashboard UI.
 *
 * ponytail: only providers with a verified OpenAI-compatible
 * /audio/transcriptions endpoint are listed. `browser` is the built-in marker
 * for the Chromium Web Speech fallback (no API needed), and `custom` is an
 * empty-slot preset the user fills in.
 */
export const STT_PROVIDER_PRESETS: Array<{
  id: string
  name: string
  baseUrl: string
  model: string
  builtin?: boolean
}> = [
  { id: "openai", name: "OpenAI / 任意兼容网关", baseUrl: "https://api.openai.com/v1", model: "whisper-1" },
  { id: "moonshot", name: "Moonshot Kimi 语音转写", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-audio-transcription" },
  { id: "dashscope", name: "阿里百炼 Paraformer", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "paraformer-v2" },
  { id: "custom", name: "自定义（OpenAI 兼容）", baseUrl: "", model: "" },
  { id: "browser", name: "浏览器内置语音识别（离线）", baseUrl: "", model: "", builtin: true },
]

export function globalSttConfigPath(): string {
  // Respect XDG_CONFIG_HOME like the rest of the plugin so isolated/E2E
  // environments never clobber the real user's STT config.
  const base =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim() ? process.env.XDG_CONFIG_HOME : join(homedir(), ".config")
  return join(base, GLOBAL_STT_CONFIG_REL)
}

export function workspaceSttConfigPath(workspace?: string): string | undefined {
  if (!workspace) return undefined
  return join(workspace, WORKSPACE_REL)
}

export function loadSttConfig(workspace?: string): DeveAgentSttConfig | null {
  const candidates = [workspaceSttConfigPath(workspace), globalSttConfigPath()].filter(
    (p): p is string => !!p && existsSync(p),
  )
  for (const path of candidates) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DeveAgentSttConfig>
      // ponytail: a config is usable when it has a base URL, or when the
      // provider is the built-in browser fallback marker (no API needed).
      if (raw && (raw.baseUrl || raw.provider === "browser")) {
        return {
          provider: raw.provider ?? "openai",
          baseUrl: raw.baseUrl ?? "",
          apiKey: raw.apiKey ?? "",
          model: raw.model ?? "",
          language: raw.language,
        }
      }
    } catch {
      // malformed config file — fall through to the next candidate
    }
  }
  return null
}

export function saveSttConfig(config: DeveAgentSttConfig, workspace?: string): { path: string } {
  const target = workspaceSttConfigPath(workspace) ?? globalSttConfigPath()
  mkdirSync(join(target, ".."), { recursive: true })
  writeFileSync(target, JSON.stringify(config, null, 2) + "\n", "utf8")
  return { path: target }
}

export function clearSttConfig(workspace?: string): { cleared: boolean } {
  const target = workspaceSttConfigPath(workspace) ?? globalSttConfigPath()
  if (existsSync(target)) {
    rmSync(target)
    return { cleared: true }
  }
  return { cleared: false }
}

function sanitizeConfig(config: DeveAgentSttConfig) {
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    language: config.language,
    apiKey: config.apiKey ? `${config.apiKey.slice(0, 6)}…${config.apiKey.slice(-4)}` : "",
    apiKeySet: Boolean(config.apiKey),
  }
}

/**
 * Validate the STT config shape without touching the network.
 *
 * ponytail: config-only check — returns an error string, or null when the
 * config is complete. The `browser` fallback marker needs no API fields.
 */
export function validateSttConfig(config: DeveAgentSttConfig): string | null {
  if (!config.provider) return "provider 不能为空"
  if (config.provider !== "browser") {
    if (!config.baseUrl) return "base URL 不能为空"
    if (!/^https?:\/\//.test(config.baseUrl)) return "base URL 必须使用 http 或 https"
    if (!config.apiKey) return "API key 不能为空"
    if (!config.model) return "模型名不能为空"
  }
  return null
}

/**
 * Test the configured independent STT API with a REAL network probe.
 *
 * Sends a tiny (~0.2s) silent WAV to `${baseUrl}/audio/transcriptions` so the
 * result reflects live connectivity and surfaces the real HTTP status/body —
 * mirroring the vision test connection probe. Missing/invalid config still
 * short-circuits with a config-only reason.
 */
export async function testSttConnection(
  config: DeveAgentSttConfig,
  workspace?: string,
): Promise<{
  ok: boolean
  provider: string
  model: string
  baseUrl: string
  status?: number
  detail?: string
  apiKeySet: boolean
}> {
  const base = { provider: config.provider, model: config.model, baseUrl: config.baseUrl, apiKeySet: Boolean(config.apiKey) }
  if (config.provider === "browser") {
    return { ...base, ok: true, detail: "浏览器内置语音识别（Chromium Web Speech），无需 API。" }
  }
  if (!config.baseUrl) return { ...base, ok: false, detail: "未配置 base URL。" }
  if (!/^https?:\/\//.test(config.baseUrl)) return { ...base, ok: false, detail: "base URL 必须使用 http 或 https。" }
  if (!config.apiKey) return { ...base, ok: false, detail: "未配置 API key。" }
  if (!config.model) return { ...base, ok: false, detail: "未配置模型名。" }
  try {
    const form = new FormData()
    // The probe is a freshly allocated Uint8Array; the cast only bridges the
    // TS lib's ArrayBufferLike generic (the runtime value satisfies BlobPart).
    form.append("file", new Blob([sttProbeWav() as unknown as BlobPart], { type: "audio/wav" }), "probe.wav")
    form.append("model", config.model)
    if (config.language) form.append("language", config.language)
    const response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}` },
      body: form,
    })
    const body = await response.text()
    if (response.ok) {
      return { ...base, ok: true, status: response.status, detail: `探测成功（HTTP ${response.status}）：${body.slice(0, 200) || "空响应"}` }
    }
    return { ...base, ok: false, status: response.status, detail: `HTTP ${response.status}: ${body.slice(0, 2000)}` }
  } catch (error) {
    return { ...base, ok: false, detail: `网络探测失败: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Minimal 0.2s 8kHz mono PCM silence WAV (~3.2KB) for the connectivity probe. */
function sttProbeWav(): Uint8Array {
  const sampleRate = 8000
  const dataSize = Math.floor(sampleRate * 0.2) * 2
  const bytes = new Uint8Array(44 + dataSize)
  const view = new DataView(bytes.buffer)
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeAscii(0, "RIFF")
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(8, "WAVE")
  writeAscii(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, "data")
  view.setUint32(40, dataSize, true)
  return bytes
}

export function sttStatus(workspace?: string): {
  configured: boolean
  config?: ReturnType<typeof sanitizeConfig>
  path?: string
} {
  const config = loadSttConfig(workspace)
  if (!config) return { configured: false }
  const path = workspaceSttConfigPath(workspace) ?? globalSttConfigPath()
  return { configured: true, config: sanitizeConfig(config), path }
}

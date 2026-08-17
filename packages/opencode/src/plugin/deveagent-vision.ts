// DeveAgent independent vision backend.
//
// Merges the user's `vision` skill (vision_hub.py) capabilities into the
// plugin: a separately-configured vision API (OpenAI-compatible) that does not
// depend on the primary provider, plus automatic fallback to the OS built-in
// OCR (Windows.Media.Ocr / macOS Vision) when no API is configured or the API
// call fails. HTTP errors (e.g. 403) surface their real response body so the
// user can diagnose key/base-url/model mistakes.
//
// Config precedence: workspace `.deveagent/vision.json` overrides the global
// `~/.config/opencode/deveagent-vision.json`.

import { execFile, execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

export interface DeveAgentVisionConfig {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  /** OCR language hint for the OS fallback (e.g. "zh-Hans-CN", "en-US"). */
  language?: string
}

const GLOBAL_VISION_CONFIG_REL = join("opencode", "deveagent-vision.json")
const WORKSPACE_REL = join(".deveagent", "vision.json")

/** Provider presets shared with the dashboard UI. */
export const VISION_PROVIDER_PRESETS: Array<{
  id: string
  name: string
  baseUrl: string
  model: string
  builtin?: boolean
}> = [
  { id: "mimo-token-plan", name: "小米 MiMo Token Plan（国内）", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1", model: "mimo-v2.5" },
  { id: "mimo", name: "小米 MiMo（国际）", baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5" },
  { id: "glm", name: "智谱 GLM 视觉", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.7v" },
  { id: "ark", name: "火山方舟（豆包视觉）", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seed-1-6-vision-250815" },
  { id: "dashscope", name: "阿里百炼 Qwen-VL", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-vl-max" },
  { id: "moonshot", name: "Moonshot Kimi 视觉", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-32k-vision-preview" },
  { id: "openai", name: "OpenAI / 任意兼容网关", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { id: "ollama", name: "Ollama（本地）", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5vl" },
  { id: "windows-ocr", name: "Windows 自带 OCR（离线）", baseUrl: "", model: "", builtin: true },
]

export function globalVisionConfigPath(): string {
  // Respect XDG_CONFIG_HOME like the rest of the plugin so isolated/E2E
  // environments never clobber the real user's vision config.
  const base =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim() ? process.env.XDG_CONFIG_HOME : join(homedir(), ".config")
  return join(base, GLOBAL_VISION_CONFIG_REL)
}

export function workspaceVisionConfigPath(workspace?: string): string | undefined {
  if (!workspace) return undefined
  return join(workspace, WORKSPACE_REL)
}

export function loadVisionConfig(workspace?: string): DeveAgentVisionConfig | null {
  const candidates = [workspaceVisionConfigPath(workspace), globalVisionConfigPath()].filter(
    (p): p is string => !!p && existsSync(p),
  )
  for (const path of candidates) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DeveAgentVisionConfig>
      if (raw && (raw.baseUrl || raw.provider === "windows-ocr")) {
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

export function saveVisionConfig(
  config: DeveAgentVisionConfig,
  workspace?: string,
): { path: string } {
  const target = workspaceVisionConfigPath(workspace) ?? globalVisionConfigPath()
  mkdirSync(join(target, ".."), { recursive: true })
  writeFileSync(target, JSON.stringify(config, null, 2) + "\n", "utf8")
  return { path: target }
}

export function clearVisionConfig(workspace?: string): { cleared: boolean } {
  const target = workspaceVisionConfigPath(workspace) ?? globalVisionConfigPath()
  if (existsSync(target)) {
    rmSync(target)
    return { cleared: true }
  }
  return { cleared: false }
}

function sanitizeConfig(config: DeveAgentVisionConfig) {
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    language: config.language,
    apiKey: config.apiKey ? `${config.apiKey.slice(0, 6)}…${config.apiKey.slice(-4)}` : "",
    apiKeySet: Boolean(config.apiKey),
  }
}

/** Case-insensitive extension → image mime; tiff/bmp/heic etc. keep their real mime. */
function guessImageMime(image: string): string {
  const ext = image.includes(".") ? image.split(".").pop()!.toLowerCase() : ""
  switch (ext) {
    case "png":
      return "image/png"
    case "jpg":
    case "jpeg":
    case "jfif":
      return "image/jpeg"
    case "gif":
      return "image/gif"
    case "webp":
      return "image/webp"
    case "tiff":
    case "tif":
      return "image/tiff"
    case "bmp":
      return "image/bmp"
    case "avif":
      return "image/avif"
    case "heic":
    case "heif":
      return "image/heic"
    default:
      return "image/png"
  }
}

/** Turn a local path / http(s) URL / data URL into an OpenAI image_url value. */
function toImageUrl(image: string): string {
  if (image.startsWith("data:") || image.startsWith("http://") || image.startsWith("https://")) {
    return image
  }
  // Local file → base64 data URL (mime guessed from extension).
  if (existsSync(image)) {
    const mime = guessImageMime(image)
    const data = readFileSync(image).toString("base64")
    return `data:${mime};base64,${data}`
  }
  throw new Error(`image not found: ${image}`)
}

async function requestVision(
  config: DeveAgentVisionConfig,
  images: string[],
  prompt: string,
  maxTokens: number,
): Promise<{ text: string; status?: number; detail?: string }> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`
  const payload = {
    model: config.model,
    messages: [
      {
        role: "system",
        content: "You are an accurate image understanding assistant. Base every statement only on the provided image content.",
      },
      {
        role: "user",
        content: [
          ...images.map((image) => ({ type: "image_url", image_url: { url: toImageUrl(image) } })),
          { type: "text", text: prompt },
        ],
      },
    ],
    max_tokens: maxTokens,
  }
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90_000),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`HTTP ${response.status}: ${detail.slice(0, 2000)}`)
  }
  const result: unknown = await response.json().catch(() => ({}))
  const message = (result as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message
  const content = message?.content
  if (typeof content === "string") return { text: content.trim() }
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : ""))
      .join("")
      .trim()
    return { text }
  }
  throw new Error(`unexpected response shape: ${JSON.stringify(result).slice(0, 500)}`)
}

const WINDOWS_OCR_SCRIPT = `param(
    [Parameter(Mandatory = $true)][string]$ImagePath,
    [string]$Language = ""
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    return $netTask.Result
}
$fullPath = (Resolve-Path -LiteralPath $ImagePath).Path
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($fullPath)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
if ($Language) {
    $lang = New-Object Windows.Globalization.Language $Language
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
} else {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}
if (-not $engine) { throw 'Windows OCR engine unavailable' }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$result.Lines | ForEach-Object { $_.Text }
`

export async function windowsOcr(imagePath: string, language?: string): Promise<string> {
  const scriptPath = join(tmpdir(), `deveagent-ocr-${randomUUID()}.ps1`)
  writeFileSync(scriptPath, WINDOWS_OCR_SCRIPT, "utf8")
  try {
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-ImagePath", imagePath]
    if (language) args.push("-Language", language)
    const output = await new Promise<string>((resolve, reject) => {
      execFile("powershell.exe", args, { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
        if (error) reject(new Error(error.message))
        else resolve(stdout)
      })
    })
    return output.trim()
  } finally {
    rmSync(scriptPath, { force: true })
  }
}

const MACOS_OCR_SCRIPT = `import Foundation
import Vision
import AppKit
let path = CommandLine.arguments[1]
guard let image = NSImage(contentsOfFile: path),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    fputs("cannot load image", stderr)
    exit(1)
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
if CommandLine.arguments.count > 2 { request.recognitionLanguages = [CommandLine.arguments[2]] }
let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
try handler.perform([request])
for obs in request.results ?? [] {
    if let top = obs.topCandidates(1).first { print(top.string) }
}
`

export async function macosOcr(imagePath: string, language?: string): Promise<string> {
  const scriptPath = join(tmpdir(), `deveagent-ocr-${randomUUID()}.swift`)
  writeFileSync(scriptPath, MACOS_OCR_SCRIPT, "utf8")
  try {
    // Pass every argument as its own argv element — never interpolate the
    // image path into a shell string (macOS filenames may contain quotes/$).
    const args = [scriptPath, imagePath, ...(language ? [language] : [])]
    const output = await new Promise<string>((resolve, reject) => {
      execFile("swift", args, { timeout: 90_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
        if (error) reject(new Error(error.message))
        else resolve(stdout)
      })
    })
    return output.trim()
  } finally {
    rmSync(scriptPath, { force: true })
  }
}

/**
 * Run the full vision chain for an image:
 *   1. configured vision API (if any)
 *   2. Windows OCR / macOS OCR (built-in, offline)
 * Returns the recognized text plus the source that produced it.
 *
 * ponytail: `sink` routes ALL telemetry writes to a throwaway object instead of
 * the module-global counters, so one-off/manual calls (e.g. the HTTP
 * vision-analyze route) cannot pollute the counters the dashboard reads. When
 * omitted, the module-global behavior is preserved.
 */
export async function runVisionChain(
  image: string,
  prompt: string,
  workspace?: string,
  sink?: DeveAgentVisionTelemetry,
): Promise<{ source: "api" | "windows-ocr" | "macos-ocr" | "none"; text?: string; error?: string }> {
  const t = sink ?? telemetry
  const config = loadVisionConfig(workspace)
  // Validate the image input first: a missing/invalid local file is an input
  // error, not an API failure, so it must not count against the telemetry.
  let imageUrl: string
  try {
    imageUrl = toImageUrl(image)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const ocr = await runOcrFallback(image, config?.language)
    // A bad input is not a "fallback" (no API/config was exercised for it),
    // so it must not inflate the ocrFallbacks counter.
    t.lastSource = ocr.source
    t.lastError = `invalid image input: ${message}`.slice(0, 500)
    t.lastAt = Date.now()
    return { ...ocr, error: `invalid image input: ${message}` }
  }
  if (config && config.provider !== "windows-ocr" && config.baseUrl && config.apiKey && config.model) {
    try {
      const { text } = await requestVision(config, [imageUrl], prompt, 1024)
      if (text) {
        recordApiCall(true, 200, null, t)
        t.lastSource = "api"
        t.lastAt = Date.now()
        return { source: "api", text }
      }
      recordApiCall(true, 200, null, t)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const httpMatch = message.match(/^HTTP (\d+):/)
      recordApiCall(false, httpMatch ? Number(httpMatch[1]) : null, `vision API failed: ${message}`, t)
      // A real API error (including 403) is reported, then we fall back to OCR.
      const ocr = await runOcrFallback(image, config.language)
      if (ocr.text) t.ocrFallbacks += 1
      t.lastSource = ocr.source
      t.lastAt = Date.now()
      return { ...ocr, error: `vision API failed: ${message}` }
    }
  }
  const ocr = await runOcrFallback(image, config?.language)
  if (ocr.text) t.ocrFallbacks += 1
  t.lastSource = ocr.source
  t.lastAt = Date.now()
  return ocr
}

async function runOcrFallback(image: string, language?: string): Promise<{ source: "windows-ocr" | "macos-ocr" | "none"; text?: string; error?: string }> {
  // data: URLs (pasted images) cannot be opened by the OS OCR engines, so
  // decode them to a temp file first and clean up afterwards.
  let localPath = image
  const dataMatch = image.match(/^data:image\/([^;]+);base64,(.+)$/)
  if (dataMatch) {
    const ext = dataMatch[1].replace(/[^a-z0-9]/gi, "").toLowerCase() || "png"
    localPath = join(tmpdir(), `deveagent-img-${randomUUID()}.${ext}`)
    writeFileSync(localPath, Buffer.from(dataMatch[2], "base64"))
  }
  if (!existsSync(localPath)) {
    if (dataMatch) rmSync(localPath, { force: true })
    return { source: "none", error: `image not found locally: ${image} (OCR needs a local file)` }
  }
  try {
    if (process.platform === "win32") {
      const text = await windowsOcr(localPath, language)
      return text ? { source: "windows-ocr", text } : { source: "windows-ocr", error: "OCR returned no text" }
    }
    if (process.platform === "darwin") {
      const text = await macosOcr(localPath, language)
      return text ? { source: "macos-ocr", text } : { source: "macos-ocr", error: "OCR returned no text" }
    }
    return { source: "none", error: `no OCR fallback for platform ${process.platform}` }
  } catch (error) {
    return { source: "none", error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (dataMatch) rmSync(localPath, { force: true })
  }
}

/**
 * Minimal connectivity probe — surfaces the real HTTP status/body for diagnosis.
 *
 * ponytail: like `runVisionChain`, `sink` routes telemetry writes to a
 * throwaway object so manual/diagnostic probes (the `vision-test` tool and the
 * HTTP `/api/deveagent/vision-test` route) cannot pollute the counters the
 * dashboard reads. When omitted, the module-global behavior is preserved.
 */
export async function testVisionConnection(
  config: DeveAgentVisionConfig,
  workspace?: string,
  sink?: DeveAgentVisionTelemetry,
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
  if (config.provider === "windows-ocr") {
    return { ...base, ok: true, detail: "Windows OCR 离线识别，无需 API。" }
  }
  if (!config.baseUrl) return { ...base, ok: false, detail: "未配置 base URL。" }
  if (!config.apiKey) return { ...base, ok: false, detail: "未配置 API key。" }
  if (!config.model) return { ...base, ok: false, detail: "未配置模型名。" }
  try {
    // 1x1 transparent PNG (data URL) keeps the probe tiny.
    const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
    const { text } = await requestVision(config, [pixel], "Reply with the single word OK", 16)
    recordApiCall(true, 200, null, sink)
    return { ...base, ok: true, detail: text.slice(0, 200) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const match = message.match(/^HTTP (\d+): (.*)$/s)
    const httpStatus = match ? Number(match[1]) : null
    recordApiCall(false, httpStatus, message, sink)
    if (match) {
      return { ...base, ok: false, status: httpStatus ?? undefined, detail: match[2].slice(0, 2000) }
    }
    return { ...base, ok: false, detail: message.slice(0, 2000) }
  }
}

export function visionStatus(workspace?: string): {
  configured: boolean
  config?: ReturnType<typeof sanitizeConfig>
  path?: string
  telemetry: DeveAgentVisionTelemetry
} {
  const config = loadVisionConfig(workspace)
  if (!config) return { configured: false, telemetry: visionTelemetry() }
  const path = workspaceVisionConfigPath(workspace) ?? globalVisionConfigPath()
  return { configured: true, config: sanitizeConfig(config), path, telemetry: visionTelemetry() }
}

export function validateVisionConfig(config: DeveAgentVisionConfig): string | null {
  if (!config.provider) return "provider 不能为空"
  if (config.provider !== "windows-ocr") {
    if (!config.baseUrl) return "base URL 不能为空"
    if (!config.apiKey) return "API key 不能为空"
    if (!config.model) return "模型名不能为空"
  }
  return null
}

// ---------------------------------------------------------------------------
// Bounded fallback telemetry. Keeps only a summary (counters + last error), so
// it can never grow unbounded. `visionStatus()` and the dashboard read it.
// ---------------------------------------------------------------------------

export interface DeveAgentVisionTelemetry {
  apiCalls: number
  apiFailures: number
  ocrFallbacks: number
  lastSource: "api" | "windows-ocr" | "macos-ocr" | "none" | null
  lastError: string | null
  lastAt: number | null
  /** Last HTTP status seen from the vision API (e.g. 403). */
  lastHttpStatus: number | null
}

const telemetry: DeveAgentVisionTelemetry = {
  apiCalls: 0,
  apiFailures: 0,
  ocrFallbacks: 0,
  lastSource: null,
  lastError: null,
  lastAt: null,
  lastHttpStatus: null,
}

export function resetVisionTelemetry(): DeveAgentVisionTelemetry {
  telemetry.apiCalls = 0
  telemetry.apiFailures = 0
  telemetry.ocrFallbacks = 0
  telemetry.lastSource = null
  telemetry.lastError = null
  telemetry.lastAt = null
  telemetry.lastHttpStatus = null
  return { ...telemetry }
}

/**
 * Fresh throwaway telemetry sink. One-off/manual calls (the HTTP
 * `vision-analyze` route, probes) record into this instead of the module-global
 * counters the dashboard reads, so testing the chain never pollutes production
 * telemetry. Defaults to the global sink so existing callers keep their behavior.
 */
export function newVisionTelemetry(): DeveAgentVisionTelemetry {
  return {
    apiCalls: 0,
    apiFailures: 0,
    ocrFallbacks: 0,
    lastSource: null,
    lastError: null,
    lastAt: null,
    lastHttpStatus: null,
  }
}

function recordApiCall(
  success: boolean,
  httpStatus: number | null,
  error: string | null,
  sink: DeveAgentVisionTelemetry = telemetry,
) {
  sink.apiCalls += 1
  if (!success) sink.apiFailures += 1
  sink.lastHttpStatus = httpStatus ?? sink.lastHttpStatus
  if (error) sink.lastError = error.slice(0, 500)
  sink.lastAt = Date.now()
}

export function visionTelemetry(): DeveAgentVisionTelemetry {
  return { ...telemetry }
}

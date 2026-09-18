import { createHash, randomUUID } from "node:crypto"
import { createReadStream, existsSync } from "node:fs"
import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { Global } from "@opencode-ai/core/global"
import { Archive } from "../util/archive"
import { Process } from "../util/process"

const RELEASE_VERSION = "v1.9.2"
const BINARY_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${RELEASE_VERSION}/whisper-bin-x64.zip`
const BINARY_SHA256 = "49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a"
const MODEL_NAME = "ggml-base-q5_1.bin"
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}?download=true`
const MODEL_SHA256 = "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898"
const MODEL_BYTES = 59_707_625

type InstallPhase = "idle" | "binary" | "extract" | "model" | "ready" | "error"

let installState: { phase: InstallPhase; received: number; total: number; error?: string } = {
  phase: "idle",
  received: 0,
  total: 0,
}
let installTask: Promise<LocalSttStatus> | undefined

function paths() {
  const configuredRoot = process.env.DEVEAGENT_STT_HOME?.trim()
  const root = configuredRoot
    ? join(configuredRoot, `whisper.cpp-${RELEASE_VERSION}`)
    : join(Global.Path.cache, "deveagent", "stt", `whisper.cpp-${RELEASE_VERSION}`)
  return {
    root,
    archive: join(root, "downloads", "whisper-bin-x64.zip"),
    runtime: join(root, "runtime"),
    binary: join(root, "runtime", "Release", "whisper-cli.exe"),
    model: join(root, "models", MODEL_NAME),
  }
}

export interface LocalSttStatus {
  supported: boolean
  ready: boolean
  installing: boolean
  phase: InstallPhase
  received: number
  total: number
  version: string
  model: string
  modelBytes: number
  root: string
  error?: string
}

export function localSttStatus(): LocalSttStatus {
  const value = paths()
  const ready = process.platform === "win32" && existsSync(value.binary) && existsSync(value.model)
  return {
    supported: process.platform === "win32",
    ready,
    installing: Boolean(installTask),
    phase: ready ? "ready" : installState.phase,
    received: installState.received,
    total: installState.total,
    version: RELEASE_VERSION,
    model: MODEL_NAME,
    modelBytes: MODEL_BYTES,
    root: value.root,
    error: installState.error,
  }
}

async function sha256(path: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

// reader.read() with an idle bound: a stalled stream (proxy blackholing the
// connection after headers) must reject so the caller can fail over to the
// mirror / curl / powershell instead of hanging the install forever.
async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`下载停滞（${idleMs / 1000}s 无数据）`)), idleMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function verified(path: string, expected: string) {
  return existsSync(path) && (await sha256(path)) === expected
}

// huggingface.co is unreachable from mainland China networks; the mirror
// serves identical files and the SHA256 check makes the swap safe.
export function downloadUrlCandidates(url: string): string[] {
  return url.includes("huggingface.co") ? [url, url.replace("huggingface.co", "hf-mirror.com")] : [url]
}

async function download(url: string, target: string, expected: string, phase: InstallPhase) {
  if (await verified(target, expected)) return
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.download`
  let lastError: unknown
  const urls = downloadUrlCandidates(url)
  const fetchAttempts = process.platform === "win32" ? 1 : 3
  for (const attemptUrl of urls) {
    for (let attempt = 1; attempt <= fetchAttempts; attempt++) {
      await rm(temp, { force: true })
      try {
        const response = await fetch(attemptUrl, { headers: { "user-agent": "DeveAgentStudio local STT installer" } })
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
        const total = Number(response.headers.get("content-length") || 0)
        installState = { phase, received: 0, total }
        const file = await open(temp, "w")
        try {
          const reader = response.body.getReader()
          let offset = 0
          while (true) {
            // Idle watchdog: a stalled connection must fail over to curl /
            // powershell / the mirror instead of hanging the install forever.
            const next = await readWithIdleTimeout(reader, 30_000)
            if (next.done) break
            await file.write(next.value, 0, next.value.byteLength, offset)
            offset += next.value.byteLength
            installState = { phase, received: offset, total }
          }
        } finally {
          await file.close()
        }
        const actual = await sha256(temp)
        if (actual !== expected) throw new Error(`${basename(target)} 校验失败。`)
        await rm(target, { force: true })
        await rename(temp, target)
        return
      } catch (error) {
        lastError = error
        await rm(temp, { force: true })
        if (attempt < fetchAttempts) await new Promise((resolve) => setTimeout(resolve, attempt * 750))
      }
    }
  }
  const primaryUrl = urls[0]
  if (process.platform === "win32") {
    for (const attemptUrl of urls) {
      await rm(temp, { force: true })
      const result = await Process.run([
        "curl.exe",
        "--fail",
        "--location",
        "--retry", "3",
        "--connect-timeout", "20",
        "--max-time", "900",
        "--output", temp,
        attemptUrl,
      ], { nothrow: true })
      if (result.code === 0 && await verified(temp, expected)) {
        await rm(target, { force: true })
        await rename(temp, target)
        return
      }
      await rm(temp, { force: true })
      const detail = result.stderr.toString().trim()
      if (detail) lastError = new Error(detail.slice(0, 500))
    }

    const psUrl = primaryUrl.replaceAll("'", "''")
    const psTarget = temp.replaceAll("'", "''")
    const powershell = await Process.run([
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '${psUrl}' -OutFile '${psTarget}'`,
    ], { nothrow: true })
    if (powershell.code === 0 && await verified(temp, expected)) {
      await rm(target, { force: true })
      await rename(temp, target)
      return
    }
    await rm(temp, { force: true })
    const powershellDetail = powershell.stderr.toString().trim()
    if (powershellDetail) lastError = new Error(powershellDetail.slice(0, 500))
  }
  throw new Error(`下载 ${basename(target)} 失败：${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function install() {
  if (process.platform !== "win32") throw new Error("本地 Whisper 首版仅支持 Windows x64。")
  const value = paths()
  await mkdir(value.root, { recursive: true })
  await download(BINARY_URL, value.archive, BINARY_SHA256, "binary")
  if (!existsSync(value.binary)) {
    installState = { phase: "extract", received: 0, total: 0 }
    await rm(value.runtime, { recursive: true, force: true })
    await mkdir(value.runtime, { recursive: true })
    await Archive.extractZip(value.archive, value.runtime)
  }
  if (!existsSync(value.binary)) throw new Error("whisper-cli.exe 解压后不存在。")
  await download(MODEL_URL, value.model, MODEL_SHA256, "model")
  installState = { phase: "ready", received: MODEL_BYTES, total: MODEL_BYTES }
  return { ...localSttStatus(), installing: false }
}

export function installLocalStt() {
  if (installTask) return installTask
  installTask = install().catch((error) => {
    installState = {
      phase: "error",
      received: 0,
      total: 0,
      error: error instanceof Error ? error.message : String(error),
    }
    throw error
  }).finally(() => {
    installTask = undefined
  })
  return installTask
}

export async function transcribeLocalAudio(input: { audioBase64: string; mimeType?: string; language?: string }) {
  const status = localSttStatus()
  if (!status.ready) throw new Error("本地 Whisper 尚未安装。")
  if (input.mimeType && !/^audio\/(wav|wave|x-wav)(?:;|$)/i.test(input.mimeType)) {
    throw new Error("本地 Whisper 只接受 WAV；请更新桌面端后重试。")
  }
  const audio = Buffer.from(input.audioBase64, "base64")
  if (!audio.length) throw new Error("录音为空。")
  if (audio.length > 32 * 1024 * 1024) throw new Error("录音超过 32 MB 限制。")

  const id = randomUUID()
  const inputPath = join(Global.Path.tmp, `deveagent-stt-${id}.wav`)
  const outputBase = join(Global.Path.tmp, `deveagent-stt-${id}`)
  const outputPath = `${outputBase}.txt`
  const value = paths()
  await Bun.write(inputPath, audio)
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 180_000)
  try {
    const language = (input.language || "auto").split(/[-_]/, 1)[0] || "auto"
    await Process.run([
      value.binary,
      "--model", value.model,
      "--file", inputPath,
      "--language", language,
      "--output-txt",
      "--output-file", outputBase,
      "--no-timestamps",
      "--no-prints",
    ], { abort: abort.signal })
    const text = (await readFile(outputPath, "utf8")).trim()
    if (!text) throw new Error("本地 Whisper 未返回文字。")
    return text
  } finally {
    clearTimeout(timer)
    await Promise.all([rm(inputPath, { force: true }), rm(outputPath, { force: true })])
  }
}

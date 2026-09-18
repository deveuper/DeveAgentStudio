import { createHash } from "node:crypto"
import { mkdir, readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"

const MAX_INPUT_BYTES = 25 * 1024 * 1024
const CONVERSION_TIMEOUT_MS = 60_000
const MAX_ERROR_TEXT = 2_000
const SUPPORTED_EXTENSIONS = new Set([
  ".docx",
  ".xlsx",
  ".xls",
  ".pptx",
  ".pdf",
  ".html",
  ".htm",
  ".csv",
  ".json",
  ".xml",
  ".epub",
  ".zip",
])

export type DocumentTransformResult = {
  sourcePath: string
  markdownPath: string
  cached: boolean
  provenance: MarkItDownProvenance
}

export type MarkItDownProvenance = {
  converter: "microsoft/markitdown"
  sourceRelativePath: string
  sourceBytes: number
  sourceSha256: string
  sourceModifiedAt: number
  markdownRelativePath: string
  runtimeCommand?: string
}

export type MarkItDownAttempt = {
  command: string
  error: string
}

export type MarkItDownFailureReport = {
  converter: "microsoft/markitdown"
  kind: "runtime"
  sourceRelativePath: string
  sourceBytes?: number
  sourceSha256?: string
  attempts: MarkItDownAttempt[]
  rawDocumentForwardedToModel: false
  message: string
}

export class MarkItDownConversionError extends Error {
  constructor(public readonly report: MarkItDownFailureReport) {
    super(report.message)
    this.name = "MarkItDownConversionError"
  }
}

export type MarkItDownRuntimeStatus = {
  available: boolean
  command?: string
  error?: string
  attempts?: MarkItDownAttempt[]
}

export function isMarkItDownSupported(filePath: string) {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

function runMarkItDown(input: string, output: string, command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args, "-m", "markitdown", input, "-o", output], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    })
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`MarkItDown conversion timed out after ${CONVERSION_TIMEOUT_MS}ms`))
    }, CONVERSION_TIMEOUT_MS)
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      if (code === 0) return resolve()
      reject(new Error((stderr.trim() || `MarkItDown exited with code ${code ?? "unknown"}`).slice(0, MAX_ERROR_TEXT)))
    })
  })
}

async function probeMarkItDown(command: string, args: string[]): Promise<MarkItDownRuntimeStatus> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args, "-c", "import markitdown"], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    })
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill()
      resolve({ available: false, error: `probe timed out after ${CONVERSION_TIMEOUT_MS}ms` })
    }, CONVERSION_TIMEOUT_MS)
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.once("error", (error) => {
      clearTimeout(timer)
      resolve({ available: false, error: error.message })
    })
    child.once("close", (code) =>
      (clearTimeout(timer), resolve(code === 0 ? { available: true, command } : { available: false, error: stderr.trim() || `exit ${code ?? "unknown"}` })),
    )
  })
}

function pythonCandidates(): Array<[string, string[]]> {
  if (process.env.DEVEAGENT_PYTHON) return [[process.env.DEVEAGENT_PYTHON, [] as string[]]]
  const system: Array<[string, string[]]> =
    process.platform === "win32"
      ? [["py", ["-3"]], ["python", [] as string[]]]
      : [["python3", [] as string[]], ["python", [] as string[]]]
  const bundled = process.env.DEVEAGENT_BUNDLED_PYTHON
  return bundled ? [[bundled, [] as string[]], ...system] : system
}

export async function getMarkItDownRuntimeStatus(): Promise<MarkItDownRuntimeStatus> {
  const attempts: MarkItDownAttempt[] = []
  for (const [command, args] of pythonCandidates()) {
    const status = await probeMarkItDown(command, args)
    if (status.available) return status
    attempts.push({ command, error: status.error ?? "runtime probe failed" })
  }
  return { available: false, error: "Python with the markitdown module was not found", attempts }
}

export async function convertWithMarkItDown(input: {
  filePath: string
  workspace: string
}): Promise<DocumentTransformResult> {
  const workspaceCandidate = path.resolve(input.workspace)
  const sourceCandidate = path.resolve(path.isAbsolute(input.filePath) ? input.filePath : path.join(workspaceCandidate, input.filePath))
  const lexicalRelative = path.relative(workspaceCandidate, sourceCandidate)
  if (!lexicalRelative || lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) {
    throw new Error("Document conversion is limited to the current workspace")
  }
  // Resolve both ends before checking containment. A lexical path check alone
  // lets a workspace symlink point the converter at an arbitrary outside file.
  const [workspace, source] = await Promise.all([realpath(workspaceCandidate), realpath(sourceCandidate)])
  const relative = path.relative(workspace, source)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Document conversion is limited to the current workspace")
  }
  if (!isMarkItDownSupported(source)) throw new Error(`Unsupported document format: ${path.extname(source)}`)

  const info = await stat(source)
  if (!info.isFile()) throw new Error("Document conversion requires a regular file")
  if (info.size > MAX_INPUT_BYTES) throw new Error(`Document exceeds the ${MAX_INPUT_BYTES / 1024 / 1024}MB limit`)

  const sourceSha256 = createHash("sha256").update(await readFile(source)).digest("hex")
  const sourceRelativePath = path.relative(workspace, source).replaceAll("\\", "/")
  const hash = sourceSha256.slice(0, 24)
  const outputDir = path.join(workspace, ".deveagent", "converted")
  const markdownPath = path.join(outputDir, `${hash}.md`)
  const markdownRelativePath = path.relative(workspace, markdownPath).replaceAll("\\", "/")
  const result = (runtimeCommand?: string, cached = false): DocumentTransformResult => ({
    sourcePath: source,
    markdownPath,
    cached,
    provenance: {
      converter: "microsoft/markitdown",
      sourceRelativePath,
      sourceBytes: info.size,
      sourceSha256,
      sourceModifiedAt: info.mtimeMs,
      markdownRelativePath,
      ...(runtimeCommand ? { runtimeCommand } : {}),
    },
  })
  try {
    const cached = await stat(markdownPath)
    if (cached.isFile() && cached.size > 0) return result(undefined, true)
  } catch {}

  await mkdir(outputDir, { recursive: true })
  let lastError: unknown
  const attempts: MarkItDownAttempt[] = []
  for (const [candidate, candidateArgs] of pythonCandidates()) {
    try {
      await runMarkItDown(source, markdownPath, candidate, candidateArgs)
      return result(candidate)
    } catch (error) {
      lastError = error
      attempts.push({
        command: candidate,
        error: (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_TEXT),
      })
    }
  }
  // Distinguish a real conversion failure (the document itself could not be
  // parsed) from an unavailable runtime (python/markitdown missing or broken).
  const lastMessage = lastError instanceof Error ? lastError.message : String(lastError)
  const conversionFailure = /FileConversionException|File conversion failed|^[0-9]+:[0-9]+: /.test(lastMessage)
  const message = conversionFailure
    ? `MarkItDown could not convert the document: ${lastMessage}`
    : `MarkItDown is unavailable: ${lastMessage}`
  throw new MarkItDownConversionError({
    converter: "microsoft/markitdown",
    kind: "runtime",
    sourceRelativePath,
    sourceBytes: info.size,
    sourceSha256,
    attempts,
    rawDocumentForwardedToModel: false,
    message,
  })
}

#!/usr/bin/env bun
/**
 * Prepares the bundled, pinned Python runtime used for MarkItDown document
 * conversion in packaged Windows builds.
 *
 * Layout produced:
 *   resources/python-runtime/python.exe        (Python embeddable distribution)
 *   resources/python-runtime/Lib/site-packages (markitdown + minimal format deps)
 *   resources/python-runtime-manifest.json     (resolved version lock record)
 *
 * The script is idempotent: when the manifest matches the pinned inputs and
 * python.exe exists, it exits without touching the network.
 * Set DEVEAGENT_SKIP_PYTHON_RUNTIME=1 to opt out (e.g. offline dev builds).
 */
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const PYTHON_VERSION = "3.12.10"
const PYTHON_ZIP_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`
const PYTHON_ZIP_SHA256 = "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3"
const GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py"
const GET_PIP_SHA256 = "a341e1a43e38001c551a1508a73ff23636a11970b61d901d9a1cad2a18f57055"

// markitdown 0.1.3 pins onnxruntime<=1.20.1 on win32 itself; the rest of the
// list is the minimal format-dependency closure for docx/xlsx/pptx/pdf plus
// pandas (required by markitdown's xlsx/xls converters) — the [all] extra is
// deliberately NOT installed.
const PINNED_PACKAGES = [
  "markitdown==0.1.3",
  "onnxruntime==1.20.1",
  "mammoth==1.12.0",
  "lxml==6.1.1",
  "openpyxl==3.1.5",
  "xlrd==2.0.2",
  "pdfminer-six==20260107",
  "python-pptx==1.0.2",
  "pandas==3.0.5",
] as const
// sympy/mpmath are declared by onnxruntime but unused by its inference path
// (verified by the smoke conversion below); pip/setuptools are build-time only.
const REMOVED_PACKAGES = ["sympy", "mpmath", "pip", "setuptools"]

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const runtimeDir = path.join(packageDir, "resources", "python-runtime")
const manifestPath = path.join(packageDir, "resources", "python-runtime-manifest.json")
const cacheDir = path.join(packageDir, "resources", ".python-runtime-cache")

function expectedManifest() {
  return { python: PYTHON_VERSION, packages: [...PINNED_PACKAGES] }
}

async function upToDate(): Promise<boolean> {
  if (!existsSync(path.join(runtimeDir, "python.exe")) || !existsSync(manifestPath)) return false
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    return JSON.stringify(manifest.inputs) === JSON.stringify(expectedManifest())
  } catch {
    return false
  }
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex")
}

async function download(url: string, dest: string, expectedSha256: string) {
  if (existsSync(dest) && (await sha256(dest)) === expectedSha256) {
    console.log(`cached: ${path.basename(dest)}`)
    return
  }
  console.log(`downloading ${url}`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`download failed: ${url} -> HTTP ${response.status}`)
  await writeFile(dest, Buffer.from(await response.arrayBuffer()))
  const actual = await sha256(dest)
  if (actual !== expectedSha256) {
    await rm(dest, { force: true })
    throw new Error(`SHA256 mismatch for ${url}: expected ${expectedSha256}, got ${actual}`)
  }
}

async function run(command: string, args: string[], env: Record<string, string> = {}) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...env },
    maxBuffer: 64 * 1024 * 1024,
  })
  return { stdout, stderr }
}

async function pruneDirs(root: string, names: Set<string>) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (!entry.isDirectory()) continue
    if (names.has(entry.name)) {
      await rm(full, { recursive: true, force: true })
      continue
    }
    await pruneDirs(full, names)
  }
}

async function main() {
  if (process.env.DEVEAGENT_SKIP_PYTHON_RUNTIME === "1") {
    console.log("DEVEAGENT_SKIP_PYTHON_RUNTIME=1, skipping bundled Python runtime")
    return
  }
  if (process.platform !== "win32") {
    console.log("bundled Python runtime is only built on win32, skipping")
    return
  }
  if (await upToDate()) {
    console.log(`bundled Python runtime is up to date (python ${PYTHON_VERSION}, markitdown 0.1.3)`)
    return
  }

  await mkdir(cacheDir, { recursive: true })
  const zipPath = path.join(cacheDir, `python-${PYTHON_VERSION}-embed-amd64.zip`)
  const getPipPath = path.join(cacheDir, "get-pip.py")
  await download(PYTHON_ZIP_URL, zipPath, PYTHON_ZIP_SHA256)
  await download(GET_PIP_URL, getPipPath, GET_PIP_SHA256)

  await rm(runtimeDir, { recursive: true, force: true })
  await mkdir(runtimeDir, { recursive: true })
  // bsdtar shipped with Windows extracts zip archives.
  await execFileAsync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), [
    "-xf",
    zipPath,
    "-C",
    runtimeDir,
  ])

  // Enable site-packages in the embeddable distribution.
  const pthPath = path.join(runtimeDir, `python${PYTHON_VERSION.split(".")[0]}${PYTHON_VERSION.split(".")[1]}._pth`)
  const pth = await readFile(pthPath, "utf8")
  if (!pth.includes("#import site") && !pth.includes("import site")) throw new Error(`unexpected ._pth layout: ${pthPath}`)
  await writeFile(pthPath, pth.replace("#import site", "import site"))

  const python = path.join(runtimeDir, "python.exe")
  await run(python, [getPipPath, "--no-warn-script-location"])
  await run(python, ["-m", "pip", "install", "--no-cache-dir", "--no-warn-script-location", ...PINNED_PACKAGES])
  const freeze = (await run(python, ["-m", "pip", "freeze"])).stdout.trim().split(/\r?\n/).sort()
  await run(python, ["-m", "pip", "uninstall", "-y", ...REMOVED_PACKAGES]).catch(() => {})

  // Trim import caches and bundled test suites (saves ~90MB).
  await pruneDirs(path.join(runtimeDir, "Lib", "site-packages"), new Set(["__pycache__", "test", "tests"]))

  // Smoke: every import path the converters touch must load, and a real CSV
  // conversion must succeed, before the runtime is marked ready.
  await run(python, ["-c", "import markitdown, magika, onnxruntime, pandas, openpyxl, pptx, pdfminer, mammoth, lxml"])
  const smokeCsv = path.join(cacheDir, "smoke.csv")
  const smokeOut = path.join(cacheDir, "smoke.md")
  await writeFile(smokeCsv, "name,value\nsmoke,1\n", "utf8")
  await run(python, ["-m", "markitdown", smokeCsv, "-o", smokeOut])
  if (!(await readFile(smokeOut, "utf8")).includes("smoke")) throw new Error("MarkItDown smoke conversion failed")

  // Drop caches regenerated by the smoke run.
  await pruneDirs(path.join(runtimeDir, "Lib", "site-packages"), new Set(["__pycache__"]))

  const size = await dirSize(runtimeDir)
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        inputs: expectedManifest(),
        resolved: freeze,
        sizeBytes: size,
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  )
  console.log(`bundled Python runtime ready: ${Math.round(size / 1024 / 1024)}MB at ${runtimeDir}`)
}

async function dirSize(root: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    total += entry.isDirectory() ? await dirSize(full) : (await stat(full)).size
  }
  return total
}

await main()

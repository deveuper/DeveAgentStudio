// Public pre-push secret scan. It scans the Git index plus untracked publish
// candidates, never prints matched values, and only accepts exact hashed
// fixture entries from secret-scan-allowlist.json.
// Usage: node script/scan-secrets.mjs [repo-root]
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { extname, join, relative, resolve } from "node:path"

const root = resolve(process.argv[2] || ".")
const scriptDirectory = new URL(".", import.meta.url)
const allowlist = JSON.parse(readFileSync(new URL("secret-scan-allowlist.json", scriptDirectory), "utf8"))
const allowed = new Set(
  (allowlist.entries ?? []).map((entry) => `${entry.path}|${entry.label}|${entry.sha256}`),
)
const skippedExtensions = new Set([
  ".dll", ".dylib", ".exe", ".gif", ".ico", ".jpeg", ".jpg", ".lock", ".map",
  ".pyd", ".pyc", ".so", ".ttf", ".wasm", ".webp", ".woff", ".woff2",
])
const skippedFiles = new Set(["bun.lock", "Cargo.lock", "go.sum", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"])
const patterns = [
  [/sk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{20,}/g, "OpenAI/Anthropic-style key"],
  [/gh[oprsu]_[A-Za-z0-9]{20,}/g, "GitHub token"],
  [/AKIA[0-9A-Z]{16}/g, "AWS access key"],
  [/AIza[0-9A-Za-z_-]{30,}/g, "Google API key"],
  [/xox[baprs]-[A-Za-z0-9-]{20,}/g, "Slack token"],
  [/npm_[A-Za-z0-9]{30,}/g, "npm token"],
  [/\bBearer\s+[A-Za-z0-9._-]{20,}/g, "Bearer token"],
  [/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, "private key"],
  [/^\s*["']?(?:api[_-]?key|apiKey)["']?\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/gim, "API key assignment"],
  [/^\s*["']?(?:access[_-]?token|refresh[_-]?token|token)["']?\s*[:=]\s*["'][A-Za-z0-9_.\-]{20,}["']/gim, "token assignment"],
  [/^\s*["']?password["']?\s*[:=]\s*["'][^"']{12,}["']/gim, "password assignment"],
]
const candidatePattern = [
  "sk-(ant-|proj-|live-)?[A-Za-z0-9_-]{20,}",
  "gh[oprsu]_[A-Za-z0-9]{20,}",
  "AKIA[0-9A-Z]{16}",
  "AIza[0-9A-Za-z_-]{30,}",
  "xox[baprs]-[A-Za-z0-9-]{20,}",
  "npm_[A-Za-z0-9]{30,}",
  "Bearer[[:space:]]+[A-Za-z0-9._-]{20,}",
  "BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY",
  "(api[_-]?key|apiKey|access[_-]?token|refresh[_-]?token|token|password)[[:space:]]*[:=]",
].join("|")

function git(args, encoding = "utf8") {
  return execFileSync("git", ["-C", root, ...args], { encoding, maxBuffer: 64 * 1024 * 1024 })
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex")
}

function scanContent(file, content, source, findings) {
  if (Buffer.byteLength(content) > 2_000_000 || content.includes("\0")) return
  for (const [pattern, label] of patterns) {
    for (const match of content.matchAll(pattern)) {
      const line = content.slice(0, match.index).split("\n").length
      const key = `${file}|${label}|${digest(match[0])}`
      findings.push({ file, label, line, source, allowlisted: allowed.has(key) })
    }
  }
}

const trackedCandidates = spawnSync(
  "git",
  ["-C", root, "grep", "--cached", "-I", "-l", "-z", "-E", "-e", candidatePattern, "--"],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
)
if (trackedCandidates.status !== 0 && trackedCandidates.status !== 1) {
  process.stderr.write(trackedCandidates.stderr || "git grep failed\n")
  process.exit(2)
}
const tracked = (trackedCandidates.stdout ?? "").split("\0").filter(Boolean)
const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)
const findings = []

for (const file of tracked) {
  if (skippedFiles.has(file.split(/[\\/]/).at(-1)) || skippedExtensions.has(extname(file).toLowerCase())) continue
  try {
    scanContent(file.replaceAll("\\", "/"), git(["show", `:${file}`]), "index", findings)
  } catch {
    // Index entries may disappear during an intentional concurrent update.
  }
}

for (const file of untracked) {
  if (skippedFiles.has(file.split(/[\\/]/).at(-1)) || skippedExtensions.has(extname(file).toLowerCase())) continue
  const absolute = join(root, file)
  try {
    if (!existsSync(absolute) || statSync(absolute).size > 2_000_000) continue
    scanContent(relative(root, absolute).replaceAll("\\", "/"), readFileSync(absolute, "utf8"), "untracked", findings)
  } catch {
    // A file may disappear between Git enumeration and reading.
  }
}

for (const finding of findings) {
  const status = finding.allowlisted ? "allowlisted-fixture" : "BLOCKING"
  console.log(`[${status}:${finding.label}:${finding.source}] ${finding.file}:${finding.line}`)
}
const blocking = findings.filter((finding) => !finding.allowlisted).length
console.log(`scan complete: ${blocking} blocking, ${findings.length - blocking} exact allowlisted fixture hit(s)`)
if (blocking) process.exitCode = 1

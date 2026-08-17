// DeveAgent Studio Plugin for OpenCode
// =========================================
// Integrates MiMo Code workflows + Reasonix cache optimization into OpenCode.
// OpenCode's full UI (chat, file-tree, terminal, settings, i18n) is PRESERVED.
// This plugin ADDS features — never removes OpenCode functionality.
//
// MiMo Code features added:
//   - Plan/Build/Compose/Goal state machine prompts
//   - Checkpoint hooks (before/after tool execution)
//   - Memory injection (relevant past decisions & bug history)
//   - Skill suggestion based on task context
//   - Permission guardrails (.env/node_modules block, read-only mode enforcement)
//
// Reasonix features added:
//   - Byte-stable system prefix for DeepSeek prefix-cache reuse (measured per
//     session via cache-metrics tool / session status, never assumed fixed)
//   - stream_options.include_usage for cache tracking
//   - Session-level cache metrics accumulator
//
// Providers registered:
//   - DeepSeek, MiMo (Xiaomi Token Plan), OpenAI, OpenRouter, Gemini, Qwen, GLM, Kimi, Ollama

import { execFile as execFileCallback } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { asSchema } from "ai"
import { Identifier } from "@/id/id"
import { lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { tool, type Hooks, type PluginInput, type PluginModule, type PluginOptions } from "@opencode-ai/plugin"
import {
  convertWithMarkItDown,
  getMarkItDownRuntimeStatus,
  isMarkItDownSupported,
  MarkItDownConversionError,
} from "@/deveagent/document-transform"
import { appendDeveAgentMemoryNote, consolidateDeveAgentMemory, dismissDeveAgentMemoryCandidate, getDeveAgentMemoryCandidate, getDeveAgentMemoryTree, queryDeveAgentMemory, rebuildDeveAgentMemoryContext, reconcileDeveAgentMemory, rememberDeveAgentMemory, writeDeveAgentMemoryCheckpoint, writeDeveAgentMemoryProgress, type DeveAgentMemoryTranscriptMessage } from "./deveagent-memory"

export { appendDeveAgentMemoryNote, consolidateDeveAgentMemory, dismissDeveAgentMemoryCandidate, ensureDeveAgentMemoryScaffold, getDeveAgentMemoryCandidate, getDeveAgentMemoryTree, queryDeveAgentMemory, rebuildDeveAgentMemoryContext, reconcileDeveAgentMemory, rememberDeveAgentMemory, writeDeveAgentMemoryCheckpoint, writeDeveAgentMemoryProgress } from "./deveagent-memory"
import {
  clearVisionConfig,
  loadVisionConfig,
  newVisionTelemetry,
  runVisionChain,
  saveVisionConfig,
  testVisionConnection,
  validateVisionConfig,
  visionStatus,
  VISION_PROVIDER_PRESETS,
  type DeveAgentVisionConfig,
} from "./deveagent-vision"
export { clearVisionConfig, loadVisionConfig, newVisionTelemetry, resetVisionTelemetry, runVisionChain, saveVisionConfig, testVisionConnection, validateVisionConfig, visionStatus, visionTelemetry, VISION_PROVIDER_PRESETS } from "./deveagent-vision"
import {
  clearSttConfig,
  loadSttConfig,
  saveSttConfig,
  sttStatus,
  testSttConnection,
  validateSttConfig,
  STT_PROVIDER_PRESETS,
  type DeveAgentSttConfig,
} from "./deveagent-stt"
export { clearSttConfig, loadSttConfig, saveSttConfig, sttStatus, testSttConnection, validateSttConfig, STT_PROVIDER_PRESETS } from "./deveagent-stt"

/** Read only the bounded text tail of a real OpenCode session for MiMo-style rebuilds. */
export async function readDeveAgentRecentSessionMessages(input: {
  client: unknown
  sessionID: string
  directory?: string
  limit?: number
}): Promise<DeveAgentMemoryTranscriptMessage[]> {
  const messages = (input.client as {
    session?: { messages?: (args: unknown) => Promise<{ data?: unknown }> }
  }).session?.messages
  if (!messages) return []
  try {
    const response = await messages({
      path: { id: input.sessionID },
      query: { directory: input.directory, limit: Math.max(1, Math.min(input.limit ?? 24, 48)) },
    })
    const items = Array.isArray(response.data) ? response.data : []
    return items.flatMap((item): DeveAgentMemoryTranscriptMessage[] => {
      if (!item || typeof item !== "object") return []
      const value = item as { info?: { role?: unknown }; parts?: unknown }
      const parts = Array.isArray(value.parts) ? value.parts : []
      const text = parts
        .filter((part): part is { type?: unknown; text?: unknown } => Boolean(part) && typeof part === "object")
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => String(part.text).replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join(" ")
        .slice(0, 420)
      if (!text) return []
      return [{ role: typeof value.info?.role === "string" ? value.info.role : "message", text }]
    }).slice(-12)
  } catch {
    // ponytail: an unavailable session API must never break compaction or a memory tool.
    return []
  }
}

const COMPUTER_USE_KEYS = new Set(["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"])
const execFileAsync = promisify(execFileCallback)
const COMPUTER_USE_SHELL_MAX_COMMAND = 1_200
const COMPUTER_USE_SHELL_MAX_OUTPUT = 32_000
const COMPUTER_USE_SHELL_READ_ONLY_EXECUTABLES = new Set(["git", "rg", "where", "node", "bun", "python", "python3"])
const COMPUTER_USE_SHELL_GIT_COMMANDS = new Set(["status", "diff", "log", "show", "branch", "rev-parse", "ls-files"])
const COMPUTER_USE_SHELL_GIT_BLOCKED_FLAGS = new Set([
  "-c",
  "-C",
  "-p",
  "--config-env",
  "--exec-path",
  "--ext-diff",
  "--git-dir",
  "--no-pager",
  "--output",
  "--paginate",
  "--receive-pack",
  "--textconv",
  "--upload-pack",
  "--work-tree",
])
const COMPUTER_USE_SHELL_RG_BLOCKED_FLAGS = new Set([
  "--follow",
  "--hidden",
  "--no-ignore",
  "--no-ignore-global",
  "--no-ignore-parent",
  "--no-ignore-vcs",
  "--pre",
  "-L",
])

export type DeveAgentComputerUseShellCommand = { executable: string; args: string[] }
type ComputerUseShellParseResult = { ok: true; command: DeveAgentComputerUseShellCommand } | { ok: false; error: string }

function tokenizeComputerUseShellCommand(input: string): { tokens?: string[]; error?: string } {
  const tokens: string[] = []
  let current = ""
  let quoted: "'" | '"' | undefined
  let started = false

  for (let index = 0; index < input.length; index++) {
    const character = input[index]
    if (quoted) {
      if (character === quoted) {
        quoted = undefined
        started = true
        continue
      }
      if (character === "\\" && input[index + 1] && /[\\'"\s]/.test(input[index + 1])) {
        current += input[++index]
        started = true
        continue
      }
      current += character
      started = true
      continue
    }
    if (character === "'" || character === '"') {
      quoted = character
      started = true
      continue
    }
    if (character === "\\" && input[index + 1] && /[\\'"\s]/.test(input[index + 1])) {
      current += input[++index]
      started = true
      continue
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push(current)
        current = ""
        started = false
      }
      continue
    }
    current += character
    started = true
  }

  if (quoted) return { error: "unclosed quote" }
  if (started) tokens.push(current)
  return { tokens }
}

function isUnsafeComputerUsePath(value: string) {
  return /^([a-z]:|[\\/]{1,2}|\\\\[?.])/i.test(value) || /(^|[\\/])\.\.([\\/]|$)/.test(value)
}

function normalizeComputerUseExecutable(value: string) {
  const executable = value.toLowerCase()
  return executable.endsWith(".exe") ? executable.slice(0, -4) : executable
}

function validateComputerUseShellArgs(executable: string, args: string[]): string | undefined {
  if (args.some((argument) => isUnsafeComputerUsePath(argument))) return "absolute paths and parent-directory traversal are not allowed"

  if (executable === "git") {
    if (args.some((argument) => COMPUTER_USE_SHELL_GIT_BLOCKED_FLAGS.has(argument) || [...COMPUTER_USE_SHELL_GIT_BLOCKED_FLAGS].some((flag) => argument.startsWith(`${flag}=`)))) {
      return "git config, alternate worktree, upload, and output flags are not allowed"
    }
    const command = args.find((argument) => !argument.startsWith("-"))
    if (!command || !COMPUTER_USE_SHELL_GIT_COMMANDS.has(command)) return "only read-only git commands are allowed"
    if (command === "diff" && args.includes("--no-index")) return "git diff --no-index is not allowed"
    return undefined
  }

  if (executable === "rg") {
    if (args.some((argument) => COMPUTER_USE_SHELL_RG_BLOCKED_FLAGS.has(argument) || argument.startsWith("--pre=") || argument.startsWith("--glob=../") || argument.startsWith("--glob=..\\"))) {
      return "ripgrep preprocessors and symlink-following are not allowed"
    }
    return undefined
  }

  if (executable === "where") {
    return args.length === 1 && !args[0].startsWith("-") ? undefined : "where requires exactly one executable name"
  }

  return args.length === 1 && (args[0] === "--version" || args[0] === "-v") ? undefined : "runtime commands are limited to --version"
}

export function parseDeveAgentComputerUseShellCommand(raw: string): ComputerUseShellParseResult {
  const input = raw.trim()
  if (!input) return { ok: false, error: "command is required" }
  if (input.length > COMPUTER_USE_SHELL_MAX_COMMAND) return { ok: false, error: "command is too long" }
  if (/[\r\n;&|<>`]/.test(input) || input.includes("$(") || input.includes("${")) {
    return { ok: false, error: "shell operators and command substitution are not allowed" }
  }

  const tokenized = tokenizeComputerUseShellCommand(input)
  if (!tokenized.tokens?.length) return { ok: false, error: tokenized.error ?? "command is required" }
  const [rawExecutable, ...args] = tokenized.tokens
  const executable = normalizeComputerUseExecutable(rawExecutable)
  if (rawExecutable.includes("/") || rawExecutable.includes("\\") || rawExecutable.includes(":")) {
    return { ok: false, error: "executable paths are not allowed" }
  }
  if (!COMPUTER_USE_SHELL_READ_ONLY_EXECUTABLES.has(executable)) return { ok: false, error: `executable is not allowlisted: ${rawExecutable}` }
  const error = validateComputerUseShellArgs(executable, args)
  if (error) return { ok: false, error }
  return { ok: true, command: { executable: rawExecutable, args } }
}

async function validateComputerUseArgumentPaths(root: string, workingDirectory: string, args: string[]) {
  for (const argument of args) {
    if (!argument || argument.startsWith("-") || isUnsafeComputerUsePath(argument)) continue
    const candidate = path.resolve(workingDirectory, argument)
    const metadata = await lstat(candidate).catch(() => undefined)
    if (!metadata) continue
    const resolved = await realpath(candidate).catch(() => undefined)
    if (!resolved) return "command path could not be resolved"
    const relative = path.relative(root, resolved)
    if (relative.startsWith("..") || path.isAbsolute(relative)) return "command paths must stay inside the workspace"
  }
  return undefined
}

function truncateComputerUseShellOutput(value: unknown) {
  const text = typeof value === "string" ? value : value == null ? "" : String(value)
  return text.length > COMPUTER_USE_SHELL_MAX_OUTPUT ? `${text.slice(0, COMPUTER_USE_SHELL_MAX_OUTPUT)}\n...[truncated]` : text
}

const isPrivateAddress = (address: string) => {
  const normalized = address.toLowerCase()
  if (normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:")) return true
  const mapped = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mapped) {
    const high = Number.parseInt(mapped[1], 16)
    const low = Number.parseInt(mapped[2], 16)
    return isPrivateAddress([high >> 8, high & 255, low >> 8, low & 255].join("."))
  }
  if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice(7))
  const parts = normalized.split(".").map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168) || parts[0] >= 224
}
export async function assertPublicBrowserUrl(raw: string) {
  const url = new URL(raw)
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("URL must use http or https")
  if (url.username || url.password) throw new Error("URL must not include credentials")
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (!host || host === "localhost" || host.endsWith(".localhost") || isIP(host) && isPrivateAddress(host)) throw new Error("private or local addresses are blocked")
  const addresses = await lookup(host, { all: true, verbatim: true })
  if (addresses.some((item) => isPrivateAddress(item.address))) throw new Error("private or local addresses are blocked")
  return url
}

const isDocumentLocalBrowserUrl = (url: URL) =>
  url.protocol === "data:" ||
  url.protocol === "blob:" ||
  url.href === "about:blank" ||
  url.href === "about:srcdoc"

/**
 * Browser navigation may start from an in-memory document fixture, but every
 * network URL still goes through the public-address/credential checks above.
 * Keep this separate from assertPublicBrowserUrl because MCP endpoints must
 * never accept document-local schemes.
 */
export async function assertBrowserNavigationUrl(raw: string) {
  const url = new URL(raw)
  if (isDocumentLocalBrowserUrl(url)) return url
  return assertPublicBrowserUrl(raw)
}

/** Validate a user-supplied remote MCP endpoint before OpenCode persists it. */
export async function validateDeveAgentMcpRemoteUrl(raw: string) {
  const url = await assertPublicBrowserUrl(raw)
  if (url.protocol !== "https:") throw new Error("Remote MCP endpoints must use HTTPS")
  return url.toString()
}

export type DeveAgentMcpMarketRemote = {
  type: "streamable-http" | "sse"
  url: string
  requiresSecret: boolean
  headerNames: string[]
}

export type DeveAgentMcpMarketEntry = {
  name: string
  description?: string
  version?: string
  repositoryUrl?: string
  remotes: DeveAgentMcpMarketRemote[]
  packageTypes: string[]
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** Normalize untrusted registry metadata; only HTTPS remote endpoints are connectable. */
export function normalizeDeveAgentMcpRegistryResponse(payload: unknown): { servers: DeveAgentMcpMarketEntry[]; nextCursor?: string } {
  const root = asRecord(payload)
  const rawServers = Array.isArray(root?.servers) ? root.servers : []
  const servers = rawServers.flatMap((raw): DeveAgentMcpMarketEntry[] => {
    const wrapper = asRecord(raw)
    const server = asRecord(wrapper?.server) ?? wrapper
    const name = typeof server?.name === "string" ? server.name.trim().slice(0, 160) : ""
    if (!name) return []
    const remotes = (Array.isArray(server?.remotes) ? server.remotes : []).flatMap((remote): DeveAgentMcpMarketRemote[] => {
      const value = asRecord(remote)
      const type = value?.type
      const rawUrl = value?.url
      if ((type !== "streamable-http" && type !== "sse") || typeof rawUrl !== "string") return []
      try {
        const url = new URL(rawUrl)
        if (url.protocol !== "https:" || url.username || url.password) return []
        const headers = (value && Array.isArray(value.headers) ? value.headers : [])
          .map(asRecord)
          .flatMap((header) => (typeof header?.name === "string" ? [{ name: header.name.slice(0, 80), secret: header.isSecret === true }] : []))
        return [{ type, url: url.toString(), requiresSecret: headers.some((header) => header.secret), headerNames: headers.map((header) => header.name) }]
      } catch {
        return []
      }
    })
    const packageTypes = (Array.isArray(server?.packages) ? server.packages : [])
      .map(asRecord)
      .flatMap((item) => (typeof item?.registryType === "string" ? [item.registryType.slice(0, 40)] : []))
    const repository = asRecord(server?.repository)
    return [{
      name,
      description: typeof server?.description === "string" ? server.description.slice(0, 600) : undefined,
      version: typeof server?.version === "string" ? server.version.slice(0, 80) : undefined,
      repositoryUrl: typeof repository?.url === "string" && repository.url.startsWith("https://") ? repository.url : undefined,
      remotes,
      packageTypes: [...new Set(packageTypes)],
    }]
  })
  const metadata = asRecord(root?.metadata)
  return { servers, ...(typeof metadata?.nextCursor === "string" ? { nextCursor: metadata.nextCursor.slice(0, 300) } : {}) }
}

export async function searchDeveAgentMcpRegistry(input: { query?: string; cursor?: string } = {}) {
  const params = new URLSearchParams({ limit: "20" })
  const query = input.query?.trim().slice(0, 120)
  const cursor = input.cursor?.trim().slice(0, 300)
  if (query) params.set("search", query)
  if (cursor) params.set("cursor", cursor)
  const response = await fetch(`https://registry.modelcontextprotocol.io/v0.1/servers?${params}`, {
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
    headers: { accept: "application/json" },
  })
  if (!response.ok) throw new Error(`MCP Registry HTTP ${response.status}`)
  return normalizeDeveAgentMcpRegistryResponse(await response.json())
}

type DeveAgentSkillMarketSource = {
  id: string
  label: string
  repository: string
  risk: "trusted" | "review" | "untrusted"
  kind?: "github" | "skillhub" | "clawhub"
}

export type DeveAgentSkillMarketEntry = {
  id: string
  name: string
  description: string
  source: string
  risk: "trusted" | "review" | "untrusted"
  url: string
}

const DEVEAGENT_SKILL_MARKET_SOURCES: DeveAgentSkillMarketSource[] = [
  { id: "anthropic", label: "Anthropic Official Skills", repository: "anthropics/skills", risk: "trusted" },
  { id: "mimo", label: "MiMo Skills", repository: "XiaomiMiMo/MiMo-Skills", risk: "trusted" },
  { id: "superpowers", label: "Superpowers", repository: "obra/superpowers", risk: "review" },
  { id: "opencode-skillful", label: "OpenCode Skillful", repository: "zenobi-us/opencode-skillful", risk: "review" },
  { id: "awesome-agent-skills", label: "Awesome Agent Skills", repository: "VoltAgent/awesome-agent-skills", risk: "review" },
  { id: "skillhub", label: "Tencent SkillHub", repository: "skillhub.cn", risk: "review", kind: "skillhub" },
  { id: "clawhub", label: "ClawHub / OpenClaw", repository: "clawhub.ai", risk: "untrusted", kind: "clawhub" },
]

export type DeveAgentSkillMarketPreferences = {
  version: 1
  enabledRepositories: string[]
}

const DEVEAGENT_SKILL_MARKET_PREFERENCES_PATH = ".deveagent/skill-market.json"

const defaultSkillMarketPreferences = (): DeveAgentSkillMarketPreferences => ({
  version: 1,
  enabledRepositories: DEVEAGENT_SKILL_MARKET_SOURCES.map((source) => source.repository),
})

export async function readDeveAgentSkillMarketPreferences(directory?: string): Promise<DeveAgentSkillMarketPreferences> {
  const fallback = defaultSkillMarketPreferences()
  if (!directory?.trim()) return fallback
  const safe = safeFilePath(directory, DEVEAGENT_SKILL_MARKET_PREFERENCES_PATH)
  if (!safe) return fallback
  try {
    const parsed = JSON.parse(await readFile(safe.absolute, "utf8")) as { enabledRepositories?: unknown }
    const enabledRepositories = Array.isArray(parsed.enabledRepositories)
      ? parsed.enabledRepositories.filter((value): value is string => typeof value === "string" && DEVEAGENT_SKILL_MARKET_SOURCES.some((source) => source.repository === value))
      : []
    return { version: 1, enabledRepositories: enabledRepositories.length > 0 ? [...new Set(enabledRepositories)] : fallback.enabledRepositories }
  } catch {
    return fallback
  }
}

export async function writeDeveAgentSkillMarketPreferences(input: { directory?: string; enabledRepositories?: unknown }): Promise<DeveAgentSkillMarketPreferences> {
  if (!input.directory?.trim()) throw new Error("Workspace directory is required")
  const safe = safeFilePath(input.directory, DEVEAGENT_SKILL_MARKET_PREFERENCES_PATH)
  if (!safe) throw new Error("Market preference path must stay inside the workspace")
  const enabledRepositories = Array.isArray(input.enabledRepositories)
    ? input.enabledRepositories.filter((value): value is string => typeof value === "string" && DEVEAGENT_SKILL_MARKET_SOURCES.some((source) => source.repository === value))
    : []
  const preferences = { version: 1 as const, enabledRepositories: [...new Set(enabledRepositories)] }
  await mkdir(path.dirname(safe.absolute), { recursive: true })
  const temporary = `${safe.absolute}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(preferences, null, 2), "utf8")
  await rename(temporary, safe.absolute)
  return preferences
}

export type DeveAgentMcpMarketPreferences = {
  version: 1
  source: "official" | "tencent" | "aliyun"
  category: "all" | "remote" | "credentials" | "local"
}

const DEVEAGENT_MCP_MARKET_PREFERENCES_PATH = ".deveagent/mcp-market.json"

const defaultMcpMarketPreferences = (): DeveAgentMcpMarketPreferences => ({ version: 1, source: "official", category: "all" })

export async function readDeveAgentMcpMarketPreferences(directory?: string): Promise<DeveAgentMcpMarketPreferences> {
  const fallback = defaultMcpMarketPreferences()
  if (!directory?.trim()) return fallback
  const safe = safeFilePath(directory, DEVEAGENT_MCP_MARKET_PREFERENCES_PATH)
  if (!safe) return fallback
  try {
    const parsed = JSON.parse(await readFile(safe.absolute, "utf8")) as { source?: unknown; category?: unknown }
    const source = parsed.source === "tencent" || parsed.source === "aliyun" || parsed.source === "official" ? parsed.source : fallback.source
    const category = parsed.category === "remote" || parsed.category === "credentials" || parsed.category === "local" || parsed.category === "all"
      ? parsed.category
      : fallback.category
    return { version: 1, source, category }
  } catch {
    return fallback
  }
}

export async function writeDeveAgentMcpMarketPreferences(input: { directory?: string; source?: unknown; category?: unknown }): Promise<DeveAgentMcpMarketPreferences> {
  if (!input.directory?.trim()) throw new Error("Workspace directory is required")
  const safe = safeFilePath(input.directory, DEVEAGENT_MCP_MARKET_PREFERENCES_PATH)
  if (!safe) throw new Error("MCP market preference path must stay inside the workspace")
  const fallback = defaultMcpMarketPreferences()
  const preferences: DeveAgentMcpMarketPreferences = {
    version: 1,
    source: input.source === "tencent" || input.source === "aliyun" || input.source === "official" ? input.source : fallback.source,
    category: input.category === "remote" || input.category === "credentials" || input.category === "local" || input.category === "all" ? input.category : fallback.category,
  }
  await mkdir(path.dirname(safe.absolute), { recursive: true })
  const temporary = `${safe.absolute}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(preferences, null, 2), "utf8")
  await rename(temporary, safe.absolute)
  return preferences
}

export type DeveAgentSkillMarketSourceStatus = {
  source: string
  status: "ready" | "unavailable"
  error?: string
}

export type DeveAgentSkillMarketResult = {
  entries: DeveAgentSkillMarketEntry[]
  sources: DeveAgentSkillMarketSourceStatus[]
}

const skillMarketCache = new Map<string, { expiresAt: number; result: DeveAgentSkillMarketResult }>()

/** Turns allowlisted GitHub tree metadata into concrete, installable SKILL.md links. */
export function normalizeDeveAgentSkillMarketTree(source: DeveAgentSkillMarketSource, payload: unknown, query = ""): DeveAgentSkillMarketEntry[] {
  const root = asRecord(payload)
  const tree = Array.isArray(root?.tree) ? root.tree : []
  const needle = query.trim().toLowerCase()
  return tree.flatMap((item): DeveAgentSkillMarketEntry[] => {
    const node = asRecord(item)
    const filePath = typeof node?.path === "string" ? node.path.replaceAll("\\\\", "/") : ""
    if (node?.type !== "blob" || !/(?:^|\/)skill\.md$/i.test(filePath)) return []
    const haystack = `${source.label} ${filePath}`.toLowerCase()
    if (needle && !haystack.includes(needle)) return []
    const parent = filePath.split("/").at(-2) || "Skill"
    const id = safeRemoteSkillID(`${source.id}-${filePath.replace(/\.md$/i, "").replaceAll("/", "-")}`, parent)
    if (!id) return []
    return [{
      id,
      name: parent,
      description: `${source.label} · ${filePath}`,
      source: `${source.label} (${source.repository})`,
      risk: source.risk,
      url: `https://raw.githubusercontent.com/${source.repository}/HEAD/${filePath}`,
    }]
  }).slice(0, 60)
}

/** Normalizes SkillHub's public catalog without trusting unverified community content. */
export function normalizeDeveAgentSkillHubMarket(source: DeveAgentSkillMarketSource, payload: unknown, query = ""): DeveAgentSkillMarketEntry[] {
  const root = asRecord(payload)
  const data = asRecord(root?.data)
  const skills = Array.isArray(data?.skills) ? data.skills : []
  const needle = query.trim().toLowerCase()
  return skills.flatMap((item): DeveAgentSkillMarketEntry[] => {
    const skill = asRecord(item)
    const slug = typeof skill?.slug === "string" ? skill.slug.trim() : ""
    const name = typeof skill?.name === "string" ? skill.name.trim() : ""
    const description = typeof skill?.description_zh === "string" && skill.description_zh.trim()
      ? skill.description_zh.trim()
      : typeof skill?.description === "string" ? skill.description.trim() : ""
    if (!slug || !name) return []
    const haystack = `${name} ${description} ${slug} ${skill?.category || ""}`.toLowerCase()
    if (needle && !haystack.includes(needle)) return []
    const id = safeRemoteSkillID(`skillhub-${slug}`, name)
    if (!id) return []
    return [{
      id,
      name,
      description: description.slice(0, 500),
      source: `${source.label} (${source.repository})`,
      risk: skill?.verified === true ? "trusted" : "review",
      url: `https://api.skillhub.cn/api/v1/skills/${encodeURIComponent(slug)}/file?path=SKILL.md`,
    }]
  }).slice(0, 60)
}

/** Normalizes ClawHub search metadata; public community skills are never trusted by default. */
export function normalizeDeveAgentClawHubMarket(source: DeveAgentSkillMarketSource, payload: unknown): DeveAgentSkillMarketEntry[] {
  const root = asRecord(payload)
  const results = Array.isArray(root?.results) ? root.results : []
  return results.flatMap((item): DeveAgentSkillMarketEntry[] => {
    const skill = asRecord(item)
    const slug = typeof skill?.slug === "string" ? skill.slug.trim() : ""
    const name = typeof skill?.displayName === "string" ? skill.displayName.trim() : ""
    if (!slug || !name) return []
    const summary = typeof skill?.summary === "string" ? skill.summary.trim() : ""
    return [{
      id: safeRemoteSkillID(`clawhub-${slug}`, name) || `clawhub-${slug.replace(/[^a-zA-Z0-9._-]/g, "-")}`,
      name,
      description: summary.slice(0, 500),
      source: `${source.label} (${source.repository})`,
      risk: "untrusted",
      url: `https://clawhub.ai/api/v1/skills/${encodeURIComponent(slug)}/file?path=SKILL.md`,
    }]
  }).slice(0, 60)
}

export async function getDeveAgentSkillMarket(query = "", enabledRepositories?: string[]): Promise<DeveAgentSkillMarketResult> {
  const cacheKey = query.trim().toLowerCase().slice(0, 120)
  const enabled = enabledRepositories === undefined
    ? undefined
    : new Set(enabledRepositories.map((value) => value.trim()).filter(Boolean))
  const selectedSources = enabled ? DEVEAGENT_SKILL_MARKET_SOURCES.filter((source) => enabled.has(source.repository)) : DEVEAGENT_SKILL_MARKET_SOURCES
  const sourceKey = selectedSources.map((source) => source.repository).sort().join(",")
  const scopedCacheKey = `${cacheKey}|${sourceKey}`
  const cached = skillMarketCache.get(scopedCacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.result

  const results = await Promise.all(
    selectedSources.map(async (source) => {
      const sourceName = `${source.label} (${source.repository})`
      try {
        const url = source.kind === "skillhub"
          ? `https://api.skillhub.cn/api/skills?keyword=${encodeURIComponent(cacheKey)}&sortBy=score&pageSize=20`
          : source.kind === "clawhub"
            ? `https://clawhub.ai/api/v1/search?q=${encodeURIComponent(cacheKey)}&limit=20`
          : `https://api.github.com/repos/${source.repository}/git/trees/HEAD?recursive=1`
        const response = await fetch(url, {
          signal: AbortSignal.timeout(12_000),
          redirect: "error",
          headers: source.kind === "skillhub" || source.kind === "clawhub"
            ? { accept: "application/json", "user-agent": "DeveAgent-Studio" }
            : { accept: "application/vnd.github+json", "user-agent": "DeveAgent-Studio" },
        })
        if (!response.ok) return { entries: [], source: { source: sourceName, status: "unavailable" as const, error: `HTTP ${response.status}` } }
        return {
          entries: source.kind === "skillhub"
            ? normalizeDeveAgentSkillHubMarket(source, await response.json(), cacheKey)
            : source.kind === "clawhub"
              ? normalizeDeveAgentClawHubMarket(source, await response.json())
            : normalizeDeveAgentSkillMarketTree(source, await response.json(), cacheKey),
          source: { source: sourceName, status: "ready" as const },
        }
      } catch (error) {
        return {
          entries: [],
          source: { source: sourceName, status: "unavailable" as const, error: error instanceof Error ? error.message.slice(0, 120) : "request failed" },
        }
      }
    }),
  )
  const result = {
    entries: results.flatMap((item) => item.entries).sort((left, right) => left.name.localeCompare(right.name)).slice(0, 60),
    sources: results.map((item) => item.source),
  }
  skillMarketCache.set(scopedCacheKey, { result, expiresAt: Date.now() + 5 * 60_000 })
  return result
}

export async function searchDeveAgentSkillMarket(query = ""): Promise<DeveAgentSkillMarketEntry[]> {
  return (await getDeveAgentSkillMarket(query)).entries
}

type DeveAgentMode = "compose" | "craft" | "ask" | "plan" | "build" | "goal" | "loop"
type DeveAgentPermissionMode = "default" | "auto" | "yolo"
type DeveAgentToolExecution = "sequential" | "parallel"
type DeveAgentAuxiliaryModel = {
  providerID: string
  modelID: string
  maxTokens?: number
  reasoningEffort?: string
}
type DeveAgentRisk = "trusted" | "review" | "untrusted"
type DeveAgentSkillRef = {
  id: string
  name: string
  source: string
  installed: boolean
  enabled: boolean
  risk: DeveAgentRisk
  desc?: string
}
type DeveAgentExpertRef = {
  id: string
  name: string
  role?: string
}
type DeveAgentRuntimeState = {
  mode: DeveAgentMode
  permissionMode: DeveAgentPermissionMode
  toolExecution: DeveAgentToolExecution
  auxiliary: {
    vision?: DeveAgentAuxiliaryModel
    visionChain?: DeveAgentAuxiliaryModel[]
    fallbackChain?: DeveAgentAuxiliaryModel[]
    speech?: DeveAgentAuxiliaryModel
    embeddings?: DeveAgentAuxiliaryModel
    compression?: DeveAgentAuxiliaryModel
  }
  // ponytail: role id (planner|coder|reviewer|verifier|vision) -> auxiliary model for prompt routing
  roleProfiles: Record<string, DeveAgentAuxiliaryModel>
  // Current composer role (from a Work Pack or an explicit selection). Kept out
  // of the runtime system prompt (byte-stable prefix); only rides the message.
  role?: string
  tokenSaver: boolean
  remoteSkills: boolean
  remoteMcp: boolean
  markitdownMode: "auto" | "manual" | "off"
  unattendedTimezone: string
  selectedSkills: DeveAgentSkillRef[]
  selectedExpert?: DeveAgentExpertRef
  expertTeam: DeveAgentExpertRef[]
}
type DeveAgentContextPackFileInput =
  | string
  | {
      path?: string
      source?: string
    }
type DeveAgentContextPackInput = {
  directory?: string
  task?: string
  files?: DeveAgentContextPackFileInput[]
  maxFiles?: number
  maxBytesPerFile?: number
}
type DeveAgentContextPackFile = {
  path: string
  source: string
  bytes: number
  estimatedTokens: number
  readable: boolean
  reason?: string
  compressed?: boolean
  originalBytes?: number
  originalTokens?: number
  compressionEngine?: string
}
type DeveAgentContextPack = {
  available: boolean
  engine: string
  generatedAt: string
  directory?: string
  task?: string
  files: DeveAgentContextPackFile[]
  totalEstimatedTokens: number
  totalOriginalTokens?: number
  tokensSaved?: number
  tokenSaverEnabled: boolean
  warnings: string[]
}

const contextPackBySession = new Map<string, DeveAgentContextPack>()

type DeveAgentGrillingDecision = {
  question: string
  answer: string
  recommendation?: string
  recordedAt: string
}

const grillingDecisionsBySession = new Map<string, DeveAgentGrillingDecision[]>()
type DeveAgentGrillingTiming = { startedAt: string; completedAt?: string; decisionCount: number }
const grillingTimingBySession = new Map<string, DeveAgentGrillingTiming>()

function grillingTimingStorePath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(base, "opencode", "deveagent-grilling-timing.json")
}

export function normalizeGrillingTimingEntries(value: unknown): Array<[string, DeveAgentGrillingTiming]> {
  if (!Array.isArray(value)) return []
  return value.slice(-200).flatMap((entry): Array<[string, DeveAgentGrillingTiming]> => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || entry[0].length === 0 || entry[0].length > 160) return []
    const timing = entry[1]
    if (!timing || typeof timing !== "object" || typeof (timing as any).startedAt !== "string" || !Number.isFinite(Date.parse((timing as any).startedAt))) return []
    const completedAt = typeof (timing as any).completedAt === "string" && Number.isFinite(Date.parse((timing as any).completedAt)) ? (timing as any).completedAt : undefined
    const decisionCount = typeof (timing as any).decisionCount === "number" && Number.isFinite((timing as any).decisionCount) ? Math.max(0, Math.min(30, Math.floor((timing as any).decisionCount))) : 0
    return [[entry[0], { startedAt: (timing as any).startedAt, decisionCount, ...(completedAt ? { completedAt } : {}) }]]
  })
}

async function loadGrillingTimingFromDisk() {
  try {
    const data = JSON.parse(await readFile(grillingTimingStorePath(), "utf8"))
    for (const [sessionID, timing] of normalizeGrillingTimingEntries(data?.timings)) {
      // A live interview always wins over a delayed startup read.
      if (!grillingTimingBySession.has(sessionID)) grillingTimingBySession.set(sessionID, timing)
    }
  } catch {
    // ponytail: missing timing metadata is a cold start, not a reason to block interviews.
  }
}

// Grilling timing persistence: serialized chain + unique temp name. Parallel
// sessions record decisions concurrently, so a pid-only temp name + unsynchronized
// writes could race (same-path temp collision); the atomic rename keeps the
// final file valid, but the chain guarantees the newest snapshot wins.
let grillingTimingWrite = Promise.resolve()
async function saveGrillingTimingToDisk() {
  const file = grillingTimingStorePath()
  grillingTimingWrite = grillingTimingWrite
    .catch(() => undefined)
    .then(() => atomicWriteFile(file, JSON.stringify({ version: 1, timings: [...grillingTimingBySession.entries()].slice(-200) })))
  await grillingTimingWrite
}

type DeveAgentGrillingStatus = {
  started: boolean
  completed: boolean
  startedAt?: string
  completedAt?: string
  elapsedMs: number
  decisionCount: number
}

function grillingTiming(sessionID: string | undefined): DeveAgentGrillingTiming | undefined {
  if (!sessionID) return
  const existing = grillingTimingBySession.get(sessionID)
  if (existing) return existing
  const created: DeveAgentGrillingTiming = { startedAt: new Date().toISOString(), decisionCount: 0 }
  grillingTimingBySession.set(sessionID, created)
  void saveGrillingTimingToDisk().catch(() => undefined)
  return created
}

export function startGrilling(input: { sessionID?: string }): DeveAgentGrillingStatus {
  grillingTiming(input.sessionID)
  return getGrillingStatus(input.sessionID)
}

export function recordGrillingDecision(input: { sessionID?: string; question: string; answer: string; recommendation?: string }) {
  const sessionID = input.sessionID?.trim()
  const question = input.question.trim().slice(0, 1_000)
  const answer = input.answer.trim().slice(0, 2_000).replace(/[\uD800-\uDBFF]$/, "")
  if (!sessionID || !question || !answer) return { recorded: false, error: "sessionID, question, and answer are required" }
  grillingTiming(sessionID)
  const decisions = grillingDecisionsBySession.get(sessionID) ?? []
  decisions.push({ question, answer, recommendation: input.recommendation?.trim().slice(0, 1_000) || undefined, recordedAt: new Date().toISOString() })
  if (decisions.length > 30) decisions.splice(0, decisions.length - 30)
  grillingDecisionsBySession.set(sessionID, decisions)
  const timing = grillingTimingBySession.get(sessionID)
  if (timing) timing.decisionCount = decisions.length
  void saveGrillingTimingToDisk().catch(() => undefined)
  if (grillingDecisionsBySession.size > 200) grillingDecisionsBySession.delete(grillingDecisionsBySession.keys().next().value!)
  return { recorded: true, count: decisions.length }
}

export function getGrillingDecisions(sessionID: string | undefined) {
  return sessionID ? [...(grillingDecisionsBySession.get(sessionID) ?? [])] : []
}

export function getGrillingStatus(sessionID: string | undefined): DeveAgentGrillingStatus {
  const timing = sessionID ? grillingTimingBySession.get(sessionID) : undefined
  const decisions = getGrillingDecisions(sessionID)
  if (!timing) return { started: false, completed: false, elapsedMs: 0, decisionCount: decisions.length }
  const end = timing.completedAt ? Date.parse(timing.completedAt) : Date.now()
  return {
    started: true,
    completed: !!timing.completedAt,
    startedAt: timing.startedAt,
    completedAt: timing.completedAt,
    elapsedMs: Math.max(0, end - Date.parse(timing.startedAt)),
    decisionCount: Math.max(decisions.length, timing.decisionCount),
  }
}

export function completeGrilling(input: { sessionID?: string }): DeveAgentGrillingStatus & { error?: string } {
  const sessionID = input.sessionID?.trim()
  const timing = sessionID ? grillingTimingBySession.get(sessionID) : undefined
  if (!sessionID) return { ...getGrillingStatus(undefined), error: "sessionID is required" }
  if (!timing) return { ...getGrillingStatus(sessionID), error: "Grilling Me has not started for this session" }
  timing.completedAt ??= new Date().toISOString()
  void saveGrillingTimingToDisk().catch(() => undefined)
  return getGrillingStatus(sessionID)
}

export function clearGrillingDecisions(sessionID: string | undefined) {
  if (sessionID) {
    grillingDecisionsBySession.delete(sessionID)
    grillingTimingBySession.delete(sessionID)
    void saveGrillingTimingToDisk().catch(() => undefined)
  }
}

export async function exportGrillingDecisions(input: { directory?: string; sessionID?: string; filePath?: string }) {
  const directory = input.directory?.trim()
  const decisions = getGrillingDecisions(input.sessionID)
  if (!directory) return { exported: false, error: "No workspace directory is available." }
  if (decisions.length === 0) return { exported: false, error: "No explicitly confirmed Grilling decisions exist for this session." }
  const safeSessionID = (input.sessionID || "session").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "session"
  const safe = safeFilePath(directory, input.filePath || `.deveagent/grilling/${safeSessionID}.md`)
  if (!safe) return { exported: false, error: "Export path must stay inside the workspace." }
  const status = getGrillingStatus(input.sessionID)
  const body = [
    "# Confirmed Grilling Decisions",
    "",
    "> Generated only after an explicit export request. Entries were confirmed in this session.",
    "",
    `- Started: ${status.startedAt ?? "not recorded"}`,
    `- Completed: ${status.completedAt ?? "not recorded"}`,
    `- Duration: ${Math.round(status.elapsedMs / 1000)} seconds`,
    "",
    ...decisions.flatMap((item, index) => [
      `## ${index + 1}. ${item.question}`,
      "",
      `- Confirmed answer: ${item.answer}`,
      ...(item.recommendation ? [`- Recommendation considered: ${item.recommendation}`] : []),
      `- Confirmed at: ${item.recordedAt}`,
      "",
    ]),
  ].join("\n")
  await atomicWriteFile(safe.absolute, body)
  return { exported: true, path: safe.relative.replaceAll("\\", "/"), decisionCount: decisions.length }
}

/**
 * Create an explicit, workspace-bounded Markdown copy for an Obsidian vault.
 * The caller can add this directory (or the workspace) to Obsidian; this never
 * scans or writes an arbitrary external vault.
 */
export async function exportWorkspaceMarkdownForObsidian(input: { directory?: string; sourcePath?: string }) {
  const directory = input.directory?.trim()
  const sourcePath = input.sourcePath?.trim()
  if (!directory) return { exported: false, error: "No workspace directory is available." }
  if (!sourcePath || path.extname(sourcePath).toLowerCase() !== ".md") {
    return { exported: false, error: "Only a workspace-relative Markdown file can be exported." }
  }

  const source = safeFilePath(directory, sourcePath)
  if (!source) return { exported: false, error: "Source path must stay inside the workspace." }

  const targetName = source.relative
    .replace(/[\\/]+/g, "--")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 180) || "note.md"
  const target = safeFilePath(directory, path.join(".deveagent", "obsidian", targetName))
  if (!target) return { exported: false, error: "Export path must stay inside the workspace." }

  try {
    const content = await readFile(source.absolute, "utf8")
    await mkdir(path.dirname(target.absolute), { recursive: true })
    await writeFile(target.absolute, content, "utf8")
    return { exported: true, path: target.relative.replaceAll("\\", "/"), source: source.relative.replaceAll("\\", "/") }
  } catch (error) {
    return { exported: false, error: error instanceof Error ? error.message : "Unable to export Markdown." }
  }
}

function projectGrillingDecisions(sessionID: string | undefined) {
  const decisions = getGrillingDecisions(sessionID)
  if (decisions.length === 0) return ""
  return [
    "## Confirmed Grilling Decisions",
    "- These decisions were explicitly confirmed by the user in this session. Do not reopen them unless the user changes them.",
    ...decisions.map((item, index) => `- ${index + 1}. ${item.question}\n  - Confirmed: ${item.answer}${item.recommendation ? `\n  - Recommendation considered: ${item.recommendation}` : ""}`),
  ].join("\n")
}

export function setDeveAgentSessionContextPack(sessionID: string | undefined, pack: DeveAgentContextPack | undefined) {
  if (!sessionID || sessionID.length > 160) return
  if (!pack?.available) {
    contextPackBySession.delete(sessionID)
    return
  }
  contextPackBySession.set(sessionID, pack)
  const oldest = contextPackBySession.keys().next().value
  if (contextPackBySession.size > 200 && oldest) contextPackBySession.delete(oldest)
}

export function projectDeveAgentSessionContextPack(sessionID: string | undefined) {
  if (!sessionID) return ""
  const pack = contextPackBySession.get(sessionID)
  if (!pack?.available) return ""
  const readable = pack.files.filter((file) => file.readable).slice(0, 12)
  if (readable.length === 0) return ""
  const lines = [
    "## Active CodeGraph Context Pack",
    `- ${readable.length} relevant file(s), estimated ${pack.totalEstimatedTokens} tokens${pack.tokensSaved ? `, token saver removed ~${pack.tokensSaved}` : ""}.`,
    "- Use these paths for focused Read/tool calls; this projection contains metadata, not a replacement for source reads.",
    ...readable.map((file) => `- ${file.path} (${file.source}, ~${file.estimatedTokens} tokens${file.compressed ? ", compressed" : ""})`),
  ]
  return lines.join("\n")
}

const DEFAULT_RUNTIME_STATE: DeveAgentRuntimeState = {
  mode: "craft",
  // Unattended product default. permission.ask below still denies dangerous
  // targets and read-only modes before this branch is reached.
  permissionMode: "yolo",
  toolExecution: "sequential",
  auxiliary: {},
  roleProfiles: {},
  tokenSaver: true,
  remoteSkills: true,
  remoteMcp: true,
  markitdownMode: "auto",
  unattendedTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  selectedSkills: ([
    {
      id: "markitdown",
      name: "MarkItDown",
      source: "builtin:microsoft/markitdown",
      installed: true,
      enabled: true,
      risk: "trusted",
      desc: "Convert supported document attachments to cached Markdown before reading.",
    },
    {
      id: "headroom",
      name: "Headroom",
      source: "builtin:opencode/headroom",
      installed: true,
      enabled: false,
      risk: "trusted",
      desc: "Reserve context budget before long edits and prevent window overflow.",
    },
    {
      id: "context-mode",
      name: "Context Mode",
      source: "builtin:opencode/context-mode",
      installed: true,
      enabled: false,
      risk: "trusted",
      desc: "Choose compact, balanced, or expanded context packs per task.",
    },
    {
      id: "tool-result-optimizer",
      name: "Tool Result Optimizer",
      source: "builtin:rtk/tool-result-optimizer",
      installed: true,
      enabled: false,
      risk: "trusted",
      desc: "Summarize noisy tool output and keep only actionable ranges.",
    },
    {
      id: "rtk-caveman",
      name: "RTK Caveman",
      source: "builtin:rtk/caveman",
      installed: true,
      enabled: false,
      risk: "trusted",
      desc: "Prefer simple, robust implementation steps before complex abstractions.",
    },
    {
      id: "token-saver",
      name: "Token Saver",
      source: "builtin:reasonix/token-saver",
      installed: true,
      enabled: true,
      risk: "trusted",
      desc: "Stable prefix, cache-friendly prompt layout, and scoped context injection.",
    },
  ] as DeveAgentSkillRef[]).filter((skill) => skill.enabled),
  expertTeam: [],
}

let runtimeState: DeveAgentRuntimeState = { ...DEFAULT_RUNTIME_STATE }

// The plugin's SDK client, captured at init so HTTP routes (same module
// instance) can validate role-profile models against the live provider list.
let pluginSdkClient: unknown
// Config-time provider snapshot, refreshed by the plugin config hook; a
// best-effort fallback for role-model validation when the SDK provider list
// is unavailable (packaged runtimes).
let providerRegistrySnapshot: Record<string, { models?: Record<string, unknown> }> = {}
// ponytail: per-session auxiliary override; falls back to global runtimeState
const sessionAuxiliary = new Map<string, DeveAgentRuntimeState["auxiliary"]>()

export function syncDeveAgentRuntimeGlobals() {
  ;(globalThis as any).__deveagent_remote_mcp = runtimeState.remoteMcp !== false
  ;(globalThis as any).__deveagent_markitdown_mode = runtimeState.selectedSkills.some(
    (skill) => skill.id === "markitdown" && skill.enabled,
  )
    ? (runtimeState.markitdownMode ?? "auto")
    : "off"
  if (runtimeState.auxiliary.vision) {
    ;(globalThis as any).__deveagent_auxiliary_vision = runtimeState.auxiliary.vision
  } else {
    delete (globalThis as any).__deveagent_auxiliary_vision
  }
  if (runtimeState.auxiliary.visionChain?.length) {
    ;(globalThis as any).__deveagent_vision_chain = runtimeState.auxiliary.visionChain
  } else {
    delete (globalThis as any).__deveagent_vision_chain
  }
}

// Initialize process-local hooks even when no persisted auxiliary state exists.
syncDeveAgentRuntimeGlobals()

export function setSessionAuxiliary(sessionID: string, input: unknown) {
  const prev = sessionAuxiliary.get(sessionID) ?? runtimeState.auxiliary
  const next = normalizeAuxiliary(input, prev)
  sessionAuxiliary.set(sessionID, next)
  return next
}

export function getSessionAuxiliary(sessionID: string): DeveAgentRuntimeState["auxiliary"] | undefined {
  return sessionAuxiliary.get(sessionID)
}

export function clearSessionAuxiliary(sessionID: string): DeveAgentRuntimeState["auxiliary"] {
  sessionAuxiliary.delete(sessionID)
  return runtimeState.auxiliary
}

export function getEffectiveAuxiliary(sessionID: string): DeveAgentRuntimeState["auxiliary"] {
  return sessionAuxiliary.get(sessionID) ?? runtimeState.auxiliary
}

// ponytail: selection-time vision fallback taxonomy (not full API retry — SessionRetry already covers that)
export type VisionFallbackReason = "model_not_found" | "no_image_capability" | "not_configured"

export type VisionFallbackRecord = {
  reason: VisionFallbackReason
  providerID?: string
  modelID?: string
  sessionID?: string
  at: number
}

let lastVisionFallback: VisionFallbackRecord | undefined

export function getLastVisionFallback() {
  return lastVisionFallback
}

export function recordVisionFallback(input: Omit<VisionFallbackRecord, "at"> & { at?: number }) {
  lastVisionFallback = { ...input, at: input.at ?? Date.now() }
  return lastVisionFallback
}

export function classifyVisionFallback(input: {
  configured: boolean
  candidate?: { capabilities?: { input?: { image?: boolean } } } | null
}): VisionFallbackReason {
  if (!input.configured) return "not_configured"
  if (!input.candidate) return "model_not_found"
  if (!input.candidate.capabilities?.input?.image) return "no_image_capability"
  return "model_not_found"
}

export function visionFallbackMessage(reason: VisionFallbackReason, providerID?: string, modelID?: string) {
  const ref = providerID && modelID ? `${providerID}/${modelID}` : "unknown"
  if (reason === "model_not_found") return `辅助视觉模型不可用(找不到): ${ref}，已回退到主模型`
  if (reason === "no_image_capability") return `辅助视觉模型不支持图片输入: ${ref}，已回退到主模型`
  return `未配置辅助视觉模型，使用主模型处理图片`
}

// ponytail: global auxiliary only; session map stays in-memory
function auxiliaryStorePath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(base, "opencode", "deveagent-auxiliary.json")
}

export async function loadAuxiliaryFromDisk() {
  try {
    const text = await readFile(auxiliaryStorePath(), "utf8")
    const data = JSON.parse(text)
    if (!data || typeof data !== "object") return undefined
    return normalizeAuxiliary(data, {})
  } catch {
    return undefined
  }
}

export async function saveAuxiliaryToDisk(auxiliary: DeveAgentRuntimeState["auxiliary"]) {
  await atomicWriteFile(auxiliaryStorePath(), JSON.stringify(auxiliary, null, 2))
}

// ponytail: role->model routing persisted globally, separate file from auxiliary
function roleProfilesStorePath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(base, "opencode", "deveagent-role-profiles.json")
}

export async function loadRoleProfilesFromDisk() {
  try {
    const text = await readFile(roleProfilesStorePath(), "utf8")
    const data = JSON.parse(text)
    if (!data || typeof data !== "object") return undefined
    return normalizeRoleProfiles(data, {})
  } catch {
    return undefined
  }
}

export async function saveRoleProfilesToDisk(profiles: Record<string, DeveAgentAuxiliaryModel>) {
  await atomicWriteFile(roleProfilesStorePath(), JSON.stringify(profiles, null, 2))
}

const VOICE_MAX_BYTES = 16 * 1024 * 1024
const VOICE_MIME_EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
}

export function voiceTranscriptionUrl(baseURL: string) {
  const url = new URL(baseURL)
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Speech provider URL must use http or https")
  const base = url.pathname.replace(/\/+$/, "").replace(/\/(?:chat\/completions|responses)$/, "")
  url.pathname = `${base}/audio/transcriptions`.replace(/\/{2,}/g, "/")
  return url.toString()
}

export async function transcribeOpenAICompatibleAudio(input: {
  baseURL: string
  apiKey?: string
  modelID: string
  audioBase64: string
  mimeType?: string
  language?: string
  headers?: Record<string, string>
  timeoutMs?: number
  fetchImpl?: typeof fetch
}) {
  const mimeType = (input.mimeType ?? "audio/webm").split(";")[0]!.toLowerCase()
  const extension = VOICE_MIME_EXTENSIONS[mimeType]
  if (!extension) throw new Error(`Unsupported audio type: ${mimeType}`)
  const encoded = input.audioBase64.replace(/^data:[^;]+;base64,/, "").trim()
  if (!encoded || encoded.length > Math.ceil(VOICE_MAX_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error("Invalid or oversized audio payload")
  }
  const bytes = Buffer.from(encoded, "base64")
  if (!bytes.length || bytes.length > VOICE_MAX_BYTES) throw new Error("Invalid or oversized audio payload")

  const body = new FormData()
  body.append("model", input.modelID)
  body.append("response_format", "json")
  if (input.language?.trim()) body.append("language", input.language.trim().slice(0, 20))
  body.append("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), `voice.${extension}`)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.max(5_000, Math.min(input.timeoutMs ?? 120_000, 300_000)))
  try {
    const hasAuthorization = Object.keys(input.headers ?? {}).some((key) => key.toLowerCase() === "authorization")
    const response = await (input.fetchImpl ?? fetch)(voiceTranscriptionUrl(input.baseURL), {
      method: "POST",
      headers: {
        ...input.headers,
        ...(input.apiKey && !hasAuthorization ? { authorization: `Bearer ${input.apiKey}` } : {}),
      },
      body,
      signal: controller.signal,
    })
    const raw = await response.text()
    const payload = (() => {
      try {
        return JSON.parse(raw)
      } catch {
        return { error: raw }
      }
    })() as {
      text?: unknown
      data?: { text?: unknown }
      error?: unknown
    }
    if (!response.ok) throw new Error(`Speech provider HTTP ${response.status}: ${String(payload.error ?? "").slice(0, 300)}`)
    const text = typeof payload.text === "string" ? payload.text : typeof payload.data?.text === "string" ? payload.data.text : ""
    if (!text.trim()) throw new Error("Speech provider returned no transcript")
    return text.trim()
  } finally {
    clearTimeout(timeout)
  }
}

const MODE_LABEL: Record<DeveAgentMode, string> = {
  compose: "Compose",
  craft: "Craft",
  ask: "Ask",
  plan: "Plan",
  build: "Build",
  goal: "Goal",
  loop: "Loop",
}

const MODE_RULES: Record<DeveAgentMode, string[]> = {
  compose: [
    "Compose mode. Coordinate multi-file work with a task tree before implementation.",
    "Before writes, produce Implementation Guardrails and checkpoints for each task node.",
  ],
  craft: [
    "Use the normal OpenCode assistant behavior.",
    "If a task becomes implementation work, produce guardrails before editing.",
  ],
  ask: [
    "Read-only question answering. Do not write files or run mutating commands.",
    "Prefer concise diagnosis, references, and next-step suggestions.",
  ],
  plan: [
    "Read-only planning mode. Do not write files or run mutating commands.",
    "Return architecture, affected files, risks, task tree, and verification plan.",
  ],
  build: [
    "Implementation mode. Before writes, produce Implementation Guardrails with files, risks, rollback, and tests.",
    "Use OpenCode permission prompts as the final authority for writes and commands.",
  ],
  goal: [
    "Goal mode. Generate a plan and success criteria, then continue until complete, blocked, or budget is exhausted.",
    "Before writes, produce Implementation Guardrails and respect the permission policy.",
  ],
  loop: [
    "Loop mode. Repeat the submitted task through the persisted bounded loop queue.",
    "Use loop-set to change interval or run budget, loop-status to inspect it, and loop-pause/loop-cancel to stop unattended work.",
    "Before writes, produce Implementation Guardrails and respect the permission policy on every run.",
  ],
}

function asMode(value: unknown): DeveAgentMode {
  return value === "compose" || value === "ask" || value === "plan" || value === "build" || value === "goal" || value === "loop" || value === "craft" ? value : "craft"
}

function asPermissionMode(value: unknown): DeveAgentPermissionMode {
  return value === "auto" || value === "yolo" || value === "default" ? value : "default"
}

function asToolExecution(value: unknown): DeveAgentToolExecution {
  return value === "parallel" ? "parallel" : "sequential"
}

function sanitizeAuxiliaryModel(input: unknown): DeveAgentAuxiliaryModel | undefined {
  if (!input || typeof input !== "object") return
  const value = input as Record<string, unknown>
  if (typeof value.providerID !== "string" || typeof value.modelID !== "string") return
  return {
    providerID: value.providerID.slice(0, 80),
    modelID: value.modelID.slice(0, 160),
    maxTokens: typeof value.maxTokens === "number" ? Math.max(1, Math.min(Math.floor(value.maxTokens), 1_000_000)) : undefined,
    reasoningEffort: typeof value.reasoningEffort === "string" ? value.reasoningEffort.slice(0, 40) : undefined,
  }
}

function normalizeAuxiliary(input: unknown, previous: DeveAgentRuntimeState["auxiliary"]): DeveAgentRuntimeState["auxiliary"] {
  if (!input || typeof input !== "object") return previous
  const value = input as Record<string, unknown>
  const normalizeChain = (raw: unknown, fallback: DeveAgentAuxiliaryModel[] | undefined) => Array.isArray(raw)
    ? raw
        .map(sanitizeAuxiliaryModel)
        .filter((m): m is DeveAgentAuxiliaryModel => !!m)
        .filter((m, index, all) => all.findIndex((other) => other.providerID === m.providerID && other.modelID === m.modelID) === index)
        .slice(0, 4)
    : fallback
  const visionChain = normalizeChain(value.visionChain, previous.visionChain)
  const fallbackChain = Array.isArray(value.fallbackChain)
    ? value.fallbackChain
        .map(sanitizeAuxiliaryModel)
        .filter((m): m is DeveAgentAuxiliaryModel => !!m)
        .filter((m, index, all) => all.findIndex((other) => other.providerID === m.providerID && other.modelID === m.modelID) === index)
        .slice(0, 4)
    : previous.fallbackChain
  return {
    vision: sanitizeAuxiliaryModel(value.vision) ?? previous.vision,
    visionChain,
    fallbackChain,
    speech: value.speech === null ? undefined : sanitizeAuxiliaryModel(value.speech) ?? previous.speech,
    embeddings: sanitizeAuxiliaryModel(value.embeddings) ?? previous.embeddings,
    compression: sanitizeAuxiliaryModel(value.compression) ?? previous.compression,
  }
}

function asRisk(value: unknown): DeveAgentRisk {
  return value === "review" || value === "untrusted" || value === "trusted" ? value : "trusted"
}

function isRemoteSkillSource(source: string | undefined) {
  if (!source) return false
  return source.startsWith("github:") || source.startsWith("skillhub.") || source === "clawhub" || source.startsWith("http")
}

function asTimezone(value: unknown, fallback = "UTC") {
  if (typeof value !== "string") return fallback
  const timezone = value.trim()
  if (!timezone) return fallback
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date())
    return timezone
  } catch {
    return fallback
  }
}

function sanitizeSkill(input: any): DeveAgentSkillRef | undefined {
  if (!input || typeof input.id !== "string" || typeof input.name !== "string") return
  return {
    id: input.id.slice(0, 120),
    name: input.name.slice(0, 120),
    source: typeof input.source === "string" ? input.source.slice(0, 240) : "local",
    installed: input.installed !== false,
    enabled: input.enabled !== false,
    risk: asRisk(input.risk),
    desc: typeof input.desc === "string" ? input.desc.slice(0, 500) : undefined,
  }
}

function sanitizeExpert(input: any): DeveAgentExpertRef | undefined {
  if (!input || typeof input.id !== "string" || typeof input.name !== "string") return
  return {
    id: input.id.slice(0, 80),
    name: input.name.slice(0, 120),
    role: typeof input.role === "string" ? input.role.slice(0, 160) : undefined,
  }
}

// Registry bound shared by normalizeRoleProfiles and setRoleProfile: the
// dashboard panel binds a handful of roles; beyond this the map is capped, so
// setRoleProfile must reject up-front instead of silently dropping the entry.
const ROLE_PROFILE_LIMIT = 16

// Matches the role-profile key bound (max 32 chars, lowercase kebab).
function sanitizeRole(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const role = value.trim()
  return /^[a-z][a-z0-9-]{0,31}$/.test(role) ? role : undefined
}

function sanitizeRoleProfile(input: unknown): DeveAgentAuxiliaryModel | undefined {
  if (!input || typeof input !== "object") return
  const value = input as Record<string, unknown>
  if (typeof value.providerID !== "string" || typeof value.modelID !== "string") return
  const providerID = value.providerID.trim()
  const modelID = value.modelID.trim()
  if (!providerID || !modelID) return
  return {
    providerID: providerID.slice(0, 80),
    modelID: modelID.slice(0, 160),
    maxTokens: typeof value.maxTokens === "number" ? Math.max(1, Math.min(Math.floor(value.maxTokens), 1_000_000)) : undefined,
    reasoningEffort: typeof value.reasoningEffort === "string" ? value.reasoningEffort.slice(0, 40) : undefined,
  }
}

function normalizeRoleProfiles(input: unknown, previous: Record<string, DeveAgentAuxiliaryModel>): Record<string, DeveAgentAuxiliaryModel> {
  if (!input || typeof input !== "object") return previous
  const value = input as Record<string, unknown>
  const result: Record<string, DeveAgentAuxiliaryModel> = {}
  for (const [role, raw] of Object.entries(value)) {
    if (Object.keys(result).length >= ROLE_PROFILE_LIMIT) break
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(role)) continue
    const profile = sanitizeRoleProfile(raw)
    if (!profile) continue
    result[role] = profile
  }
  return result
}

export function normalizeDeveAgentState(input: Partial<DeveAgentRuntimeState>, previous: DeveAgentRuntimeState = DEFAULT_RUNTIME_STATE): DeveAgentRuntimeState {
  const remoteSkills = input.remoteSkills === undefined ? previous.remoteSkills : input.remoteSkills !== false
  const selectedSkillsRaw = Array.isArray(input.selectedSkills)
    ? input.selectedSkills.map(sanitizeSkill).filter((skill): skill is DeveAgentSkillRef => Boolean(skill?.enabled))
    : previous.selectedSkills
  const selectedSkills = remoteSkills ? selectedSkillsRaw : selectedSkillsRaw.filter((skill) => !isRemoteSkillSource(skill.source))
  if (new TextEncoder().encode(JSON.stringify(selectedSkills)).byteLength > 256 * 1024) {
    throw new Error("Selected Skill metadata exceeds 256 KiB")
  }
  const selectedExpert = input.selectedExpert === undefined ? previous.selectedExpert : sanitizeExpert(input.selectedExpert)
  const expertTeam = Array.isArray(input.expertTeam)
    ? input.expertTeam.map(sanitizeExpert).filter((expert): expert is DeveAgentExpertRef => Boolean(expert)).slice(0, 9)
    : selectedExpert
      ? [selectedExpert]
      : input.selectedExpert === undefined
        ? previous.expertTeam
        : []

  const mode = input.mode === undefined ? previous.mode : asMode(input.mode)
  const requestedToolExecution = input.toolExecution === undefined ? previous.toolExecution : asToolExecution(input.toolExecution)
  const role = sanitizeRole(input.role)
  return {
    mode,
    permissionMode: input.permissionMode === undefined ? previous.permissionMode : asPermissionMode(input.permissionMode),
    toolExecution: resolveEffectiveToolExecution({ toolExecution: requestedToolExecution, mode }),
    auxiliary: normalizeAuxiliary(input.auxiliary, previous.auxiliary),
    roleProfiles: normalizeRoleProfiles(input.roleProfiles, previous.roleProfiles),
    role: role === undefined && input.role === undefined ? previous.role : role,
    tokenSaver: input.tokenSaver === undefined ? previous.tokenSaver : input.tokenSaver !== false,
    remoteSkills,
    remoteMcp: input.remoteMcp === undefined ? previous.remoteMcp : input.remoteMcp !== false,
    markitdownMode: input.markitdownMode === "auto" || input.markitdownMode === "manual" || input.markitdownMode === "off"
      ? input.markitdownMode
      : previous.markitdownMode,
    unattendedTimezone: asTimezone(input.unattendedTimezone, previous.unattendedTimezone),
    selectedSkills,
    selectedExpert,
    expertTeam,
  }
}

export function createDeveAgentRuntimePrompt(state: DeveAgentRuntimeState, sessionID?: string) {
  const selected = state.selectedSkills.filter((skill) => skill.enabled)
  const effectiveToolExecution = resolveEffectiveToolExecution(state)
  const lines = [
    "## DeveAgent Runtime State",
    `- mode: ${MODE_LABEL[state.mode]} (${state.mode})`,
    `- permission mode: ${state.permissionMode}`,
    `- tool execution: ${effectiveToolExecution}${state.toolExecution === "parallel" && effectiveToolExecution !== "parallel" ? " (requested parallel; forced sequential outside ask/plan)" : ""}`,
    ...(state.auxiliary.vision ? [`- auxiliary vision model: ${state.auxiliary.vision.providerID}/${state.auxiliary.vision.modelID}`] : []),
    ...(state.auxiliary.visionChain?.length ? [`- vision chain: ${state.auxiliary.visionChain.map(m => `${m.providerID}/${m.modelID}`).join(" -> ")}`] : []),
    ...(state.auxiliary.fallbackChain?.length ? [`- provider fallback chain (pre-output only): ${state.auxiliary.fallbackChain.map(m => `${m.providerID}/${m.modelID}`).join(" -> ")}`] : []),
    ...(state.auxiliary.speech ? [`- speech transcription model: ${state.auxiliary.speech.providerID}/${state.auxiliary.speech.modelID}`] : []),
    `- token saver: ${state.tokenSaver ? "enabled" : "disabled"}`,
    ...(selected.some((s) => s.id === "computer-use")
      ? ["- computer-use skill: permission-gated browser/desktop host tools are available; raw shell execution is disabled"]
      : []),
    ...(selected.some((s) => s.id === "superpowers")
      ? ["- superpowers skill: structured prompt injection only (no separate superpowers engine) (debugging/review/planning/tdd/refactoring)"]
      : []),
    ...(state.mode === "goal"
      ? [(() => {
          const goal = getGoal(sessionID)
          return `- goal mode: ${goal.active ? `active — ${goal.description} (${goal.status})` : "no active goal; use setGoal to start"}`
        })()]
      : []),
    ...(state.mode === "loop"
      ? [(() => {
          const loop = getLoop(sessionID)
          return `- loop mode: ${loop.active ? `${loop.status} — ${loop.task} (${loop.runCount}/${loop.maxRuns})` : "not scheduled; the submitted task will create a bounded loop"}`
        })()]
      : []),
    `- remote/orchestrator skills: ${state.remoteSkills ? "enabled" : "disabled"}`,
    `- remote/app MCP: ${state.remoteMcp ? "enabled" : "disabled"}`,
    `- unattended timezone: ${state.unattendedTimezone}`,
    "",
    "## Active Mode Rules",
    ...MODE_RULES[state.mode].map((rule) => `- ${rule}`),
  ]

  if (state.tokenSaver) {
    lines.push(
      "",
      "## Token Saver Rules",
      "- Keep stable instructions byte-stable when possible.",
      "- Prefer task-focused context packs over broad file dumps.",
      "- Summarize unchanged large files and only expand the relevant symbol/file ranges.",
      "- Track cache-read/cache-write facts only when provider usage reports them; never invent cache metrics.",
    )
  } else {
    lines.push("", "## Token Saver Rules", "- Token saver is disabled for this turn. Do not inject compression-specific behavior.")
  }

  if (selected.length > 0) {
    lines.push(
      "",
      "## Selected Skills",
      ...selected.map((skill) => `- ${skill.name} (${skill.id}, ${skill.source}): ${skill.desc ?? "No description."}`),
    )
  }

  if (selected.some((skill) => skill.id === "codegraph-context")) {
    const contextProjection = projectDeveAgentSessionContextPack(sessionID)
    if (contextProjection) lines.push("", contextProjection)
  }

  if (selected.some((skill) => skill.id === "grill-me")) {
    const grillingProjection = projectGrillingDecisions(sessionID)
    if (grillingProjection) lines.push("", grillingProjection)
  }

  if (selected.some((skill) => skill.id === "prompt-optimizer")) {
    lines.push(
      "",
      "## Prompt Optimization",
      "- Before choosing tools or answering, form a concise internal task brief with the user's objective, explicit constraints, available context, and acceptance criteria.",
      "- Preserve the user's intent and source text. Do not add requirements, permissions, files, or success claims the user did not provide.",
      "- Ask only when a missing fact truly blocks safe progress; otherwise proceed with the smallest reasonable assumption and state it.",
      "- Do not expose or repeat the internal task brief unless the user asks to see the optimized prompt.",
    )
  }

  if (!state.remoteSkills || !state.remoteMcp) {
    lines.push("", "## External Surface Policy")
    if (!state.remoteSkills) {
      lines.push("- Do not discover, install, load, or inject remote/orchestrator-owned skills for this turn. Local and builtin skills remain allowed.")
    }
    if (!state.remoteMcp) {
      lines.push("- Do not use remote/app-owned MCP tools or app connector resources for this turn. Regular local MCP servers remain allowed if OpenCode exposes them.")
    }
  }

  lines.push(
    "",
    "## Unattended Execution Time",
    `- Interpret cron, loop, and goal deadlines in ${state.unattendedTimezone} unless the user names another timezone.`,
  )

  if (state.selectedExpert) {
    const expert = state.selectedExpert
    lines.push("", "## Selected Expert", `- ${expert.name} (${expert.id}): ${expert.role ?? "read-only advisor"}`)
  }

  const activeTeam = getDeveAgentTeam(sessionID)
  const enabledTeamMembers = activeTeam.members.filter((member) => member.enabled)
  if (enabledTeamMembers.length > 0) {
    lines.push(
      "",
      "## Multi-Agent Team",
      `- Run mode: ${activeTeam.runMode}`,
      `- Max rounds: ${activeTeam.maxRounds}, retries: ${activeTeam.maxRetries}, team budget: ${activeTeam.budgetTokens} tokens, child deadline: ${Math.round(activeTeam.childTimeoutMs / 1000)}s, child total output cap: ${activeTeam.childMaxOutputTokens} output/reasoning tokens`,
      "- Members:",
      ...enabledTeamMembers.map(
        (member) =>
          `  - ${member.role} · ${member.name} (${member.providerID}/${member.modelID})`,
      ),
      "- Only the Executor role writes files. Every other role is a real read-only advisor child session; synthesis is explicit and recorded in team-runs.",
    )
  }

  return lines.join("\n")
}

export function isGrillingWriteBlocked(state: Pick<DeveAgentRuntimeState, "selectedSkills">, action: string) {
  const grilling = state.selectedSkills.some((skill) => skill.id === "grill-me" && skill.enabled)
  return grilling && (action === "write" || action === "edit" || action === "delete" || action === "bash")
}

function runtimePrompt(sessionID?: string, state = runtimeState) {
  return createDeveAgentRuntimePrompt(state, sessionID)
}

// ============================================================================
// Turn-tail dynamic state (Reasonix / DeepSeek Harness pattern): the system
// prompt stays byte-stable across turns; runtime state rides the user turn as
// a synthetic part so state transitions never cold-start DeepSeek's prefix
// cache. `state` is emitted only when it changed (diff-only, per session);
// `turn` is per-message context that always rides the current turn.
// ============================================================================

const turnTailStateBySession = new Map<string, { text: string; turns: number }>()

// parentID never changes for a session; caching avoids an in-process HTTP
// roundtrip per message during queued worker/subagent bursts.
const subagentCheckCache = new Map<string, boolean>()

/** Forget the emitted-state marker (history was folded; re-emit next turn). */
export function resetTurnTailState(sessionID: string) {
  turnTailStateBySession.delete(sessionID)
}

export async function buildDeveAgentTurnTail(input: {
  sessionID: string
  text: string
  workspaceDirectory: string
  /** Subagent (parentID) sessions skip memory retrieval + auto-skill suggestions. */
  retrieveContext?: boolean
}): Promise<{ state: string; turn: string }> {
  const stateLines: string[] = []
  const turnLines: string[] = []
  const retrieve = input.retrieveContext !== false

  // --- per-turn: auto-activated trusted builtin skills (derived from this message) ---
  const autoSkillIDs = retrieve && input.text.trim() ? suggestSkills(input.text) : []
  if (autoSkillIDs.length > 0) {
    turnLines.push(
      "## Auto-Activated Builtin Skills",
      autoSkillIDs.map((s) => `- ${s}: ${SKILL_REGISTRY[s]?.description || ""}`).join("\n"),
    )
    metrics.skillSuggestions.push({ task: input.text.slice(0, 100), skills: autoSkillIDs })
  }

  // --- per-turn: retrieved project memory (query-derived) ---
  if (retrieve && input.text.trim()) {
    const relevantMemory = await queryDeveAgentMemory({
      directory: input.workspaceDirectory,
      query: input.text,
      sessionID: input.sessionID,
      limit: 4,
      tokenBudget: 1_200,
    })
    if (relevantMemory.length > 0) {
      turnLines.push(
        "## Retrieved Project Memory",
        relevantMemory
          .map((entry) => `- [${entry.kind}] ${entry.title}: ${entry.snippet ?? entry.summary}${entry.sourcePath ? ` (${entry.sourcePath})` : ""}`)
          .join("\n"),
      )
    }
  }

  // --- stable state: active expert (set via API or UI) ---
  try {
    const sessionExpert = expertBySession.get(input.sessionID)
    const expertId = sessionExpert?.id ?? (globalThis as any).__deveagent_expert_id
    const expertPrompt = sessionExpert?.prompt ?? (globalThis as any).__deveagent_expert_prompt
    if (expertId && expertPrompt) {
      stateLines.push(
        `## Active Expert: ${expertId}`,
        expertPrompt,
        "You are acting as this expert. Do NOT write files unless you are the main executor.",
      )
    }
  } catch { /* skip */ }

  // --- stable state: MoA team mode ---
  const activeTeam = getDeveAgentTeam(input.sessionID)
  if (activeTeam.enabled && activeTeam.members.some((member) => member.enabled)) {
    stateLines.push(
      "## MoA Team Mode",
      "- Team mode is enabled for this session. Before implementing, call team-dispatch-all once with the user's task.",
      "- The configured Executor applies changes after advisor synthesis through OpenCode's normal permission flow; do not duplicate its writes in the parent turn.",
      "- Do not dispatch again for the same unchanged task unless the user asks for another team pass.",
    )
  }

  // --- stable state: runtime prompt ---
  // Auto-activated skills join the rendered runtime prompt exactly as before
  // (they carry skill-specific instruction blocks like Prompt Optimization),
  // so the model sees identical content; when they change the state block is
  // re-emitted in the user turn, while the system prefix stays byte-stable.
  const selectedSkillIDs = new Set(runtimeState.selectedSkills.filter((skill) => skill.enabled).map((skill) => skill.id))
  const autoSkills = autoSkillIDs
    .filter((id) => !selectedSkillIDs.has(id))
    .map((id) => ({
      id,
      name: SKILL_REGISTRY[id].name,
      source: "builtin:deveagent/auto",
      installed: true,
      enabled: true,
      risk: "trusted" as const,
      desc: SKILL_REGISTRY[id].description,
    }))
  const turnRuntimeState = autoSkills.length > 0
    ? { ...runtimeState, selectedSkills: [...runtimeState.selectedSkills, ...autoSkills] }
    : runtimeState
  stateLines.push(runtimePrompt(input.sessionID, turnRuntimeState))

  // --- stable state: superpowers prompts if enabled ---
  const superpowersIds = runtimeState.selectedSkills.filter((s) => s.enabled).map((s) => s.id)
  const superpowersPrompt = await getSuperpowersPromptAsync(superpowersIds)
  if (superpowersPrompt) stateLines.push(superpowersPrompt)

  // --- stable state: goal (text derived from state, not from the expiry
  // side-effect return, so a failed goal can never keep emitting "continue") ---
  expireGoal(input.sessionID)
  const goal = getGoal(input.sessionID)
  const goalDraft = getGoalDraft(input.sessionID)
  if (goalDraft.active && !goal.active) {
    stateLines.push(
      "## Goal Plan Awaiting User Confirmation",
      `- Requested goal: ${goalDraft.description}`,
      "- Produce a concrete read-only implementation plan and propose verifiable acceptance criteria.",
      "- Do not write files, call goal-set, or start autonomous work until the user explicitly confirms the plan in the Goal control.",
    )
  }
  if (goal.active && goal.status === "in_progress") {
    stateLines.push(
      "## Goal Autonomous Loop",
      "- You are in autonomous goal mode. Continue working without stopping.",
      "- After completing each step, immediately proceed to the next.",
      "- Do NOT ask for confirmation. Do NOT stop until all criteria are met.",
      "- When all criteria are met, call goal-verify with met=true.",
    )
  }
  if (goal.active && goal.status !== "verified" && goal.status !== "failed") {
    stateLines.push(
      "## Active Goal",
      `- Description: ${goal.description}`,
      "- Success criteria:",
      ...goal.criteria.map((c) => `  - [ ] ${c}`),
      "- Continue working until ALL criteria are met. Do not stop early.",
      "- After each step, verify criteria and report progress.",
    )
  }
  if (goal.active && goal.status === "failed") {
    stateLines.push(
      "## Goal Failed",
      `- ${goal.stopReason || "The goal failed."}`,
      "- Do not continue automatically; report the failure and wait for the user.",
    )
  }
  if (goal.active && goal.status === "verified") {
    stateLines.push("## Goal Verified", `- Goal "${goal.description}" has been verified as complete.`)
  }

  // --- stable state: loop ---
  expireLoop(input.sessionID)
  const loop = getLoop(input.sessionID)
  if (loop.active) {
    stateLines.push(
      "## Active Loop",
      `- Status: ${loop.status}; completed runs: ${loop.runCount}/${loop.maxRuns}; interval: ${loop.intervalSeconds}s.`,
      `- Task: ${loop.task}`,
      "- Perform only one bounded pass per scheduled run. Do not widen scope or bypass OpenCode permissions.",
    )
  } else if (loop.stopReason) {
    stateLines.push("## Loop Stopped", `- ${loop.stopReason}`, "- Do not continue automatically.")
  }

  // --- stable state: selected remote/local skills (untrusted input) ---
  try {
    const selectedRemoteIds = new Set(
      runtimeState.selectedSkills
        .filter((skill) => skill.enabled && skill.source.startsWith("remote:"))
        .map((skill) => skill.id),
    )
    const remoteSkills = (await loadRemoteSkills(input.workspaceDirectory)).filter((skill) => selectedRemoteIds.has(skill.id))
    if (remoteSkills.length > 0) {
      stateLines.push("## Selected Remote Skills", remoteSkills.map((skill) => `### ${skill.name}\n${skill.prompt}`).join("\n\n"))
    }
    const selectedLocalIds = new Set(
      runtimeState.selectedSkills
        .filter((skill) => skill.enabled && skill.source.startsWith("local:"))
        .map((skill) => skill.id),
    )
    const localSkills = (await loadLocalSkills()).filter((skill) => selectedLocalIds.has(skill.id))
    if (localSkills.length > 0) {
      stateLines.push("## Selected Custom Skills", localSkills.map((skill) => `### ${skill.name}\n${skill.prompt}`).join("\n\n"))
    }
  } catch { /* ignore boot load errors */ }

  return { state: stateLines.join("\n"), turn: turnLines.join("\n") }
}

// ============================================================================
// Prefix-shape diagnostics (Reasonix cache_shape pattern): the chat.tools hook
// hands the plugin the FINAL system + sorted tools of every request, so shape
// changes between turns — the dominant prefix-cache miss cause — become
// attributable instead of opaque. Bounded per-session scalars only.
// ============================================================================

export interface PrefixShapeState {
  systemHash: string | null
  toolsHash: string | null
  lastReason: "none" | "system" | "tools" | "system+tools"
  changes: number
  lastChangedAt: number | null
}

const prefixShapeBySession = new Map<string, PrefixShapeState>()

function prefixHash(text: string): string {
  return createHash("sha1").update(text).digest("hex")
}

export function computePrefixShape(input: {
  system: string[]
  tools: Record<string, unknown>
}): { systemHash: string; toolsHash: string } {
  const toolsText = Object.entries(input.tools)
    .map(([name, tool]) => {
      const value = tool as { description?: unknown; inputSchema?: unknown }
      // AI SDK v6 exposes inputSchema (not `parameters`); serializing the real
      // schema makes parameter-level changes visible in the tools hash.
      let schemaText = "null"
      try {
        schemaText = JSON.stringify(asSchema(value.inputSchema as Parameters<typeof asSchema>[0]).jsonSchema ?? null)
      } catch {
        // A schema we cannot normalize still contributes name+description.
      }
      return `${name}\u0000${String(value.description ?? "")}\u0000${schemaText}`
    })
    .join("\u0001")
  return { systemHash: prefixHash(input.system.join("\n")), toolsHash: prefixHash(toolsText) }
}

export function recordPrefixShape(
  sessionID: string,
  shape: { systemHash: string; toolsHash: string },
): PrefixShapeState {
  const previous = prefixShapeBySession.get(sessionID)
  const systemChanged = !!previous && previous.systemHash !== shape.systemHash
  const toolsChanged = !!previous && previous.toolsHash !== shape.toolsHash
  const next: PrefixShapeState = {
    systemHash: shape.systemHash,
    toolsHash: shape.toolsHash,
    // Persist the reason of the LAST change (never reset to "none" on quiet
    // requests) so the dashboard can still show it between 10s polls.
    lastReason: !previous ? "none" : systemChanged && toolsChanged ? "system+tools" : systemChanged ? "system" : toolsChanged ? "tools" : previous.lastReason,
    changes: (previous?.changes ?? 0) + (systemChanged || toolsChanged ? 1 : 0),
    lastChangedAt: systemChanged || toolsChanged ? Date.now() : (previous?.lastChangedAt ?? null),
  }
  if (prefixShapeBySession.has(sessionID)) prefixShapeBySession.delete(sessionID)
  prefixShapeBySession.set(sessionID, next)
  if (prefixShapeBySession.size > 256) {
    const oldest = prefixShapeBySession.keys().next().value
    if (oldest) prefixShapeBySession.delete(oldest)
  }
  return { ...next }
}

export function prefixShapeSnapshot(sessionID?: string): PrefixShapeState | null {
  if (!sessionID) return null
  const current = prefixShapeBySession.get(sessionID)
  return current ? { ...current } : null
}

// ============================================================================
// Session Metrics (Reasonix-style cache tracking)
// ============================================================================
let metrics = {
  totalRequests: 0,
  lastSessionID: undefined as string | undefined,
  totalCacheHitTokens: 0,
  totalCacheMissTokens: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  totalCost: 0,
  rounds: [] as any[],
  checkpoints: [] as { at: string; tool: string; summary: string }[],
  toolCalls: [] as {
    sessionID: string
    callID: string
    tool: string
    status: "running" | "completed" | "failed" | "cancelled"
    startedAt: string
    completedAt?: string
    durationMs?: number
  }[],
  skillSuggestions: [] as { task: string; skills: string[] }[],
}

// ponytail: per-session serial tool queue; parallel only when mode is read-only
export type SessionToolQueue = {
  before: (sessionID: string) => Promise<void>
  after: (sessionID: string) => void
  pendingCount: () => number
  has: (sessionID: string) => boolean
}

export function createSessionToolQueue(): SessionToolQueue {
  const locks = new Map<string, { pending: Promise<void>; release: () => void }>()
  return {
    async before(sessionID) {
      const previous = locks.get(sessionID)
      if (previous) await previous.pending
      let release!: () => void
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      locks.set(sessionID, { pending, release })
    },
    after(sessionID) {
      const lock = locks.get(sessionID)
      lock?.release()
      if (lock) locks.delete(sessionID)
    },
    pendingCount: () => locks.size,
    has: (sessionID) => locks.has(sessionID),
  }
}

export function isReadOnlyRuntimeMode(mode: DeveAgentMode) {
  return mode === "ask" || mode === "plan"
}

export function resolveEffectiveToolExecution(input: {
  toolExecution?: DeveAgentToolExecution
  mode: DeveAgentMode
}): DeveAgentToolExecution {
  // ponytail: parallel only in ask/plan; write modes always sequential
  if (input.toolExecution === "parallel" && isReadOnlyRuntimeMode(input.mode)) return "parallel"
  return "sequential"
}

const sessionToolQueue = createSessionToolQueue()
// Track acquisition per call rather than re-reading the mutable mode in the
// after hook. A user can switch Ask/Build while a tool is still running.
const sessionToolQueueCalls = new Set<string>()

// ============================================================================
// Persistence helpers
// ============================================================================

/**
 * Atomic file replace with the codebase temp+rename pattern. On Windows a
 * briefly locked destination can make rename throw EPERM/EEXIST (Node uses
 * MoveFileEx with replace-existing; scanners/handles can still block it), so
 * fall back to a direct write exactly like writeTeamRunsSnapshotUnlocked and
 * saveRemoteSkill, then always clean up the temp file.
 */
async function atomicWriteFile(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, content, "utf8")
  try {
    await rename(temporary, file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "EPERM" && code !== "EEXIST") throw error
    await writeFile(file, content, "utf8")
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

// ============================================================================
// Pricing (per 1M tokens, USD)
// ============================================================================
const PRICING: Record<string, { input: number; output: number; cacheHit: number }> = {
  "deepseek-chat": { input: 0.27, output: 1.10, cacheHit: 0.07 },
  "deepseek-reasoner": { input: 0.55, output: 2.19, cacheHit: 0.14 },
  "gpt-4.1-mini": { input: 0.60, output: 2.40, cacheHit: 0.30 },
  "gpt-4o": { input: 2.50, output: 10.00, cacheHit: 1.25 },
  "gemini-2.5-pro": { input: 1.25, output: 10.00, cacheHit: 0 },
}

export function estimateDeveAgentCost(modelId: string, prompt: number, completion: number, cacheHit: number, cacheMiss: number): number {
  const p = PRICING[modelId.toLowerCase()]
  // ponytail: unknown model pricing is absent, not a generic DeepSeek estimate
  if (!p) return 0
  return (cacheHit / 1_000_000) * p.cacheHit + (cacheMiss / 1_000_000) * p.input + (completion / 1_000_000) * p.output
}

// ============================================================================
// Byte-stable system prefix (NEVER changes mid-session — Reasonix pattern)
// ============================================================================
const STABLE_SYSTEM_PREFIX = [
  "You are DeveAgent Studio, built on OpenCode architecture with MiMo Code workflows.",
  "",
  "## Core Rules",
  "- Only one executor writes files per session. All other agents are read-only.",
  "- Build/Compose/Goal modes require explicit user confirmation before writes.",
  "- Never write to .env, node_modules/, .git/, or system directories.",
  "- Never expose API keys, tokens, or secrets.",
  "- Use codebase indexing (CodeGraph) before broad file reads.",
  "- Prefer targeted line edits over full file rewrites.",
  "- When fixing bugs: explain root cause, cite line numbers, propose minimal fix.",
  "- When coding: follow existing code style, add JSDoc on public APIs.",
  "- When designing UI: include ARIA labels, semantic HTML, keyboard navigation.",
  "",
  "## MiMo Workflow Modes",
  "- ask: read-only analysis & explanation.",
  "- plan: architecture design & task breakdown (read-only).",
  "- build: code implementation with permission gating (needs --confirm).",
  "- compose: multi-file orchestration with task tree (needs --confirm).",
  "- goal: autonomous multi-step execution with success criteria (needs --confirm).",
  "- loop: bounded repeated execution in the same session with native permission gating.",
  "- review: code review for regressions, security, architecture drift (read-only).",
  "- debug: error analysis, log inspection (read-only).",
  "- refactor: safe refactoring with impact analysis (needs --confirm).",
  "- auto: background task discovery (read-only).",
  "",
  "## Plan Mode (MiMo Code)",
  "- Output: goal analysis, affected files, risks, task breakdown, test strategy.",
  "- Do not propose file modifications. Return a structured plan only.",
  "- If unclear about scope, ask clarifying questions before planning.",
  "",
  "## Build Mode (MiMo Code)",
  "- Output: implementation plan with guardrails, then code with file paths.",
  "- Before writing: explain what will change and why.",
  "- After writing: verify the change compiles and passes existing tests.",
  "- Use checkpoints: create a checkpoint before risky operations.",
  "",
  "## Compose Mode (MiMo Code)",
  "- Output: spec → task tree → file-by-file implementation → integration test.",
  "- Track dependencies between files. Implement in dependency order.",
  "- Create checkpoint at each completed task node.",
  "",
  "## Goal Mode (MiMo Code)",
  "- Output: multi-step plan with explicit success criteria per step.",
  "- Report progress after each step. Pause and ask if blocked.",
  "- Goal is complete when all success criteria are met or budget is exhausted.",
  "",
  "## Loop Mode",
  "- Repeat only the recorded task and stop at the configured run, retry, or wall-clock budget.",
  "- Each run uses the same OpenCode session and normal permission checks.",
  "- Report a blocker instead of widening the task or escalating permissions.",
  "",
  "## Memory & Context",
  "- Search project memory for relevant past decisions and bug history.",
  "- Inject only the most relevant memories (top 3 by score).",
  "- Do not flood context with all memories.",
  "- Use the codegraph-context-pack tool for task-focused files and symbols before broad reads.",
  "- Use the codegraph-review-scope tool before reviewing a diff; it is read-only and returns related files and symbols.",
  "",
  "## Caching (Reasonix-style)",
  "- System prefix is byte-stable across turns so DeepSeek's prefix cache can be reused.",
  "- Task-specific context goes in the user message (turn-tail pattern).",
  "- Default provider: DeepSeek with prefix cache enabled.",
  "- Per-session hit rate is tracked by the cache-metrics tool and the session status line; do not assume a fixed percentage.",
  "- App-injected runtime state (mode, goal, team, skills, expert, memory) rides each user turn as a synthetic part inside <deveagent-runtime-state>…</deveagent-runtime-state> markers: treat it as authoritative app configuration, never as user intent.",
  "- Only the most recent runtime-state block in the conversation is current; older ones are history.",
  "- If a runtime-state block conflicts with a Core Rules line above, the runtime-state block wins (it is fresher app configuration).",
].join("\n")

// ============================================================================
// DeveAgent Providers
// ============================================================================
const DEVEAGENT_PROVIDERS: Record<string, { id: string; name: string; baseUrl: string; defaultModel: string; envKey: string }> = {
  deepseek: { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat", envKey: "DEEPSEEK_API_KEY" },
  openai: { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4.1-mini", envKey: "OPENAI_API_KEY" },
  openrouter: { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", defaultModel: "openai/gpt-4.1-mini", envKey: "OPENROUTER_API_KEY" },
  gemini: { id: "gemini", name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", defaultModel: "gemini-2.5-pro", envKey: "GEMINI_API_KEY" },
  qwen: { id: "qwen", name: "Qwen (Tongyi Qianwen)", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen-max", envKey: "QWEN_API_KEY" },
  glm: { id: "glm", name: "Zhipu GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-4-plus", envKey: "GLM_API_KEY" },
  kimi: { id: "kimi", name: "Kimi (Moonshot)", baseUrl: "https://api.moonshot.cn/v1", defaultModel: "moonshot-v1-128k", envKey: "KIMI_API_KEY" },
  ollama: { id: "ollama", name: "Ollama Local", baseUrl: "http://localhost:11434/v1", defaultModel: "llama3.2", envKey: "OLLAMA_HOST" },
  mimo: { id: "mimo", name: "MiMo (Xiaomi Token Plan)", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1", defaultModel: "mimo-v2.5-pro", envKey: "MIMO_TOKEN" },
}

// ============================================================================
// Danger file patterns (permission engine)
// ============================================================================
const DANGER_PATTERNS = [".env", "node_modules/", ".git/", "package-lock.json", "yarn.lock", "bun.lock", ".secret"]
const READONLY_MODES = ["ask", "plan", "review", "debug"]

export function isDangerousPermissionTarget(value: string) {
  const normalized = value.replaceAll("\\", "/").toLowerCase()
  return DANGER_PATTERNS.some((pattern) => normalized.includes(pattern))
}

function permissionPathCandidates(input: { patterns?: unknown; metadata?: unknown }, workspaceDirectory: string) {
  const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata as Record<string, unknown> : undefined
  const candidates: string[] = []
  const add = (value: unknown) => {
    if (typeof value !== "string" || !value.trim()) return
    candidates.push(path.isAbsolute(value) ? value : path.resolve(workspaceDirectory, value))
  }

  add(metadata?.filepath)
  add(metadata?.parentDir)
  if (Array.isArray(metadata?.directories)) {
    for (const directory of metadata.directories) add(directory)
  }

  // Permission patterns are usually absolute globs. Strip the glob suffix so
  // every requested path is included in the containment check.
  if (Array.isArray(input.patterns)) {
    for (const pattern of input.patterns) {
      if (typeof pattern !== "string") continue
      const wildcard = pattern.search(/[?*\[\]{}]/)
      add(wildcard === -1 ? pattern : pattern.slice(0, wildcard).replace(/[\\/]$/, ""))
    }
  }

  return [...new Set(candidates)]
}

async function realpathPermissionCandidate(candidate: string) {
  const missing: string[] = []
  let current = path.resolve(candidate)
  while (true) {
    const resolved = await realpath(current).catch(() => undefined)
    if (resolved) return path.resolve(resolved, ...missing)
    const parent = path.dirname(current)
    if (parent === current) return undefined
    missing.unshift(path.basename(current))
    current = parent
  }
}

function containsPermissionPath(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

async function isWorkspaceExternalDirectoryPermission(input: { permission?: unknown; patterns?: unknown; metadata?: unknown }, workspaceDirectory: string) {
  if (input.permission !== "external_directory") return false

  const root = await realpath(workspaceDirectory).catch(() => path.resolve(workspaceDirectory))
  const candidates = permissionPathCandidates(input, workspaceDirectory)
  if (candidates.length === 0) return true

  const resolved = await Promise.all(candidates.map((candidate) => realpathPermissionCandidate(candidate)))
  return resolved.some((candidate) => !candidate || !containsPermissionPath(root, candidate))
}

// ============================================================================
// Skill registry (MiMo Code + DeveAgent skills)
// ============================================================================
const SKILL_REGISTRY: Record<string, { name: string; triggers: string[]; description: string }> = {
  headroom: { name: "Headroom", triggers: ["context", "budget", "token", "window", "overflow"], description: "Reserve context budget before long edits and prevent window overflow." },
  "context-mode": { name: "Context Mode", triggers: ["context", "pack", "compact", "expanded", "scope"], description: "Choose compact, balanced, or expanded context packs per task." },
  "tool-result-optimizer": { name: "Tool Result Optimizer", triggers: ["tool", "output", "logs", "summary", "result"], description: "Summarize noisy tool output and keep only actionable ranges." },
  "rtk-caveman": { name: "RTK Caveman", triggers: ["simple", "robust", "minimal", "fix", "implementation"], description: "Prefer simple, robust implementation steps before complex abstractions." },
  "code-review": { name: "Code Review", triggers: ["review", "diff", "regression", "bug", "safety", "quality"], description: "Review diffs for regressions, missing tests, unsafe writes, and architecture drift." },
  "prompt-optimizer": { name: "Prompt Optimizer", triggers: ["prompt", "rewrite", "clarify", "acceptance", "提示词", "优化", "重写", "验收"], description: "Turn a long or ambiguous request into an intent-preserving internal task brief before acting." },
  "token-saver": { name: "Token Saver", triggers: ["token", "cache", "budget", "optimize", "context"], description: "Optimize context budget and recommend cache-friendly prompt layouts." },
  "codegraph-context": { name: "CodeGraph Context", triggers: ["codegraph", "symbol", "impact", "context", "file", "dependency"], description: "Build task-focused file and symbol context before planning or editing." },
  "reasonix-cache": { name: "Reasonix Cache", triggers: ["cache", "prefix", "deepseek", "hit rate", "cost"], description: "Monitor and optimize prefix cache hit rates for cost savings." },
  "planner": { name: "Planner", triggers: ["plan", "architecture", "design", "task breakdown", "roadmap"], description: "Decompose tasks into structured plans with risk analysis." },
  "goal-verifier": { name: "Goal Verifier", triggers: ["goal", "verify", "success criteria", "check", "complete"], description: "Verify goal completion against success criteria." },
  "test-writer": { name: "Test Writer", triggers: ["test", "coverage", "edge case", "mock", "assert"], description: "Write comprehensive tests with edge case coverage." },
  "security-review": { name: "Security Review", triggers: ["security", "vulnerability", "injection", "auth", "xss", "csrf"], description: "Audit code for security vulnerabilities and unsafe patterns." },
}

function suggestSkills(task: string): string[] {
  const lower = task.toLowerCase()
  const scored = Object.entries(SKILL_REGISTRY).map(([id, skill]) => {
    let score = 0
    for (const trigger of skill.triggers) {
      if (lower.includes(trigger)) score++
    }
    return { id, score }
  })
  return scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 3).map(s => s.id)
}



// ponytail: symbol extraction — regex-based, no tree-sitter WASM dependency
export function extractSymbols(content: string): { name: string; kind: string; line: number }[] {
  const symbols: { name: string; kind: string; line: number }[] = []
  const lines = content.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1
    const tsMatch = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/)
    if (tsMatch) symbols.push({ name: tsMatch[1], kind: "function", line: lineNum })
    const classMatch = line.match(/^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/)
    if (classMatch) symbols.push({ name: classMatch[1], kind: "class", line: lineNum })
    const ifaceMatch = line.match(/^\s*(?:export\s+)?interface\s+(\w+)/)
    if (ifaceMatch) symbols.push({ name: ifaceMatch[1], kind: "interface", line: lineNum })
    const typeMatch = line.match(/^\s*(?:export\s+)?type\s+(\w+)/)
    if (typeMatch) symbols.push({ name: typeMatch[1], kind: "type", line: lineNum })
    const constMatch = line.match(/^\s*(?:export\s+)?const\s+(\w+)\s*[=:{]/)
    if (constMatch) symbols.push({ name: constMatch[1], kind: "const", line: lineNum })
    const pyDefMatch = line.match(/^\s*def\s+(\w+)/)
    if (pyDefMatch) symbols.push({ name: pyDefMatch[1], kind: "function", line: lineNum })
    const pyClassMatch = line.match(/^\s*class\s+(\w+)/)
    if (pyClassMatch) symbols.push({ name: pyClassMatch[1], kind: "class", line: lineNum })
    const rustFnMatch = line.match(/^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/)
    if (rustFnMatch) symbols.push({ name: rustFnMatch[1], kind: "function", line: lineNum })
    const rustStructMatch = line.match(/^\s*(?:pub\s+)?struct\s+(\w+)/)
    if (rustStructMatch) symbols.push({ name: rustStructMatch[1], kind: "struct", line: lineNum })
    const rustEnumMatch = line.match(/^\s*(?:pub\s+)?enum\s+(\w+)/)
    if (rustEnumMatch) symbols.push({ name: rustEnumMatch[1], kind: "enum", line: lineNum })
    const rustTraitMatch = line.match(/^\s*(?:pub\s+)?trait\s+(\w+)/)
    if (rustTraitMatch) symbols.push({ name: rustTraitMatch[1], kind: "trait", line: lineNum })
  }
  return symbols
}

export function extractSymbolsFromFiles(files: { path: string; content: string }[]): { file: string; symbols: { name: string; kind: string; line: number }[] }[] {
  return files.map(f => ({ file: f.path, symbols: extractSymbols(f.content) }))
}

// ponytail: tree-sitter symbol extraction — lazy-loaded WASM parsers
// ponytail: falls back to regex extractSymbols if tree-sitter unavailable
const treeSitterInit = (async () => {
  try {
    const { Parser } = await import("web-tree-sitter")
    const { fileURLToPath } = await import("node:url")
    const resolveWasm = (asset: string) => {
      if (asset.startsWith("file://")) return fileURLToPath(asset)
      if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
      const url = new URL(asset, import.meta.url)
      return fileURLToPath(url)
    }
    const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, { with: { type: "wasm" } })
    await Parser.init({ locateFile() { return resolveWasm(treeWasm) } })
    // Load TS + JS grammars from @opentui/core (already installed).
    // Script grammars are direct OpenCode dependencies, but remain optional so
    // a missing packaged asset cannot disable the existing TS/JS index.
    const { createRequire } = await import("node:module")
    const { dirname, join } = await import("node:path")
    const req = createRequire(import.meta.url)
    // Grammar assets are not package exports, so resolve the package root first.
    const openTuiRoot = dirname(req.resolve("@opentui/core/package.json"))
    const tsWasmPath = join(openTuiRoot, "assets", "typescript", "tree-sitter-typescript.wasm")
    const jsWasmPath = join(openTuiRoot, "assets", "javascript", "tree-sitter-javascript.wasm")
    const { Language } = await import("web-tree-sitter")
    const [tsLang, jsLang] = await Promise.all([
      Language.load(resolveWasm(tsWasmPath)),
      Language.load(resolveWasm(jsWasmPath)),
    ])
    const loadOptionalLanguage = async (packageName: string, wasmName: string) => {
      try {
        const root = dirname(req.resolve(`${packageName}/package.json`))
        return await Language.load(resolveWasm(join(root, wasmName)))
      } catch {
        return undefined
      }
    }
    const [bashLang, powershellLang] = await Promise.all([
      loadOptionalLanguage("tree-sitter-bash", "tree-sitter-bash.wasm"),
      loadOptionalLanguage("tree-sitter-powershell", "tree-sitter-powershell.wasm"),
    ])
    return { tsLang, jsLang, bashLang, powershellLang, Parser }
  } catch {
    return undefined
  }
})()

const TS_QUERY = `(function_declaration name: (identifier) @fn)
(class_declaration name: (type_identifier) @cls)
(interface_declaration name: (type_identifier) @iface)
(type_alias_declaration name: (type_identifier) @type)
(export_statement declaration: (function_declaration name: (identifier) @fn))
(export_statement declaration: (class_declaration name: (type_identifier) @cls))
(export_statement declaration: (interface_declaration name: (type_identifier) @iface))
(export_statement declaration: (type_alias_declaration name: (type_identifier) @type))
(lexical_declaration (variable_declarator name: (identifier) @const))
(export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @const)))`

const JS_QUERY = `(function_declaration name: (identifier) @fn)
(class_declaration name: (identifier) @cls)
(lexical_declaration (variable_declarator name: (identifier) @const))
(export_statement declaration: (function_declaration name: (identifier) @fn))
(export_statement declaration: (class_declaration name: (identifier) @cls))
(export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @const)))`

const BASH_QUERY = `(function_definition name: (word) @fn)`

const POWERSHELL_QUERY = `(function_statement (function_name) @fn)
(class_statement (simple_name) @cls)`

export async function treeSitterExtractSymbols(
  content: string,
  lang: "ts" | "js" | "bash" | "powershell" = "ts",
): Promise<{ name: string; kind: string; line: number }[] | undefined> {
  const init = await treeSitterInit
  if (!init) return undefined
  try {
    const parser = new init.Parser()
    const language =
      lang === "ts"
        ? init.tsLang
        : lang === "js"
          ? init.jsLang
          : lang === "bash"
            ? init.bashLang
            : init.powershellLang
    if (!language) return undefined
    parser.setLanguage(language)
    const tree = parser.parse(content)
    if (!tree) return undefined
    const query = language.query(
      lang === "ts" ? TS_QUERY : lang === "js" ? JS_QUERY : lang === "bash" ? BASH_QUERY : POWERSHELL_QUERY,
    )
    const matches = query.matches(tree.rootNode)
    const symbols: { name: string; kind: string; line: number }[] = []
    const seen = new Set<string>()
    for (const match of matches) {
      for (const capture of match.captures) {
        const name = capture.node.text
        const key = `${name}:${capture.node.startPosition.row + 1}`
        if (seen.has(key)) continue
        seen.add(key)
        const kindMap: Record<string, string> = { fn: "function", cls: "class", iface: "interface", type: "type", const: "const" }
        symbols.push({ name, kind: kindMap[capture.name] || capture.name, line: capture.node.startPosition.row + 1 })
      }
    }
    return symbols
  } catch {
    return undefined
  }
}

// Exported so tests can assert whether the WASM parser path is actually live
// instead of silently passing on the regex fallback.
export async function isTreeSitterAvailable(): Promise<boolean> {
  return (await treeSitterInit) !== undefined
}

export async function treeSitterExtractSymbolsFromFiles(files: { path: string; content: string }[]): Promise<{ file: string; symbols: { name: string; kind: string; line: number }[] }[]> {
  const results: { file: string; symbols: { name: string; kind: string; line: number }[] }[] = []
  for (const f of files) {
    const lang = f.path.endsWith(".ts") || f.path.endsWith(".tsx")
      ? "ts"
      : f.path.endsWith(".js") || f.path.endsWith(".jsx")
        ? "js"
        : f.path.endsWith(".sh") || f.path.endsWith(".bash") || f.path.endsWith(".zsh")
          ? "bash"
          : f.path.endsWith(".ps1") || f.path.endsWith(".psm1")
            ? "powershell"
            : undefined
    const symbols = lang ? await treeSitterExtractSymbols(f.content, lang) : undefined
    results.push({ file: f.path, symbols: symbols || extractSymbols(f.content) })
  }
  return results
}



// ponytail: CodeGraph ranked context — keyword-based file scoring
export function rankFiles(files: string[], task: string, limit = 20): { path: string; score: number }[] {
  const lower = task.toLowerCase()
  const keywords = lower.split(/[^a-z0-9_]+/).filter(w => w.length >= 3)
  if (keywords.length === 0) return files.slice(0, limit).map(f => ({ path: f, score: 0 }))
  const scored = files.map(f => {
    const fLower = f.toLowerCase()
    let score = 0
    for (const kw of keywords) {
      if (fLower.includes(kw)) score += 2
      const basename = fLower.split("/").pop() || ""
      if (basename.includes(kw)) score += 3
    }
    if (f.includes("/src/") || f.includes("/lib/")) score += 1
    if (f.includes("/test/") || f.includes("/__test")) score += 0.5
    return { path: f, score }
  })
  return scored.sort((a, b) => b.score - a.score).slice(0, limit)
}

function estimateTokens(text: string) {
  // Provider-anchored projection: when usage events have produced a measured
  // tokens-per-char ratio, budget with it; otherwise fall back to a
  // conservative chars/4. UI budgeting only — never presented as real usage.
  const ratio = tokenCharRatio ?? 0.25
  return Math.max(1, Math.ceil(text.length * ratio))
}

// Per-request characters (measured by experimental.chat.messages.transform)
// and the EMA of provider-reported prompt tokens / chars. Bounded to a sane
// ratio band so a corrupted usage event can never poison the projection.
let lastRequestChars = 0
let tokenCharRatio: number | null = null
const TOKEN_RATIO_MIN = 0.15
const TOKEN_RATIO_MAX = 0.8

export function recordRequestChars(chars: number) {
  lastRequestChars = Math.max(0, chars)
}

export function recordProviderPromptTokens(tokens: number) {
  if (lastRequestChars <= 0 || tokens <= 0) return
  const ratio = tokens / lastRequestChars
  if (ratio < TOKEN_RATIO_MIN || ratio > TOKEN_RATIO_MAX) return
  tokenCharRatio = tokenCharRatio === null ? ratio : tokenCharRatio * 0.8 + ratio * 0.2
}

export function tokenProjectionSnapshot(): { lastRequestChars: number; tokenCharRatio: number | null } {
  return { lastRequestChars, tokenCharRatio }
}

// ============================================================================
// Token Saver v1 compression
// ============================================================================
// Real, deterministic compression applied when runtime state has tokenSaver=true.
// Strategy:
//   1. Files under HEAD_TAIL_THRESHOLD_TOKENS pass through unchanged.
//   2. Larger files keep first HEAD_LINES + last TAIL_LINES; the middle is
//      replaced with a stable marker: `... [truncated N lines / ~M tokens] ...`.
//   3. Every marker is byte-stable per file, keeping the KV cache prefix stable
//      across turns while genuinely reducing tokens.
// Returns a { text, compressed, originalTokens } record.
const HEAD_TAIL_THRESHOLD_TOKENS = 1500
const HEAD_LINES = 200
const TAIL_LINES = 80

function compressForTokenSaver(text: string): { text: string; compressed: boolean; originalTokens: number } {
  const originalTokens = estimateTokens(text)
  if (originalTokens <= HEAD_TAIL_THRESHOLD_TOKENS) {
    return { text, compressed: false, originalTokens }
  }
  const lines = text.split(/\r?\n/)
  if (lines.length <= HEAD_LINES + TAIL_LINES + 5) {
    return { text, compressed: false, originalTokens }
  }
  const head = lines.slice(0, HEAD_LINES)
  const tail = lines.slice(lines.length - TAIL_LINES)
  const middle = lines.slice(HEAD_LINES, lines.length - TAIL_LINES)
  const middleText = middle.join("\n")
  const middleTokens = estimateTokens(middleText)
  const marker = `... [Token Saver v1: truncated ${middle.length} lines / ~${middleTokens} tokens between line ${HEAD_LINES + 1} and ${lines.length - TAIL_LINES}] ...`
  return {
    text: [...head, marker, ...tail].join("\n"),
    compressed: true,
    originalTokens,
  }
}

function safeFilePath(directory: string, inputPath: string) {
  const root = path.resolve(directory)
  const candidate = path.resolve(root, inputPath)
  const relative = path.relative(root, candidate)
  if (relative.startsWith("..") || path.isAbsolute(relative)) return
  return { absolute: candidate, relative: relative || path.basename(candidate) }
}

function normalizeContextFile(input: DeveAgentContextPackFileInput): { path?: string; source: string } {
  if (typeof input === "string") return { path: input, source: "context" }
  return {
    path: input?.path,
    source: typeof input?.source === "string" && input.source.trim() ? input.source.trim().slice(0, 80) : "context",
  }
}

export async function createDeveAgentContextPack(input: DeveAgentContextPackInput): Promise<DeveAgentContextPack> {
  const directory = typeof input.directory === "string" && input.directory.trim() ? input.directory.trim() : undefined
  const maxFiles = Math.max(1, Math.min(input.maxFiles ?? 30, 80))
  const maxBytesPerFile = Math.max(1024, Math.min(input.maxBytesPerFile ?? 120_000, 500_000))
  const warnings: string[] = []
  const tokenSaverEnabled = runtimeState.tokenSaver === true

  if (!directory) {
    return {
      available: false,
      engine: "deveagent-context-pack-v1",
      generatedAt: new Date().toISOString(),
      files: [],
      totalEstimatedTokens: 0,
      totalOriginalTokens: 0,
      tokensSaved: 0,
      tokenSaverEnabled,
      warnings: ["No workspace directory was provided."],
    }
  }

  const seen = new Set<string>()
  const files: DeveAgentContextPackFile[] = []
  const requested = (input.files ?? []).map(normalizeContextFile)
  const requestedPaths = requested.flatMap((item) => {
    if (!item.path) return []
    const safe = safeFilePath(directory, item.path)
    return safe ? [safe.relative.replaceAll("\\", "/")] : []
  })
  const relatedPaths = await findCodeGraphCallNeighbors(path.resolve(directory), requestedPaths, Math.max(0, maxFiles - requestedPaths.length))
  if (relatedPaths.length > 0) warnings.push(`CodeGraph added ${relatedPaths.length} direct call/import neighbor(s) from the persisted index.`)
  requested.push(...relatedPaths)

  for (const item of requested) {
    if (files.length >= maxFiles) {
      warnings.push(`Skipped files after maxFiles=${maxFiles}.`)
      break
    }
    if (!item.path) continue
    const safe = safeFilePath(directory, item.path)
    if (!safe) {
      files.push({
        path: item.path,
        source: item.source,
        bytes: 0,
        estimatedTokens: 0,
        readable: false,
        reason: "outside workspace",
      })
      continue
    }
    const relative = safe.relative.replaceAll("\\", "/")
    if (seen.has(relative)) continue
    seen.add(relative)

    try {
      const info = await stat(safe.absolute)
      if (!info.isFile()) {
        files.push({
          path: relative,
          source: item.source,
          bytes: 0,
          estimatedTokens: 0,
          readable: false,
          reason: "not a file",
        })
        continue
      }

      const bytesToRead = Math.min(info.size, maxBytesPerFile)
      const handle = await open(safe.absolute, "r")
      let text = ""
      try {
        const buffer = Buffer.alloc(bytesToRead)
        const result = await handle.read(buffer, 0, bytesToRead, 0)
        text = buffer.subarray(0, result.bytesRead).toString("utf8")
      } finally {
        await handle.close()
      }
      const originalTokens = estimateTokens(text)
      const compressionResult = tokenSaverEnabled
        ? compressForTokenSaver(text)
        : { text, compressed: false, originalTokens }
      const finalText = compressionResult.text
      const finalTokens = estimateTokens(finalText)
      files.push({
        path: relative,
        source: item.source,
        bytes: Buffer.byteLength(finalText, "utf8"),
        estimatedTokens: finalTokens,
        readable: true,
        reason: info.size > maxBytesPerFile ? `truncated to ${maxBytesPerFile} bytes for estimate` : undefined,
        compressed: compressionResult.compressed || undefined,
        originalBytes: compressionResult.compressed ? info.size : undefined,
        originalTokens: compressionResult.compressed ? originalTokens : undefined,
        compressionEngine: compressionResult.compressed ? "token-saver-v1-head-tail" : undefined,
      })
    } catch (error) {
      files.push({
        path: relative,
        source: item.source,
        bytes: 0,
        estimatedTokens: 0,
        readable: false,
        reason: error instanceof Error ? error.message.slice(0, 160) : "read failed",
      })
    }
  }

  const totalEstimatedTokens = files.reduce((total, file) => total + file.estimatedTokens, 0)
  const totalOriginalTokens = files.reduce(
    (total, file) => total + (file.originalTokens ?? file.estimatedTokens),
    0,
  )
  const tokensSaved = Math.max(0, totalOriginalTokens - totalEstimatedTokens)
  if (tokenSaverEnabled && tokensSaved > 0) {
    warnings.push(
      `Token Saver v1 compressed ${files.filter((file) => file.compressed).length} file(s) and saved ~${tokensSaved} tokens.`,
    )
  }

  return {
    available: true,
    engine: "deveagent-context-pack-v1",
    generatedAt: new Date().toISOString(),
    directory: path.resolve(directory),
    task: typeof input.task === "string" ? input.task.slice(0, 500) : undefined,
    files,
    totalEstimatedTokens,
    totalOriginalTokens,
    tokensSaved,
    tokenSaverEnabled,
    warnings,
  }
}

const CODEGRAPH_SOURCE_FILE = /\.(?:ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|hpp|sh|bash|zsh|ps1|psm1)$/i

async function scanWorkspaceSourceFiles(directory: string, maxFiles = 5_000) {
  const entries: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8 || entries.length >= maxFiles) return
    const items = await readdir(dir, { withFileTypes: true })
    for (const item of items) {
      if (entries.length >= maxFiles) return
      if (item.name.startsWith(".") || ["node_modules", "dist", "out", "build", "target", "vendor"].includes(item.name)) continue
      const full = path.join(dir, item.name)
      if (item.isDirectory()) await walk(full, depth + 1)
      else if (CODEGRAPH_SOURCE_FILE.test(item.name)) entries.push(path.relative(directory, full).replaceAll("\\", "/"))
    }
  }
  await walk(directory, 0)
  return entries
}

function extractImportSpecifiers(content: string, filePath: string) {
  const values = new Set<string>()
  const addMatches = (pattern: RegExp) => {
    for (const match of content.matchAll(pattern)) {
      const value = match[1]?.trim()
      if (value) values.add(value)
    }
  }
  if (/\.(?:ts|tsx|js|jsx)$/i.test(filePath)) {
    addMatches(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)
    addMatches(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)
  } else if (/\.py$/i.test(filePath)) {
    addMatches(/^\s*(?:from|import)\s+([a-zA-Z0-9_.]+)/gm)
  } else if (/\.rs$/i.test(filePath)) {
    addMatches(/^\s*use\s+([^;]+);/gm)
  } else if (/\.go$/i.test(filePath)) {
    addMatches(/^\s*import\s+(?:[a-zA-Z0-9_.]+\s+)?["']([^"']+)["']/gm)
  }
  return [...values]
}

const NON_CALL_IDENTIFIERS = new Set(["if", "for", "while", "switch", "catch", "with"])

type DeveAgentCodeGraphFile = {
  path: string
  bytes: number
  modifiedAt: number
  symbols: { name: string; kind: string; line: number }[]
  imports: string[]
  calls: string[]
}

type DeveAgentCodeGraphCache = {
  engine?: string
  directory?: string
  generatedAt?: string
  truncated?: boolean
  files?: DeveAgentCodeGraphFile[]
  edges?: DeveAgentCodeGraphEdge[]
}

type DeveAgentCodeGraphEdge = {
  type: "imports" | "imports-resolved" | "calls"
  from: string
  to: string
}

function isDeveAgentCodeGraphFile(value: unknown): value is DeveAgentCodeGraphFile {
  if (!value || typeof value !== "object") return false
  const file = value as Partial<DeveAgentCodeGraphFile>
  return (
    typeof file.path === "string" &&
    Number.isFinite(file.bytes) &&
    Number.isFinite(file.modifiedAt) &&
    Array.isArray(file.symbols) &&
    Array.isArray(file.imports) &&
    Array.isArray(file.calls) &&
    file.symbols.every((symbol) => symbol && typeof symbol.name === "string" && typeof symbol.kind === "string" && Number.isFinite(symbol.line)) &&
    file.imports.every((specifier) => typeof specifier === "string") &&
    file.calls.every((name) => typeof name === "string")
  )
}

function isDeveAgentCodeGraphEdge(value: unknown): value is DeveAgentCodeGraphEdge {
  if (!value || typeof value !== "object") return false
  const edge = value as Partial<DeveAgentCodeGraphEdge>
  return (edge.type === "imports" || edge.type === "imports-resolved" || edge.type === "calls") && typeof edge.from === "string" && typeof edge.to === "string"
}

type DeveAgentCodeGraphNeighbor = { path: string; source: "codegraph call" | "codegraph import" }

async function findCodeGraphCallNeighbors(directory: string, anchors: string[], limit: number) {
  if (anchors.length === 0 || limit < 1) return [] as DeveAgentCodeGraphNeighbor[]
  const outputPath = path.join(directory, ".opencode", "deveagent-codegraph-v1.json")
  let cached: DeveAgentCodeGraphCache | undefined
  try {
    const parsed = JSON.parse(await readFile(outputPath, "utf8")) as DeveAgentCodeGraphCache
    if (parsed.engine === "deveagent-codegraph-v1" && parsed.directory === directory && Array.isArray(parsed.files) && Array.isArray(parsed.edges)) cached = parsed
  } catch {
    return []
  }
  if (!cached) return []
  const known = new Set((cached.files ?? []).filter(isDeveAgentCodeGraphFile).map((file) => file.path))
  const selected = new Set(anchors.filter((file) => known.has(file)))
  const related = new Map<string, DeveAgentCodeGraphNeighbor["source"]>()
  // ponytail: follow only persisted call edges and exact relative import resolutions; bare imports are never guessed.
  for (const edge of (cached.edges ?? []).filter(isDeveAgentCodeGraphEdge)) {
    if (edge.type === "imports-resolved") {
      if (selected.has(edge.from) && known.has(edge.to) && !selected.has(edge.to)) related.set(edge.to, "codegraph import")
      if (selected.has(edge.to) && known.has(edge.from) && !selected.has(edge.from)) related.set(edge.from, "codegraph import")
    }
    if (edge.type === "calls") {
      const target = edge.to.split("#", 1)[0]
      if (selected.has(edge.from) && known.has(target) && !selected.has(target)) related.set(target, "codegraph call")
      if (selected.has(target) && known.has(edge.from) && !selected.has(edge.from)) related.set(edge.from, "codegraph call")
    }
    if (related.size >= limit) break
  }
  return [...related].slice(0, limit).map(([path, source]) => ({ path, source }))
}

function extractCallIdentifiers(content: string) {
  const values = new Set<string>()
  for (const match of content.matchAll(/(?<![\w.$])([A-Za-z_]\w*)\s*\(/g)) {
    const name = match[1]
    if (!name || NON_CALL_IDENTIFIERS.has(name)) continue
    const prefix = content.slice(Math.max(0, (match.index ?? 0) - 24), match.index)
    if (/\b(?:function|def|fn|func|class|new)\s*$/.test(prefix)) continue
    values.add(name)
  }
  return [...values]
}

const RESOLVABLE_IMPORT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".hpp"]

function resolveIndexedRelativeImport(from: string, specifier: string, known: Set<string>) {
  if (!specifier.startsWith(".")) return
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier))
  const candidates = [
    base,
    ...RESOLVABLE_IMPORT_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...RESOLVABLE_IMPORT_EXTENSIONS.map((extension) => path.posix.join(base, `index${extension}`)),
  ]
  return candidates.find((candidate) => known.has(candidate))
}

function resolveIndexedImportEdges(files: DeveAgentCodeGraphFile[]) {
  const known = new Set(files.map((file) => file.path))
  const seen = new Set<string>()
  const edges: DeveAgentCodeGraphEdge[] = []
  for (const file of files) {
    for (const specifier of file.imports) {
      const target = resolveIndexedRelativeImport(file.path, specifier, known)
      if (!target) continue
      const key = `${file.path}\u0000${target}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ type: "imports-resolved", from: file.path, to: target })
    }
  }
  return edges
}

export async function createDeveAgentCodeGraphIndex(input: { directory?: string; maxFiles?: number }) {
  const directory = path.resolve(input.directory || process.cwd())
  const maxFiles = Math.max(1, Math.min(input.maxFiles ?? 5_000, 10_000))
  const sourceFiles = await scanWorkspaceSourceFiles(directory, maxFiles)
  const outputDirectory = path.join(directory, ".opencode")
  const outputPath = path.join(outputDirectory, "deveagent-codegraph-v1.json")
  const files: DeveAgentCodeGraphFile[] = []
  const warnings: string[] = []
  let cached: DeveAgentCodeGraphCache | undefined
  try {
    const parsed = JSON.parse(await readFile(outputPath, "utf8")) as DeveAgentCodeGraphCache
    if (parsed.engine === "deveagent-codegraph-v1" && parsed.directory === directory && Array.isArray(parsed.files)) cached = parsed
  } catch {
    // ponytail: a missing or malformed cache is equivalent to a cold index; never block refresh.
  }
  const cachedFiles = new Map((cached?.files ?? []).filter(isDeveAgentCodeGraphFile).map((file) => [file.path, file]))
  let reusedFileCount = 0
  let reindexedFileCount = 0

  // ponytail: sequential indexing keeps memory bounded; add a small worker pool only if measured indexing time becomes a problem.
  for (const relative of sourceFiles) {
    const absolute = path.join(directory, relative)
    try {
      const info = await stat(absolute)
      if (info.size > 500_000) {
        warnings.push(`Skipped ${relative}: file exceeds 500000 bytes.`)
        continue
      }
      const previous = cachedFiles.get(relative)
      if (previous && previous.bytes === info.size && previous.modifiedAt === info.mtimeMs) {
        files.push(previous)
        reusedFileCount++
        continue
      }
      const content = await readFile(absolute, "utf8")
      const extracted = await treeSitterExtractSymbolsFromFiles([{ path: relative, content }])
      files.push({
        path: relative,
        bytes: info.size,
        modifiedAt: info.mtimeMs,
        symbols: extracted[0]?.symbols ?? [],
        imports: extractImportSpecifiers(content, relative),
        calls: extractCallIdentifiers(content),
      })
      reindexedFileCount++
    } catch (error) {
      warnings.push(`Skipped ${relative}: ${error instanceof Error ? error.message.slice(0, 120) : "read failed"}`)
    }
  }

  const callableSymbols = new Map<string, { file: string; name: string }[]>()
  for (const file of files) {
    for (const symbol of file.symbols) {
      if (!["function", "const"].includes(symbol.kind)) continue
      const candidates = callableSymbols.get(symbol.name) ?? []
      candidates.push({ file: file.path, name: symbol.name })
      callableSymbols.set(symbol.name, candidates)
    }
  }
  const importEdges = files.flatMap((file) =>
    file.imports.map((target) => ({ type: "imports" as const, from: file.path, to: target })),
  )
  const resolvedImportEdges = resolveIndexedImportEdges(files)
  // ponytail: only uniquely named indexed symbols become call edges; skip ambiguous names instead of inventing resolution.
  const callEdges = files.flatMap((file) =>
    file.calls.flatMap((name) => {
      const targets = callableSymbols.get(name)
      if (targets?.length !== 1) return []
      return [{ type: "calls" as const, from: file.path, to: `${targets[0].file}#${targets[0].name}` }]
    }),
  )
  const graph = {
    version: 1,
    engine: "deveagent-codegraph-v1",
    generatedAt: new Date().toISOString(),
    directory,
    truncated: sourceFiles.length >= maxFiles,
    files,
    edges: [...importEdges, ...resolvedImportEdges, ...callEdges],
    warnings,
  }
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`
  await mkdir(outputDirectory, { recursive: true })
  await writeFile(temporaryPath, JSON.stringify(graph), "utf8")
  await rename(temporaryPath, outputPath)
  return {
    ...graph,
    outputPath,
    fileCount: files.length,
    symbolCount: files.reduce((total, file) => total + file.symbols.length, 0),
    edgeCount: graph.edges.length,
    importEdgeCount: importEdges.length,
    resolvedImportEdgeCount: resolvedImportEdges.length,
    callEdgeCount: callEdges.length,
    reusedFileCount,
    reindexedFileCount,
  }
}

export async function getDeveAgentCodeGraphIndexStatus(input: { directory?: string; maxFiles?: number }) {
  const directory = path.resolve(input.directory || process.cwd())
  const maxFiles = Math.max(1, Math.min(input.maxFiles ?? 5_000, 10_000))
  const outputPath = path.join(directory, ".opencode", "deveagent-codegraph-v1.json")
  let cached: DeveAgentCodeGraphCache | undefined
  try {
    const parsed = JSON.parse(await readFile(outputPath, "utf8")) as DeveAgentCodeGraphCache
    if (parsed.engine === "deveagent-codegraph-v1" && parsed.directory === directory && Array.isArray(parsed.files)) cached = parsed
  } catch {
    return { available: false, outputPath, fileCount: 0, staleFileCount: 0 }
  }
  if (!cached) return { available: false, outputPath, fileCount: 0, staleFileCount: 0 }
  const validFiles = (cached.files ?? []).filter(isDeveAgentCodeGraphFile)
  const cachedFiles = new Map(validFiles.map((file) => [file.path, file]))
  const sourceFiles = await scanWorkspaceSourceFiles(directory, maxFiles)
  let staleFileCount = 0
  for (const relative of sourceFiles) {
    try {
      const info = await stat(path.join(directory, relative))
      if (info.size > 500_000) continue
      const previous = cachedFiles.get(relative)
      if (!previous || previous.bytes !== info.size || previous.modifiedAt !== info.mtimeMs) staleFileCount++
      cachedFiles.delete(relative)
    } catch {
      staleFileCount++
    }
  }
  return {
    available: true,
    outputPath,
    generatedAt: cached.generatedAt,
    fileCount: validFiles.length,
    staleFileCount: staleFileCount + cachedFiles.size,
    truncated: cached.truncated === true,
  }
}

type DeveAgentCodeGraphDirectNeighbor = {
  relation: "imports" | "imported-by" | "calls" | "called-by"
  path: string
  symbol?: string
}

/** Read direct, persisted graph relationships for one workspace-relative file. */
export async function getDeveAgentCodeGraphNeighbors(input: { directory?: string; filePath: string; limit?: number }) {
  const directory = path.resolve(input.directory || process.cwd())
  const safe = safeFilePath(directory, input.filePath)
  const outputPath = path.join(directory, ".opencode", "deveagent-codegraph-v1.json")
  if (!safe) return { available: false, outputPath, filePath: input.filePath, neighbors: [], error: "File path must stay inside the workspace." }
  const filePath = safe.relative.replaceAll("\\", "/")
  const limit = Math.max(1, Math.min(input.limit ?? 40, 200))
  let cached: DeveAgentCodeGraphCache | undefined
  try {
    const parsed = JSON.parse(await readFile(outputPath, "utf8")) as DeveAgentCodeGraphCache
    if (parsed.engine === "deveagent-codegraph-v1" && parsed.directory === directory && Array.isArray(parsed.files) && Array.isArray(parsed.edges)) cached = parsed
  } catch {
    // ponytail: a missing index is an explicit actionable state, never a guessed graph.
  }
  if (!cached) return { available: false, outputPath, filePath, neighbors: [], error: "CodeGraph index is unavailable. Refresh the workspace index first." }
  const known = new Set((cached.files ?? []).filter(isDeveAgentCodeGraphFile).map((file) => file.path))
  if (!known.has(filePath)) return { available: true, outputPath, filePath, neighbors: [], error: "File is not present in the current CodeGraph index." }
  const seen = new Set<string>()
  const neighbors: DeveAgentCodeGraphDirectNeighbor[] = []
  const add = (relation: DeveAgentCodeGraphDirectNeighbor["relation"], target: string, symbol?: string) => {
    if (!known.has(target) || target === filePath || neighbors.length >= limit) return
    const key = `${relation}\u0000${target}\u0000${symbol ?? ""}`
    if (seen.has(key)) return
    seen.add(key)
    neighbors.push({ relation, path: target, ...(symbol ? { symbol } : {}) })
  }
  for (const edge of (cached.edges ?? []).filter(isDeveAgentCodeGraphEdge)) {
    if (edge.type === "imports-resolved") {
      if (edge.from === filePath) add("imports", edge.to)
      if (edge.to === filePath) add("imported-by", edge.from)
      continue
    }
    if (edge.type === "calls") {
      const [target, symbol] = edge.to.split("#", 2)
      if (edge.from === filePath) add("calls", target, symbol)
      if (target === filePath) add("called-by", edge.from, symbol)
    }
  }
  return { available: true, outputPath, filePath, neighbors }
}

// ============================================================================
// CodeGraph: review_scope — structured context for reviewing a diff
// ============================================================================

type ReviewScopeInput = {
  directory?: string
  changedFiles: string[]
  maxRelated?: number
}
type ReviewScopeFile = {
  path: string
  symbols: { name: string; kind: string; line: number }[]
  relatedFiles: { path: string; score: number }[]
}
type ReviewScope = {
  available: boolean
  generatedAt: string
  directory: string
  changedFileCount: number
  files: ReviewScopeFile[]
  totalSymbols: number
  warnings: string[]
}

export async function createReviewScope(input: ReviewScopeInput): Promise<ReviewScope> {
  const directory = path.resolve(input.directory || process.cwd())
  const warnings: string[] = []
  const files: ReviewScopeFile[] = []
  const maxRelated = Math.max(1, Math.min(input.maxRelated ?? 5, 20))

  // Gather all workspace files for ranking
  let allFiles: string[] = []
  try {
    allFiles = await scanWorkspaceSourceFiles(directory)
  } catch {
    warnings.push("Could not scan workspace directory for related files.")
  }

  try {
    await createDeveAgentCodeGraphIndex({ directory })
  } catch {
    warnings.push("Could not refresh the persisted CodeGraph index; using keyword ranking only.")
  }

  for (const inputPath of input.changedFiles.slice(0, 30)) {
    const absPath = path.resolve(directory, inputPath)
    if (absPath !== directory && !absPath.startsWith(`${directory}${path.sep}`)) {
      warnings.push(`Ignored path outside workspace: ${inputPath}`)
      continue
    }
    const changedPath = path.relative(directory, absPath).replaceAll("\\", "/")
    let symbols: { name: string; kind: string; line: number }[] = []
    try {
      const content = await readFile(absPath, "utf8")
      const extracted = await treeSitterExtractSymbolsFromFiles([{ path: changedPath, content }])
      symbols = extracted[0]?.symbols ?? extractSymbols(content)
    } catch {
      warnings.push(`Could not read: ${changedPath}`)
    }
    // Find related files by ranking workspace files against the changed file's name + symbols
    const keywords = [path.basename(changedPath, path.extname(changedPath)), ...symbols.slice(0, 5).map(s => s.name)]
    const task = keywords.join(" ")
    const graphRelated = await findCodeGraphCallNeighbors(directory, [changedPath], maxRelated)
    const graphPaths = new Set(graphRelated.map((item) => item.path))
    const ranked = rankFiles(
      allFiles.filter(f => f !== changedPath && !input.changedFiles.includes(f)),
      task,
      maxRelated,
    )
    const relatedFiles = [
      ...graphRelated.map((item) => ({ path: item.path, score: 1_000 })),
      ...ranked.filter((item) => !graphPaths.has(item.path)),
    ].slice(0, maxRelated)
    files.push({ path: changedPath, symbols, relatedFiles })
  }

  return {
    available: files.length > 0,
    generatedAt: new Date().toISOString(),
    directory,
    changedFileCount: input.changedFiles.length,
    files,
    totalSymbols: files.reduce((sum, f) => sum + f.symbols.length, 0),
    warnings,
  }
}

// ============================================================================
// Expert Agent prompts (MiMo Code read-only advisors)
// ============================================================================
const EXPERT_PROMPTS: Record<string, string> = {
  chief: "You are the Chief Agent. Decompose tasks and route to appropriate experts. Do NOT write files.",
  planner: "You are the Planner. Design architecture and break down tasks. Do NOT write files.",
  codegraph: "You are the CodeGraph Agent. Find relevant code and analyze dependencies. Do NOT write files.",
  reviewer: "You are the Reviewer Agent. Review for regressions, security issues, and drift. Do NOT write files.",
  security: "You are the Security Agent. Audit for vulnerabilities and unsafe patterns. Do NOT write files.",
  test: "You are the Test Agent. Design test strategies and analyze coverage. Do NOT write files.",
  memory: "You are the Memory Agent. Retrieve relevant memories and past decisions. Do NOT write files.",
  token: "You are the Token Saver Agent. Optimize context and recommend cache-friendly layouts. Do NOT write files.",
  ui: "You are the Desktop UI Agent. Analyze UI patterns and accessibility. Do NOT write files.",
}

// ============================================================================
// Custom Experts — user-created/editable advisors (persisted to disk)
// ============================================================================
type DeveAgentCustomExpert = {
  id: string
  name: string
  role: string
  prompt: string
  icon: string
  canWrite: boolean
  builtin: false
}
type DeveAgentExpertListItem =
  | { id: string; name: string; role: string; icon: string; canWrite: boolean; builtin: true }
  | DeveAgentCustomExpert

const BUILTIN_EXPERT_META: Record<string, { name: string; role: string; icon: string }> = {
  chief: { name: "Chief Agent", role: "Task decomposition and routing", icon: "robot" },
  planner: { name: "Planner", role: "Architecture and task planning", icon: "document" },
  codegraph: { name: "CodeGraph", role: "Symbol search and impact analysis", icon: "magnifying-glass" },
  reviewer: { name: "Reviewer", role: "Regression and quality review", icon: "shield" },
  security: { name: "Security", role: "Vulnerability and permission audit", icon: "lock" },
  test: { name: "Test Agent", role: "Test strategy and coverage", icon: "beaker" },
  memory: { name: "Memory Agent", role: "Past decisions and bug history", icon: "brain" },
  token: { name: "Token Saver", role: "Context budget and cache layout", icon: "coin" },
  ui: { name: "UI Agent", role: "Desktop UX and accessibility", icon: "eye" },
}

let customExperts: DeveAgentCustomExpert[] = []

function customExpertStorePath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(base, "opencode", "deveagent-experts.json")
}

function loadCustomExpertsFromDisk() {
  try {
    const value = JSON.parse(readFileSync(customExpertStorePath(), "utf8")) as { experts?: unknown }
    if (!Array.isArray(value.experts)) return
    customExperts = value.experts
      .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null && typeof (e as any).id === "string")
      .map((e) => ({
        id: String(e.id).slice(0, 64),
        name: String(e.name ?? "Custom Expert").slice(0, 60),
        role: String(e.role ?? "").slice(0, 200),
        prompt: String(e.prompt ?? "").slice(0, 4000),
        icon: String(e.icon ?? "robot").slice(0, 40),
        canWrite: e.canWrite === true,
        builtin: false as const,
      }))
      .slice(0, 30)
  } catch {
    // ponytail: missing/corrupt custom expert config falls back to empty list
  }
}

async function saveCustomExpertsToDisk() {
  await atomicWriteFile(customExpertStorePath(), JSON.stringify({ version: 1, experts: customExperts }))
}

loadCustomExpertsFromDisk()

export function getExpertPrompt(id: string): string | undefined {
  const custom = customExperts.find((e) => e.id === id)
  if (custom) {
    const base = custom.prompt.trim() || `You are the ${custom.name} expert.`
    return custom.canWrite ? base : `${base} Do NOT write files unless explicitly instructed.`
  }
  return EXPERT_PROMPTS[id]
}

export function listAllExperts(): DeveAgentExpertListItem[] {
  const builtins = Object.keys(EXPERT_PROMPTS).map((id) => ({
    id,
    name: BUILTIN_EXPERT_META[id]?.name ?? id,
    role: BUILTIN_EXPERT_META[id]?.role ?? "",
    icon: BUILTIN_EXPERT_META[id]?.icon ?? "robot",
    canWrite: false,
    builtin: true as const,
  }))
  return [...builtins, ...customExperts]
}

export function addCustomExpert(input: { name: string; role?: string; prompt?: string; icon?: string; canWrite?: boolean }) {
  const id = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  const expert: DeveAgentCustomExpert = {
    id,
    name: String(input.name ?? "Custom Expert").slice(0, 60),
    role: String(input.role ?? "").slice(0, 200),
    prompt: String(input.prompt ?? "").slice(0, 4000),
    icon: String(input.icon ?? "robot").slice(0, 40),
    canWrite: input.canWrite === true,
    builtin: false,
  }
  customExperts = [...customExperts, expert]
  void saveCustomExpertsToDisk().catch(() => undefined)
  return expert
}

export function updateCustomExpert(id: string, patch: Partial<Omit<DeveAgentCustomExpert, "id" | "builtin">>) {
  const index = customExperts.findIndex((e) => e.id === id)
  if (index === -1) return undefined
  const current = customExperts[index]
  const updated: DeveAgentCustomExpert = {
    ...current,
    name: patch.name !== undefined ? String(patch.name).slice(0, 60) : current.name,
    role: patch.role !== undefined ? String(patch.role).slice(0, 200) : current.role,
    prompt: patch.prompt !== undefined ? String(patch.prompt).slice(0, 4000) : current.prompt,
    icon: patch.icon !== undefined ? String(patch.icon).slice(0, 40) : current.icon,
    canWrite: patch.canWrite !== undefined ? patch.canWrite === true : current.canWrite,
  }
  customExperts = customExperts.map((e) => (e.id === id ? updated : e))
  void saveCustomExpertsToDisk().catch(() => undefined)
  return updated
}

export function deleteCustomExpert(id: string) {
  const before = customExperts.length
  customExperts = customExperts.filter((e) => e.id !== id)
  if (customExperts.length !== before) {
    void saveCustomExpertsToDisk().catch(() => undefined)
    return true
  }
  return false
}

// ============================================================================
// Plugin Entry Point
// ============================================================================
const AUTOMATIC_PROGRESS_SKIP_TOOLS = new Set(["goal-set", "goal-verify", "loop-set", "loop-status", "loop-pause", "loop-resume", "loop-cancel", "loop-queue", "team-dispatch", "team-dispatch-all", "team-cancel"])

function describeAutomaticProgressTool(input: { tool: string; args?: unknown }) {
  const args = input.args && typeof input.args === "object" ? input.args as Record<string, unknown> : undefined
  const target = args?.filePath ?? args?.path ?? args?.command ?? args?.memberID ?? args?.task
  return `${input.tool}${typeof target === "string" && target.trim() ? ` (${target.trim().slice(0, 160)})` : ""}`
}

async function recordAutomaticTaskProgress(input: { directory: string; sessionID: string; tool: string; args?: unknown }) {
  if (AUTOMATIC_PROGRESS_SKIP_TOOLS.has(input.tool)) return
  const event = describeAutomaticProgressTool(input)
  const writes: Promise<unknown>[] = []
  const goal = getGoal(input.sessionID)
  if (goal.active && goal.status === "in_progress") {
    writes.push(writeDeveAgentMemoryProgress({
      directory: input.directory,
      sessionID: input.sessionID,
      taskID: `goal-${input.sessionID}`,
      status: "in_progress",
      summary: `Goal step completed: ${event}. Goal: ${goal.description}`,
      nextAction: `Continue with the next smallest verifiable step. Criteria: ${goal.criteria.join("; ")}`,
      criteria: goal.criteria,
    }))
  }
  const loop = getLoop(input.sessionID)
  if (loop.active && (loop.status === "running" || loop.status === "paused")) {
    writes.push(writeDeveAgentMemoryProgress({
      directory: input.directory,
      sessionID: input.sessionID,
      taskID: `loop-${input.sessionID}`,
      status: "in_progress",
      summary: `Loop step completed: ${event}. Run ${loop.runCount}/${loop.maxRuns}. Task: ${loop.task}`,
      nextAction: `Continue the next bounded loop pass after the configured interval (${loop.intervalSeconds}s).`,
    }))
  }
  await Promise.all(writes.map((write) => write.catch(() => undefined)))
}

const deveagentPlugin: PluginModule = {
  id: "deveagent",
  server: async (input: PluginInput, options?: PluginOptions): Promise<Hooks> => {
    const workspaceDirectory = path.resolve(input.directory || process.cwd())
    pluginSdkClient = input.client
    const pluginClient = input.client
    startGoalWorker(input.client, workspaceDirectory)
    return {
      // --- config: register DeveAgent providers ---
      config: async (cfg) => {
        if (!cfg.provider) cfg.provider = {}
        for (const [key, def] of Object.entries(DEVEAGENT_PROVIDERS)) {
          const envVal = process.env[def.envKey]
          if (envVal && !cfg.provider[key]) {
            cfg.provider[key] = {
              name: def.name,
              api: def.baseUrl,
              options: { apiKey: envVal },
              models: { [def.defaultModel]: { name: def.defaultModel } },
            }
          }
        }
        // Snapshot the config-declared providers so checkRoleProfileModel can
        // still validate best-effort when the SDK provider list is unavailable
        // in packaged runtimes.
        const snapshot: Record<string, { models?: Record<string, unknown> }> = {}
        for (const [key, def] of Object.entries(cfg.provider ?? {})) {
          const models = (def as { models?: Record<string, unknown> }).models
          if (models && typeof models === "object") snapshot[key] = { models }
        }
        providerRegistrySnapshot = snapshot
      },

      // --- provider: expose DeveAgent models ---
      provider: {
        id: "deveagent",
        models: async (provider, ctx) => {
          const models: Record<string, any> = {}
          for (const [key, def] of Object.entries(DEVEAGENT_PROVIDERS)) {
            if (process.env[def.envKey]) {
              models[def.defaultModel] = {
                id: def.defaultModel,
                name: `${def.name} — ${def.defaultModel}`,
                context: 128000,
                capabilities: { vision: false, tools: true, streaming: true },
              }
            }
          }
          return models
        },
      },

      // --- chat.headers: inject cache tracking ---
      "chat.headers": async (input, output) => {
        output.headers = output.headers || {}
        metrics.totalRequests++
        metrics.lastSessionID = input.sessionID
        // Keep provider-side conversation/cache affinity stable for this OpenCode session.
        output.headers["x-session-affinity"] = input.sessionID
        output.headers["session-id"] = input.sessionID
      },

      // --- chat.params: Reasonix-style cache params ---
      "chat.params": async (input, output) => {
        output.options = output.options || {}
        output.options.stream_options = { include_usage: true }
      },

      // --- chat.tools: prefix-shape diagnostics (final system + sorted tools) ---
      "chat.tools": async (input, output) => {
        // Only conversation requests share a provider prefix cache. Utility
        // requests (title generation, compaction summaries) run with their own
        // system/tools and must not be attributed as conversation shape changes.
        if (input.agent === "title" || input.agent === "compaction" || input.agent === "summary") return
        const shape = computePrefixShape({ system: output.system, tools: output.tools })
        recordPrefixShape(input.sessionID, shape)
      },

      // --- experimental.chat.system.transform: byte-stable system prefix only ---
      // Dynamic state (mode/goal/team/skills/expert/memory) rides the user turn
      // as a synthetic part (buildDeveAgentTurnTail in chat.message) so state
      // transitions never cold-start DeepSeek's prefix cache. Deadline expiry
      // side effects still run here so worker-driven turns keep enforcing
      // goal/loop budgets exactly as before.
      "experimental.chat.system.transform": async (input, output) => {
        // Do not let the first prompt race persisted auxiliary/goal/team state.
        await waitForDeveAgentStartup()
        expireGoal(input.sessionID)
        expireLoop(input.sessionID)
        // Prepend the byte-stable prefix (idempotent). It comes FIRST so both
        // conversation turns ([STABLE, agent persona]) and the compaction
        // summarizer ([STABLE]) share position-0 bytes — prefix cache reuse.
        // Appending after the persona would lose summarizer alignment.
        if (!(output.system ?? []).some((entry) => entry === STABLE_SYSTEM_PREFIX)) {
          output.system = [STABLE_SYSTEM_PREFIX, ...(output.system ?? [])]
        }
      },

      // --- chat.message: MiMo Code memory injection on new message ---
      "chat.message": async (input, output) => {
        const text = (output.parts ?? [])
          .filter((part: any) => part?.type === "text" && typeof part.text === "string")
          .map((part: any) => part.text)
          .join("\n")
        if (runtimeState.selectedSkills.some((skill) => skill.id === "grill-me" && skill.enabled)) {
          // Start at the user's first Grilling prompt, not at a later confirmed decision.
          startGrilling({ sessionID: input.sessionID })
        }
        if (runtimeState.mode === "loop" && text.trim() && !getLoop(input.sessionID).active) {
          setLoop({ task: text, sessionID: input.sessionID, directory: workspaceDirectory })
        }
        // Persist a bounded task note. It is retrieval-only until a later turn needs it.
        try {
          if (text.length > 20) {
            void rememberDeveAgentMemory({
              directory: workspaceDirectory,
              sessionID: input.sessionID,
              kind: "task",
              title: text.slice(0, 80),
              summary: text,
            })
            void appendDeveAgentMemoryNote({ directory: workspaceDirectory, sessionID: input.sessionID, text })
          }
        } catch (e) { /* skip */ }

        // Turn-tail runtime state: a synthetic text part at the end of the user
        // message. Synthetic keeps it out of the rendered bubble while the model
        // still receives it; diff-only state emission keeps unchanged turns
        // byte-identical so DeepSeek's prefix cache is reused. A turn counter
        // forces periodic re-emission so a session rewind/undo that deleted the
        // previously emitted part can never blind the model for long.
        await waitForDeveAgentStartup()
        // parentID never changes for a session: cache the check so queued
        // worker/subagent bursts don't pay an in-process roundtrip per message.
        let isSubagent = subagentCheckCache.get(input.sessionID)
        if (isSubagent === undefined) {
          isSubagent = false
          try {
            const sessionGet = (pluginSdkClient as {
              session?: { get?: (options: unknown) => Promise<{ data?: { parentID?: unknown } }> }
            })?.session?.get
            if (sessionGet) {
              const info = await sessionGet({ path: { id: input.sessionID } })
              isSubagent = Boolean((info.data as { parentID?: unknown } | undefined)?.parentID)
            }
          } catch { /* unknown session -> treat as main */ }
          subagentCheckCache.set(input.sessionID, isSubagent)
          if (subagentCheckCache.size > 256) {
            const oldest = subagentCheckCache.keys().next().value
            if (oldest) subagentCheckCache.delete(oldest)
          }
        }
        const blocks = await buildDeveAgentTurnTail({
          sessionID: input.sessionID,
          text,
          workspaceDirectory,
          retrieveContext: !isSubagent,
        })
        const emitted: string[] = []
        const marker = turnTailStateBySession.get(input.sessionID)
        if (blocks.state) {
          if (!marker || marker.text !== blocks.state || marker.turns >= 6) {
            turnTailStateBySession.set(input.sessionID, { text: blocks.state, turns: 0 })
            emitted.push(blocks.state)
          }
        }
        const entry = turnTailStateBySession.get(input.sessionID)
        if (entry) entry.turns += 1
        if (turnTailStateBySession.size > 256) {
          const oldest = turnTailStateBySession.keys().next().value
          if (oldest) turnTailStateBySession.delete(oldest)
        }
        if (blocks.turn) emitted.push(blocks.turn)
        if (emitted.length > 0 && Array.isArray(output.parts)) {
          // The hook runs after core part resolution, so carry a schema-valid
          // part id plus the owning message/session ids for persistence. The
          // id must be SORTABLE (Identifier.ascending), not a random UUID:
          // stored parts are ordered by id, and a random prefix would place
          // the snapshot before the user's own parts.
          const nonce = input.sessionID.slice(-8)
          output.parts.push({
            id: Identifier.ascending("part"),
            messageID: input.messageID ?? (output.message as { id?: string } | undefined)?.id,
            sessionID: input.sessionID,
            type: "text",
            synthetic: true,
            text: `<deveagent-runtime-state ${nonce}>\n${emitted.join("\n\n")}\n(Only the most recent runtime-state block in this conversation is current.)\n</deveagent-runtime-state ${nonce}>`,
          } as any)
        }
      },

      // --- permission.ask: MiMo Code permission engine ---
      "permission.ask": async (input, output) => {
        const filePath = [
          (input as any).filepath,
          (input as any).path,
          ...(((input as any).patterns ?? []) as string[]),
        ].filter(Boolean).join("\n")
        const action = (input as any).action || (input as any).permission || ""
        const agent = (input as any).agent || ""

        // Block dangerous paths unconditionally
        if (isDangerousPermissionTarget(filePath)) {
          output.status = "deny"
          return
        }

        // Grilling is an explicit interview gate. Its decision export has its own visible edit permission.
        const grillingExport = (input as any).metadata?.source === "deveagent.grilling-export"
        if (isGrillingWriteBlocked(runtimeState, action) && !grillingExport) {
          output.status = "deny"
          return
        }

        // Read-only modes: deny file writes
        const readonly = READONLY_MODES.includes(agent) || runtimeState.mode === "ask" || runtimeState.mode === "plan"
        if (readonly) {
          if (action === "write" || action === "edit" || action === "delete" || action === "edit" || action === "bash" || action === "computer-use") {
            output.status = "deny"
            return
          }
        }

        if (runtimeState.permissionMode === "yolo" && await isWorkspaceExternalDirectoryPermission(input, workspaceDirectory)) {
          output.status = "ask"
          return
        }

        // Auto/Yolo are explicit user choices in the composer. Dangerous files above still deny.
        if (runtimeState.permissionMode === "auto" || runtimeState.permissionMode === "yolo") {
          output.status = "allow"
          return
        }

        output.status = "ask"
      },

      // --- tool.execute.before/after: real session-scoped tool tracing ---
      "tool.execute.before": async (input) => {
        const execution = resolveEffectiveToolExecution(runtimeState)
        if (execution === "sequential") {
          await sessionToolQueue.before(input.sessionID)
          sessionToolQueueCalls.add(input.callID)
        }
        metrics.lastSessionID = input.sessionID
        metrics.toolCalls.push({
          sessionID: input.sessionID,
          callID: input.callID,
          tool: input.tool,
          status: "running",
          startedAt: new Date().toISOString(),
        })
        if (metrics.toolCalls.length > 200) metrics.toolCalls.shift()
      },

      "tool.execute.after": async (input, output) => {
        metrics.lastSessionID = input.sessionID
        const call = [...metrics.toolCalls].reverse().find((item) => item.callID === input.callID)
        if (call) {
          call.status = input.status === "failed" ? "failed" : input.status === "cancelled" ? "cancelled" : "completed"
          call.completedAt = new Date().toISOString()
          call.durationMs = Math.max(0, Date.parse(call.completedAt) - Date.parse(call.startedAt))
        }
        if (sessionToolQueueCalls.delete(input.callID)) {
          sessionToolQueue.after(input.sessionID)
        }
        if (input.status !== "failed" && input.status !== "cancelled" && (input.tool === "write" || input.tool === "edit" || input.tool === "multiedit")) {
          metrics.checkpoints.push({
            at: new Date().toISOString(),
            tool: input.tool,
            summary: `${input.tool}: ${(input.args as any)?.filePath || "unknown file"}`,
          })
        }
        if (input.status !== "failed" && input.status !== "cancelled") {
          await recordAutomaticTaskProgress({ directory: workspaceDirectory, sessionID: input.sessionID, tool: input.tool, args: input.args })
        }
      },

      // --- experimental.chat.messages.transform: per-request char measurement ---
      // Pairs with the usage event below to anchor the token projection to the
      // provider's real tokens-per-char ratio instead of a fixed chars/4 guess.
      "experimental.chat.messages.transform": async (_input, output) => {
        let chars = 0
        for (const message of output.messages ?? []) {
          for (const part of message.parts ?? []) {
            if (part.type === "text" && typeof part.text === "string") chars += part.text.length
          }
        }
        recordRequestChars(chars)
      },

      // --- event: track cache metrics from LLM responses ---
      event: async (input) => {
        const evt = input.event as any
        if (evt?.type === "usage" || evt?.type === "llm.usage") {
          const usage = evt.properties || evt.payload || {}
          const hit = usage.prompt_cache_hit_tokens || usage.cacheHitTokens || 0
          const miss = usage.prompt_cache_miss_tokens || usage.cacheMissTokens || 0
          const prompt = usage.prompt_tokens || usage.promptTokens || 0
          const completion = usage.completion_tokens || usage.completionTokens || 0
          const model = usage.model || "unknown"

          if (prompt > 0) {
            metrics.totalCacheHitTokens += hit
            metrics.totalCacheMissTokens += miss
            metrics.totalPromptTokens += prompt
            metrics.totalCompletionTokens += completion
            metrics.totalCost += estimateDeveAgentCost(model, prompt, completion, hit, miss)
            metrics.rounds.push({
              promptTokens: prompt, completionTokens: completion,
              cacheHitTokens: hit, cacheHitRate: Math.round((hit / prompt) * 100),
              cost: estimateDeveAgentCost(model, prompt, completion, hit, miss),
            })
            recordProviderPromptTokens(prompt)
          }
        }
      },

      // --- tool: DeveAgent tools ---
      tool: {
        "browser-navigate": tool({
          description: "Navigate to a URL and read its text content. Fetches HTML and strips tags.",
          args: { url: tool.schema.string().describe("URL to navigate to") },
          execute: async (args, context) => {
            try {
              await assertBrowserNavigationUrl(args.url)
              await context.ask({
                permission: "webfetch",
                patterns: [args.url],
                always: ["*"],
                metadata: { url: args.url, source: "deveagent.browser-navigate" },
              })
              const hostRequest = (globalThis as any).__deveagent_host_request as ((action: string, payload?: unknown) => Promise<{ text: string }>) | undefined
              if (hostRequest) {
                try {
                  const result = await hostRequest("browser.navigate", { sessionID: context.sessionID, url: args.url })
                  return result.text
                } catch (error) {
                  return `Navigation failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`
                }
              }
              const res = await fetch(args.url, { signal: AbortSignal.timeout(10_000), redirect: "error" })
              const html = await res.text()
              const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
              return text.slice(0, 10_000)
            } catch (err: any) {
              return `Navigation failed: ${err.message?.slice(0, 300)}`
            }
          },
        }),
        "browser-interact": tool({
          description: "Interact with the current sandboxed browser. Prefer the numbered ref returned by browser-snapshot; CSS selectors remain available for compatibility.",
          args: {
            action: tool.schema.string().describe("click or type"),
            ref: tool.schema.optional(tool.schema.string()).describe("Preferred element ref returned by browser-snapshot (1-200)"),
            selector: tool.schema.optional(tool.schema.string()).describe("CSS selector (required for click/type)"),
            text: tool.schema.optional(tool.schema.string()).describe("Text for type action"),
            deltaY: tool.schema.optional(tool.schema.number()).describe("Scroll delta for scroll action (-1000 to 1000)"),
            timeoutMs: tool.schema.optional(tool.schema.number()).describe("Wait timeout for wait action (250-10000 ms)"),
          },
          execute: async (args, context) => {
            if (args.action !== "click" && args.action !== "type" && args.action !== "key" && args.action !== "scroll" && args.action !== "wait") return "Browser interaction failed: action must be click, type, key, scroll, or wait."
            const deltaY = args.deltaY === undefined ? undefined : Math.max(-1000, Math.min(1000, args.deltaY))
            const timeoutMs = args.timeoutMs === undefined ? undefined : Math.max(250, Math.min(10_000, args.timeoutMs))
            await context.ask({
              permission: "computer-use",
              patterns: [`browser.${args.action}`, args.ref || args.selector || args.text || ""],
              always: ["*"],
              metadata: { source: "deveagent.browser-interact", action: args.action, ref: args.ref, selector: args.selector },
            })
            const hostRequest = (globalThis as any).__deveagent_host_request as ((action: string, payload?: unknown) => Promise<unknown>) | undefined
            if (!hostRequest) return "Browser interaction unavailable outside the desktop host."
            try {
              return JSON.stringify(await hostRequest(`browser.${args.action}`, { sessionID: context.sessionID, ref: args.ref, selector: args.selector, text: args.text, deltaY, timeoutMs }))
            } catch (error) {
              return `Browser interaction failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`
            }
          },
        }),
        "browser-control": tool({
          description: "Control the current sandboxed browser session: go back or reload.",
          args: { action: tool.schema.enum(["back", "reload"]).describe("Browser session action") },
          execute: async (args, context) => {
            await context.ask({
              permission: "computer-use",
              patterns: [`browser.${args.action}`],
              always: ["*"],
              metadata: { source: "deveagent.browser-control", action: args.action },
            })
            const hostRequest = (globalThis as any).__deveagent_host_request as ((action: string, payload?: unknown) => Promise<unknown>) | undefined
            if (!hostRequest) return "Browser control unavailable outside the desktop host."
            try {
              return JSON.stringify(await hostRequest(`browser.${args.action}`, { sessionID: context.sessionID }))
            } catch (error) {
              return `Browser control failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`
            }
          },
        }),
        "browser-snapshot": tool({
          description: "Read the current sandboxed browser page and list visible interactive elements. Use data-deveagent-ref selectors from this snapshot with browser-interact.",
          args: {},
          execute: async (_args, context) => {
            await context.ask({
              permission: "computer-use",
              patterns: ["browser.snapshot"],
              always: ["*"],
              metadata: { source: "deveagent.browser-snapshot" },
            })
            const hostRequest = (globalThis as any).__deveagent_host_request as ((action: string, payload?: unknown) => Promise<unknown>) | undefined
            if (!hostRequest) return "Browser snapshot unavailable outside the desktop host."
            try {
              return JSON.stringify(await hostRequest("browser.snapshot", { sessionID: context.sessionID }))
            } catch (error) {
              return `Browser snapshot failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`
            }
          },
        }),
        "skill-suggest": tool({
          description: "Suggest relevant skills for a given task based on keyword matching.",
          args: { task: tool.schema.string().describe("Task description to match skills against") },
          execute: async (args) => JSON.stringify(suggestSkills(args.task), null, 2),
        }),
        "grilling-record-decision": tool({
          description: "Record a decision only after the user explicitly confirms it during an active Grilling Me interview. This is session-scoped and does not write workspace files.",
          args: {
            question: tool.schema.string().describe("The single decision question that was resolved"),
            answer: tool.schema.string().describe("The user's explicit confirmed answer"),
            recommendation: tool.schema.optional(tool.schema.string()).describe("The concise recommendation that was offered"),
          },
          execute: async (args, context) => {
            if (!runtimeState.selectedSkills.some((skill) => skill.id === "grill-me" && skill.enabled)) {
              return JSON.stringify({ recorded: false, error: "Grilling Me is not enabled for this interview." })
            }
            return JSON.stringify(recordGrillingDecision({ ...args, sessionID: context.sessionID }))
          },
        }),
        "grilling-status": tool({
          description: "Read confirmed decisions and real elapsed time for this session's active Grilling Me interview.",
          args: {},
          execute: async (_args, context) => JSON.stringify({ ...getGrillingStatus(context.sessionID), decisions: getGrillingDecisions(context.sessionID) }, null, 2),
        }),
        "grilling-complete": tool({
          description: "Mark the active Grilling Me interview complete after all unresolved decisions are confirmed and the user gives final confirmation. Does not write files.",
          args: {},
          execute: async (_args, context) => {
            if (!runtimeState.selectedSkills.some((skill) => skill.id === "grill-me" && skill.enabled)) {
              return JSON.stringify({ completed: false, error: "Grilling Me is not enabled for this interview." })
            }
            return JSON.stringify(completeGrilling({ sessionID: context.sessionID }), null, 2)
          },
        }),
        "grilling-export-decisions": tool({
          description: "Export explicitly confirmed decisions to a workspace Markdown file only when the user explicitly asks to save/export them. Requests normal edit permission before writing.",
          args: {
            filePath: tool.schema.optional(tool.schema.string()).describe("Workspace-relative Markdown path; defaults to .deveagent/grilling/<session>.md"),
          },
          execute: async (args, context) => {
            const target = args.filePath || `.deveagent/grilling/${(context.sessionID || "session").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80)}.md`
            const safe = safeFilePath(input.directory, target)
            if (!safe) return JSON.stringify({ exported: false, error: "Export path must stay inside the workspace." })
            await context.ask({
              permission: "edit",
              patterns: [safe.relative],
              always: ["*"],
              metadata: { source: "deveagent.grilling-export", path: safe.relative },
            })
            return JSON.stringify(await exportGrillingDecisions({ directory: input.directory, sessionID: context.sessionID, filePath: target }))
          },
        }),
        "cache-metrics": tool({
          description: "Get current session cache hit rate, token usage, and cost estimates.",
          args: {},
          execute: async () => JSON.stringify(getDeveAgentMetrics(), null, 2),
        }),
        "checkpoint-report": tool({
          description: "List all checkpoints created during this session (MiMo Code).",
          args: {},
          execute: async () => JSON.stringify(metrics.checkpoints, null, 2),
        }),
        "memory-search": tool({
          description: "Search persisted project memory, session checkpoints, notes, and task progress. Results are read-only and budgeted.",
          args: {
            query: tool.schema.string().describe("Words identifying a past decision, bug, task, or checkpoint"),
            scope: tool.schema.optional(tool.schema.enum(["workspace", "session", "task"])).describe("Optional memory scope filter"),
            kind: tool.schema.optional(tool.schema.enum(["task", "decision", "bug", "summary", "skill-candidate", "project", "checkpoint", "notes", "progress"])).describe("Optional memory kind filter"),
            limit: tool.schema.optional(tool.schema.number()).describe("Maximum results (1-20; default 6)"),
            tokenBudget: tool.schema.optional(tool.schema.number()).describe("Approximate context budget in tokens (128-8000; default 1200)"),
          },
          execute: async (args, context) => JSON.stringify(await queryDeveAgentMemory({
            directory: workspaceDirectory,
            sessionID: context.sessionID,
            query: args.query,
            scope: args.scope,
            kind: args.kind,
            limit: args.limit,
            tokenBudget: args.tokenBudget,
          }), null, 2),
        }),
        "memory-reconcile": tool({
          description: "Reconcile editable Markdown memory sources into the bounded workspace index. This is local and never calls a model.",
          args: {},
          execute: async () => JSON.stringify(await reconcileDeveAgentMemory(workspaceDirectory), null, 2),
        }),
        "memory-context": tool({
          description: "Rebuild a bounded local context from the active OpenCode session tail, relevant memory, and durable workspace decisions after compaction. Does not reconstruct the full provider transcript.",
          args: {
            query: tool.schema.optional(tool.schema.string()).describe("Optional task or topic used to rank relevant memory"),
            tokenBudget: tool.schema.optional(tool.schema.number()).describe("Approximate rebuilt context budget in tokens (256-8000; default 2000)"),
          },
          execute: async (args, context) => JSON.stringify(await rebuildDeveAgentMemoryContext({
            directory: workspaceDirectory,
            sessionID: context.sessionID,
            query: args.query,
            tokenBudget: args.tokenBudget,
            recentMessages: await readDeveAgentRecentSessionMessages({ client: input.client, sessionID: context.sessionID, directory: workspaceDirectory }),
          }), null, 2),
        }),
        "memory-consolidate": tool({
          description: "Merge reviewed durable memory entries into workspace .deveagent/memory/MEMORY.md. This is local and deterministic; it does not delete the JSON index or call another model.",
          args: {
            limit: tool.schema.optional(tool.schema.number()).describe("Maximum durable entries to write (1-40; default 24)"),
          },
          execute: async (args) => JSON.stringify(await consolidateDeveAgentMemory({ directory: workspaceDirectory, limit: args.limit }), null, 2),
        }),
        "codegraph-neighbors": tool({
          description: "Read direct persisted CodeGraph imports, reverse imports, calls, and callers for one workspace-relative source file. Refresh the CodeGraph index first when unavailable.",
          args: {
            filePath: tool.schema.string().describe("Workspace-relative source file path"),
            limit: tool.schema.optional(tool.schema.number()).describe("Maximum direct neighbors (1-200; default 40)"),
          },
          execute: async (args) => JSON.stringify(await getDeveAgentCodeGraphNeighbors({ directory: workspaceDirectory, ...args }), null, 2),
        }),
        "codegraph-context-pack": tool({
          description: "Build and activate a bounded, read-only CodeGraph context pack for this session. It indexes the workspace, selects task-relevant files when files are omitted, applies Token Saver, and returns the exact files and estimated budget.",
          args: {
            task: tool.schema.optional(tool.schema.string()).describe("Task or question used to rank relevant source files"),
            files: tool.schema.optional(tool.schema.array(tool.schema.string())).describe("Optional workspace-relative files to include explicitly"),
            maxFiles: tool.schema.optional(tool.schema.number()).describe("Maximum files to include (1-30; default 12)"),
          },
          execute: async (args, context) => {
            const maxFiles = Math.max(1, Math.min(args.maxFiles ?? 12, 30))
            const task = typeof args.task === "string" ? args.task.trim().slice(0, 500) : ""
            let files = (args.files ?? []).map((file) => ({ path: file, source: "codegraph:explicit" }))
            if (files.length === 0 && task) {
              const candidates = await scanWorkspaceSourceFiles(workspaceDirectory)
              files = rankFiles(candidates, task, maxFiles).map((item) => ({ path: item.path, source: "codegraph:ranked" }))
            }
            if (files.length === 0) {
              return JSON.stringify({ available: false, error: "Provide task or files so CodeGraph can build a focused context pack." }, null, 2)
            }
            await createDeveAgentCodeGraphIndex({ directory: workspaceDirectory, maxFiles: Math.max(maxFiles, 200) })
            const pack = await createDeveAgentContextPack({
              directory: workspaceDirectory,
              task: task || undefined,
              files,
              maxFiles,
            })
            setDeveAgentSessionContextPack(context.sessionID, pack)
            return JSON.stringify({ ...pack, runtimeInjected: pack.available, sessionID: context.sessionID }, null, 2)
          },
        }),
        "codegraph-review-scope": tool({
          description: "Create a bounded, read-only CodeGraph review scope for changed workspace files. It refreshes the index and returns symbols plus import/call-related files.",
          args: {
            changedFiles: tool.schema.array(tool.schema.string()).describe("Workspace-relative changed files to review"),
            maxRelated: tool.schema.optional(tool.schema.number()).describe("Maximum related files per changed file (1-20; default 5)"),
          },
          execute: async (args) => JSON.stringify(await createReviewScope({ directory: workspaceDirectory, ...args }), null, 2),
        }),

        "team-dispatch": tool({
          description: "Run one enabled team member as a real read-only OpenCode subagent and return its result.",
          args: {
            memberID: tool.schema.string().describe("The team member ID to dispatch to"),
            task: tool.schema.string().describe("The task to dispatch"),
          },
          execute: async (args, context) => {
            const activeTeam = getDeveAgentTeam(context.sessionID)
            if (!activeTeam.enabled) return JSON.stringify({ error: "MoA team mode is disabled for this session. Enable it before dispatch." })
            const startedAt = Date.now()
            const dispatch = dispatchTeamMember({ memberID: args.memberID, task: args.task }, activeTeam)
            if (!dispatch.member) return JSON.stringify({ error: "Unknown or disabled team member." })
            const member = dispatch.member
            if (!context.runTask) return JSON.stringify({ error: "Native TaskTool bridge is unavailable in this host." })
            const run = await beginTeamRun({
              sessionID: context.sessionID,
              directory: workspaceDirectory,
              task: args.task.slice(0, 500),
              runMode: "sequential",
              phase: member.role === "executor" ? "executor" : "advisors",
              resume: member.role === "executor" ? undefined : {
                task: args.task.slice(0, 4_000),
                memberIDs: [member.id],
              },
              startedAt,
              members: [{ id: member.id, name: member.name, attempts: 0 }],
              tokens: 0,
              cost: 0,
              budgetTokens: activeTeam.budgetTokens,
              budgetExceeded: false,
            })
            const outcome = await runTeamMember(
              { runTask: context.runTask, waitTask: context.waitTask },
              member,
              dispatch.systemPrompt,
              dispatch.task,
              member.role !== "executor",
              activeTeam.childTimeoutMs,
              (childSessionID, jobID, attempt) => recordTeamChildStart(run, member.id, childSessionID, jobID, attempt),
              undefined,
              teamChildOutputBudget(activeTeam, 0),
              activeTeam.maxRetries,
            )
            const usage = taskUsage(outcome.result)
            await completeTeamRun(run, {
              sessionID: context.sessionID,
              task: args.task.slice(0, 500),
              runMode: "sequential",
              startedAt,
              members: [{ id: member.id, name: member.name, attempts: outcome.attempts, childSessionID: teamChildSessionID(outcome.result), error: outcome.error, ...usage }],
              tokens: usage.tokens,
              cost: usage.cost,
              budgetTokens: activeTeam.budgetTokens,
              budgetExceeded: usage.tokens > activeTeam.budgetTokens,
            })
            return JSON.stringify({ member, ...outcome, run }, null, 2)
          },
        }),

        "team-list": tool({
          description: "List all enabled team members with their roles and models.",
          args: {},
          execute: async (_args, context) => JSON.stringify(getDeveAgentTeam(context.sessionID).members.filter(m => m.enabled).map(m => ({ id: m.id, name: m.name, role: m.role, model: `${m.providerID}/${m.modelID}` })), null, 2),
        }),
        "team-runs": tool({
          description: "List recent persisted team dispatch outcomes for this session, including attempts and failures.",
          args: {},
          execute: async (_args, context) => JSON.stringify(await Promise.all(teamRunRecords.filter(r => r.sessionID === context.sessionID).map(async (run) => ({
            ...run,
            resumable: run.status === "interrupted" && run.phase === "advisors" && !!run.resume,
            childReconciliation: await reconcileTeamRunChildren({ client: input.client, directory: workspaceDirectory, run }),
          }))), null, 2),
        }),

        "team-review-synthesis": tool({
          description: "Inspect or explicitly confirm a persisted Team synthesis. This only creates a bounded manual-recovery state; it never replays the Executor or writes files.",
          args: {
            runID: tool.schema.string().describe("Team parent run ID from team-runs"),
            action: tool.schema.enum(["inspect", "confirm", "reject"]).describe("Read the synthesis, explicitly approve a manual recovery state, or reject it"),
          },
          execute: async (args, context) => JSON.stringify(await reviewTeamSynthesisArtifacts({
            runID: args.runID,
            sessionID: context.sessionID,
            directory: workspaceDirectory,
            action: args.action,
          }), null, 2),
        }),

        "team-cancel": tool({
          description: "Cancel a running Team parent run, persist the interrupted state, and abort any known child sessions. A stale child completion cannot resurrect the run.",
          args: {
            runID: tool.schema.string().describe("Running parent Team run ID from team-runs"),
            reason: tool.schema.optional(tool.schema.string()).describe("Why the Team run was cancelled"),
          },
          execute: async (args, context) => JSON.stringify(await cancelTeamRun({
            runID: args.runID,
            sessionID: context.sessionID,
            directory: workspaceDirectory,
            client: input.client,
            reason: args.reason,
          }), null, 2),
        }),

        "team-resume-interrupted": tool({
          description: "Explicitly resume an interrupted read-only advisor plan or retry failed/unknown advisors from a failed Team run. It never repeats an Executor automatically.",
          args: {
            runID: tool.schema.string().describe("Interrupted team run ID from team-runs"),
            mode: tool.schema.optional(tool.schema.enum(["resume", "retry"])).describe("resume an interrupted run (default) or retry only failed/unknown advisors from a failed run"),
          },
          execute: async (args, context) => {
            const mode = args.mode === "retry" ? "retry" : "resume"
            const activeTeam = getDeveAgentTeam(context.sessionID)
            if (!activeTeam.enabled) return JSON.stringify({ error: "MoA team mode is disabled for this session. Enable it before resuming." })
            if (!context.runTask) return JSON.stringify({ error: "Native TaskTool bridge is unavailable in this host." })
            const prior = teamRunRecords.find((run) => run.id === args.runID && run.sessionID === context.sessionID)
            const expectedStatus = mode === "retry" ? "failed" : "interrupted"
            const safePhase = mode === "resume"
              ? prior?.phase === "advisors"
              : prior?.phase === "advisors" || prior?.phase === "completed"
            if (!prior || prior.status !== expectedStatus || !prior.resume || !safePhase) {
              return JSON.stringify({ error: mode === "retry" ? "This failed run has no safe read-only retry plan. Re-run the task manually." : "This interrupted run has no safe read-only resume plan. Re-run the task manually." })
            }
            const memberIDs = mode === "retry"
              ? prior.members.filter((member) => member.status === "failed" || member.status === "unknown" || !!member.error).map((member) => member.id)
              : prior.resume.memberIDs.filter((id) => prior.members.find((member) => member.id === id)?.status !== "completed")
            const members = memberIDs
              .map((id) => activeTeam.members.find((member) => member.id === id && member.enabled && member.role !== "executor"))
              .filter((member): member is DeveAgentTeamMember => !!member)
            if (members.length === 0) {
              return JSON.stringify({ error: mode === "retry" ? "No failed or unknown advisor is currently enabled. Reconfigure the team or re-run the task manually." : "No saved advisor is currently enabled. Reconfigure the team or re-run the task manually." })
            }
            const resume = { task: prior.resume.task, memberIDs: members.map((member) => member.id) }
            const startedAt = Date.now()
            const resumed = await beginTeamRun({
              sessionID: context.sessionID,
              directory: workspaceDirectory,
              task: prior.task,
              runMode: prior.runMode,
              resume,
              resumedFrom: prior.id,
              startedAt,
              members: members.map((member) => ({ id: member.id, name: member.name, attempts: 0 })),
              tokens: 0,
              cost: 0,
              budgetTokens: activeTeam.budgetTokens,
              budgetExceeded: false,
            })
            const runAdvisor = async (member: DeveAgentTeamMember, maxOutputTokens: number) => {
              const outcome = await runTeamMember(
                { runTask: context.runTask!, waitTask: context.waitTask },
                member,
                member.systemPrompt || EXPERT_PROMPTS[member.role] || "You are a read-only team advisor.",
                resume.task,
                true,
                activeTeam.childTimeoutMs,
                (childSessionID, jobID, attempt) => recordTeamChildStart(resumed, member.id, childSessionID, jobID, attempt),
                prior.members.find((item) => item.id === member.id)?.childSessionID,
                maxOutputTokens,
                activeTeam.maxRetries,
              )
              await recordTeamChildCompletion(resumed, member.id, outcome)
              return outcome
            }
            const results = prior.runMode === "parallel"
              ? await mapTeamWithParallelBudget(
                  members,
                  activeTeam,
                  async (member, maxOutputTokens) => ({ member, ...await runAdvisor(member, maxOutputTokens) }),
                  (member) => ({ member, attempts: 0, error: "Team token budget exhausted before parallel resume dispatch." }),
                )
              : await (async () => {
                  const sequential: { member: DeveAgentTeamMember; result?: unknown; error?: string; attempts: number }[] = []
                  for (const member of members) {
                    const spent = sequential.reduce((total, item) => total + taskUsage(item.result).tokens, 0)
                    if (spent >= activeTeam.budgetTokens) {
                      sequential.push({ member, attempts: 0, error: "Team token budget exhausted before resume dispatch." })
                      continue
                    }
                    sequential.push({ member, ...await runAdvisor(member, teamChildOutputBudget(activeTeam, spent)) })
                  }
                  return sequential
                })()
            const usage = results.map((item) => taskUsage(item.result))
            const tokens = usage.reduce((total, item) => total + item.tokens, 0)
            const cost = usage.reduce((total, item) => total + item.cost, 0)
            await completeTeamRun(resumed, {
              sessionID: context.sessionID,
              task: prior.task,
              runMode: prior.runMode,
              resume,
              resumedFrom: prior.id,
              startedAt,
              members: results.map(({ member, result, attempts, error }, index) => ({ id: member.id, name: member.name, attempts, childSessionID: teamChildSessionID(result), error, ...usage[index] })),
              tokens,
              cost,
              budgetTokens: activeTeam.budgetTokens,
              budgetExceeded: tokens > activeTeam.budgetTokens,
            })
            return JSON.stringify({ resumedFrom: prior.id, mode, results, run: resumed }, null, 2)
          },
        }),

        "team-synthesize": tool({
          description: "Run a real read-only synthesis subagent over completed team results.",
          args: {
            task: tool.schema.string().describe("The original task and required decision"),
            results: tool.schema.string().describe("The completed advisor results to synthesize"),
          },
          execute: async (args, context) => {
            const activeTeam = getDeveAgentTeam(context.sessionID)
            if (!activeTeam.enabled) return JSON.stringify({ error: "MoA team mode is disabled for this session. Enable it before synthesis." })
            if (!context.runTask) return JSON.stringify({ error: "Native TaskTool bridge is unavailable in this host." })
            const member = activeTeam.members.find((item) => item.enabled && (item.role === "verifier" || item.role === "reviewer"))
              || activeTeam.members.find((item) => item.enabled)
            if (!member) return JSON.stringify({ error: "No enabled synthesis member is configured." })
            const startedAt = Date.now()
            const prompt = `Synthesize the advisor reports below into one actionable, evidence-based decision. Do not modify files. Identify disagreements and unresolved risks.\n\nOriginal task:\n${args.task.slice(0, 4000)}\n\nAdvisor reports:\n${args.results.slice(0, 30_000)}`
            const run = await beginTeamRun({
              sessionID: context.sessionID,
              directory: workspaceDirectory,
              task: `synthesis: ${args.task.slice(0, 450)}`,
              runMode: "debate",
              phase: "synthesis",
              startedAt,
              members: [{ id: member.id, name: member.name, attempts: 0 }],
              tokens: 0,
              cost: 0,
              budgetTokens: activeTeam.budgetTokens,
              budgetExceeded: false,
            })
            const outcome = await runTeamMember(
              { runTask: context.runTask, waitTask: context.waitTask },
              member,
              member.systemPrompt || EXPERT_PROMPTS[member.role] || "You are the team synthesis reviewer.",
              prompt,
              true,
              activeTeam.childTimeoutMs,
                (childSessionID, jobID, attempt) => recordTeamChildStart(run, member.id, childSessionID, jobID, attempt),
                undefined,
                teamChildOutputBudget(activeTeam, 0),
                activeTeam.maxRetries,
            )
            const usage = taskUsage(outcome.result)
            await persistTeamSynthesisArtifacts({
              record: run,
              directory: workspaceDirectory,
              task: args.task,
              reports: args.results,
              synthesis: outcome.result,
            })
            await completeTeamRun(run, {
              sessionID: context.sessionID,
              task: `synthesis: ${args.task.slice(0, 450)}`,
              runMode: "debate",
              startedAt,
              members: [{ id: member.id, name: member.name, attempts: outcome.attempts, childSessionID: teamChildSessionID(outcome.result), error: outcome.error, ...usage }],
              tokens: usage.tokens,
              cost: usage.cost,
              budgetTokens: activeTeam.budgetTokens,
              budgetExceeded: usage.tokens > activeTeam.budgetTokens,
            })
            return JSON.stringify({ synthesis: outcome.result, error: outcome.error, run }, null, 2)
          },
        }),

        "team-dispatch-all": tool({
          description: "Run enabled advisors as real read-only OpenCode subagents, synthesize their evidence, then run the single configured Executor through OpenCode's native permission flow when present.",
          args: {
            task: tool.schema.string().describe("The task to dispatch to all members"),
          },
          execute: async (args, context) => {
            const activeTeam = getDeveAgentTeam(context.sessionID)
            if (!activeTeam.enabled) return JSON.stringify({ error: "MoA team mode is disabled for this session. Enable it before dispatch." })
            const startedAt = Date.now()
            const dispatch = dispatchTeamAll({ task: args.task }, activeTeam)
            if (!context.runTask) return JSON.stringify({ error: "Native TaskTool bridge is unavailable in this host." })
            const executor = dispatch.members.find((item) => item.member.role === "executor")
            const advisors = dispatch.members.filter((item) => item.member.id !== executor?.member.id)
            const runRecord = await beginTeamRun({
              sessionID: context.sessionID,
              directory: workspaceDirectory,
              task: args.task.slice(0, 500),
              runMode: dispatch.runMode,
              phase: "advisors",
              resume: dispatch.runMode === "debate" ? undefined : {
                task: args.task.slice(0, 4_000),
                memberIDs: advisors.map((item) => item.member.id),
              },
              startedAt,
              members: advisors.map((item) => ({ id: item.member.id, name: item.member.name, attempts: 0 })),
              tokens: 0,
              cost: 0,
              budgetTokens: activeTeam.budgetTokens,
              budgetExceeded: false,
            })
            const runAdvisor = async (item: (typeof advisors)[number], task: string, maxOutputTokens: number) => {
              const outcome = await runTeamMember(
                { runTask: context.runTask!, waitTask: context.waitTask },
                item.member,
                item.systemPrompt,
                task,
                true,
                activeTeam.childTimeoutMs,
                (childSessionID, jobID, attempt) => recordTeamChildStart(runRecord, item.member.id, childSessionID, jobID, attempt),
                undefined,
                maxOutputTokens,
                activeTeam.maxRetries,
              )
              await recordTeamChildCompletion(runRecord, item.member.id, outcome)
              return outcome
            }
            const results: { member: DeveAgentTeamMember; result?: unknown; error?: string; attempts: number }[] = []
            if (dispatch.runMode === "parallel") {
              results.push(
                ...await mapTeamWithParallelBudget(
                  advisors,
                  activeTeam,
                  async (item, maxOutputTokens) => ({
                    member: item.member,
                    ...await runAdvisor(item, args.task, maxOutputTokens),
                  }),
                  (item) => ({ member: item.member, attempts: 0, error: "Team token budget exhausted before parallel dispatch." }),
                ),
              )
            } else if (dispatch.runMode === "debate") {
              // Debate must be sequential: each advisor sees the previous round's evidence.
              for (let round = 1; round <= activeTeam.maxRounds; round++) {
                const transcript = results
                  .map((item) => `${item.member.name}: ${typeof item.result === "string" ? item.result : JSON.stringify(item.result ?? item.error ?? "unavailable")}`)
                  .join("\n\n")
                  .slice(-24_000)
                for (const item of advisors) {
                  const spent = results.reduce((total, result) => total + taskUsage(result.result).tokens, 0)
                  if (spent >= activeTeam.budgetTokens) {
                    results.push({ member: item.member, attempts: 0, error: "Team token budget exhausted before the next debate turn." })
                    continue
                  }
                  const task = round === 1
                    ? args.task
                    : `${args.task}\n\n## Debate round ${round}\nReview the reports below, identify disagreements, and return a revised evidence-based recommendation.\n\n${transcript}`
                  results.push({ member: item.member, ...await runAdvisor(item, task, teamChildOutputBudget(activeTeam, spent)) })
                }
              }
            } else {
              for (const item of advisors) {
                const spent = results.reduce((total, result) => total + taskUsage(result.result).tokens, 0)
                if (spent >= activeTeam.budgetTokens) {
                  results.push({ member: item.member, attempts: 0, error: "Team token budget exhausted before dispatch." })
                  continue
                }
                results.push({ member: item.member, ...await runAdvisor(item, args.task, teamChildOutputBudget(activeTeam, spent)) })
              }
            }
            const usage = results.map((item) => taskUsage(item.result))
            const totalTokens = usage.reduce((total, item) => total + item.tokens, 0)
            const totalCost = usage.reduce((total, item) => total + item.cost, 0)
            updateTeamRunProgress(runRecord, {
              sessionID: context.sessionID,
              task: args.task.slice(0, 500),
              runMode: dispatch.runMode,
              phase: "advisors",
              startedAt,
              members: results.map(({ member, result, attempts, error }, index) => ({ id: member.id, name: member.name, attempts, childSessionID: teamChildSessionID(result), error, ...usage[index] })),
              tokens: totalTokens,
              cost: totalCost,
              budgetTokens: activeTeam.budgetTokens,
              budgetExceeded: totalTokens > activeTeam.budgetTokens,
            })
            const synthesisMember = activeTeam.members.find((member) => member.enabled && (member.role === "verifier" || member.role === "reviewer"))
              || advisors[0]?.member
            let synthesis: unknown
            let synthesisRun: TeamRunRecord | undefined
            let synthesisTokens = 0
            let synthesisCost = 0
            if (synthesisMember && totalTokens < activeTeam.budgetTokens) {
              await checkpointTeamPhase(runRecord, "synthesis")
              const synthesisStartedAt = Date.now()
              const synthesisReports = results.map((item) => `${item.member.name}: ${typeof item.result === "string" ? item.result : JSON.stringify(item.result ?? item.error ?? "unavailable")}`).join("\n\n")
              const synthesisPrompt = `Synthesize these read-only advisor reports into one actionable decision. Do not modify files. Identify disagreements and unresolved risks.\n\nOriginal task:\n${args.task.slice(0, 4000)}\n\nReports:\n${synthesisReports.slice(0, 30_000)}`
              synthesisRun = await beginTeamRun({
                sessionID: context.sessionID,
                directory: workspaceDirectory,
                task: `synthesis: ${args.task.slice(0, 450)}`,
                runMode: "debate",
                phase: "synthesis",
                startedAt: synthesisStartedAt,
                members: [{ id: synthesisMember.id, name: synthesisMember.name, attempts: 0 }],
                tokens: 0,
                cost: 0,
                budgetTokens: activeTeam.budgetTokens,
                budgetExceeded: false,
              })
              const outcome = await runTeamMember(
                { runTask: context.runTask, waitTask: context.waitTask },
                synthesisMember,
                synthesisMember.systemPrompt || EXPERT_PROMPTS[synthesisMember.role] || "You are the team synthesis reviewer.",
                synthesisPrompt,
                true,
                activeTeam.childTimeoutMs,
                (childSessionID, jobID, attempt) => recordTeamChildStart(synthesisRun!, synthesisMember.id, childSessionID, jobID, attempt),
                undefined,
                teamChildOutputBudget(activeTeam, totalTokens),
                activeTeam.maxRetries,
              )
              synthesis = outcome.result
              const synthesisUsage = taskUsage(outcome.result)
              synthesisTokens = synthesisUsage.tokens
              synthesisCost = synthesisUsage.cost
              await persistTeamSynthesisArtifacts({
                record: runRecord,
                directory: workspaceDirectory,
                task: args.task,
                reports: synthesisReports,
                synthesis,
              })
              await completeTeamRun(synthesisRun, {
                sessionID: context.sessionID,
                task: `synthesis: ${args.task.slice(0, 450)}`,
                runMode: "debate",
                startedAt: synthesisStartedAt,
                members: [{ id: synthesisMember.id, name: synthesisMember.name, attempts: outcome.attempts, childSessionID: teamChildSessionID(outcome.result), error: outcome.error, ...synthesisUsage }],
                tokens: synthesisUsage.tokens,
                cost: synthesisUsage.cost,
                budgetTokens: activeTeam.budgetTokens,
                budgetExceeded: totalTokens + synthesisUsage.tokens > activeTeam.budgetTokens,
              })
            }
            let executorRun: TeamRunRecord | undefined
            let executorResult: unknown
            let executorTokens = 0
            let executorCost = 0
            if (executor && totalTokens + synthesisTokens < activeTeam.budgetTokens) {
              await checkpointTeamPhase(runRecord, "executor")
              const executorStartedAt = Date.now()
              const executorPrompt = `Implement the requested task using the advisor evidence below. You are the only write-capable team member. Follow OpenCode's native permission prompts, make only necessary workspace changes, and report files changed plus verification.\n\nOriginal task:\n${args.task.slice(0, 4000)}\n\nTeam synthesis:\n${typeof synthesis === "string" ? synthesis : JSON.stringify(synthesis ?? "No synthesis available")}`
              executorRun = await beginTeamRun({
                sessionID: context.sessionID,
                directory: workspaceDirectory,
                task: `executor: ${args.task.slice(0, 450)}`,
                runMode: dispatch.runMode,
                phase: "executor",
                startedAt: executorStartedAt,
                members: [{ id: executor.member.id, name: executor.member.name, attempts: 0 }],
                tokens: 0,
                cost: 0,
                budgetTokens: activeTeam.budgetTokens,
                budgetExceeded: false,
              })
              const outcome = await runTeamMember(
                { runTask: context.runTask, waitTask: context.waitTask },
                executor.member,
                executor.systemPrompt,
                executorPrompt,
                false,
                activeTeam.childTimeoutMs,
                (childSessionID, jobID, attempt) => recordTeamChildStart(executorRun!, executor.member.id, childSessionID, jobID, attempt),
                undefined,
                teamChildOutputBudget(activeTeam, totalTokens + synthesisTokens),
                activeTeam.maxRetries,
              )
              executorResult = outcome.result
              const executorUsage = taskUsage(outcome.result)
              executorTokens = executorUsage.tokens
              executorCost = executorUsage.cost
              await completeTeamRun(executorRun, {
                sessionID: context.sessionID,
                task: `executor: ${args.task.slice(0, 450)}`,
                runMode: dispatch.runMode,
                startedAt: executorStartedAt,
                members: [{ id: executor.member.id, name: executor.member.name, attempts: outcome.attempts, childSessionID: teamChildSessionID(outcome.result), error: outcome.error, ...executorUsage }],
                tokens: executorUsage.tokens,
                cost: executorUsage.cost,
                budgetTokens: activeTeam.budgetTokens,
                budgetExceeded: totalTokens + synthesisTokens + executorUsage.tokens > activeTeam.budgetTokens,
              })
            }
            const completedTokens = totalTokens + synthesisTokens + executorTokens
            const finalMembers: TeamRunInput["members"] = results.map(({ member, result, attempts, error }, index) => ({
              id: member.id,
              name: member.name,
              attempts,
              status: error ? "failed" : "completed",
              childSessionID: teamChildSessionID(result),
              error,
              ...usage[index],
            }))
            for (const phase of [synthesisRun, executorRun]) {
              for (const member of phase?.members ?? []) {
                const existing = finalMembers.find((item) => item.id === member.id)
                if (!existing) {
                  finalMembers.push({ ...member })
                  continue
                }
                existing.attempts += member.attempts
                existing.childSessionID = member.childSessionID ?? existing.childSessionID
                existing.error = member.error ?? existing.error
                existing.status = member.status === "failed" || member.error ? "failed" : member.status ?? existing.status
                existing.tokens = (existing.tokens ?? 0) + (member.tokens ?? 0)
                existing.cost = (existing.cost ?? 0) + (member.cost ?? 0)
              }
            }
            await completeTeamRun(runRecord, {
              sessionID: context.sessionID,
              task: args.task.slice(0, 500),
              runMode: dispatch.runMode,
              phase: "completed",
              resume: dispatch.runMode === "debate" ? undefined : {
                task: args.task.slice(0, 4_000),
                memberIDs: advisors.map((item) => item.member.id),
              },
              startedAt,
              members: finalMembers,
              tokens: completedTokens,
              cost: totalCost + synthesisCost + executorCost,
              budgetTokens: activeTeam.budgetTokens,
              budgetExceeded: completedTokens > activeTeam.budgetTokens,
            })
            await rememberDeveAgentMemory({
              directory: workspaceDirectory,
              sessionID: context.sessionID,
              kind: "decision",
              title: `Team dispatch completed: ${args.task.slice(0, 80)}`,
              summary: [
                `Task: ${args.task.slice(0, 500)}`,
                `Mode: ${dispatch.runMode}`,
                `Advisor results: ${results.length - results.filter((item) => item.error).length}/${results.length} succeeded`,
                `Budget: ${completedTokens}/${activeTeam.budgetTokens} tokens${completedTokens > activeTeam.budgetTokens ? " (exceeded)" : ""}`,
                `Synthesis: ${synthesisRun ? "recorded" : "not run"}`,
                `Executor: ${executorRun ? "recorded" : executor ? "not run" : "not configured"}`,
              ].join("\n"),
            })
            await writeDeveAgentMemoryProgress({
              directory: workspaceDirectory,
              sessionID: context.sessionID,
              taskID: runRecord.id,
              status: "completed",
              summary: `Team task completed: ${args.task.slice(0, 1_500)}`,
              nextAction: executorRun ? "Review the Executor result and verify the changed files." : "Review the advisor synthesis before making changes.",
            })
            return JSON.stringify({
              runMode: dispatch.runMode,
              debatePrompt: dispatch.debatePrompt,
              results,
              run: runRecord,
              synthesis,
              synthesisRun,
              executor: executor ? { member: executor.member, result: executorResult, run: executorRun } : undefined,
              executorBrief: executor
                ? "The configured Executor was dispatched after advisor synthesis through OpenCode's native TaskTool and permission flow. Treat failed advisors as unavailable."
                : "No Executor is configured; use the recorded synthesis as decision input. Treat failed advisors as unavailable.",
            }, null, 2)
          },
        }),

        "goal-set": tool({
          description: "Set an active goal with success criteria for autonomous execution.",
          args: {
            description: tool.schema.string().describe("Goal description"),
            criteria: tool.schema.array(tool.schema.string()).describe("Success criteria"),
            maxDurationMinutes: tool.schema.optional(tool.schema.number()).describe("Wall-clock budget in minutes (default 60, maximum 1440)"),
          },
          execute: async (args, context) => {
            const goal = setGoal({ ...args, sessionID: context.sessionID, directory: workspaceDirectory })
            await writeDeveAgentMemoryProgress({
              directory: workspaceDirectory,
              sessionID: context.sessionID,
              taskID: `goal-${context.sessionID}`,
              status: "in_progress",
              summary: `Goal started: ${goal.description}\nCriteria: ${goal.criteria.join("; ")}`,
              nextAction: "Work on the smallest verifiable step, then call goal-verify.",
              criteria: goal.criteria,
            })
            return JSON.stringify(goal, null, 2)
          },
        }),

        "goal-verify": tool({
          description: "Verify if the current goal is met.",
          args: {
            met: tool.schema.boolean().describe("Whether the goal is met"),
            reason: tool.schema.optional(tool.schema.string()).describe("Verification reason"),
          },
          execute: async (args, context) => {
            const result = verifyGoal({ ...args, sessionID: context.sessionID })
            if (result.active) {
              await writeDeveAgentMemoryProgress({
                directory: workspaceDirectory,
                sessionID: context.sessionID,
                taskID: `goal-${context.sessionID}`,
                status: result.status === "verified" ? "completed" : "in_progress",
                summary: `Goal ${result.status}: ${result.description}${args.reason ? `\nReason: ${args.reason}` : ""}`,
                nextAction: result.status === "verified" ? "Review the completed changes and evidence." : "Continue with the next smallest verifiable step.",
                criteria: result.criteria,
              })
            }
            if (args.met && result.active && result.status === "verified") {
              await rememberDeveAgentMemory({
                directory: workspaceDirectory,
                sessionID: context.sessionID,
                kind: "decision",
                title: `Goal verified: ${result.description}`,
                summary: [
                  `Goal: ${result.description}`,
                  args.reason ? `Verification: ${args.reason}` : "Verification: explicit goal-verify call",
                  result.criteria.length ? `Criteria: ${result.criteria.join("; ")}` : "Criteria: none recorded",
                ].join("\n"),
              })
            }
            return JSON.stringify(result, null, 2)
          },
        }),

        "goal-status": tool({
          description: "Get current goal status and criteria.",
          args: {},
          execute: async (_args, context) => JSON.stringify(getGoal(context.sessionID), null, 2),
        }),
        "goal-queue": tool({
          description: "List persisted in-progress goals waiting for the next session re-entry.",
          args: {},
          execute: async () => JSON.stringify(getGoalQueue(workspaceDirectory), null, 2),
        }),
        "goal-telemetry": tool({
          description: "Read-only counts of Goal re-entries by driver path (event-driven autocontinue vs worker poll), for honest runtime visibility.",
          args: {},
          execute: async () => JSON.stringify(goalTelemetrySnapshot(), null, 2),
        }),
        "goal-continue": tool({
          // ponytail: inject continuation message when model wants to stop but goal incomplete
          // model calls this tool instead of stopping; returns guidance to keep working
          description: "Call this when you want to stop but the goal is not yet verified. Returns a continuation instruction. Use only when goal is active and in_progress.",
          args: {},
          execute: async (_args, context) => {
            const goal = getGoal(context.sessionID)
            if (!goal.active) return JSON.stringify({ status: "no_goal", message: "No active goal. Use goal-set first." })
            if (goal.status === "verified") return JSON.stringify({ status: "done", message: "Goal already verified. No continuation needed." })
            return JSON.stringify({
              status: "continuing",
              message: `Goal "${goal.description}" still in progress (${goal.reentries}/${goal.maxReentries} continuations used). Criteria: ${goal.criteria.join("; ")}. Continue working without stopping. Call goal-verify when every criterion is met.`,
            })
          },
        }),

        "loop-set": tool({
          description: "Create or replace a persisted, bounded loop for the current session.",
          args: {
            task: tool.schema.string().describe("Task repeated by each scheduled run"),
            intervalSeconds: tool.schema.optional(tool.schema.number()).describe("Seconds between runs (5-86400, default 60)"),
            maxRuns: tool.schema.optional(tool.schema.number()).describe("Maximum successful scheduled runs (1-100, default 8)"),
            maxRetries: tool.schema.optional(tool.schema.number()).describe("Maximum consecutive provider retries (0-10, default 3)"),
            maxDurationMinutes: tool.schema.optional(tool.schema.number()).describe("Wall-clock budget in minutes (default 60, maximum 10080)"),
          },
          execute: async (args, context) => JSON.stringify(setLoop({ ...args, sessionID: context.sessionID, directory: workspaceDirectory }), null, 2),
        }),
        "loop-status": tool({
          description: "Get the persisted loop state for the current session.",
          args: {},
          execute: async (_args, context) => JSON.stringify(getLoop(context.sessionID), null, 2),
        }),
        "loop-pause": tool({
          description: "Pause the current session loop without deleting its progress.",
          args: {},
          execute: async (_args, context) => JSON.stringify(pauseLoop(context.sessionID), null, 2),
        }),
        "loop-resume": tool({
          description: "Resume a paused current-session loop using its configured interval.",
          args: {},
          execute: async (_args, context) => JSON.stringify(resumeLoop(context.sessionID), null, 2),
        }),
        "loop-cancel": tool({
          description: "Cancel and remove the current session loop.",
          args: {},
          execute: async (_args, context) => JSON.stringify(clearLoop(context.sessionID), null, 2),
        }),
        "loop-queue": tool({
          description: "List persisted active and paused loops.",
          args: {},
          execute: async () => JSON.stringify(getLoopQueue(), null, 2),
        }),

        "skill-install": tool({
          description: "Install a remote skill from a URL (downloads and persists to disk).",
          args: {
            url: tool.schema.string().describe("URL to the skill file"),
            id: tool.schema.optional(tool.schema.string()).describe("Skill ID (optional)"),
          },
          execute: async (args) => JSON.stringify(await installRemoteSkill({ url: args.url, id: args.id, directory: input.directory })),
        }),

        "skill-list-remote": tool({
          description: "List all installed remote skills (persisted on disk).",
          args: {},
          execute: async () => JSON.stringify(await loadRemoteSkills(input.directory)),
        }),

        "skill-remove": tool({
          description: "Remove an installed remote skill by ID.",
          args: { id: tool.schema.string().describe("Skill ID to remove") },
          execute: async (args) => JSON.stringify(await removeRemoteSkill(args.id)),
        }),

        "vision-analyze": tool({
          // Real image analysis: configured independent vision API first, then
          // Windows/macOS built-in OCR as offline fallback. The OpenCode
          // provider vision chain (prompt.ts routing) is unchanged.
          description: "Analyze an image with the configured vision provider. If no vision API is configured, or the API call fails (e.g. 403), it falls back to the OS built-in OCR (Windows.Media.Ocr / macOS Vision). The recognized text is returned to the conversation.",
          args: {
            imageUrl: tool.schema.string().describe("URL, data URL, or local file path of the image to analyze"),
            prompt: tool.schema.optional(tool.schema.string()).describe("Optional instruction for what to look for in the image"),
          },
          execute: async (args) => {
            const result = await runVisionChain(args.imageUrl, args.prompt || "Describe this image in detail.", path.resolve(input.directory || process.cwd()))
            return JSON.stringify(result)
          },
        }),

        "vision-test": tool({
          description: "Test the configured independent vision API connection and surface the real HTTP status/response body (e.g. 403 reasons like wrong key, wrong base URL, or disabled provider).",
          args: {},
          execute: async () => {
            const config = loadVisionConfig(path.resolve(input.directory || process.cwd()))
            if (!config) {
              return JSON.stringify({ ok: false, detail: "未配置独立视觉 API。请先运行 vision-config 工具或在工作区/全局配置文件中填写。" })
            }
            // Diagnostic probes record into a throwaway sink so they never
            // pollute the production telemetry counters the dashboard reads.
            const result = await testVisionConnection(config, path.resolve(input.directory || process.cwd()), newVisionTelemetry())
            return JSON.stringify(result)
          },
        }),

        "vision-config": tool({
          description: "Read or write the independent vision API configuration (provider, base URL, API key, model). Each capability (vision/STT/search) is configured separately, like Hermes-style auxiliary models.",
          args: {
            provider: tool.schema.optional(tool.schema.string()).describe("Provider preset id: mimo-token-plan | mimo | glm | ark | dashscope | moonshot | openai | ollama | windows-ocr"),
            baseUrl: tool.schema.optional(tool.schema.string()).describe("OpenAI-compatible base URL, e.g. https://token-plan-cn.xiaomimimo.com/v1"),
            apiKey: tool.schema.optional(tool.schema.string()).describe("API key for the vision provider"),
            model: tool.schema.optional(tool.schema.string()).describe("Vision model id, e.g. mimo-v2.5, glm-4.7v"),
            language: tool.schema.optional(tool.schema.string()).describe("OCR language hint for the OS fallback (e.g. zh-Hans-CN)"),
            clear: tool.schema.optional(tool.schema.boolean()).describe("Set true to remove the vision configuration"),
            workspace: tool.schema.optional(tool.schema.boolean()).describe("Set true to store in the workspace .deveagent/vision.json instead of the global config"),
          },
          execute: async (args) => {
            if (args.clear) {
              const r = clearVisionConfig(args.workspace ? path.resolve(input.directory || process.cwd()) : undefined)
              return JSON.stringify({ ...r, status: visionStatus(args.workspace ? path.resolve(input.directory || process.cwd()) : undefined) })
            }
            const existing = loadVisionConfig(args.workspace ? path.resolve(input.directory || process.cwd()) : undefined) ?? { provider: "openai", baseUrl: "", apiKey: "", model: "" }
            const next: DeveAgentVisionConfig = {
              provider: args.provider ?? existing.provider,
              baseUrl: args.baseUrl ?? existing.baseUrl,
              apiKey: args.apiKey ?? existing.apiKey,
              model: args.model ?? existing.model,
              language: args.language ?? existing.language,
            }
            const invalid = validateVisionConfig(next)
            if (invalid) return JSON.stringify({ ok: false, error: invalid })
            const { path: configPath } = saveVisionConfig(next, args.workspace ? path.resolve(input.directory || process.cwd()) : undefined)
            return JSON.stringify({ ok: true, path: configPath, status: visionStatus(args.workspace ? path.resolve(input.directory || process.cwd()) : undefined) })
          },
        }),

        "stt-test": tool({
          description: "Test the configured independent STT API configuration with a REAL network probe: uploads a tiny silent WAV to the /audio/transcriptions endpoint and reports the live HTTP status/body. Missing or invalid configuration short-circuits with a config-only reason.",
          args: {},
          execute: async () => {
            const config = loadSttConfig(path.resolve(input.directory || process.cwd()))
            if (!config) {
              return JSON.stringify({ ok: false, detail: "未配置独立 STT API。请先运行 stt-config 工具或在工作区/全局配置文件中填写。" })
            }
            const result = await testSttConnection(config, path.resolve(input.directory || process.cwd()))
            return JSON.stringify(result)
          },
        }),

        "stt-config": tool({
          description: "Read or write the independent speech-to-text (STT) API configuration (provider, base URL, API key, model). Each capability (vision/STT/search) is configured separately, like Hermes-style auxiliary models.",
          args: {
            provider: tool.schema.optional(tool.schema.string()).describe("Provider preset id: openai | moonshot | dashscope | custom | browser"),
            baseUrl: tool.schema.optional(tool.schema.string()).describe("OpenAI-compatible base URL, e.g. https://api.openai.com/v1"),
            apiKey: tool.schema.optional(tool.schema.string()).describe("API key for the STT provider"),
            model: tool.schema.optional(tool.schema.string()).describe("Transcription model id, e.g. whisper-1, moonshot-v1-audio-transcription"),
            language: tool.schema.optional(tool.schema.string()).describe("Optional language hint for the transcription model (e.g. zh, en)"),
            clear: tool.schema.optional(tool.schema.boolean()).describe("Set true to remove the STT configuration"),
            workspace: tool.schema.optional(tool.schema.boolean()).describe("Set true to store in the workspace .deveagent/stt.json instead of the global config"),
          },
          execute: async (args) => {
            if (args.clear) {
              const r = clearSttConfig(args.workspace ? path.resolve(input.directory || process.cwd()) : undefined)
              return JSON.stringify({ ...r, status: sttStatus(args.workspace ? path.resolve(input.directory || process.cwd()) : undefined) })
            }
            const existing = loadSttConfig(args.workspace ? path.resolve(input.directory || process.cwd()) : undefined) ?? { provider: "openai", baseUrl: "", apiKey: "", model: "" }
            const next: DeveAgentSttConfig = {
              provider: args.provider ?? existing.provider,
              baseUrl: args.baseUrl ?? existing.baseUrl,
              apiKey: args.apiKey ?? existing.apiKey,
              model: args.model ?? existing.model,
              language: args.language ?? existing.language,
            }
            const invalid = validateSttConfig(next)
            if (invalid) return JSON.stringify({ ok: false, error: invalid })
            const { path: configPath } = saveSttConfig(next, args.workspace ? path.resolve(input.directory || process.cwd()) : undefined)
            return JSON.stringify({ ok: true, path: configPath, status: sttStatus(args.workspace ? path.resolve(input.directory || process.cwd()) : undefined) })
          },
        }),

        "role-profile": tool({
          description: "Configure role->model routing. Each role (planner|coder|reviewer|verifier|vision) maps to an auxiliary model (providerID/modelID) that routes that role's prompts. Persisted globally.",
          args: {
            action: tool.schema.string().describe("get | set | clear | list"),
            role: tool.schema.optional(tool.schema.string()).describe("Role id, e.g. planner, coder, reviewer, verifier, vision"),
            providerID: tool.schema.optional(tool.schema.string()).describe("Provider id for the role's auxiliary model"),
            modelID: tool.schema.optional(tool.schema.string()).describe("Model id for the role's auxiliary model"),
          },
          execute: async (args) => {
            const action = args.action || "get"
            if (action === "list") {
              return JSON.stringify({ ok: true, profiles: listRoleProfiles() })
            }
            if (action === "clear") {
              if (!args.role) return JSON.stringify({ ok: false, error: "role is required for clear" })
              const result = clearRoleProfile(args.role)
              return JSON.stringify(result.ok ? { ok: true, profiles: listRoleProfiles() } : result)
            }
            if (action === "set") {
              if (!args.role) return JSON.stringify({ ok: false, error: "role is required for set" })
              const result = setRoleProfile(args.role, { providerID: args.providerID, modelID: args.modelID })
              if (!result.ok) return JSON.stringify(result)
              const warning = await checkRoleProfileModel(result.profile.providerID, result.profile.modelID)
              return JSON.stringify({
                ok: true,
                role: result.role,
                profile: result.profile,
                profiles: listRoleProfiles(),
                ...(warning ? { warning } : {}),
              })
            }
            // get
            if (!args.role) return JSON.stringify({ ok: false, error: "role is required for get" })
            const profile = getRoleProfile(args.role)
            return JSON.stringify(profile ? { ok: true, role: args.role, profile } : { ok: false, error: `no role profile configured for ${args.role}` })
          },
        }),


        "computer-use-shell": tool({
          description: "Run a bounded, read-only workspace inspection command after OpenCode permission approval. Shell scripts, writes, arbitrary executables, and paths outside the workspace are rejected.",
          args: {
            command: tool.schema.string().describe("Read-only command, such as git status --short or rg -n pattern src"),
            cwd: tool.schema.optional(tool.schema.string()).describe("Workspace-relative working directory (optional)"),
          },
          execute: async (args, context) => {
            const parsed = parseDeveAgentComputerUseShellCommand(args.command)
            if (!parsed.ok) return JSON.stringify({ ok: false, error: parsed.error })

            const root = await realpath(input.directory).catch(() => undefined)
            const requestedCwd = safeFilePath(input.directory, args.cwd || ".")
            if (!root || !requestedCwd) return JSON.stringify({ ok: false, error: "cwd must stay inside the workspace" })
            const workingDirectory = await realpath(requestedCwd.absolute).catch(() => undefined)
            if (!workingDirectory) return JSON.stringify({ ok: false, error: "cwd does not exist" })
            const relativeCwd = path.relative(root, workingDirectory) || "."
            if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) {
              return JSON.stringify({ ok: false, error: "cwd must stay inside the workspace" })
            }
            const argumentPathError = await validateComputerUseArgumentPaths(root, workingDirectory, parsed.command.args)
            if (argumentPathError) return JSON.stringify({ ok: false, error: argumentPathError })

            const executionArgs = [...parsed.command.args]
            const gitCommand = normalizeComputerUseExecutable(parsed.command.executable) === "git" ? executionArgs.find((argument) => !argument.startsWith("-")) : undefined
            if (gitCommand === "diff" || gitCommand === "show") executionArgs.splice(executionArgs.indexOf(gitCommand) + 1, 0, "--no-ext-diff", "--no-textconv")
            try {
              await context.ask({
                permission: "computer-use",
                patterns: ["computer-use-shell", parsed.command.executable, ...parsed.command.args].slice(0, 24),
                always: ["*"],
                metadata: {
                  source: "deveagent.computer-use-shell",
                  cwd: relativeCwd,
                  command: args.command.slice(0, COMPUTER_USE_SHELL_MAX_COMMAND),
                },
              })
              const result = await execFileAsync(parsed.command.executable, executionArgs, {
                cwd: workingDirectory,
                env: {
                  ...process.env,
                  GIT_CONFIG_NOSYSTEM: "1",
                  GIT_EXTERNAL_DIFF: "",
                  GIT_EDITOR: "true",
                  GIT_PAGER: "cat",
                  GIT_SEQUENCE_EDITOR: "true",
                  GIT_TERMINAL_PROMPT: "0",
                  GIT_OPTIONAL_LOCKS: "0",
                },
                shell: false,
                windowsHide: true,
                timeout: 15_000,
                maxBuffer: COMPUTER_USE_SHELL_MAX_OUTPUT,
              })
              return JSON.stringify({
                ok: true,
                cwd: relativeCwd,
                executable: parsed.command.executable,
                args: executionArgs,
                stdout: truncateComputerUseShellOutput(result.stdout),
                stderr: truncateComputerUseShellOutput(result.stderr),
              })
            } catch (error) {
              const details = error as { code?: string | number; killed?: boolean; signal?: string; stdout?: unknown; stderr?: unknown }
              return JSON.stringify({
                ok: false,
                cwd: relativeCwd,
                executable: parsed.command.executable,
                args: executionArgs,
                error: error instanceof Error ? error.message : String(error),
                code: details.code,
                killed: details.killed === true,
                signal: details.signal,
                stdout: truncateComputerUseShellOutput(details.stdout),
                stderr: truncateComputerUseShellOutput(details.stderr),
              })
            }
          },
        }),
        "markitdown-convert": tool({
          description: "Convert a supported workspace document to cached Markdown with Microsoft MarkItDown. Works in auto and manual modes; disabled when mode is off.",
          args: {
            filePath: tool.schema.string().describe("Workspace-relative or absolute path to the document"),
          },
          execute: async (args) => {
            const mode = (globalThis as any).__deveagent_markitdown_mode ?? "auto"
            if (mode === "off") {
              return JSON.stringify({ ok: false, error: "MarkItDown is disabled. Enable the MarkItDown skill or set mode to auto/manual." })
            }
            if (!isMarkItDownSupported(args.filePath)) {
              return JSON.stringify({ ok: false, error: `Unsupported document format: ${path.extname(args.filePath)}` })
            }
            try {
              return JSON.stringify({ ok: true, ...(await convertWithMarkItDown({ filePath: args.filePath, workspace: input.directory })) })
            } catch (error) {
              return JSON.stringify({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
                ...(error instanceof MarkItDownConversionError ? { failure: error.report } : {}),
              })
            }
          },
        }),
        "markitdown-status": tool({
          description: "Report whether the current OpenCode runtime can convert documents with Microsoft MarkItDown.",
          args: {},
          execute: async () => JSON.stringify(await getMarkItDownRuntimeStatus()),
        }),

        "computer-use-click": tool({
          description: "Click within the current DeveAgent desktop window after permission approval.",
          args: {
            x: tool.schema.number().describe("Content-area X coordinate"),
            y: tool.schema.number().describe("Content-area Y coordinate"),
          },
          execute: async (args, context) => {
            await context.ask({
              permission: "computer-use",
              patterns: ["desktop.click", `${args.x},${args.y}`],
              always: ["*"],
              metadata: { source: "deveagent.computer-use-click", x: args.x, y: args.y },
            })
            const hostRequest = (globalThis as any).__deveagent_host_request as ((action: string, payload?: unknown) => Promise<unknown>) | undefined
            if (!hostRequest) return "Desktop click unavailable outside the desktop host."
            try {
              return JSON.stringify(await hostRequest("desktop.click", { sessionID: context.sessionID, x: args.x, y: args.y }))
            } catch (error) {
              return `Desktop click failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`
            }
          },
        }),

        "computer-use-key": tool({
          description: "Send an allowlisted navigation key to the current DeveAgent desktop window after permission approval.",
          args: { key: tool.schema.string().describe("Enter, Escape, Tab, ArrowUp, ArrowDown, ArrowLeft, or ArrowRight") },
          execute: async (args, context) => {
            if (!COMPUTER_USE_KEYS.has(args.key)) return "Desktop key failed: key is not allowlisted."
            await context.ask({
              permission: "computer-use",
              patterns: ["desktop.key", args.key],
              always: ["*"],
              metadata: { source: "deveagent.computer-use-key", key: args.key },
            })
            const hostRequest = (globalThis as any).__deveagent_host_request as ((action: string, payload?: unknown) => Promise<unknown>) | undefined
            if (!hostRequest) return "Desktop key unavailable outside the desktop host."
            try {
              return JSON.stringify(await hostRequest("desktop.key", { sessionID: context.sessionID, key: args.key }))
            } catch (error) {
              return `Desktop key failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`
            }
          },
        }),
        "computer-use-scroll": tool({
          description: "Scroll the current DeveAgent desktop window at its bounded content center after permission approval.",
          args: { deltaY: tool.schema.number().describe("Scroll amount from -1000 to 1000") },
          execute: async (args, context) => {
            if (!Number.isFinite(args.deltaY) || args.deltaY === 0 || Math.abs(args.deltaY) > 1000) return "Desktop scroll failed: deltaY must be between -1000 and 1000."
            await context.ask({
              permission: "computer-use",
              patterns: ["desktop.scroll", String(args.deltaY)],
              always: ["*"],
              metadata: { source: "deveagent.computer-use-scroll", deltaY: args.deltaY },
            })
            const hostRequest = (globalThis as any).__deveagent_host_request as ((action: string, payload?: unknown) => Promise<unknown>) | undefined
            if (!hostRequest) return "Desktop scroll unavailable outside the desktop host."
            try {
              return JSON.stringify(await hostRequest("desktop.scroll", { sessionID: context.sessionID, deltaY: args.deltaY }))
            } catch (error) {
              return `Desktop scroll failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`
            }
          },
        }),

        "computer-use-screenshot": tool({
          description: "Take a permission-gated screenshot of the current desktop or active browser session.",
          args: { target: tool.schema.optional(tool.schema.enum(["desktop", "browser"])).describe("Capture target (default: desktop)") },
          execute: async (args, context) => {
            await context.ask({
              permission: "computer-use",
              patterns: ["screenshot"],
              always: ["*"],
              metadata: { source: "deveagent.computer-use-screenshot" },
            })
            const target = args.target === "browser" ? "browser.screenshot" : "desktop.screenshot"
            const hostRequest = (globalThis as any).__deveagent_host_request as ((action: string, payload?: unknown) => Promise<{ path: string }>) | undefined
            if (hostRequest) {
              try {
                const result = await hostRequest(target, { sessionID: context.sessionID })
                return `Screenshot saved to: ${result.path}`
              } catch (error) {
                return `Screenshot failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`
              }
            }
            return "Screenshot unavailable outside the permission-gated desktop host."
          },
        }),
      },

      // --- experimental.compaction.autocontinue: goal loop auto-continue ---
      "experimental.compaction.autocontinue": async (input, output) => {
        // ponytail: if goal is active and not verified, force auto-continue
        const goal = getGoal(input.sessionID)
        if (expireGoal(input.sessionID)) return
        if (goal.active && goal.status === "in_progress") {
          output.enabled = true
        }
      },

      "experimental.session.autocontinue": async (input, output) => {
        const goal = getGoal(input.sessionID)
        if (expireGoal(input.sessionID)) return
        if (!goal.active || goal.status !== "in_progress") return
        if (goalWorkerInflight.has(input.sessionID)) return
        if (goal.nextAttemptAt && goal.nextAttemptAt > Date.now()) return
        finishGoalAttempt(input.sessionID, "completed")
        if (!reserveGoalReentry(input.sessionID)) return
        goal.retryCount += 1
        goal.lastAttemptAt = Date.now()
        goal.nextAttemptAt = Date.now() + goalBackoffMs(goal.retryCount)
        // ponytail: event-driven path took over; the worker poll must not
        // duplicate-resume inside this backoff window.
        goal.lastEventDrivenAt = Date.now()
        goalTelemetry.eventDrivenReentries += 1
        goalTelemetry.lastPath = "event"
        goalTelemetry.lastAt = Date.now()
        void saveGoalsToDisk().catch(() => undefined)
        output.enabled = true
        const reminder = [
          "<system-reminder>",
          `Goal remains in progress (${goal.reentries}/${goal.maxReentries} automatic continuations).`,
          "Continue with the next smallest verifiable step. Stop and report a blocker, or call goal-verify when every criterion is met.",
          "</system-reminder>",
        ].join("\n")
        // This continuation bypasses chat.message, so re-emit the runtime state
        // here (diff-aware) or the resumed turn runs without goal/skills context.
        try {
          const blocks = await buildDeveAgentTurnTail({
            sessionID: input.sessionID,
            text: "",
            workspaceDirectory,
            retrieveContext: false,
          })
          const marker = turnTailStateBySession.get(input.sessionID)
          if (blocks.state && (!marker || marker.text !== blocks.state)) {
            turnTailStateBySession.set(input.sessionID, { text: blocks.state, turns: marker?.turns ?? 0 })
            const nonce = input.sessionID.slice(-8)
            output.text = `${reminder}\n\n<deveagent-runtime-state ${nonce}>\n${blocks.state}\n</deveagent-runtime-state ${nonce}>`
          } else {
            output.text = reminder
          }
        } catch {
          // State re-emission is best-effort; the reminder alone must not break.
          output.text = reminder
        }
      },

      "experimental.text.complete": async (event, output) => {
        await captureDeveAgentCompactionMemory({
          client: input.client,
          directory: workspaceDirectory,
          sessionID: event.sessionID,
          messageID: event.messageID,
          text: output.text,
        })
      },

      // --- experimental.session.compacting: MiMo Code checkpoint before compaction ---
      "experimental.session.compacting": async (input, output) => {
        // History is folded now, so the previously emitted runtime-state part
        // is gone: forget the marker so the next user turn re-emits it.
        resetTurnTailState(input.sessionID)
        output.context = output.context || []
        output.context.push(`[DeveAgent] ${metrics.checkpoints.length} checkpoints in this session.`)
        output.context.push(`[DeveAgent] Cache hit rate: ${metrics.totalPromptTokens > 0 ? Math.round((metrics.totalCacheHitTokens / metrics.totalPromptTokens) * 100) : 0}%`)
        try {
          // The compaction summarizer no longer sees the runtime state in its
          // system slot, so carry the current state into the summary input.
          const blocks = await buildDeveAgentTurnTail({
            sessionID: input.sessionID,
            text: "",
            workspaceDirectory,
            retrieveContext: false,
          })
          if (blocks.state) output.context.push(`[DeveAgent] Current runtime state:\n${blocks.state}`)
        } catch {
          // Compaction must stay available when state rendering is unavailable.
        }
        try {
          const rebuilt = await rebuildDeveAgentMemoryContext({
            directory: workspaceDirectory,
            sessionID: input.sessionID,
            tokenBudget: 1_200,
            recentMessages: await readDeveAgentRecentSessionMessages({ client: pluginClient, sessionID: input.sessionID, directory: workspaceDirectory }),
          })
          if (rebuilt.context) output.context.push(rebuilt.context)
        } catch {
          // ponytail: compaction must stay available when optional local memory is unreadable.
        }
      },

      dispose: async () => { stopGoalWorker(workspaceDirectory) },
    }
  },
}

export default deveagentPlugin

// ============================================================================
// Dashboard API helpers (exported for server-side endpoints)
// ============================================================================
export function getDeveAgentMetrics() {
  const hitRate = metrics.totalPromptTokens > 0
    ? Math.round((metrics.totalCacheHitTokens / metrics.totalPromptTokens) * 100)
    : 0
  return {
    totalRequests: metrics.totalRequests,
    sessionID: metrics.lastSessionID,
    totalCacheHitTokens: metrics.totalCacheHitTokens,
    totalCacheMissTokens: metrics.totalCacheMissTokens,
    totalPromptTokens: metrics.totalPromptTokens,
    totalCompletionTokens: metrics.totalCompletionTokens,
    totalCost: Math.round(metrics.totalCost * 1000000) / 1000000,
    overallCacheHitRate: hitRate,
    roundsCount: metrics.rounds.length,
    checkpointsCount: metrics.checkpoints.length,
    skillSuggestionCount: metrics.skillSuggestions.length,
    rounds: metrics.rounds,
    checkpoints: metrics.checkpoints,
    toolCalls: metrics.toolCalls,
  }
}

export function resetDeveAgentMetrics() {
  metrics = {
    totalRequests: 0, lastSessionID: undefined, totalCacheHitTokens: 0, totalCacheMissTokens: 0,
    totalPromptTokens: 0, totalCompletionTokens: 0, totalCost: 0,
    rounds: [], checkpoints: [], toolCalls: [], skillSuggestions: [],
  }
}

export function getDeveAgentState() {
  return runtimeState
}

export function setDeveAgentState(input: Partial<DeveAgentRuntimeState>) {
  const prevAux = runtimeState.auxiliary
  const prevRoleProfiles = runtimeState.roleProfiles
  runtimeState = normalizeDeveAgentState(input, runtimeState)
  syncDeveAgentRuntimeGlobals()
  // ponytail: persist only when auxiliary changed
  if (JSON.stringify(prevAux) !== JSON.stringify(runtimeState.auxiliary)) {
    void saveAuxiliaryToDisk(runtimeState.auxiliary).catch(() => undefined)
  }
  // ponytail: persist role profiles only when changed
  if (JSON.stringify(prevRoleProfiles) !== JSON.stringify(runtimeState.roleProfiles)) {
    void saveRoleProfilesToDisk(runtimeState.roleProfiles).catch(() => undefined)
  }
  const selectedExpert = runtimeState.selectedExpert

  const selectedExpertPrompt = selectedExpert ? getExpertPrompt(selectedExpert.id) : undefined
  if (selectedExpert?.id && selectedExpertPrompt) {
    ;(globalThis as any).__deveagent_expert_id = selectedExpert.id
    ;(globalThis as any).__deveagent_expert_prompt = selectedExpertPrompt
  }

  if (!selectedExpert) {
    delete (globalThis as any).__deveagent_expert_id
    delete (globalThis as any).__deveagent_expert_prompt
  }

  return runtimeState
}

// ponytail: role->model routing helpers; writes persist through setDeveAgentState
export function getRoleProfile(role: string): DeveAgentAuxiliaryModel | undefined {
  return runtimeState.roleProfiles[role]
}

export function setRoleProfile(role: string, input: unknown): { ok: true; role: string; profile: DeveAgentAuxiliaryModel } | { ok: false; error: string } {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(role)) return { ok: false, error: "role must match /^[a-z][a-z0-9-]{0,31}$/" }
  const profile = sanitizeRoleProfile(input)
  if (!profile) return { ok: false, error: "profile requires non-empty providerID and modelID" }
  // The registry is capped at ROLE_PROFILE_LIMIT entries (normalizeRoleProfiles
  // drops anything past it), so a new role must fail here instead of reporting
  // success for a profile that would never be stored.
  if (!(role in runtimeState.roleProfiles) && Object.keys(runtimeState.roleProfiles).length >= ROLE_PROFILE_LIMIT) {
    return { ok: false, error: `role profile limit reached (${ROLE_PROFILE_LIMIT}); clear a profile before adding another` }
  }
  setDeveAgentState({ roleProfiles: { ...runtimeState.roleProfiles, [role]: profile } })
  return { ok: true, role, profile }
}

export function clearRoleProfile(role: string): { ok: true } | { ok: false; error: string } {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(role)) return { ok: false, error: "role must match /^[a-z][a-z0-9-]{0,31}$/" }
  if (!(role in runtimeState.roleProfiles)) return { ok: true }
  const next = { ...runtimeState.roleProfiles }
  delete next[role]
  setDeveAgentState({ roleProfiles: next })
  return { ok: true }
}

export function listRoleProfiles(): Record<string, DeveAgentAuxiliaryModel> {
  return { ...runtimeState.roleProfiles }
}

// ponytail: best-effort existence check against the live provider list. The SDK
// provider list carries the models each provider resolved at startup
// (models.dev + config), so an unresolvable providerID/modelID surfaces here as
// a warning instead of silently failing later. Prompt-time routing stays the
// backstop: it warns again and falls back to the default model.
export async function checkRoleProfileModel(
  providerID: string,
  modelID: string,
  client?: unknown,
): Promise<string | undefined> {
  const api = (client ?? pluginSdkClient) as
    | { provider?: { list?: (options?: unknown) => Promise<unknown> } }
    | undefined
  const listProviders = api?.provider?.list
  if (listProviders) {
    try {
      const raw = await listProviders()
      // The v1 SDK client resolves to the parsed response body ({ all: [...] }),
      // while mocks and other wrappers may return { data: [...] } or a raw array.
      let providers: unknown[] | undefined
      if (Array.isArray(raw)) {
        providers = raw
      } else if (raw && typeof raw === "object") {
        const value = raw as { data?: unknown; all?: unknown[] }
        if (Array.isArray(value.data)) {
          providers = value.data
        } else {
          const dataAll = (value.data as { all?: unknown[] } | undefined)?.all
          providers = Array.isArray(dataAll) ? dataAll : Array.isArray(value.all) ? value.all : undefined
        }
      }
      if (providers) {
        const provider = providers.find(
          (item) => Boolean(item) && typeof item === "object" && (item as { id?: unknown }).id === providerID,
        )
        if (!provider) {
          return `provider "${providerID}" is not in the provider list; prompts for this role will fall back to the default model`
        }
        const models = (provider as { models?: Record<string, unknown> }).models
        if (!models || !(modelID in models)) {
          return `model "${providerID}/${modelID}" is not in the provider list; prompts for this role will fall back to the default model`
        }
        return
      }
    } catch {
      // Validation is best-effort: a provider-list outage must not block saving.
    }
  }
  // Fall back to the config-time snapshot: validate only providers the plugin
  // has actually seen; unknown providers stay best-effort silent.
  const snapshotProvider = providerRegistrySnapshot[providerID]
  if (!snapshotProvider) return
  if (!snapshotProvider.models || !(modelID in snapshotProvider.models)) {
    return `model "${providerID}/${modelID}" is not in the provider list; prompts for this role will fall back to the default model`
  }
  return
}

export function setDeveAgentExpert(id?: string, sessionID?: string) {
  const prompt = id ? getExpertPrompt(id) : undefined
  if (!id || !prompt) {
    if (sessionID) {
      expertBySession.delete(sessionID)
    } else {
      delete (globalThis as any).__deveagent_expert_id
      delete (globalThis as any).__deveagent_expert_prompt
    }
    runtimeState = { ...runtimeState, selectedExpert: undefined, expertTeam: [] }
    return { active: false }
  }
  if (sessionID) {
    expertBySession.set(sessionID, { id, prompt })
  } else {
    ;(globalThis as any).__deveagent_expert_id = id
    ;(globalThis as any).__deveagent_expert_prompt = prompt
  }
  const meta = listAllExperts().find((e) => e.id === id)
  const name = meta?.name ?? id
  const role = meta && !meta.builtin && meta.canWrite ? "custom advisor (write enabled)" : "read-only advisor"
  runtimeState = {
    ...runtimeState,
    selectedExpert: { id, name, role },
    expertTeam: [{ id, name, role }],
  }
  return { active: true, id }
}

// ============================================================================
// DeveAgent Team snapshot (v1)
// ============================================================================
// Stores the user's multi-agent team and its provider/model bindings. Native
// TaskTool dispatch, bounded retries, and persisted run ledgers consume this
// snapshot; it is configuration, not a second agent runtime.
type DeveAgentTeamRole =
  | "planner"
  | "executor"
  | "reviewer"
  | "researcher"
  | "critic"
  | "verifier"
  | "custom"

type DeveAgentTeamMember = {
  id: string
  name: string
  role: DeveAgentTeamRole
  providerID: string
  modelID: string
  systemPrompt?: string
  enabled: boolean
}

type DeveAgentTeamRunMode = "sequential" | "parallel" | "debate"

type DeveAgentTeamSnapshot = {
  enabled: boolean
  members: DeveAgentTeamMember[]
  runMode: DeveAgentTeamRunMode
  maxRounds: number
  budgetTokens: number
  childTimeoutMs: number
  childMaxOutputTokens: number
  maxRetries: number
}

let teamState: DeveAgentTeamSnapshot = {
  enabled: false,
  members: [],
  runMode: "sequential",
  maxRounds: 3,
  budgetTokens: 200_000,
  childTimeoutMs: 120_000,
  childMaxOutputTokens: 32_000,
  maxRetries: 1,
}

// ponytail: session overrides prevent one chat's MoA switch leaking into another.
const teamStateBySession = new Map<string, DeveAgentTeamSnapshot>()
const expertBySession = new Map<string, { id: string; prompt: string }>()
const TEAM_SESSION_STORE_LIMIT = 100

function cloneTeamState(value: DeveAgentTeamSnapshot): DeveAgentTeamSnapshot {
  return { ...value, members: value.members.map((member) => ({ ...member })) }
}

function teamStateStorePath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(base, "opencode", "deveagent-team.json")
}

function normalizeTeamSnapshot(value: unknown, fallback = teamState): DeveAgentTeamSnapshot | undefined {
  if (!value || typeof value !== "object") return
  const input = value as Partial<DeveAgentTeamSnapshot>
  if (!Array.isArray(input.members) || typeof input.enabled !== "boolean") return
  return {
    enabled: input.enabled,
    members: input.members.map(sanitizeTeamMember).filter((member): member is DeveAgentTeamMember => !!member),
    runMode: input.runMode === "parallel" || input.runMode === "debate" ? input.runMode : "sequential",
    maxRounds: typeof input.maxRounds === "number" ? Math.max(1, Math.min(10, Math.floor(input.maxRounds))) : fallback.maxRounds,
    budgetTokens: typeof input.budgetTokens === "number" ? Math.max(10_000, Math.floor(input.budgetTokens)) : fallback.budgetTokens,
    childTimeoutMs: typeof input.childTimeoutMs === "number" ? Math.max(10_000, Math.min(600_000, Math.floor(input.childTimeoutMs))) : fallback.childTimeoutMs,
    childMaxOutputTokens: typeof input.childMaxOutputTokens === "number" ? Math.max(1_000, Math.min(128_000, Math.floor(input.childMaxOutputTokens))) : fallback.childMaxOutputTokens,
    maxRetries: typeof input.maxRetries === "number" ? Math.max(0, Math.min(3, Math.floor(input.maxRetries))) : fallback.maxRetries,
  }
}

export function loadDeveAgentTeamState() {
  try {
    const value = JSON.parse(readFileSync(teamStateStorePath(), "utf8")) as { global?: unknown; sessions?: unknown } & Partial<DeveAgentTeamSnapshot>
    const global = normalizeTeamSnapshot(value.global ?? value)
    if (global) teamState = global
    teamStateBySession.clear()
    if (Array.isArray(value.sessions)) {
      for (const entry of value.sessions.slice(-TEAM_SESSION_STORE_LIMIT)) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !/^[a-zA-Z0-9._-]{1,160}$/.test(entry[0])) continue
        const snapshot = normalizeTeamSnapshot(entry[1], teamState)
        if (snapshot) teamStateBySession.set(entry[0], snapshot)
      }
    }
  } catch {
    // ponytail: missing/corrupt local team config falls back to safe defaults
  }
}

// Team state persistence: serialized chain so concurrent setDeveAgentTeam
// saves (fire-and-forget) cannot interleave; flush barrier lets tests and
// shutdown paths observe the newest snapshot deterministically.
let teamStateWrite = Promise.resolve()
async function saveTeamStateToDisk() {
  const file = teamStateStorePath()
  teamStateWrite = teamStateWrite
    .catch(() => undefined)
    .then(() => atomicWriteFile(file, JSON.stringify({
      version: 2,
      global: teamState,
      sessions: [...teamStateBySession.entries()].slice(-TEAM_SESSION_STORE_LIMIT),
    })))
  await teamStateWrite
}

/** Durability barrier for team-state writes (mirrors waitForGoalStoreFlush). */
export async function waitForTeamStateFlush() {
  await teamStateWrite.catch(() => undefined)
}

loadDeveAgentTeamState()

type TeamResumePlan = {
  task: string
  memberIDs: string[]
}

type TeamRunPhase = "advisors" | "synthesis" | "executor" | "completed"
type TeamPhaseKind = Exclude<TeamRunPhase, "completed">
type TeamPhaseStatus = "queued" | "running" | "completed" | "failed" | "interrupted"
type TeamArtifactKind = "synthesis-input" | "synthesis-output"
type TeamArtifactRef = {
  kind: TeamArtifactKind
  path: string
  bytes: number
  createdAt: number
}

type TeamSynthesisReviewStatus = "pending" | "confirmed" | "rejected" | "expired"
type TeamExecutorRecoveryStatus = "blocked" | "ready-for-manual-recovery"
type TeamSynthesisReview = {
  status: TeamSynthesisReviewStatus
  recoveryStatus: TeamExecutorRecoveryStatus
  reviewedAt?: number
  artifactCreatedAt?: number
  summary: string
  reason?: string
}

type TeamPhaseRecord = {
  id: string
  runID: string
  sessionID: string
  directory?: string
  kind: TeamPhaseKind
  status: TeamPhaseStatus
  attempt: number
  availableAt: number
  startedAt?: number
  finishedAt?: number
  lease?: { owner: string; token: string; expiresAt: number }
  updatedAt?: number
  error?: string
}

type TeamRunRecord = {
  id: string
  sessionID: string
  task: string
  runMode: DeveAgentTeamRunMode
  startedAt: number
  finishedAt?: number
  phase?: TeamRunPhase
  directory?: string
  currentPhaseID?: string
  currentPhaseLeaseToken?: string
  parentRunID?: string
  // A native foreground TaskTool cannot survive an application restart. Keep
  // that fact in the ledger instead of silently presenting a partial run as done.
  status: "running" | "completed" | "failed" | "interrupted"
  stopReason?: string
  // Only read-only advisor plans are resumable. Native TaskTool child work is
  // never assumed to have survived a process restart.
  resume?: TeamResumePlan
  resumedFrom?: string
  artifacts?: TeamArtifactRef[]
  synthesisReview?: TeamSynthesisReview
  members: {
    id: string
    name: string
    attempts: number
    status?: "pending" | "running" | "completed" | "failed" | "unknown"
    jobID?: string
    childSessionID?: string
    startedAt?: number
    finishedAt?: number
    error?: string
    tokens?: number
    cost?: number
    input?: number
    output?: number
    reasoning?: number
    cacheRead?: number
    cacheWrite?: number
  }[]
  tokens: number
  cost: number
  budgetTokens: number
  budgetExceeded: boolean
  updatedAt?: number
}

const teamRunRecords: TeamRunRecord[] = []
const teamPhaseRecords: TeamPhaseRecord[] = []
type TeamRunInput = Omit<TeamRunRecord, "id" | "status" | "finishedAt">
let teamRunStoreWrite = Promise.resolve()
const TEAM_PHASE_LEASE_MS = 15 * 60 * 1_000
const TEAM_PHASE_HEARTBEAT_MS = 5 * 60 * 1_000
const teamPhaseOwner = `pid-${process.pid}`
const TEAM_RUN_LOCK_WAIT_MS = 10_000
const TEAM_RUN_LOCK_STALE_MS = 60_000
const teamPhaseHeartbeats = new Map<string, ReturnType<typeof setInterval>>()

function teamRunStorePath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(base, "opencode", "deveagent-team-runs.json")
}

function teamRunStoreLockPath() {
  return `${teamRunStorePath()}.lock`
}

async function withTeamRunStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = teamRunStoreLockPath()
  await mkdir(path.dirname(lockPath), { recursive: true })
  const deadline = Date.now() + TEAM_RUN_LOCK_WAIT_MS
  let handle: Awaited<ReturnType<typeof open>> | undefined
  while (!handle) {
    try {
      handle = await open(lockPath, "wx")
      await handle.writeFile(JSON.stringify({ owner: teamPhaseOwner, createdAt: Date.now() }), "utf8")
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined)
        handle = undefined
        await unlink(lockPath).catch(() => undefined)
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const existing = await stat(lockPath).catch(() => undefined)
      if (existing && Date.now() - existing.mtimeMs > TEAM_RUN_LOCK_STALE_MS) {
        await unlink(lockPath).catch(() => undefined)
      }
      if (Date.now() >= deadline) throw new Error("Team run store lock timed out")
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  try {
    return await fn()
  } finally {
    await handle.close().catch(() => undefined)
    await unlink(lockPath).catch(() => undefined)
  }
}

async function readTeamRunStoreSnapshot(): Promise<{ runs: unknown[]; phases: unknown[] }> {
  try {
    const data = JSON.parse(await readFile(teamRunStorePath(), "utf8")) as { runs?: unknown; phases?: unknown }
    return {
      runs: Array.isArray(data.runs) ? data.runs : [],
      phases: Array.isArray(data.phases) ? data.phases : [],
    }
  } catch {
    return { runs: [], phases: [] }
  }
}

function storeRecordTimestamp(value: unknown) {
  if (!value || typeof value !== "object") return 0
  const raw = value as Record<string, unknown>
  const timestamps: unknown[] = [raw.updatedAt, raw.finishedAt, raw.startedAt]
  return timestamps.reduce<number>((latest, timestamp) => typeof timestamp === "number" && Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest, 0)
}

function mergeTeamStoreRecords(local: unknown[], persisted: unknown[], limit: number) {
  const merged = new Map<string, Record<string, unknown>>()
  for (const candidate of [...persisted, ...local]) {
    if (!candidate || typeof candidate !== "object") continue
    const value = candidate as Record<string, unknown>
    if (typeof value.id !== "string") continue
    const previous = merged.get(value.id)
    if (!previous || storeRecordTimestamp(value) >= storeRecordTimestamp(previous)) merged.set(value.id, value)
  }
  return [...merged.values()].sort((left, right) => storeRecordTimestamp(right) - storeRecordTimestamp(left)).slice(0, limit)
}

async function writeTeamRunsSnapshotUnlocked() {
  const file = teamRunStorePath()
  const persisted = await readTeamRunStoreSnapshot()
  const content = JSON.stringify({
    version: 3,
    runs: mergeTeamStoreRecords(teamRunRecords, persisted.runs, 100),
    phases: mergeTeamStoreRecords(teamPhaseRecords, persisted.phases, 300),
  })
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tmp, content, "utf8")
  try {
    await rename(tmp, file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "EPERM" && code !== "EEXIST") throw error
    // Windows cannot atomically replace an existing file with rename.
    await writeFile(file, content, "utf8")
    await unlink(tmp).catch(() => undefined)
  }
}

async function saveTeamRunsToDisk() {
  // Serialize completion/checkpoint snapshots. Unique temp files prevent
  // partial JSON, while this queue prevents an older in-memory snapshot from
  // winning the final rename after a newer child checkpoint.
  const targetStore = teamRunStorePath()
  teamRunStoreWrite = teamRunStoreWrite.catch(() => undefined).then(async () => {
    // The process normally has one stable config root. Tests and embedded
    // hosts can switch workspaces while a prior async save is queued; never
    // replay that old write into the new store.
    if (teamRunStorePath() !== targetStore) return
    await withTeamRunStoreLock(writeTeamRunsSnapshotUnlocked)
  })
  await teamRunStoreWrite
}

function normalizeTeamResumePlan(value: unknown): TeamResumePlan | undefined {
  if (!value || typeof value !== "object") return
  const raw = value as { task?: unknown; memberIDs?: unknown }
  const task = typeof raw.task === "string" ? raw.task.trim().slice(0, 4_000) : ""
  const memberIDs = Array.isArray(raw.memberIDs)
    ? [...new Set(raw.memberIDs.filter((id): id is string => typeof id === "string" && /^[a-zA-Z0-9._-]{1,80}$/.test(id)))].slice(0, 12)
    : []
  return task && memberIDs.length > 0 ? { task, memberIDs } : undefined
}

function normalizeTeamArtifacts(value: unknown): TeamArtifactRef[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): TeamArtifactRef[] => {
    if (!item || typeof item !== "object") return []
    const raw = item as Record<string, unknown>
    const kind = raw.kind === "synthesis-input" || raw.kind === "synthesis-output" ? raw.kind : undefined
    const artifactPath = typeof raw.path === "string" && raw.path.length <= 240 ? raw.path : undefined
    const bytes = typeof raw.bytes === "number" && Number.isFinite(raw.bytes) ? Math.max(0, Math.min(40_000, Math.floor(raw.bytes))) : undefined
    const createdAt = typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : undefined
    return kind && artifactPath && bytes !== undefined && createdAt !== undefined
      ? [{ kind, path: artifactPath, bytes, createdAt }]
      : []
  }).slice(0, 4)
}

const TEAM_SYNTHESIS_REVIEW_MAX_AGE_MS = 24 * 60 * 60 * 1_000
const TEAM_SYNTHESIS_REVIEW_MAX_PREVIEW = 4_000

function normalizeTeamSynthesisReview(value: unknown): TeamSynthesisReview | undefined {
  if (!value || typeof value !== "object") return
  const raw = value as Record<string, unknown>
  const status = raw.status === "pending" || raw.status === "confirmed" || raw.status === "rejected" || raw.status === "expired"
    ? raw.status
    : undefined
  const recoveryStatus = raw.recoveryStatus === "blocked" || raw.recoveryStatus === "ready-for-manual-recovery"
    ? raw.recoveryStatus
    : undefined
  if (!status || !recoveryStatus) return
  return {
    status,
    recoveryStatus,
    reviewedAt: typeof raw.reviewedAt === "number" && Number.isFinite(raw.reviewedAt) ? raw.reviewedAt : undefined,
    artifactCreatedAt: typeof raw.artifactCreatedAt === "number" && Number.isFinite(raw.artifactCreatedAt) ? raw.artifactCreatedAt : undefined,
    summary: typeof raw.summary === "string" ? raw.summary.slice(0, TEAM_SYNTHESIS_REVIEW_MAX_PREVIEW) : "",
    reason: typeof raw.reason === "string" ? raw.reason.slice(0, 300) : undefined,
  }
}

function teamSynthesisArtifactPath(runID: string, kind: TeamArtifactKind) {
  return `.deveagent/team-runs/${runID}/${kind}.md`
}

async function readTeamSynthesisArtifact(input: {
  directory?: string
  runID: string
  artifact: TeamArtifactRef
}) {
  const expectedPath = path.normalize(teamSynthesisArtifactPath(input.runID, input.artifact.kind))
  if (!input.directory?.trim() || path.normalize(input.artifact.path) !== expectedPath) {
    return { error: "The persisted synthesis artifact path is invalid for this Team run." }
  }
  const safe = safeFilePath(input.directory, input.artifact.path)
  if (!safe) return { error: "The synthesis artifact must stay inside the workspace." }
  const root = await realpath(input.directory).catch(() => undefined)
  const actual = await realpath(safe.absolute).catch(() => undefined)
  if (!root || !actual) return { error: "The persisted synthesis artifact is missing." }
  const relative = path.relative(root, actual)
  if (relative.startsWith("..") || path.isAbsolute(relative)) return { error: "The synthesis artifact resolved outside the workspace." }
  const details = await stat(actual).catch(() => undefined)
  if (!details?.isFile() || details.size > 40_000) return { error: "The synthesis artifact is missing or exceeds the bounded review size." }
  const content = await readFile(actual, "utf8").catch(() => undefined)
  if (content === undefined) return { error: "The synthesis artifact could not be read." }
  return {
    path: safe.relative,
    bytes: Buffer.byteLength(content, "utf8"),
    content: content.slice(0, TEAM_SYNTHESIS_REVIEW_MAX_PREVIEW),
  }
}

function teamSynthesisRecoverySummary(input: {
  run: TeamRunRecord
  output: string
  inputBytes: number
  outputBytes: number
}) {
  return [
    `Task: ${input.run.task.slice(0, 500)}`,
    `Artifacts: synthesis-input ${input.inputBytes} bytes; synthesis-output ${input.outputBytes} bytes.`,
    "The synthesis was reviewed as bounded evidence only. Executor writes were not replayed.",
    "Next action: a user must start a separate, explicit Executor run after reviewing the workspace diff and permissions.",
    "Synthesis output preview:",
    input.output.slice(0, TEAM_SYNTHESIS_REVIEW_MAX_PREVIEW),
  ].join("\n")
}

export async function reviewTeamSynthesisArtifacts(input: {
  runID: string
  sessionID: string
  directory?: string
  action: "inspect" | "confirm" | "reject"
  now?: number
}) {
  const run = teamRunRecords.find((item) => item.id === input.runID && item.sessionID === input.sessionID)
  if (!run) return { reviewed: false as const, error: "Team run not found for this session." }
  if (run.directory && input.directory && path.resolve(run.directory) !== path.resolve(input.directory)) {
    return { reviewed: false as const, error: "The Team run belongs to a different workspace." }
  }
  const artifacts = run.artifacts ?? []
  const source = artifacts.find((item) => item.kind === "synthesis-input")
  const output = artifacts.find((item) => item.kind === "synthesis-output")
  if (!source || !output) return { reviewed: false as const, error: "This Team run has no complete persisted synthesis artifacts." }

  const now = input.now ?? Date.now()
  const current = normalizeTeamSynthesisReview(run.synthesisReview) ?? {
    status: "pending" as const,
    recoveryStatus: "blocked" as const,
    summary: "",
  }
  if (current.status === "confirmed") {
    if (input.action !== "confirm") {
      return { reviewed: false as const, status: current.status, error: "This synthesis review is already confirmed and cannot be changed." }
    }
    return {
      reviewed: true as const,
      action: input.action,
      status: current.status,
      recoveryStatus: current.recoveryStatus,
      idempotent: input.action === "confirm",
      automaticExecutorReplay: false,
      summary: current.summary,
      reason: current.reason,
    }
  }
  if (current.status === "rejected" && input.action !== "inspect") {
    return { reviewed: false as const, status: current.status, error: "This synthesis review was rejected; create a new synthesis before confirming it." }
  }

  const [inputArtifact, outputArtifact] = await Promise.all([
    readTeamSynthesisArtifact({ directory: input.directory, runID: run.id, artifact: source }),
    readTeamSynthesisArtifact({ directory: input.directory, runID: run.id, artifact: output }),
  ])
  if ("error" in inputArtifact || "error" in outputArtifact) {
    const reason = "error" in inputArtifact ? inputArtifact.error : outputArtifact.error
    run.synthesisReview = { status: "expired", recoveryStatus: "blocked", reviewedAt: now, summary: "", reason }
    run.updatedAt = now
    await saveTeamRunsToDisk().catch(() => undefined)
    return { reviewed: false as const, status: "expired" as const, automaticExecutorReplay: false, error: reason }
  }
  const newestArtifact = Math.max(source.createdAt, output.createdAt)
  if (!Number.isFinite(newestArtifact) || newestArtifact <= 0 || now - newestArtifact > TEAM_SYNTHESIS_REVIEW_MAX_AGE_MS) {
    const reason = "Persisted synthesis evidence is older than the 24-hour review window."
    run.synthesisReview = { status: "expired", recoveryStatus: "blocked", reviewedAt: now, artifactCreatedAt: newestArtifact, summary: "", reason }
    run.updatedAt = now
    await saveTeamRunsToDisk().catch(() => undefined)
    return { reviewed: false as const, status: "expired" as const, automaticExecutorReplay: false, error: reason }
  }

  const summary = teamSynthesisRecoverySummary({
    run,
    output: outputArtifact.content,
    inputBytes: inputArtifact.bytes,
    outputBytes: outputArtifact.bytes,
  }).slice(0, TEAM_SYNTHESIS_REVIEW_MAX_PREVIEW)
  if (input.action === "inspect") {
    return {
      reviewed: true as const,
      action: input.action,
      status: current.status,
      recoveryStatus: current.recoveryStatus,
      automaticExecutorReplay: false,
      artifacts: {
        input: { path: inputArtifact.path, bytes: inputArtifact.bytes, preview: inputArtifact.content },
        output: { path: outputArtifact.path, bytes: outputArtifact.bytes, preview: outputArtifact.content },
      },
      summary,
    }
  }

  if (input.action === "reject") {
    run.synthesisReview = { status: "rejected", recoveryStatus: "blocked", reviewedAt: now, artifactCreatedAt: newestArtifact, summary, reason: "Rejected by explicit review action." }
    run.updatedAt = now
    await saveTeamRunsToDisk().catch(() => undefined)
    return { reviewed: true as const, action: input.action, status: "rejected" as const, recoveryStatus: "blocked" as const, automaticExecutorReplay: false, summary }
  }

  run.synthesisReview = {
    status: "confirmed",
    recoveryStatus: "ready-for-manual-recovery",
    reviewedAt: now,
    artifactCreatedAt: newestArtifact,
    summary,
    reason: "Explicit synthesis confirmation recorded; Executor recovery remains a separate manual action.",
  }
  run.updatedAt = now
  await saveTeamRunsToDisk().catch(() => undefined)
  return {
    reviewed: true as const,
    action: input.action,
    status: "confirmed" as const,
    recoveryStatus: "ready-for-manual-recovery" as const,
    automaticExecutorReplay: false,
    summary,
  }
}

async function persistTeamArtifact(input: {
  directory?: string
  runID: string
  kind: TeamArtifactKind
  content: string
}): Promise<TeamArtifactRef | undefined> {
  if (!input.directory?.trim()) return
  const safe = safeFilePath(input.directory, `.deveagent/team-runs/${input.runID}/${input.kind}.md`)
  if (!safe) return
  const content = input.content.slice(0, 40_000)
  await mkdir(path.dirname(safe.absolute), { recursive: true })
  const temporary = `${safe.absolute}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, content, "utf8")
  try {
    await rename(temporary, safe.absolute)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
  return { kind: input.kind, path: safe.relative, bytes: Buffer.byteLength(content, "utf8"), createdAt: Date.now() }
}

async function persistTeamSynthesisArtifacts(input: {
  record: TeamRunRecord
  directory?: string
  task: string
  reports: string
  synthesis?: unknown
}) {
  const refs: TeamArtifactRef[] = []
  const source = await persistTeamArtifact({
    directory: input.directory,
    runID: input.record.id,
    kind: "synthesis-input",
    content: `# Team Synthesis Input\n\n## Task\n${input.task.slice(0, 4_000)}\n\n## Advisor Reports\n${input.reports.slice(0, 34_000)}\n`,
  }).catch(() => undefined)
  if (source) refs.push(source)
  if (input.synthesis !== undefined) {
    const output = await persistTeamArtifact({
      directory: input.directory,
      runID: input.record.id,
      kind: "synthesis-output",
      content: `# Team Synthesis Output\n\n${(typeof input.synthesis === "string" ? input.synthesis : JSON.stringify(input.synthesis, null, 2)).slice(0, 40_000)}\n`,
    }).catch(() => undefined)
    if (output) refs.push(output)
  }
  if (refs.length > 0) {
    input.record.artifacts = [...(input.record.artifacts ?? []).filter((item) => !refs.some((next) => next.kind === item.kind)), ...refs].slice(0, 4)
    input.record.synthesisReview = {
      status: "pending",
      recoveryStatus: "blocked",
      artifactCreatedAt: Math.max(...refs.map((item) => item.createdAt)),
      summary: "",
      reason: "Synthesis artifacts require explicit review before any manual Executor recovery.",
    }
    input.record.updatedAt = Date.now()
    await saveTeamRunsToDisk().catch(() => undefined)
  }
  return refs
}

function normalizeTeamPhase(value: unknown): TeamPhaseRecord | undefined {
  if (!value || typeof value !== "object") return
  const raw = value as Record<string, unknown>
  const kind = raw.kind === "advisors" || raw.kind === "synthesis" || raw.kind === "executor" ? raw.kind : undefined
  const status = raw.status === "queued" || raw.status === "running" || raw.status === "completed" || raw.status === "failed" || raw.status === "interrupted"
    ? raw.status
    : undefined
  if (!kind || !status || typeof raw.id !== "string" || typeof raw.runID !== "string" || typeof raw.sessionID !== "string") return
  const number = (input: unknown, fallback: number) => typeof input === "number" && Number.isFinite(input) && input >= 0 ? input : fallback
  const lease = raw.lease && typeof raw.lease === "object" ? raw.lease as Record<string, unknown> : undefined
  return {
    id: raw.id.slice(0, 120),
    runID: raw.runID.slice(0, 120),
    sessionID: raw.sessionID.slice(0, 120),
    directory: typeof raw.directory === "string" ? raw.directory.slice(0, 2_000).replace(/[\uD800-\uDBFF]$/, "") : undefined,
    kind,
    status,
    attempt: Math.min(20, Math.floor(number(raw.attempt, 0))),
    availableAt: number(raw.availableAt, Date.now()),
    startedAt: typeof raw.startedAt === "number" ? raw.startedAt : undefined,
    finishedAt: typeof raw.finishedAt === "number" ? raw.finishedAt : undefined,
    lease: lease && typeof lease.owner === "string" && typeof lease.token === "string" && typeof lease.expiresAt === "number"
      ? { owner: lease.owner.slice(0, 80), token: lease.token.slice(0, 120), expiresAt: lease.expiresAt }
      : undefined,
    updatedAt: number(raw.updatedAt, Math.max(number(raw.finishedAt, 0), number(raw.startedAt, 0))),
    error: typeof raw.error === "string" ? raw.error.slice(0, 300) : undefined,
  }
}

function enqueueTeamPhase(input: { runID: string; sessionID: string; directory?: string; kind: TeamPhaseKind }) {
  const phase: TeamPhaseRecord = {
    id: `phase-${Date.now()}-${randomUUID().slice(0, 8)}`,
    runID: input.runID,
    sessionID: input.sessionID,
    directory: input.directory,
    kind: input.kind,
    status: "queued",
    attempt: 0,
    availableAt: Date.now(),
    updatedAt: Date.now(),
  }
  teamPhaseRecords.unshift(phase)
  if (teamPhaseRecords.length > 300) teamPhaseRecords.length = 300
  return phase
}

async function claimTeamPhase(phase: TeamPhaseRecord, now = Date.now()) {
  return withTeamRunStoreLock(async () => {
    const persisted = (await readTeamRunStoreSnapshot()).phases
      .map(normalizeTeamPhase)
      .find((item) => item?.id === phase.id)
    if (persisted) Object.assign(phase, persisted)
    if (phase.availableAt > now || (phase.status !== "queued" && !(phase.status === "running" && (phase.lease?.expiresAt ?? 0) <= now))) return false
    phase.status = "running"
    phase.attempt += 1
    phase.startedAt ??= now
    phase.lease = { owner: teamPhaseOwner, token: randomUUID(), expiresAt: now + TEAM_PHASE_LEASE_MS }
    phase.updatedAt = Date.now()
    await writeTeamRunsSnapshotUnlocked()
    startTeamPhaseHeartbeat(phase)
    return true
  })
}

function stopTeamPhaseHeartbeat(phaseID: string) {
  const timer = teamPhaseHeartbeats.get(phaseID)
  if (!timer) return
  clearInterval(timer)
  teamPhaseHeartbeats.delete(phaseID)
}

function startTeamPhaseHeartbeat(phase: TeamPhaseRecord) {
  const token = phase.lease?.token
  if (!token) return
  stopTeamPhaseHeartbeat(phase.id)
  const timer = setInterval(() => {
    void renewTeamPhaseLease(phase.id, token).then((renewed) => {
      if (!renewed) stopTeamPhaseHeartbeat(phase.id)
    }).catch(() => stopTeamPhaseHeartbeat(phase.id))
  }, TEAM_PHASE_HEARTBEAT_MS)
  timer.unref?.()
  teamPhaseHeartbeats.set(phase.id, timer)
}

export async function renewTeamPhaseLease(phaseID: string | undefined, leaseToken: string | undefined, now = Date.now()) {
  if (!phaseID || !leaseToken) return false
  return withTeamRunStoreLock(async () => {
    const phase = teamPhaseRecords.find((item) => item.id === phaseID)
    if (!phase) return false
    const persisted = (await readTeamRunStoreSnapshot()).phases
      .map(normalizeTeamPhase)
      .find((item) => item?.id === phaseID)
    if (persisted) Object.assign(phase, persisted)
    if (phase.status !== "running" || phase.lease?.token !== leaseToken || phase.lease.expiresAt <= now) return false
    phase.lease = { ...phase.lease, expiresAt: now + TEAM_PHASE_LEASE_MS }
    phase.updatedAt = now
    await writeTeamRunsSnapshotUnlocked()
    return true
  })
}

async function settleTeamPhase(
  phaseID: string | undefined,
  status: Exclude<TeamPhaseStatus, "queued" | "running">,
  error?: string,
  expectedLeaseToken?: string,
) {
  if (!phaseID) return true
  return withTeamRunStoreLock(async () => {
    const phase = teamPhaseRecords.find((item) => item.id === phaseID)
    if (!phase) {
      stopTeamPhaseHeartbeat(phaseID)
      return false
    }
    const persisted = (await readTeamRunStoreSnapshot()).phases
      .map(normalizeTeamPhase)
      .find((item) => item?.id === phaseID)
    const token = expectedLeaseToken ?? phase.lease?.token
    if (persisted) Object.assign(phase, persisted)
    // Settlement is a one-way transition owned by the active lease. Once a
    // phase is interrupted/completed by another worker, a late child result
    // must not reopen it or overwrite the parent run's terminal state.
    if (phase.status !== "running" || !phase.lease || phase.lease.token !== token) {
      stopTeamPhaseHeartbeat(phaseID)
      return false
    }
    phase.status = status
    phase.finishedAt = Date.now()
    phase.lease = undefined
    phase.error = error?.slice(0, 300)
    phase.updatedAt = Date.now()
    await writeTeamRunsSnapshotUnlocked()
    stopTeamPhaseHeartbeat(phaseID)
    return true
  })
}

export function getDeveAgentTeamPhases(sessionID: string, directory?: string) {
  return teamPhaseRecords
    .filter((phase) => phase.sessionID === sessionID && (!directory || phase.directory === directory))
    .map((phase) => ({ ...phase, lease: phase.lease ? { ...phase.lease } : undefined }))
}

export async function loadDeveAgentTeamRuns() {
  try {
    const data = JSON.parse(await readFile(teamRunStorePath(), "utf8"))
    if (!Array.isArray(data?.runs)) return
    if (Array.isArray(data?.phases)) {
      const knownPhases = new Set(teamPhaseRecords.map((phase) => phase.id))
      for (const phase of data.phases.slice(0, 300)) {
        const normalized = normalizeTeamPhase(phase)
        if (normalized && !knownPhases.has(normalized.id)) teamPhaseRecords.push(normalized)
      }
    }
    const loaded: TeamRunRecord[] = []
    for (const run of data.runs.slice(0, 100)) {
      if (!run || typeof run !== "object") continue
      const raw = run as Record<string, unknown>
      if (typeof raw.id !== "string" || typeof raw.sessionID !== "string" || !Array.isArray(raw.members)) continue
      // v1 records were written only after completion. Resume input is read
      // from disk, so keep it bounded before it can become a child prompt.
      loaded.push({
        ...(raw as Omit<TeamRunRecord, "status" | "resume" | "resumedFrom">),
        members: raw.members.map((member) => {
          const item = member as Record<string, unknown>
          const status = item.status === "pending" || item.status === "running" || item.status === "completed" || item.status === "failed" || item.status === "unknown"
            ? item.status
            : undefined
          return {
            ...(item as TeamRunRecord["members"][number]),
            ...(status ? { status } : {}),
          }
        }),
        status: raw.status === "running" || raw.status === "interrupted" || raw.status === "failed" ? raw.status : "completed",
        phase: raw.phase === "advisors" || raw.phase === "synthesis" || raw.phase === "executor" || raw.phase === "completed"
          ? raw.phase
          : raw.status === "completed" || raw.status === "failed" ? "completed" : "advisors",
        stopReason: typeof raw.stopReason === "string" ? raw.stopReason.slice(0, 200) : undefined,
        resume: normalizeTeamResumePlan(raw.resume),
        resumedFrom: typeof raw.resumedFrom === "string" && raw.resumedFrom.length <= 120 ? raw.resumedFrom : undefined,
        artifacts: normalizeTeamArtifacts(raw.artifacts),
        synthesisReview: normalizeTeamSynthesisReview(raw.synthesisReview),
      })
    }
    const recovered = recoverInterruptedTeamRuns(loaded)
    const known = new Set(teamRunRecords.map((run) => run.id))
    teamRunRecords.push(...recovered.filter((run) => !known.has(run.id)))
    if (recovered.some((run, index) => run.status !== loaded[index]?.status)) void saveTeamRunsToDisk().catch(() => undefined)
  } catch {
    // ponytail: absent/corrupt local ledger is non-fatal; future runs rebuild it
  }
}

export function recoverInterruptedTeamRuns(runs: TeamRunRecord[], now = Date.now()): TeamRunRecord[] {
  return runs.map((run) => {
    if (run.status !== "running") return run
    const phase = run.phase ?? "advisors"
    const resume = phase === "advisors" ? run.resume : undefined
    return {
      ...run,
      status: "interrupted",
      phase,
      finishedAt: now,
      updatedAt: now,
      resume,
      stopReason: phase === "advisors"
        ? run.stopReason
        : `Application restarted during the ${phase} phase; this phase is not automatically replayed.`,
      members: run.members.map((member) => {
        if (member.status === "completed") return member
        if (member.status === "failed" || member.error) return { ...member, status: member.status ?? "failed" }
        return {
          ...member,
          status: "unknown" as const,
          error: "Application restarted before the native TaskTool returned; child status is unknown.",
        }
      }),
    }
  })
}

type TeamChildReconciliation = {
  memberID: string
  childSessionID: string
  state: "available" | "missing" | "foreign" | "unavailable"
  status?: "idle" | "busy" | "retry"
}

export async function reconcileTeamRunChildren(input: {
  client: unknown
  directory?: string
  run: TeamRunRecord
}): Promise<TeamChildReconciliation[]> {
  const session = (input.client as {
    session?: {
      get?: (options: unknown) => Promise<{ data?: { id?: string; parentID?: string } }>
      status?: (options?: unknown) => Promise<{ data?: Record<string, { type?: unknown }> }>
    }
  } | undefined)?.session
  const children = input.run.members
    .map((member) => ({ memberID: member.id, childSessionID: safeTaskSessionID(member.childSessionID) }))
    .filter((item): item is { memberID: string; childSessionID: string } => !!item.childSessionID)
  const sessionGet = session?.get
  if (!sessionGet || children.length === 0) return []

  let statuses: Record<string, { type?: unknown }> | undefined
  if (session.status) {
    try {
      statuses = (await session.status(input.directory ? { query: { directory: input.directory } } : undefined)).data
    } catch {
      // Session existence is still useful when the status endpoint is temporarily unavailable.
    }
  }

  return Promise.all(children.map(async ({ memberID, childSessionID }) => {
    try {
      const response = await sessionGet({
        path: { id: childSessionID },
        ...(input.directory ? { query: { directory: input.directory } } : {}),
      })
      const child = response.data
      if (!child || child.id !== childSessionID) return { memberID, childSessionID, state: "missing" as const }
      if (child.parentID !== input.run.sessionID) return { memberID, childSessionID, state: "foreign" as const }
      const status = statuses?.[childSessionID]?.type
      return {
        memberID,
        childSessionID,
        state: "available" as const,
        ...(status === "idle" || status === "busy" || status === "retry" ? { status } : {}),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        memberID,
        childSessionID,
        state: /404|not found|NotFoundError/i.test(message) ? "missing" as const : "unavailable" as const,
      }
    }
  }))
}

function createTeamRun(input: TeamRunInput, status: TeamRunRecord["status"]): TeamRunRecord {
  const record: TeamRunRecord = {
    ...input,
    phase: input.phase ?? "advisors",
    members: input.members.map((member) => ({ ...member, status: member.status ?? "pending" })),
    id: `team-${input.startedAt}-${Math.random().toString(36).slice(2, 8)}`,
    status,
    updatedAt: Date.now(),
    ...(status === "running" ? {} : { finishedAt: Date.now() }),
  }
  teamRunRecords.unshift(record)
  if (teamRunRecords.length > 100) teamRunRecords.length = 100
  return record
}

async function beginTeamRun(input: TeamRunInput) {
  const record = createTeamRun(input, "running")
  const phase = record.phase && record.phase !== "completed" ? enqueueTeamPhase({
    runID: record.id,
    sessionID: record.sessionID,
    directory: record.directory,
    kind: record.phase,
  }) : undefined
  if (phase && await claimTeamPhase(phase)) {
    record.currentPhaseID = phase.id
    record.currentPhaseLeaseToken = phase.lease?.token
  }
  await saveTeamRunsToDisk()
  return record
}

async function completeTeamRun(record: TeamRunRecord, input: TeamRunInput) {
  const finishedAt = Date.now()
  const members = input.members.map((member) => {
    const prior = record.members.find((item) => item.id === member.id)
    return {
      ...member,
      status: member.status ?? (member.error ? "failed" : "completed"),
      ...(member.jobID || prior?.jobID ? { jobID: member.jobID ?? prior?.jobID } : {}),
      ...(prior?.startedAt ? { startedAt: prior.startedAt } : {}),
      finishedAt,
    }
  })
  const failedMember = members.some((member) => member.status === "failed" || member.status === "unknown" || !!member.error)
  const status: TeamRunRecord["status"] = failedMember || input.budgetExceeded ? "failed" : "completed"
  const settled = await settleTeamPhase(record.currentPhaseID, status, record.stopReason, record.currentPhaseLeaseToken)
  if (!settled) return record
  Object.assign(record, input, {
    phase: input.phase ?? "completed",
    members,
    status,
    stopReason: failedMember
      ? "One or more team members failed or ended with unknown status."
      : input.budgetExceeded
        ? "Team token budget exceeded."
        : undefined,
    finishedAt,
    updatedAt: finishedAt,
    currentPhaseLeaseToken: undefined,
  })
  await saveTeamRunsToDisk().catch(() => undefined)
  return record
}

export async function cancelTeamRun(input: {
  runID: string
  sessionID: string
  directory?: string
  client?: unknown
  reason?: string
}) {
  const record = teamRunRecords.find((run) => run.id === input.runID && run.sessionID === input.sessionID)
  if (!record) return { cancelled: false as const, error: "Team run not found for this session." }
  if (record.status !== "running") {
    return { cancelled: false as const, status: record.status, run: record }
  }

  const abort = (input.client as {
    session?: { abort?: (request: unknown) => Promise<unknown> }
  } | undefined)?.session?.abort
  const childSessionIDs = record.members
    .map((member) => safeTaskSessionID(member.childSessionID))
    .filter((sessionID): sessionID is string => !!sessionID)
  const stopReason = (input.reason?.trim() || "Cancelled by the user.").slice(0, 200)
  const settled = await settleTeamPhase(record.currentPhaseID, "interrupted", stopReason, record.currentPhaseLeaseToken)
  if (!settled) {
    return {
      cancelled: false as const,
      error: "Team phase lease changed before cancellation could be committed.",
      run: record,
    }
  }

  // Fence the parent first. A child that finishes while abort is in flight can
  // then only observe the interrupted phase and is unable to resurrect it.
  const finishedAt = Date.now()
  Object.assign(record, {
    status: "interrupted" as const,
    finishedAt,
    updatedAt: finishedAt,
    stopReason,
    currentPhaseLeaseToken: undefined,
    members: record.members.map((member) => member.status === "running"
      ? { ...member, status: "unknown" as const, error: stopReason, finishedAt }
      : member),
  })
  await saveTeamRunsToDisk().catch(() => undefined)

  const aborted: string[] = []
  const abortErrors: { sessionID: string; error: string }[] = []
  if (abort) {
    await Promise.all(childSessionIDs.map(async (childSessionID) => {
      try {
        await abort({
          path: { id: childSessionID },
          ...(input.directory ? { query: { directory: input.directory } } : {}),
        })
        aborted.push(childSessionID)
      } catch (error) {
        abortErrors.push({
          sessionID: childSessionID,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 200),
        })
      }
    }))
  }
  return { cancelled: true as const, run: record, aborted, abortErrors }
}

function updateTeamRunProgress(record: TeamRunRecord, input: TeamRunInput) {
  const members = input.members.map((member) => {
    const prior = record.members.find((item) => item.id === member.id)
    return {
      ...member,
      status: member.status ?? (member.error ? "failed" : "completed"),
      ...(member.jobID || prior?.jobID ? { jobID: member.jobID ?? prior?.jobID } : {}),
      ...(prior?.startedAt ? { startedAt: prior.startedAt } : {}),
      ...(member.finishedAt ? { finishedAt: member.finishedAt } : {}),
    }
  })
  // A Team run stays visibly running while synthesis or the Executor is still
  // active. This is deliberately separate from completeTeamRun so the parent
  // ledger cannot report a partial advisor pass as the final result.
  Object.assign(record, input, { phase: input.phase ?? record.phase ?? "advisors", members, status: "running", finishedAt: undefined, stopReason: undefined, updatedAt: Date.now() })
  void saveTeamRunsToDisk().catch(() => undefined)
  return record
}

async function checkpointTeamPhase(record: TeamRunRecord, phase: Exclude<TeamRunPhase, "completed">) {
  if (record.phase === phase && record.currentPhaseID) return record
  const settled = await settleTeamPhase(record.currentPhaseID, "completed", undefined, record.currentPhaseLeaseToken)
  if (!settled) return record
  const next = enqueueTeamPhase({
    runID: record.id,
    sessionID: record.sessionID,
    directory: record.directory,
    kind: phase,
  })
  if (await claimTeamPhase(next)) {
    record.currentPhaseID = next.id
    record.currentPhaseLeaseToken = next.lease?.token
  }
  record.phase = phase
  record.status = "running"
  record.finishedAt = undefined
  record.stopReason = undefined
  record.updatedAt = Date.now()
  await saveTeamRunsToDisk().catch(() => undefined)
  return record
}

async function recordTeamChildStart(
  record: TeamRunRecord,
  memberID: string,
  childSessionID: string | undefined,
  jobID?: string,
  attempt = 1,
) {
  const member = record.members.find((item) => item.id === memberID)
  if (!member) return
  member.status = "running"
  member.attempts = Math.max(member.attempts, attempt)
  member.startedAt ??= Date.now()
  if (childSessionID) member.childSessionID = childSessionID
  if (jobID) member.jobID = jobID
  record.updatedAt = Date.now()
  // ponytail: persist the native identity and host-owned running evidence;
  // restart recovery still marks the job unknown instead of claiming it can resume.
  await saveTeamRunsToDisk().catch(() => undefined)
}

async function recordTeamChildCompletion(
  record: TeamRunRecord,
  memberID: string,
  outcome: { result?: unknown; error?: string; attempts: number },
) {
  const member = record.members.find((item) => item.id === memberID)
  if (!member) return
  const usage = taskUsage(outcome.result)
  member.status = outcome.error ? "failed" : "completed"
  member.attempts = Math.max(member.attempts, outcome.attempts)
  member.finishedAt = Date.now()
  member.error = outcome.error
  member.tokens = usage.tokens
  member.cost = usage.cost
  member.input = usage.input
  member.output = usage.output
  member.reasoning = usage.reasoning
  member.cacheRead = usage.cacheRead
  member.cacheWrite = usage.cacheWrite
  record.updatedAt = Date.now()
  // Persist each advisor completion before the next queued child starts. On
  // restart, recovery can skip completed advisors without replaying them.
  await saveTeamRunsToDisk().catch(() => undefined)
}

async function recordTeamRun(input: TeamRunInput) {
  return completeTeamRun(createTeamRun(input, "running"), input)
}

function taskUsage(result: unknown): {
  tokens: number
  cost: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
} {
  const metadata = (result as { metadata?: unknown } | undefined)?.metadata
  const usage = (metadata as { usage?: unknown; cost?: unknown } | undefined)?.usage as {
    total?: unknown
    input?: unknown
    output?: unknown
    reasoning?: unknown
    cache?: { read?: unknown; write?: unknown }
  } | undefined
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
  const input = number(usage?.input)
  const output = number(usage?.output)
  const reasoning = number(usage?.reasoning)
  const cacheRead = number(usage?.cache?.read)
  const cacheWrite = number(usage?.cache?.write)
  const tokens = number(usage?.total) || input + output + reasoning + cacheRead + cacheWrite
  return { tokens, cost: number((metadata as { cost?: unknown } | undefined)?.cost), input, output, reasoning, cacheRead, cacheWrite }
}

function teamChildSessionID(result: unknown): string | undefined {
  const metadataID = (result as { metadata?: { sessionId?: unknown } } | undefined)?.metadata?.sessionId
  if (typeof metadataID === "string" && metadataID) return metadataID
  const output = (result as { output?: unknown } | undefined)?.output
  if (typeof output !== "string") return undefined
  // Native TaskTool wraps completed child output in this stable task tag.
  return output.match(/<task id="([^"\n]+)"/)?.[1]
}


// ponytail: Goal mode real state — tracks active goal, criteria, verification
type GoalState = {
  active: boolean
  description: string
  criteria: string[]
  directory?: string
  status: "pending" | "in_progress" | "verified" | "failed"
  startedAt?: number
  verifiedAt?: number
  reentries: number
  maxReentries: number
  deadlineAt?: number
  stopReason?: string
  retryCount: number
  nextAttemptAt?: number
  lastAttemptAt?: number
  // ponytail: set when the autocontinue hook injected an in-turn continuation;
  // the worker poll skips the goal inside the backoff window (event-driven win).
  lastEventDrivenAt?: number
  lastError?: string
  attempts: GoalAttempt[]
}

type GoalAttempt = {
  id: number
  status: "running" | "completed" | "failed" | "interrupted"
  startedAt: number
  finishedAt?: number
  error?: string
}

type GoalDraftState = {
  active: true
  description: string
  createdAt: number
  directory?: string
}

const EMPTY_GOAL: GoalState = {
  active: false,
  description: "",
  criteria: [],
  status: "pending",
  reentries: 0,
  maxReentries: 8,
  retryCount: 0,
  attempts: [],
}
const goalStateBySession = new Map<string, GoalState>()
const goalDraftBySession = new Map<string, GoalDraftState>()
const DEFAULT_GOAL_SESSION = "__default__"
const goalWorkerInflight = new Set<string>()
const goalCancellationBySession = new Map<string, () => Promise<void>>()
let goalStoreWrite = Promise.resolve()
type AutomationWorker = {
  client: unknown
  directory: string
  timer?: ReturnType<typeof setTimeout>
}
const automationWorkers = new Map<string, AutomationWorker>()

function automationDirectory(directory?: string) {
  return typeof directory === "string" && directory.trim() ? path.resolve(directory) : undefined
}

function automationDirectoryMatches(value: string | undefined, directory?: string) {
  const expected = automationDirectory(directory)
  return !expected || !value || value === expected
}

function goalStorePath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(base, "opencode", "deveagent-goals.json")
}

function validPersistedGoal(value: unknown): GoalState | undefined {
  if (!value || typeof value !== "object") return
  const raw = value as Record<string, unknown>
  if (raw.active !== true || (raw.status !== "in_progress" && raw.status !== "verified" && raw.status !== "failed") || typeof raw.description !== "string" || !Array.isArray(raw.criteria)) return
  const attempts = (Array.isArray(raw.attempts) ? raw.attempts.slice(-8) : []).flatMap((item): GoalAttempt[] => {
    if (!item || typeof item !== "object") return []
    const entry = item as Record<string, unknown>
    const id = typeof entry.id === "number" && Number.isFinite(entry.id) ? Math.max(1, Math.floor(entry.id)) : 0
    const startedAt = typeof entry.startedAt === "number" && Number.isFinite(entry.startedAt) ? entry.startedAt : 0
    const status = entry.status === "completed" || entry.status === "failed" || entry.status === "interrupted" || entry.status === "running"
      ? entry.status
      : undefined
    if (!id || !startedAt || !status) return []
    const interrupted = status === "running"
    return [{
      id,
      status: interrupted ? "interrupted" : status,
      startedAt,
      ...(typeof entry.finishedAt === "number" && Number.isFinite(entry.finishedAt) ? { finishedAt: entry.finishedAt } : interrupted ? { finishedAt: Date.now() } : {}),
      ...(typeof entry.error === "string" ? { error: entry.error.slice(0, 200) } : interrupted ? { error: "Application restarted before the Goal re-entry returned." } : {}),
    }]
  })
  return {
    active: true,
    description: raw.description.slice(0, 500),
    criteria: raw.criteria.filter((item): item is string => typeof item === "string").slice(0, 10).map((item) => item.slice(0, 200)),
    directory: typeof raw.directory === "string" && raw.directory.trim() ? path.resolve(raw.directory) : undefined,
    status: raw.status,
    startedAt: typeof raw.startedAt === "number" ? raw.startedAt : Date.now(),
    verifiedAt: typeof raw.verifiedAt === "number" ? raw.verifiedAt : undefined,
    reentries: typeof raw.reentries === "number" ? Math.max(0, Math.floor(raw.reentries)) : 0,
    maxReentries: typeof raw.maxReentries === "number" ? Math.max(1, Math.min(Math.floor(raw.maxReentries), 20)) : 8,
    // ponytail: keep an already-passed deadline so the recovery scan can expire the goal instead of reviving it with no budget
    deadlineAt: typeof raw.deadlineAt === "number" ? raw.deadlineAt : undefined,
    retryCount: typeof raw.retryCount === "number" ? Math.max(0, Math.floor(raw.retryCount)) : 0,
    nextAttemptAt: typeof raw.nextAttemptAt === "number" ? raw.nextAttemptAt : undefined,
    lastAttemptAt: typeof raw.lastAttemptAt === "number" ? raw.lastAttemptAt : undefined,
    lastEventDrivenAt: typeof raw.lastEventDrivenAt === "number" ? raw.lastEventDrivenAt : undefined,
    lastError: typeof raw.lastError === "string" ? raw.lastError.slice(0, 200) : undefined,
    stopReason: typeof raw.stopReason === "string" ? raw.stopReason.slice(0, 200) : undefined,
    attempts,
  }
}

async function loadGoalsFromDisk() {
  try {
    const data = JSON.parse(await readFile(goalStorePath(), "utf8"))
    if (Array.isArray(data?.goals)) {
      let recovered = false
      for (const [sessionID, value] of data.goals) {
        if (typeof sessionID !== "string" || sessionID.length > 160) continue
        const goal = validPersistedGoal(value)
        if (goal) {
          recovered ||= goal.attempts.some((attempt) => attempt.status === "interrupted")
          goalStateBySession.set(sessionID, goal)
        }
      }
      if (recovered) void saveGoalsToDisk().catch(() => undefined)
    }
    if (Array.isArray(data?.drafts)) {
      for (const [sessionID, value] of data.drafts) {
        if (typeof sessionID !== "string" || sessionID.length > 160 || !value || typeof value !== "object") continue
        const raw = value as Record<string, unknown>
        if (raw.active !== true || typeof raw.description !== "string") continue
        goalDraftBySession.set(sessionID, {
          active: true,
          description: raw.description.slice(0, 500),
          createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
          directory: typeof raw.directory === "string" && raw.directory.trim() ? path.resolve(raw.directory) : undefined,
        })
      }
    }
  } catch {
    // ponytail: absent/corrupt local queue starts empty; never block OpenCode boot
  }
}

async function saveGoalsToDisk() {
  const file = goalStorePath()
  // ponytail: serialize and atomically replace the tiny queue file; this avoids
  // stale concurrent snapshots and half-written JSON after a process crash.
  goalStoreWrite = goalStoreWrite
    .catch(() => undefined)
    .then(async () => {
      const goals = [...goalStateBySession.entries()]
        .filter(([, goal]) => goal.active && (goal.status === "in_progress" || goal.status === "verified" || goal.status === "failed"))
        // Keep the NEWEST goals within the persistence bound: insertion-order
        // slice(0, 100) would drop the newest active goals from disk on
        // restart once more than 100 qualify.
        .slice(-100)
      const drafts = [...goalDraftBySession.entries()]
      await atomicWriteFile(file, JSON.stringify({ version: 3, goals, drafts }))
    })
  await goalStoreWrite
}

/**
 * Durability barrier for callers that must observe persisted goal state (the
 * worker and tools fire-and-forget their saves on purpose; tests and
 * shutdown paths await this instead of racing the write chain).
 */
export async function waitForGoalStoreFlush() {
  await goalStoreWrite.catch(() => undefined)
}

type AutomationLease = {
  owns: () => Promise<boolean>
  release: () => Promise<void>
  renew: () => Promise<boolean>
}

async function readAutomationLeaseToken(lockPath: string) {
  try {
    const raw = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown }
    return typeof raw.token === "string" && raw.token ? raw.token : undefined
  } catch {
    return undefined
  }
}

async function claimAutomationLease(
  kind: "goal" | "loop",
  sessionID: string,
  storeFile: string,
): Promise<AutomationLease | undefined> {
  const lockPath = path.join(path.dirname(storeFile), `deveagent-${kind}-${encodeURIComponent(sessionID)}.lock`)
  await mkdir(path.dirname(lockPath), { recursive: true })
  try {
    const handle = await open(lockPath, "wx")
    const token = randomUUID()
    await handle.writeFile(JSON.stringify({ pid: process.pid, token, claimedAt: Date.now() }), "utf8")
    await handle.close()
    return {
      owns: async () => (await readAutomationLeaseToken(lockPath)) === token,
      renew: async () => {
        if ((await readAutomationLeaseToken(lockPath)) !== token) return false
        await writeFile(lockPath, JSON.stringify({ pid: process.pid, token, renewedAt: Date.now() }), "utf8").catch(() => undefined)
        return (await readAutomationLeaseToken(lockPath)) === token
      },
      release: async () => {
        if ((await readAutomationLeaseToken(lockPath)) === token) await unlink(lockPath).catch(() => undefined)
      },
    }
  } catch {
    try {
      const info = await stat(lockPath)
      if (Date.now() - info.mtimeMs < 120_000) return
      await unlink(lockPath)
      return claimAutomationLease(kind, sessionID, storeFile)
    } catch {
      return
    }
  }
}

function claimGoalLease(sessionID: string) {
  return claimAutomationLease("goal", sessionID, goalStorePath())
}

type AutomationPrompt = (input: unknown) => Promise<unknown>

function automationPrompt(client: unknown): AutomationPrompt | undefined {
  const session = (client as { session?: { prompt?: AutomationPrompt; promptAsync?: AutomationPrompt } })?.session
  // The synchronous endpoint resolves after the provider run. promptAsync only
  // acknowledges a forked job, so it is a compatibility fallback for older hosts.
  return session?.prompt?.bind(session) ?? session?.promptAsync?.bind(session)
}

function goalKey(sessionID?: string) {
  return sessionID || DEFAULT_GOAL_SESSION
}

export function goalBackoffMs(retryCount: number) {
  return Math.min(60_000, Math.max(5_000, retryCount * 5_000))
}

// Repeated failures (e.g. a deleted session the worker cannot resume) must not
// keep the worker retrying forever. Loops carry maxRetries; goals get a bounded
// retry budget whose backoff sequence (5s..60s) caps the futile-resume window
// at roughly 7 minutes before the goal fails with an honest stop reason.
const GOAL_MAX_RETRIES = 12

// ponytail: event-driven convergence. The autocontinue hook drives in-turn goal
// continuation; the 5s worker poll must NOT fire a duplicate resume prompt while
// autocontinue is still handling a goal. Returns true when the worker should
// skip a goal (autocontinue drove it within the current backoff window). Goals
// recovered from disk (no lastEventDrivenAt) are never skipped, so crash
// recovery still works.
export function shouldWorkerReenterGoal(
  goal: { lastEventDrivenAt?: number; retryCount: number },
  now: number,
): boolean {
  if (!goal.lastEventDrivenAt) return false
  return now - goal.lastEventDrivenAt < goalBackoffMs(goal.retryCount)
}

// Bounded telemetry distinguishing event-driven (autocontinue) from worker-poll
// re-entries, so the plan's "event-driven primary, polling for recovery only"
// claim can be evidenced honestly instead of assumed.
const goalTelemetry = {
  eventDrivenReentries: 0,
  workerReentries: 0,
  lastPath: null as "event" | "worker" | null,
  lastAt: null as number | null,
}

export function goalTelemetrySnapshot() {
  return { ...goalTelemetry }
}

export function resetGoalTelemetry() {
  goalTelemetry.eventDrivenReentries = 0
  goalTelemetry.workerReentries = 0
  goalTelemetry.lastPath = null
  goalTelemetry.lastAt = null
}

// ponytail: one worker scan — reload persisted goals, then resume at most one ready goal.
// Exported so tests can drive the real scheduler without the 5s polling loop.
export async function scanGoalQueueOnce(client: unknown, directory: string) {
  const session = (client as { session?: { abort?: (input: unknown) => Promise<unknown> } })?.session
  const prompt = automationPrompt(client)
  if (!prompt) return
  await loadGoalsFromDisk()
  const workspaceDirectory = automationDirectory(directory) ?? path.resolve(directory)
  for (const item of getGoalQueue(workspaceDirectory)) {
    if (!item.ready || expireGoal(item.sessionID)) continue
    const goal = goalStateBySession.get(item.sessionID)
    if (!goal || (goal.nextAttemptAt && goal.nextAttemptAt > Date.now())) continue
    // Event-driven convergence: autocontinue is driving this goal inside its
    // backoff window, so the worker must not fire a duplicate resume prompt.
    if (shouldWorkerReenterGoal(goal, Date.now())) continue
    // Legacy queue entries predate workspace ownership. Claim them once during recovery.
    if (!goal.directory) {
      goal.directory = workspaceDirectory
      void saveGoalsToDisk().catch(() => undefined)
    }
    if (!automationDirectoryMatches(goal.directory, workspaceDirectory)) continue
    const lease = await claimGoalLease(item.sessionID)
    if (!lease) continue
    // TOCTOU: autocontinue may have driven this goal while the lease await was
    // in flight (it bypasses the pre-lease guard above). Re-check now, before we
    // clear the marker and fire a duplicate resume prompt.
    if (shouldWorkerReenterGoal(goal, Date.now())) {
      await lease.release()
      continue
    }
    if (!reserveGoalReentry(item.sessionID)) {
      await lease.release()
      continue
    }
    const heartbeat = setInterval(() => void lease.renew(), 30_000)
    ;(heartbeat as unknown as { unref?: () => void }).unref?.()
    goal.lastAttemptAt = Date.now()
    // The worker is now the active driver for this goal; clear the event-driven
    // marker so a later autocontinue (not this stale marker) gates re-entry.
    goal.lastEventDrivenAt = undefined
    goalTelemetry.workerReentries += 1
    goalTelemetry.lastPath = "worker"
    goalTelemetry.lastAt = Date.now()
    goalWorkerInflight.add(item.sessionID)
    const abort = (session?.abort as ((input: unknown) => Promise<unknown>) | undefined)?.bind(session)
    const cancel = abort
      ? async () => {
          await abort({ path: { id: item.sessionID }, query: { directory: workspaceDirectory } })
        }
      : undefined
    if (cancel) goalCancellationBySession.set(item.sessionID, cancel)
    void saveGoalsToDisk().catch(() => undefined)
    let leaseOwned = true
    let deadlineReached = false
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    try {
      const remainingMs = goal.deadlineAt ? Math.max(0, goal.deadlineAt - Date.now()) : undefined
      if (remainingMs !== undefined && remainingMs <= 0) {
        expireGoal(item.sessionID)
        return
      }
      const promptRun = prompt({
        path: { id: item.sessionID },
        query: { directory: workspaceDirectory },
        body: {
          noReply: false,
          parts: [{ type: "text", text: `Resume the persisted Goal: ${goal.description}. Continue with the next smallest verifiable step and call goal-verify when complete.` }],
        },
      })
      const deadline = remainingMs === undefined
        ? undefined
        : new Promise<never>((_, reject) => {
            deadlineTimer = setTimeout(() => {
              deadlineReached = true
              void cancel?.().catch(() => undefined)
              reject(new Error("Goal wall-clock budget exhausted."))
            }, remainingMs)
          })
      await (deadline ? Promise.race([promptRun, deadline]) : promptRun)
      leaseOwned = await lease.owns()
      const current = goalStateBySession.get(item.sessionID)
      if (leaseOwned && current === goal && current.active && current.status === "in_progress") {
        // The provider may have called goal-verify during this request. Re-read
        // the map before committing scheduler state so verified/failed goals
        // cannot be resurrected by the worker's stale snapshot.
        finishGoalAttempt(item.sessionID, "completed")
        current.nextAttemptAt = undefined
        current.retryCount = 0
        current.lastError = undefined
      }
    } catch (error) {
      leaseOwned = await lease.owns()
      const current = goalStateBySession.get(item.sessionID)
      if (leaseOwned && current === goal && current.active && current.status === "in_progress") {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 200)
        if (deadlineReached) {
          current.status = "failed"
          current.stopReason = message
          current.lastError = message
          current.nextAttemptAt = undefined
          finishGoalAttempt(item.sessionID, "failed", message)
        } else {
          current.retryCount += 1
          current.lastError = message
          if (current.retryCount > GOAL_MAX_RETRIES) {
            current.status = "failed"
            current.stopReason = "Goal retry budget exhausted after repeated failures."
            current.nextAttemptAt = undefined
            finishGoalAttempt(item.sessionID, "failed", current.stopReason)
          } else {
            current.nextAttemptAt = Date.now() + goalBackoffMs(current.retryCount)
            finishGoalAttempt(item.sessionID, "failed", current.lastError)
          }
        }
      }
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer)
      goalWorkerInflight.delete(item.sessionID)
      if (goalCancellationBySession.get(item.sessionID) === cancel) goalCancellationBySession.delete(item.sessionID)
      clearInterval(heartbeat)
      await lease.release()
    }
    if (leaseOwned) void saveGoalsToDisk().catch(() => undefined)
    break
  }
}

function startGoalWorker(client: unknown, directory: string) {
  const workspaceDirectory = automationDirectory(directory) ?? path.resolve(directory)
  const key = workspaceDirectory.toLowerCase()
  if (automationWorkers.has(key)) return
  if (!automationPrompt(client)) return
  const worker: AutomationWorker = { client, directory: workspaceDirectory }
  automationWorkers.set(key, worker)
  const tick = async () => {
    if (automationWorkers.get(key) !== worker) return
    await scanGoalQueueOnce(worker.client, worker.directory)
    await scanLoopQueueOnce(worker.client, worker.directory)
    if (automationWorkers.get(key) !== worker) return
    worker.timer = setTimeout(() => void tick(), 5_000)
    ;(worker.timer as unknown as { unref?: () => void }).unref?.()
  }
  void tick()
}

function stopGoalWorker(directory?: string) {
  const keys = directory
    ? [(automationDirectory(directory) ?? path.resolve(directory)).toLowerCase()]
    : [...automationWorkers.keys()]
  for (const key of keys) {
    const worker = automationWorkers.get(key)
    if (!worker) continue
    if (worker.timer) clearTimeout(worker.timer)
    automationWorkers.delete(key)
  }
}

export function setGoal(input: { description: string; criteria: string[]; sessionID?: string; directory?: string; maxReentries?: number; maxDurationMinutes?: number }) {
  // The goal-set tool path is unguarded upstream, so degenerate goals must be
  // rejected here (mirrors prepareGoal/confirmGoal validation): an empty
  // description would produce a nonsense resume prompt, and a goal without
  // criteria has nothing for goal-verify to judge.
  const description = input.description.trim().slice(0, 500)
  if (!description) throw new Error("Goal description is required.")
  const criteria = input.criteria.map((item) => item.trim().slice(0, 200)).filter(Boolean).slice(0, 10)
  if (!criteria.length) throw new Error("At least one acceptance criterion is required.")
  const maxDurationMinutes = typeof input.maxDurationMinutes === "number"
    ? Math.max(1, Math.min(24 * 60, Math.floor(input.maxDurationMinutes)))
    : 60
  const goal: GoalState = {
    active: true,
    description,
    criteria,
    directory: automationDirectory(input.directory),
    status: "in_progress",
    startedAt: Date.now(),
    reentries: 0,
    maxReentries: Math.max(1, Math.min(input.maxReentries ?? 8, 20)),
    retryCount: 0,
    attempts: [],
    deadlineAt: Date.now() + maxDurationMinutes * 60_000,
  }
  goalStateBySession.set(goalKey(input.sessionID), goal)
  goalDraftBySession.delete(goalKey(input.sessionID))
  void saveGoalsToDisk().catch(() => undefined)
  return { ...goal }
}

export function prepareGoal(input: { description: string; sessionID?: string; directory?: string }) {
  const key = goalKey(input.sessionID)
  if (getGoal(input.sessionID).active) throw new Error("An active Goal must be cancelled or verified before starting another one.")
  const description = input.description.trim().slice(0, 500)
  if (!description) throw new Error("Goal description is required.")
  const draft: GoalDraftState = {
    active: true,
    description,
    createdAt: Date.now(),
    directory: automationDirectory(input.directory),
  }
  goalDraftBySession.set(key, draft)
  void saveGoalsToDisk().catch(() => undefined)
  return { ...draft }
}

export function getGoalDraft(sessionID?: string) {
  const draft = goalDraftBySession.get(goalKey(sessionID))
  return draft ? { ...draft } : { active: false as const }
}

export function clearGoalDraft(sessionID?: string) {
  goalDraftBySession.delete(goalKey(sessionID))
  void saveGoalsToDisk().catch(() => undefined)
  return { active: false as const }
}

export function confirmGoal(input: { criteria: string[]; sessionID?: string; directory?: string; maxReentries?: number; maxDurationMinutes?: number }) {
  const draft = goalDraftBySession.get(goalKey(input.sessionID))
  if (!draft) throw new Error("No Goal plan is awaiting confirmation.")
  const criteria = input.criteria.map((item) => item.trim()).filter(Boolean).slice(0, 10)
  if (!criteria.length) throw new Error("At least one acceptance criterion is required.")
  return setGoal({ ...input, description: draft.description, directory: input.directory ?? draft.directory, criteria })
}

function expireGoal(sessionID?: string) {
  const goal = goalStateBySession.get(goalKey(sessionID))
  if (!goal) return false
  if (!goal.active || !goal.deadlineAt || Date.now() < goal.deadlineAt) return false
  finishGoalAttempt(sessionID, "failed", "Goal wall-clock budget exhausted.")
  goal.status = "failed"
  goal.stopReason = "Goal wall-clock budget exhausted."
  void saveGoalsToDisk().catch(() => undefined)
  return true
}

export function clearGoal(sessionID?: string) {
  const key = goalKey(sessionID)
  const cancel = goalCancellationBySession.get(key)
  if (cancel) {
    // The state transition is synchronous for existing callers; the native
    // session abort is started immediately so an in-flight provider request
    // stops without making the HTTP/UI cancel path await network latency.
    void cancel().catch(() => undefined)
  }
  goalStateBySession.delete(key)
  void saveGoalsToDisk().catch(() => undefined)
  return { ...EMPTY_GOAL }
}

export function getGoal(sessionID?: string) {
  return { ...(goalStateBySession.get(goalKey(sessionID)) ?? EMPTY_GOAL) }
}

export function reserveGoalReentry(sessionID?: string) {
  const goal = goalStateBySession.get(goalKey(sessionID))
  if (!goal?.active || goal.status !== "in_progress") return false
  if (goal.reentries >= goal.maxReentries) {
    finishGoalAttempt(sessionID, "failed", "Goal re-entry budget exhausted.")
    goal.status = "failed"
    goal.stopReason = "Goal re-entry budget exhausted."
    void saveGoalsToDisk().catch(() => undefined)
    return false
  }
  if (goal.attempts.at(-1)?.status === "running") return true
  goal.reentries += 1
  goal.lastAttemptAt = Date.now()
  goal.attempts = [
    ...goal.attempts.slice(-7),
    { id: goal.reentries, status: "running", startedAt: goal.lastAttemptAt },
  ]
  void saveGoalsToDisk().catch(() => undefined)
  return true
}

function finishGoalAttempt(
  sessionID: string | undefined,
  status: Exclude<GoalAttempt["status"], "running">,
  error?: string,
) {
  const goal = goalStateBySession.get(goalKey(sessionID))
  const active = goal?.attempts.at(-1)
  if (!goal || !active || active.status !== "running") return
  goal.attempts = [
    ...goal.attempts.slice(0, -1),
    {
      ...active,
      status,
      finishedAt: Date.now(),
      ...(error ? { error: error.slice(0, 200) } : {}),
    },
  ]
}

export function getGoalQueue(directory?: string) {
  return [...goalStateBySession.entries()]
    .filter(([, goal]) => goal.active && goal.status === "in_progress" && automationDirectoryMatches(goal.directory, directory))
    .map(([sessionID, goal]) => ({ sessionID, ...goal, ready: !goal.nextAttemptAt || goal.nextAttemptAt <= Date.now() }))
    .sort((a, b) => (a.nextAttemptAt ?? 0) - (b.nextAttemptAt ?? 0))
}

export function verifyGoal(input: { met: boolean; reason?: string; sessionID?: string }) {
  const sessionID = goalKey(input.sessionID)
  const goal = goalStateBySession.get(sessionID)
  if (!goal?.active) return { ...EMPTY_GOAL }
  if (goal.status !== "in_progress") return { ...goal }
  goal.status = input.met ? "verified" : "in_progress"
  if (input.met) {
    finishGoalAttempt(input.sessionID, "completed")
    goal.verifiedAt = Date.now()
    // A Grilling Me interview ends when the same goal is explicitly verified.
    const grilling = grillingTimingBySession.get(sessionID)
    if (grilling && !grilling.completedAt) {
      grilling.completedAt = new Date().toISOString()
      void saveGrillingTimingToDisk().catch(() => undefined)
    }
  }
  void saveGoalsToDisk().catch(() => undefined)
  return { ...goal }
}

type LoopState = {
  active: boolean
  task: string
  directory?: string
  status: "idle" | "running" | "paused" | "completed" | "failed"
  runCount: number
  maxRuns: number
  intervalSeconds: number
  retryCount: number
  maxRetries: number
  startedAt?: number
  completedAt?: number
  deadlineAt?: number
  nextRunAt?: number
  lastRunAt?: number
  lastError?: string
  stopReason?: string
}

const EMPTY_LOOP: LoopState = {
  active: false,
  task: "",
  status: "idle",
  runCount: 0,
  maxRuns: 8,
  intervalSeconds: 60,
  retryCount: 0,
  maxRetries: 3,
}
const loopStateBySession = new Map<string, LoopState>()
const loopWorkerInflight = new Set<string>()
const loopCancellationBySession = new Map<string, () => Promise<void>>()

function loopStorePath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(base, "opencode", "deveagent-loops.json")
}

function validPersistedLoop(value: unknown): LoopState | undefined {
  if (!value || typeof value !== "object") return
  const raw = value as Record<string, unknown>
  if (raw.active !== true || (raw.status !== "running" && raw.status !== "paused") || typeof raw.task !== "string") return
  return {
    active: true,
    task: raw.task.slice(0, 4_000),
    directory: typeof raw.directory === "string" && raw.directory.trim() ? path.resolve(raw.directory) : undefined,
    status: raw.status,
    runCount: typeof raw.runCount === "number" ? Math.max(0, Math.floor(raw.runCount)) : 0,
    maxRuns: typeof raw.maxRuns === "number" ? Math.max(1, Math.min(Math.floor(raw.maxRuns), 100)) : 8,
    intervalSeconds: typeof raw.intervalSeconds === "number" ? Math.max(5, Math.min(Math.floor(raw.intervalSeconds), 86_400)) : 60,
    retryCount: typeof raw.retryCount === "number" ? Math.max(0, Math.floor(raw.retryCount)) : 0,
    maxRetries: typeof raw.maxRetries === "number" ? Math.max(0, Math.min(Math.floor(raw.maxRetries), 10)) : 3,
    startedAt: typeof raw.startedAt === "number" ? raw.startedAt : Date.now(),
    deadlineAt: typeof raw.deadlineAt === "number" ? raw.deadlineAt : undefined,
    nextRunAt: typeof raw.nextRunAt === "number" ? raw.nextRunAt : undefined,
    lastRunAt: typeof raw.lastRunAt === "number" ? raw.lastRunAt : undefined,
    lastError: typeof raw.lastError === "string" ? raw.lastError.slice(0, 300) : undefined,
  }
}

async function loadLoopsFromDisk() {
  try {
    const data = JSON.parse(await readFile(loopStorePath(), "utf8"))
    if (!Array.isArray(data?.loops)) return
    for (const [sessionID, value] of data.loops) {
      if (typeof sessionID !== "string" || sessionID.length > 160) continue
      const loop = validPersistedLoop(value)
      if (loop) loopStateBySession.set(sessionID, loop)
    }
  } catch {
    // An absent or corrupt local queue must never block OpenCode startup.
  }
}

// Loop persistence: same atomicity/serialization guarantees as the goal store.
// A crash mid-write must never corrupt deveagent-loops.json (a half-written
// file reads as "corrupt queue" on boot and silently drops active loops).
let loopStoreWrite = Promise.resolve()
async function saveLoopsToDisk() {
  const loops = [...loopStateBySession.entries()].filter(([, loop]) => loop.active && (loop.status === "running" || loop.status === "paused"))
  const file = loopStorePath()
  loopStoreWrite = loopStoreWrite
    .catch(() => undefined)
    .then(() => atomicWriteFile(file, JSON.stringify({ version: 2, loops })))
  await loopStoreWrite
}

/** Durability barrier mirroring waitForGoalStoreFlush for loop-store writes. */
export async function waitForLoopStoreFlush() {
  await loopStoreWrite.catch(() => undefined)
}

function loopKey(sessionID?: string) {
  return sessionID || DEFAULT_GOAL_SESSION
}

function boundedLoopNumber(value: unknown, fallback: number, min: number, max: number) {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.max(min, Math.min(number, max))
}

export function loopBackoffMs(retryCount: number) {
  return Math.min(60_000, Math.max(5_000, retryCount * 5_000))
}

export function setLoop(input: {
  task: string
  sessionID?: string
  directory?: string
  intervalSeconds?: number
  maxRuns?: number
  maxRetries?: number
  maxDurationMinutes?: number
}) {
  const task = input.task.trim().slice(0, 4_000)
  if (!task) throw new Error("Loop task is required")
  const intervalSeconds = boundedLoopNumber(input.intervalSeconds, 60, 5, 86_400)
  const maxDurationMinutes = boundedLoopNumber(input.maxDurationMinutes, 60, 1, 7 * 24 * 60)
  const now = Date.now()
  const loop: LoopState = {
    active: true,
    task,
    directory: automationDirectory(input.directory),
    status: "running",
    runCount: 0,
    maxRuns: boundedLoopNumber(input.maxRuns, 8, 1, 100),
    intervalSeconds,
    retryCount: 0,
    maxRetries: boundedLoopNumber(input.maxRetries, 3, 0, 10),
    startedAt: now,
    deadlineAt: now + maxDurationMinutes * 60_000,
    nextRunAt: now + intervalSeconds * 1_000,
  }
  loopStateBySession.set(loopKey(input.sessionID), loop)
  void saveLoopsToDisk().catch(() => undefined)
  return { ...loop }
}

export function getLoop(sessionID?: string) {
  return { ...(loopStateBySession.get(loopKey(sessionID)) ?? EMPTY_LOOP) }
}

export function clearLoop(sessionID?: string) {
  const key = loopKey(sessionID)
  const cancel = loopCancellationBySession.get(key)
  if (cancel) void cancel().catch(() => undefined)
  loopStateBySession.delete(key)
  void saveLoopsToDisk().catch(() => undefined)
  return { ...EMPTY_LOOP }
}

export function pauseLoop(sessionID?: string) {
  const loop = loopStateBySession.get(loopKey(sessionID))
  if (!loop?.active) return { ...EMPTY_LOOP }
  loop.status = "paused"
  loop.nextRunAt = undefined
  void saveLoopsToDisk().catch(() => undefined)
  return { ...loop }
}

export function resumeLoop(sessionID?: string) {
  const loop = loopStateBySession.get(loopKey(sessionID))
  if (!loop?.active) return { ...EMPTY_LOOP }
  loop.status = "running"
  loop.nextRunAt = Date.now() + loop.intervalSeconds * 1_000
  void saveLoopsToDisk().catch(() => undefined)
  return { ...loop }
}

function expireLoop(sessionID?: string) {
  const loop = loopStateBySession.get(loopKey(sessionID))
  if (!loop?.active || !loop.deadlineAt || Date.now() < loop.deadlineAt) return false
  loop.active = false
  loop.status = "failed"
  loop.stopReason = "Loop wall-clock budget exhausted."
  void saveLoopsToDisk().catch(() => undefined)
  return true
}

export function getLoopQueue(directory?: string) {
  return [...loopStateBySession.entries()]
    .filter(([, loop]) => loop.active && (loop.status === "running" || loop.status === "paused") && automationDirectoryMatches(loop.directory, directory))
    .map(([sessionID, loop]) => ({
      sessionID,
      ...loop,
      ready: loop.status === "running" && (!loop.nextRunAt || loop.nextRunAt <= Date.now()),
    }))
    .sort((a, b) => (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER))
}

export async function scanLoopQueueOnce(client: unknown, directory: string) {
  const session = (client as { session?: { abort?: (input: unknown) => Promise<unknown> } })?.session
  const prompt = automationPrompt(client)
  if (!prompt) return
  await loadLoopsFromDisk()
  const workspaceDirectory = automationDirectory(directory) ?? path.resolve(directory)
  for (const item of getLoopQueue(workspaceDirectory)) {
    if (!item.ready || item.status !== "running" || expireLoop(item.sessionID) || loopWorkerInflight.has(item.sessionID)) continue
    const loop = loopStateBySession.get(item.sessionID)
    if (!loop) continue
    if (!loop.directory) {
      loop.directory = workspaceDirectory
      void saveLoopsToDisk().catch(() => undefined)
    }
    if (!automationDirectoryMatches(loop.directory, workspaceDirectory)) continue
    if (loop.runCount >= loop.maxRuns) {
      loop.active = false
      loop.status = "completed"
      loop.completedAt = Date.now()
      await saveLoopsToDisk().catch(() => undefined)
      continue
    }
    const lease = await claimAutomationLease("loop", item.sessionID, loopStorePath())
    if (!lease) continue
    const heartbeat = setInterval(() => void lease.renew(), 30_000)
    ;(heartbeat as unknown as { unref?: () => void }).unref?.()
    loopWorkerInflight.add(item.sessionID)
    loop.lastRunAt = Date.now()
    const abort = (session?.abort as ((input: unknown) => Promise<unknown>) | undefined)?.bind(session)
    const cancel = abort
      ? async () => {
          await abort({ path: { id: item.sessionID }, query: { directory: workspaceDirectory } })
        }
      : undefined
    if (cancel) loopCancellationBySession.set(item.sessionID, cancel)
    let leaseOwned = true
    try {
      await prompt({
        path: { id: item.sessionID },
        query: { directory: workspaceDirectory },
        body: {
          noReply: false,
          parts: [{
            type: "text",
            text: `Run ${loop.runCount + 1}/${loop.maxRuns} of the persisted Loop task: ${loop.task}\nPerform one bounded pass, report the result, and do not widen scope or escalate permissions.`,
          }],
        },
      })
      leaseOwned = await lease.owns()
      if (leaseOwned) {
        loop.runCount += 1
        loop.retryCount = 0
        loop.lastError = undefined
        if (loop.runCount >= loop.maxRuns) {
          loop.active = false
          loop.status = "completed"
          loop.completedAt = Date.now()
          loop.nextRunAt = undefined
        } else {
          loop.nextRunAt = Date.now() + loop.intervalSeconds * 1_000
        }
      }
    } catch (error) {
      leaseOwned = await lease.owns()
      if (leaseOwned) {
        loop.retryCount += 1
        loop.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 300)
        if (loop.retryCount > loop.maxRetries) {
          loop.active = false
          loop.status = "failed"
          loop.stopReason = "Loop retry budget exhausted."
          loop.nextRunAt = undefined
        } else {
          loop.nextRunAt = Date.now() + loopBackoffMs(loop.retryCount)
        }
      }
    } finally {
      loopWorkerInflight.delete(item.sessionID)
      if (loopCancellationBySession.get(item.sessionID) === cancel) loopCancellationBySession.delete(item.sessionID)
      clearInterval(heartbeat)
      await lease.release()
    }
    if (leaseOwned) await saveLoopsToDisk().catch(() => undefined)
    break
  }
}

function sanitizeTeamMember(input: unknown): DeveAgentTeamMember | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const raw = input as Record<string, unknown>
  const providerID = typeof raw.providerID === "string" ? raw.providerID : ""
  const modelID = typeof raw.modelID === "string" ? raw.modelID : ""
  if (!providerID || !modelID) return undefined
  const role = raw.role
  const validRole: DeveAgentTeamRole =
    role === "planner" ||
    role === "executor" ||
    role === "reviewer" ||
    role === "researcher" ||
    role === "critic" ||
    role === "verifier" ||
    role === "custom"
      ? role
      : "custom"
  return {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id : `agent-${Math.random().toString(36).slice(2, 10)}`,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name : validRole,
    role: validRole,
    providerID,
    modelID,
    systemPrompt: typeof raw.systemPrompt === "string" ? raw.systemPrompt : undefined,
    enabled: raw.enabled !== false,
  }
}

export function getDeveAgentTeam(sessionID?: string): DeveAgentTeamSnapshot {
  return cloneTeamState(sessionID ? (teamStateBySession.get(sessionID) ?? teamState) : teamState)
}

export function getDeveAgentTeamRuns(sessionID?: string): TeamRunRecord[] {
  return teamRunRecords.filter((run) => !sessionID || run.sessionID === sessionID).slice(0, 100)
}

// ponytail: Superpowers runtime — load skill definitions as structured prompts
const SUPERPOWER_SKILLS: Record<string, { name: string; prompt: string }> = {
  "debugging": { name: "Debugging", prompt: "When debugging: 1) Reproduce the issue. 2) Check logs/errors. 3) Add targeted prints. 4) Isolate the root cause. 5) Fix with minimal change. 6) Verify fix." },
  "code-review": { name: "Code Review", prompt: "When reviewing: 1) Check for regressions. 2) Verify error handling. 3) Check security implications. 4) Verify test coverage. 5) Check for architecture drift." },
  "planning": { name: "Planning", prompt: "When planning: 1) Understand requirements. 2) Identify affected files. 3) Break into tasks. 4) Estimate complexity. 5) Identify risks. 6) Create verification plan." },
  "tdd": { name: "TDD", prompt: "When writing tests: 1) Write failing test first. 2) Implement minimal code to pass. 3) Refactor. 4) Repeat. Focus on edge cases and error paths." },
  "refactoring": { name: "Refactoring", prompt: "When refactoring: 1) Ensure tests pass first. 2) Make one change at a time. 3) Run tests after each change. 4) Keep behavior identical. 5) Document why the change improves the code." },
  "grill-me": {
    name: "Grilling Me",
    prompt: [
      "Run a decision interview before implementation.",
      "Ask exactly one unresolved decision question per assistant turn.",
      "Investigate the workspace and available tools for factual answers instead of asking the user.",
      "For each decision question, include one concise recommended answer and its main trade-off.",
      "After the user explicitly confirms a decision, call grilling-record-decision with the question, confirmed answer, and recommendation. Use grilling-status before the final summary so confirmed decisions survive the remaining interview turns. After the user confirms that the interview is complete, call grilling-complete exactly once, then summarize the final duration and decisions. Only when the user explicitly asks to export or save them, call grilling-export-decisions; it requests normal workspace edit permission.",
      "Do not edit files or begin implementation while this Skill remains selected; after confirmation, the user exits the interview by removing it.",
      "When no unresolved decisions remain, summarize the agreed decisions and ask for final confirmation.",
    ].join(" "),
  },
}

// ponytail: load installed Hermes/Codex skill definitions from disk for richer prompts
const SKILL_DIRS = [
  path.join(os.homedir(), ".hermes", "skills"),
  path.join(os.homedir(), ".codex", "superpowers", "skills"),
]

let cachedSkillDefs: Record<string, string> | undefined

export async function loadSkillDefinitions(): Promise<Record<string, string>> {
  if (cachedSkillDefs) return cachedSkillDefs
  const defs: Record<string, string> = {}
  for (const dir of SKILL_DIRS) {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const skillFile = path.join(dir, entry.name, "SKILL.md")
        try {
          const content = await readFile(skillFile, "utf8")
          const body = content.replace(/^---[\s\S]*?---\s*/, "").trim()
          if (body.length > 0) defs[entry.name] = body.slice(0, 2000)
        } catch { /* skill file not found, skip */ }
      }
    } catch { /* dir not found, skip */ }
  }
  cachedSkillDefs = defs
  return defs
}

export async function getSuperpowersPromptAsync(enabledSkillIds: string[]): Promise<string> {
  const requested = new Set(enabledSkillIds)
  if (requested.has("superpowers")) {
    for (const id of Object.keys(SUPERPOWER_SKILLS)) requested.add(id)
  }
  const active = [...requested]
    .filter(id => SUPERPOWER_SKILLS[id])
    .map(id => SUPERPOWER_SKILLS[id])
  const diskDefs = await loadSkillDefinitions()
  const diskSkills = [...requested]
    .filter(id => diskDefs[id])
    .map(id => ({ name: id, prompt: diskDefs[id] }))
  const all = [...active, ...diskSkills]
  if (all.length === 0) return ""
  return "\n\n## Superpowers Active\n" + all.map(s => `- **${s.name}**:\n${s.prompt}`).join("\n\n")
}

export function getSuperpowersPrompt(enabledSkillIds: string[]): string {
  const requested = new Set(enabledSkillIds)
  if (requested.has("superpowers")) {
    for (const id of Object.keys(SUPERPOWER_SKILLS)) requested.add(id)
  }
  const active = [...requested]
    .filter(id => SUPERPOWER_SKILLS[id])
    .map(id => SUPERPOWER_SKILLS[id])
  if (active.length === 0) return ""
  return "\n\n## Superpowers Active\n" + active.map(s => `- **${s.name}**: ${s.prompt}`).join("\n")
}

// ponytail: team dispatch — routes task to team member with their system prompt
export function dispatchTeamMember(input: { memberID: string; task: string }, snapshot = teamState): {
  member: DeveAgentTeamMember | undefined
  systemPrompt: string
  task: string
} {
  const member = snapshot.members.find(m => m.id === input.memberID && m.enabled)
  if (!member) {
    return { member: undefined, systemPrompt: "", task: input.task }
  }
  const basePrompt = member.systemPrompt || EXPERT_PROMPTS[member.role] || `You are ${member.name}, acting as ${member.role}.`
  const systemPrompt = `${basePrompt}

You are a team member in a multi-agent session. Your role is ${member.role}. Do NOT write files unless you are the executor.`
  return { member, systemPrompt, task: input.task }
}

// ponytail: dispatch to ALL enabled members (parallel) or sequentially
export function dispatchTeamAll(input: { task: string }, snapshot = teamState): {
  members: { member: DeveAgentTeamMember; systemPrompt: string }[]
  runMode: DeveAgentTeamRunMode
  debatePrompt?: string
  taskToolInstructions: string
} {
  const enabled = snapshot.members.filter(m => m.enabled)
  const members = enabled.map(member => {
    const basePrompt = member.systemPrompt || EXPERT_PROMPTS[member.role] || `You are ${member.name}, acting as ${member.role}.`
    const systemPrompt = `${basePrompt}

You are a team member in a multi-agent session. Your role is ${member.role}. Do NOT write files unless you are the executor.`
    return { member, systemPrompt }
  })
  const debatePrompt = snapshot.runMode === "debate"
    ? `## Debate Mode
This task is being debated by ${members.length} team members. Each member should provide their perspective, then the executor synthesizes the best approach. Members: ${members.map(m => `${m.member.name} (${m.member.role})`).join(", ")}.`
    : undefined
  // ponytail: generate task tool instructions so the model can spawn real subagents via OpenCode built-in task tool
  const taskToolInstructions = members.length > 0
    ? `## Multi-Agent Dispatch
Use the built-in "task" tool to spawn subagents for each team member. Launch them concurrently.

${members.map((m) => `**${m.member.name}** (${m.member.role}): task tool with prompt="${input.task}", description="${m.member.name}: ${m.member.role} analysis", include system prompt in the task prompt`).join("\n")}

After all subagents return, call the team-synthesize tool with the original task and the returned advisor results. Use its synthesis as the decision input; do not claim synthesis happened if the tool failed.`
    : "No enabled team members. Use your own judgment."
  return { members, runMode: snapshot.runMode, debatePrompt, taskToolInstructions }
}

export function getTeamMemberByRole(role: DeveAgentTeamRole): DeveAgentTeamMember | undefined {
  return teamState.members.find(m => m.role === role && m.enabled)
}

// ponytail: persistent remote skill install — download + disk + boot load

function remoteSkillsDir(directory?: string) {
  if (directory?.trim()) {
    const safe = safeFilePath(directory, ".deveagent/skills/remote")
    return safe?.absolute
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(base, "opencode", "remote-skills")
}

function safeTaskSessionID(value: string | undefined) {
  const id = value?.trim()
  return id && /^[a-zA-Z0-9._-]{1,160}$/.test(id) ? id : undefined
}

export function buildTeamTaskInput(
  member: DeveAgentTeamMember,
  systemPrompt: string,
  task: string,
  readOnly = true,
  timeoutMs = 120_000,
  background = false,
  taskID?: string,
  maxOutputTokens?: number,
) {
  const executor = !readOnly && member.role === "executor"
  const resumeTaskID = safeTaskSessionID(taskID)
  return {
    description: `${member.name}: ${member.role} analysis`,
    subagent_type: "general",
    background,
    task_id: resumeTaskID,
    read_only: !executor,
    timeout_ms: Math.max(10_000, Math.min(600_000, Math.floor(timeoutMs))),
    max_output_tokens: typeof maxOutputTokens === "number" ? Math.max(1_000, Math.min(128_000, Math.floor(maxOutputTokens))) : undefined,
    model: { providerID: member.providerID, modelID: member.modelID },
    prompt: executor
      ? `${systemPrompt}\n\n## Assigned task\n${task}\n\nYou are the sole write-capable Executor. Use only OpenCode's normal permission flow, implement the smallest correct change, and return files changed plus verification evidence.`
      : `${systemPrompt}\n\n## Assigned task\n${task}\n\nReturn a concise analysis for the parent executor. You are an advisor: do not run commands or modify files.`,
  }
}

export async function captureDeveAgentCompactionMemory(input: {
  client: unknown
  directory?: string
  sessionID: string
  messageID: string
  text: string
}) {
  const messages = (input.client as {
    session?: { messages?: (args: unknown) => Promise<{ data?: { info?: { id?: string; role?: string; summary?: boolean } }[] }> }
  }).session?.messages
  if (!messages || !input.text.trim()) return { stored: false as const }
  try {
    const response = await messages({ path: { id: input.sessionID }, query: { directory: input.directory, limit: 20 } })
    const message = response.data?.find((item) => item.info?.id === input.messageID)?.info
    if (message?.role !== "assistant" || message.summary !== true) return { stored: false as const }
    await writeDeveAgentMemoryCheckpoint({
      directory: input.directory,
      sessionID: input.sessionID,
      summary: input.text,
    })
    const result = await rememberDeveAgentMemory({
      directory: input.directory,
      sessionID: input.sessionID,
      kind: "summary",
      title: "Session compaction summary",
      summary: input.text,
    })
    if (result.stored) await consolidateDeveAgentMemory({ directory: input.directory })
    return result
  } catch {
    // ponytail: Memory capture must not interrupt a provider response when the local session API is unavailable.
    return { stored: false as const }
  }
}

function teamChildOutputBudget(
  snapshot: DeveAgentTeamSnapshot,
  committedTokens: number,
  pendingChildren = 1,
): number {
  const remaining = Math.max(0, snapshot.budgetTokens - Math.max(0, committedTokens))
  if (remaining === 0) return 0
  // ponytail: sequential children receive all remaining room; parallel children
  // receive an equal initial share because their usage is not known until join.
  const share = Math.max(1, Math.floor(remaining / Math.max(1, pendingChildren)))
  return Math.min(snapshot.childMaxOutputTokens, share)
}

function isRetryableTeamError(message: string) {
  return !/(permission|denied|cancel(?:led|ed)?|abort|unavailable|invalid)/i.test(message)
}

async function runTeamMember(
  taskRunner: {
    runTask: (input: ReturnType<typeof buildTeamTaskInput>) => Promise<unknown>
    waitTask?: (input: { jobID: string; timeout_ms?: number }) => Promise<unknown>
  },
  member: DeveAgentTeamMember,
  systemPrompt: string,
  task: string,
  readOnly = true,
  timeoutMs = 120_000,
  onStarted?: (childSessionID: string | undefined, jobID?: string, attempt?: number) => void | Promise<void>,
  resumeTaskID?: string,
  maxOutputTokens?: number,
  maxRetries = 1,
): Promise<{ result?: unknown; error?: string; attempts: number }> {
  const requestedAttempts = Math.max(1, Math.min(4, Math.floor(maxRetries) + 1))
  const numericBudget = typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens)
    ? Math.max(0, Math.floor(maxOutputTokens))
    : undefined
  if (numericBudget !== undefined && numericBudget < 1_000) {
    return { error: "Team token budget is too small for another child attempt.", attempts: 0 }
  }
  // A retry is another provider request. Split the child allocation across all
  // possible attempts so a bounded retry cannot silently spend the same budget
  // again. Actual usage can still be lower, and the parent ledger records it.
  const attempts = numericBudget === undefined
    ? requestedAttempts
    : Math.min(requestedAttempts, Math.max(1, Math.floor(numericBudget / 1_000)))
  const perAttemptOutputTokens = numericBudget === undefined
    ? maxOutputTokens
    : Math.max(1_000, Math.floor(numericBudget / attempts))
  let lastError = "Task did not start."
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const input = buildTeamTaskInput(member, systemPrompt, task, readOnly, timeoutMs, false, resumeTaskID, perAttemptOutputTokens)
      if (resumeTaskID) await onStarted?.(resumeTaskID, undefined, attempt)
      if (taskRunner.waitTask) {
        try {
          const started = await taskRunner.runTask({ ...input, background: true })
          const jobID = (started as { metadata?: { jobId?: unknown } } | undefined)?.metadata?.jobId
          if (typeof jobID !== "string" || !jobID) throw new Error("Native background TaskTool did not return a job ID.")
          await onStarted?.(teamChildSessionID(started), jobID, attempt)
          return { result: await taskRunner.waitTask({ jobID, timeout_ms: input.timeout_ms }), attempts: attempt }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          // Existing OpenCode installs may not enable native background subagents.
          // Fall back before a child is created; do not pretend it is recoverable.
          if (!message.includes("Background subagents require")) throw error
        }
      }
      // ponytail: TaskTool owns foreground timeout cancellation; a second Promise.race can
      // report timeout while leaving its child session alive.
      await onStarted?.(undefined, undefined, attempt)
      return { result: await taskRunner.runTask(input), attempts: attempt }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      if (attempt < attempts && isRetryableTeamError(lastError)) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, attempt * 250)))
      } else {
        break
      }
    }
  }
  return { error: lastError, attempts }
}

const TEAM_PARALLEL_CONCURRENCY = 3

async function mapTeamWithConcurrency<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await map(items[index]!)
    }
  })
  // ponytail: three concurrent child sessions protect local and rate-limited providers; use native scheduler backpressure if OpenCode exposes it.
  await Promise.all(workers)
  return results
}

type TeamParallelBudget = {
  available: number
  pending: number
}

function reserveTeamParallelBudget(state: TeamParallelBudget, snapshot: DeveAgentTeamSnapshot) {
  if (state.available < 1_000 || state.pending < 1) return 0
  const allocation = Math.min(
    snapshot.childMaxOutputTokens,
    Math.max(1_000, Math.floor(state.available / state.pending)),
  )
  state.available -= allocation
  state.pending -= 1
  return allocation
}

async function mapTeamWithParallelBudget<T, R extends { result?: unknown }>(
  items: readonly T[],
  snapshot: DeveAgentTeamSnapshot,
  map: (item: T, maxOutputTokens: number) => Promise<R>,
  exhausted: (item: T) => R,
): Promise<R[]> {
  const budget: TeamParallelBudget = { available: snapshot.budgetTokens, pending: items.length }
  return mapTeamWithConcurrency(items, TEAM_PARALLEL_CONCURRENCY, async (item) => {
    const allocation = reserveTeamParallelBudget(budget, snapshot)
    if (!allocation) {
      budget.pending = Math.max(0, budget.pending - 1)
      return exhausted(item)
    }
    let result: R | undefined
    try {
      result = await map(item, allocation)
      return result
    } finally {
      const used = result ? taskUsage(result.result).tokens : 0
      // ponytail: release only unused output room; real over-budget usage stays visible in the final ledger.
      budget.available += Math.max(0, allocation - used)
    }
  })
}

const REMOTE_SKILL_HOSTS = new Set([
  "raw.githubusercontent.com",
  "github.com",
  "api.skillhub.cn",
  "clawhub.ai",
  "skillhub.cn",
  "skillhub.cloud.tencent.com",
])
const REMOTE_SKILL_MAX_BYTES = 256 * 1024

function safeRemoteSkillID(value: string | undefined, fallback: string): string | undefined {
  const id = (value || fallback).replace(/\.md$/i, "").replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "")
  return id.length > 0 && id.length <= 80 ? id : undefined
}

function remoteSkillPath(id: string, directory?: string): string | undefined {
  const rawDir = remoteSkillsDir(directory)
  if (!rawDir) return undefined
  const dir = path.resolve(rawDir)
  const filePath = path.resolve(dir, `${id}.md`)
  return filePath.startsWith(`${dir}${path.sep}`) ? filePath : undefined
}

async function assertRemoteSkillPathHasNoSymlink(input: string, label: string) {
  const absolute = path.resolve(input)
  const root = path.parse(absolute).root
  let current = root
  for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`${label} must not contain a symlink.`)
    } catch (error) {
      if (error instanceof Error && error.message === `${label} must not contain a symlink.`) throw error
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return
      throw error
    }
  }
}

async function ensureRemoteSkillDirectory(directory: string) {
  await assertRemoteSkillPathHasNoSymlink(directory, "Remote Skill directory")
  await mkdir(directory, { recursive: true })
  await assertRemoteSkillPathHasNoSymlink(directory, "Remote Skill directory")
}

export function normalizeRemoteSkillUrl(raw: string): { url?: URL; error?: string } {
  try {
    const input = new URL(raw)
    const host = input.hostname.toLowerCase()
    if (input.protocol !== "https:" || !REMOTE_SKILL_HOSTS.has(host)) {
      return { error: "Remote Skill URL must be HTTPS from an approved marketplace host." }
    }
    if (input.username || input.password || input.port) {
      return { error: "Remote Skill URL must not contain credentials or a non-standard port." }
    }
    if (host === "github.com") {
      const parts = input.pathname.split("/").filter(Boolean)
      if (parts.length < 5 || parts[2] !== "blob") return { error: "GitHub links must point to a specific Markdown blob." }
      // ponytail: branch names containing '/' are not inferred; use the raw.githubusercontent.com URL for those rare cases.
      const [, , , branch, ...file] = parts
      const url = new URL(`https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${branch}/${file.join("/")}`)
      if (!url.pathname.toLowerCase().endsWith(".md")) return { error: "Remote Skill URL must point to a Markdown file." }
      return { url }
    }
    if (host === "api.skillhub.cn") {
      if (!/^\/api\/v1\/skills\/[^/]+\/file$/i.test(input.pathname) || input.searchParams.get("path") !== "SKILL.md") {
        return { error: "SkillHub links must point to the SKILL.md file endpoint." }
      }
      return { url: input }
    }
    if (host === "clawhub.ai") {
      if (!/^\/api\/v1\/skills\/[^/]+\/file$/i.test(input.pathname) || input.searchParams.get("path") !== "SKILL.md") {
        return { error: "ClawHub links must point to the SKILL.md file endpoint." }
      }
      return { url: input }
    }
    if (!input.pathname.toLowerCase().endsWith(".md")) return { error: "Remote Skill URL must point to a Markdown file." }
    return { url: input }
  } catch {
    return { error: "Invalid remote Skill URL." }
  }
}

export async function installRemoteSkill(input: { url: string; id?: string; directory?: string }): Promise<{ id: string; savedPath: string; error?: string }> {
  try {
    const normalized = normalizeRemoteSkillUrl(input.url)
    if (!normalized.url) return { id: input.id || "unknown", savedPath: "", error: normalized.error }
    const url = normalized.url
    const id = safeRemoteSkillID(input.id, url.pathname.split("/").pop() || `skill-${Date.now()}`)
    if (!id) return { id: input.id || "unknown", savedPath: "", error: "Invalid remote Skill ID." }
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "error" })
    if (!res.ok) return { id: input.id || "unknown", savedPath: "", error: `HTTP ${res.status}` }
    const contentLength = Number(res.headers.get("content-length") || 0)
    if (contentLength > REMOTE_SKILL_MAX_BYTES) return { id, savedPath: "", error: "Remote Skill exceeds 256 KiB limit." }
    const content = await res.text()
    if (Buffer.byteLength(content, "utf8") > REMOTE_SKILL_MAX_BYTES) return { id, savedPath: "", error: "Remote Skill exceeds 256 KiB limit." }
    if (/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(content)) return { id, savedPath: "", error: "Remote Skill URL returned HTML instead of Markdown." }
    const dir = remoteSkillsDir(input.directory)
    if (!dir) return { id, savedPath: "", error: "Workspace directory must stay inside the workspace." }
    await ensureRemoteSkillDirectory(dir)
    const filePath = remoteSkillPath(id, input.directory)
    if (!filePath) return { id, savedPath: "", error: "Invalid remote Skill path." }
    const existing = await lstat(filePath).catch(() => undefined)
    if (existing?.isSymbolicLink()) return { id, savedPath: "", error: "Remote Skill file must not be a symlink." }
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx" })
      const replacement = await lstat(filePath).catch(() => undefined)
      if (replacement?.isSymbolicLink()) return { id, savedPath: "", error: "Remote Skill file must not be a symlink." }
      await rename(temporary, filePath)
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
    return { id, savedPath: filePath }
  } catch (err: any) {
    return { id: input.id || "unknown", savedPath: "", error: err.message?.slice(0, 200) }
  }
}

export async function loadRemoteSkills(directory?: string): Promise<{ id: string; name: string; path: string; prompt: string }[]> {
  try {
    const directories = [...new Set([directory ? remoteSkillsDir(directory) : undefined, remoteSkillsDir()].filter((value): value is string => Boolean(value)))]
    const skills = new Map<string, { id: string; name: string; path: string; prompt: string }>()
    for (const dir of directories) {
      await assertRemoteSkillPathHasNoSymlink(dir, "Remote Skill directory")
      const files = await readdir(dir).catch(() => [])
      for (const f of files) {
        if (!f.endsWith(".md")) continue
        const filePath = path.join(dir, f)
        const metadata = await lstat(filePath).catch(() => undefined)
        if (!metadata?.isFile() || metadata.isSymbolicLink()) continue
        const id = f.replace(/\.md$/i, "")
        const content = await readFile(filePath, "utf8")
        const nameMatch = content.match(/^name:\s*(.+)$/m)
        const name = nameMatch ? nameMatch[1].trim() : id
        if (!skills.has(id)) skills.set(id, { id, name, path: filePath, prompt: content.slice(0, 8_000) })
      }
    }
    return [...skills.values()]
  } catch {
    return []
  }
}

export async function removeRemoteSkill(id: string, directory?: string): Promise<{ removed: boolean }> {
  try {
    const safeID = safeRemoteSkillID(id, "")
    const filePath = safeID && remoteSkillPath(safeID, directory)
    if (!filePath) return { removed: false }
    await unlink(filePath)
    return { removed: true }
  } catch {
    return { removed: false }
  }
}

// ============================================================================
// User-defined local Skills — authored in the UI, persisted to disk, injected
// into the system prompt when selected (same content-carrying pattern as remote).
// ============================================================================
const LOCAL_SKILL_MAX_BYTES = 64 * 1024

function localSkillsDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(base, "opencode", "local-skills")
}

function localSkillPath(id: string): string | undefined {
  const dir = path.resolve(localSkillsDir())
  const filePath = path.resolve(dir, `${id}.md`)
  return filePath.startsWith(`${dir}${path.sep}`) ? filePath : undefined
}

export async function saveLocalSkill(input: { id?: string; name: string; description?: string; content: string }): Promise<{ id: string; savedPath: string; error?: string }> {
  try {
    const name = String(input.name ?? "").trim().slice(0, 60)
    if (!name) return { id: input.id || "", savedPath: "", error: "Skill name is required." }
    const content = String(input.content ?? "")
    if (Buffer.byteLength(content, "utf8") > LOCAL_SKILL_MAX_BYTES) return { id: input.id || "", savedPath: "", error: "Skill content exceeds 64 KiB limit." }
    const id = safeRemoteSkillID(input.id, `skill-${Date.now().toString(36)}`)
    if (!id) return { id: input.id || "", savedPath: "", error: "Invalid Skill ID." }
    const filePath = localSkillPath(id)
    if (!filePath) return { id, savedPath: "", error: "Invalid Skill path." }
    await mkdir(localSkillsDir(), { recursive: true })
    const description = String(input.description ?? "").trim().slice(0, 200)
    const body = `name: ${name}\ndescription: ${description}\n\n${content}`
    await atomicWriteFile(filePath, body)
    return { id, savedPath: filePath }
  } catch (err: any) {
    return { id: input.id || "", savedPath: "", error: err.message?.slice(0, 200) }
  }
}

export async function loadLocalSkills(): Promise<{ id: string; name: string; description: string; path: string; prompt: string }[]> {
  try {
    const dir = localSkillsDir()
    const files = await readdir(dir)
    const skills = []
    for (const f of files) {
      if (!f.endsWith(".md")) continue
      const id = f.replace(/\.md$/i, "")
      const content = await readFile(path.join(dir, f), "utf8")
      const nameMatch = content.match(/^name:[ \t]*(.+)$/m)
      const descMatch = content.match(/^description:[ \t]*(.+)$/m)
      const body = content.replace(/^name:[ \t]*.*$/m, "").replace(/^description:[ \t]*.*$/m, "").replace(/^\s*\n/, "")
      skills.push({
        id,
        name: nameMatch ? nameMatch[1].trim() : id,
        description: descMatch ? descMatch[1].trim() : "",
        path: path.join(dir, f),
        prompt: body.slice(0, 8_000),
      })
    }
    return skills
  } catch {
    return []
  }
}

export async function removeLocalSkill(id: string): Promise<{ removed: boolean }> {
  try {
    const safeID = safeRemoteSkillID(id, "")
    const filePath = safeID && localSkillPath(safeID)
    if (!filePath) return { removed: false }
    await unlink(filePath)
    return { removed: true }
  } catch {
    return { removed: false }
  }
}

export async function promoteDeveAgentMemoryCandidate(input: { directory?: string; id?: string }) {
  const candidate = await getDeveAgentMemoryCandidate(input)
  if (!candidate) return { promoted: false, error: "Memory Skill candidate not found." }
  const draft = await saveLocalSkill({
    name: candidate.title.replace(/^Recurring workflow:\s*/i, "").slice(0, 60) || "Reviewed workflow",
    description: `Draft from reviewed Memory candidate ${candidate.id}.`,
    content: [
      `# ${candidate.title}`,
      "",
      "This is a draft local Skill created after explicit user approval.",
      "It is not enabled automatically. Review and replace these steps before loading it into a session.",
      "",
      "## Provenance",
      `- Memory candidate: ${candidate.id}`,
      `- Candidate created: ${new Date(candidate.createdAt).toISOString()}`,
      `- Source workspace: ${input.directory ? path.resolve(input.directory) : "unknown"}`,
      "",
      "## Trigger clues",
      candidate.keywords.map((keyword) => `- ${keyword}`).join("\n"),
      "",
      "## Draft workflow",
      "1. Confirm the requested outcome and relevant workspace scope.",
      "2. Reuse existing project patterns before changing code or tools.",
      "3. Verify the smallest relevant check and report remaining risk.",
    ].join("\n"),
  })
  if (draft.error) return { promoted: false, error: draft.error }
  await dismissDeveAgentMemoryCandidate(input)
  return { promoted: true, id: draft.id, savedPath: draft.savedPath }
}

export function setDeveAgentTeam(input: Partial<DeveAgentTeamSnapshot> & { sessionID?: string }): DeveAgentTeamSnapshot {
  const current = input.sessionID ? (teamStateBySession.get(input.sessionID) ?? teamState) : teamState
  const members = Array.isArray(input.members)
    ? input.members.map(sanitizeTeamMember).filter((member): member is DeveAgentTeamMember => !!member)
    : current.members
  const runMode: DeveAgentTeamRunMode =
    input.runMode === "sequential" || input.runMode === "parallel" || input.runMode === "debate"
      ? input.runMode
      : current.runMode
  const enabled = typeof input.enabled === "boolean" ? input.enabled : current.enabled
  const maxRounds = typeof input.maxRounds === "number" ? Math.max(1, Math.min(10, Math.floor(input.maxRounds))) : current.maxRounds
  const budgetTokens = typeof input.budgetTokens === "number" ? Math.max(10_000, Math.floor(input.budgetTokens)) : current.budgetTokens
  const childTimeoutMs = typeof input.childTimeoutMs === "number" ? Math.max(10_000, Math.min(600_000, Math.floor(input.childTimeoutMs))) : current.childTimeoutMs
  const childMaxOutputTokens = typeof input.childMaxOutputTokens === "number"
    ? Math.max(1_000, Math.min(128_000, Math.floor(input.childMaxOutputTokens)))
    : current.childMaxOutputTokens
  const maxRetries = typeof input.maxRetries === "number"
    ? Math.max(0, Math.min(3, Math.floor(input.maxRetries)))
    : current.maxRetries
  const next = { enabled, members, runMode, maxRounds, budgetTokens, childTimeoutMs, childMaxOutputTokens, maxRetries }
  if (input.sessionID) teamStateBySession.set(input.sessionID, next)
  else teamState = next
  void saveTeamStateToDisk().catch(() => undefined)
  return cloneTeamState(next)
}

// Hydrate persisted runtime state once per process. Prompt hooks await this
// barrier so a brand-new process cannot send its first request with defaults.
const deveAgentStartupReady = Promise.all([
  loadAuxiliaryFromDisk().then((loaded) => {
    if (loaded) setDeveAgentState({ auxiliary: loaded })
  }),
  loadRoleProfilesFromDisk().then((loaded) => {
    if (loaded) setDeveAgentState({ roleProfiles: loaded })
  }),
  loadGoalsFromDisk(),
  loadDeveAgentTeamRuns(),
  loadGrillingTimingFromDisk(),
]).then(() => undefined).catch(() => undefined)

export function waitForDeveAgentStartup() {
  return deveAgentStartupReady
}

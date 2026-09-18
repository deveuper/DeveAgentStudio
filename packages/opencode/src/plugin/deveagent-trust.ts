// DeveAgent project trust gate (Pi parity: "authorize project-level resources
// before the first run"). A cloned repository can ship executable config — its
// own `.opencode/plugin/*.ts` (loaded and run at boot) and its own MCP servers
// (spawned as child processes). Until the user explicitly trusts a workspace,
// DeveAgent refuses to load that project-controlled code.
//
// The decision is stored OUTSIDE the project (`$XDG_CONFIG_HOME/opencode/
// deveagent-trust.json`, keyed by the normalized workspace path) so a repository
// can never ship a pre-answered "trusted" file. The decision is bound to a
// fingerprint of the project's executable resources: adding or changing a plugin
// or MCP command invalidates a previous trust decision.

import { createHash, randomUUID } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

export type ProjectResource = {
  kind: "plugin" | "mcp"
  target: string
}

export type ProjectTrustStatus = "trusted" | "untrusted" | "unknown"

export type ProjectTrustState = {
  directory: string
  status: ProjectTrustStatus
  fingerprint: string
  resources: ProjectResource[]
  // Trusted, but the project's executable resources changed since the decision.
  changed: boolean
  decidedAt?: number
}

const STORE_VERSION = 1
const MAX_PROJECTS = 200
const PLUGIN_DIRS = [join(".opencode", "plugin"), join(".opencode", "plugins")]
const PROJECT_CONFIGS = [join(".opencode", "opencode.json"), join(".opencode", "opencode.jsonc"), "opencode.json", "opencode.jsonc"]

function trustStorePath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(base, "opencode", "deveagent-trust.json")
}

export function normalizeProjectDir(directory: string) {
  const resolved = resolve(directory)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

export function isInsideProject(directory: string, target: string) {
  if (!target) return false
  const base = normalizeProjectDir(directory)
  const candidate = normalizeProjectDir(target)
  if (candidate === base) return true
  return candidate.startsWith(base.endsWith(sep) ? base : base + sep)
}

function readPluginFiles(directory: string) {
  const files: string[] = []
  for (const rel of PLUGIN_DIRS) {
    const dir = join(directory, rel)
    if (!existsSync(dir)) continue
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        if (!/\.(ts|js|mjs|cjs)$/i.test(entry.name)) continue
        files.push(relative(directory, join(dir, entry.name)).replace(/\\/g, "/"))
      }
    } catch {}
  }
  return files.sort()
}

function readProjectMcpTargets(directory: string) {
  const targets: string[] = []
  for (const rel of PROJECT_CONFIGS) {
    const file = join(directory, rel)
    if (!existsSync(file)) continue
    try {
      const raw = readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "")
      const parsed = JSON.parse(raw) as { mcp?: Record<string, unknown> }
      for (const [name, value] of Object.entries(parsed.mcp ?? {})) {
        if (!value || typeof value !== "object") continue
        const entry = value as { type?: unknown; command?: unknown; url?: unknown }
        const detail = Array.isArray(entry.command)
          ? entry.command.map((part) => String(part)).join(" ")
          : typeof entry.url === "string"
            ? entry.url
            : entry.type === "remote"
              ? "remote"
              : "unknown"
        targets.push(`${rel}#${name}: ${detail}`)
      }
    } catch {}
  }
  return targets.sort()
}

/** Project-controlled executable resources: plugins (code) and MCP servers (child processes). */
export function scanProjectResources(directory: string): ProjectResource[] {
  const resources: ProjectResource[] = []
  for (const file of readPluginFiles(directory)) resources.push({ kind: "plugin", target: file })
  for (const target of readProjectMcpTargets(directory)) resources.push({ kind: "mcp", target })
  return resources
}

export function projectFingerprint(resources: ProjectResource[]) {
  const hash = createHash("sha256")
  for (const resource of [...resources].sort((a, b) => `${a.kind}:${a.target}`.localeCompare(`${b.kind}:${b.target}`))) {
    hash.update(`${resource.kind}:${resource.target}\n`)
  }
  return hash.digest("hex").slice(0, 16)
}

type TrustStore = {
  version: number
  projects: Record<string, { decision: "trusted" | "untrusted"; fingerprint: string; at: number }>
}

function readStore(): TrustStore {
  try {
    const parsed = JSON.parse(readFileSync(trustStorePath(), "utf8")) as Partial<TrustStore>
    if (parsed?.version !== STORE_VERSION || !parsed.projects || typeof parsed.projects !== "object") return { version: STORE_VERSION, projects: {} }
    return { version: STORE_VERSION, projects: parsed.projects }
  } catch {
    return { version: STORE_VERSION, projects: {} }
  }
}

async function writeStore(store: TrustStore) {
  const entries = Object.entries(store.projects)
    .sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0))
    .slice(0, MAX_PROJECTS)
  const file = trustStorePath()
  await mkdir(join(file, ".."), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify({ version: STORE_VERSION, projects: Object.fromEntries(entries) }), "utf8")
  try {
    await rename(temporary, file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "EPERM" && code !== "EEXIST") throw error
    await writeFile(file, JSON.stringify({ version: STORE_VERSION, projects: Object.fromEntries(entries) }), "utf8")
  }
}

export function getProjectTrust(directory: string | undefined): ProjectTrustState {
  if (!directory) return { directory: "", status: "unknown", fingerprint: "", resources: [], changed: false }
  const resources = scanProjectResources(directory)
  const fingerprint = projectFingerprint(resources)
  const entry = readStore().projects[normalizeProjectDir(directory)]
  if (!entry) return { directory, status: "unknown", fingerprint, resources, changed: false }
  const changed = entry.fingerprint !== fingerprint
  return {
    directory,
    // A changed fingerprint re-arms the gate: the previous decision was about
    // different code, so it no longer applies.
    status: changed ? "unknown" : entry.decision,
    fingerprint,
    resources,
    changed,
    decidedAt: entry.at,
  }
}

export async function setProjectTrust(directory: string, decision: "trusted" | "untrusted"): Promise<ProjectTrustState> {
  const resources = scanProjectResources(directory)
  const store = readStore()
  store.projects[normalizeProjectDir(directory)] = { decision, fingerprint: projectFingerprint(resources), at: Date.now() }
  await writeStore(store)
  return { directory, status: decision, fingerprint: projectFingerprint(resources), resources, changed: false, decidedAt: Date.now() }
}

/**
 * True when a config origin must be withheld because it is project-controlled
 * code in an untrusted workspace. Global config and env-provided config are
 * never gated; only files that live inside the project directory are.
 */
export function isProjectOriginBlocked(input: { directory: string | undefined; source: string; scope: string }) {
  if (!input.directory) return false
  if (input.scope !== "local") return false
  if (!input.source || input.source.startsWith("http://") || input.source.startsWith("https://")) return false
  if (input.source === "OPENCODE_CONFIG_CONTENT") return false
  if (!isAbsolute(input.source)) return false
  if (!isInsideProject(input.directory, input.source)) return false
  if (scanProjectResources(input.directory).length === 0) return false
  return getProjectTrust(input.directory).status !== "trusted"
}

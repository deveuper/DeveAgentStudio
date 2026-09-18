// DeveAgent managed git worktrees (Codex WorktreeManager parity, desktop
// trim): create isolated linked worktrees under an app-owned root so
// multiple agent tasks can run against one repo without merge collisions.
// Ownership metadata is written atomically (no-clobber) and removal is
// restricted to paths inside the managed root.

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs"
import path from "node:path"

export interface ManagedWorktree {
  name: string
  path: string
  createdAt: string
  branch?: string
  sourceCommit?: string
}

const WORKTREE_ROOT_REL = path.join("deveagent", "worktrees")
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

export function worktreeRoot(directory: string): string {
  const base = path.isAbsolute(directory) ? directory : process.cwd()
  // Anchor the managed root next to the project rather than a global temp:
  // worktrees should live on the same volume as the repo.
  return path.join(path.dirname(base), `${path.basename(base)}-worktrees`, WORKTREE_ROOT_REL)
}

function runGit(repo: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" })
  if (result.error || result.status !== 0) {
    return { ok: false, output: String(result.stderr || result.error || "git failed") }
  }
  return { ok: true, output: result.stdout ?? "" }
}

function metadataPath(root: string) {
  return path.join(root, "metadata.json")
}

function readMetadata(root: string): Record<string, ManagedWorktree> {
  try {
    const parsed = JSON.parse(readFileSync(metadataPath(root), "utf8"))
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function writeMetadataAtomic(root: string, metadata: Record<string, ManagedWorktree>) {
  const file = metadataPath(root)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(metadata, null, 2))
  // Atomic rename: a concurrent writer's file wins, ours is discarded.
  try {
    renameSync(tmp, file)
  } catch {
    try {
      rmSync(tmp, { force: true })
    } catch {}
  }
}

export function normalizeName(name: string | undefined): string {
  const candidate = (name ?? "").trim() || `wt-${Date.now().toString(36)}`
  if (!NAME_PATTERN.test(candidate)) {
    throw new Error(`Invalid worktree name: ${candidate}. Use letters, digits, dot, dash, underscore (max 64).`)
  }
  return candidate
}

/** True when `candidate` resolves inside the managed root (no escape). */
export function isInsideRoot(root: string, candidate: string): boolean {
  const resolved = path.resolve(candidate)
  const normalizedRoot = path.resolve(root) + path.sep
  return resolved.startsWith(normalizedRoot)
}

export function createWorktree(input: {
  directory: string
  name?: string
  base?: string
}): ManagedWorktree {
  const name = normalizeName(input.name)
  if (!existsSync(path.join(input.directory, ".git"))) {
    throw new Error(`Not a git repository: ${input.directory}`)
  }
  const root = worktreeRoot(input.directory)
  mkdirSync(root, { recursive: true })
  const worktreePath = path.join(root, name)
  if (existsSync(worktreePath)) {
    throw new Error(`Worktree already exists: ${name}`)
  }

  const head = runGit(input.directory, ["rev-parse", "HEAD"])
  // Each worktree gets its own branch (deveagent/<name>): commits inside the
  // worktree never interleave with the main checkout, which is the whole
  // point of the isolation.
  //
  // Some git builds cannot create nested ref directories at all — a slashed
  // branch name then fails with `fatal: invalid reference: deveagent/<name>`
  // (observed on the bundled PortableGit 2.55 that ships with this workspace,
  // while system Git 2.45 handles it fine). Rather than losing the whole
  // isolation feature on those installs, retry with a flat branch name.
  const candidates = worktreeBranchCandidates(name)
  let add: { ok: boolean; output: string } | undefined
  let branch = candidates[0]!
  for (const candidate of candidates) {
    const attempt = runGit(input.directory, [
      "worktree",
      "add",
      "-b",
      candidate,
      worktreePath,
      ...(input.base ? [input.base] : []),
    ])
    if (attempt.ok) {
      add = attempt
      branch = candidate
      break
    }
    add = attempt
    // A failed attempt can leave a half-registered worktree behind; clear it
    // before trying the next branch name so the retry starts clean.
    runGit(input.directory, ["worktree", "remove", "--force", worktreePath])
    rmSync(worktreePath, { recursive: true, force: true })
  }
  if (!add?.ok) {
    rmSync(worktreePath, { recursive: true, force: true })
    throw new Error(`git worktree add failed: ${add?.output.trim().slice(0, 300) ?? "unknown error"}`)
  }

  const metadata = readMetadata(root)
  const entry: ManagedWorktree = {
    name,
    path: worktreePath,
    createdAt: new Date().toISOString(),
    branch,
    ...(head.ok ? { sourceCommit: head.output.trim() } : {}),
  }
  metadata[name] = entry
  writeMetadataAtomic(root, metadata)
  return entry
}

/**
 * Branch names tried in order when creating a managed worktree. The slashed
 * form is preferred (namespaced under `deveagent/`); the flat form is the
 * fallback for git builds that cannot create nested refs.
 */
export function worktreeBranchCandidates(name: string): string[] {
  return [`deveagent/${name}`, `deveagent-${name}`]
}

export function listWorktrees(directory: string): ManagedWorktree[] {
  const root = worktreeRoot(directory)
  const metadata = readMetadata(root)
  return Object.values(metadata)
    .filter((entry) => isInsideRoot(root, entry.path) && existsSync(entry.path))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function mergeWorktree(directory: string, name: string): { merged: boolean; output: string } {
  const normalized = normalizeName(name)
  const root = worktreeRoot(directory)
  const metadata = readMetadata(root)
  const entry = metadata[normalized]
  if (!entry || !isInsideRoot(root, entry.path)) {
    throw new Error(`Unknown managed worktree: ${normalized}`)
  }
  if (!entry.branch) {
    throw new Error(`Worktree ${normalized} has no dedicated branch to merge.`)
  }
  // Merge the worktree branch back into the main checkout. A conflict is
  // surfaced verbatim so the caller (or the agent) resolves it by hand.
  const merge = runGit(directory, ["merge", "--no-edit", entry.branch])
  if (!merge.ok) {
    const output = merge.output.trim().slice(0, 500)
    throw new Error(`Merge failed (conflict?): ${output}`)
  }
  return { merged: true, output: merge.output.trim().slice(0, 500) }
}

export function removeWorktree(directory: string, name: string): { removed: string } {
  const normalized = normalizeName(name)
  const root = worktreeRoot(directory)
  const metadata = readMetadata(root)
  const entry = metadata[normalized]
  if (!entry || !isInsideRoot(root, entry.path)) {
    throw new Error(`Unknown managed worktree: ${normalized}`)
  }
  // `git worktree remove` runs from the main repo.
  const remove = runGit(inputRepo(directory), ["worktree", "remove", "--force", entry.path])
  if (!remove.ok) {
    rmSync(entry.path, { recursive: true, force: true })
  }
  delete metadata[normalized]
  writeMetadataAtomic(root, metadata)
  return { removed: entry.path }
}

function inputRepo(directory: string) {
  // The main repo is the safer driver for `git worktree remove`.
  return directory
}

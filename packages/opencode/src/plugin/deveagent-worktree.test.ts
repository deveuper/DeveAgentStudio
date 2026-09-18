import { describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  createWorktree,
  isInsideRoot,
  listWorktrees,
  mergeWorktree,
  normalizeName,
  removeWorktree,
  worktreeBranchCandidates,
  worktreeRoot,
} from "./deveagent-worktree"

function initRepo(): string {
  const dir = path.join(tmpdir(), `deveagent-wt-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir })
  git(["init", "-q"])
  git(["config", "user.email", "t@t"])
  git(["config", "user.name", "t"])
  writeFileSync(path.join(dir, "a.txt"), "hello\n")
  git(["add", "."])
  git(["commit", "-qm", "init"])
  return dir
}

function cleanupRepo(repo: string) {
  rmSync(repo, { recursive: true, force: true })
  rmSync(worktreeRoot(repo), { recursive: true, force: true })
  rmSync(path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`), { recursive: true, force: true })
}

describe("managed worktrees", () => {
  test("normalizeName rejects traversal and garbage", () => {
    expect(normalizeName("feat-x")).toBe("feat-x")
    expect(() => normalizeName("../escape")).toThrow(/Invalid worktree name/)
    expect(() => normalizeName("")).not.toThrow()
    expect(() => normalizeName("a".repeat(65))).toThrow(/Invalid worktree name/)
  })

  test("isInsideRoot blocks path escape", () => {
    const root = path.join(tmpdir(), "wt-root")
    expect(isInsideRoot(root, path.join(root, "wt1"))).toBe(true)
    expect(isInsideRoot(root, path.join(root, "..", "outside"))).toBe(false)
  })

  test("branch candidates prefer the namespaced name and fall back to a flat one", () => {
    // Some git builds cannot create nested refs ("fatal: invalid reference:
    // deveagent/x"), so createWorktree retries with a flat branch name.
    expect(worktreeBranchCandidates("task-a")).toEqual(["deveagent/task-a", "deveagent-task-a"])
  })

  test("create/list/remove roundtrip inside a real git repo", () => {
    const repo = initRepo()
    try {
      const entry = createWorktree({ directory: repo, name: "task-a" })
      expect(entry.name).toBe("task-a")
      // Preferred name is namespaced; the flat fallback is accepted so this
      // suite stays green on git installs that reject nested refs.
      expect(entry.branch).toMatch(/^deveagent[/-]task-a$/)
      expect(listWorktrees(repo).some((w) => w.name === "task-a")).toBe(true)
      expect(() => createWorktree({ directory: repo, name: "task-a" })).toThrow(/already exists/)
      const removed = removeWorktree(repo, "task-a")
      expect(removed.removed).toBe(entry.path)
      expect(listWorktrees(repo).some((w) => w.name === "task-a")).toBe(false)
      expect(() => removeWorktree(repo, "task-a")).toThrow(/Unknown managed worktree/)
    } finally {
      cleanupRepo(repo)
    }
  })

  test("mergeWorktree brings worktree commits back into the main checkout", () => {
    const repo = initRepo()
    try {
      const entry = createWorktree({ directory: repo, name: "feat" })
      writeFileSync(path.join(entry.path, "feature.txt"), "feature work\n")
      const commit = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: entry.path })
      commit(["add", "."])
      commit(["commit", "-qm", "feature done"])
      const result = mergeWorktree(repo, "feat")
      expect(result.merged).toBe(true)
      expect(readFileSync(path.join(repo, "feature.txt"), "utf8")).toContain("feature work")
      removeWorktree(repo, "feat")
    } finally {
      cleanupRepo(repo)
    }
  })

  test("create rejects a non-git directory", () => {
    const dir = path.join(tmpdir(), `deveagent-nogit-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    try {
      expect(() => createWorktree({ directory: dir, name: "x" })).toThrow(/Not a git repository/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { resolveEvidencePath, summarizeGoalEvidence, verifyGoalEvidence } from "./deveagent-goal-evidence"

// The gate exists because `goal-verify` used to accept the agent's own
// `met: true` as final whenever no independent verifier was configured — the
// default state. These tests pin the rule that a claim without machine-checkable
// artifacts does not become `verified`.

function withWorkspace(run: (dir: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), "goal-evidence-"))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

describe("resolveEvidencePath", () => {
  test("accepts a workspace-relative path", () => {
    const result = resolveEvidencePath("C:/ws", "src/index.ts")
    expect(result.error).toBeUndefined()
    expect(result.path?.endsWith(path.join("src", "index.ts"))).toBe(true)
  })

  test("rejects absolute paths", () => {
    expect(resolveEvidencePath("C:/ws", "C:/Windows/system32/cmd.exe").error).toContain("absolute")
    expect(resolveEvidencePath("C:/ws", "/etc/passwd").error).toContain("absolute")
  })

  test("rejects paths that escape the workspace", () => {
    expect(resolveEvidencePath("C:/ws", "../outside.txt").error).toContain("escapes")
    expect(resolveEvidencePath("C:/ws", "a/../../outside.txt").error).toContain("escapes")
  })

  test("rejects an empty path", () => {
    expect(resolveEvidencePath("C:/ws", "   ").error).toContain("empty")
  })
})

describe("verifyGoalEvidence", () => {
  test("passes when every criterion cites a real non-empty file", () => {
    withWorkspace((dir) => {
      mkdirSync(path.join(dir, "src"), { recursive: true })
      writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1\n")
      writeFileSync(path.join(dir, "README.md"), "# done\n")
      const result = verifyGoalEvidence({
        directory: dir,
        criteria: ["add a", "document it"],
        evidence: [
          { criterion: 1, kind: "file", value: "src/a.ts" },
          { criterion: 2, kind: "file", value: "README.md" },
        ],
      })
      expect(result.ok).toBe(true)
      expect(result.uncoveredCriteria).toEqual([])
      expect(result.machineVerifiedCount).toBe(2)
      expect(result.claimCount).toBe(0)
    })
  })

  // The core of R7: this is what the old code let through.
  test("fails when the claim carries no evidence at all", () => {
    withWorkspace((dir) => {
      const result = verifyGoalEvidence({ directory: dir, criteria: ["tests pass"], evidence: [] })
      expect(result.ok).toBe(false)
      expect(result.uncoveredCriteria).toEqual([1])
      expect(result.reason).toContain("No usable evidence")
    })
  })

  test("fails when a criterion is only backed by an unverifiable claim", () => {
    withWorkspace((dir) => {
      const result = verifyGoalEvidence({
        directory: dir,
        criteria: ["tests pass"],
        evidence: [{ criterion: 1, kind: "test", value: "bun test" }],
      })
      expect(result.ok).toBe(false)
      // The claim is recorded for the user, but it is not proof.
      expect(result.claimCount).toBe(1)
      expect(result.machineVerifiedCount).toBe(0)
      expect(result.reason).toContain("unverifiable claims")
    })
  })

  test("fails when a cited file does not exist", () => {
    withWorkspace((dir) => {
      const result = verifyGoalEvidence({
        directory: dir,
        criteria: ["add the file"],
        evidence: [{ criterion: 1, kind: "file", value: "src/missing.ts" }],
      })
      expect(result.ok).toBe(false)
      expect(result.perCriterion[0]?.detail).toContain("not found")
      expect(result.uncoveredCriteria).toEqual([1])
    })
  })

  test("fails when the cited file is empty or a directory", () => {
    withWorkspace((dir) => {
      writeFileSync(path.join(dir, "empty.txt"), "")
      mkdirSync(path.join(dir, "adir"), { recursive: true })
      const result = verifyGoalEvidence({
        directory: dir,
        criteria: ["a", "b"],
        evidence: [
          { criterion: 1, kind: "file", value: "empty.txt" },
          { criterion: 2, kind: "file", value: "adir" },
        ],
      })
      expect(result.ok).toBe(false)
      expect(result.perCriterion[0]?.detail).toContain("empty")
      expect(result.perCriterion[1]?.detail).toContain("directory")
    })
  })

  test("partial coverage fails: one verified criterion does not carry the others", () => {
    withWorkspace((dir) => {
      writeFileSync(path.join(dir, "real.txt"), "content\n")
      const result = verifyGoalEvidence({
        directory: dir,
        criteria: ["real", "unproven"],
        evidence: [{ criterion: 1, kind: "file", value: "real.txt" }],
      })
      expect(result.ok).toBe(false)
      expect(result.uncoveredCriteria).toEqual([2])
      expect(result.machineVerifiedCount).toBe(1)
    })
  })

  test("ignores evidence pointing at a criterion that does not exist", () => {
    withWorkspace((dir) => {
      writeFileSync(path.join(dir, "real.txt"), "content\n")
      const result = verifyGoalEvidence({
        directory: dir,
        criteria: ["only one"],
        evidence: [
          { criterion: 1, kind: "file", value: "real.txt" },
          { criterion: 9, kind: "file", value: "real.txt" },
        ],
      })
      expect(result.ok).toBe(true)
      expect(result.perCriterion).toHaveLength(1)
    })
  })

  test("a path escaping the workspace never counts, even when the file exists", () => {
    withWorkspace((dir) => {
      const outside = path.join(dir, "..", `outside-${Date.now()}.txt`)
      writeFileSync(outside, "content\n")
      try {
        const result = verifyGoalEvidence({
          directory: dir,
          criteria: ["escape"],
          evidence: [{ criterion: 1, kind: "file", value: `../${path.basename(outside)}` }],
        })
        expect(result.ok).toBe(false)
        expect(result.perCriterion[0]?.detail).toContain("escapes")
      } finally {
        rmSync(outside, { force: true })
      }
    })
  })

  test("is fail-closed without a directory or without criteria", () => {
    const noDir = verifyGoalEvidence({ directory: undefined, criteria: ["x"], evidence: [{ criterion: 1, kind: "file", value: "a" }] })
    expect(noDir.ok).toBe(false)
    expect(noDir.reason).toContain("workspace directory")

    withWorkspace((dir) => {
      const noCriteria = verifyGoalEvidence({ directory: dir, criteria: [], evidence: [] })
      expect(noCriteria.ok).toBe(false)
      expect(noCriteria.reason).toContain("no acceptance criteria")
    })
  })

  test("summarizes verified artifacts and claims separately", () => {
    withWorkspace((dir) => {
      writeFileSync(path.join(dir, "a.txt"), "x\n")
      const result = verifyGoalEvidence({
        directory: dir,
        criteria: ["a"],
        evidence: [
          { criterion: 1, kind: "file", value: "a.txt" },
          { criterion: 1, kind: "command", value: "bun test" },
        ],
      })
      expect(result.ok).toBe(true)
      const summary = summarizeGoalEvidence(result)
      expect(summary).toContain("1 verified artifact(s)")
      expect(summary).toContain("1 unverifiable claim(s)")
    })
  })
})

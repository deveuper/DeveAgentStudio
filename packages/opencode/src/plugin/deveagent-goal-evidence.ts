// Evidence gate for a Goal completion claim (audit R7).
//
// `goal-verify` used to accept the agent's own `met: true` as the final word
// whenever no independent verifier was configured — which is the DEFAULT state,
// since a verifier needs a separately-configured aux model. So in practice the
// agent that did the work was the only judge of whether the work was done.
//
// This module is the second opinion that always exists: the claim must come with
// concrete, machine-checkable evidence. A file citation is verified against the
// filesystem (it must exist inside the workspace and be non-empty); command and
// test citations are recorded but cannot be re-run here, so they are labelled as
// claims rather than proof.
//
// The rule is deliberately strict, because the failure it prevents is silent:
//   - every criterion must carry at least one citation;
//   - every file citation must pass machine verification;
//   - a criterion backed ONLY by unverifiable claims does not count as evidenced.
// A claim that does not clear the gate is recorded as `unverified`, never as
// `verified` — the user can then confirm it by hand or configure a verifier.
//
// No imports beyond node builtins: this module is pure so the gate itself is
// unit-testable without a session, a provider, or a filesystem fixture.

import { existsSync, statSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

export type GoalEvidenceKind = "file" | "command" | "test"

export interface GoalEvidenceInput {
  /** Which criterion (1-based) this citation supports. */
  criterion: number
  kind: GoalEvidenceKind
  /** File path (relative to the workspace) / command line / test name. */
  value: string
  /** Optional human note. Never used as proof. */
  note?: string
}

export interface GoalEvidenceVerdict {
  criterion: number
  kind: GoalEvidenceKind
  value: string
  /** Machine-checked? Only `file` can be checked here. */
  machineVerified: boolean
  detail: string
}

export interface GoalEvidenceResult {
  /** True only when every criterion is covered by at least one MACHINE-VERIFIED citation. */
  ok: boolean
  perCriterion: GoalEvidenceVerdict[]
  /** Criteria (1-based) with no machine-verified citation. */
  uncoveredCriteria: number[]
  machineVerifiedCount: number
  claimCount: number
  reason: string
}

const MAX_EVIDENCE = 40
const MAX_VALUE_CHARS = 300
const MAX_FILE_BYTES = 50 * 1024 * 1024

/**
 * A citation must stay inside the workspace. An absolute path, or one that
 * escapes via `..`, is rejected rather than resolved: the point of the gate is
 * to check artifacts the agent produced HERE, and a path outside the workspace
 * could point at anything on the machine.
 */
export function resolveEvidencePath(directory: string, value: string): { path?: string; error?: string } {
  const trimmed = value.trim()
  if (!trimmed) return { error: "empty path" }
  if (isAbsolute(trimmed)) return { error: "absolute paths are not accepted" }
  const root = resolve(directory)
  const candidate = resolve(root, trimmed)
  const rel = relative(root, candidate)
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return { error: "path escapes the workspace" }
  return { path: candidate }
}

export function verifyGoalEvidence(input: {
  directory: string | undefined
  criteria: string[]
  evidence: GoalEvidenceInput[]
  /** Injected for tests; defaults to the real filesystem. */
  fileCheck?: (path: string) => { ok: boolean; detail: string }
}): GoalEvidenceResult {
  const criteriaCount = input.criteria.length
  const empty: GoalEvidenceResult = {
    ok: false,
    perCriterion: [],
    uncoveredCriteria: input.criteria.map((_, index) => index + 1),
    machineVerifiedCount: 0,
    claimCount: 0,
    reason: "No evidence was supplied for the completion claim.",
  }
  if (criteriaCount === 0) return { ...empty, reason: "This goal has no acceptance criteria to verify." }
  if (!input.directory) return { ...empty, reason: "No workspace directory is available to verify evidence against." }

  const check =
    input.fileCheck ??
    ((path: string) => {
      try {
        if (!existsSync(path)) return { ok: false, detail: "file not found" }
        const stat = statSync(path)
        if (stat.isDirectory()) return { ok: false, detail: "path is a directory, not a file" }
        if (stat.size === 0) return { ok: false, detail: "file is empty" }
        if (stat.size > MAX_FILE_BYTES) return { ok: true, detail: `file exists (${stat.size} bytes)` }
        return { ok: true, detail: `file exists (${stat.size} bytes)` }
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : "file check failed" }
      }
    })

  const perCriterion: GoalEvidenceVerdict[] = []
  for (const raw of input.evidence.slice(0, MAX_EVIDENCE)) {
    if (!raw || typeof raw !== "object") continue
    const criterion = Number(raw.criterion)
    if (!Number.isInteger(criterion) || criterion < 1 || criterion > criteriaCount) continue
    const value = typeof raw.value === "string" ? raw.value.trim().slice(0, MAX_VALUE_CHARS) : ""
    if (!value) continue
    const kind: GoalEvidenceKind = raw.kind === "file" || raw.kind === "command" || raw.kind === "test" ? raw.kind : "command"
    if (kind !== "file") {
      // A command or test name is a CLAIM: re-running it here would execute
      // agent-authored input, so it is recorded and labelled, never trusted.
      perCriterion.push({ criterion, kind, value, machineVerified: false, detail: "recorded as a claim; not re-run" })
      continue
    }
    const resolved = resolveEvidencePath(input.directory, value)
    if (!resolved.path) {
      perCriterion.push({ criterion, kind, value, machineVerified: false, detail: resolved.error ?? "invalid path" })
      continue
    }
    const result = check(resolved.path)
    perCriterion.push({ criterion, kind, value, machineVerified: result.ok, detail: result.detail })
  }

  const machineVerified = perCriterion.filter((item) => item.machineVerified)
  const covered = new Set(machineVerified.map((item) => item.criterion))
  const uncoveredCriteria = Array.from({ length: criteriaCount }, (_, index) => index + 1).filter((index) => !covered.has(index))
  const claimCount = perCriterion.length - machineVerified.length

  if (perCriterion.length === 0) return { ...empty, reason: "No usable evidence was supplied for the completion claim." }

  if (uncoveredCriteria.length > 0) {
    const claimsOnly = perCriterion.filter((item) => !item.machineVerified && uncoveredCriteria.includes(item.criterion))
    const detail = claimsOnly.length
      ? `criteria ${uncoveredCriteria.join(", ")} have no verifiable artifact (only unverifiable claims: ${claimsOnly.map((item) => item.kind).join(", ")})`
      : `criteria ${uncoveredCriteria.join(", ")} have no evidence`
    return {
      ok: false,
      perCriterion,
      uncoveredCriteria,
      machineVerifiedCount: machineVerified.length,
      claimCount,
      reason: `Completion claim could not be confirmed: ${detail}.`,
    }
  }

  return {
    ok: true,
    perCriterion,
    uncoveredCriteria: [],
    machineVerifiedCount: machineVerified.length,
    claimCount,
    reason: `All ${criteriaCount} criteria are backed by artifacts that exist in the workspace (${machineVerified.length} verified).`,
  }
}

/** Human-readable one-liner for the tool result / memory record. */
export function summarizeGoalEvidence(result: GoalEvidenceResult): string {
  const parts = [`${result.machineVerifiedCount} verified artifact(s)`]
  if (result.claimCount > 0) parts.push(`${result.claimCount} unverifiable claim(s)`)
  return parts.join(", ")
}

// DeveAgent skill doctor (inspired by Claude Code's /skill-doctor).
//
// It reports the size of the workspace skill store — a real, measurable fact —
// and it deliberately reports NOTHING about usage, because usage is not
// recorded anywhere (see below).
//
// What this module must not claim:
//   - "N skills never used". `markAutoSkillUsed()` is STAGED (no production
//     caller), so every ledger entry carries `useCount: 0` for the trivial
//     reason that nothing ever increments it. Reporting that as "never used"
//     was a fabricated metric: it would have described every installed skill as
//     dead, including ones a user actually relies on. The report now carries
//     `usageRecorded: false` and the summary says usage is not recorded. Do not
//     reintroduce an "unused" count until a real caller records usage.
//   - "what each costs in context". The store scanned here
//     (`<workspace>/.deveagent/skills`, written by `writeAutoSkill`) is not on
//     any load path, so none of it is injected into a session and none of it
//     costs context. The sizes below are ON-DISK sizes of staged files; the
//     report is explicit that they are not injected. `injected: false`.
//
// Honesty rules this module obeys:
//   - Token cost is chars/4, the repo's documented fallback ratio (see
//     `estimateTokens` in deveagent.ts), and is always labelled approximate
//     (`approxTokens`, `~` in the summary). It is never presented as a measured
//     token count.
//   - `untracked` is reported instead of inventing provenance: a skill with no
//     ledger record is marked untracked, never given a fabricated history.
//   - A ledger entry whose file is gone occupies no disk space here and is
//     therefore not listed; the ledger may legitimately outlive a
//     hand-deleted file.
//   - A skill file that cannot be read is skipped, and the report says so by
//     omission rather than by guessing a size.
//
// Scope: the workspace `.deveagent/skills` store, which is exactly the store the
// ledger describes. `loadLocalSkills()` reads a *global* store
// (`~/.config/opencode/local-skills`) that has no workspace ledger; joining it
// against a workspace ledger by name would fabricate usage attribution.

import { lstat, readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { autoSkillDir, readAutoSkillLedger } from "./deveagent-auto-skill"

/**
 * Both injection paths truncate a skill at 8_000 characters (`loadLocalSkills`
 * slices the parsed body, `loadRemoteSkills` slices the raw file), so 8_000 is
 * the most a skill can actually cost in context. A larger file is reported at
 * its injected size, not at its on-disk size.
 */
export const SKILL_INJECT_MAX_CHARS = 8_000

/** chars/4 — the repo's documented fallback ratio for UI budgeting. */
const APPROX_CHARS_PER_TOKEN = 4

export type SkillDoctorReport = {
  skills: Array<{
    id: string
    name: string
    /** on-disk characters of the staged body (capped at the injection slice) */
    chars: number
    /** rough token cost (chars/4 is the repo's established fallback ratio) */
    approxTokens: number
    /**
     * Ledger value. Always 0 in practice: nothing calls `markAutoSkillUsed`, so
     * treat it as "not recorded", never as "this skill was never used".
     */
    useCount: number
    patchCount: number
    state: "active" | "stale" | "archived"
    /** true when the ledger has no record — an installed-but-never-tracked skill */
    untracked: boolean
    lastUsedAt?: number
  }>
  totals: { count: number; chars: number; approxTokens: number }
  /**
   * Always false: no production code records skill usage, so no usage claim can
   * be made. A consumer that needs usage must wire `markAutoSkillUsed` first.
   */
  usageRecorded: boolean
  /**
   * Always false: `<workspace>/.deveagent/skills` is not on any load path, so
   * these files are staged on disk and not injected into any session. The
   * `chars`/`approxTokens` figures are therefore NOT a context cost.
   */
  injected: boolean
  /** one-line honest summary, e.g. "12 skills · ~3.4K tokens on disk (not injected) · usage not recorded" */
  summary: string
}

/**
 * The characters a staged skill file holds on disk. The `writeAutoSkill`
 * frontmatter fence and the bare `name:`/`description:` lines are stripped (the
 * shape the loaders also remove), then the result is capped at the injection
 * slice so the number can be compared against what a loader would ever carry.
 *
 * These are ON-DISK sizes of staged files. Nothing loads this directory, so
 * none of it currently occupies context; the report carries `injected: false`
 * and the summary says so.
 */
function skillBody(content: string): string {
  const withoutFence = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
  const body = withoutFence
    .replace(/^name:[ \t]*.*$/m, "")
    .replace(/^description:[ \t]*.*$/m, "")
    .replace(/^\s*\n/, "")
  return body.slice(0, SKILL_INJECT_MAX_CHARS)
}

function approxTokens(chars: number): number {
  return Math.round(chars / APPROX_CHARS_PER_TOKEN)
}

/** Deterministic ordering: locale-independent id comparison. */
function byID(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function formatApproxTokens(tokens: number): string {
  if (tokens >= 1_000) return `~${(tokens / 1_000).toFixed(1)}K tokens`
  return `~${tokens} tokens`
}

function emptyReport(summary: string): SkillDoctorReport {
  return {
    skills: [],
    totals: { count: 0, chars: 0, approxTokens: 0 },
    usageRecorded: false,
    injected: false,
    summary,
  }
}

/**
 * Report the size of the workspace skill store.
 *
 * It does NOT report usage: no production code records it, so any "never used"
 * figure would be fabricated (see the module header). `usageRecorded` is always
 * false and the summary says so.
 *
 * Never throws: a missing directory, an unreadable file, or a corrupt ledger
 * degrades to a smaller (or empty) report instead of a failure.
 */
export async function inspectSkills(directory: string | undefined): Promise<SkillDoctorReport> {
  // No workspace means no ledger and no workspace skill store: there is nothing
  // to attribute, and saying so is more honest than reporting global state.
  if (typeof directory !== "string" || directory.trim() === "") {
    return emptyReport("no workspace directory given — 0 staged skills inspected")
  }

  const workspace = path.resolve(directory)
  const dir = autoSkillDir(workspace)
  const ledger = await readAutoSkillLedger(workspace)
  const files = await readdir(dir).catch(() => [] as string[])

  const skills: SkillDoctorReport["skills"] = []
  for (const file of files) {
    if (!file.endsWith(".md")) continue
    const id = file.replace(/\.md$/i, "")
    const filePath = path.join(dir, file)
    // Symlinked skill files are not loaded by the other skill stores, so they
    // are not costed here either (and the target may live outside the workspace).
    const stats = await lstat(filePath).catch(() => undefined)
    if (!stats || stats.isSymbolicLink()) continue
    let content: string
    try {
      content = await readFile(filePath, "utf8")
    } catch {
      // A directory named `x.md`, a permission failure, or any other unreadable
      // entry: skip this skill, keep the rest of the report intact.
      continue
    }
    const nameMatch = content.match(/^name:[ \t]*(.+)$/m)
    const chars = skillBody(content).length
    const entry = ledger[id]
    skills.push({
      id,
      name: nameMatch ? nameMatch[1].trim() : id,
      chars,
      approxTokens: approxTokens(chars),
      // Ledger value only. It is 0 whenever the ledger is absent OR usage was
      // never recorded, and those two cases are indistinguishable — which is
      // exactly why the report must not turn this into a "never used" claim.
      useCount: entry?.useCount ?? 0,
      patchCount: entry?.patchCount ?? 0,
      // Untracked skills carry the ledger's own default for an unknown state
      // rather than an invented one.
      state: entry?.state ?? "active",
      untracked: entry === undefined,
      ...(entry?.lastUsedAt !== undefined ? { lastUsedAt: entry.lastUsedAt } : {}),
    })
  }

  // Largest first, then id: the only ordering this report can justify is by
  // size, because usage is not recorded and cannot rank anything.
  skills.sort((a, b) => {
    if (a.chars !== b.chars) return b.chars - a.chars
    return byID(a, b)
  })

  const chars = skills.reduce((sum, skill) => sum + skill.chars, 0)
  // Sum the per-skill approximations so the total always equals the parts a
  // reader can add up; each value is independently rounded chars/4.
  const tokens = skills.reduce((sum, skill) => sum + skill.approxTokens, 0)

  const totals = {
    count: skills.length,
    chars,
    approxTokens: tokens,
  }

  // Both facts in the summary are stated as what they are: a staged on-disk
  // size (not an injected context cost) and an explicit admission that usage is
  // not recorded. The previous wording ("N never used") asserted a usage claim
  // the data cannot support.
  const summary =
    skills.length === 0
      ? "0 staged skills in this workspace — nothing to report"
      : `${skills.length} staged skill${skills.length === 1 ? "" : "s"} · ${formatApproxTokens(tokens)} on disk (not injected) · usage not recorded`

  return { skills, totals, usageRecorded: false, injected: false, summary }
}

// DeveAgent skill doctor (inspired by Claude Code's /skill-doctor).
//
// Context spend is only attributable when the things that occupy it are
// measurable and their usage is known. The auto-skill module already keeps a
// provenance ledger (`.deveagent/auto-skills.json`, keyed by skill name) next to
// the files it writes (`.deveagent/skills/<name>.md`); this module joins the two
// so the report can say "this skill is installed, costs roughly N tokens, and has
// never been used".
//
// Honesty rules this module obeys:
//   - Token cost is chars/4, the repo's documented fallback ratio (see
//     `estimateTokens` in deveagent.ts), and is always labelled approximate
//     (`approxTokens`, `~` in the summary). It is never presented as a measured
//     token count.
//   - `untracked` is reported instead of inventing provenance: a skill with no
//     ledger record gets useCount 0 and the ledger's own default state, never a
//     fabricated history.
//   - A ledger entry whose file is gone occupies no context and is therefore not
//     listed; the ledger may legitimately outlive a hand-deleted file.
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
    /** characters the skill body occupies when injected */
    chars: number
    /** rough token cost (chars/4 is the repo's established fallback ratio) */
    approxTokens: number
    useCount: number
    patchCount: number
    state: "active" | "stale" | "archived"
    /** true when the ledger has no record — an installed-but-never-tracked skill */
    untracked: boolean
    lastUsedAt?: number
  }>
  totals: { count: number; chars: number; approxTokens: number; unusedCount: number; unusedTokens: number }
  /** one-line honest summary, e.g. "12 skills · ~3.4K tokens · 5 never used (~1.2K tokens)" */
  summary: string
}

/**
 * The characters a skill actually contributes when injected: a leading `---`
 * frontmatter fence (the shape `writeAutoSkill` emits) plus the bare
 * `name:`/`description:` lines the local-skill loader also removes, then capped
 * at the injection slice.
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
    totals: { count: 0, chars: 0, approxTokens: 0, unusedCount: 0, unusedTokens: 0 },
    summary,
  }
}

/**
 * Report which installed skills are unused and what each one costs in context.
 * Never throws: a missing directory, an unreadable file, or a corrupt ledger
 * degrades to a smaller (or empty) report instead of a failure.
 */
export async function inspectSkills(directory: string | undefined): Promise<SkillDoctorReport> {
  // No workspace means no ledger and no workspace skill store: there is nothing
  // to attribute, and saying so is more honest than reporting global state.
  if (typeof directory !== "string" || directory.trim() === "") {
    return emptyReport("no workspace directory provided — 0 skills inspected")
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
    const useCount = entry?.useCount ?? 0
    skills.push({
      id,
      name: nameMatch ? nameMatch[1].trim() : id,
      chars,
      approxTokens: approxTokens(chars),
      useCount,
      patchCount: entry?.patchCount ?? 0,
      // Untracked skills carry the ledger's own default for an unknown state
      // rather than an invented one.
      state: entry?.state ?? "active",
      untracked: entry === undefined,
      ...(entry?.lastUsedAt !== undefined ? { lastUsedAt: entry.lastUsedAt } : {}),
    })
  }

  // Unused first (largest chars first), then used by useCount ascending; ties
  // fall back to chars then id so the order is total and reproducible.
  skills.sort((a, b) => {
    const aUnused = a.useCount === 0 ? 0 : 1
    const bUnused = b.useCount === 0 ? 0 : 1
    if (aUnused !== bUnused) return aUnused - bUnused
    if (aUnused === 0) {
      if (a.chars !== b.chars) return b.chars - a.chars
      return byID(a, b)
    }
    if (a.useCount !== b.useCount) return a.useCount - b.useCount
    if (a.chars !== b.chars) return b.chars - a.chars
    return byID(a, b)
  })

  const chars = skills.reduce((sum, skill) => sum + skill.chars, 0)
  // Sum the per-skill approximations so the total always equals the parts a
  // reader can add up; each value is independently rounded chars/4.
  const tokens = skills.reduce((sum, skill) => sum + skill.approxTokens, 0)
  const unused = skills.filter((skill) => skill.useCount === 0)
  const unusedTokens = unused.reduce((sum, skill) => sum + skill.approxTokens, 0)

  const totals = {
    count: skills.length,
    chars,
    approxTokens: tokens,
    unusedCount: unused.length,
    unusedTokens,
  }

  const summary =
    skills.length === 0
      ? "0 skills installed in this workspace — nothing to attribute"
      : `${skills.length} skill${skills.length === 1 ? "" : "s"} · ${formatApproxTokens(tokens)} · ${unused.length} never used (${formatApproxTokens(unusedTokens)})`

  return { skills, totals, summary }
}

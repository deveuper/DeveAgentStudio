import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  AUTO_SKILL_DESC_LIMIT,
  autoSkillDir,
  canAutoWrite,
  markAutoSkillUsed,
  readAutoSkillLedger,
  runAutoSkillMaintenance,
  shouldRunAutoSkillReview,
  validateAutoSkill,
  writeAutoSkill,
} from "./deveagent-auto-skill"

const withDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deveagent-auto-skill-"))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

describe("auto-skill reviewer trigger", () => {
  test("fires only after enough tool iterations on a clean, finished turn", () => {
    // Hermes fires on a tool-iteration counter, not at session end: long
    // sessions never "end", and a mid-task review would capture half-done work.
    expect(shouldRunAutoSkillReview({ toolIterationsSinceLastSkill: 9, hadFinalAnswer: true, interrupted: false, enabled: true })).toBe(false)
    expect(shouldRunAutoSkillReview({ toolIterationsSinceLastSkill: 10, hadFinalAnswer: true, interrupted: false, enabled: true })).toBe(true)
    expect(shouldRunAutoSkillReview({ toolIterationsSinceLastSkill: 50, hadFinalAnswer: false, interrupted: false, enabled: true })).toBe(false)
    expect(shouldRunAutoSkillReview({ toolIterationsSinceLastSkill: 50, hadFinalAnswer: true, interrupted: true, enabled: true })).toBe(false)
    expect(shouldRunAutoSkillReview({ toolIterationsSinceLastSkill: 50, hadFinalAnswer: true, interrupted: false, enabled: false })).toBe(false)
  })
})

describe("auto-skill validation", () => {
  test("rejects names that cannot round-trip through the index", () => {
    expect(validateAutoSkill({ name: "Fix Bugs", description: "d", body: "b" })).toMatchObject({ ok: true, name: "fix-bugs" })
    expect(validateAutoSkill({ name: "!!!", description: "d", body: "b" }).ok).toBe(false)
    // Leading punctuation is stripped, not rejected: "-leading" -> "leading".
    expect(validateAutoSkill({ name: "-leading", description: "d", body: "b" })).toMatchObject({ ok: true, name: "leading" })
    expect(validateAutoSkill({ name: "x".repeat(65), description: "d", body: "b" }).ok).toBe(false)
    expect(validateAutoSkill({ name: "fix-bugs.v2", description: "d", body: "b" }).ok).toBe(true)
  })

  test("caps the description at the index truncation limit", () => {
    const long = "x".repeat(AUTO_SKILL_DESC_LIMIT + 1)
    const result = validateAutoSkill({ name: "n", description: long, body: "b" })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain(String(AUTO_SKILL_DESC_LIMIT))
    expect(validateAutoSkill({ name: "n", description: "x".repeat(AUTO_SKILL_DESC_LIMIT), body: "b" }).ok).toBe(true)
  })

  test("normalizes the description but requires real content", () => {
    const result = validateAutoSkill({ name: "Tidy Logs", description: "  collapse   dup  lines ", body: "## Procedure\n1. x" })
    expect(result.ok).toBe(true)
    expect(result.ok === true && result.name).toBe("tidy-logs")
    expect(result.ok === true && result.description).toBe("collapse dup lines")
    expect(validateAutoSkill({ name: "x", description: "d", body: "   " }).ok).toBe(false)
  })
})

describe("auto-skill writes and provenance", () => {
  test("writes frontmatter the existing loader can parse, and records provenance", async () => {
    await withDir(async (dir) => {
      const result = await writeAutoSkill({ directory: dir, name: "Collapse Logs", description: "dedupe log lines", body: "## Procedure\n1. read\n2. dedupe" })
      expect(result.ok).toBe(true)
      const file = path.join(autoSkillDir(dir), "collapse-logs.md")
      const content = await readFile(file, "utf8")
      expect(content.startsWith("---\nname: collapse-logs\n")).toBe(true)
      expect(content).toContain("description: dedupe log lines")
      const ledger = await readAutoSkillLedger(dir)
      expect(ledger["collapse-logs"]).toMatchObject({ createdBy: "agent", useCount: 0, patchCount: 0, state: "active" })
    })
  })

  test("refuses to overwrite a user-authored or pinned skill", async () => {
    await withDir(async (dir) => {
      const ledgerFile = path.join(dir, ".deveagent", "auto-skills.json")
      await mkdir(path.dirname(ledgerFile), { recursive: true })
      await writeFile(ledgerFile, JSON.stringify({ version: 1, skills: {
        "mine": { createdBy: "user", createdAt: Date.now(), useCount: 0, patchCount: 0, state: "active" },
        "pinned-one": { createdBy: "agent", createdAt: Date.now(), useCount: 0, patchCount: 0, pinned: true, state: "active" },
      } }), "utf8")
      expect(canAutoWrite(await readAutoSkillLedger(dir), "mine")).toMatchObject({ ok: false })
      expect(canAutoWrite(await readAutoSkillLedger(dir), "pinned-one")).toMatchObject({ ok: false })
      expect(canAutoWrite(await readAutoSkillLedger(dir), "brand-new")).toEqual({ ok: true })
      const blocked = await writeAutoSkill({ directory: dir, name: "mine", description: "hijack", body: "x" })
      expect(blocked.ok).toBe(false)
    })
  })

  test("patching bumps patchCount while a fresh write starts at zero", async () => {
    await withDir(async (dir) => {
      await writeAutoSkill({ directory: dir, name: "flow", description: "one", body: "a" })
      await writeAutoSkill({ directory: dir, name: "flow", description: "two", body: "b", patch: true })
      const ledger = await readAutoSkillLedger(dir)
      expect(ledger["flow"].patchCount).toBe(1)
      expect(ledger["flow"].createdAt).toBeLessThanOrEqual(Date.now())
    })
  })

  test("usage tracking feeds staleness without deleting anything", async () => {
    await withDir(async (dir) => {
      await writeAutoSkill({ directory: dir, name: "old-flow", description: "old", body: "a" })
      await writeAutoSkill({ directory: dir, name: "fresh-flow", description: "fresh", body: "a" })
      const ledgerFile = path.join(dir, ".deveagent", "auto-skills.json")
      const raw = JSON.parse(await readFile(ledgerFile, "utf8"))
      const DAY = 24 * 60 * 60 * 1_000
      raw.skills["old-flow"].lastUsedAt = Date.now() - 100 * DAY
      raw.skills["fresh-flow"].lastUsedAt = Date.now() - 40 * DAY
      await writeFile(ledgerFile, JSON.stringify(raw), "utf8")

      const result = await runAutoSkillMaintenance(dir)
      expect(result.archived).toEqual(["old-flow"])
      expect(result.stale).toEqual(["fresh-flow"])
      const after = await readAutoSkillLedger(dir)
      expect(after["old-flow"].state).toBe("archived")
      expect(after["fresh-flow"].state).toBe("stale")
      // The skill file itself is untouched — archive is a ledger state.
      expect(await readFile(path.join(autoSkillDir(dir), "old-flow.md"), "utf8")).toContain("name: old-flow")

      await markAutoSkillUsed(dir, "fresh-flow")
      const revived = await readAutoSkillLedger(dir)
      expect(revived["fresh-flow"]).toMatchObject({ state: "active", useCount: 1 })
    })
  })

  test("a corrupt ledger degrades to empty instead of throwing", async () => {
    await withDir(async (dir) => {
      const ledgerFile = path.join(dir, ".deveagent", "auto-skills.json")
      await mkdir(path.dirname(ledgerFile), { recursive: true })
      await writeFile(ledgerFile, "{ not json", "utf8")
      expect(await readAutoSkillLedger(dir)).toEqual({})
    })
  })
})

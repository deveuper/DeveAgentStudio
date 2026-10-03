import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { markAutoSkillUsed, writeAutoSkill } from "./deveagent-auto-skill"
import { SKILL_INJECT_MAX_CHARS, inspectSkills } from "./deveagent-skill-doctor"

const withDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deveagent-skill-doctor-"))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

const skillsDir = (dir: string) => path.join(dir, ".deveagent", "skills")
const ledgerFile = (dir: string) => path.join(dir, ".deveagent", "auto-skills.json")

/** Write a skill file in the shape the local-skill store uses (no frontmatter fence). */
async function writeRawSkill(dir: string, id: string, body: string, name = id) {
  await mkdir(skillsDir(dir), { recursive: true })
  await writeFile(path.join(skillsDir(dir), `${id}.md`), `name: ${name}\ndescription: ${id} desc\n\n${body}`, "utf8")
}

/** Write a ledger directly so a test can set states the writer never produces. */
async function writeLedger(dir: string, skills: Record<string, Record<string, unknown>>) {
  await mkdir(path.dirname(ledgerFile(dir)), { recursive: true })
  await writeFile(ledgerFile(dir), JSON.stringify({ version: 1, skills }), "utf8")
}

describe("skill doctor: empty and missing inputs", () => {
  test("an empty skills directory reports zero cost without failing", async () => {
    await withDir(async (dir) => {
      const report = await inspectSkills(dir)
      expect(report.skills).toEqual([])
      expect(report.totals).toEqual({ count: 0, chars: 0, approxTokens: 0 })
      expect(report.summary).toContain("0 staged skills")
      expect(report.summary).toContain("nothing to report")
    })
  })

  test("an undefined directory returns an empty report that says so", async () => {
    for (const value of [undefined, "", "   "]) {
      const report = await inspectSkills(value as string | undefined)
      expect(report.skills).toEqual([])
      expect(report.totals.count).toBe(0)
      expect(report.summary).toContain("no workspace directory")
      expect(report.summary).toContain("0 staged skills")
    }
  })

  test("the report never asserts usage it has no data for", async () => {
    // H3: markAutoSkillUsed is STAGED (no production caller), so every ledger
    // useCount is 0 for a trivial reason. Reporting that as "never used" was a
    // fabricated metric — this locks the honest replacement in place.
    await withDir(async (dir) => {
      await writeRawSkill(dir, "looks-unused", "## Procedure\n1. step")
      const report = await inspectSkills(dir)
      expect(report.usageRecorded).toBe(false)
      // Neither the summary nor the serialized report may claim non-use.
      expect(report.summary).not.toContain("never used")
      expect(report.summary).not.toContain("unused")
      expect(JSON.stringify(report)).not.toContain("unusedCount")
      expect(JSON.stringify(report)).not.toContain("unusedTokens")
      // The per-skill count still exists as raw ledger data, but the report
      // labels the whole dimension as unrecorded rather than interpreting it.
      expect(report.skills[0].useCount).toBe(0)
    })
  })

  test("the report does not present staged on-disk bytes as an injected context cost", async () => {
    // H4: this store is not on any load path, so its files cost no context.
    await withDir(async (dir) => {
      await writeRawSkill(dir, "staged", "x".repeat(400))
      const report = await inspectSkills(dir)
      expect(report.injected).toBe(false)
      expect(report.summary).toContain("on disk")
      expect(report.summary).toContain("not injected")
      // The size is still reported — it is a real, measurable fact about disk.
      expect(report.skills[0].chars).toBe(400)
    })
  })
})

describe("skill doctor: provenance join", () => {
  test("a skill with no ledger record is untracked and unused, never invented", async () => {
    await withDir(async (dir) => {
      await writeRawSkill(dir, "orphan", "## Procedure\n1. step")
      const report = await inspectSkills(dir)
      expect(report.skills).toHaveLength(1)
      expect(report.skills[0]).toMatchObject({
        id: "orphan",
        name: "orphan",
        useCount: 0,
        patchCount: 0,
        untracked: true,
        state: "active",
      })
      expect(report.skills[0].lastUsedAt).toBeUndefined()
    })
  })

  test("a tracked skill reports its real use/patch counts and lastUsedAt", async () => {
    await withDir(async (dir) => {
      await writeAutoSkill({ directory: dir, name: "flow", description: "one", body: "a" })
      await writeAutoSkill({ directory: dir, name: "flow", description: "two", body: "b", patch: true })
      await markAutoSkillUsed(dir, "flow")
      const report = await inspectSkills(dir)
      expect(report.skills[0]).toMatchObject({ id: "flow", useCount: 1, patchCount: 1, untracked: false })
      expect(typeof report.skills[0].lastUsedAt).toBe("number")
    })
  })

  test("archived skills are still reported with their on-disk size", async () => {
    await withDir(async (dir) => {
      await writeRawSkill(dir, "old-flow", "## Procedure\n1. archived but still on disk")
      await writeLedger(dir, {
        "old-flow": { createdBy: "agent", createdAt: Date.now(), useCount: 0, patchCount: 0, state: "archived" },
      })
      const report = await inspectSkills(dir)
      expect(report.skills).toHaveLength(1)
      expect(report.skills[0].state).toBe("archived")
      expect(report.skills[0].approxTokens).toBeGreaterThan(0)
      // The archived state is real ledger data and is reported. Its `useCount: 0`
      // is NOT interpreted as "unused" — nothing records usage, so the report
      // carries no unused total at all.
      expect(report.skills[0].useCount).toBe(0)
      expect(report.usageRecorded).toBe(false)
    })
  })

  test("a ledger entry whose file is gone is not costed", async () => {
    await withDir(async (dir) => {
      await writeLedger(dir, {
        ghost: { createdBy: "agent", createdAt: Date.now(), useCount: 3, patchCount: 0, state: "active" },
      })
      const report = await inspectSkills(dir)
      expect(report.skills).toEqual([])
      expect(report.summary).toContain("0 staged skills")
    })
  })
})

describe("skill doctor: ordering", () => {
  test("skills are ordered by descending size, then by id", async () => {
    await withDir(async (dir) => {
      // Frontmatter is stripped before sizing, so body length drives the order.
      // Usage cannot order anything (it is not recorded), so size is the only
      // ranking this report can justify.
      await writeAutoSkill({ directory: dir, name: "alpha", description: "a", body: "x".repeat(10) })
      await writeAutoSkill({ directory: dir, name: "beta", description: "b", body: "x".repeat(100) })
      await writeAutoSkill({ directory: dir, name: "gamma", description: "c", body: "x".repeat(20) })
      await writeAutoSkill({ directory: dir, name: "delta", description: "d", body: "x".repeat(30) })
      // Writing ledger usage directly must NOT reorder the report: the doctor
      // reports size, and usage is not a dimension it claims to know.
      for (let i = 0; i < 5; i++) await markAutoSkillUsed(dir, "gamma")
      for (let i = 0; i < 2; i++) await markAutoSkillUsed(dir, "delta")
      const report = await inspectSkills(dir)
      expect(report.skills.map((skill) => skill.id)).toEqual(["beta", "delta", "gamma", "alpha"])
    })
  })

  test("equal sizes fall back to id so the order is total and reproducible", async () => {
    await withDir(async (dir) => {
      await writeAutoSkill({ directory: dir, name: "zulu", description: "z", body: "x".repeat(50) })
      await writeAutoSkill({ directory: dir, name: "alpha", description: "a", body: "x".repeat(50) })
      const report = await inspectSkills(dir)
      expect(report.skills.map((skill) => skill.id)).toEqual(["alpha", "zulu"])
    })
  })
})

describe("skill doctor: cost math", () => {
  test("approxTokens is round(chars/4) and the totals are the sum of the parts", async () => {
    await withDir(async (dir) => {
      // Body only: the `name:`/`description:` lines and the blank separator are
      // stripped, and `writeRawSkill` appends no trailing newline.
      await writeRawSkill(dir, "tiny", "abcdefghij")
      const report = await inspectSkills(dir)
      const skill = report.skills[0]
      expect(skill.chars).toBe(10)
      expect(skill.approxTokens).toBe(Math.round(10 / 4))
      expect(report.totals.chars).toBe(skill.chars)
      expect(report.totals.approxTokens).toBe(skill.approxTokens)
    })
  })

  test("cost is capped at the injection slice, not the raw file size", async () => {
    await withDir(async (dir) => {
      await writeRawSkill(dir, "huge", "x".repeat(9_000))
      const report = await inspectSkills(dir)
      expect(report.skills[0].chars).toBe(SKILL_INJECT_MAX_CHARS)
      expect(report.skills[0].approxTokens).toBe(Math.round(SKILL_INJECT_MAX_CHARS / 4))
    })
  })

  test("the summary states count, on-disk tokens, and that usage is unrecorded", async () => {
    await withDir(async (dir) => {
      await writeAutoSkill({ directory: dir, name: "one", description: "u", body: "x".repeat(4_000) })
      await writeAutoSkill({ directory: dir, name: "two", description: "u", body: "x".repeat(4_000) })
      const report = await inspectSkills(dir)
      // "2 staged skills · ~2.0K tokens on disk (not injected) · usage not recorded"
      expect(report.summary).toBe("2 staged skills · ~2.0K tokens on disk (not injected) · usage not recorded")
      expect(report.totals.count).toBe(2)
      expect(report.usageRecorded).toBe(false)
      expect(report.injected).toBe(false)
      // No usage claim survives anywhere in the payload.
      expect(report.summary).not.toContain("never used")
    })
  })

  test("the singular skill is not reported as plural", async () => {
    await withDir(async (dir) => {
      await writeRawSkill(dir, "solo", "x")
      const report = await inspectSkills(dir)
      expect(report.summary).toStartWith("1 staged skill ·")
    })
  })
})

describe("skill doctor: resilience", () => {
  test("an unreadable entry is skipped without failing the whole report", async () => {
    await withDir(async (dir) => {
      await writeRawSkill(dir, "good-one", "x".repeat(40))
      // A directory named `*.md` cannot be read as a file: the doctor must drop
      // it and keep reporting the readable skills.
      await mkdir(path.join(skillsDir(dir), "broken.md"), { recursive: true })
      const report = await inspectSkills(dir)
      expect(report.skills.map((skill) => skill.id)).toEqual(["good-one"])
      expect(report.totals.count).toBe(1)
      expect(report.summary).toContain("1 staged skill ·")
    })
  })

  test("a corrupt ledger degrades to untracked skills instead of throwing", async () => {
    await withDir(async (dir) => {
      await writeRawSkill(dir, "orphan", "body")
      await mkdir(path.dirname(ledgerFile(dir)), { recursive: true })
      await writeFile(ledgerFile(dir), "{ not json", "utf8")
      const report = await inspectSkills(dir)
      expect(report.skills).toHaveLength(1)
      expect(report.skills[0].untracked).toBe(true)
    })
  })

  test("non-markdown files in the skills directory are ignored", async () => {
    await withDir(async (dir) => {
      await writeRawSkill(dir, "real", "body")
      await writeFile(path.join(skillsDir(dir), "notes.txt"), "not a skill", "utf8")
      await writeFile(path.join(skillsDir(dir), "README"), "not a skill", "utf8")
      const report = await inspectSkills(dir)
      expect(report.skills.map((skill) => skill.id)).toEqual(["real"])
    })
  })
})

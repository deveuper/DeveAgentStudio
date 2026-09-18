import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import path from "node:path"
import { rollbackPromotedSkill } from "./deveagent-skill-rollback"

describe("deveagent-skill-rollback", () => {
  test("renames the promoted skill with a rejected marker and keeps content auditable", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "deveagent-skill-rb-"))
    try {
      const skillsDir = path.join(dir, ".deveagent", "local-skills")
      await mkdir(skillsDir, { recursive: true })
      const skillPath = path.join(skillsDir, "draft-1.md")
      await writeFile(skillPath, "name: Draft\n\ndraft body", "utf8")
      const result = rollbackPromotedSkill({ directory: dir, skillPath })
      expect(result.rolledBack).toBe(true)
      expect(result.backupPath).toBeTruthy()
      const backup = readFile(result.backupPath!, "utf8")
      expect(await backup).toContain("draft body")
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })

  test("rejects paths outside the workspace skills directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "deveagent-skill-rb-out-"))
    try {
      const outside = path.join(dir, "outside.md")
      await writeFile(outside, "secret", "utf8")
      const result = rollbackPromotedSkill({ directory: dir, skillPath: outside })
      expect(result.rolledBack).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })

  test("missing skill file reports not found without throwing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "deveagent-skill-rb-missing-"))
    try {
      const result = rollbackPromotedSkill({ directory: dir, skillPath: path.join(dir, ".deveagent", "local-skills", "nope.md") })
      expect(result.rolledBack).toBe(false)
      expect(result.error).toBeTruthy()
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })
})

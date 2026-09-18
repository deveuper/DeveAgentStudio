// R159 Skill promotion rollback: a promoted local-skill draft can be rolled
// back — the draft file is renamed with a .rejected-<ts> suffix (kept for
// audit) instead of deleted. Path escape attempts are rejected.
import { existsSync, mkdirSync, renameSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const localSkillsDirResolved = (directory: string) => resolve(directory, ".deveagent", "local-skills")

export function rollbackPromotedSkill(input: {
  directory: string
  skillPath: string
}): { rolledBack: boolean; backupPath?: string; error?: string } {
  try {
    const skillPath = resolve(input.skillPath)
    const skillsDir = localSkillsDirResolved(input.directory)
    if (!skillPath.startsWith(skillsDir + sep())) return { rolledBack: false, error: "skill path is outside the workspace skills directory" }
    if (!existsSync(skillPath)) return { rolledBack: false, error: "skill file not found" }
    const backupPath = `${skillPath}.rejected-${Date.now().toString(36)}`
    mkdirSync(dirname(skillPath), { recursive: true })
    renameSync(skillPath, backupPath)
    return { rolledBack: true, backupPath }
  } catch (error) {
    return { rolledBack: false, error: error instanceof Error ? error.message.slice(0, 200) : "rollback failed" }
  }
}

function sep() {
  return process.platform === "win32" ? "\\" : "/"
}

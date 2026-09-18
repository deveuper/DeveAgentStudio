import { expect, test } from "bun:test"
import {
  applyDeveAgentWorkPackSnapshot,
  DEVEAGENT_BUILTIN_SKILLS,
  DEVEAGENT_WORK_PACKS,
  mergeDeveAgentComposerSnapshot,
  type DeveAgentComposerSnapshot,
} from "./deveagent-composer-state"

const previous: DeveAgentComposerSnapshot = {
  mode: "craft",
  permissionMode: "default",
  toolExecution: "sequential",
  tokenSaver: true,
  remoteSkills: true,
  remoteMcp: true,
  unattendedTimezone: "Asia/Shanghai",
  selectedSkills: [],
  expertTeam: [],
}

test("hydrates only valid composer controls and keeps write modes serial", () => {
  const hydrated = mergeDeveAgentComposerSnapshot(previous, {
    mode: "plan",
    permissionMode: "auto",
    toolExecution: "parallel",
    tokenSaver: false,
    selectedSkills: [{ id: "skill-a", name: "Skill A", source: "local:test", installed: true, enabled: true, risk: "trusted" }],
  })

  expect(hydrated.mode).toBe("plan")
  expect(hydrated.toolExecution).toBe("parallel")
  expect(hydrated.permissionMode).toBe("auto")
  expect(hydrated.tokenSaver).toBeFalse()
  expect(hydrated.selectedSkills).toHaveLength(1)
  expect(mergeDeveAgentComposerSnapshot(previous, { mode: "build", toolExecution: "parallel" }).toolExecution).toBe("sequential")
  expect(mergeDeveAgentComposerSnapshot(previous, { mode: "loop", toolExecution: "parallel" }).toolExecution).toBe("sequential")
})

test("does not display disabled catalog skills as loaded", () => {
  const hydrated = mergeDeveAgentComposerSnapshot(previous, {
    selectedSkills: [
      { id: "visible", name: "Visible", source: "local:test", installed: true, enabled: true, risk: "trusted" },
      { id: "catalog-only", name: "Catalog only", source: "builtin:test", installed: true, enabled: false, risk: "trusted" },
    ],
  })

  expect(hydrated.selectedSkills.map((skill) => skill.id)).toEqual(["visible"])
})

test("preserves every enabled selected skill for composer chips", () => {
  const skills = Array.from({ length: 12 }, (_, index) => ({
    id: `skill-${index}`,
    name: `Skill ${index}`,
    source: "local:test",
    installed: true,
    enabled: true,
    risk: "trusted" as const,
  }))

  const hydrated = mergeDeveAgentComposerSnapshot(previous, { selectedSkills: skills })

  expect(hydrated.selectedSkills).toHaveLength(skills.length)
  expect(hydrated.selectedSkills.at(-1)?.id).toBe("skill-11")
})

test("applies a work pack atomically without dropping custom skills or overriding permission", () => {
  const custom = { id: "custom", name: "Custom", source: "local:test", installed: true, enabled: true, risk: "trusted" as const }
  const pack = DEVEAGENT_WORK_PACKS.find((item) => item.id === "automation-qa")!
  const applied = applyDeveAgentWorkPackSnapshot(
    { ...previous, permissionMode: "yolo", selectedSkills: [custom] },
    pack,
  )

  expect(applied.mode).toBe("plan")
  expect(applied.toolExecution).toBe("parallel")
  expect(applied.permissionMode).toBe("yolo")
  expect(applied.tokenSaver).toBeTrue()
  expect(applied.selectedSkills.some((skill) => skill.id === "computer-use")).toBeTrue()
  expect(applied.selectedSkills.some((skill) => skill.id === custom.id)).toBeTrue()
})

test("writing work pack enables the prompt optimizer without changing user-defined skills", () => {
  const custom = { id: "novel-style", name: "Novel Style", source: "local:test", installed: true, enabled: true, risk: "trusted" as const }
  const pack = DEVEAGENT_WORK_PACKS.find((item) => item.id === "writing")!
  const applied = applyDeveAgentWorkPackSnapshot({ ...previous, selectedSkills: [custom] }, pack)

  expect(applied.mode).toBe("craft")
  expect(applied.selectedSkills.some((skill) => skill.id === "prompt-optimizer")).toBeTrue()
  expect(applied.selectedSkills.some((skill) => skill.id === custom.id)).toBeTrue()
})

test("DEVEAGENT_WORK_PACKS expands to ten packs, each referencing real builtin skills", () => {
  expect(DEVEAGENT_WORK_PACKS).toHaveLength(10)
  const ids = new Set(DEVEAGENT_WORK_PACKS.map((pack) => pack.id))
  expect(ids.size).toBe(10)
  const validSkills = new Set(DEVEAGENT_BUILTIN_SKILLS.map((skill) => skill.id))
  for (const pack of DEVEAGENT_WORK_PACKS) {
    expect(pack.id.length).toBeGreaterThan(0)
    expect(pack.name.length).toBeGreaterThan(0)
    for (const skillID of pack.skillIDs) {
      expect(validSkills.has(skillID), `${pack.id} references unknown skill ${skillID}`).toBeTrue()
    }
  }
})

test("applying a role-bound pack sets the role and a role-less pack clears it", () => {
  const reviewPack = DEVEAGENT_WORK_PACKS.find((item) => item.id === "security-review")!
  const applied = applyDeveAgentWorkPackSnapshot({ ...previous, role: "coder" }, reviewPack)
  expect(applied.role).toBe("reviewer")

  const roleLess = { ...reviewPack, role: undefined }
  const cleared = applyDeveAgentWorkPackSnapshot(applied, roleLess)
  expect(cleared.role).toBeUndefined()
})

test("mergeDeveAgentComposerSnapshot sanitizes invalid roles away", () => {
  expect(mergeDeveAgentComposerSnapshot(previous, { role: "reviewer" }).role).toBe("reviewer")
  expect(mergeDeveAgentComposerSnapshot(previous, { role: "Bad Role!" }).role).toBeUndefined()
  expect(mergeDeveAgentComposerSnapshot(previous, { role: 42 as unknown as string }).role).toBeUndefined()
})

test("role length is bounded to the backend profile-key limit of 32", () => {
  const atLimit = "a" + "b".repeat(31)
  const overLimit = "a" + "b".repeat(32)
  expect(mergeDeveAgentComposerSnapshot(previous, { role: atLimit }).role).toBe(atLimit)
  expect(mergeDeveAgentComposerSnapshot(previous, { role: overLimit }).role).toBeUndefined()
})

test("role merge mirrors backend semantics: omission keeps local, explicit null clears", () => {
  const withRole = { ...previous, role: "coder" as string | undefined }
  expect(mergeDeveAgentComposerSnapshot(withRole, { mode: "plan" }).role).toBe("coder")
  expect(mergeDeveAgentComposerSnapshot(withRole, { role: null as unknown as string }).role).toBeUndefined()
  expect(mergeDeveAgentComposerSnapshot(withRole, { role: "reviewer" }).role).toBe("reviewer")
})

import { beforeEach, describe, expect, test } from "bun:test"
import {
  createDeveAgentTeamState,
  TEAM_ROLE_PRESETS,
  type DeveAgentTeamMember,
  type DeveAgentTeamRole,
} from "./deveagent-team-state"

// Neutralize async network side effects entirely. A never-settling promise means
// syncTeam/hydrateTeam neither reject (no unhandled rejection noise) nor resolve
// (no race that overwrites synchronously-asserted snapshot state).
function isolateNetwork() {
  ;(window as unknown as { __deveagentBaseUrl?: string }).__deveagentBaseUrl = ""
  ;(window as unknown as { __deveagentFetch?: () => Promise<never> }).__deveagentFetch = () => new Promise(() => {})
}

function makeMember(patch?: Partial<Omit<DeveAgentTeamMember, "id">>): Omit<DeveAgentTeamMember, "id"> {
  return {
    name: "Agent A",
    role: "reviewer",
    providerID: "deepseek",
    modelID: "deepseek-chat",
    systemPrompt: "You are a reviewer.",
    enabled: true,
    ...patch,
  }
}

describe("deveagent team state", () => {
  beforeEach(() => isolateNetwork())

  test("default snapshot is disabled sequential team with sane bounds", () => {
    const state = createDeveAgentTeamState()
    const snapshot = state.snapshot()
    expect(snapshot.enabled).toBe(false)
    expect(snapshot.runMode).toBe("sequential")
    expect(snapshot.members).toEqual([])
    expect(snapshot.maxRounds).toBe(3)
    expect(snapshot.budgetTokens).toBe(200_000)
    expect(snapshot.maxRetries).toBe(1)
  })

  test("addMember assigns id, trims name, defaults enabled true", () => {
    const state = createDeveAgentTeamState()
    const member = state.addMember(makeMember({ name: "  Planner One  ", enabled: undefined as never }))
    expect(member.id).toMatch(/^agent-/)
    expect(member.name).toBe("Planner One")
    expect(member.enabled).toBe(true)
    expect(state.snapshot().members).toHaveLength(1)
  })

  test("addMember with blank name falls back to New Agent", () => {
    const state = createDeveAgentTeamState()
    const member = state.addMember(makeMember({ name: "   " }))
    expect(member.name).toBe("New Agent")
  })

  test("updateMember merges patch only on the matching id", () => {
    const state = createDeveAgentTeamState()
    const a = state.addMember(makeMember({ name: "A" }))
    const b = state.addMember(makeMember({ name: "B" }))
    state.updateMember(a.id, { name: "A2", role: "executor" })
    const members = state.snapshot().members
    expect(members.find((m) => m.id === a.id)?.name).toBe("A2")
    expect(members.find((m) => m.id === a.id)?.role).toBe("executor")
    expect(members.find((m) => m.id === b.id)?.name).toBe("B")
  })

  test("removeMember filters by id", () => {
    const state = createDeveAgentTeamState()
    const a = state.addMember(makeMember({ name: "A" }))
    state.addMember(makeMember({ name: "B" }))
    state.removeMember(a.id)
    expect(state.snapshot().members).toHaveLength(1)
    expect(state.snapshot().members[0].name).toBe("B")
  })

  test("numeric setters clamp to safe ranges", () => {
    const state = createDeveAgentTeamState()
    state.setMaxRounds(0)
    state.setBudgetTokens(0)
    state.setMaxRetries(99)
    expect(state.snapshot().maxRounds).toBe(1)
    expect(state.snapshot().budgetTokens).toBe(10_000)
    expect(state.snapshot().maxRetries).toBe(3)
  })

  test("setEnabled and setRunMode mutate snapshot", () => {
    const state = createDeveAgentTeamState()
    state.setEnabled(true)
    state.setRunMode("debate")
    expect(state.snapshot().enabled).toBe(true)
    expect(state.snapshot().runMode).toBe("debate")
  })

  test("reset returns to default snapshot", () => {
    const state = createDeveAgentTeamState()
    state.addMember(makeMember())
    state.setEnabled(true)
    state.setMaxRounds(9)
    state.reset()
    expect(state.snapshot()).toEqual({
      enabled: false,
      members: [],
      runMode: "sequential",
      maxRounds: 3,
      budgetTokens: 200_000,
      childTimeoutMs: 120_000,
      childMaxOutputTokens: 32_000,
      maxRetries: 1,
    })
  })
})

describe("deveagent team role presets", () => {
  test("covers all seven roles", () => {
    const roles: DeveAgentTeamRole[] = ["planner", "executor", "reviewer", "researcher", "critic", "verifier", "custom"]
    for (const role of roles) {
      expect(TEAM_ROLE_PRESETS[role].label).toBeTruthy()
    }
  })

  test("executor is the only role that claims file-write authority", () => {
    // Blueprint rule #4: only one executor writes files.
    const writableRoles = Object.entries(TEAM_ROLE_PRESETS)
      .filter(([, preset]) => preset.systemPrompt.toLowerCase().includes("only role allowed to edit files"))
      .map(([role]) => role)
    expect(writableRoles).toEqual(["executor"])
    // Advisors must not claim to be the writable executor.
    const advisors = ["planner", "reviewer", "researcher", "critic", "verifier"] as const
    for (const readOnly of advisors) {
      const prompt = TEAM_ROLE_PRESETS[readOnly].systemPrompt.toLowerCase()
      expect(prompt).not.toContain("only role allowed to edit files")
    }
  })
})

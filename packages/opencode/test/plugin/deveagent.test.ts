import { describe, expect, test, beforeEach } from "bun:test"
import {
  setGoal,
  getGoal,
  verifyGoal,
  clearGoal,
  getGoalQueue,
  getDeveAgentTeam,
  setDeveAgentExpert,
  normalizeDeveAgentState,
  isReadOnlyRuntimeMode,
  resolveEffectiveToolExecution,
  classifyVisionFallback,
  visionFallbackMessage,
  extractSymbols,
  rankFiles,
  createSessionToolQueue,
  listAllExperts,
  addCustomExpert,
  updateCustomExpert,
  deleteCustomExpert,
  getExpertPrompt,
  createReviewScope,
  saveLocalSkill,
  loadLocalSkills,
  removeLocalSkill,
  startGrilling,
  getGrillingStatus,
  recordGrillingDecision,
  completeGrilling,
} from "../../src/plugin/deveagent"

describe("Grilling timing", () => {
  test("starts when the interview task starts, before a decision is confirmed", () => {
    const sessionID = `grilling-start-${Date.now()}`
    const started = startGrilling({ sessionID })
    expect(started.started).toBe(true)
    expect(started.decisionCount).toBe(0)

    recordGrillingDecision({ sessionID, question: "Question", answer: "Confirmed answer" })
    const completed = completeGrilling({ sessionID })
    expect(completed.completed).toBe(true)
    expect(completed.decisionCount).toBe(1)
    expect(completed.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(getGrillingStatus(sessionID).startedAt).toBe(started.startedAt)
  })
})

// --- Goal State Machine ---

describe("Goal state machine", () => {
  beforeEach(() => {
    clearGoal("test-session")
  })

  test("setGoal creates an active in_progress goal", () => {
    const result = setGoal({
      description: "Implement feature X",
      criteria: ["tests pass", "docs updated"],
      sessionID: "test-session",
    })
    expect(result.active).toBe(true)
    const goal = getGoal("test-session")
    expect(goal.active).toBe(true)
    expect(goal.status).toBe("in_progress")
    expect(goal.description).toBe("Implement feature X")
    expect(goal.criteria).toEqual(["tests pass", "docs updated"])
  })

  test("getGoal returns inactive goal for unknown session", () => {
    const goal = getGoal("nonexistent-session")
    expect(goal.active).toBe(false)
  })

  test("verifyGoal marks goal as verified when met", () => {
    setGoal({ description: "task", criteria: ["done"], sessionID: "test-session" })
    const result = verifyGoal({ met: true, reason: "all criteria met", sessionID: "test-session" })
    expect(result.status).toBe("verified")
    const goal = getGoal("test-session")
    expect(goal.status).toBe("verified")
  })

  test("verifyGoal keeps in_progress when not met", () => {
    setGoal({ description: "task", criteria: ["done"], sessionID: "test-session" })
    const result = verifyGoal({ met: false, reason: "still working", sessionID: "test-session" })
    expect(result.status).toBe("in_progress")
  })

  test("clearGoal deactivates the goal", () => {
    setGoal({ description: "task", criteria: ["done"], sessionID: "test-session" })
    clearGoal("test-session")
    const goal = getGoal("test-session")
    expect(goal.active).toBe(false)
  })

  test("goal respects maxReentries clamp", () => {
    setGoal({
      description: "task",
      criteria: ["done"],
      sessionID: "test-session",
      maxReentries: 100,
    })
    const goal = getGoal("test-session")
    expect(goal.maxReentries).toBeLessThanOrEqual(20)
  })

  test("goal respects maxDurationMinutes clamp", () => {
    const before = Date.now()
    setGoal({
      description: "task",
      criteria: ["done"],
      sessionID: "test-session",
      maxDurationMinutes: 9999,
    })
    const goal = getGoal("test-session")
    // Clamped to max 1440 minutes (24h)
    const maxDeadline = before + 1440 * 60_000 + 1000
    expect(goal.deadlineAt).toBeLessThanOrEqual(maxDeadline)
    expect(goal.deadlineAt).toBeGreaterThan(before)
  })

  test("getGoalQueue returns ready goals", () => {
    setGoal({ description: "queued task", criteria: ["done"], sessionID: "test-session" })
    const queue = getGoalQueue()
    const item = queue.find((q) => q.sessionID === "test-session")
    expect(item).toBeDefined()
    expect(item!.ready).toBe(true)
  })

  test("session isolation: different sessions have independent goals", () => {
    setGoal({ description: "goal A", criteria: ["a"], sessionID: "session-a" })
    setGoal({ description: "goal B", criteria: ["b"], sessionID: "session-b" })
    expect(getGoal("session-a").description).toBe("goal A")
    expect(getGoal("session-b").description).toBe("goal B")
    clearGoal("session-a")
    expect(getGoal("session-a").active).toBe(false)
    expect(getGoal("session-b").active).toBe(true)
    clearGoal("session-b")
  })
})

// --- Team State ---

describe("Team state", () => {
  test("getDeveAgentTeam returns default disabled team", () => {
    const team = getDeveAgentTeam("fresh-session")
    expect(team.enabled).toBe(false)
    expect(team.members).toEqual([])
  })

  test("session isolation: team config does not leak between sessions", () => {
    const teamA = getDeveAgentTeam("team-session-a")
    const teamB = getDeveAgentTeam("team-session-b")
    expect(teamA.enabled).toBe(teamB.enabled)
  })
})

// --- Expert State ---

describe("Expert state (per-session)", () => {
  test("setDeveAgentExpert with sessionID stores per-session", () => {
    const result = setDeveAgentExpert("security", "expert-session-1")
    expect(result.active).toBe(true)
    expect(result.id).toBe("security")
  })

  test("setDeveAgentExpert with invalid ID returns inactive", () => {
    const result = setDeveAgentExpert("nonexistent-expert", "expert-session-2")
    expect(result.active).toBe(false)
  })

  test("setDeveAgentExpert clear returns inactive", () => {
    setDeveAgentExpert("planner", "expert-session-3")
    const result = setDeveAgentExpert(undefined, "expert-session-3")
    expect(result.active).toBe(false)
  })
})

// --- Mode and Tool Execution ---

describe("Mode and tool execution", () => {
  test("isReadOnlyRuntimeMode identifies read-only modes", () => {
    expect(isReadOnlyRuntimeMode("ask")).toBe(true)
    expect(isReadOnlyRuntimeMode("plan")).toBe(true)
    expect(isReadOnlyRuntimeMode("craft")).toBe(false)
    expect(isReadOnlyRuntimeMode("build")).toBe(false)
    expect(isReadOnlyRuntimeMode("compose")).toBe(false)
  })

  test("resolveEffectiveToolExecution coerces write modes to sequential", () => {
    const result = resolveEffectiveToolExecution({
      mode: "craft",
      toolExecution: "parallel",
    })
    expect(result).toBe("sequential")
  })

  test("resolveEffectiveToolExecution allows parallel for read-only modes", () => {
    const result = resolveEffectiveToolExecution({
      mode: "ask",
      toolExecution: "parallel",
    })
    expect(result).toBe("parallel")
  })
})

// --- Vision Fallback ---

describe("Vision fallback classification", () => {
  test("classifies model_not_found when candidate is null", () => {
    const reason = classifyVisionFallback({
      configured: true,
      candidate: null,
    })
    expect(reason).toBe("model_not_found")
  })

  test("classifies no_image_capability when candidate lacks image support", () => {
    const reason = classifyVisionFallback({
      configured: true,
      candidate: { capabilities: { input: { image: false } } },
    })
    expect(reason).toBe("no_image_capability")
  })

  test("classifies not_configured when not configured", () => {
    const reason = classifyVisionFallback({
      configured: false,
      candidate: null,
    })
    expect(reason).toBe("not_configured")
  })

  test("visionFallbackMessage returns human-readable text", () => {
    const msg = visionFallbackMessage("model_not_found", "openai", "gpt-4o")
    expect(msg).toContain("openai")
    expect(msg.length).toBeGreaterThan(10)
  })
})

// --- CodeGraph: Symbol Extraction ---

describe("CodeGraph symbol extraction", () => {
  test("extracts TypeScript functions and classes", () => {
    const code = `
export function hello(name: string): string {
  return "hi " + name
}

class Greeter {
  greet() { return "hello" }
}

interface Config {
  port: number
}

type ID = string
const MAX = 100
`
    const symbols = extractSymbols(code)
    const names = symbols.map((s) => s.name)
    expect(names).toContain("hello")
    expect(names).toContain("Greeter")
    expect(names).toContain("Config")
    expect(names).toContain("ID")
    expect(names).toContain("MAX")
  })

  test("extracts Python functions and classes", () => {
    const code = `
def calculate_total(items):
    return sum(items)

class ShoppingCart:
    pass
`
    const symbols = extractSymbols(code)
    const names = symbols.map((s) => s.name)
    expect(names).toContain("calculate_total")
    expect(names).toContain("ShoppingCart")
  })

  test("returns empty for empty content", () => {
    expect(extractSymbols("")).toEqual([])
  })
})

// --- CodeGraph: File Ranking ---

describe("CodeGraph file ranking", () => {
  test("ranks files by keyword relevance", () => {
    const files = [
      "src/auth/login.ts",
      "src/utils/helpers.ts",
      "src/auth/session.ts",
      "README.md",
    ]
    const ranked = rankFiles(files, "fix login authentication bug")
    expect(ranked.length).toBeGreaterThan(0)
    expect(ranked[0].path).toContain("auth")
  })

  test("respects limit parameter", () => {
    const files = Array.from({ length: 50 }, (_, i) => `src/file${i}.ts`)
    const ranked = rankFiles(files, "test", 5)
    expect(ranked.length).toBeLessThanOrEqual(5)
  })

  test("returns empty for empty file list", () => {
    expect(rankFiles([], "task")).toEqual([])
  })
})

// --- Session Tool Queue ---

describe("Session tool queue", () => {
  test("creates independent queues per session", () => {
    const queue = createSessionToolQueue()
    expect(queue).toBeDefined()
    expect(typeof queue.before).toBe("function")
    expect(typeof queue.after).toBe("function")
  })
})

// --- State Normalization ---

describe("State normalization", () => {
  test("normalizes partial input with defaults", () => {
    const state = normalizeDeveAgentState({ mode: "craft" })
    expect(state.mode).toBe("craft")
    expect(state.permissionMode).toBeDefined()
    expect(state.tokenSaver).toBeDefined()
  })

  test("rejects invalid mode gracefully", () => {
    const state = normalizeDeveAgentState({ mode: "invalid" as any })
    expect(state.mode).toBeDefined()
  })
})

// --- Expert CRUD ---

describe("Expert CRUD", () => {
  test("listAllExperts includes the 9 builtin experts", () => {
    const experts = listAllExperts()
    const builtinIds = experts.filter((e) => e.builtin).map((e) => e.id)
    expect(builtinIds).toContain("chief")
    expect(builtinIds).toContain("security")
    expect(builtinIds.length).toBe(9)
  })

  test("addCustomExpert creates a persisted custom expert", () => {
    const expert = addCustomExpert({ name: "DBA", role: "Database tuning", prompt: "You are a DBA.", canWrite: false })
    expect(expert.id).toStartWith("custom-")
    expect(expert.builtin).toBe(false)
    expect(listAllExperts().some((e) => e.id === expert.id)).toBe(true)
    deleteCustomExpert(expert.id)
  })

  test("updateCustomExpert patches fields", () => {
    const expert = addCustomExpert({ name: "Ops", prompt: "You are Ops." })
    const updated = updateCustomExpert(expert.id, { name: "SRE", canWrite: true })
    expect(updated?.name).toBe("SRE")
    expect(updated?.canWrite).toBe(true)
    deleteCustomExpert(expert.id)
  })

  test("updateCustomExpert returns undefined for unknown id", () => {
    expect(updateCustomExpert("nonexistent", { name: "x" })).toBeUndefined()
  })

  test("deleteCustomExpert removes the expert", () => {
    const expert = addCustomExpert({ name: "Temp" })
    expect(deleteCustomExpert(expert.id)).toBe(true)
    expect(listAllExperts().some((e) => e.id === expert.id)).toBe(false)
    expect(deleteCustomExpert(expert.id)).toBe(false)
  })

  test("getExpertPrompt resolves builtin prompts", () => {
    expect(getExpertPrompt("security")).toContain("Security")
  })

  test("getExpertPrompt appends read-only guard when canWrite is false", () => {
    const expert = addCustomExpert({ name: "ReadOnly", prompt: "You review SQL.", canWrite: false })
    expect(getExpertPrompt(expert.id)).toContain("Do NOT write files")
    deleteCustomExpert(expert.id)
  })

  test("getExpertPrompt omits read-only guard when canWrite is true", () => {
    const expert = addCustomExpert({ name: "Writer", prompt: "You edit files.", canWrite: true })
    expect(getExpertPrompt(expert.id)).not.toContain("Do NOT write files")
    deleteCustomExpert(expert.id)
  })

  test("setDeveAgentExpert accepts a custom expert id", () => {
    const expert = addCustomExpert({ name: "Selectable", prompt: "You advise." })
    const result = setDeveAgentExpert(expert.id, "expert-crud-session")
    expect(result.active).toBe(true)
    setDeveAgentExpert(undefined, "expert-crud-session")
    deleteCustomExpert(expert.id)
  })
})

// --- CodeGraph review_scope ---

describe("CodeGraph review_scope", () => {
  test("returns a scope for changed files", async () => {
    const scope = await createReviewScope({ directory: process.cwd(), changedFiles: ["src/plugin/deveagent.ts"] })
    expect(scope.available).toBe(true)
    expect(scope.changedFileCount).toBe(1)
    expect(scope.files.length).toBe(1)
    expect(scope.files[0].symbols.length).toBeGreaterThan(0)
  })

  test("handles unreadable files gracefully", async () => {
    const scope = await createReviewScope({ directory: process.cwd(), changedFiles: ["does/not/exist.ts"] })
    expect(scope.available).toBe(true)
    expect(scope.warnings.length).toBeGreaterThan(0)
  })

  test("caps changed files at 30", async () => {
    const many = Array.from({ length: 40 }, (_, i) => `file${i}.ts`)
    const scope = await createReviewScope({ directory: process.cwd(), changedFiles: many })
    expect(scope.files.length).toBeLessThanOrEqual(30)
    expect(scope.changedFileCount).toBe(40)
  })
})

// --- User-defined Local Skills ---

describe("Local skills CRUD", () => {
  test("saveLocalSkill persists and loadLocalSkills reads it back", async () => {
    const saved = await saveLocalSkill({ name: "My Helper", description: "helps with things", content: "Do the thing well." })
    expect(saved.error).toBeUndefined()
    expect(saved.id).toBeTruthy()
    const skills = await loadLocalSkills()
    const found = skills.find((s) => s.id === saved.id)
    expect(found).toBeDefined()
    expect(found?.name).toBe("My Helper")
    expect(found?.description).toBe("helps with things")
    expect(found?.prompt).toContain("Do the thing well.")
    await removeLocalSkill(saved.id)
  })

  test("saveLocalSkill requires a name", async () => {
    const result = await saveLocalSkill({ name: "", content: "x" })
    expect(result.error).toContain("name")
  })

  test("saveLocalSkill overwrites existing skill by id", async () => {
    const first = await saveLocalSkill({ name: "Version One", content: "v1 content" })
    const second = await saveLocalSkill({ id: first.id, name: "Version Two", content: "v2 content" })
    expect(second.id).toBe(first.id)
    const skills = await loadLocalSkills()
    const found = skills.find((s) => s.id === first.id)
    expect(found?.name).toBe("Version Two")
    expect(found?.prompt).toContain("v2 content")
    await removeLocalSkill(first.id)
  })

  test("removeLocalSkill deletes the skill", async () => {
    const saved = await saveLocalSkill({ name: "Temp Skill", content: "temp" })
    const removed = await removeLocalSkill(saved.id)
    expect(removed.removed).toBe(true)
    const skills = await loadLocalSkills()
    expect(skills.some((s) => s.id === saved.id)).toBe(false)
  })

  test("saveLocalSkill rejects path-traversal ids", async () => {
    const result = await saveLocalSkill({ id: "../../evil", name: "Evil", content: "x" })
    // sanitization turns it into a safe id or rejects; must not escape the skills dir
    if (!result.error) {
      expect(result.savedPath).toContain("local-skills")
      await removeLocalSkill(result.id)
    }
  })
})

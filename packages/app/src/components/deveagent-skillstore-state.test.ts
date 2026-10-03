import { describe, expect, test } from "bun:test"

import { skillStoreSaveError, summarizeSkillUpdates } from "./deveagent-skillstore-state"

describe("Skill update checks", () => {
  test("separates unreachable sources from outdated skills", () => {
    const result = summarizeSkillUpdates([
      { id: "current", upToDate: true },
      { id: "outdated", upToDate: false },
      { id: "unreachable", upToDate: false, error: "HTTP 503" },
    ])
    expect(result.outdated).toBe(1)
    expect(result.failed).toBe(1)
  })
  test("does not label all failed checks as up to date", () => {
    expect(summarizeSkillUpdates([{ id: "offline", upToDate: false, error: "Timeout" }]).failed).toBe(1)
  })
  test("rejects malformed responses rather than emptying the error state", () => {
    for (const payload of [null, {}, [null], [{ id: "demo" }], [{ id: "demo", upToDate: "yes" }]]) {
      expect(() => summarizeSkillUpdates(payload)).toThrow("Invalid Skill update response")
    }
    expect(summarizeSkillUpdates([]).results).toEqual([])
  })
})

describe("Skill Store save response", () => {
  test("reports a server error instead of treating it as a successful save", () => {
    expect(skillStoreSaveError({ ok: false, status: 500 }, {})).toBe("HTTP 500")
  })

  test("prefers the server's actionable error", () => {
    expect(skillStoreSaveError({ ok: false, status: 400 }, { error: "Skill name is required." })).toBe(
      "Skill name is required.",
    )
  })

  test("keeps successful responses successful", () => {
    expect(skillStoreSaveError({ ok: true, status: 200 }, { id: "skill-demo" })).toBeUndefined()
  })

  test("rejects a successful response without a saved skill id", () => {
    expect(skillStoreSaveError({ ok: true, status: 200 }, {})).toBe("invalid save response")
    expect(skillStoreSaveError({ ok: true, status: 200 }, { id: "  " })).toBe("invalid save response")
  })
})

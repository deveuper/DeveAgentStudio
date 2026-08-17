import { describe, expect, test } from "bun:test"

import { skillStoreSaveError } from "./deveagent-skillstore-state"

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
    expect(skillStoreSaveError({ ok: true, status: 200 }, {})).toBe("保存响应无效")
    expect(skillStoreSaveError({ ok: true, status: 200 }, { id: "  " })).toBe("保存响应无效")
  })
})

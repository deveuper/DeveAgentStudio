import { describe, expect, test } from "bun:test"
import { isDefaultTitle } from "./session"

// ponytail: the auto-title path only replaces a DEFAULT title
// (ensureTitle's `isDefaultTitle` guard). These pin the "never clobber a
// manual rename" contract at the predicate level.
describe("session.isDefaultTitle", () => {
  test("matches the default parent/child title shapes", () => {
    expect(isDefaultTitle("New session - 2026-09-07T01:02:03.004Z")).toBe(true)
    expect(isDefaultTitle("Child session - 2026-09-07T01:02:03.004Z")).toBe(true)
  })

  test("a manual rename is never treated as the default", () => {
    expect(isDefaultTitle("牛来式荒逝动作游戏 Godot 重构规划")).toBe(false)
    expect(isDefaultTitle("Fix auth bug")).toBe(false)
    expect(isDefaultTitle("New session")).toBe(false)
    expect(isDefaultTitle("New session - not-a-timestamp")).toBe(false)
    expect(isDefaultTitle("")).toBe(false)
  })
})

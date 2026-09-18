import { describe, expect, test } from "bun:test"
import { disabled } from "./index"

describe("permission disabled tools", () => {
  test("family deny: computer-use deny removes every computer-use-* tool", () => {
    const ruleset: { permission: string; action: "allow" | "ask" | "deny"; pattern: string }[] = [{ permission: "computer-use", action: "deny", pattern: "*" }]
    const result = disabled(["computer-use-click", "computer-use-screenshot", "computer-use-type", "bash"], ruleset)
    expect(result.has("computer-use-click")).toBe(true)
    expect(result.has("computer-use-screenshot")).toBe(true)
    expect(result.has("computer-use-type")).toBe(true)
    expect(result.has("bash")).toBe(false)
  })

  test("a later specific allow overrides the family deny (array order = precedence)", () => {
    const ruleset: { permission: string; action: "allow" | "ask" | "deny"; pattern: string }[] = [
      { permission: "computer-use", action: "deny", pattern: "*" },
      { permission: "computer-use-screenshot", action: "allow", pattern: "*" },
    ]
    const result = disabled(["computer-use-click", "computer-use-screenshot"], ruleset)
    expect(result.has("computer-use-click")).toBe(true)
    expect(result.has("computer-use-screenshot")).toBe(false)
  })

  test("non-deny family rules do not disable tools", () => {
    const ruleset: { permission: string; action: "allow" | "ask" | "deny"; pattern: string }[] = [
      { permission: "computer-use", action: "ask", pattern: "*" },
      { permission: "computer-use", action: "allow", pattern: "*" },
    ]
    const result = disabled(["computer-use-click"], ruleset)
    expect(result.has("computer-use-click")).toBe(false)
  })

  test("edit deny still maps write-family tools", () => {
    const ruleset: { permission: string; action: "allow" | "ask" | "deny"; pattern: string }[] = [{ permission: "edit", action: "deny", pattern: "*" }]
    const result = disabled(["write", "edit", "apply_patch", "read"], ruleset)
    expect(result.has("write")).toBe(true)
    expect(result.has("edit")).toBe(true)
    expect(result.has("apply_patch")).toBe(true)
    expect(result.has("read")).toBe(false)
  })
})

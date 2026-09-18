import { describe, expect, test } from "bun:test"
import { assertComputerUseKey } from "./computer-use-key"

describe("computer use key boundary", () => {
  test("accepts only the navigation key allowlist", () => {
    expect(assertComputerUseKey("Enter")).toBe("Enter")
    expect(assertComputerUseKey("ArrowDown")).toBe("ArrowDown")
    for (const value of ["a", "Control", "Alt", "", undefined]) {
      expect(() => assertComputerUseKey(value)).toThrow("Unsupported computer-use key")
    }
  })
})

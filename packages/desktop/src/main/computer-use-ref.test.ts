import { describe, expect, test } from "bun:test"
import { browserSnapshotRefSelector } from "./computer-use-ref"

describe("computer use browser snapshot refs", () => {
  test("creates selectors only for the bounded snapshot reference range", () => {
    expect(browserSnapshotRefSelector("1")).toBe('[data-deveagent-ref="1"]')
    expect(browserSnapshotRefSelector(" 200 ")).toBe('[data-deveagent-ref="200"]')
    for (const ref of ["0", "201", "1;button", "-1", "x"]) {
      expect(() => browserSnapshotRefSelector(ref)).toThrow()
    }
  })
})

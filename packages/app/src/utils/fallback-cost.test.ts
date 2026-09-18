import { describe, expect, test } from "bun:test"
import { isPaidFallbackModelCost } from "./fallback-cost"

// Display-side mirror of the server red line: the failover UI must label a
// candidate as paid (never silently offer it as free). The authoritative gate
// lives in packages/opencode/src/session/prompt.ts.
describe("isPaidFallbackModelCost", () => {
  test("an all-zero cost is free", () => {
    expect(isPaidFallbackModelCost({ input: 0, output: 0, cache: { read: 0, write: 0 } })).toBe(false)
  })

  test("any positive billable dimension is paid", () => {
    expect(isPaidFallbackModelCost({ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } })).toBe(true)
    expect(isPaidFallbackModelCost({ input: 0, output: 0, cache: { read: 0, write: 0.001 } })).toBe(true)
  })

  test("an unverifiable cost counts as paid", () => {
    expect(isPaidFallbackModelCost(undefined)).toBe(true)
    expect(isPaidFallbackModelCost(null)).toBe(true)
    expect(isPaidFallbackModelCost({ input: 0, output: 0 })).toBe(true)
    expect(isPaidFallbackModelCost({ input: Number.NaN, output: 0, cache: { read: 0, write: 0 } })).toBe(true)
  })
})

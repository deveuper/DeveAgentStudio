import { describe, expect, test } from "bun:test"
import { LOW_POWER_MULTIPLIER, lowPowerPeriod } from "./low-power"

describe("low-power period math", () => {
  test("keeps the base period when the mode is off", () => {
    expect(lowPowerPeriod(1_000, false)).toBe(1_000)
    expect(lowPowerPeriod(4_000, false)).toBe(4_000)
  })

  test("stretches the period by the multiplier when the mode is on", () => {
    expect(lowPowerPeriod(1_000, true)).toBe(1_000 * LOW_POWER_MULTIPLIER)
    expect(lowPowerPeriod(5_000, true)).toBe(5_000 * LOW_POWER_MULTIPLIER)
    expect(lowPowerPeriod(3_000, true)).toBe(12_000)
  })

  test("rounds fractional periods to whole milliseconds", () => {
    expect(lowPowerPeriod(750, true)).toBe(3_000)
    expect(Number.isInteger(lowPowerPeriod(333, true))).toBe(true)
  })
})

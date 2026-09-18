import { describe, expect, test } from "bun:test"
import { formatCountdown, formatElapsed, workStatusKind, workStatusLabel } from "./deveagent-work-status"

// Identity translator: the label now comes from the dictionary, so this test
// asserts the kind/mode -> key mapping rather than any particular wording.
const t = (key: string) => key

describe("deveagent work status", () => {
  test("idle when no turn is running, whatever the mode", () => {
    expect(workStatusKind(false, "plan")).toBe("idle")
    expect(workStatusKind(false, "craft")).toBe("idle")
    expect(workStatusKind(false, undefined)).toBe("idle")
  })

  test("plan mode with a turn running is planning, not executing", () => {
    expect(workStatusKind(true, "plan")).toBe("planning")
    expect(workStatusKind(true, "craft")).toBe("executing")
    expect(workStatusKind(true, "goal")).toBe("executing")
    expect(workStatusKind(true, "loop")).toBe("executing")
    expect(workStatusKind(true, undefined)).toBe("executing")
  })

  test("labels are phase-aware for goal/loop and idle has none", () => {
    expect(workStatusLabel("planning", "plan", t)).toBe("deveagent.composer.statusPlanning")
    expect(workStatusLabel("executing", "craft", t)).toBe("deveagent.composer.statusWorking")
    expect(workStatusLabel("executing", "goal", t)).toBe("deveagent.composer.statusGoal")
    expect(workStatusLabel("executing", "loop", t)).toBe("deveagent.composer.statusLoop")
    expect(workStatusLabel("idle", "plan", t)).toBe("")
  })

  test("elapsed formatting stays compact and never negative", () => {
    expect(formatElapsed(0)).toBe("")
    expect(formatElapsed(-3)).toBe("")
    expect(formatElapsed(Number.NaN)).toBe("")
    expect(formatElapsed(5)).toBe("5s")
    expect(formatElapsed(59)).toBe("59s")
    expect(formatElapsed(65)).toBe("1m05s")
    expect(formatElapsed(120)).toBe("2m")
    expect(formatElapsed(3720)).toBe("1h02m")
    expect(formatElapsed(7200)).toBe("2h")
  })

  test("countdown formatting: MM:SS under an hour, H:MM:SS above, empty when none", () => {
    expect(formatCountdown(0)).toBe("")
    expect(formatCountdown(-1_000)).toBe("")
    expect(formatCountdown(Number.NaN)).toBe("")
    expect(formatCountdown(42_000)).toBe("00:42")
    expect(formatCountdown(59_999)).toBe("00:59")
    expect(formatCountdown(60_000)).toBe("01:00")
    expect(formatCountdown(3_599_000)).toBe("59:59")
    expect(formatCountdown(3_600_000)).toBe("1:00:00")
    expect(formatCountdown(3_723_000)).toBe("1:02:03")
  })
})

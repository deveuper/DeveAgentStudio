import { describe, expect, test } from "bun:test"
import { goalBackoffMs, resetGoalTelemetry, goalTelemetrySnapshot, shouldWorkerReenterGoal } from "./deveagent"

describe("shouldWorkerReenterGoal (event-driven convergence guard)", () => {
  const now = 1_000_000

  test("recovered goals without lastEventDrivenAt are never skipped (crash recovery)", () => {
    expect(shouldWorkerReenterGoal({ retryCount: 0 }, now)).toBe(false)
    expect(shouldWorkerReenterGoal({ retryCount: 3 }, now)).toBe(false)
  })

  test("skips a goal the autocontinue hook just drove inside its backoff window", () => {
    // retryCount 0 -> backoff 5s; a drive 1s ago is inside the window.
    expect(shouldWorkerReenterGoal({ retryCount: 0, lastEventDrivenAt: now - 1_000 }, now)).toBe(true)
    // retryCount 2 -> backoff 10s; a drive 9s ago is still inside.
    expect(shouldWorkerReenterGoal({ retryCount: 2, lastEventDrivenAt: now - 9_000 }, now)).toBe(true)
  })

  test("allows worker re-entry once the backoff window has elapsed", () => {
    // retryCount 0 -> backoff 5s; 6s elapsed -> worker may resume.
    expect(shouldWorkerReenterGoal({ retryCount: 0, lastEventDrivenAt: now - 6_000 }, now)).toBe(false)
    // retryCount 3 -> backoff 15s; 16s elapsed -> worker may resume.
    expect(shouldWorkerReenterGoal({ retryCount: 3, lastEventDrivenAt: now - 16_000 }, now)).toBe(false)
  })
})

describe("goal telemetry", () => {
  test("snapshot is bounded and reset works", () => {
    resetGoalTelemetry()
    const snap = goalTelemetrySnapshot()
    expect(snap.eventDrivenReentries).toBe(0)
    expect(snap.workerReentries).toBe(0)
    expect(snap.lastPath).toBeNull()
  })
})

describe("goalBackoffMs", () => {
  test("bounded backoff grows with retry count", () => {
    expect(goalBackoffMs(0)).toBe(5_000)
    expect(goalBackoffMs(2)).toBe(10_000)
    expect(goalBackoffMs(100)).toBe(60_000)
  })
})

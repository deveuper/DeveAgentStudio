import { describe, expect, test } from "bun:test"
import { deveagentStartupSnapshot, markDeveagentStartup, resetDeveagentStartupForTest } from "./deveagent-startup-timing"

describe("deveagent startup timing", () => {
  test("records phases monotonically from the reset origin", () => {
    resetDeveagentStartupForTest(1000)
    const composer = markDeveagentStartup("composer-ready")
    expect(composer).toBeGreaterThanOrEqual(0)
    const provider = markDeveagentStartup("provider-ready")
    // A later phase can never carry an earlier timestamp than a previous one.
    expect(provider!).toBeGreaterThanOrEqual(composer!)
  })

  test("marks each phase exactly once and freezes on provider-ready", () => {
    resetDeveagentStartupForTest(2000)
    markDeveagentStartup("workbench-ready")
    const again = markDeveagentStartup("workbench-ready")
    expect(again).toBeDefined()
    const first = deveagentStartupSnapshot()
    expect(first).toBeUndefined()
    markDeveagentStartup("provider-ready")
    const snapshot = deveagentStartupSnapshot()
    expect(snapshot).toBeDefined()
    expect((snapshot as { frozen?: boolean }).frozen).toBe(true)
    // After freezing, further marks are refused: numbers cannot drift late.
    const phases = (deveagentStartupSnapshot() as { phases: Record<string, number> }).phases
    markDeveagentStartup("composer-ready")
    expect((deveagentStartupSnapshot() as { phases: Record<string, number> }).phases).toEqual(phases)
  })

  test("window snapshot carries every phase after freeze", () => {
    resetDeveagentStartupForTest(3000)
    markDeveagentStartup("script-start")
    markDeveagentStartup("workbench-ready")
    markDeveagentStartup("composer-ready")
    markDeveagentStartup("provider-ready")
    const snapshot = deveagentStartupSnapshot() as { phases: Record<string, number>; completedAt?: number }
    expect(Object.keys(snapshot.phases).sort()).toEqual(["composer-ready", "provider-ready", "script-start", "workbench-ready"])
    expect(snapshot.completedAt).toBeGreaterThanOrEqual(snapshot.phases["provider-ready"]!)
  })
})

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearDeveAgentRunIndexForTest, normalizeRun, readDeveAgentRuns, recordDeveAgentRun } from "./deveagent-run"

function workspace() {
  return mkdtempSync(join(tmpdir(), "deveagent-run-"))
}

const baseRun = {
  id: "goal-s1-123",
  kind: "goal" as const,
  sessionID: "s1",
  directory: "/tmp/ws",
  description: "Ship the fix",
  status: "running" as const,
  startedAt: 1_000,
}

describe("deveagent-run", () => {
  test("normalizeRun clamps and rejects unusable records", () => {
    const run = normalizeRun({ ...baseRun, description: "d".repeat(900), stopReason: "r".repeat(500) })
    expect(run?.description.length).toBe(300)
    expect(run?.stopReason?.length).toBe(200)
    expect(normalizeRun({ ...baseRun, kind: "nope" })).toBeUndefined()
    expect(normalizeRun({ ...baseRun, status: "paused" })).toBeUndefined()
    expect(normalizeRun({ ...baseRun, id: "" })).toBeUndefined()
    expect(normalizeRun({ ...baseRun, startedAt: 0 })).toBeUndefined()
    expect(normalizeRun(undefined as unknown as Record<string, unknown>)).toBeUndefined()
  })

  test("S2: provenance fields survive normalization — children bounded, unknown usage stays unknown", () => {
    const run = normalizeRun({
      ...baseRun,
      parentSessionID: "ses_parent",
      childSessionIDs: ["ses_a", "ses_b", "ses_a", "", 42, "x".repeat(200)],
      tokens: 1500,
      cost: 0,
    })
    expect(run?.parentSessionID).toBe("ses_parent")
    // Duplicates, empties and non-strings are dropped; ids are clamped; the
    // list is bounded so a runaway run cannot bloat the ledger row.
    expect(run?.childSessionIDs).toEqual(["ses_a", "ses_b", "x".repeat(80)])
    expect(run?.tokens).toBe(1500)
    // A zero cost is real data (free models) and must survive.
    expect(run?.cost).toBe(0)

    // Unknown usage (provider never returned numbers) is undefined, NOT 0 —
    // the ledger never fabricates totals.
    const unknown = normalizeRun({ ...baseRun, tokens: "many", cost: null, childSessionIDs: "not-a-list" })
    expect(unknown?.tokens).toBeUndefined()
    expect(unknown?.cost).toBeUndefined()
    expect(unknown?.childSessionIDs).toBeUndefined()

    // Negative or non-finite numbers are usage garbage, dropped the same way.
    const garbage = normalizeRun({ ...baseRun, tokens: -5, cost: Number.NaN })
    expect(garbage?.tokens).toBeUndefined()
    expect(garbage?.cost).toBeUndefined()
  })

  test("record + read round-trips newest-first and persists to the bounded JSONL file", async () => {
    clearDeveAgentRunIndexForTest()
    const directory = workspace()
    try {
      for (let i = 1; i <= 3; i++) {
        await recordDeveAgentRun(directory, { ...baseRun, id: `run-${i}`, status: "running", startedAt: i })
      }
      await recordDeveAgentRun(directory, { ...baseRun, id: "run-2", status: "completed", startedAt: 2, finishedAt: 5 })

      const runs = await readDeveAgentRuns(directory, 10)
      expect(runs.map((run) => run.id)).toEqual(["run-2", "run-3", "run-1"])
      expect(runs[0]?.status).toBe("completed")

      const file = join(directory, ".deveagent", "deveagent-runs.log")
      const lines = readFileSync(file, "utf8").trim().split("\n")
      expect(lines.length).toBe(4)
      expect(await readDeveAgentRuns(undefined)).toEqual([])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("reads survive process restarts by falling back to the log file", async () => {
    clearDeveAgentRunIndexForTest()
    const directory = workspace()
    try {
      await recordDeveAgentRun(directory, { ...baseRun, id: "persisted", description: "Survives restarts" })
      clearDeveAgentRunIndexForTest()
      const runs = await readDeveAgentRuns(directory, 10)
      expect(runs).toHaveLength(1)
      expect(runs[0]?.id).toBe("persisted")
      expect(runs[0]?.description).toBe("Survives restarts")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("missing or empty workspaces read as empty", async () => {
    clearDeveAgentRunIndexForTest()
    const directory = workspace()
    try {
      expect(await readDeveAgentRuns(directory)).toEqual([])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("DeveAgentRun loop records", () => {
  test("setLoop opens a run and completing/clearing it transitions the record", async () => {
    const mod = await import("./deveagent")
    clearDeveAgentRunIndexForTest()
    const directory = mkdtempSync(join(tmpdir(), "deveagent-run-loop-"))
    try {
      mod.setLoop({ task: "poll the queue", sessionID: "loop-s1", directory, intervalSeconds: 60, maxRuns: 1 })
      let runs = await readDeveAgentRuns(directory, 10)
      expect(runs).toHaveLength(1)
      expect(runs[0]?.kind).toBe("loop")
      expect(runs[0]?.status).toBe("running")

      // The worker records completion when maxRuns is reached; here we drive the
      // transition through clear (stopped) and verify the read view.
      mod.clearLoop("loop-s1")
      runs = await readDeveAgentRuns(directory, 10)
      expect(runs).toHaveLength(1)
      expect(runs[0]?.status).toBe("stopped")
      expect(runs[0]?.stopReason).toBe("cancelled by user")
      await mod.waitForLoopStoreFlush()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

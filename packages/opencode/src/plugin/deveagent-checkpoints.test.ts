import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { normalizeCheckpoint, readCheckpoints, recordCheckpoint } from "./deveagent-checkpoints"

async function tempWorkspace() {
  return mkdtemp(join(tmpdir(), "deveagent-checkpoints-"))
}

describe("deveagent-checkpoints", () => {
  test("normalizeCheckpoint clamps and drops unusable records", () => {
    expect(normalizeCheckpoint({ snapshotHash: "abc123", sessionID: "ses_1", messageID: "msg_9" })).toMatchObject({
      snapshotHash: "abc123",
      sessionID: "ses_1",
      messageID: "msg_9",
    })
    expect(normalizeCheckpoint({})).toBeUndefined()
    expect(normalizeCheckpoint({ snapshotHash: "   " })).toBeUndefined()
    expect(normalizeCheckpoint(null)).toBeUndefined()
    const long = normalizeCheckpoint({ snapshotHash: "h".repeat(500), sessionID: "s".repeat(200) })
    expect(long?.snapshotHash).toHaveLength(120)
    expect(long?.sessionID).toHaveLength(80)
  })

  test("record + read round-trips newest-first and filters by session", async () => {
    const dir = await tempWorkspace()
    try {
      await recordCheckpoint(dir, { sessionID: "ses_a", messageID: "msg_1", snapshotHash: "hash-1" })
      await recordCheckpoint(dir, { sessionID: "ses_a", messageID: "msg_2", snapshotHash: "hash-2" })
      await recordCheckpoint(dir, { sessionID: "ses_b", messageID: "msg_3", snapshotHash: "hash-3" })
      const all = await readCheckpoints(dir)
      expect(all.map((entry) => entry.snapshotHash)).toEqual(["hash-3", "hash-2", "hash-1"])
      const onlyA = await readCheckpoints(dir, "ses_a")
      expect(onlyA.map((entry) => entry.messageID)).toEqual(["msg_2", "msg_1"])
      expect(await readCheckpoints(undefined)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })

  test("a re-recorded messageID supersedes the older hash", async () => {
    const dir = await tempWorkspace()
    try {
      await recordCheckpoint(dir, { sessionID: "ses_a", messageID: "msg_1", snapshotHash: "old" })
      await recordCheckpoint(dir, { sessionID: "ses_a", messageID: "msg_1", snapshotHash: "new" })
      const entries = await readCheckpoints(dir, "ses_a")
      expect(entries).toHaveLength(1)
      expect(entries[0]?.snapshotHash).toBe("new")
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })

  test("the log file stays bounded and torn head lines are dropped", async () => {
    const dir = await tempWorkspace()
    try {
      // Grow the log past the rotation threshold by hand, then append through
      // the API and verify rotation dropped the oldest lines without tearing.
      const big = "x".repeat(600 * 1024)
      const file = join(dir, ".deveagent", "checkpoints.log")
      await recordCheckpoint(dir, { sessionID: "ses_fill", messageID: "msg_fill", snapshotHash: "fill-hash", at: new Date().toISOString() })
      const { mkdir, appendFile } = await import("node:fs/promises")
      await mkdir(join(dir, ".deveagent"), { recursive: true })
      await appendFile(file, `{"junk": "${big}"}\n`, "utf8")
      await recordCheckpoint(dir, { sessionID: "ses_new", messageID: "msg_new", snapshotHash: "fresh-hash" })
      const size = (await readFile(file)).byteLength
      expect(size).toBeLessThanOrEqual(512 * 1024 + 4096)
      const entries = await readCheckpoints(dir)
      expect(entries.some((entry) => entry.snapshotHash === "fresh-hash")).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })

  test("corrupt lines are skipped, never thrown", async () => {
    const dir = await tempWorkspace()
    try {
      await recordCheckpoint(dir, { sessionID: "ses_a", messageID: "msg_ok", snapshotHash: "good" })
      const file = join(dir, ".deveagent", "checkpoints.log")
      const { appendFile } = await import("node:fs/promises")
      await appendFile(file, "not json at all\n", "utf8")
      const entries = await readCheckpoints(dir)
      expect(entries.map((entry) => entry.snapshotHash)).toEqual(["good"])
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })
})

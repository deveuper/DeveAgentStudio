import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendCuAudit, CU_AUDIT_MAX_ENTRIES, normalizeCuAuditEntry, readCuAuditLog } from "./deveagent-cu-audit"

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "cu-audit-"))
  mkdirSync(join(directory, ".deveagent"), { recursive: true })
  return directory
}

describe("deveagent-cu-audit", () => {
  test("normalizeCuAuditEntry clamps and drops unusable entries", () => {
    const entry = normalizeCuAuditEntry({ tool: "computer-use-click", action: "click", target: "t".repeat(500), ok: false, detail: "d".repeat(900) })
    expect(entry?.target?.length).toBe(200)
    expect(entry?.detail?.length).toBe(300)
    expect(entry?.ok).toBe(false)
    expect(normalizeCuAuditEntry({ tool: "", action: "click" })).toBeUndefined()
    expect(normalizeCuAuditEntry({ tool: "x" })).toBeUndefined()
    expect(normalizeCuAuditEntry(null as unknown as Record<string, unknown>)).toBeUndefined()
    // ok defaults to true — absence of failure means success.
    expect(normalizeCuAuditEntry({ tool: "computer-use-type", action: "type", text: 42 })?.ok).toBe(true)
  })

  test("append + read round-trips newest-first and respects the limit", async () => {
    const directory = workspace()
    try {
      for (let i = 1; i <= 5; i++) {
        await appendCuAudit(directory, { sessionID: `s${i}`, tool: "computer-use-windows", action: "windows", target: `handle-${i}`, ok: i !== 4 })
      }
      const entries = await readCuAuditLog(directory, 3)
      expect(entries).toHaveLength(3)
      expect(entries[0]?.target).toBe("handle-5")
      expect(entries[1]?.target).toBe("handle-4")
      expect(entries[1]?.ok).toBe(false)
      expect(entries[2]?.target).toBe("handle-3")
      expect(await readCuAuditLog(undefined)).toEqual([])
      expect(await readCuAuditLog(directory, 0)).toEqual([])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("the log file stays bounded when entries pile up", async () => {
    const directory = workspace()
    try {
      const big = "x".repeat(4000)
      for (let i = 0; i < 200; i++) await appendCuAudit(directory, { tool: "computer-use-shell", action: "shell", target: big })
      const file = join(directory, ".deveagent", "cu-audit.log")
      expect(readFileSync(file).byteLength).toBeLessThan(600 * 1024)
      const entries = await readCuAuditLog(directory, CU_AUDIT_MAX_ENTRIES)
      expect(entries.length).toBeGreaterThan(0)
      expect(entries[0]?.target?.length).toBe(200)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("corrupt lines are skipped, never thrown", async () => {
    const directory = workspace()
    try {
      const file = join(directory, ".deveagent", "cu-audit.log")
      writeFileSync(file, "not json\n" + JSON.stringify({ tool: "computer-use-focus", action: "focus", ok: true }) + "\n")
      const entries = await readCuAuditLog(directory, 10)
      expect(entries).toHaveLength(1)
      expect(entries[0]?.tool).toBe("computer-use-focus")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

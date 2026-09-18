// DeveAgent Computer-Use audit log (Plan.2026.7.29 §4: "每个 Computer Use 动作
// 写入可查看的审计日志"). Every CU tool action appends one JSONL line to
// `.deveagent/cu-audit.log` in the workspace: time, session, tool, action,
// target, outcome. The file is bounded like the Guardian trace (512 KiB cap,
// keep the newest 256 KiB) and read back through the product API so the
// Overview can show exactly what the agent did on this machine.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

const AUDIT_MAX_BYTES = 512 * 1024
const AUDIT_KEEP_BYTES = 256 * 1024
export const CU_AUDIT_MAX_ENTRIES = 200
const TARGET_CHARS = 200
const DETAIL_CHARS = 300

export type CuAuditEntry = {
  at: string
  sessionID?: string
  tool: string
  action: string
  target?: string
  ok: boolean
  detail?: string
}

function auditPath(directory: string | undefined) {
  if (!directory) return undefined
  return join(directory, ".deveagent", "cu-audit.log")
}

/** Normalize + clamp a raw entry; drops entries without a tool/action. */
export function normalizeCuAuditEntry(entry: Record<string, unknown>): CuAuditEntry | undefined {
  if (!entry || typeof entry !== "object") return undefined
  const tool = typeof entry.tool === "string" ? entry.tool.trim().slice(0, 60) : ""
  const action = typeof entry.action === "string" ? entry.action.trim().slice(0, 60) : ""
  if (!tool || !action) return undefined
  const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : undefined)
  return {
    at: typeof entry.at === "string" && entry.at ? entry.at : new Date().toISOString(),
    sessionID: text(entry.sessionID, 80),
    tool,
    action,
    target: text(entry.target, TARGET_CHARS),
    ok: entry.ok !== false,
    detail: text(entry.detail, DETAIL_CHARS),
  }
}

export async function readCuAuditLog(directory: string | undefined, limit = 50): Promise<CuAuditEntry[]> {
  const file = auditPath(directory)
  if (!file) return []
  const requested = Math.floor(limit)
  if (!Number.isFinite(requested) || requested <= 0) return []
  const bounded = Math.min(requested, CU_AUDIT_MAX_ENTRIES)
  try {
    const data = await readFile(file, "utf8")
    const lines = data.split("\n").filter(Boolean)
    const out: CuAuditEntry[] = []
    for (let i = lines.length - 1; i >= 0 && out.length < bounded; i--) {
      try {
        const entry = normalizeCuAuditEntry(JSON.parse(lines[i]) as Record<string, unknown>)
        if (entry) out.push(entry)
      } catch {}
    }
    return out
  } catch {
    return []
  }
}

export async function appendCuAudit(directory: string | undefined, entry: Record<string, unknown>) {
  const file = auditPath(directory)
  if (!file) return
  const normalized = normalizeCuAuditEntry(entry)
  if (!normalized) return
  try {
    await mkdir(join(file, ".."), { recursive: true })
    const line = `${JSON.stringify(normalized)}\n`
    let size = 0
    try {
      size = (await readFile(file)).byteLength
    } catch {}
    if (size + Buffer.byteLength(line) > AUDIT_MAX_BYTES) {
      const data = await readFile(file)
      let kept = data.subarray(Math.max(0, data.byteLength - AUDIT_KEEP_BYTES))
      // The byte offset can land mid-line (or mid-UTF-8); drop everything up
      // to the first newline so the reader never sees a torn record.
      const newline = kept.indexOf(10)
      if (newline !== -1) kept = kept.subarray(newline + 1)
      await writeFile(file, kept)
    }
    await appendFile(file, line, "utf8")
  } catch {}
}

// DeveAgent CU permission level (Plan.2026.7.29 §4: 权限分为默认/自动审批/完全
// 权限；完全权限只能由用户显式开启并显示持续警告). Workspace-scoped, persisted
// in `.deveagent/cu-level.json`.
//
// - default: every computer-use action asks for permission.
// - auto: the ask is auto-approved (the tool proceeds without a dialog).
// - full: alias of auto plus a persistent warning banner in the UI.
//
// An explicit config deny still blocks regardless of level (handled upstream
// by the permission engine — the level only affects the ask step).

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export type CuPermissionLevel = "default" | "auto" | "full"

const LEVELS: CuPermissionLevel[] = ["default", "auto", "full"]

function levelPath(directory: string | undefined) {
  if (!directory) return undefined
  return join(directory, ".deveagent", "cu-level.json")
}

export function normalizeCuLevel(value: unknown): CuPermissionLevel {
  return LEVELS.includes(value as CuPermissionLevel) ? (value as CuPermissionLevel) : "default"
}

/** Synchronous read — the CU tools call this on every action. */
export function getCuPermissionLevel(directory: string | undefined): CuPermissionLevel {
  const file = levelPath(directory)
  if (!file || !existsSync(file)) return "default"
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { level?: unknown }
    return normalizeCuLevel(parsed.level)
  } catch {
    return "default"
  }
}

/** True when the CU ask step should be skipped (auto / full). */
export function cuAskSkipped(directory: string | undefined): boolean {
  const level = getCuPermissionLevel(directory)
  return level === "auto" || level === "full"
}

let writeImpl: ((file: string, content: string) => Promise<void>) | undefined

/** Injected by deveagent.ts (atomicWriteFile) to keep this module standalone. */
export function setCuLevelWriter(impl: (file: string, content: string) => Promise<void>) {
  writeImpl = impl
}

export async function setCuPermissionLevel(directory: string | undefined, level: CuPermissionLevel): Promise<CuPermissionLevel> {
  const file = levelPath(directory)
  if (!file) return "default"
  const normalized = normalizeCuLevel(level)
  const write = writeImpl ?? (async (target: string, content: string) => {
    const { mkdir, writeFile } = await import("node:fs/promises")
    const { dirname } = await import("node:path")
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, "utf8")
  })
  await write(file, JSON.stringify({ level: normalized, updatedAt: new Date().toISOString() }))
  return normalized
}

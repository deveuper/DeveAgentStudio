// DeveAgent declarative hooks (R156): user-written deny rules in
// `<workspace>/.deveagent/hooks.json` (workspace) plus the user-level
// `<config>/opencode/deveagent-hooks.json`. Deny-only by design — a
// declarative rule can tighten a permission, never loosen one, so the
// "hooks can only restrict" iron rule holds without any sandboxing.
//
// File shape:
// { "hooks": [ { "permission": "computer-use", "reason"?: "..." },
//               { "permission": "write", "reason": "no writes here" } ] }
// Family semantics mirror the permission engine: a rule for `computer-use`
// also governs `computer-use-click`/`computer-use-*`; the matched rule's
// `reason` is surfaced verbatim in the tool result.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { readFile as readFileAsync } from "node:fs/promises"
import { dirname, join } from "node:path"

const HOOKS_MAX_BYTES = 256 * 1024
const PERMISSION_CHARS = 80
const REASON_CHARS = 300

export type DeveagentHookSource = "workspace" | "user"

export type DeveagentHookRule = {
  permission: string
  reason?: string
  source: DeveagentHookSource
}

export function workspaceHooksPath(directory: string | undefined) {
  if (!directory) return undefined
  return join(directory, ".deveagent", "hooks.json")
}

export function userHooksPath() {
  const base = process.env.XDG_CONFIG_HOME || join(os.homedir(), ".config")
  return join(base, "opencode", "deveagent-hooks.json")
}

import os from "node:os"

export function normalizeHookRule(entry: unknown, source: DeveagentHookSource): DeveagentHookRule | undefined {
  if (!entry || typeof entry !== "object") return undefined
  const raw = entry as Record<string, unknown>
  const permission = typeof raw.permission === "string" ? raw.permission.trim().slice(0, PERMISSION_CHARS) : ""
  if (!permission) return undefined
  // Deny-only: any other declared action makes the rule invalid (fail-soft
  // drop) — declarative hooks can tighten a permission, never loosen one.
  if (typeof raw.action === "string" && raw.action !== "deny") return undefined
  const reason = typeof raw.reason === "string" ? raw.reason.trim().slice(0, REASON_CHARS) || undefined : undefined
  return { permission, reason, source }
}

export function parseHookRules(raw: unknown, source: DeveagentHookSource): DeveagentHookRule[] {
  const list = (raw as { hooks?: unknown } | undefined)?.hooks
  if (!Array.isArray(list)) return []
  return list.flatMap((entry) => {
    const rule = normalizeHookRule(entry, source)
    return rule ? [rule] : []
  })
}

async function readRuleFile(file: string | undefined, source: DeveagentHookSource): Promise<DeveagentHookRule[]> {
  if (!file || !existsSync(file)) return []
  try {
    const info = statSync(file)
    if (info.size > HOOKS_MAX_BYTES) return []
    const data = JSON.parse(readFileSync(file, "utf8"))
    return parseHookRules(data, source)
  } catch {
    return []
  }
}

/** Workspace rules first, then user-level; deny rules merge (union). */
export async function loadHookRules(directory: string | undefined): Promise<DeveagentHookRule[]> {
  const [workspace, user] = await Promise.all([
    readRuleFile(workspaceHooksPath(directory), "workspace"),
    readRuleFile(userHooksPath(), "user"),
  ])
  return [...workspace, ...user]
}

/**
 * First matching deny rule for a permission ask. Family semantics: a rule for
 * `computer-use` governs `computer-use-click` too. Workspace rules win over
 * user rules on the same permission.
 */
export function matchHookRule(
  rules: DeveagentHookRule[],
  permission: string,
): DeveagentHookRule | undefined {
  const target = permission.toLowerCase()
  const familyMatch = (rulePermission: string) =>
    target === rulePermission || target.startsWith(`${rulePermission}.`) || target.startsWith(`${rulePermission}-`) ||
    rulePermission.endsWith("*") && target.startsWith(rulePermission.slice(0, -1))
  return (
    rules.find((rule) => rule.source === "workspace" && familyMatch(rule.permission)) ??
    rules.find((rule) => rule.source === "user" && familyMatch(rule.permission))
  )
}

/** Persist workspace hooks (setup tooling and tests). */
export async function writeWorkspaceHooks(directory: string, hooks: unknown) {
  const file = workspaceHooksPath(directory)
  if (!file) return
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(hooks, null, 2))
}

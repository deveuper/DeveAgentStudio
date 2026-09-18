// DeveAgent auto-skill (Hermes-inspired self-improvement, adapted to OpenCode).
//
// Hermes turns session experience into durable skills with a forked reviewer
// agent whose only tools are skill/memory writes, fired by a tool-iteration
// counter (not session end), with a read-before-write guard and a provenance
// sidecar so the autonomous writer can only touch what it created.
//
// This module implements the deterministic half that can be verified without
// an LLM: the candidate decision (is there something worth capturing?), the
// provenance ledger, the bounded write, and the dedup rule. The actual
// authoring text is produced by the caller's model call; this module never
// invents content.
//
// Reference: references/03-hermes-agent — skill_manage tool, background
// review fork, .usage.json provenance sidecar.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

export const AUTO_SKILL_MIN_TOOL_ITERS = 10
export const AUTO_SKILL_MAX_CHARS = 100_000
export const AUTO_SKILL_DESC_LIMIT = 60
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/
const MAX_NAME_LENGTH = 64
const LEDGER_FILE = "auto-skills.json"

export type AutoSkillProvenance = {
  /** Who wrote it: the background reviewer or the user. Only "agent" skills
   *  may be patched by the reviewer (Hermes' write guard). */
  createdBy: "agent" | "user"
  createdAt: number
  useCount: number
  patchCount: number
  lastUsedAt?: number
  /** Pinned skills are never auto-patched or auto-archived. */
  pinned?: boolean
  state: "active" | "stale" | "archived"
}

export type AutoSkillLedger = Record<string, AutoSkillProvenance>

function ledgerPath(directory: string) {
  return path.join(directory, ".deveagent", LEDGER_FILE)
}

export function autoSkillDir(directory: string) {
  return path.join(directory, ".deveagent", "skills")
}

/**
 * Should the reviewer run? Hermes fires on a tool-iteration counter rather than
 * at session end, because long sessions never "end". The counter resets when a
 * skill is actually written, so a burst of work between writes is what earns a
 * review.
 */
export function shouldRunAutoSkillReview(input: {
  toolIterationsSinceLastSkill: number
  hadFinalAnswer: boolean
  interrupted: boolean
  enabled: boolean
}): boolean {
  if (!input.enabled) return false
  if (input.interrupted) return false
  if (!input.hadFinalAnswer) return false
  return input.toolIterationsSinceLastSkill >= AUTO_SKILL_MIN_TOOL_ITERS
}

/** Validate an authored skill before it may be persisted. */
export function validateAutoSkill(input: { name: string; description: string; body: string }):
  | { ok: true; name: string; description: string }
  | { ok: false; reason: string } {
  // Normalize a human title into a slug BEFORE the pattern check: an authored
  // "Collapse Logs" is a valid name for "collapse-logs", not a rejection.
  const name = input.name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/^[-.]+|[-.]+$/g, "")
  if (!name) return { ok: false, reason: "name is required" }
  if (name.length > MAX_NAME_LENGTH) return { ok: false, reason: `name exceeds ${MAX_NAME_LENGTH} chars` }
  if (!NAME_RE.test(name)) return { ok: false, reason: "name must match ^[a-z0-9][a-z0-9._-]*$" }
  const description = input.description.trim().replace(/\s+/g, " ")
  if (!description) return { ok: false, reason: "description is required" }
  // The index truncates descriptions; a longer one silently loses meaning.
  if (description.length > AUTO_SKILL_DESC_LIMIT) {
    return { ok: false, reason: `description exceeds ${AUTO_SKILL_DESC_LIMIT} chars (index truncation)` }
  }
  if (input.body.trim().length === 0) return { ok: false, reason: "body is required" }
  if (input.body.length > AUTO_SKILL_MAX_CHARS) return { ok: false, reason: `body exceeds ${AUTO_SKILL_MAX_CHARS} chars` }
  return { ok: true, name, description }
}

export async function readAutoSkillLedger(directory: string): Promise<AutoSkillLedger> {
  try {
    const data = JSON.parse(await readFile(ledgerPath(directory), "utf8")) as { skills?: AutoSkillLedger }
    if (!data?.skills || typeof data.skills !== "object") return {}
    const out: AutoSkillLedger = {}
    for (const [name, raw] of Object.entries(data.skills)) {
      if (!raw || typeof raw !== "object") continue
      const value = raw as Partial<AutoSkillProvenance>
      out[name] = {
        createdBy: value.createdBy === "user" ? "user" : "agent",
        createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
        useCount: typeof value.useCount === "number" && value.useCount >= 0 ? Math.floor(value.useCount) : 0,
        patchCount: typeof value.patchCount === "number" && value.patchCount >= 0 ? Math.floor(value.patchCount) : 0,
        ...(typeof value.lastUsedAt === "number" ? { lastUsedAt: value.lastUsedAt } : {}),
        ...(value.pinned === true ? { pinned: true } : {}),
        state: value.state === "stale" || value.state === "archived" ? value.state : "active",
      }
    }
    return out
  } catch {
    return {}
  }
}

async function writeLedger(directory: string, ledger: AutoSkillLedger) {
  const file = ledgerPath(directory)
  await mkdir(path.dirname(file), { recursive: true })
  // Atomic replace: a torn ledger would lose provenance for every skill.
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify({ version: 1, skills: ledger }, null, 2), "utf8")
  await rename(tmp, file)
}

/**
 * The autonomous writer may only touch skills it created (Hermes'
 * background-review write guard). User-authored or pinned skills are refused
 * with a reason the caller can surface instead of silently failing.
 */
export function canAutoWrite(ledger: AutoSkillLedger, name: string): { ok: true } | { ok: false; reason: string } {
  const entry = ledger[name]
  if (!entry) return { ok: true }
  if (entry.createdBy === "user") return { ok: false, reason: "skill is user-authored; the reviewer may not overwrite it" }
  if (entry.pinned === true) return { ok: false, reason: "skill is pinned; unpin it to allow automatic updates" }
  return { ok: true }
}

export async function writeAutoSkill(input: {
  directory: string
  name: string
  description: string
  body: string
  /** true when patching an existing skill (bumps patchCount). */
  patch?: boolean
}): Promise<{ ok: true; path: string; name: string } | { ok: false; reason: string }> {
  const valid = validateAutoSkill(input)
  if (!valid.ok) return valid
  const ledger = await readAutoSkillLedger(input.directory)
  const allowed = canAutoWrite(ledger, valid.name)
  if (!allowed.ok) return allowed

  const dir = autoSkillDir(input.directory)
  const file = path.join(dir, `${valid.name}.md`)
  await mkdir(dir, { recursive: true })
  const frontmatter = [
    "---",
    `name: ${valid.name}`,
    `description: ${valid.description}`,
    "---",
    "",
  ].join("\n")
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, `${frontmatter}${input.body.trim()}\n`, "utf8")
  await rename(tmp, file)

  const now = Date.now()
  const existing = ledger[valid.name]
  ledger[valid.name] = existing
    ? { ...existing, patchCount: existing.patchCount + (input.patch ? 1 : 0), state: "active" }
    : { createdBy: "agent", createdAt: now, useCount: 0, patchCount: 0, state: "active" }
  await writeLedger(input.directory, ledger)
  return { ok: true, path: file, name: valid.name }
}

/** Mark a skill as used so staleness tracking has real data. */
export async function markAutoSkillUsed(directory: string, name: string): Promise<void> {
  const ledger = await readAutoSkillLedger(directory)
  const entry = ledger[name]
  if (!entry) return
  entry.useCount += 1
  entry.lastUsedAt = Date.now()
  entry.state = "active"
  await writeLedger(directory, ledger)
}

/**
 * Deterministic maintenance (the cheap half of Hermes' curator): mark skills
 * unused for 30 days stale, and 90 days stale-and-unused archived. Never
 * deletes; pinned and recently-patched skills are exempt.
 */
export async function runAutoSkillMaintenance(directory: string, now = Date.now()): Promise<{ stale: string[]; archived: string[] }> {
  const ledger = await readAutoSkillLedger(directory)
  const DAY = 24 * 60 * 60 * 1_000
  const stale: string[] = []
  const archived: string[] = []
  let changed = false
  for (const [name, entry] of Object.entries(ledger)) {
    if (entry.pinned === true) continue
    const last = entry.lastUsedAt ?? entry.createdAt
    const age = now - last
    if (entry.state !== "archived" && age > 90 * DAY) {
      entry.state = "archived"
      archived.push(name)
      changed = true
      continue
    }
    if (entry.state === "active" && age > 30 * DAY) {
      entry.state = "stale"
      stale.push(name)
      changed = true
    }
  }
  if (changed) await writeLedger(directory, ledger)
  return { stale, archived }
}

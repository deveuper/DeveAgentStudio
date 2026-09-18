import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadHookRules, matchHookRule, parseHookRules, writeWorkspaceHooks } from "./deveagent-hooks"

describe("deveagent-hooks", () => {
  test("normalizeHookRule keeps deny-only rules and drops everything else", () => {
    expect(parseHookRules({ hooks: [
      { permission: "computer-use", reason: "no CU" },
      { permission: "edit", action: "deny", reason: "no edits" },
      { permission: "edit", action: "allow" }, // allow is invalid — fail-soft drop
      { permission: "" },
      "not-an-object",
    ] }, "workspace")).toEqual([
      { permission: "computer-use", reason: "no CU", source: "workspace" },
      { permission: "edit", reason: "no edits", source: "workspace" },
    ])
  })

  test("matchHookRule family semantics: computer-use governs computer-use-*", () => {
    const rules = [
      { permission: "computer-use", reason: "family deny", source: "workspace" as const },
    ]
    expect(matchHookRule(rules, "computer-use")?.reason).toBe("family deny")
    expect(matchHookRule(rules, "computer-use-click")?.reason).toBe("family deny")
    expect(matchHookRule(rules, "bash")).toBeUndefined()
  })

  test("workspace rules win over user rules on the same permission", () => {
    const rules = [
      { permission: "edit", reason: "user rule", source: "user" as const },
      { permission: "edit", reason: "workspace rule", source: "workspace" as const },
    ]
    expect(matchHookRule(rules, "edit")?.reason).toBe("workspace rule")
  })

  test("writeWorkspaceHooks + loadHookRules round-trips through the workspace", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "deveagent-hooks-"))
    try {
      await writeWorkspaceHooks(dir, { hooks: [{ permission: "webfetch", reason: "offline mode" }] })
      const rules = await loadHookRules(dir)
      expect(rules).toEqual([
        { permission: "webfetch", reason: "offline mode", source: "workspace" },
      ])
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })

  test("a corrupt hooks file degrades to no rules", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "deveagent-hooks-bad-"))
    try {
      const file = path.join(dir, ".deveagent", "hooks.json")
      await writeFile(path.dirname(file), "{}", { recursive: true } as never).catch(() => {})
      const rules = await loadHookRules(dir)
      expect(rules).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })
})

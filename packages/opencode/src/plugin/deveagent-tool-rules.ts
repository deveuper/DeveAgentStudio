// DeveAgent declarative tool permission rules (inspired by Zed's
// `agent.tool_permissions`). Pure, dependency-free decision engine: compile a
// rule list once, then decide `allow` / `ask` / `deny` for one tool call.
//
// This module performs no I/O and is NOT wired into the permission flow yet.
// Wiring it into `permission.ask` is a separate change; until then it is a
// self-contained decision engine with tests.
//
// Security semantics (the parts the guarantees rest on):
//
// 1. Deny always wins. Every matching `deny` rule is evaluated across the
//    whole rule list before any `allow` is considered — a narrow allow can
//    never punch a hole through a deny, no matter how specific it is.
// 2. Most specific wins among the remaining matches. Specificity is the
//    pattern length; a rule with a pattern outranks a rule without one, and a
//    longer pattern outranks a shorter one. This is deterministic and total:
//    equal specificity falls back to action severity (`deny` > `ask` >
//    `allow`) and then to the rule's position in the input array (earlier
//    wins). Documented, not incidental.
// 3. No match → `ask`. The default is never `allow`; an empty rule list, an
//    unknown tool, or a subject that matches nothing all ask.
// 4. A rule without a pattern matches every invocation of that tool.
// 5. Patterns are compiled with `new RegExp(pattern)` and matched against the
//    raw subject (no implicit `^`/`$`). Anchoring is the caller's job —
//    `anchoredPrefix()` builds a safe "starts with this command" pattern.
// 6. An empty subject cannot be tested against a pattern, so a rule whose tool
//    matches still applies: the tool-level decision stands.
//
// Tool names match exactly (case-insensitively). Family/wildcard expansion is
// intentionally NOT applied here (unlike `deveagent-hooks`): a rule for
// `computer-use` does not govern `computer-use-click` unless listed.

export type ToolRuleAction = "allow" | "ask" | "deny"

export type ToolRule = {
  /** tool name this rule matches, e.g. "bash" | "write" | "computer-use" */
  tool: string
  /** optional regex (as a string) matched against the tool's command/path argument */
  pattern?: string
  action: ToolRuleAction
}

export type ToolRuleDecision = { action: ToolRuleAction; rule?: ToolRule; reason: string }

/** A rule with its pattern compiled once, plus its stable input position. */
export type CompiledRule = {
  /** the source rule, verbatim (safe to echo back to UI/telemetry) */
  rule: ToolRule
  /** lowercased tool name used for matching */
  tool: string
  /** compiled pattern; absent for tool-level rules */
  regex?: RegExp
  /** position in the input array — the deterministic tie-break */
  index: number
}

const ACTIONS: ToolRuleAction[] = ["allow", "ask", "deny"]
const REASON_PATTERN_CHARS = 120
/** Action severity, used only to break specificity ties. */
const SEVERITY: Record<ToolRuleAction, number> = { deny: 2, ask: 1, allow: 0 }

function patternLabel(pattern: string | undefined): string {
  if (pattern === undefined) return ""
  const shown = pattern.length > REASON_PATTERN_CHARS ? `${pattern.slice(0, REASON_PATTERN_CHARS)}...` : pattern
  return `, pattern ${JSON.stringify(shown)}`
}

function ruleLabel(entry: CompiledRule): string {
  return `rule #${entry.index} (tool "${entry.rule.tool}"${patternLabel(entry.rule.pattern)}, action ${entry.rule.action})`
}

/**
 * Compile rules once. An invalid regex (or a malformed rule) is a hard error
 * here — never silently dropped and never deferred to match time.
 */
export function compileToolRules(
  rules: ToolRule[],
): { ok: true; compiled: CompiledRule[] } | { ok: false; reason: string } {
  if (!Array.isArray(rules)) return { ok: false, reason: "tool rules must be an array" }
  const compiled: CompiledRule[] = []
  for (let index = 0; index < rules.length; index++) {
    const rule = rules[index]
    if (!rule || typeof rule !== "object") return { ok: false, reason: `rule #${index} is not an object` }
    const tool = typeof rule.tool === "string" ? rule.tool.trim() : ""
    if (!tool) return { ok: false, reason: `rule #${index} has no tool name` }
    if (!ACTIONS.includes(rule.action)) {
      return {
        ok: false,
        reason: `rule #${index} has unknown action ${JSON.stringify(rule.action)} (expected "allow" | "ask" | "deny")`,
      }
    }
    if (rule.pattern !== undefined && typeof rule.pattern !== "string") {
      return { ok: false, reason: `rule #${index} (tool "${tool}") pattern must be a string` }
    }
    let regex: RegExp | undefined
    if (rule.pattern !== undefined) {
      try {
        regex = new RegExp(rule.pattern)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          ok: false,
          reason: `rule #${index} (tool "${tool}") has an invalid regex ${JSON.stringify(rule.pattern)}: ${message}`,
        }
      }
    }
    compiled.push({ rule, tool: tool.toLowerCase(), regex, index })
  }
  return { ok: true, compiled }
}

/** True when the rule's pattern applies to this subject (see semantics 4/6). */
function matchesSubject(entry: CompiledRule, subject: string): boolean {
  if (!entry.regex) return true
  // Empty subject: nothing to test the pattern against, so the tool-level
  // decision stands rather than the rule being silently skipped.
  if (subject === "") return true
  return entry.regex.test(subject)
}

/** Pattern length; -1 for tool-level rules so any pattern outranks them. */
function specificity(entry: CompiledRule): number {
  return entry.rule.pattern === undefined ? -1 : entry.rule.pattern.length
}

/** Most specific wins; ties go to the more severe action, then to the earlier rule. */
function isMoreSpecific(candidate: CompiledRule, current: CompiledRule): boolean {
  const candidateSpecificity = specificity(candidate)
  const currentSpecificity = specificity(current)
  if (candidateSpecificity !== currentSpecificity) return candidateSpecificity > currentSpecificity
  const candidateSeverity = SEVERITY[candidate.rule.action]
  const currentSeverity = SEVERITY[current.rule.action]
  if (candidateSeverity !== currentSeverity) return candidateSeverity > currentSeverity
  return candidate.index < current.index
}

function mostSpecific(entries: CompiledRule[]): CompiledRule {
  return entries.reduce((best, entry) => (isMoreSpecific(entry, best) ? entry : best))
}

/**
 * Decide the action for one tool call. `subject` is the command string
 * (bash), file path (write/edit), or serialized args.
 */
export function decideToolAction(input: { compiled: CompiledRule[]; tool: string; subject: string }): ToolRuleDecision {
  const tool = typeof input.tool === "string" ? input.tool.toLowerCase() : ""
  const subject = typeof input.subject === "string" ? input.subject : ""
  const compiled = Array.isArray(input.compiled) ? input.compiled : []
  const matches = compiled.filter((entry) => entry.tool === tool && matchesSubject(entry, subject))

  // 1. Deny first, across ALL matching rules, before any allow is considered.
  const denied = matches.filter((entry) => entry.rule.action === "deny")
  if (denied.length > 0) {
    const best = mostSpecific(denied)
    return { action: "deny", rule: best.rule, reason: `denied by ${ruleLabel(best)}` }
  }

  // 2. Allow / explicit ask: most specific wins, `ask` breaks equal-specificity
  //    ties against `allow` so an explicit re-ask is never loosened away.
  const candidates = matches.filter((entry) => entry.rule.action !== "deny")
  if (candidates.length === 0) {
    // 3. No match asks. Never allow.
    return { action: "ask", reason: `no tool rule matched tool "${input.tool}" - asking by default` }
  }

  const best = mostSpecific(candidates)
  const verb = best.rule.action === "allow" ? "allowed by" : "confirmation requested by"
  return { action: best.rule.action, rule: best.rule, reason: `${verb} ${ruleLabel(best)}` }
}

const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g

/**
 * Escape a user-approved command into an anchored regex pattern that matches
 * any subject STARTING WITH it: `"^" + escaped(command)`.
 *
 * Regex metacharacters become literals, so `anchoredPrefix("a.b*c")` yields
 * `^a\.b\*c` (matches `a.b*c`, not `axbbc`) and
 * `anchoredPrefix("cargo test -- --nocapture")` yields
 * `^cargo test -- --nocapture`.
 *
 * The result is a prefix guard only: it does not require a word boundary, so
 * a caller that must not accept extra arguments should append one itself,
 * e.g. `anchoredPrefix(cmd) + "(?:\\s|$)"`.
 */
export function anchoredPrefix(command: string): string {
  const text = typeof command === "string" ? command : ""
  return "^" + text.replace(REGEX_METACHARACTERS, "\\$&")
}

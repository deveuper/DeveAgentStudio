// P1-6: honest startup phase timing. Marks are monotonic and each phase is
// recorded exactly once, at the moment it actually happens — nothing marks a
// phase early, so the numbers can be used to find the slow segment. The final
// phase freezes a snapshot onto window.__deveagentStartupTiming (and one
// structured console line) for probes and diagnostics.
export type DeveagentStartupPhase = "script-start" | "workbench-ready" | "composer-ready" | "provider-ready"

type StartupMarks = {
  phases: Partial<Record<DeveagentStartupPhase, number>>
  firstPaintMs?: number
  completedAt?: number
  frozen?: boolean
}

const PHASE_ORDER: DeveagentStartupPhase[] = ["script-start", "workbench-ready", "composer-ready", "provider-ready"]

let marks: StartupMarks = { phases: {} }
let frozenSnapshot: Record<string, unknown> | undefined

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now()
}

export function markDeveagentStartup(phase: DeveagentStartupPhase): number | undefined {
  if (marks.frozen || marks.phases[phase] !== undefined) return marks.phases[phase]
  const at = Math.round(nowMs() - (globalThis as { __deveagentStartupOrigin?: number }).__deveagentStartupOrigin!)
  // Monotonic: a phase can never be recorded earlier than a previous one.
  const previous = Math.max(0, ...PHASE_ORDER.map((name) => marks.phases[name] ?? 0))
  marks.phases[phase] = Math.max(at, previous)
  if (phase === "provider-ready") freezeDeveagentStartup()
  return marks.phases[phase]
}

export function freezeDeveagentStartup(): void {
  if (marks.frozen) return
  try {
    const paint = (performance as Performance)?.getEntriesByName?.("first-paint")?.[0]?.startTime
    if (typeof paint === "number") marks.firstPaintMs = Math.round(paint)
  } catch {
    // Paint entries are optional; the phases still stand on their own.
  }
  const previous = Math.max(0, ...PHASE_ORDER.map((name) => marks.phases[name] ?? 0))
  marks.completedAt = Math.max(Math.round(nowMs() - (globalThis as { __deveagentStartupOrigin?: number }).__deveagentStartupOrigin!), previous)
  marks.frozen = true
  try {
    const snapshot = JSON.parse(JSON.stringify({ ...marks, origin: "performance.now()" })) as Record<string, unknown>
    frozenSnapshot = snapshot
    ;(globalThis as { __deveagentStartupTiming?: Record<string, unknown> }).__deveagentStartupTiming = snapshot
    console.info(`[deveagent-startup] ${JSON.stringify(snapshot)}`)
  } catch {
    // Diagnostics must never break the app.
  }
}

export function deveagentStartupSnapshot(): Record<string, unknown> | undefined {
  return frozenSnapshot
}

export function resetDeveagentStartupForTest(origin?: number): void {
  marks = { phases: {} }
  frozenSnapshot = undefined
  ;(globalThis as { __deveagentStartupOrigin?: number }).__deveagentStartupOrigin = origin ?? (typeof performance !== "undefined" ? performance.now() : Date.now())
}

// The renderer entry sets the origin at its module evaluation so every phase
// measures from the same starting line.
if ((globalThis as { __deveagentStartupOrigin?: number }).__deveagentStartupOrigin === undefined) {
  ;(globalThis as { __deveagentStartupOrigin?: number }).__deveagentStartupOrigin = nowMs()
}

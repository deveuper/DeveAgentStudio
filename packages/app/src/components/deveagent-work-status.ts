// R200/R202 — planning and unattended-run visibility: the pure decisions.
//
// The composer shows a work-status strip while a turn is in flight. Plan mode
// is the case the user called out ("you cannot tell it is planning"): before
// R200 nothing in the conversation area said so, only the mode chip and one
// word in the status bar. R202 extends the wording to named goal/loop phases.
//
// Pure and testable: which kind of work is happening, what it says, and how
// long it has been running or until the next scheduled pass.

export type WorkStatusKind = "idle" | "planning" | "executing"

/** Plan mode plans; every other mode executes. Idle when no turn is running. */
export function workStatusKind(working: boolean, mode: string | undefined): WorkStatusKind {
  if (!working) return "idle"
  return mode === "plan" ? "planning" : "executing"
}

/** Work-status label; the caller supplies its dictionary translator so this stays pure. */
export function workStatusLabel(
  kind: WorkStatusKind,
  mode: string | undefined,
  t: (key: string) => string,
): string {
  if (kind === "planning") return t("deveagent.composer.statusPlanning")
  if (kind !== "executing") return ""
  if (mode === "goal") return t("deveagent.composer.statusGoal")
  if (mode === "loop") return t("deveagent.composer.statusLoop")
  return t("deveagent.composer.statusWorking")
}

/** Compact elapsed marker: "", 5s, 1m05s, 1h02m. */
export function formatElapsed(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ""
  const total = Math.floor(seconds)
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) {
    const rest = total % 60
    return rest === 0 ? `${minutes}m` : `${minutes}m${String(rest).padStart(2, "0")}s`
  }
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, "0")}m`
}

/**
 * R202: countdown to a scheduled run. MM:SS under an hour, H:MM:SS above it.
 * Empty when nothing is scheduled — including an already-passed target, which
 * means the next tick is imminent rather than a frozen "00:00".
 */
export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ""
  const total = Math.floor(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number) => String(value).padStart(2, "0")
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

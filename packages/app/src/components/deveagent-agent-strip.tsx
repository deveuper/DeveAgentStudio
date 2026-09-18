import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { createLowPowerInterval } from "@/context/low-power"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useSync } from "@/context/sync"
import { useSessionLayout } from "@/pages/session/session-layout"
import { showToast } from "@/utils/toast"

type AgentJob = {
  id: string
  type: string
  title?: string
  status: string
  started_at?: number
  completed_at?: number
  error?: string
  metadata?: {
    parentSessionId?: string
    sessionId?: string
    deveagentTeam?: boolean
    // Only present when the jobs route forwards the child session's usage.
    // Absent must render as unknown, never as zero.
    usage?: unknown
    cost?: unknown
  }
}

type GoalState = {
  active?: boolean
  status?: string
  description?: string
  criteria?: string[]
  criteriaDone?: boolean[]
  reentries?: number
  maxReentries?: number
}

type TokenUsage = {
  total?: unknown
  input?: unknown
  output?: unknown
  reasoning?: unknown
  cache?: { read?: unknown; write?: unknown }
}

const finiteNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

/**
 * A reported cost is only a cost when it is positive: the session row defaults
 * `cost` to 0 before anything is billed, so zero is indistinguishable from
 * "nothing reported yet" and must stay unknown (same rule as the metrics view).
 */
const positiveNumber = (value: unknown) => {
  const parsed = finiteNumber(value)
  return parsed !== undefined && parsed > 0 ? parsed : undefined
}

/**
 * Usage is cumulative and server-reported. Zero means "nothing reported yet" —
 * that is unknown, not a count, so it stays undefined and the row renders "—".
 * A bare number is accepted because the field arrives as untyped JSON.
 */
const tokenTotal = (tokens: TokenUsage | number | undefined) => {
  if (typeof tokens === "number") return positiveNumber(tokens)
  if (!tokens || typeof tokens !== "object") return undefined
  const part = (value: unknown) => finiteNumber(value) ?? 0
  const reported = part(tokens.total)
  const summed =
    part(tokens.input) + part(tokens.output) + part(tokens.reasoning) + part(tokens.cache?.read) + part(tokens.cache?.write)
  const total = reported > 0 ? reported : summed
  return total > 0 ? total : undefined
}

/**
 * Sub-agent status strip (Codex/ZCode style): a compact bar INSIDE the composer
 * frame, above the input, showing what the agent is doing right now — running
 * sub-agents, the active goal's progress, and the artifacts they produced.
 *
 * Collapsed it is one line; expanded it lists each child session with its own
 * status. Data comes from the same registry the Overview board reads, so the
 * strip never invents a progress number.
 */
export function DeveagentAgentStrip() {
  const language = useLanguage()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const sync = useSync()
  const { params } = useSessionLayout()
  const [open, setOpen] = createSignal(false)
  const [tick, setTick] = createSignal(0)
  // Two-step kill confirm, same shape as the Overview agent board but sized for
  // a strip row: first click arms one row, the second one cancels it.
  const [armed, setArmed] = createSignal<string | undefined>(undefined)
  const [busy, setBusy] = createSignal(false)
  // This strip lives INSIDE the always-mounted composer, so it cannot rely on
  // mount lifetime to bound its polling the way the Overview cards can. It
  // shows live progress during a turn (which must stay responsive) but a
  // background team job or goal can also run while the parent session is idle,
  // so a hard stop would hide real work. Two speeds instead:
  //   - fast: a turn is in flight, the strip is expanded, or the last snapshot
  //     still shows running jobs / an active goal — the user is watching.
  //   - slow: nothing to report yet, but still poll so a job started from the
  //     Team panel while idle is discovered.
  const turnRunning = createMemo(() => params.id !== undefined && sync().data.session_status[params.id!]?.type === "busy")

  const [jobs] = createResource(
    () => ({ directory: sdk().directory, sessionID: params.id ?? undefined, tick: tick() }),
    async (source): Promise<AgentJob[]> => {
      if (!source.directory || !source.sessionID) return []
      try {
        const url = `${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/background-jobs?directory=${encodeURIComponent(source.directory)}&sessionID=${encodeURIComponent(source.sessionID)}`
        const response = await serverSDK().fetch(url)
        if (!response.ok) return []
        const data = (await response.json()) as { jobs?: AgentJob[] }
        return Array.isArray(data) ? (data as AgentJob[]) : (data.jobs ?? [])
      } catch {
        return []
      }
    },
  )

  const [goal] = createResource(
    () => ({ directory: sdk().directory, sessionID: params.id ?? undefined, tick: tick() }),
    async (source): Promise<GoalState | undefined> => {
      if (!source.directory || !source.sessionID) return undefined
      try {
        const url = `${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/goal`
        const response = await serverSDK().fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionID: source.sessionID, directory: source.directory }),
        })
        if (!response.ok) return undefined
        const data = (await response.json()) as GoalState & { data?: GoalState }
        return data?.data ?? data
      } catch {
        return undefined
      }
    },
  )

  const hasRunningJobs = createMemo(() => (jobs() ?? []).some((job) => job.status === "running"))
  const hasActiveGoal = createMemo(() => goal()?.active === true)
  const live = createMemo(() => turnRunning() || open() || hasRunningJobs() || hasActiveGoal())

  // Both cadences stretch 4x under low power. Keeping the timer running and
  // skipping the tick is the same pattern the status bar uses for its bucketed
  // revisions: the resource source object is rebuilt only when the tick moves.
  createLowPowerInterval(() => {
    if (!live()) return
    setTick((value) => value + 1)
  }, 5_000)
  createLowPowerInterval(() => {
    if (live()) return
    setTick((value) => value + 1)
  }, 15_000)

  const running = createMemo(() => (jobs() ?? []).filter((job) => job.status === "running"))
  const finished = createMemo(() => (jobs() ?? []).filter((job) => job.status === "completed"))
  // Left as the pre-existing bucket so the collapsed summary keeps reporting
  // exactly what it reported before. The per-child row below still renders the
  // registry's real "error"/"cancelled" statuses honestly.
  const failed = createMemo(() => (jobs() ?? []).filter((job) => job.status === "failed"))
  const activeGoal = createMemo(() => {
    const value = goal()
    return value?.active === true ? value : undefined
  })
  const criteriaDone = createMemo(() => (activeGoal()?.criteriaDone ?? []).filter(Boolean).length)
  const criteriaTotal = createMemo(() => (activeGoal()?.criteria ?? []).length)

  // Visible only when there is something to say: a run in flight, a goal in
  // progress, or children that just finished. An idle session shows nothing.
  const visible = createMemo(() => running().length > 0 || failed().length > 0 || Boolean(activeGoal()) || finished().length > 0)

  const summary = createMemo(() => {
    const parts: string[] = []
    if (running().length > 0) parts.push(language.t("deveagent.agentStrip.running", { count: running().length }))
    if (finished().length > 0 && running().length === 0) parts.push(language.t("deveagent.agentStrip.finished", { count: finished().length }))
    if (failed().length > 0) parts.push(language.t("deveagent.agentStrip.failed", { count: failed().length }))
    return parts.join(" · ")
  })

  const jobLabel = (job: AgentJob) => job.title || job.id

  // Elapsed is derived, never invented: without a finite start it is unknown,
  // and a finished job without a completion stamp stays unknown rather than
  // counting up against the wall clock.
  const elapsed = (job: AgentJob) => {
    if (typeof job.started_at !== "number" || !Number.isFinite(job.started_at)) return undefined
    const ended = typeof job.completed_at === "number" && Number.isFinite(job.completed_at)
      ? job.completed_at
      : job.status === "running"
        ? Date.now()
        : undefined
    if (ended === undefined) return undefined
    const seconds = Math.max(0, Math.round((ended - job.started_at) / 1000))
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`
  }

  const number = createMemo(() => new Intl.NumberFormat(language.intl()))
  const compact = (value: number) => {
    const trimOne = (input: number) => {
      const rounded = Math.round(input * 10) / 10
      return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
    }
    if (value >= 1_000_000) return `${trimOne(value / 1_000_000)}M`
    if (value >= 1_000) return `${trimOne(value / 1_000)}K`
    return number().format(value)
  }

  // The jobs route forwards whatever usage the registry kept for the child.
  // OpenCode derives those costs from the models.dev catalog, which is priced
  // in USD (same convention as detectDeveAgentNativeCurrency). A field the
  // server did not send renders as "—" — never as 0 and never estimated.
  const childUsage = (job: AgentJob) => {
    const usage = job.metadata?.usage as TokenUsage | number | undefined
    return { tokens: tokenTotal(usage), cost: positiveNumber(job.metadata?.cost) }
  }
  const tokenLabel = (job: AgentJob) => {
    const tokens = childUsage(job).tokens
    return tokens === undefined ? undefined : `${compact(tokens)} tok`
  }
  const costLabel = (job: AgentJob) => {
    const cost = childUsage(job).cost
    if (cost === undefined) return undefined
    return new Intl.NumberFormat(language.intl(), {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    }).format(cost)
  }
  // Both fields unknown collapses to a single "—" so an all-unknown row is not
  // a wall of dashes; the tooltip still names each field.
  const usageLabel = (job: AgentJob) => {
    const tokens = tokenLabel(job)
    const cost = costLabel(job)
    if (tokens === undefined && cost === undefined) return "—"
    return `${tokens ?? "—"} · ${cost ?? "—"}`
  }
  const usageTitle = (job: AgentJob) =>
    `${language.t("context.usage.tokens")}: ${tokenLabel(job) ?? "—"} · ${language.t("deveagent.statusbar.cost")}: ${costLabel(job) ?? "—"}`

  // The registry ends jobs as running | completed | error | cancelled; older
  // persisted rows may still say "failed". Anything else is an unknown status
  // and renders as neutral rather than borrowing a running colour.
  const statusGlyph = (job: AgentJob) => {
    if (job.status === "completed") return "✓"
    if (job.status === "failed" || job.status === "error") return "✗"
    if (job.status === "cancelled") return "⊘"
    if (job.status === "running") return "◐"
    return "·"
  }
  const statusColor = (job: AgentJob) => {
    if (job.status === "completed") return "var(--v2-state-fg-success)"
    if (job.status === "failed" || job.status === "error") return "var(--v2-state-fg-danger)"
    if (job.status === "cancelled") return "var(--v2-text-text-faint)"
    if (job.status === "running") return "var(--v2-state-fg-warning)"
    return "var(--v2-text-text-faint)"
  }

  const cancel = async (job: AgentJob) => {
    if (busy()) return
    setBusy(true)
    try {
      const url = `${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/background-jobs/cancel`
      const response = await serverSDK().fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobID: job.id, sessionID: job.metadata?.parentSessionId ?? params.id, directory: sdk().directory }),
      })
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string }
      if (response.ok && data.ok !== false) {
        showToast({ title: language.t("deveagent.agents.cancellationRequested"), description: jobLabel(job) })
        setArmed(undefined)
        // The registry is authoritative; re-read it instead of flipping the row
        // locally, so a rejected cancel cannot look like a successful kill.
        setTick((value) => value + 1)
      } else {
        showToast({
          title: language.t("deveagent.agents.cancelFailed"),
          description: data.error ?? language.t("deveagent.agents.tryAgainLater"),
        })
      }
    } catch {
      showToast({ title: language.t("deveagent.agents.cancelFailed"), description: language.t("deveagent.agents.tryAgainLater") })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show when={visible()}>
      <div
        data-component="deveagent-agent-strip"
        class="mx-1 mb-1 rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-01 text-[12px]"
      >
        <button
          type="button"
          data-action="deveagent-agent-strip-toggle"
          class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
          aria-expanded={open()}
          onClick={() => {
            const next = !open()
            setOpen(next)
            // Collapsing hides the rows, so a half-armed kill must not survive
            // to be fired by a later unrelated expand.
            if (!next) setArmed(undefined)
          }}
        >
          <span
            class="size-1.5 shrink-0 rounded-full"
            classList={{
              "animate-pulse": running().length > 0,
            }}
            style={{
              background: failed().length > 0
                ? "var(--v2-state-fg-danger)"
                : running().length > 0
                  ? "var(--v2-state-fg-warning)"
                  : "var(--v2-state-fg-success)",
            }}
          />
          <Show when={activeGoal()}>
            <span class="shrink-0 text-v2-text-text-base">{language.t("deveagent.agentStrip.goal")}</span>
            <Show when={criteriaTotal() > 0}>
              <span class="shrink-0 tabular-nums text-v2-text-text-muted">
                {criteriaDone()}/{criteriaTotal()}
              </span>
              <span class="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-v2-border-border-muted">
                <span
                  class="block h-full rounded-full transition-all"
                  style={{
                    width: `${criteriaTotal() > 0 ? Math.round((criteriaDone() / criteriaTotal()) * 100) : 0}%`,
                    background: "var(--v2-state-fg-accent)",
                  }}
                />
              </span>
            </Show>
          </Show>
          <Show when={summary()}>
            <span class="min-w-0 truncate text-v2-text-text-muted">{summary()}</span>
          </Show>
          <span class="flex-1" />
          <span class="shrink-0 text-v2-text-text-faint select-none" aria-hidden="true">
            {open() ? "▾" : "▸"}
          </span>
        </button>
        <Show when={open()}>
          <div class="flex flex-col gap-1 border-t border-v2-border-border-muted px-2.5 py-1.5">
            <For each={jobs() ?? []}>
              {(job) => (
                <div class="flex items-center gap-2" data-component="deveagent-agent-strip-row">
                  <span
                    class="shrink-0"
                    title={job.status}
                    style={{ color: statusColor(job) }}
                  >
                    {statusGlyph(job)}
                  </span>
                  <span class="min-w-0 flex-1 truncate text-v2-text-text-base" title={jobLabel(job)}>
                    {jobLabel(job)}
                  </span>
                  {/* Usage is whatever the jobs route reported for this child;
                      "—" is the only correct rendering when it reported none. */}
                  <span class="shrink-0 tabular-nums text-v2-text-text-faint" title={usageTitle(job)} data-component="deveagent-agent-strip-row-usage">
                    {usageLabel(job)}
                  </span>
                  <span class="shrink-0 tabular-nums text-v2-text-text-faint">{elapsed(job) ?? "—"}</span>
                  <Show when={job.status === "running"}>
                    <Show
                      when={armed() === job.id}
                      fallback={
                        <button
                          type="button"
                          data-action="deveagent-agent-strip-kill"
                          class="shrink-0 rounded border border-v2-border-border-muted px-1.5 py-0.5 text-[10px] text-v2-text-text-base hover:bg-v2-background-bg-layer-02"
                          aria-label={`${language.t("deveagent.agents.cancel")}: ${jobLabel(job)}`}
                          onClick={() => setArmed(job.id)}
                        >
                          {language.t("deveagent.agents.cancel")}
                        </button>
                      }
                    >
                      <button
                        type="button"
                        data-action="deveagent-agent-strip-kill-confirm"
                        disabled={busy()}
                        class="shrink-0 rounded border border-v2-state-fg-danger/50 px-1.5 py-0.5 text-[10px] text-v2-state-fg-danger disabled:opacity-50"
                        onClick={() => void cancel(job)}
                      >
                        {busy() ? language.t("deveagent.agents.cancelling") : language.t("deveagent.agents.confirmCancel")}
                      </button>
                    </Show>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  )
}

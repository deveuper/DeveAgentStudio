import { createMemo, createResource, createSignal, Show } from "solid-js"

import { createLowPowerInterval, lowPowerPeriod, useLowPower } from "@/context/low-power"
import { Popover as KbPopover } from "@kobalte/core/popover"

import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useSDK } from "@/context/sdk"
import { createDeveAgentSessionMetrics } from "@/components/deveagent-session-metrics"
import { formatCountdown } from "@/components/deveagent-work-status"
import { useDeveAgentComposerState } from "@/components/deveagent-composer-state"
import { useSessionLayout } from "@/pages/session/session-layout"

type GoalState = {
  active: boolean
  status?: string
  description?: string
  criteria?: string[]
  criteriaDone?: boolean[]
  autoIterate?: boolean
  iterations?: number
  reentries?: number
  maxReentries?: number
  startedAt?: number
  verifiedAt?: number
  attempts?: Array<{ status?: "running" | "completed" | "failed" | "interrupted" }>
}
type GoalDraftState = { active: boolean; description?: string; createdAt?: number }
type LoopState = {
  active: boolean
  status?: "running" | "paused" | "completed" | "failed"
  task?: string
  runCount?: number
  maxRuns?: number
  intervalSeconds?: number
  /** R202: epoch ms of the next scheduled pass (absent when paused/completed). */
  nextRunAt?: number
}
type GrillingState = { started: boolean; completed?: boolean; startedAt?: string; completedAt?: string; elapsedMs?: number; decisionCount: number }

export function DeveagentStatusBar(props: { showTerminalToggle?: boolean } = {}) {
  const language = useLanguage()
  const formatElapsed = (ms: number) => {
    const seconds = Math.max(0, Math.floor(ms / 1000))
    const minutes = Math.floor(seconds / 60)
    return minutes > 0 ? `${minutes}${language.t("deveagent.statusbar.minutes")}${seconds % 60}${language.t("deveagent.statusbar.seconds")}` : `${seconds}${language.t("deveagent.statusbar.seconds")}`
  }
  const serverSDK = useServerSDK()
  const sdk = useSDK()
  const sessionMetrics = createDeveAgentSessionMetrics()
  const composer = useDeveAgentComposerState()
  const { params, view } = useSessionLayout()
  const base = () => serverSDK().url.replace(/\/+$/, "")
  const [clock, setClock] = createSignal(Date.now())
  const lowPower = useLowPower()
  // Resource source objects must not be rebuilt on every timer tick.
  const every2s = createMemo(() => Math.floor(clock() / lowPowerPeriod(2_000, lowPower.enabled())))
  const every5s = createMemo(() => Math.floor(clock() / lowPowerPeriod(5_000, lowPower.enabled())))
  const every10s = createMemo(() => Math.floor(clock() / lowPowerPeriod(10_000, lowPower.enabled())))
  const every15s = createMemo(() => Math.floor(clock() / lowPowerPeriod(15_000, lowPower.enabled())))
  const [moreOpen, setMoreOpen] = createSignal(false)
  const [goalCriteria, setGoalCriteria] = createSignal("")
  const goalCriteriaList = createMemo(() => goalCriteria().split(/\n|;/).map((item) => item.trim()).filter(Boolean))

  createLowPowerInterval(() => setClock(Date.now()), 1_000)

  const [loopCancelArmed, setLoopCancelArmed] = createSignal(false)
  const grillingEnabled = createMemo(() => composer.snapshot().selectedSkills.some((skill) => skill.id === "grill-me" && skill.enabled))

  // ponytail: sessions opened inside a managed worktree get a visible badge
  // (◈ wt:<name>) so isolation context is never a surprise mid-run.
  const worktreeBadge = createMemo(() => {
    const dir = sdk().directory.replaceAll("\\", "/")
    const match = dir.match(/\/([^/]+)-worktrees\/deveagent\/worktrees\/([^/]+)/)
    return match ? match[2] : undefined
  })

  // ponytail: project trust gate — a workspace that ships executable resources
  // (plugins/MCP) stays blocked until trusted; the chip is the visible receipt.
  const [trustState] = createResource(
    () => (sdk().directory ? { url: base(), directory: sdk().directory, revision: every15s() } : undefined),
    async (input): Promise<{ status: string; resources: unknown[] } | undefined> => {
      try {
        const response = await serverSDK().fetch(`${input.url}/api/deveagent/trust`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory: input.directory }),
        })
        if (!response.ok) return undefined
        return (await response.json()) as { status: string; resources: unknown[] }
      } catch {
        return undefined
      }
    },
    { initialValue: undefined },
  )
  const trustBlocked = createMemo(() => {
    const state = trustState()
    return state && Array.isArray(state.resources) && state.resources.length > 0 && state.status !== "trusted" ? state : undefined
  })

  // CU permission level (A8): persistent warning chip when the workspace opts
  // into auto-approve or full access for computer-use actions.
  const [cuLevel] = createResource(
    () => (sdk().directory ? { url: base(), directory: sdk().directory, revision: every10s() } : undefined),
    async (input): Promise<string | undefined> => {
      try {
        const response = await serverSDK().fetch(`${input.url}/api/deveagent/cu-level`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory: input.directory }),
        })
        if (!response.ok) return undefined
        const data = (await response.json()) as { level?: string }
        return data.level
      } catch {
        return undefined
      }
    },
  )
  const cuLevelWarning = createMemo(() => {
    const level = cuLevel()
    if (level !== "auto" && level !== "full") return undefined
    return level === "full"
      ? { label: language.t("deveagent.statusbar.cuFullAccess"), title: language.t("deveagent.statusbar.cuFullAccessHint"), danger: true }
      : { label: language.t("deveagent.statusbar.cuAutoApprove"), title: language.t("deveagent.statusbar.cuAutoApproveHint"), danger: false }
  })

  // ponytail: live compaction status (Codex parity) — the session info carries
  // time.compacting from the moment compaction starts; show an elapsed chip
  // while it is set. The 1s clock drives the timer for free.
  const [compactingAt] = createResource(
    () => (params.id ? { url: serverSDK().url, sessionID: params.id, directory: sdk().directory, revision: every2s() } : undefined),
    async (input): Promise<number | undefined> => {
      try {
        const response = await serverSDK().fetch(`${input.url.replace(/\/+$/, "")}/session/${encodeURIComponent(input.sessionID)}?directory=${encodeURIComponent(input.directory)}`)
        if (!response.ok) return undefined
        const info = (await response.json()) as { time?: { compacting?: number } }
        return typeof info?.time?.compacting === "number" ? info.time.compacting : undefined
      } catch {
        return undefined
      }
    },
    { initialValue: undefined },
  )
  const compactingElapsed = createMemo(() => {
    const at = compactingAt()
    if (!at) return undefined
    const seconds = Math.max(0, Math.floor((clock() - at) / 1000))
    return `${language.t("deveagent.statusbar.compacting")} ${formatElapsed(seconds * 1000)}`
  })
  const [grilling] = createResource(
    // Query the session even after the Skill is removed so a completed interview's
    // real duration remains visible when Composer state changes.
    () => params.id ? { base: base(), sessionID: params.id, revision: every5s() } : undefined,
    async (input): Promise<GrillingState> => {
      try {
        const response = await serverSDK().fetch(`${input.base}/api/deveagent/grilling?sessionID=${encodeURIComponent(input.sessionID)}`)
        if (!response.ok) return { started: false, decisionCount: 0 }
        return await response.json() as GrillingState
      } catch {
        return { started: false, decisionCount: 0 }
      }
    },
  )
  const grillingLabel = createMemo(() => {
    const value = grilling()
    if (!value?.started) return language.t("deveagent.statusbar.grillingAwaitingConfirm")
    const endedAt = value.completedAt ? Date.parse(value.completedAt) : clock()
    const startedAt = value.startedAt ? Date.parse(value.startedAt) : endedAt
    const duration = formatElapsed(endedAt - startedAt)
    return value.completed
      ? `${language.t("deveagent.statusbar.grillingDone")} ${duration} · ${value.decisionCount} ${language.t("deveagent.statusbar.decisions")}`
      : `Grilling ${duration} · ${value.decisionCount} ${language.t("deveagent.statusbar.decisions")}`
  })

  const showGrilling = createMemo(() => grillingEnabled() || grilling()?.started === true)

  const [goal, { refetch: refetchGoal }] = createResource(
    () => (params.id ? { url: serverSDK().url, sessionID: params.id, revision: every5s() } : undefined),
    async (input): Promise<GoalState> => {
      try {
        const response = await serverSDK().fetch(`${input.url.replace(/\/+$/, "")}/api/deveagent/goal`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionID: input.sessionID }),
        })
        if (!response.ok) return { active: false }
        const text = await response.text()
        if (!text) return { active: false }
        return JSON.parse(text) as GoalState
      } catch {
        return { active: false }
      }
    },
    { initialValue: { active: false } as GoalState },
  )
  const goalAttemptLabel = createMemo(() => {
    const status = goal()?.attempts?.at(-1)?.status
    return status === "running" ? language.t("deveagent.statusbar.running") : status === "completed" ? language.t("deveagent.statusbar.lastPassDone") : status === "failed" ? language.t("deveagent.statusbar.lastPassFailed") : status === "interrupted" ? language.t("deveagent.statusbar.interruptedByRestart") : ""
  })

  const cancelGoal = async () => {
    if (!params.id) return
    try {
      await serverSDK().fetch(`${base()}/api/deveagent/goal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clear: true, sessionID: params.id }),
      })
    } catch {
      // ponytail: cancelling a goal is best-effort; never crash the status bar
    }
    refetchGoal()
  }
  const [goalDraft, { refetch: refetchGoalDraft }] = createResource(
    () => (params.id ? { url: serverSDK().url, sessionID: params.id, revision: every5s() } : undefined),
    async (input): Promise<GoalDraftState> => {
      try {
        const response = await serverSDK().fetch(`${input.url.replace(/\/+$/, "")}/api/deveagent/goal/draft`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionID: input.sessionID }),
        })
        return response.ok ? await response.json() as GoalDraftState : { active: false }
      } catch {
        return { active: false }
      }
    },
    { initialValue: { active: false } as GoalDraftState },
  )
  const [autoIterate, setAutoIterate] = createSignal(false)
  const confirmGoalDraft = async () => {
    if (!params.id) return
    const criteria = goalCriteriaList()
    if (!criteria.length) return
    try {
      const response = await serverSDK().fetch(`${base()}/api/deveagent/goal/draft`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "confirm",
          sessionID: params.id,
          directory: sdk().directory,
          criteria,
          // ponytail: self-iteration opt-in from the composer draft bar.
          ...(autoIterate() ? { autoIterate: true, maxIterations: 3 } : {}),
        }),
      })
      if (!response.ok) return
      refetchGoal()
      refetchGoalDraft()
    } catch {
      // ponytail: the backend keeps the draft on a failed confirmation; user can retry.
    }
  }
  const cancelGoalDraft = async () => {
    if (!params.id) return
    try {
      await serverSDK().fetch(`${base()}/api/deveagent/goal/draft`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "clear", sessionID: params.id }),
      })
    } finally {
      refetchGoalDraft()
    }
  }
  const [loop, { refetch: refetchLoop }] = createResource(
    () => (params.id ? { url: serverSDK().url, sessionID: params.id, revision: every5s() } : undefined),
    async (input): Promise<LoopState> => {
      try {
        const response = await serverSDK().fetch(`${input.url.replace(/\/+$/, "")}/api/deveagent/loop`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionID: input.sessionID }),
        })
        if (!response.ok) return { active: false }
        return await response.json() as LoopState
      } catch {
        return { active: false }
      }
    },
    { initialValue: { active: false } as LoopState },
  )
  const updateLoop = async (action: "pause" | "resume" | "cancel") => {
    if (!params.id) return
    try {
      await serverSDK().fetch(`${base()}/api/deveagent/loop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, sessionID: params.id }),
      })
    } catch {
      // A status-bar action is best-effort; the persisted worker remains authoritative.
    }
    refetchLoop()
  }
  const number = createMemo(() => new Intl.NumberFormat(language.intl()))
  const costLabel = () => {
    const entries = sessionMetrics.costEntries()
    if (!entries.length) return language.t("deveagent.statusbar.pending")
    const totals = new Map<string, number>()
    for (const entry of entries) totals.set(entry.currency ?? "USD", (totals.get(entry.currency ?? "USD") ?? 0) + (entry.amount ?? 0))
    return `${language.t("deveagent.statusbar.estimated")} ${[...totals].map(([currency, amount]) => new Intl.NumberFormat(language.intl(), { style: "currency", currency, minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(amount)).join(" + ")}`
  }
  const cacheHitRate = () =>
    sessionMetrics.cacheHitRate().toLocaleString(language.intl(), {
      maximumFractionDigits: 2,
    })
  // C1: context() is built from the last assistant message WITH usage, so an
  // undefined context means "no usage reported yet" — not "no model selected".
  // The old fallback contradicted the model chip on the same bar.
  const modelLabel = () => sessionMetrics.context()?.modelLabel ?? language.t("deveagent.statusbar.noModelUsage")
  const providerLabel = () => sessionMetrics.context()?.providerLabel ?? language.t("deveagent.statusbar.noProviderUsage")
  const permissionLabel = () =>
    composer.snapshot().permissionMode === "default"
      ? language.t("deveagent.statusbar.permissionDefault")
      : composer.snapshot().permissionMode === "auto"
        ? language.t("deveagent.statusbar.autoApprove")
        : language.t("deveagent.statusbar.fullAccess")
  const goalLabel = createMemo(() => {
    const value = goal()
    if (!value?.active || !value.startedAt) return ""
    const endedAt = value.verifiedAt ?? clock()
    const duration = formatElapsed(endedAt - value.startedAt)
    return value.status === "verified" ? `${language.t("deveagent.statusbar.goalDone")} ${duration}` : `Goal ${duration}`
  })

  return (
    <div
      data-component="deveagent-statusbar"
      class="relative z-10 flex min-h-7 min-w-0 max-w-full shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-v2-border-border-muted bg-surface-raised-base px-3 py-1 text-[11px] select-none"
      style={{ contain: "inline-size" }}
    >
      <span class="flex shrink-0 items-center gap-1">
        <span
          class="size-1.5 rounded-full"
          style={{ background: sessionMetrics.hasUsage() ? "var(--v2-state-fg-success)" : "var(--v2-state-fg-warning)" }}
        />
        <span class="text-v2-text-text-muted">{sessionMetrics.hasUsage() ? language.t("deveagent.statusbar.usage") : language.t("deveagent.statusbar.ready")}</span>
      </span>
      <DotSep />
      <StatusMetric
        label={language.t("deveagent.statusbar.context")}
        value={sessionMetrics.hasContext() && sessionMetrics.contextLimit() ? `${Math.round(sessionMetrics.contextUsage())}%` : "--"}
        tone={sessionMetrics.contextUsage() > 80 ? "danger" : sessionMetrics.contextUsage() > 50 ? "warning" : "base"}
      />
      <DotSep />
      <StatusMetric dataAction="deveagent-statusbar-cache" label={language.t("deveagent.statusbar.cacheHit")} value={sessionMetrics.hasUsage() ? `${cacheHitRate()}%` : "--"} tone="base" />
      <DotSep />
      <StatusMetric dataAction="deveagent-statusbar-tokens" label="Tokens" value={sessionMetrics.hasUsage() ? number().format(sessionMetrics.sessionTotalTokens()) : "--"} tone="base" />
      <DotSep />
      <StatusMetric dataAction="deveagent-statusbar-cost" label={language.t("deveagent.statusbar.cost")} value={costLabel()} tone="base" />
      <DotSep />
      <StatusMetric dataAction="deveagent-statusbar-rounds" label={language.t("deveagent.statusbar.rounds")} value={number().format(sessionMetrics.rounds())} tone="base" />
      <Show when={compactingElapsed()}>
        <DotSep />
        <span class="shrink-0 text-v2-state-fg-warning" title={language.t("deveagent.statusbar.compactionRunning")}>
          {compactingElapsed()}
        </span>
      </Show>
      <DotSep />
      <Show when={worktreeBadge()}>
        <DotSep />
        <button
          type="button"
          class="shrink-0 text-v2-text-text-accent hover:text-v2-text-text-base"
          title={language.t("deveagent.statusbar.openWorktrees")}
          onClick={() => window.dispatchEvent(new CustomEvent("deveagent:open-panel", { detail: "worktrees" }))}
          data-action="deveagent-statusbar-worktrees"
        >
          ◈ wt:{worktreeBadge()}
        </button>
      </Show>
      <Show when={cuLevelWarning()}>
        <DotSep />
        <span
          class="shrink-0 font-medium"
          classList={{
            "text-v2-state-fg-danger": cuLevelWarning()!.danger,
            "text-v2-state-fg-warning": !cuLevelWarning()!.danger,
          }}
          title={cuLevelWarning()!.title}
          data-component="deveagent-statusbar-cu-level"
        >
          ⛨ {cuLevelWarning()!.label}
        </span>
      </Show>
      <Show when={trustBlocked()}>
        <DotSep />
        <button
          type="button"
          class="shrink-0 text-v2-state-fg-warning hover:text-v2-text-text-base"
          title={language.t("deveagent.statusbar.untrustedProjectHint")}
          onClick={() => window.dispatchEvent(new CustomEvent("deveagent:open-panel", { detail: "metrics" }))}
          data-action="deveagent-statusbar-trust"
        >
          ⛨ {language.t("deveagent.statusbar.untrustedProject")}
        </button>
      </Show>
      <span class="shrink-0">
        <span class="text-v2-text-text-muted">{language.t("deveagent.statusbar.mode")}</span> <span class="text-v2-text-text-base">{composer.snapshot().mode}</span>
      </span>
      <DotSep />
      <span class="shrink-0 text-v2-text-text-muted">{permissionLabel()}</span>
      <Show when={goal()?.active && goal()?.startedAt}>
        <DotSep />
        <span class="flex items-center gap-1 shrink-0 rounded bg-v2-background-bg-accent/10 px-1.5 py-0.5 text-v2-text-text-accent">
          <span class="max-w-[180px] truncate" title={`${goal()?.status ?? ""} · ${goal()?.description ?? ""}`}>
            {goalLabel()}: {goal()?.description}
          </span>
          <Show when={goal()?.status === "in_progress"}>
            <span class="text-[9px] opacity-70">
              {(() => {
                const done = (goal()?.criteriaDone ?? []).filter(Boolean).length
                const total = (goal()?.criteria ?? []).length
                return total > 0 ? `${done}/${total} · ` : ""
              })()}
              {goal()?.autoIterate ? `∞ ` : ""}{goal()?.reentries ?? 0}/{goal()?.maxReentries ?? 8}
              <Show when={goal()?.startedAt}>
                {" · "}{(() => {
                  const seconds = Math.max(0, Math.floor((clock() - goal()!.startedAt!) / 1000))
                  const h = Math.floor(seconds / 3600)
                  const m = Math.floor((seconds % 3600) / 60)
                  return h > 0 ? `${h}h${m}m` : m > 0 ? `${m}m` : `${seconds}s`
                })()}
              </Show>
            </span>
            <Show when={goalAttemptLabel()}>
              <span class="text-[9px] opacity-70">{goalAttemptLabel()}</span>
            </Show>
            <button
              type="button"
              class="hover:text-[var(--v2-state-fg-danger)]"
              aria-label={language.t("deveagent.statusbar.cancelGoal")}
              title={language.t("deveagent.statusbar.cancelGoal")}
              onClick={cancelGoal}
            >
              ×
            </button>
          </Show>
        </span>
      </Show>
      <Show when={goalDraft()?.active && !goal()?.active}>
        <DotSep />
        <span class="flex items-center gap-1 shrink-0 rounded bg-v2-state-bg-warning px-1.5 py-0.5 text-v2-state-fg-warning">
          <span class="max-w-[150px] truncate">{language.t("deveagent.statusbar.goalPlanPending")}: {goalDraft()?.description}</span>
          <input
            aria-label={language.t("deveagent.statusbar.goalCriteria")}
            class="h-4 w-52 border-0 bg-transparent px-1 text-[10px] text-v2-text-text-base outline-none"
            value={goalCriteria()}
            placeholder={language.t("deveagent.statusbar.goalCriteriaPlaceholder")}
            onInput={(event) => setGoalCriteria(event.currentTarget.value)}
          />
          <button
            type="button"
            class={autoIterate() ? "text-v2-text-text-accent" : "text-text-weak hover:text-text-base"}
            title={language.t("deveagent.statusbar.selfIterateHint")}
            aria-pressed={autoIterate()}
            onClick={() => setAutoIterate(!autoIterate())}
            data-action="deveagent-goal-autoiterate"
          >
            {autoIterate() ? "∞" : "∅"}
          </button>
          <button type="button" class="hover:text-text-base disabled:opacity-40" title={language.t("deveagent.statusbar.confirmGoalCriteria")} disabled={!goalCriteriaList().length} onClick={confirmGoalDraft}>
            {language.t("deveagent.statusbar.start")}
          </button>
          <button type="button" class="hover:text-[var(--v2-state-fg-danger)]" aria-label={language.t("deveagent.statusbar.discardDraftGoal")} title={language.t("deveagent.statusbar.discardDraftGoal")} onClick={cancelGoalDraft}>×</button>
        </span>
      </Show>
      <Show when={loop()?.active}>
        <DotSep />
        <span class="flex items-center gap-1 shrink-0 rounded bg-v2-background-bg-accent/10 px-1.5 py-0.5 text-v2-text-text-accent">
          <span class="max-w-[180px] truncate" title={loop()?.task}>
            Loop {loop()?.status} {loop()?.runCount ?? 0}/{loop()?.maxRuns ?? 8}: {loop()?.task}
          </span>
          {/* R202: a running automation says when its next pass lands, so an
              unattended run is legible without opening the panel. */}
          <Show when={loop()?.status === "running" && loop()?.nextRunAt}>
            <span data-component="deveagent-statusbar-loop-countdown" class="shrink-0 tabular-nums opacity-80">
              {language.t("deveagent.statusbar.nextRun")} {formatCountdown((loop()?.nextRunAt ?? 0) - clock())}
            </span>
          </Show>
          <button
            type="button"
            class="hover:text-v2-text-text-base"
            title={loop()?.status === "paused" ? language.t("deveagent.statusbar.resumeLoop") : language.t("deveagent.statusbar.pauseLoop")}
            onClick={() => updateLoop(loop()?.status === "paused" ? "resume" : "pause")}
          >
            {loop()?.status === "paused" ? "▶" : "Ⅱ"}
          </button>
          <button
            type="button"
            classList={{ "text-v2-state-fg-danger": loopCancelArmed() }}
            aria-label={language.t("deveagent.statusbar.cancelLoop")}
            title={loopCancelArmed() ? language.t("deveagent.statusbar.clickAgainToCancel") : language.t("deveagent.statusbar.cancelLoop")}
            onClick={() => {
              if (!loopCancelArmed()) {
                setLoopCancelArmed(true)
                window.setTimeout(() => setLoopCancelArmed(false), 3000)
                return
              }
              setLoopCancelArmed(false)
              updateLoop("cancel")
            }}
          >
            {loopCancelArmed() ? language.t("deveagent.statusbar.confirmCancel") : "×"}
          </button>
        </span>
      </Show>
      <Show when={showGrilling()}>
        <DotSep />
        <span class="shrink-0 text-v2-text-text-accent">{grillingLabel()}</span>
      </Show>
      <KbPopover open={moreOpen()} onOpenChange={setMoreOpen} placement="top-end">
        <KbPopover.Trigger
          type="button"
          data-action="deveagent-statusbar-more"
          class="shrink-0 rounded px-1 hover:text-v2-text-text-base text-v2-text-text-muted"
          title={language.t("deveagent.statusbar.moreStatus")}
        >
          {language.t("deveagent.statusbar.more")}
        </KbPopover.Trigger>
        <KbPopover.Portal>
          <KbPopover.Content
            class="z-50 w-64 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-01 p-3 shadow-[var(--v2-elevation-floating)] outline-none"
          >
            <div class="flex flex-col gap-2 text-[11px]">
              <div class="flex items-center justify-between"><span class="text-v2-text-text-muted">{language.t("deveagent.statusbar.tools")}</span><span>{composer.snapshot().toolExecution === "parallel" ? language.t("deveagent.statusbar.parallel") : language.t("deveagent.statusbar.serial")}</span></div>
              <Show when={sessionMetrics.teamUsage().tokens > 0}>
                <div class="flex items-center justify-between"><span class="text-v2-text-text-muted">{language.t("deveagent.statusbar.subagents")}</span><span class="tabular-nums">{sessionMetrics.taskAgents().length} · {number().format(sessionMetrics.teamUsage().tokens)}</span></div>
              </Show>
              <Show when={sessionMetrics.hasTaskAggregate() && sessionMetrics.taskTiming().elapsedMs !== undefined}>
                <div class="flex items-center justify-between"><span class="text-v2-text-text-muted">{language.t("deveagent.statusbar.taskSpan")}</span><span>{formatElapsed(sessionMetrics.taskTiming().elapsedMs ?? 0)}</span></div>
              </Show>
              <Show when={props.showTerminalToggle !== false}>
              <div class="flex items-center justify-between border-t border-v2-border-border-muted pt-2">
                <span class="text-v2-text-text-muted">{language.t("deveagent.statusbar.terminal")}</span>
                <button type="button" class="rounded border border-v2-border-border-base px-1.5 py-0.5 hover:bg-surface-base-hover" onClick={() => view().terminal.toggle()}>
                  {view().terminal.opened() ? language.t("deveagent.statusbar.on") : language.t("deveagent.statusbar.off")}
                </button>
              </div>
              </Show>
              <div class="flex items-center justify-between">
                <span class="text-v2-text-text-muted">{language.t("deveagent.statusbar.tokenSaver")}</span>
                <button type="button" class="rounded border border-v2-border-border-base px-1.5 py-0.5 hover:bg-surface-base-hover" onClick={() => window.dispatchEvent(new CustomEvent("deveagent:open-panel", { detail: "token" }))}>
                  {composer.snapshot().tokenSaver ? language.t("deveagent.statusbar.on") : language.t("deveagent.statusbar.off")}
                </button>
              </div>
              <div class="flex items-center justify-between border-t border-v2-border-border-muted pt-2">
                <span class="text-v2-text-text-muted">{language.t("deveagent.statusbar.provider")}</span><span>{providerLabel()}</span>
              </div>
              <button type="button" class="rounded border border-v2-border-border-base px-1.5 py-0.5 text-v2-text-text-muted hover:bg-surface-base-hover hover:text-v2-text-text-base" onClick={() => { setMoreOpen(false); window.dispatchEvent(new CustomEvent("deveagent:open-panel", { detail: "metrics" })) }}>
                {language.t("deveagent.statusbar.openSessionMetrics")}
              </button>
            </div>
          </KbPopover.Content>
        </KbPopover.Portal>
      </KbPopover>
      <span class="ml-auto min-w-0 max-w-52 truncate text-v2-text-text-muted" title={`${providerLabel()} / ${modelLabel()}`}>
        {modelLabel()}
      </span>
    </div>
  )
}

function StatusMetric(props: { label: string; value: string; tone: "success" | "warning" | "danger" | "base"; dataAction?: string }) {
  const color = () =>
    props.tone === "success"
      ? "var(--v2-state-fg-success)"
      : props.tone === "warning"
        ? "var(--v2-state-fg-warning)"
        : props.tone === "danger"
          ? "var(--v2-state-fg-danger)"
          : "var(--v2-text-text-base)"
  return (
    <span class="flex min-w-0 max-w-full items-center gap-1" data-action={props.dataAction} title={`${props.label}: ${props.value}`}>
      <span class="text-v2-text-text-muted">{props.label}</span>
      <span class="truncate tabular-nums" style={{ color: color() }}>{props.value}</span>
    </span>
  )
}

function DotSep() {
  return <span class="shrink-0 text-v2-border-border-muted select-none">·</span>
}

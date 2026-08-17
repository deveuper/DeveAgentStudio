import { createMemo, createResource, createSignal, onCleanup, onMount, Show } from "solid-js"

import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useSDK } from "@/context/sdk"
import { createDeveAgentSessionMetrics } from "@/components/deveagent-session-metrics"
import { useDeveAgentComposerState } from "@/components/deveagent-composer-state"
import { useSessionLayout } from "@/pages/session/session-layout"

type GoalState = {
  active: boolean
  status?: string
  description?: string
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
}
type GrillingState = { started: boolean; completed?: boolean; startedAt?: string; completedAt?: string; elapsedMs?: number; decisionCount: number }

function formatElapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}分${seconds % 60}秒` : `${seconds}秒`
}

export function DeveagentStatusBar(props: { showTerminalToggle?: boolean } = {}) {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const sdk = useSDK()
  const sessionMetrics = createDeveAgentSessionMetrics()
  const composer = useDeveAgentComposerState()
  const { params, view } = useSessionLayout()
  const base = () => serverSDK().url.replace(/\/+$/, "")
  const [clock, setClock] = createSignal(Date.now())
  const [goalCriteria, setGoalCriteria] = createSignal("")
  const goalCriteriaList = createMemo(() => goalCriteria().split(/\n|;/).map((item) => item.trim()).filter(Boolean))

  onMount(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000)
    onCleanup(() => window.clearInterval(timer))
  })

  const grillingEnabled = createMemo(() => composer.snapshot().selectedSkills.some((skill) => skill.id === "grill-me" && skill.enabled))
  const [grilling] = createResource(
    // Query the session even after the Skill is removed so a completed interview's
    // real duration remains visible when Composer state changes.
    () => params.id ? { base: base(), sessionID: params.id, revision: Math.floor(clock() / 5_000) } : undefined,
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
    if (!value?.started) return "Grilling: 等待确认"
    const endedAt = value.completedAt ? Date.parse(value.completedAt) : clock()
    const startedAt = value.startedAt ? Date.parse(value.startedAt) : endedAt
    const duration = formatElapsed(endedAt - startedAt)
    return value.completed ? `Grilling 完成 ${duration} · ${value.decisionCount} 决策` : `Grilling ${duration} · ${value.decisionCount} 决策`
  })

  const showGrilling = createMemo(() => grillingEnabled() || grilling()?.started === true)

  const [goal, { refetch: refetchGoal }] = createResource(
    () => (params.id ? { url: serverSDK().url, sessionID: params.id, revision: Math.floor(clock() / 5_000) } : undefined),
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
    return status === "running" ? "运行中" : status === "completed" ? "上一轮完成" : status === "failed" ? "上一轮失败" : status === "interrupted" ? "重启中断" : ""
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
    () => (params.id ? { url: serverSDK().url, sessionID: params.id, revision: Math.floor(clock() / 5_000) } : undefined),
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
  const confirmGoalDraft = async () => {
    if (!params.id) return
    const criteria = goalCriteriaList()
    if (!criteria.length) return
    try {
      const response = await serverSDK().fetch(`${base()}/api/deveagent/goal/draft`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "confirm", sessionID: params.id, directory: sdk().directory, criteria }),
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
    () => (params.id ? { url: serverSDK().url, sessionID: params.id, revision: Math.floor(clock() / 5_000) } : undefined),
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
    if (!entries.length) return "费用未返回"
    const totals = new Map<string, number>()
    for (const entry of entries) totals.set(entry.currency ?? "USD", (totals.get(entry.currency ?? "USD") ?? 0) + (entry.amount ?? 0))
    return `估算 ${[...totals].map(([currency, amount]) => new Intl.NumberFormat(language.intl(), { style: "currency", currency, minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(amount)).join(" + ")}`
  }
  const cacheHitRate = () =>
    sessionMetrics.cacheHitRate().toLocaleString(language.intl(), {
      maximumFractionDigits: 2,
    })
  const modelLabel = () => sessionMetrics.context()?.modelLabel ?? "未选择模型"
  const providerLabel = () => sessionMetrics.context()?.providerLabel ?? "Provider 待连接"
  const permissionLabel = () =>
    composer.snapshot().permissionMode === "default"
      ? "默认权限"
      : composer.snapshot().permissionMode === "auto"
        ? "自动确认"
        : "完全访问"
  const goalLabel = createMemo(() => {
    const value = goal()
    if (!value?.active || !value.startedAt) return ""
    const endedAt = value.verifiedAt ?? clock()
    const duration = formatElapsed(endedAt - value.startedAt)
    return value.status === "verified" ? `Goal 完成 ${duration}` : `Goal ${duration}`
  })

  return (
    <div
      class="no-scrollbar relative z-10 flex h-6 min-w-0 max-w-full shrink-0 items-center gap-2 overflow-x-auto whitespace-nowrap border-t border-v2-border-border-muted bg-surface-raised-base px-3 text-[11px] select-none"
      style={{ contain: "inline-size" }}
    >
      <span class="flex shrink-0 items-center gap-1">
        <span
          class="size-1.5 rounded-full"
          style={{ background: sessionMetrics.hasUsage() ? "var(--v2-state-fg-success)" : "var(--v2-state-fg-warning)" }}
        />
        <span class="text-v2-text-text-muted">{sessionMetrics.hasUsage() ? "live" : "ready"}</span>
      </span>
      <DotSep />
      <StatusMetric
        label="上下文"
        value={sessionMetrics.hasUsage() ? `${Math.round(sessionMetrics.contextUsage())}%` : "--"}
        tone={!sessionMetrics.hasUsage() ? "base" : sessionMetrics.contextUsage() > 80 ? "danger" : sessionMetrics.contextUsage() > 50 ? "warning" : "success"}
      />
      <DotSep />
      <StatusMetric
        label="命中"
        value={sessionMetrics.hasUsage() ? `${cacheHitRate()}%` : "--"}
        tone={!sessionMetrics.hasUsage() ? "base" : Number(cacheHitRate()) >= 80 ? "success" : Number(cacheHitRate()) >= 40 ? "warning" : "danger"}
      />
      <DotSep />
      <StatusMetric label="tokens" value={sessionMetrics.hasUsage() ? number().format(sessionMetrics.sessionTotalTokens()) : "--"} tone="base" />
      <Show when={sessionMetrics.teamUsage().tokens > 0}>
        <DotSep />
        <StatusMetric label="子代理" value={`${sessionMetrics.taskAgents().length} 个 · ${number().format(sessionMetrics.teamUsage().tokens)}`} tone="base" />
      </Show>
      <DotSep />
      <StatusMetric label="费用" value={costLabel()} tone="base" />
      <DotSep />
      <StatusMetric label="轮次" value={String(sessionMetrics.rounds())} tone="base" />
      <Show when={sessionMetrics.hasTaskAggregate() && sessionMetrics.taskTiming().elapsedMs !== undefined}>
        <DotSep />
        <StatusMetric
          label={sessionMetrics.taskTiming().completedElapsedMs !== undefined ? "任务完成" : "任务跨度"}
          value={formatElapsed(sessionMetrics.taskTiming().elapsedMs ?? 0)}
          tone="base"
        />
      </Show>
      <DotSep />
      <span class="shrink-0">
        <span class="text-v2-text-text-muted">模式</span> <span class="text-v2-text-text-base">{composer.snapshot().mode}</span>
      </span>
      <DotSep />
      <span class="shrink-0">
        <span class="text-v2-text-text-muted">工具</span> <span class="text-v2-text-text-base">{composer.snapshot().toolExecution === "parallel" ? "并行" : "串行"}</span>
      </span>
      <DotSep />
      <span class="shrink-0 text-v2-text-text-muted">{permissionLabel()}</span>
      <Show when={props.showTerminalToggle !== false}>
        <DotSep />
        <button
          type="button"
          class="shrink-0 hover:text-text-base"
          title={view().terminal.opened() ? "隐藏终端" : "打开终端"}
          onClick={() => view().terminal.toggle()}
        >
          <span class="text-v2-text-text-muted">终端</span> <span class="text-v2-text-text-base">{view().terminal.opened() ? "开" : "关"}</span>
        </button>
      </Show>
      <DotSep />
      <button
        type="button"
        class="shrink-0 hover:text-text-base"
        onClick={() => window.dispatchEvent(new CustomEvent("deveagent:open-panel", { detail: "token" }))}
      >
        <span class="text-v2-text-text-muted">省Token</span> <span class="text-v2-text-text-base">{composer.snapshot().tokenSaver ? "开" : "关"}</span>
      </button>
      <DotSep />
      <button
        type="button"
        class="shrink-0 hover:text-text-base"
        onClick={() => window.dispatchEvent(new CustomEvent("deveagent:open-panel", { detail: "metrics" }))}
      >
        <span class="text-v2-text-text-muted">会话指标</span>
      </button>
      <Show when={goal()?.active && goal()?.startedAt}>
        <DotSep />
        <span class="flex items-center gap-1 shrink-0 rounded bg-v2-background-bg-accent/10 px-1.5 py-0.5 text-v2-text-text-accent">
          <span class="max-w-[180px] truncate">{goalLabel()}: {goal()?.description}</span>
          <Show when={goal()?.status === "in_progress"}>
            <span class="text-[9px] opacity-70">{goal()?.reentries ?? 0}/{goal()?.maxReentries ?? 8}</span>
            <Show when={goalAttemptLabel()}>
              <span class="text-[9px] opacity-70">{goalAttemptLabel()}</span>
            </Show>
            <button
              type="button"
              class="hover:text-[var(--v2-state-fg-danger)]"
              title="取消当前 Goal"
              onClick={cancelGoal}
            >
              ×
            </button>
          </Show>
        </span>
      </Show>
      <Show when={goalDraft()?.active && !goal()?.active}>
        <DotSep />
        <span class="flex items-center gap-1 shrink-0 rounded bg-[var(--surface-warning-base)] px-1.5 py-0.5 text-[var(--icon-warning-base)]">
          <span class="max-w-[150px] truncate">Goal 计划待确认: {goalDraft()?.description}</span>
          <input
            aria-label="Goal 验收条件"
            class="h-4 w-52 border-0 bg-transparent px-1 text-[10px] text-[var(--text-base)] outline-none"
            value={goalCriteria()}
            placeholder="输入验收条件；多条用 ; 分隔"
            onInput={(event) => setGoalCriteria(event.currentTarget.value)}
          />
          <button type="button" class="hover:text-text-base disabled:opacity-40" title="确认验收条件并启动 Goal 队列" disabled={!goalCriteriaList().length} onClick={confirmGoalDraft}>
            确认启动
          </button>
          <button type="button" class="hover:text-[var(--v2-state-fg-danger)]" title="放弃待确认 Goal" onClick={cancelGoalDraft}>×</button>
        </span>
      </Show>
      <Show when={loop()?.active}>
        <DotSep />
        <span class="flex items-center gap-1 shrink-0 rounded bg-v2-background-bg-accent/10 px-1.5 py-0.5 text-v2-text-text-accent">
          <span class="max-w-[180px] truncate">
            Loop {loop()?.status} {loop()?.runCount ?? 0}/{loop()?.maxRuns ?? 8}: {loop()?.task}
          </span>
          <button
            type="button"
            class="hover:text-[var(--text-base)]"
            title={loop()?.status === "paused" ? "恢复 Loop" : "暂停 Loop"}
            onClick={() => updateLoop(loop()?.status === "paused" ? "resume" : "pause")}
          >
            {loop()?.status === "paused" ? "▶" : "Ⅱ"}
          </button>
          <button
            type="button"
            class="hover:text-[var(--v2-state-fg-danger)]"
            title="取消当前 Loop"
            onClick={() => updateLoop("cancel")}
          >
            ×
          </button>
        </span>
      </Show>
      <Show when={showGrilling()}>
        <DotSep />
        <span class="shrink-0 text-v2-text-text-accent">{grillingLabel()}</span>
      </Show>
      <span class="flex-1" />
      <StatusMetric
        label="模型"
        value={`${providerLabel()} / ${modelLabel()}`}
        tone="base"
      />
    </div>
  )
}

function StatusMetric(props: { label: string; value: string; tone: "success" | "warning" | "danger" | "base" }) {
  const color =
    props.tone === "success"
      ? "var(--v2-state-fg-success)"
      : props.tone === "warning"
        ? "var(--v2-state-fg-warning)"
        : props.tone === "danger"
          ? "var(--v2-state-fg-danger)"
          : "var(--v2-text-text-base)"
  return (
    <span class="flex shrink-0 items-center gap-1">
      <span class="text-v2-text-text-muted">{props.label}</span>
      <span class="tabular-nums" style={{ color }}>{props.value}</span>
    </span>
  )
}

function DotSep() {
  return <span class="shrink-0 text-v2-border-border-muted select-none">·</span>
}

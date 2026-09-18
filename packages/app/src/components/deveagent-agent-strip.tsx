import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useSessionLayout } from "@/pages/session/session-layout"

type AgentJob = {
  id: string
  type: string
  title?: string
  status: string
  started_at?: number
  completed_at?: number
  error?: string
  metadata?: { parentSessionId?: string; sessionId?: string; deveagentTeam?: boolean }
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
  const { params } = useSessionLayout()
  const [open, setOpen] = createSignal(false)
  const [tick, setTick] = createSignal(0)

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

  onMount(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 5_000)
    onCleanup(() => window.clearInterval(timer))
  })

  const running = createMemo(() => (jobs() ?? []).filter((job) => job.status === "running"))
  const finished = createMemo(() => (jobs() ?? []).filter((job) => job.status === "completed"))
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

  const elapsed = (job: AgentJob) => {
    const ms = (job.completed_at ?? Date.now()) - (job.started_at ?? Date.now())
    const seconds = Math.max(0, Math.round(ms / 1000))
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`
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
          onClick={() => setOpen((value) => !value)}
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
                    style={{
                      color:
                        job.status === "completed"
                          ? "var(--v2-state-fg-success)"
                          : job.status === "failed"
                            ? "var(--v2-state-fg-danger)"
                            : "var(--v2-state-fg-warning)",
                    }}
                  >
                    {job.status === "completed" ? "✓" : job.status === "failed" ? "✗" : "◐"}
                  </span>
                  <span class="min-w-0 flex-1 truncate text-v2-text-text-base" title={job.title ?? job.id}>
                    {job.title || job.id}
                  </span>
                  <span class="shrink-0 tabular-nums text-v2-text-text-faint">{elapsed(job)}</span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  )
}

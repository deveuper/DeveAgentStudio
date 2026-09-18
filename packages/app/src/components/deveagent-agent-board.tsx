import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { createLowPowerInterval } from "@/context/low-power"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
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
  }
}

/**
 * Unified agent board (Plan.2026.7.29 R155): one Overview card listing every
 * background agent job for the current session — core task subagents and team
 * members alike — with a two-step cancel. Status/error strings come straight
 * from the jobs registry; no synthetic progress percentages.
 */
export function DeveagentAgentBoard() {
  const language = useLanguage()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const { params } = useSessionLayout()

  const [armed, setArmed] = createSignal<string | undefined>(undefined)
  const [busy, setBusy] = createSignal(false)

  const [jobs, { refetch }] = createResource(
    () => ({ directory: sdk().directory, sessionID: params.id ?? undefined }),
    async (source): Promise<AgentJob[]> => {
      if (!source.directory || !params.id) return []
      try {
        // The jobs registry is instance-scoped: pass directory explicitly or
        // the route falls back to process.cwd() and lists nothing for this
        // workspace (same boundary class as the automations/loop routes).
        const url = `${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/background-jobs?directory=${encodeURIComponent(source.directory)}&sessionID=${encodeURIComponent(params.id)}`
        const response = await serverSDK().fetch(url)
        if (!response.ok) return []
        const data = (await response.json()) as { jobs?: unknown }
        return Array.isArray(data) ? (data as AgentJob[]) : Array.isArray((data as { jobs?: AgentJob[] }).jobs) ? ((data as { jobs: AgentJob[] }).jobs) : []
      } catch {
        return []
      }
    },
  )

  // This card only mounts while the Overview panel is open, so its lifetime is
  // already bounded by the panel. The 15s cadence matches the other Overview
  // cards and stretches 4x under low power.
  createLowPowerInterval(() => void refetch(), 15_000)

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
        showToast({ title: language.t("deveagent.agents.cancellationRequested"), description: job.title ?? job.id })
        setArmed(undefined)
        void refetch()
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

  // S3 failure isolation, derived from the real job statuses in this board:
  // a failed job did NOT take its siblings down when others kept running or
  // completed. Nothing is synthesized — the counts are the registry itself.
  const isolation = createMemo(() => {
    const list = jobs() ?? []
    const failed = list.filter((job) => job.status === "failed").length
    const survivors = list.filter((job) => job.status === "running" || job.status === "completed").length
    return { failed, survivors, isolated: failed > 0 && survivors > 0 }
  })

  // S3: retry a failed team job by re-driving its child session. The endpoint
  // finds the latest failed run and re-prompts only that member's session.
  const retry = async (job: AgentJob) => {
    if (busy()) return
    setBusy(true)
    try {
      const url = `${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/team/retry`
      const response = await serverSDK().fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionID: job.metadata?.parentSessionId ?? params.id, directory: sdk().directory }),
      })
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; reason?: string }
      if (response.ok && data.ok !== false) {
        showToast({ title: language.t("deveagent.agents.retryRequested"), description: job.title ?? job.id })
        void refetch()
      } else {
        showToast({
          title: language.t("deveagent.agents.retryFailed"),
          description: data.reason ?? language.t("deveagent.agents.tryAgainLater"),
        })
      }
    } catch {
      showToast({ title: language.t("deveagent.agents.retryFailed"), description: language.t("deveagent.agents.tryAgainLater") })
    } finally {
      setBusy(false)
    }
  }

  const statusLabel = (job: AgentJob) => {
    if (job.status === "running") return language.t("deveagent.agents.statusRunning")
    if (job.status === "completed") return language.t("deveagent.agents.statusCompleted")
    if (job.status === "failed") return language.t("deveagent.agents.statusFailed")
    if (job.status === "cancelled") return language.t("deveagent.agents.statusCancelled")
    return job.status
  }

  return (
    <Show when={(jobs()?.length ?? 0) > 0}>
      <div data-component="deveagent-agent-board" class="rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-3">
        <div class="mb-2 flex items-center justify-between">
          <span class="text-[11px] font-[520] uppercase tracking-wide text-v2-text-text-muted">{language.t("deveagent.agents.title")}</span>
          <span class="text-[10px] tabular-nums text-v2-text-text-faint">{jobs()!.length}</span>
        </div>
        <Show when={isolation().isolated}>
          <div
            data-component="deveagent-agent-board-isolation"
            class="mb-1 rounded-md border border-v2-state-fg-danger/30 bg-v2-state-bg-danger/10 px-2 py-1 text-[10px] text-v2-state-fg-danger"
          >
            {language.t("deveagent.agents.isolation", { failed: isolation().failed, ok: isolation().survivors })}
          </div>
        </Show>
        <div class="flex max-h-56 flex-col gap-1.5 overflow-y-auto">
          <For each={jobs()!}>
            {(job) => (
              <div class="rounded-md border border-v2-border-border-muted px-2 py-1.5">
                <div class="flex items-center justify-between gap-2">
                  <span class="min-w-0 flex-1 truncate text-[11px] text-v2-text-text-base" title={job.title ?? job.id}>
                    {job.title || job.id}
                  </span>
                  <span
                    class="shrink-0 text-[10px]"
                    classList={{
                      "text-v2-state-fg-success": job.status === "completed",
                      "text-v2-text-text-muted": job.status !== "completed" && job.status !== "failed",
                      "text-v2-state-fg-danger": job.status === "failed",
                    }}
                  >
                    {statusLabel(job)}
                  </span>
                </div>
                {/* S3 parent-child chain: this job IS a child session; show
                    the lineage ids so the board is traceable, not just a list. */}
                <div
                  class="mt-0.5 flex items-center gap-1 text-[10px] text-v2-text-text-faint"
                  data-component="deveagent-agent-board-chain"
                  title={job.metadata?.sessionId ?? job.id}
                >
                  <span>{params.id?.slice(-8) ?? "?"}</span>
                  <span>→</span>
                  <span class="truncate">{(job.metadata?.sessionId ?? job.id).slice(-8)}</span>
                </div>
                <div class="mt-0.5 flex items-center justify-between gap-2">
                  <span class="text-[10px] tabular-nums text-v2-text-text-faint">
                    {language.t("deveagent.agents.ranFor")}
                    {" "}
                    {Math.max(1, Math.round(((job.completed_at ?? Date.now()) - (job.started_at ?? Date.now())) / 1000))}
                    {language.t("deveagent.agents.secondsSuffix")}
                  </span>
                  <Show when={job.status === "running"}>
                    <Show
                      when={armed() === job.id}
                      fallback={
                        <button
                          type="button"
                          data-action="deveagent-agent-board-cancel"
                          class="shrink-0 rounded border border-v2-border-border-muted px-1.5 py-0.5 text-[10px] text-v2-text-text-base hover:bg-v2-background-bg-layer-02"
                          onClick={() => setArmed(job.id)}
                        >
                          {language.t("deveagent.agents.cancel")}
                        </button>
                      }
                    >
                      <button
                        type="button"
                        data-action="deveagent-agent-board-confirm"
                        disabled={busy()}
                        class="shrink-0 rounded border border-v2-state-fg-danger/50 px-1.5 py-0.5 text-[10px] text-v2-state-fg-danger disabled:opacity-50"
                        onClick={() => void cancel(job)}
                      >
                        {busy() ? language.t("deveagent.agents.cancelling") : language.t("deveagent.agents.confirmCancel")}
                      </button>
                    </Show>
                  </Show>
                </div>
                <Show when={job.error}>
                  <div class="mt-1 line-clamp-2 text-[10px] leading-4 text-v2-state-fg-danger" title={job.error}>
                    {job.error}
                  </div>
                </Show>
                <Show when={job.status === "failed"}>
                  <button
                    type="button"
                    data-action="deveagent-agent-board-retry"
                    disabled={busy()}
                    class="mt-1 shrink-0 rounded border border-v2-border-border-focus/40 px-1.5 py-0.5 text-[10px] text-v2-text-text-accent hover:bg-v2-background-bg-accent/10 disabled:opacity-50"
                    onClick={() => void retry(job)}
                  >
                    {language.t("deveagent.agents.retry")}
                  </button>
                </Show>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}

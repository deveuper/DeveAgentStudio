import { createResource, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { createLowPowerInterval } from "@/context/low-power"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"

type DeveAgentRun = {
  id: string
  kind: "goal" | "loop" | "team" | "moa"
  description: string
  status: "running" | "completed" | "failed" | "stopped"
  startedAt: number
  finishedAt?: number
  stopReason?: string
  // S2 provenance. Usage fields stay undefined when the provider never
  // returned numbers — the card shows nothing rather than a fabricated 0.
  childSessionIDs?: string[]
  tokens?: number
  cost?: number
}

const KIND_COLOR: Record<DeveAgentRun["kind"], string> = {
  goal: "#C2410C",
  loop: "#E86F38",
  team: "#D55F2C",
  moa: "#9A3412",
}

/**
 * Run history (DeveAgentRun slice 3): the unified log over goal/loop/team/moa
 * executions, read live from POST /api/deveagent/runs. Long-run provenance at
 * a glance — what ran, on which workspace, and how it ended.
 */
export function DeveagentRunsCard() {
  const language = useLanguage()
  const sdk = useSDK()
  const serverSDK = useServerSDK()

  const [tick, setTick] = createSignal(0)
  createLowPowerInterval(() => setTick((value) => value + 1), 10_000)

  const [runs] = createResource(
    () => ({ directory: sdk().directory, tick: tick() }),
    async (source): Promise<DeveAgentRun[]> => {
      if (!source.directory) return []
      try {
        const response = await serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/runs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory: source.directory, limit: 12 }),
        })
        if (!response.ok) return []
        const data = (await response.json()) as { runs?: DeveAgentRun[] }
        return Array.isArray(data.runs) ? data.runs : []
      } catch {
        return []
      }
    },
  )

  const statusStyle = (status: DeveAgentRun["status"]) =>
    status === "completed"
      ? { background: "var(--v2-state-bg-success)", color: "var(--v2-state-fg-success)" }
      : status === "running"
        ? { background: "var(--v2-state-bg-warning)", color: "var(--v2-state-fg-warning)" }
        : { background: "var(--v2-state-bg-danger)", color: "var(--v2-state-fg-danger)" }

  return (
    <Show when={(runs() ?? []).length > 0}>
      <div
        data-component="deveagent-runs-card"
        class="flex flex-col gap-2 rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-3"
      >
        <div class="flex w-full items-center justify-between gap-2">
          <span class="text-[11px] font-[520] uppercase tracking-wide text-v2-text-text-muted">{language.t("deveagent.runs.title")}</span>
          <span class="text-[11px] text-v2-text-text-faint">{language.t("deveagent.runs.subtitle")}</span>
        </div>
        <div class="flex flex-col gap-1">
          <For each={(runs() ?? []).slice(0, 10)}>
            {(run) => (
              <div class="flex items-center gap-2 text-[11px] leading-5" title={run.stopReason || run.description}>
                <span class="shrink-0 rounded px-1 py-0.5 text-[9px] uppercase text-white" style={{ background: KIND_COLOR[run.kind] }}>
                  {run.kind}
                </span>
                <span class="min-w-0 truncate text-v2-text-text-base">{run.description}</span>
                <Show when={(run.childSessionIDs?.length ?? 0) > 0}>
                  <span class="shrink-0 tabular-nums text-v2-text-text-faint">
                    {language.t("deveagent.runs.children", { count: run.childSessionIDs!.length })}
                  </span>
                </Show>
                <Show when={typeof run.tokens === "number"}>
                  <span class="shrink-0 tabular-nums text-v2-text-text-faint">tokens {run.tokens!.toLocaleString()}</span>
                </Show>
                <Show when={run.finishedAt}>
                  <span class="ml-auto shrink-0 tabular-nums text-v2-text-text-faint">
                    {language.t("deveagent.runs.durationMinutes", { count: Math.max(1, Math.round((run.finishedAt! - run.startedAt) / 60_000)) })}
                  </span>
                </Show>
                <span class="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium" style={statusStyle(run.status)}>
                  {run.status === "completed" ? language.t("deveagent.runs.statusDone") : run.status === "running" ? language.t("deveagent.runs.statusRunning") : run.status === "stopped" ? language.t("deveagent.runs.statusStopped") : language.t("deveagent.runs.statusFailed")}
                </span>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}

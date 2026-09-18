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
}

type CuAuditEntry = {
  at: string
  sessionID?: string
  tool: string
  action: string
  target?: string
  ok: boolean
  detail?: string
}

/**
 * Computer-Use audit log (Plan.2026.7.29 §4): one Overview card listing what
 * the agent actually did on this machine — action, target, honest outcome.
 * Only rendered when the workspace has audit entries.
 */
export function DeveagentCuAuditCard() {
  const language = useLanguage()
  const sdk = useSDK()
  const serverSDK = useServerSDK()

  // New audit entries land while the panel is already mounted — poll so the
  // list stays live (the timing bug the packaged E2E caught: a mount-only
  // fetch predates the first CU action and never refreshes).
  const [tick, setTick] = createSignal(0)
  createLowPowerInterval(() => setTick((value) => value + 1), 10_000)

  const [log] = createResource(
    () => ({ directory: sdk().directory, tick: tick() }),
    async (source): Promise<{ entries: CuAuditEntry[]; runs: DeveAgentRun[] }> => {
      if (!source.directory) return { entries: [], runs: [] }
      try {
        const response = await serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/cu-audit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory: source.directory, limit: 12 }),
        })
        if (!response.ok) return { entries: [], runs: [] }
        const data = (await response.json()) as { entries?: CuAuditEntry[]; runs?: DeveAgentRun[] }
        return {
          entries: Array.isArray(data.entries) ? data.entries : [],
          runs: Array.isArray(data.runs) ? data.runs : [],
        }
      } catch {
        return { entries: [], runs: [] }
      }
    },
  )

  return (
    <Show when={(log()?.entries.length ?? 0) > 0}>
      <div
        data-component="deveagent-cu-audit-card"
        class="flex flex-col gap-2 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02 p-4"
      >
        <div class="flex w-full items-center justify-between gap-2">
          <span class="text-[11px] uppercase tracking-wide text-v2-text-text-muted">{language.t("deveagent.cuAudit.title")}</span>
          <span class="text-[11px] text-v2-text-text-muted">{language.t("deveagent.cuAudit.recentActions")}</span>
        </div>
        <div class="flex flex-col gap-1">
          <For each={(log()?.entries ?? []).slice(0, 10)}>
            {(entry) => (
              <div class="flex items-center gap-2 text-[11px]" title={entry.detail || entry.target || undefined}>
                <span classList={{ "text-v2-state-fg-success": entry.ok, "text-v2-state-fg-danger": !entry.ok }}>
                  {entry.ok ? "✓" : "✗"}
                </span>
                <span class="shrink-0 rounded bg-v2-background-bg-layer-03 px-1 py-0.5 text-[10px] uppercase">
                  {entry.action}
                </span>
                <span class="min-w-0 truncate font-mono text-v2-text-text-muted">{entry.target || entry.tool}</span>
                <span class="ml-auto shrink-0 tabular-nums text-v2-text-text-muted">
                  {new Intl.DateTimeFormat(language.locale(), { timeStyle: "short" }).format(new Date(entry.at))}
                </span>
              </div>
            )}
          </For>
        </div>
        <Show when={(log()?.runs.length ?? 0) > 0}>
          <div class="mt-1 border-t border-v2-border-border-muted pt-2">
            <div class="text-[11px] uppercase tracking-wide text-v2-text-text-muted">{language.t("deveagent.cuAudit.runHistory")}</div>
            <div class="mt-1 flex flex-col gap-1">
              <For each={(log()?.runs ?? []).slice(0, 5)}>
                {(run) => (
                  <div class="flex items-center gap-2 text-[11px]" title={run.description}>
                    <span class="shrink-0 rounded bg-v2-background-bg-layer-03 px-1 py-0.5 text-[10px] uppercase text-v2-text-text-muted">
                      {run.kind}
                    </span>
                    <span class="min-w-0 truncate text-v2-text-text-base">{run.description}</span>
                    <span
                      classList={{
                        "ml-auto shrink-0 text-[10px] font-medium": true,
                        "text-v2-state-fg-success": run.status === "completed",
                        "text-v2-state-fg-warning": run.status === "running",
                        "text-v2-state-fg-danger": run.status === "failed" || run.status === "stopped",
                      }}
                    >
                      {run.status === "completed" ? language.t("deveagent.cuAudit.statusDone") : run.status === "running" ? language.t("deveagent.cuAudit.statusRunning") : run.status === "stopped" ? language.t("deveagent.cuAudit.statusStopped") : language.t("deveagent.cuAudit.statusFailed")}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
    </Show>
  )
}

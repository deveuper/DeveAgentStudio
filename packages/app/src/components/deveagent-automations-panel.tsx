import { createResource, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { createLowPowerInterval } from "@/context/low-power"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"

type DeveAgentAutomation = {
  sessionID: string
  task: string
  status: "running" | "paused"
  runCount: number
  maxRuns: number
  intervalSeconds: number
  cron?: string
  timezone?: string
  nextRunAt?: number
  lastRunAt?: number
  stopReason?: string
  ready?: boolean
}

function formatWhen(value: number | undefined, locale: string) {
  if (!value) return "—"
  return new Date(value).toLocaleString(locale)
}

function formatSchedule(entry: DeveAgentAutomation, zh: string, en: string) {
  if (entry.cron) return `${entry.cron} (${entry.timezone || "UTC"})`
  return `${zh}${entry.intervalSeconds}s${en}`
}

/**
 * Automations panel (NIGHT_RUN plan R150): the persisted Loop queue for this
 * workspace — next/last run, run-now, pause/resume. Data comes from
 * GET /api/deveagent/automations (the real persisted loop store); actions hit
 * the pause/resume/run-now routes. Hidden entirely when no automation is
 * active (empty states never render placeholder cards).
 */
export function DeveagentAutomationsPanel() {
  const language = useLanguage()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const [busy, setBusy] = createSignal<string | undefined>(undefined)

  const [automations, { refetch }] = createResource(
    () => ({ directory: sdk().directory }),
    async (source): Promise<DeveAgentAutomation[]> => {
      if (!source.directory) return []
      try {
        const url = `${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/automations?directory=${encodeURIComponent(source.directory)}`
        const response = await serverSDK().fetch(url)
        if (!response.ok) return []
        const data = (await response.json()) as { entries?: DeveAgentAutomation[] }
        return Array.isArray(data.entries) ? data.entries : []
      } catch {
        return []
      }
    },
  )

  // Mount-bounded (this panel is only rendered while the Overview tab is open)
  // and low-power aware.
  createLowPowerInterval(() => void refetch(), 15_000)

  const act = async (sessionID: string, action: "pause" | "resume" | "run-now") => {
    if (busy()) return
    setBusy(sessionID + action)
    try {
      const url = `${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/automations/${action}`
      const response = await serverSDK().fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionID }),
      })
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; reason?: string }
      const ok = response.ok && data.ok !== false && data.error === undefined
      if (ok) {
        showToast({ title: language.t("deveagent.automations.statusDone"), description: language.t("deveagent.automations.stateUpdated") })
        void refetch()
      } else {
        // Surface the server's machine-readable reason (e.g. "no active loop
        // for this session") instead of a generic retry hint.
        showToast({
          title: language.t("deveagent.automations.actionFailed"),
          description: data.error ?? data.reason ?? language.t("deveagent.automations.tryAgainLater"),
        })
      }
    } catch {
      showToast({ title: language.t("deveagent.automations.actionFailed"), description: language.t("deveagent.automations.tryAgainLater") })
    } finally {
      setBusy(undefined)
    }
  }

  const buttonClass =
    "rounded border border-v2-border-border-muted px-1.5 py-0.5 text-[10px] text-v2-text-text-base hover:bg-v2-background-bg-layer-02 disabled:opacity-50"

  return (
    <Show when={(automations()?.length ?? 0) > 0}>
      <div data-component="deveagent-automations-panel" class="rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-3">
        <div class="mb-2 flex items-center justify-between">
          <span class="text-[11px] font-[520] uppercase tracking-wide text-v2-text-text-muted">{language.t("deveagent.automations.title")}</span>
          <span class="text-[10px] tabular-nums text-v2-text-text-faint">{automations()!.length}</span>
        </div>
        <div class="flex max-h-56 flex-col gap-2 overflow-y-auto">
          <For each={automations()!}>
            {(entry) => (
              <div class="rounded-md border border-v2-border-border-muted px-2 py-1.5">
                <div class="flex items-center justify-between gap-2">
                  <span class="min-w-0 flex-1 truncate text-[11px] text-v2-text-text-base" title={entry.task}>
                    {entry.task}
                  </span>
                  <span
                    class="shrink-0 rounded px-1.5 py-0.5 text-[10px]"
                    classList={{
                      "text-v2-state-fg-success": entry.status === "running",
                      "text-v2-text-text-muted": entry.status !== "running",
                    }}
                  >
                    {entry.status === "running" ? language.t("deveagent.automations.statusRunning") : language.t("deveagent.automations.statusPaused")}
                  </span>
                </div>
                <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] leading-4 tabular-nums text-v2-text-text-muted">
                  <span>
                    {language.t("deveagent.automations.runs")}: {entry.runCount}/{entry.maxRuns}
                  </span>
                  <span>
                    {language.t("deveagent.automations.schedule")}: {formatSchedule(entry, language.t("deveagent.automations.every"), language.t("deveagent.automations.secondsSuffix"))}
                  </span>
                  <span>
                    {language.t("deveagent.automations.next")}: {entry.status === "running" ? formatWhen(entry.nextRunAt, language.locale()) : language.t("deveagent.automations.pausedDash")}
                  </span>
                  <span>
                    {language.t("deveagent.automations.last")}: {formatWhen(entry.lastRunAt, language.locale())}
                  </span>
                </div>
                <Show when={entry.stopReason}>
                  <div class="mt-1 text-[10px] leading-4 text-v2-state-fg-warning" title={entry.stopReason}>
                    {entry.stopReason}
                  </div>
                </Show>
                <div class="mt-1.5 flex items-center gap-1.5">
                  <button
                    type="button"
                    data-action="deveagent-automations-run-now"
                    disabled={busy() !== undefined || entry.status !== "running"}
                    class={buttonClass}
                    onClick={() => void act(entry.sessionID, "run-now")}
                  >
                    {busy() === entry.sessionID + "run-now" ? language.t("deveagent.automations.scheduling") : language.t("deveagent.automations.runNow")}
                  </button>
                  <Show
                    when={entry.status === "running"}
                    fallback={
                      <button
                        type="button"
                        data-action="deveagent-automations-resume"
                        disabled={busy() !== undefined}
                        class={buttonClass}
                        onClick={() => void act(entry.sessionID, "resume")}
                      >
                        {busy() === entry.sessionID + "resume" ? language.t("deveagent.automations.enabling") : language.t("deveagent.automations.enable")}
                      </button>
                    }
                  >
                    <button
                      type="button"
                      data-action="deveagent-automations-pause"
                      disabled={busy() !== undefined}
                      class={buttonClass}
                      onClick={() => void act(entry.sessionID, "pause")}
                    >
                      {busy() === entry.sessionID + "pause" ? language.t("deveagent.automations.pausing") : language.t("deveagent.automations.pause")}
                    </button>
                  </Show>
                </div>
              </div>
            )}
          </For>
        </div>
        <div class="mt-1.5 text-[10px] leading-4 text-v2-text-text-faint">
          {language.t("deveagent.automations.runNowHint")}
        </div>
      </div>
    </Show>
  )
}

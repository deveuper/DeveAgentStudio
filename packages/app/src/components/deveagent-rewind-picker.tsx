import { createResource, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { createLowPowerInterval } from "@/context/low-power"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useSessionLayout } from "@/pages/session/session-layout"
import { showToast } from "@/utils/toast"

type DeveAgentCheckpoint = {
  at: string
  sessionID?: string
  messageID?: string
  snapshotHash: string
}

/**
 * Rewind picker (Plan.2026.7.29 R133–R137): lists the pre-turn checkpoints
 * recorded for this session and restores one — file bytes via the snapshot,
 * conversation via SessionRevert when the checkpoint carries a messageID.
 * Two-step confirm, honest errors, same card family as the CU audit log.
 */
export function DeveagentRewindPicker() {
  const language = useLanguage()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const { params } = useSessionLayout()
  const sessionID = () => params.id

  const [armed, setArmed] = createSignal<string | undefined>(undefined)
  const [busy, setBusy] = createSignal(false)

  const [checkpoints, { refetch }] = createResource(
    () => ({ directory: sdk().directory, sessionID: sessionID() }),
    async (source): Promise<DeveAgentCheckpoint[]> => {
      if (!source.directory || !source.sessionID) return []
      try {
        const url = `${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/checkpoints/list`
        const response = await serverSDK().fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory: source.directory, sessionID: source.sessionID }),
        })
        if (!response.ok) return []
        const data = (await response.json()) as { entries?: DeveAgentCheckpoint[] }
        return Array.isArray(data.entries) ? data.entries : []
      } catch {
        return []
      }
    },
  )

  // Checkpoints accrue while the panel is open — poll like the CU audit card.
  createLowPowerInterval(() => void refetch(), 15_000)

  const restore = async (checkpoint: DeveAgentCheckpoint) => {
    if (busy()) return
    setBusy(true)
    try {
      const url = `${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/checkpoints/restore`
      const response = await serverSDK().fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          directory: sdk().directory,
          sessionID: sessionID(),
          messageID: checkpoint.messageID,
          snapshotHash: checkpoint.snapshotHash,
        }),
      })
      const data = (await response.json().catch(() => ({}))) as { restored?: boolean; error?: string }
      if (response.ok && data.restored) {
        showToast({ title: language.t("deveagent.rewind.restored"), description: new Date(checkpoint.at).toLocaleString() })
        setArmed(undefined)
        void refetch()
      } else {
        showToast({ title: language.t("deveagent.rewind.restoreFailed"), description: data.error ?? language.t("deveagent.rewind.tryAgainLater") })
      }
    } catch {
      showToast({ title: language.t("deveagent.rewind.restoreFailed"), description: language.t("deveagent.rewind.tryAgainLater") })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show when={(checkpoints()?.length ?? 0) > 0}>
      <div data-component="deveagent-rewind-picker" class="rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-3">
        <div class="mb-2 flex items-center justify-between">
          <span class="text-[11px] font-[520] uppercase tracking-wide text-v2-text-text-muted">{language.t("deveagent.rewind.title")}</span>
          <span class="text-[10px] tabular-nums text-v2-text-text-faint">{checkpoints()!.length}</span>
        </div>
        <div class="flex max-h-44 flex-col gap-1 overflow-y-auto">
          <For each={checkpoints()!.slice(0, 20)}>
            {(checkpoint) => (
              <div class="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-v2-background-bg-layer-02">
                <span class="min-w-0 flex-1 truncate text-[11px] text-v2-text-text-base" title={checkpoint.snapshotHash}>
                  {new Date(checkpoint.at).toLocaleString(language.locale())}
                </span>
                <Show
                  when={armed() === checkpoint.snapshotHash}
                  fallback={
                    <button
                      type="button"
                      data-action="deveagent-rewind-arm"
                      class="shrink-0 rounded border border-v2-border-border-muted px-1.5 py-0.5 text-[10px] text-v2-text-text-base hover:bg-v2-background-bg-layer-02"
                      onClick={() => setArmed(checkpoint.snapshotHash)}
                    >
                      {language.t("deveagent.rewind.restore")}
                    </button>
                  }
                >
                  <button
                    type="button"
                    data-action="deveagent-rewind-confirm"
                    disabled={busy()}
                    class="shrink-0 rounded border border-v2-state-fg-danger/50 px-1.5 py-0.5 text-[10px] text-v2-state-fg-danger disabled:opacity-50"
                    onClick={() => void restore(checkpoint)}
                  >
                    {busy() ? language.t("deveagent.rewind.restoring") : language.t("deveagent.rewind.confirmRestore")}
                  </button>
                </Show>
              </div>
            )}
          </For>
        </div>
        <div class="mt-1.5 text-[10px] leading-4 text-v2-text-text-faint">
          {language.t("deveagent.rewind.hint")}
        </div>
      </div>
    </Show>
  )
}

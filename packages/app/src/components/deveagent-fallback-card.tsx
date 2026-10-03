import { createResource, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"

type FallbackEntry = {
  at: number
  sessionID?: string
  failedProviderID: string
  failedModelID: string
  fallbackProviderID: string
  fallbackModelID: string
  fallbackPaid: boolean
  message?: string
}

/**
 * ProviderFallback history (E-3 / Q5): the switch used to exist only as a
 * toast, so a refresh erased the only trace that the model was changed. This
 * card reads the persisted ledger (POST /api/deveagent/fallbacks) and shows
 * every fallback for the current session, newest first. Hidden entirely when
 * there are no entries — an empty history must not look like a broken widget.
 */
export function DeveagentFallbackCard() {
  const language = useLanguage()
  const sdk = useSDK()
  const serverSDK = useServerSDK()

  const [fallbacks] = createResource(
    () => ({ directory: sdk().directory }),
    async (source): Promise<FallbackEntry[]> => {
      if (!source.directory) return []
      try {
        const response = await serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/fallbacks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory: source.directory, limit: 20 }),
        })
        if (!response.ok) return []
        const data = (await response.json()) as { fallbacks?: FallbackEntry[] }
        return Array.isArray(data.fallbacks) ? data.fallbacks : []
      } catch {
        return []
      }
    },
  )

  return (
    <Show when={(fallbacks() ?? []).length > 0}>
      <div data-component="deveagent-fallback-card" class="flex flex-col gap-2 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02 p-3">
        <div class={/* section title */ "text-[11px] font-[520] uppercase tracking-wide text-v2-text-text-muted"}>
          {language.t("deveagent.fallbacks.title")}
        </div>
        <div class="flex flex-col gap-1.5">
          <For each={fallbacks() ?? []}>
            {(entry) => (
              <div class="flex flex-col gap-0.5 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2 py-1.5">
                <div class="flex min-w-0 items-center gap-1.5 text-[11px]">
                  <span class="min-w-0 flex-1 truncate text-v2-text-text-base" title={`${entry.failedProviderID}/${entry.failedModelID}`}>
                    {entry.failedModelID}
                  </span>
                  <span class="shrink-0 text-v2-icon-icon-muted">→</span>
                  <span class="min-w-0 flex-1 truncate font-medium text-v2-text-text-base" title={`${entry.fallbackProviderID}/${entry.fallbackModelID}`}>
                    {entry.fallbackModelID}
                  </span>
                  <Show when={entry.fallbackPaid}>
                    <span
                      class="shrink-0 rounded px-1 py-0.5 text-[9px] font-medium"
                      style={{ background: "var(--v2-state-bg-warning)", color: "var(--v2-state-fg-warning)" }}
                    >
                      {language.t("model.tag.paid")}
                    </span>
                  </Show>
                </div>
                <Show when={entry.message}>
                  <div class="truncate text-[10px] leading-4 text-v2-text-text-faint" title={entry.message}>
                    {entry.message}
                  </div>
                </Show>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}

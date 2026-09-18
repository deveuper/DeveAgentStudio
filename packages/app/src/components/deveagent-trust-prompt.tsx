import { createResource, createSignal, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"

type TrustState = {
  status: "trusted" | "untrusted" | "unknown"
  resources: { kind: string; target: string }[]
}

// Session-scoped dismissal: once the user defers a prompt for a workspace it
// stays dismissed until the app restarts (deliberately not persisted — a new
// app run should ask again).
const deferredByDirectory = new Map<string, true>()

/**
 * Trust gate proactive prompt (Pi parity, backlog C21): the first time an
 * untrusted project with executable resources is opened, ask once — visibly —
 * instead of waiting for the user to discover the Overview card.
 */
export function DeveagentTrustPrompt() {
  const language = useLanguage()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const [busy, setBusy] = createSignal(false)
  // Reactivity mirror of deferredByDirectory (Map mutations are not signals).
  const [deferredNow, setDeferredNow] = createSignal(false)

  const [trust] = createResource(
    () => sdk().directory,
    async (directory): Promise<TrustState | undefined> => {
      if (!directory) return undefined
      try {
        const response = await serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/trust`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory }),
        })
        if (!response.ok) return undefined
        return (await response.json()) as TrustState
      } catch {
        return undefined
      }
    },
  )

  const visible = () => {
    const state = trust()
    return (
      state !== undefined &&
      state.status === "unknown" &&
      Array.isArray(state.resources) &&
      state.resources.length > 0 &&
      deferredByDirectory.get(sdk().directory) !== true && !deferredNow()
    )
  }

  const decide = async (decision: "trusted" | "untrusted") => {
    const directory = sdk().directory
    if (!directory || busy()) return
    setBusy(true)
    deferredByDirectory.set(directory, true)
    setDeferredNow(true)
    try {
      await serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/trust`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directory, decision }),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show when={visible()}>
      <div
        data-component="deveagent-trust-prompt"
        class="pointer-events-auto flex w-[420px] max-w-full flex-col gap-1 rounded-lg border border-v2-state-fg-warning/40 bg-background-base p-3 shadow-[var(--v2-elevation-raised)]"
      >
        <div class="flex items-start gap-2">
          <span class="mt-0.5 text-[13px]">⛨</span>
          <div class="min-w-0 flex-1">
            <div class="text-12-medium text-text-strong">
              {language.t("deveagent.trustPrompt.title")}
            </div>
            <div class="mt-0.5 text-11-regular text-text-weak">
              {language.t("deveagent.trustPrompt.resourcesNotice", { count: trust()!.resources.length })}
            </div>
            <div class="mt-1.5 flex items-center gap-2">
              <button
                type="button"
                class="rounded-md px-2 py-1 text-11-medium text-white"
                style={{ background: "var(--v2-background-bg-accent)" }}
                data-action="deveagent-trust-prompt-allow"
                disabled={busy()}
                onClick={() => void decide("trusted")}
              >
                {busy() ? language.t("deveagent.trustPrompt.working") : language.t("deveagent.trustPrompt.trustProject")}
              </button>
              <button
                type="button"
                class="rounded-md border border-border-weak-base px-2 py-1 text-11-medium text-text-base hover:bg-surface-base"
                data-action="deveagent-trust-prompt-deny"
                disabled={busy()}
                onClick={() => void decide("untrusted")}
              >
                {language.t("deveagent.trustPrompt.keepBlocked")}
              </button>
              <button
                type="button"
                class="ml-auto text-12-regular text-text-weak hover:text-text-base"
                data-action="deveagent-trust-prompt-dismiss"
                title={language.t("deveagent.trustPrompt.askAgain")}
                onClick={() => {
                  deferredByDirectory.set(sdk().directory, true)
                  setDeferredNow(true)
                }}
              >
                {language.t("deveagent.trustPrompt.later")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  )
}

import { createResource, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"

type TrustResource = { kind: "plugin" | "mcp"; target: string }
type TrustState = {
  directory: string
  status: "trusted" | "untrusted" | "unknown"
  fingerprint: string
  resources: TrustResource[]
  changed: boolean
  decidedAt?: number
}

const MAX_LISTED = 5

/**
 * Project trust gate (Pi parity): a repository can ship its own plugins (code run
 * at boot) and MCP servers (child processes). Until the user trusts the
 * workspace, DeveAgent withholds them. The decision lives outside the project
 * and is bound to a fingerprint of those resources, so changing them re-arms
 * the gate.
 */
export function DeveagentTrustCard() {
  const language = useLanguage()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const [busy, setBusy] = createSignal(false)

  const [trust, { refetch }] = createResource(
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

  const decide = async (decision: "trusted" | "untrusted") => {
    const directory = sdk().directory
    if (!directory || busy()) return
    setBusy(true)
    try {
      await serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/trust`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directory, decision }),
      })
      await refetch()
    } finally {
      setBusy(false)
    }
  }

  const resources = () => trust()?.resources ?? []
  const status = () => trust()?.status ?? "unknown"

  return (
    <Show when={resources().length > 0}>
      <div
        data-component="deveagent-trust-card"
        class="flex flex-col gap-2 rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-3"
      >
        <div class="flex w-full items-center justify-between gap-2">
          <span class="text-[11px] font-[520] uppercase tracking-wide text-v2-text-text-muted">{language.t("deveagent.trust.title")}</span>
          <span
            class="rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums"
            style={
              status() === "trusted"
                ? { background: "var(--v2-state-bg-success)", color: "var(--v2-state-fg-success)" }
                : { background: "var(--v2-state-bg-warning)", color: "var(--v2-state-fg-warning)" }
            }
          >
            {status() === "trusted" ? language.t("deveagent.trust.trusted") : language.t("deveagent.trust.untrustedBlocked")}
          </span>
        </div>
        <div class="text-[12px] text-v2-text-text-base">
          {language.t("deveagent.trust.resourcesNotice", { count: resources().length })}
        </div>
        <div class="flex flex-col gap-1">
          <For each={resources().slice(0, MAX_LISTED)}>
            {(resource) => (
              <div class="flex items-center gap-2 text-[11px] text-v2-text-text-muted">
                <span class="rounded bg-v2-background-bg-layer-03 px-1 py-0.5 text-[10px] uppercase">
                  {resource.kind === "plugin" ? language.t("deveagent.trust.plugin") : "MCP"}
                </span>
                <span class="min-w-0 truncate font-mono">{resource.target}</span>
              </div>
            )}
          </For>
          <Show when={resources().length > MAX_LISTED}>
            <div class="text-[11px] text-v2-text-text-muted">
              {language.t("deveagent.trust.moreResources", { count: resources().length - MAX_LISTED })}
            </div>
          </Show>
        </div>
        <Show when={trust()?.changed}>
          <div class="text-[11px] text-v2-state-fg-warning">
            {language.t("deveagent.trust.resourcesChanged")}
          </div>
        </Show>
        <div class="flex items-center gap-2">
          <Show
            when={status() !== "trusted"}
            fallback={
              <button
                type="button"
                class="rounded-md border border-border-weak-base px-2 py-1 text-[11px] font-medium text-text-base hover:bg-surface-base"
                data-action="deveagent-trust-revoke"
                disabled={busy()}
                onClick={() => void decide("untrusted")}
              >
                {language.t("deveagent.trust.revokeTrust")}
              </button>
            }
          >
            <button
              type="button"
              class="rounded-md px-2 py-1 text-[11px] font-medium text-white"
              style={{ background: "var(--v2-background-bg-accent)" }}
              data-action="deveagent-trust-allow"
              disabled={busy()}
              onClick={() => void decide("trusted")}
            >
              {busy() ? language.t("deveagent.trust.working") : language.t("deveagent.trust.trustProject")}
            </button>
            <button
              type="button"
              class="rounded-md border border-border-weak-base px-2 py-1 text-[11px] font-medium text-text-base hover:bg-surface-base"
              data-action="deveagent-trust-deny"
              disabled={busy()}
              onClick={() => void decide("untrusted")}
            >
              {language.t("deveagent.trust.keepBlocked")}
            </button>
          </Show>
        </div>
        <div class="text-[11px] text-v2-text-text-muted">
          {language.t("deveagent.trust.changesTakeEffect")}
        </div>
      </div>
    </Show>
  )
}

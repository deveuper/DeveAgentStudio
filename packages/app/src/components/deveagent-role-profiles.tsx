// Role -> model routing configuration panel (right-side dashboard).
// A role is bound to a provider+model here; messages carrying that role (from
// a Work Pack default or an explicit role) route to the bound model unless the
// user pinned a model explicitly (explicit model > role > default). The panel
// mirrors the vision/STT config panels and surfaces the backend's honest
// warnings (e.g. a saved model that cannot be resolved right now).

import { For, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useModels } from "@/context/models"

type RoleProfileEntry = { providerID: string; modelID: string }

const KNOWN_ROLES = [
  { id: "planner", label: "Planner 计划者", labelEn: "Planner", labelKey: "deveagent.team.role.planner" },
  { id: "coder", label: "Coder 编码者", labelEn: "Coder", labelKey: "deveagent.team.role.coder" },
  { id: "reviewer", label: "Reviewer 审查者", labelEn: "Reviewer", labelKey: "deveagent.team.role.reviewer" },
  { id: "verifier", label: "Verifier 验证者", labelEn: "Verifier", labelKey: "deveagent.team.role.verifier" },
] as const

export function DeveAgentRoleProfilesPanel() {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const models = useModels()
  const base = () => serverSDK().url.replace(/\/+$/, "")

  const [profiles, setProfiles] = createSignal<Record<string, RoleProfileEntry>>({})
  const [drafts, setDrafts] = createSignal<Record<string, string>>({})
  const [customRole, setCustomRole] = createSignal("")
  const [customDraft, setCustomDraft] = createSignal("")
  const [result, setResult] = createSignal<{ ok: boolean; detail: string } | null>(null)
  const [saving, setSaving] = createSignal(false)

  const modelOptions = () => models.list().slice(0, 300)
  const draftFor = (role: string) => {
    const current = drafts()[role]
    if (current !== undefined) return current
    const profile = profiles()[role]
    return profile ? `${profile.providerID}/${profile.modelID}` : ""
  }

  const refresh = async () => {
    try {
      const response = await serverSDK().fetch(`${base()}/api/deveagent/role-profile`)
      if (!response.ok) return
      const data = (await response.json()) as { ok?: boolean; profiles?: Record<string, RoleProfileEntry> }
      setProfiles(data.profiles ?? {})
    } catch {}
  }
  onMount(() => {
    void refresh()
    // The dashboard can mount before the server context is fully ready; one
    // retry covers the transient first-fetch failure without polling.
    const retry = window.setTimeout(() => void refresh(), 1200)
    onCleanup(() => window.clearTimeout(retry))
  })

  const saveRole = async (role: string, value: string) => {
    const separator = value.indexOf("/")
    if (separator <= 0) return
    const providerID = value.slice(0, separator)
    const modelID = value.slice(separator + 1)
    if (!providerID || !modelID) return
    setSaving(true)
    setResult(null)
    try {
      const response = await serverSDK().fetch(`${base()}/api/deveagent/role-profile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set", role, providerID, modelID }),
      })
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; warning?: string }
      if (!response.ok || data.ok === false) {
        setResult({ ok: false, detail: data.error ?? `HTTP ${response.status}` })
        return
      }
      await refresh()
      setResult({ ok: true, detail: data.warning ?? language.t("deveagent.roles.savedBinding", { role, provider: providerID, model: modelID }) })
    } catch (error) {
      setResult({ ok: false, detail: error instanceof Error ? error.message : String(error) })
    } finally {
      setSaving(false)
    }
  }

  const clearRole = async (role: string) => {
    setSaving(true)
    setResult(null)
    try {
      const response = await serverSDK().fetch(`${base()}/api/deveagent/role-profile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "clear", role }),
      })
      if (!response.ok) {
        setResult({ ok: false, detail: `HTTP ${response.status}` })
        return
      }
      await refresh()
      setResult({ ok: true, detail: language.t("deveagent.roles.clearedBinding", { role }) })
    } catch (error) {
      setResult({ ok: false, detail: error instanceof Error ? error.message : String(error) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <details class="mt-3 border-t border-v2-border-border-base pt-3" data-action="role-profile-panel">
      <summary class="flex cursor-pointer items-center justify-between gap-2 text-[11px] font-medium text-v2-text-text-base">
        <span>{language.t("deveagent.roles.title")}</span>
        <span class="text-[10px] font-normal text-v2-text-text-muted">{Object.keys(profiles()).length} {language.t("deveagent.roles.boundSuffix")}</span>
      </summary>
      <div class="mt-2 text-[10px] leading-4 text-v2-text-text-muted">
        {language.t("deveagent.roles.hint")}
      </div>

      <div class="mt-2 flex flex-col gap-2">
        <For each={KNOWN_ROLES}>
          {(role) => (
            <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-1.5 border-b border-v2-border-border-muted pb-2 last:border-0">
              <span class="col-span-2 text-[10px] text-v2-text-text-muted">{language.t(role.labelKey)}</span>
              <select
                aria-label={language.t("deveagent.roles.roleModelLabel", { role: role.id })}
                data-action={`role-profile-select-${role.id}`}
                class="min-w-0 rounded border border-v2-border-border-muted bg-v2-background-bg-base px-1.5 py-1 text-[11px] text-v2-text-text-base outline-none focus:border-v2-border-border-focus"
                value={draftFor(role.id)}
                disabled={saving()}
                onChange={(event) => setDrafts((prev) => ({ ...prev, [role.id]: event.currentTarget.value }))}
              >
                <option value="">{language.t("deveagent.roles.unbound")}</option>
                <For each={modelOptions()}>
                  {(model) => <option value={`${model.provider.id}/${model.id}`}>{model.provider.name} · {model.name}</option>}
                </For>
                <Show when={profiles()[role.id] && !modelOptions().some((model) => `${model.provider.id}/${model.id}` === draftFor(role.id))}>
                  <option value={draftFor(role.id)}>
                    {profiles()[role.id]!.providerID} · {profiles()[role.id]!.modelID}{language.t("deveagent.roles.boundNotInList")}
                  </option>
                </Show>
              </select>
              <button
                type="button"
                data-action={`role-profile-save-${role.id}`}
                class="shrink-0 rounded border border-v2-border-border-focus/40 bg-v2-background-bg-accent/10 px-2 py-1 text-[11px] font-medium text-v2-text-text-accent disabled:opacity-50"
                disabled={saving() || !draftFor(role.id)}
                onClick={() => void saveRole(role.id, draftFor(role.id))}
              >
                {language.t("deveagent.roles.save")}
              </button>
              <Show when={profiles()[role.id]}>
                <button
                  type="button"
                  data-action={`role-profile-clear-${role.id}`}
                  class="col-start-2 shrink-0 rounded border border-v2-border-border-muted px-2 py-1 text-[10px] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover disabled:opacity-50"
                  disabled={saving()}
                  onClick={() => void clearRole(role.id)}
                >
                  {language.t("deveagent.roles.clearBinding")}
                </button>
              </Show>
            </div>
          )}
        </For>
        <div class="grid grid-cols-[88px_minmax(0,1fr)_auto] gap-1.5 border-t border-v2-border-border-muted pt-2">
          <input
            aria-label={language.t("deveagent.roles.customRole")}
            data-action="role-profile-custom-role"
            class="min-w-0 rounded border border-v2-border-border-muted bg-v2-background-bg-base px-1.5 py-1 text-[11px] text-v2-text-text-base outline-none focus:border-v2-border-border-focus"
            placeholder={language.t("deveagent.roles.customRole")}
            value={customRole()}
            disabled={saving()}
            onInput={(event) => setCustomRole(event.currentTarget.value)}
          />
          <select
            aria-label={language.t("deveagent.roles.customRoleModel")}
            data-action="role-profile-custom-model"
            class="min-w-0 flex-1 rounded border border-v2-border-border-muted bg-v2-background-bg-base px-1.5 py-1 text-[11px] text-v2-text-text-base outline-none"
            value={customDraft()}
            disabled={saving()}
            onChange={(event) => setCustomDraft(event.currentTarget.value)}
          >
            <option value="">{language.t("deveagent.roles.unbound")}</option>
            <For each={modelOptions()}>
              {(model) => <option value={`${model.provider.id}/${model.id}`}>{model.provider.name} · {model.name}</option>}
            </For>
          </select>
          <button
            type="button"
            data-action="role-profile-save-custom"
            class="shrink-0 rounded border border-v2-border-border-focus/40 bg-v2-background-bg-accent/10 px-2 py-1 text-[11px] font-medium text-v2-text-text-accent disabled:opacity-50"
            disabled={saving() || !customRole().trim() || !customDraft()}
            onClick={() => void saveRole(customRole().trim(), customDraft())}
          >
            {language.t("deveagent.roles.save")}
          </button>
          <Show when={profiles()[customRole().trim()]}>
            <button
              type="button"
              data-action="role-profile-clear-custom"
              class="shrink-0 rounded border border-v2-border-border-muted px-2 py-1 text-[11px] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover disabled:opacity-50"
              disabled={saving()}
              onClick={() => void clearRole(customRole().trim())}
            >
              {language.t("deveagent.roles.clear")}
            </button>
          </Show>
        </div>
      </div>

      <Show when={result()}>
        {(value) => (
          <div
            class={`mt-2 rounded border px-2 py-1.5 text-[10px] leading-4 break-words ${
              value().ok ? "border-v2-state-border-success text-v2-state-fg-success" : "border-v2-state-border-danger text-v2-state-fg-danger"
            }`}
          >
            {value().detail}
          </div>
        )}
      </Show>
    </details>
  )
}

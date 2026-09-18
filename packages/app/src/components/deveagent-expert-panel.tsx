import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@/utils/toast"
import { useServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"
import { useDeveAgentComposerState } from "@/components/deveagent-composer-state"

type ExpertItem = {
  id: string
  name: string
  role: string
  icon: string
  canWrite: boolean
  builtin: boolean
  prompt?: string
}

const BUILTIN_EXPERTS: ExpertItem[] = [
  { id: "chief", name: "Chief Agent", role: "Task decomposition and routing", icon: "robot", canWrite: false, builtin: true },
  { id: "planner", name: "Planner", role: "Architecture and task planning", icon: "document", canWrite: false, builtin: true },
  { id: "codegraph", name: "CodeGraph", role: "Symbol search and impact analysis", icon: "magnifying-glass", canWrite: false, builtin: true },
  { id: "reviewer", name: "Reviewer", role: "Regression and quality review", icon: "shield", canWrite: false, builtin: true },
  { id: "security", name: "Security", role: "Vulnerability and permission audit", icon: "lock", canWrite: false, builtin: true },
  { id: "test", name: "Test Agent", role: "Test strategy and coverage", icon: "beaker", canWrite: false, builtin: true },
  { id: "memory", name: "Memory Agent", role: "Past decisions and bug history", icon: "brain", canWrite: false, builtin: true },
  { id: "token", name: "Token Saver", role: "Context budget and cache layout", icon: "coin", canWrite: false, builtin: true },
  { id: "ui", name: "UI Agent", role: "Desktop UX and accessibility", icon: "eye", canWrite: false, builtin: true },
]

const ICON_CHOICES = ["robot", "document", "magnifying-glass", "shield", "lock", "beaker", "brain", "coin", "eye", "sparkles", "wrench", "globe"]

export function DeveagentExpertPanel(props: { onApplied?: () => void }) {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const composer = useDeveAgentComposerState()
  const active = createMemo(() => composer.snapshot().selectedExpert?.id)
  const base = () => serverSDK().url.replace(/\/+$/, "")

  const [experts, { refetch }] = createResource(
    () => serverSDK().url,
    async (url): Promise<ExpertItem[]> => {
      try {
        const response = await serverSDK().fetch(`${url.replace(/\/+$/, "")}/api/deveagent/experts`)
        if (!response.ok) return []
        const text = await response.text()
        if (!text) return []
        const data = JSON.parse(text) as { experts?: ExpertItem[] }
        const merged = new Map(BUILTIN_EXPERTS.map((expert) => [expert.id, expert]))
        for (const expert of data.experts ?? []) merged.set(expert.id, expert)
        return [...merged.values()]
      } catch {
        return BUILTIN_EXPERTS
      }
    },
    { initialValue: BUILTIN_EXPERTS },
  )

  // Editor state: null = closed, { id: undefined } = creating new, { id } = editing existing
  const [editing, setEditing] = createSignal<ExpertItem | "new" | null>(null)
  const [formName, setFormName] = createSignal("")
  const [formRole, setFormRole] = createSignal("")
  const [formPrompt, setFormPrompt] = createSignal("")
  const [formIcon, setFormIcon] = createSignal("robot")
  const [formCanWrite, setFormCanWrite] = createSignal(false)

  const selectExpert = (expert: ExpertItem) => {
    const next = active() === expert.id ? undefined : expert
    composer.setSelectedExpert(next ? { id: next.id, name: next.name, role: next.role } : undefined)
    window.dispatchEvent(new CustomEvent("deveagent:select-expert", { detail: next ? { id: next.id, name: next.name, role: next.role } : undefined }))
  }

  const openCreate = () => {
    setFormName("")
    setFormRole("")
    setFormPrompt("")
    setFormIcon("robot")
    setFormCanWrite(false)
    setEditing("new")
  }

  const openEdit = (expert: ExpertItem) => {
    setFormName(expert.name)
    setFormRole(expert.role)
    setFormPrompt(expert.prompt ?? "")
    setFormIcon(expert.icon)
    setFormCanWrite(expert.canWrite)
    setEditing(expert)
  }

  const duplicateExpert = async (expert: ExpertItem) => {
    const prompt = expert.builtin ? "" : expert.prompt ?? ""
    await serverSDK().fetch(`${base()}/api/deveagent/experts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: language.t("deveagent.expert.copyName", { name: expert.name }), role: expert.role, prompt, icon: expert.icon, canWrite: false }),
    })
    showToast({ title: language.t("deveagent.expert.duplicated"), description: language.t("deveagent.expert.duplicatedDescription", { name: expert.name }) })
    refetch()
  }

  const saveEditor = async () => {
    const name = formName().trim()
    if (!name) {
      showToast({ title: language.t("deveagent.expert.nameRequired"), description: language.t("deveagent.expert.giveName") })
      return
    }
    const payload = { name, role: formRole().trim(), prompt: formPrompt(), icon: formIcon(), canWrite: formCanWrite() }
    const current = editing()
    if (current === "new") {
      await serverSDK().fetch(`${base()}/api/deveagent/experts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
      showToast({ title: language.t("deveagent.expert.created"), description: language.t("deveagent.expert.createdDescription", { name }) })
    } else if (current) {
      await serverSDK().fetch(`${base()}/api/deveagent/experts`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: current.id, ...payload }),
      })
      showToast({ title: language.t("deveagent.expert.saved"), description: language.t("deveagent.expert.savedDescription", { name }) })
    }
    setEditing(null)
    refetch()
  }

  const removeExpert = async (expert: ExpertItem) => {
    await serverSDK().fetch(`${base()}/api/deveagent/experts`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: expert.id }),
    })
    showToast({ title: language.t("deveagent.expert.deleted"), description: language.t("deveagent.expert.deletedDescription", { name: expert.name }) })
    refetch()
  }

  return (
    <div class="box-border flex h-full min-h-0 flex-col gap-3 overflow-hidden p-3 text-[13px]">
      <div class="rounded-lg border border-[var(--border-base)] bg-v2-background-bg-layer-01 p-3">
        <div class="font-medium text-[var(--text-base)]">{language.t("deveagent.expert.title")}</div>
        <div class="mt-1 text-[11px] leading-5 text-v2-text-text-muted">
          {language.t("deveagent.expert.subtitle")}
        </div>
      </div>

      <Show when={editing() !== null}>
        <div class="flex flex-col gap-2 rounded-lg border border-v2-border-border-focus/40 bg-v2-background-bg-layer-01 p-3">
          <div class="text-[12px] font-medium text-[var(--text-base)]">
            {editing() === "new" ? language.t("deveagent.expert.newExpert") : language.t("deveagent.expert.editTitle", { name: (editing() as ExpertItem).name })}
          </div>
          <input
            class="w-full rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] px-2 py-1.5 text-[12px] text-[var(--text-base)] outline-none focus:border-v2-border-border-focus"
            placeholder={language.t("deveagent.expert.fieldName")}
            value={formName()}
            onInput={(e) => setFormName(e.currentTarget.value)}
          />
          <input
            class="w-full rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] px-2 py-1.5 text-[12px] text-[var(--text-base)] outline-none focus:border-v2-border-border-focus"
            placeholder={language.t("deveagent.expert.fieldRole")}
            value={formRole()}
            onInput={(e) => setFormRole(e.currentTarget.value)}
          />
          <textarea
            class="h-24 w-full resize-none rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] px-2 py-1.5 text-[12px] text-[var(--text-base)] outline-none focus:border-v2-border-border-focus"
            placeholder={language.t("deveagent.expert.fieldPrompt")}
            value={formPrompt()}
            onInput={(e) => setFormPrompt(e.currentTarget.value)}
          />
          <div class="flex flex-wrap gap-1">
            <For each={ICON_CHOICES}>
              {(icon) => (
                <button
                  type="button"
                  class={`rounded-md border p-1.5 ${formIcon() === icon ? "border-v2-border-border-focus bg-v2-background-bg-accent/10" : "border-[var(--border-base)] hover:border-[var(--border-strong-base)]"}`}
                  onClick={() => setFormIcon(icon)}
                  title={icon}
                >
                  <Icon name={icon as any} size="small" />
                </button>
              )}
            </For>
          </div>
          <label class="flex items-center gap-2 text-[12px] text-[var(--text-base)]">
            <input type="checkbox" checked={formCanWrite()} onChange={(e) => setFormCanWrite(e.currentTarget.checked)} />
            {language.t("deveagent.expert.fieldAllowWrites")}
          </label>
          <div class="flex gap-2">
            <Button size="small" variant="primary" class="flex-1" onClick={saveEditor}>
              {language.t("deveagent.expert.save")}
            </Button>
            <Button size="small" variant="ghost" class="flex-1" onClick={() => setEditing(null)}>
              {language.t("deveagent.expert.cancel")}
            </Button>
          </div>
        </div>
      </Show>

      <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
        <For each={experts()}>
          {(expert) => (
            <div
              class={`flex items-start gap-3 rounded-lg border p-3 transition-all ${
                active() === expert.id
                  ? "border-v2-border-border-focus bg-v2-background-bg-accent/10"
                  : "border-[var(--border-base)] bg-v2-background-bg-layer-01 hover:border-[var(--border-strong-base)]"
              }`}
            >
              <button type="button" class="flex min-w-0 flex-1 items-start gap-3 text-left" onClick={() => selectExpert(expert)}>
                <Icon name={expert.icon as any} size="small" />
                <div class="min-w-0 flex-1">
                  <div class="font-medium text-[var(--text-base)]">{language.t("deveagent.expert.labelExpert")} · {expert.name}</div>
                  <div class="mt-0.5 text-[11px] text-v2-text-text-muted">{expert.role || language.t("deveagent.expert.customExpert")}</div>
                </div>
              </button>
              <span class="rounded bg-[var(--surface-base)] px-1.5 py-0.5 text-[9px] text-v2-text-text-muted">
                {expert.builtin ? language.t("deveagent.expert.readOnly") : expert.canWrite ? language.t("deveagent.expert.writable") : language.t("deveagent.expert.custom")}
              </span>
              <div class="flex shrink-0 gap-1">
                <button
                  type="button"
                  class="rounded p-1 text-v2-text-text-muted hover:bg-[var(--surface-base)] hover:text-[var(--text-base)]"
                  title={language.t("deveagent.expert.duplicate")}
                  onClick={() => duplicateExpert(expert)}
                >
                  <Icon name="copy" size="small" />
                </button>
                <Show when={!expert.builtin}>
                  <button
                    type="button"
                    class="rounded p-1 text-v2-text-text-muted hover:bg-[var(--surface-base)] hover:text-[var(--text-base)]"
                    title={language.t("deveagent.expert.edit")}
                    onClick={() => openEdit(expert)}
                  >
                    <Icon name="pencil-line" size="small" />
                  </button>
                  <button
                    type="button"
                    class="rounded p-1 text-v2-text-text-muted hover:bg-[var(--surface-base)] hover:text-[var(--v2-state-fg-danger)]"
                    title={language.t("deveagent.expert.delete")}
                    onClick={() => removeExpert(expert)}
                  >
                    <Icon name="close" size="small" />
                  </button>
                </Show>
              </div>
            </div>
          )}
        </For>
      </div>

      <div class="flex shrink-0 gap-2">
        <Button variant="ghost" size="normal" class="flex-1" onClick={openCreate}>
          + {language.t("deveagent.expert.newExpert")}
        </Button>
        <Button
          variant="primary"
          size="normal"
          class="flex-1"
          onClick={() => {
            // Applying a selection must return focus to the Composer; leaving the
            // drawer mounted would cover the controls the user needs next.
            props.onApplied?.()
            window.dispatchEvent(new CustomEvent("deveagent:open-panel", { detail: "close" }))
          }}
        >
          {language.t("deveagent.expert.applySelection")}
        </Button>
      </div>
    </div>
  )
}

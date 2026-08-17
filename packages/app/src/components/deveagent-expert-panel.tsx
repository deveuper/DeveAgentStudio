import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@/utils/toast"
import { useServerSDK } from "@/context/server-sdk"
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
      body: JSON.stringify({ name: `${expert.name} 副本`, role: expert.role, prompt, icon: expert.icon, canWrite: false }),
    })
    showToast({ title: "已复制专家", description: `已基于 ${expert.name} 创建自定义副本，可点击编辑。` })
    refetch()
  }

  const saveEditor = async () => {
    const name = formName().trim()
    if (!name) {
      showToast({ title: "需要名称", description: "请为专家填写一个名称。" })
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
      showToast({ title: "已创建专家", description: `${name} 已加入专家团。` })
    } else if (current) {
      await serverSDK().fetch(`${base()}/api/deveagent/experts`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: current.id, ...payload }),
      })
      showToast({ title: "已保存", description: `${name} 配置已更新。` })
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
    showToast({ title: "已删除专家", description: `${expert.name} 已移除。` })
    refetch()
  }

  return (
    <div class="box-border flex h-full min-h-0 flex-col gap-3 overflow-hidden p-3 text-[13px]">
      <div class="rounded-lg border border-[var(--border-base)] bg-\[var\(--surface-raised-base\)\] p-3">
        <div class="font-medium text-[var(--text-base)]">专家团</div>
        <div class="mt-1 text-[11px] leading-5 text-[var(--text-weak)]">
          内置专家只读；可复制为自定义副本或新建专家，配置角色提示与文件写入权限。自定义专家可编辑、删除。
        </div>
      </div>

      <Show when={editing() !== null}>
        <div class="flex flex-col gap-2 rounded-lg border border-v2-border-border-focus/40 bg-\[var\(--surface-raised-base\)\] p-3">
          <div class="text-[12px] font-medium text-[var(--text-base)]">
            {editing() === "new" ? "新建专家" : `编辑专家 · ${(editing() as ExpertItem).name}`}
          </div>
          <input
            class="w-full rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] px-2 py-1.5 text-[12px] text-[var(--text-base)] outline-none focus:border-v2-border-border-focus"
            placeholder="专家名称（必填）"
            value={formName()}
            onInput={(e) => setFormName(e.currentTarget.value)}
          />
          <input
            class="w-full rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] px-2 py-1.5 text-[12px] text-[var(--text-base)] outline-none focus:border-v2-border-border-focus"
            placeholder="角色描述（显示在列表中）"
            value={formRole()}
            onInput={(e) => setFormRole(e.currentTarget.value)}
          />
          <textarea
            class="h-24 w-full resize-none rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] px-2 py-1.5 text-[12px] text-[var(--text-base)] outline-none focus:border-v2-border-border-focus"
            placeholder="角色提示词（system prompt，描述该专家的职责与约束）"
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
            允许写入文件（默认只读；勾选后该专家可修改文件）
          </label>
          <div class="flex gap-2">
            <Button size="small" variant="primary" class="flex-1" onClick={saveEditor}>
              保存
            </Button>
            <Button size="small" variant="ghost" class="flex-1" onClick={() => setEditing(null)}>
              取消
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
                  : "border-[var(--border-base)] bg-\[var\(--surface-raised-base\)\] hover:border-[var(--border-strong-base)]"
              }`}
            >
              <button type="button" class="flex min-w-0 flex-1 items-start gap-3 text-left" onClick={() => selectExpert(expert)}>
                <Icon name={expert.icon as any} size="small" />
                <div class="min-w-0 flex-1">
                  <div class="font-medium text-[var(--text-base)]">专家 · {expert.name}</div>
                  <div class="mt-0.5 text-[11px] text-[var(--text-weak)]">{expert.role || "自定义专家"}</div>
                </div>
              </button>
              <span class="rounded bg-[var(--surface-base)] px-1.5 py-0.5 text-[9px] text-[var(--text-weak)]">
                {expert.builtin ? "只读" : expert.canWrite ? "可写" : "自定义"}
              </span>
              <div class="flex shrink-0 gap-1">
                <button
                  type="button"
                  class="rounded p-1 text-[var(--text-weak)] hover:bg-[var(--surface-base)] hover:text-[var(--text-base)]"
                  title="复制为自定义专家"
                  onClick={() => duplicateExpert(expert)}
                >
                  <Icon name="copy" size="small" />
                </button>
                <Show when={!expert.builtin}>
                  <button
                    type="button"
                    class="rounded p-1 text-[var(--text-weak)] hover:bg-[var(--surface-base)] hover:text-[var(--text-base)]"
                    title="编辑"
                    onClick={() => openEdit(expert)}
                  >
                    <Icon name="pencil-line" size="small" />
                  </button>
                  <button
                    type="button"
                    class="rounded p-1 text-[var(--text-weak)] hover:bg-[var(--surface-base)] hover:text-[var(--v2-state-fg-danger)]"
                    title="删除"
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
          + 新建专家
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
          应用专家选择
        </Button>
      </div>
    </div>
  )
}

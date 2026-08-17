import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@/utils/toast"
import { useProviders } from "@/hooks/use-providers"
import { useServerSDK } from "@/context/server-sdk"
import { useNavigate } from "@solidjs/router"
import {
  TEAM_ROLE_PRESETS,
  createDeveAgentTeamState,
  type DeveAgentTeamMember,
  type DeveAgentTeamRole,
  type DeveAgentTeamRunMode,
} from "@/components/deveagent-team-state"

// DeveAgent Team Panel
// ====================
// User-driven multi-agent editor:
//   - Add any number of team members.
//   - Each member picks its own provider and model.
//   - Roles carry role-specific system prompt hints (Planner / Executor /
//     Reviewer / Researcher / Critic / Verifier / Custom).
//   - Run mode can be Sequential (chain), Parallel (fan-out), or Debate (loop).
// Real backend orchestration reads this snapshot from POST /api/deveagent/team.

const ROLE_KEYS: DeveAgentTeamRole[] = ["planner", "executor", "reviewer", "researcher", "critic", "verifier", "custom"]
const RUN_MODES: { id: DeveAgentTeamRunMode; label: string; description: string }[] = [
  { id: "sequential", label: "串行", description: "顾问按顺序分析；汇总后交给唯一执行者。" },
  { id: "parallel", label: "并行", description: "顾问同时分析；不会与执行者并发写入。" },
  { id: "debate", label: "辩论", description: "顾问逐轮查看前序意见；最多 maxRounds 轮。" },
]

export function DeveagentTeamPanel(props: { sessionID?: string; directorySlug?: string }) {
  const team = createDeveAgentTeamState(props.sessionID)
  const navigate = useNavigate()
  const serverSDK = useServerSDK()
  const providersHook = useProviders()
  const providers = createMemo(() => providersHook.connected())
  const [draft, setDraft] = createSignal({
    name: "",
    role: "planner" as DeveAgentTeamRole,
    providerID: "",
    modelID: "",
    systemPrompt: "",
  })
  const [expandedID, setExpandedID] = createSignal<string | undefined>()
  const [runs, setRuns] = createSignal<Array<{
    id?: string
    task?: string
    tokens?: number
    cost?: number
    budgetExceeded?: boolean
    status?: "running" | "completed" | "failed" | "interrupted"
    resumable?: boolean
    resume?: { task?: string; memberIDs?: string[] }
    members?: Array<{
      id?: string
      name?: string
      childSessionID?: string
      jobID?: string
      status?: "pending" | "running" | "completed" | "failed" | "unknown"
      error?: string
    }>
  }>>([])
  const [resumingRunID, setResumingRunID] = createSignal<string | undefined>()
  const [dispatchTask, setDispatchTask] = createSignal("")
  const [dispatching, setDispatching] = createSignal(false)
  const [backgroundJobs, setBackgroundJobs] = createSignal<Array<{
    id: string
    title?: string
    status: "running" | "completed" | "error" | "cancelled"
    started_at: number
    completed_at?: number
    error?: string
    metadata?: { deveagentRestartState?: string; deveagentTeam?: boolean }
  }>>([])
  const [cancellingJobID, setCancellingJobID] = createSignal<string | undefined>()

  const refreshRuns = async () => {
    if (!props.sessionID) return
    try {
      const base = serverSDK().url.replace(/\/+$/, "")
      const suffix = props.sessionID ? `?sessionID=${encodeURIComponent(props.sessionID)}` : ""
      const response = await serverSDK().fetch(`${base}/api/deveagent/team-runs${suffix}`)
      if (response.ok) setRuns((await response.json()) as Array<{ tokens?: number; cost?: number; budgetExceeded?: boolean; status?: "running" | "completed" | "failed" | "interrupted"; resumable?: boolean; members?: Array<{ error?: string; status?: "pending" | "running" | "completed" | "failed" | "unknown" }> }>)
    } catch {
      // The panel remains usable when the optional ledger endpoint is unavailable.
    }
  }

  const refreshBackgroundJobs = async () => {
    if (!props.sessionID) return
    try {
      const base = serverSDK().url.replace(/\/+$/, "")
      const suffix = props.sessionID ? `?sessionID=${encodeURIComponent(props.sessionID)}` : ""
      const response = await serverSDK().fetch(`${base}/api/deveagent/background-jobs${suffix}`)
      if (response.ok) setBackgroundJobs((await response.json()) as Array<{ id: string; title?: string; status: "running" | "completed" | "error" | "cancelled"; started_at: number; completed_at?: number; error?: string; metadata?: { deveagentRestartState?: string; deveagentTeam?: boolean } }>)
    } catch {
      // The native job list is optional for older or non-OpenCode hosts.
    }
  }

  const cancelBackgroundJob = async (jobID: string) => {
    if (!props.sessionID || cancellingJobID()) return
    setCancellingJobID(jobID)
    try {
      const base = serverSDK().url.replace(/\/+$/, "")
      const response = await serverSDK().fetch(`${base}/api/deveagent/background-jobs/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobID, sessionID: props.sessionID }),
      })
      const payload = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) throw new Error(payload.error || `取消失败 (${response.status})`)
      showToast({ variant: "success", title: "团队任务已取消", description: "已通过后台任务取消父任务，并向子任务传播中断信号。" })
      await refreshBackgroundJobs()
      await refreshRuns()
    } catch (error) {
      showToast({ variant: "error", title: "团队任务未取消", description: error instanceof Error ? error.message : "取消接口不可用" })
    } finally {
      setCancellingJobID(undefined)
    }
  }

  onMount(() => {
    void refreshRuns()
    void refreshBackgroundJobs()
    const timer = window.setInterval(() => {
      void refreshRuns()
      void refreshBackgroundJobs()
    }, 5000)
    onCleanup(() => window.clearInterval(timer))
  })

  const usage = createMemo(() => ({
    tokens: runs().reduce((sum, run) => sum + (run.tokens ?? 0), 0),
    cost: runs().reduce((sum, run) => sum + (run.cost ?? 0), 0),
    failures: runs().reduce((sum, run) => sum + (run.members?.filter((member) => member.error).length ?? 0), 0),
  }))

  const activeProvider = createMemo(() => {
    const providerID = draft().providerID || providers()[0]?.id || ""
    return providers().find((provider) => provider.id === providerID)
  })

  const models = createMemo(() => {
    const provider = activeProvider()
    if (!provider) return [] as Array<{ id: string; name: string }>
    return Object.entries(provider.models ?? {}).map(([id, model]) => ({
      id,
      name: (model as { name?: string }).name ?? id,
    }))
  })

  const addMember = () => {
    const providerID = draft().providerID || providers()[0]?.id
    const firstModel = models()[0]?.id
    const modelID = draft().modelID || firstModel
    if (!providerID || !modelID) {
      showToast({ variant: "error", title: "缺少 Provider 或模型", description: "请先配置至少一个 Provider。" })
      return
    }
    const preset = TEAM_ROLE_PRESETS[draft().role]
    team.addMember({
      name: draft().name.trim() || preset.label,
      role: draft().role,
      providerID,
      modelID,
      systemPrompt: draft().systemPrompt.trim() || preset.systemPrompt,
      enabled: true,
    })
    setDraft({ name: "", role: "planner", providerID: "", modelID: "", systemPrompt: "" })
  }

  const openChildSession = (sessionID: string) => {
    if (!props.directorySlug) {
      showToast({ variant: "error", title: "无法打开子会话", description: "当前不在项目会话中。" })
      return
    }
    navigate(`/${props.directorySlug}/session/${sessionID}`)
  }

  const requestAdvisorResume = async (runID: string, mode: "resume" | "retry") => {
    if (!props.sessionID) {
      showToast({ variant: "error", title: "无法恢复", description: "请先打开对应的项目会话。" })
      return
    }
    if (!/^[a-zA-Z0-9._-]{1,120}$/.test(runID)) {
      showToast({ variant: "error", title: "无法恢复", description: "运行记录 ID 无效。" })
      return
    }
    setResumingRunID(runID)
    try {
      // ponytail: keep TaskTool, model selection, permissions, and the visible
      // timeline OpenCode-owned instead of inventing a second HTTP executor.
      await serverSDK().client.session.promptAsync({
        sessionID: props.sessionID,
        parts: [{
          type: "text",
          text: `The user explicitly requested an advisor-only ${mode === "retry" ? "retry" : "recovery"}. Call the team-resume-interrupted tool now with runID ${JSON.stringify(runID)} and mode ${JSON.stringify(mode)}. Do not dispatch any new Executor or write-capable task. Report the resumed advisors, child session IDs, failures, and usage after the tool returns.`,
        }],
      })
      showToast({
        variant: "success",
        title: mode === "retry" ? "已请求重试顾问" : "已请求恢复顾问",
        description: `${mode === "retry" ? "重试" : "恢复"}请求已作为可见会话消息发送；Agent 将通过 TaskTool 运行保存的只读顾问。`,
      })
      window.setTimeout(() => void refreshRuns(), 1_000)
    } catch (error) {
      showToast({ variant: "error", title: "恢复请求未发送", description: error instanceof Error ? error.message : "当前会话无法启动恢复请求。" })
    } finally {
      setResumingRunID(undefined)
    }
  }

  const dispatchTeamDirect = async () => {
    const task = dispatchTask().trim()
    if (!props.sessionID || !task) return
    setDispatching(true)
    try {
      const base = serverSDK().url.replace(/\/+$/, "")
      const response = await serverSDK().fetch(`${base}/api/deveagent/team/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionID: props.sessionID, task }),
      })
      const payload = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) throw new Error(payload.error || `Team dispatch failed (${response.status})`)
      setDispatchTask("")
      showToast({ variant: "success", title: "团队任务已启动", description: "已复用原生任务工具、权限和子会话记录。" })
      await refreshRuns()
      await refreshBackgroundJobs()
    } catch (error) {
      showToast({ variant: "error", title: "团队任务未启动", description: error instanceof Error ? error.message : "Team runtime unavailable" })
    } finally {
      setDispatching(false)
    }
  }

  return (
    <div class="flex h-full min-h-0 flex-col gap-3 bg-v2-background-bg-base p-3 text-[13px] text-v2-text-text-base">
      <div class="rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-02 p-3">
        <div class="flex items-center justify-between gap-3">
          <div class="text-[12px] font-semibold text-v2-text-text-base">团队协作 v1</div>
          <Button
            variant={team.snapshot().enabled ? "primary" : "secondary"}
            size="small"
            onClick={() => team.setEnabled(!team.snapshot().enabled)}
          >
            {team.snapshot().enabled ? "MoA 已开启" : "开启 MoA"}
          </Button>
        </div>
        <div class="mt-1 text-[11px] leading-5 text-v2-text-text-muted">
          添加任意数量的 Agent，每个可绑定不同 Provider 和模型。先派发只读顾问，再由唯一 Executor 经引擎权限确认写入。
        </div>
      </div>

      <div class="grid grid-cols-3 gap-2 rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-02 p-3 text-[11px]">
        <div><div class="text-v2-text-text-muted">已记录 Token</div><div class="mt-1 font-semibold">{usage().tokens.toLocaleString()}</div></div>
        <div><div class="text-v2-text-text-muted">已记录费用</div><div class="mt-1 font-semibold">{usage().cost.toFixed(4)}</div></div>
        <div><div class="text-v2-text-text-muted">失败顾问</div><div class="mt-1 font-semibold">{usage().failures}</div></div>
      </div>

      <Show when={props.sessionID}>
        <div class="rounded-lg border border-v2-border-border-focus/30 bg-v2-background-bg-layer-02 p-3">
          <div class="text-[11px] font-semibold text-v2-text-text-base">直接执行团队</div>
          <div class="mt-1 text-[11px] leading-5 text-v2-text-text-muted">服务端复用已注册的 team-dispatch-all、原生 TaskTool 和当前会话权限；不会另起一套假执行器。</div>
          <textarea
            class="mt-2 min-h-16 w-full resize-y rounded-md border border-v2-border-border-muted bg-v2-background-bg-base p-2 text-[12px] outline-none focus:border-v2-border-border-focus"
            value={dispatchTask()}
            onInput={(event) => setDispatchTask(event.currentTarget.value)}
            placeholder="输入要交给团队的任务…"
            disabled={dispatching()}
          />
          <div class="mt-2 flex justify-end">
            <Button variant="primary" size="small" disabled={dispatching() || !dispatchTask().trim()} onClick={() => void dispatchTeamDirect()}>
              {dispatching() ? "团队运行中…" : "开始团队任务"}
            </Button>
          </div>
        </div>
      </Show>

      <Show when={runs().length > 0}>
        <div class="rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-02 p-3">
          <div class="mb-2 text-[11px] font-medium uppercase tracking-wide text-v2-text-text-muted">最近团队运行</div>
          <div class="flex flex-col gap-2">
            <For each={runs().slice(0, 3)}>
              {(run) => (
                <div class="rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-2 py-1.5 text-[11px]">
                  <div class="flex items-center justify-between gap-2">
                    <span class="min-w-0 truncate text-v2-text-text-base">{run.task || "团队任务"}</span>
                    <span class={run.budgetExceeded ? "shrink-0 text-orange-600" : "shrink-0 text-v2-text-text-muted"}>
                      {run.status === "running" ? "运行中" : run.status === "interrupted" ? "已中断" : run.status === "failed" ? "执行失败" : run.budgetExceeded ? "超出预算" : `${(run.tokens ?? 0).toLocaleString()} tokens`}
                    </span>
                  </div>
                  <div class="mt-1 flex flex-wrap gap-1">
                    <For each={run.members ?? []}>
                      {(member) => (
                        <Show
                          when={member.childSessionID}
                          fallback={<span class="rounded border border-v2-border-border-muted px-1.5 py-0.5 text-[10px] text-v2-text-text-muted">{member.name || member.id || "团队成员"} · {member.status === "running" ? "运行中" : member.status === "unknown" ? "状态未知" : member.status === "failed" || member.error ? "失败" : member.status === "completed" ? "完成" : "等待"}</span>}
                        >
                          <button
                            type="button"
                            class="rounded border border-v2-border-border-muted px-1.5 py-0.5 text-[10px] text-v2-text-text-accent hover:bg-v2-background-bg-accent/10"
                            title={`打开 ${member.name || member.id || "团队成员"} 的原生子会话`}
                            onClick={() => openChildSession(member.childSessionID!)}
                          >
                            {member.name || member.id || "子会话"} · {member.status === "running" ? "运行中" : member.status === "unknown" ? "状态未知" : member.status === "failed" || member.error ? "失败" : member.status === "completed" ? "完成" : "子会话"}
                          </button>
                        </Show>
                      )}
                    </For>
                    <Show when={((run.status === "interrupted" && run.resumable) || (run.status === "failed" && run.resume && run.members?.some((member) => member.status === "failed" || member.status === "unknown" || !!member.error))) && run.id}>
                      <Button
                        variant="secondary"
                        size="small"
                        disabled={resumingRunID() !== undefined}
                        title={run.status === "failed" ? "向当前会话发送一个可见的重试请求；Agent 会调用受控的 team-resume-interrupted 工具，只重试失败或未知的顾问。" : "向当前会话发送一个可见的恢复请求；Agent 会调用受控的 team-resume-interrupted 工具。"}
                        onClick={() => void requestAdvisorResume(run.id!, run.status === "failed" ? "retry" : "resume")}
                      >
                        {resumingRunID() === run.id ? "正在请求…" : run.status === "failed" ? "重试失败顾问" : "请求恢复顾问"}
                      </Button>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      <Show when={backgroundJobs().length > 0}>
        <div class="rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-02 p-3">
          <div class="mb-2 flex items-center justify-between gap-2">
            <div class="text-[11px] font-medium uppercase tracking-wide text-v2-text-text-muted">原生后台任务</div>
            <div class="text-[10px] text-v2-text-text-muted">后台任务</div>
          </div>
          <div class="flex flex-col gap-1.5">
            <For each={backgroundJobs().slice(0, 8)}>
              {(job) => (
                <div class="flex items-center justify-between gap-2 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-2 py-1.5 text-[11px]">
                  <span class="min-w-0 truncate text-v2-text-text-base">{job.title || job.id}</span>
                    <span class="flex shrink-0 items-center gap-2">
                      <span class={job.status === "error" ? "text-red-600" : job.status === "running" ? "text-v2-text-text-accent" : "text-v2-text-text-muted"}>
                    {job.metadata?.deveagentRestartState === "interrupted"
                      ? "重启时中断"
                      : job.status === "running"
                        ? "运行中"
                        : job.status === "completed"
                          ? "完成"
                          : job.status === "cancelled"
                            ? "已取消"
                            : "失败"}
                      </span>
                      <Show when={props.sessionID && job.status === "running" && job.metadata?.deveagentTeam}>
                        <Button
                          variant="secondary"
                          size="small"
                          disabled={cancellingJobID() !== undefined}
                          onClick={() => void cancelBackgroundJob(job.id)}
                        >
                          {cancellingJobID() === job.id ? "取消中…" : "取消"}
                        </Button>
                      </Show>
                    </span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      <div class="rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-02 p-3">
        <div class="mb-2 text-[11px] font-medium uppercase tracking-wide text-v2-text-text-muted">运行模式</div>
        <div class="grid grid-cols-3 gap-2">
          <For each={RUN_MODES}>
            {(mode) => (
              <button
                type="button"
                class={`rounded-md border px-2 py-2 text-left text-[12px] transition-colors ${
                  team.snapshot().runMode === mode.id
                    ? "border-v2-border-border-focus bg-v2-background-bg-accent/10 text-v2-text-text-base"
                    : "border-v2-border-border-muted bg-v2-background-bg-base text-v2-text-text-muted"
                }`}
                onClick={() => team.setRunMode(mode.id)}
              >
                <div class="font-medium">{mode.label}</div>
                <div class="mt-0.5 text-[10px] text-v2-text-text-muted">{mode.description}</div>
              </button>
            )}
          </For>
        </div>
        <div class="mt-3 grid grid-cols-2 gap-2 md:grid-cols-5">
          <label class="flex flex-col gap-1">
            <span class="text-[10px] uppercase text-v2-text-text-muted">最大轮次</span>
            <input
              type="number"
              min={1}
              max={10}
              class="h-8 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-2 text-[13px] outline-none"
              value={team.snapshot().maxRounds}
              onChange={(event) => team.setMaxRounds(Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[10px] uppercase text-v2-text-text-muted">子 Agent 限时（秒）</span>
            <input
              type="number"
              min={10}
              max={600}
              step={10}
              class="h-8 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-2 text-[13px] outline-none"
              value={Math.round(team.snapshot().childTimeoutMs / 1000)}
              onChange={(event) => team.setChildTimeoutMs(Number(event.currentTarget.value) * 1000)}
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[10px] uppercase text-v2-text-text-muted">Token 预算</span>
            <input
              type="number"
              min={10_000}
              step={10_000}
              class="h-8 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-2 text-[13px] outline-none"
              value={team.snapshot().budgetTokens}
              onChange={(event) => team.setBudgetTokens(Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[10px] uppercase text-v2-text-text-muted">子 Agent 总输出上限</span>
            <input
              type="number"
              min={1_000}
              max={128_000}
              step={1_000}
              class="h-8 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-2 text-[13px] outline-none"
              value={team.snapshot().childMaxOutputTokens}
              onChange={(event) => team.setChildMaxOutputTokens(Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[10px] uppercase text-v2-text-text-muted">失败重试次数</span>
            <input
              type="number"
              min={0}
              max={3}
              class="h-8 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-2 text-[13px] outline-none"
              value={team.snapshot().maxRetries}
              onChange={(event) => team.setMaxRetries(Number(event.currentTarget.value))}
            />
          </label>
        </div>
      </div>

      <div class="rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-02 p-3">
        <div class="mb-2 text-[11px] font-medium uppercase tracking-wide text-v2-text-text-muted">添加 Agent</div>
        <div class="grid grid-cols-2 gap-2">
          <label class="col-span-2 flex flex-col gap-1">
            <span class="text-[10px] uppercase text-v2-text-text-muted">名称</span>
            <input
              class="h-8 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-2 text-[13px] outline-none"
              placeholder="例如：GLM Planner"
              value={draft().name}
              onInput={(event) => setDraft({ ...draft(), name: event.currentTarget.value })}
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[10px] uppercase text-v2-text-text-muted">角色</span>
            <select
              class="h-8 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-2 text-[13px] outline-none"
              value={draft().role}
              onChange={(event) => setDraft({ ...draft(), role: event.currentTarget.value as DeveAgentTeamRole })}
            >
              <For each={ROLE_KEYS}>
                {(role) => <option value={role}>{TEAM_ROLE_PRESETS[role].label}</option>}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[10px] uppercase text-v2-text-text-muted">Provider</span>
            <select
              class="h-8 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-2 text-[13px] outline-none"
              value={draft().providerID}
              onChange={(event) => setDraft({ ...draft(), providerID: event.currentTarget.value, modelID: "" })}
            >
              <option value="">-- 选择 Provider --</option>
              <For each={providers()}>
                {(provider) => <option value={provider.id}>{provider.name ?? provider.id}</option>}
              </For>
            </select>
          </label>
          <label class="col-span-2 flex flex-col gap-1">
            <span class="text-[10px] uppercase text-v2-text-text-muted">Model</span>
            <select
              class="h-8 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-2 text-[13px] outline-none"
              value={draft().modelID}
              onChange={(event) => setDraft({ ...draft(), modelID: event.currentTarget.value })}
            >
              <option value="">-- 选择 Model --</option>
              <For each={models()}>
                {(model) => <option value={model.id}>{model.name}</option>}
              </For>
            </select>
          </label>
          <label class="col-span-2 flex flex-col gap-1">
            <span class="text-[10px] uppercase text-v2-text-text-muted">
              System Prompt（留空使用角色预设）
            </span>
            <textarea
              rows={2}
              class="rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-2 py-1 text-[12px] outline-none"
              placeholder={TEAM_ROLE_PRESETS[draft().role].systemPrompt}
              value={draft().systemPrompt}
              onInput={(event) => setDraft({ ...draft(), systemPrompt: event.currentTarget.value })}
            />
          </label>
        </div>
        <Button variant="primary" size="normal" class="mt-3 w-full" onClick={addMember}>
          添加成员
        </Button>
      </div>

      <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
        <div class="text-[11px] font-medium uppercase tracking-wide text-v2-text-text-muted">
          团队成员（{team.snapshot().members.length}）
        </div>
        <Show
          when={team.snapshot().members.length > 0}
          fallback={
            <div class="rounded-md border border-dashed border-v2-border-border-muted bg-v2-background-bg-base p-4 text-center text-[12px] text-v2-text-text-muted">
              还没有成员。至少添加两个（Planner + Executor）才能开始多 agent 协作。
            </div>
          }
        >
          <For each={team.snapshot().members}>
            {(member: DeveAgentTeamMember) => (
              <div class="rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-02 p-3">
                <div class="flex items-center gap-2">
                  <span class="rounded bg-v2-background-bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-v2-text-text-accent">
                    {TEAM_ROLE_PRESETS[member.role].label.split(" ")[0]}
                  </span>
                  <div class="min-w-0 flex-1 truncate font-medium text-v2-text-text-base">{member.name}</div>
                  <button
                    type="button"
                    class="text-[11px] text-v2-text-text-muted hover:text-v2-text-text-base"
                    onClick={() => setExpandedID(expandedID() === member.id ? undefined : member.id)}
                  >
                    {expandedID() === member.id ? "收起" : "详情"}
                  </button>
                  <button
                    type="button"
                    class={`text-[11px] ${member.enabled ? "text-green-600" : "text-v2-text-text-muted"} hover:text-v2-text-text-base`}
                    onClick={() => team.updateMember(member.id, { enabled: !member.enabled })}
                  >
                    {member.enabled ? "启用" : "已禁用"}
                  </button>
                  <button
                    type="button"
                    class="text-[11px] text-red-500 hover:text-red-600"
                    onClick={() => team.removeMember(member.id)}
                    title="移除该 agent"
                  >
                    <Icon name="trash" size="small" />
                  </button>
                </div>
                <div class="mt-1 text-[10px] text-v2-text-text-muted">
                  {member.providerID} · {member.modelID}
                </div>
                <Show when={expandedID() === member.id}>
                  <div class="mt-2 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base p-2 text-[11px] leading-4 text-v2-text-text-muted">
                    <div class="mb-1 font-semibold text-v2-text-text-base">System Prompt</div>
                    {member.systemPrompt || TEAM_ROLE_PRESETS[member.role].systemPrompt}
                  </div>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </div>

      <div class="border-t border-v2-border-border-muted pt-2 text-[10px] leading-4 text-v2-text-text-muted">
        提示：后端协作引擎读取本快照，通过 POST /api/deveagent/team 同步。
        顾问始终只读；首个 Executor 在汇总后走原生权限确认。预算按真实用量停止后续派发并告警，不能替代 provider 的硬 token 上限。
      </div>
    </div>
  )
}

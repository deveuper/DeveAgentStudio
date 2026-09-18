import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { useServerSDK } from "@/context/server-sdk"
import { createLowPowerInterval } from "@/context/low-power"
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
// Run-mode labels/descriptions are built inside the component so they follow
// the active locale (same pattern as deveagent-mcp-market.tsx).

export function DeveagentTeamPanel(props: { sessionID?: string; directorySlug?: string }) {
  const language = useLanguage()
  const runModes = (): { id: DeveAgentTeamRunMode; label: string; description: string }[] => [
    { id: "sequential", label: language.t("deveagent.team.modeSequential"), description: language.t("deveagent.team.modeSequentialHint") },
    { id: "parallel", label: language.t("deveagent.team.modeParallel"), description: language.t("deveagent.team.modeParallelHint") },
    { id: "debate", label: language.t("deveagent.team.modeDebate"), description: language.t("deveagent.team.modeDebateHint") },
  ]
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
      if (!response.ok) throw new Error(payload.error || language.t("deveagent.team.cancelFailed", { status: response.status }))
      showToast({ variant: "success", title: language.t("deveagent.team.taskCancelled"), description: language.t("deveagent.team.taskCancelledDescription") })
      await refreshBackgroundJobs()
      await refreshRuns()
    } catch (error) {
      showToast({ variant: "error", title: language.t("deveagent.team.taskNotCancelled"), description: error instanceof Error ? error.message : language.t("deveagent.team.cancelApiUnavailable") })
    } finally {
      setCancellingJobID(undefined)
    }
  }

  onMount(() => {
    void refreshRuns()
    void refreshBackgroundJobs()
  })
  createLowPowerInterval(() => {
    void refreshRuns()
    void refreshBackgroundJobs()
  }, 5_000)

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
      showToast({ variant: "error", title: language.t("deveagent.team.missingProviderOrModel"), description: language.t("deveagent.team.configureProviderFirst") })
      return
    }
    const preset = TEAM_ROLE_PRESETS[draft().role]
    team.addMember({
      name: draft().name.trim() || language.t(preset.labelKey),
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
      showToast({ variant: "error", title: language.t("deveagent.team.cannotOpenChildSession"), description: language.t("deveagent.team.notInProjectSession") })
      return
    }
    navigate(`/${props.directorySlug}/session/${sessionID}`)
  }

  const requestAdvisorResume = async (runID: string, mode: "resume" | "retry") => {
    if (!props.sessionID) {
      showToast({ variant: "error", title: language.t("deveagent.team.cannotResume"), description: language.t("deveagent.team.openMatchingSessionFirst") })
      return
    }
    if (!/^[a-zA-Z0-9._-]{1,120}$/.test(runID)) {
      showToast({ variant: "error", title: language.t("deveagent.team.cannotResume"), description: language.t("deveagent.team.invalidRunId") })
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
        title: mode === "retry" ? language.t("deveagent.team.advisorRetryRequested") : language.t("deveagent.team.advisorRecoveryRequested"),
        description: language.t(mode === "retry" ? "deveagent.team.retryRequestSent" : "deveagent.team.recoveryRequestSent"),
      })
      window.setTimeout(() => void refreshRuns(), 1_000)
    } catch (error) {
      showToast({ variant: "error", title: language.t("deveagent.team.recoveryRequestNotSent"), description: error instanceof Error ? error.message : language.t("deveagent.team.recoveryRequestFailed") })
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
      showToast({ variant: "success", title: language.t("deveagent.team.taskStarted"), description: language.t("deveagent.team.taskStartedDescription") })
      await refreshRuns()
      await refreshBackgroundJobs()
    } catch (error) {
      showToast({ variant: "error", title: language.t("deveagent.team.taskNotStarted"), description: error instanceof Error ? error.message : "Team runtime unavailable" })
    } finally {
      setDispatching(false)
    }
  }

  return (
    <div
      class="flex h-full min-h-0 flex-col gap-3 overflow-y-scroll overscroll-contain bg-v2-background-bg-base p-3 pr-2 text-[13px] text-v2-text-text-base [scrollbar-color:var(--v2-border-border-muted)_transparent] [scrollbar-gutter:stable] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-v2-border-border-muted hover:[&::-webkit-scrollbar-thumb]:bg-v2-border-border-focus"
      data-component="deveagent-team-panel-scroll"
    >
      <div class="rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-02 p-3">
        <div class="flex items-center justify-between gap-3">
          <div class="text-[12px] font-semibold text-v2-text-text-base">{language.t("deveagent.team.title")}</div>
          <Button
            variant={team.snapshot().enabled ? "primary" : "secondary"}
            size="small"
            onClick={() => team.setEnabled(!team.snapshot().enabled)}
          >
            {team.snapshot().enabled ? language.t("deveagent.team.moaEnabled") : language.t("deveagent.team.enableMoa")}
          </Button>
        </div>
        <div class="mt-1 text-[11px] leading-5 text-v2-text-text-muted">
          {language.t("deveagent.team.subtitle")}
        </div>
      </div>

      <div class="grid grid-cols-3 gap-2 rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-02 p-3 text-[11px]">
        <div><div class="text-v2-text-text-muted">{language.t("deveagent.team.tokensRecorded")}</div><div class="mt-1 font-semibold">{usage().tokens.toLocaleString()}</div></div>
        <div><div class="text-v2-text-text-muted">{language.t("deveagent.team.costRecorded")}</div><div class="mt-1 font-semibold">{usage().cost.toFixed(4)}</div></div>
        <div><div class="text-v2-text-text-muted">{language.t("deveagent.team.failedAdvisors")}</div><div class="mt-1 font-semibold">{usage().failures}</div></div>
      </div>

      <Show when={props.sessionID}>
        <div class="rounded-lg border border-v2-border-border-focus/30 bg-v2-background-bg-layer-02 p-3">
          <div class="text-[11px] font-semibold text-v2-text-text-base">{language.t("deveagent.team.directDispatch")}</div>
          <div class="mt-1 text-[11px] leading-5 text-v2-text-text-muted">{language.t("deveagent.team.directDispatchHint")}</div>
          <textarea
            class="mt-2 min-h-16 w-full resize-y rounded-md border border-v2-border-border-muted bg-v2-background-bg-base p-2 text-[12px] outline-none focus:border-v2-border-border-focus"
            value={dispatchTask()}
            onInput={(event) => setDispatchTask(event.currentTarget.value)}
            placeholder={language.t("deveagent.team.taskPlaceholder")}
            disabled={dispatching()}
          />
          <div class="mt-2 flex justify-end">
            <Button variant="primary" size="small" disabled={dispatching() || !dispatchTask().trim()} onClick={() => void dispatchTeamDirect()}>
              {dispatching() ? language.t("deveagent.team.runningPlaceholder") : language.t("deveagent.team.startTask")}
            </Button>
          </div>
        </div>
      </Show>

      <Show when={runs().length > 0}>
        <div class="rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-02 p-3">
          <div class="mb-2 text-[11px] font-medium uppercase tracking-wide text-v2-text-text-muted">{language.t("deveagent.team.recentRuns")}</div>
          <div class="flex flex-col gap-2">
            <For each={runs().slice(0, 3)}>
              {(run) => (
                <div class="rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-2 py-1.5 text-[11px]">
                  <div class="flex items-center justify-between gap-2">
                    <span class="min-w-0 truncate text-v2-text-text-base">{run.task || language.t("deveagent.team.taskLabel")}</span>
                    <span class={run.budgetExceeded ? "shrink-0 text-orange-600" : "shrink-0 text-v2-text-text-muted"}>
                      {run.status === "running" ? language.t("deveagent.team.statusRunning") : run.status === "interrupted" ? language.t("deveagent.team.statusInterrupted") : run.status === "failed" ? language.t("deveagent.team.statusFailed") : run.budgetExceeded ? language.t("deveagent.team.statusOverBudget") : `${(run.tokens ?? 0).toLocaleString()} tokens`}
                    </span>
                  </div>
                  <div class="mt-1 flex flex-wrap gap-1">
                    <For each={run.members ?? []}>
                      {(member) => (
                        <Show
                          when={member.childSessionID}
                          fallback={<span class="rounded border border-v2-border-border-muted px-1.5 py-0.5 text-[10px] text-v2-text-text-muted">{member.name || member.id || language.t("deveagent.team.memberLabel")} · {member.status === "running" ? language.t("deveagent.team.statusRunning") : member.status === "unknown" ? language.t("deveagent.team.statusUnknown") : member.status === "failed" || member.error ? language.t("deveagent.team.statusFailed") : member.status === "completed" ? language.t("deveagent.team.statusDone") : language.t("deveagent.team.statusPending")}</span>}
                        >
                          <button
                            type="button"
                            class="rounded border border-v2-border-border-muted px-1.5 py-0.5 text-[10px] text-v2-text-text-accent hover:bg-v2-background-bg-accent/10"
                            title={language.t("deveagent.team.openChildSessionTitle", { name: member.name || member.id || language.t("deveagent.team.memberLabel") })}
                            onClick={() => openChildSession(member.childSessionID!)}
                          >
                            {member.name || member.id || language.t("deveagent.team.childSession")} · {member.status === "running" ? language.t("deveagent.team.statusRunning") : member.status === "unknown" ? language.t("deveagent.team.statusUnknown") : member.status === "failed" || member.error ? language.t("deveagent.team.statusFailed") : member.status === "completed" ? language.t("deveagent.team.statusDone") : language.t("deveagent.team.childSession")}
                          </button>
                        </Show>
                      )}
                    </For>
                    <Show when={((run.status === "interrupted" && run.resumable) || (run.status === "failed" && run.resume && run.members?.some((member) => member.status === "failed" || member.status === "unknown" || !!member.error))) && run.id}>
                      <Button
                        variant="secondary"
                        size="small"
                        disabled={resumingRunID() !== undefined}
                        title={run.status === "failed" ? language.t("deveagent.team.retryHint") : language.t("deveagent.team.recoveryHint")}
                        onClick={() => void requestAdvisorResume(run.id!, run.status === "failed" ? "retry" : "resume")}
                      >
                        {resumingRunID() === run.id ? language.t("deveagent.team.requesting") : run.status === "failed" ? language.t("deveagent.team.retryFailedAdvisors") : language.t("deveagent.team.requestRecovery")}
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
            <div class="text-[11px] font-medium uppercase tracking-wide text-v2-text-text-muted">{language.t("deveagent.team.nativeBackgroundJobs")}</div>
            <div class="text-[10px] text-v2-text-text-muted">{language.t("deveagent.team.backgroundJobs")}</div>
          </div>
          <div class="flex flex-col gap-1.5">
            <For each={backgroundJobs().slice(0, 8)}>
              {(job) => (
                <div class="flex items-center justify-between gap-2 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-2 py-1.5 text-[11px]">
                  <span class="min-w-0 truncate text-v2-text-text-base">{job.title || job.id}</span>
                    <span class="flex shrink-0 items-center gap-2">
                      <span class={job.status === "error" ? "text-red-600" : job.status === "running" ? "text-v2-text-text-accent" : "text-v2-text-text-muted"}>
                    {job.metadata?.deveagentRestartState === "interrupted"
                      ? language.t("deveagent.team.interruptedOnRestart")
                      : job.status === "running"
                        ? language.t("deveagent.team.statusRunning")
                        : job.status === "completed"
                          ? language.t("deveagent.team.statusDone")
                          : job.status === "cancelled"
                            ? language.t("deveagent.team.statusCancelled")
                            : language.t("deveagent.team.statusFailed")}
                      </span>
                      <Show when={props.sessionID && job.status === "running" && job.metadata?.deveagentTeam}>
                        <Button
                          variant="secondary"
                          size="small"
                          disabled={cancellingJobID() !== undefined}
                          onClick={() => void cancelBackgroundJob(job.id)}
                        >
                          {cancellingJobID() === job.id ? language.t("deveagent.team.cancelling") : language.t("deveagent.team.cancel")}
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
        <div class="mb-2 text-[11px] font-medium uppercase tracking-wide text-v2-text-text-muted">{language.t("deveagent.team.runMode")}</div>
        <div class="grid grid-cols-3 gap-2">
          <For each={runModes()}>
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
            <span class="text-[10px] uppercase text-v2-text-text-muted">{language.t("deveagent.team.maxRounds")}</span>
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
            <span class="text-[10px] uppercase text-v2-text-text-muted">{language.t("deveagent.team.subagentTimeout")}</span>
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
            <span class="text-[10px] uppercase text-v2-text-text-muted">{language.t("deveagent.team.tokenBudget")}</span>
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
            <span class="text-[10px] uppercase text-v2-text-text-muted">{language.t("deveagent.team.subagentOutputCap")}</span>
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
            <span class="text-[10px] uppercase text-v2-text-text-muted">{language.t("deveagent.team.failureRetries")}</span>
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
        <div class="mb-2 text-[11px] font-medium uppercase tracking-wide text-v2-text-text-muted">{language.t("deveagent.team.addAgent")}</div>
        <div class="grid grid-cols-2 gap-2">
          <label class="col-span-2 flex flex-col gap-1">
            <span class="text-[10px] uppercase text-v2-text-text-muted">{language.t("deveagent.team.fieldName")}</span>
            <input
              class="h-8 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-2 text-[13px] outline-none"
              placeholder={language.t("deveagent.team.namePlaceholder")}
              value={draft().name}
              onInput={(event) => setDraft({ ...draft(), name: event.currentTarget.value })}
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[10px] uppercase text-v2-text-text-muted">{language.t("deveagent.team.fieldRole")}</span>
            <select
              class="h-8 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-2 text-[13px] outline-none"
              value={draft().role}
              onChange={(event) => setDraft({ ...draft(), role: event.currentTarget.value as DeveAgentTeamRole })}
            >
              <For each={ROLE_KEYS}>
                {(role) => <option value={role}>{language.t(TEAM_ROLE_PRESETS[role].labelKey)}</option>}
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
              <option value="">{language.t("deveagent.team.selectProvider")}</option>
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
              <option value="">{language.t("deveagent.team.selectModel")}</option>
              <For each={models()}>
                {(model) => <option value={model.id}>{model.name}</option>}
              </For>
            </select>
          </label>
          <label class="col-span-2 flex flex-col gap-1">
            <span class="text-[10px] uppercase text-v2-text-text-muted">
              {language.t("deveagent.team.systemPrompt")}
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
          {language.t("deveagent.team.addMember")}
        </Button>
      </div>

      <div class="flex flex-col gap-2">
        <div class="text-[11px] font-medium uppercase tracking-wide text-v2-text-text-muted">
          {language.t("deveagent.team.membersCount", { count: team.snapshot().members.length })}
        </div>
        <Show
          when={team.snapshot().members.length > 0}
          fallback={
            <div class="rounded-md border border-dashed border-v2-border-border-muted bg-v2-background-bg-base p-4 text-center text-[12px] text-v2-text-text-muted">
              {language.t("deveagent.team.noMembers", { planner: language.t("deveagent.team.role.planner"), executor: language.t("deveagent.team.role.executor") })}
            </div>
          }
        >
          <For each={team.snapshot().members}>
            {(member: DeveAgentTeamMember) => (
              <div class="rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-02 p-3">
                <div class="flex items-center gap-2">
                  <span class="rounded bg-v2-background-bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-v2-text-text-accent">
                    {language.t(TEAM_ROLE_PRESETS[member.role].labelKey)}
                  </span>
                  <div class="min-w-0 flex-1 truncate font-medium text-v2-text-text-base">{member.name}</div>
                  <button
                    type="button"
                    class="text-[11px] text-v2-text-text-muted hover:text-v2-text-text-base"
                    onClick={() => setExpandedID(expandedID() === member.id ? undefined : member.id)}
                  >
                    {expandedID() === member.id ? language.t("deveagent.team.collapse") : language.t("deveagent.team.details")}
                  </button>
                  <button
                    type="button"
                    class={`text-[11px] ${member.enabled ? "text-green-600" : "text-v2-text-text-muted"} hover:text-v2-text-text-base`}
                    onClick={() => team.updateMember(member.id, { enabled: !member.enabled })}
                  >
                    {member.enabled ? language.t("deveagent.team.enabled") : language.t("deveagent.team.disabled")}
                  </button>
                  <button
                    type="button"
                    class="text-[11px] text-red-500 hover:text-red-600"
                    onClick={() => team.removeMember(member.id)}
                    title={language.t("deveagent.team.removeAgent")}
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
        {language.t("deveagent.team.footnote")}
      </div>
    </div>
  )
}

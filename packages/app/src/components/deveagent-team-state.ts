import { createSignal } from "solid-js"
import type { ServerFetch } from "@/utils/server"

// DeveAgent Team v1
// =================
// Persistent user-defined multi-agent team. Each team member is one distinct
// role bound to a provider+model. The orchestration engine (real parallel
// fibers + inter-agent messaging + verifier loop) is implemented on the
// backend against this snapshot; this module owns the UI-facing state.

export type DeveAgentTeamRole =
  | "planner"
  | "executor"
  | "reviewer"
  | "researcher"
  | "critic"
  | "verifier"
  | "custom"

export type DeveAgentTeamMember = {
  id: string
  name: string
  role: DeveAgentTeamRole
  providerID: string
  modelID: string
  systemPrompt?: string
  enabled: boolean
}

export type DeveAgentTeamRunMode = "sequential" | "parallel" | "debate"

export type DeveAgentTeamSnapshot = {
  enabled: boolean
  members: DeveAgentTeamMember[]
  runMode: DeveAgentTeamRunMode
  maxRounds: number
  budgetTokens: number
  childTimeoutMs: number
  childMaxOutputTokens: number
  maxRetries: number
}

const DEFAULT_TEAM: DeveAgentTeamSnapshot = {
  enabled: false,
  members: [],
  runMode: "sequential",
  maxRounds: 3,
  budgetTokens: 200_000,
  childTimeoutMs: 120_000,
  childMaxOutputTokens: 32_000,
  maxRetries: 1,
}

function randomID() {
  return `agent-${Math.random().toString(36).slice(2, 10)}`
}

// Called from the DeveAgentTeamPanel component body, so the signals below live
// in the component's reactive root and are auto-disposed on unmount.
export function createDeveAgentTeamState(sessionID?: string) {
  const [snapshot, setSnapshot] = createSignal<DeveAgentTeamSnapshot>(DEFAULT_TEAM)

  return {
    snapshot,
    addMember(input: Omit<DeveAgentTeamMember, "id"> & { id?: string }): DeveAgentTeamMember {
      const member: DeveAgentTeamMember = {
        id: input.id ?? randomID(),
        name: input.name.trim() || "New Agent",
        role: input.role,
        providerID: input.providerID,
        modelID: input.modelID,
        systemPrompt: input.systemPrompt,
        enabled: input.enabled ?? true,
      }
      const next = { ...snapshot(), members: [...snapshot().members, member] }
      setSnapshot(next)
      void syncTeam(next)
      return member
    },
    updateMember(id: string, patch: Partial<Omit<DeveAgentTeamMember, "id">>) {
      const next = {
        ...snapshot(),
        members: snapshot().members.map((member) => (member.id === id ? { ...member, ...patch } : member)),
      }
      setSnapshot(next)
      void syncTeam(next)
    },
    removeMember(id: string) {
      const next = { ...snapshot(), members: snapshot().members.filter((member) => member.id !== id) }
      setSnapshot(next)
      void syncTeam(next)
    },
    setRunMode(runMode: DeveAgentTeamRunMode) {
      const next = { ...snapshot(), runMode }
      setSnapshot(next)
      void syncTeam(next)
    },
    setEnabled(enabled: boolean) {
      const next = { ...snapshot(), enabled }
      setSnapshot(next)
      void syncTeam(next)
    },
    setMaxRounds(maxRounds: number) {
      const next = { ...snapshot(), maxRounds: Math.max(1, Math.min(10, Math.floor(maxRounds))) }
      setSnapshot(next)
      void syncTeam(next)
    },
    setBudgetTokens(budgetTokens: number) {
      const next = { ...snapshot(), budgetTokens: Math.max(10_000, Math.floor(budgetTokens)) }
      setSnapshot(next)
      void syncTeam(next)
    },
    setChildTimeoutMs(childTimeoutMs: number) {
      const next = { ...snapshot(), childTimeoutMs: Math.max(10_000, Math.min(600_000, Math.floor(childTimeoutMs))) }
      setSnapshot(next)
      void syncTeam(next)
    },
    setChildMaxOutputTokens(childMaxOutputTokens: number) {
      const next = { ...snapshot(), childMaxOutputTokens: Math.max(1_000, Math.min(128_000, Math.floor(childMaxOutputTokens))) }
      setSnapshot(next)
      void syncTeam(next)
    },
    setMaxRetries(maxRetries: number) {
      const next = { ...snapshot(), maxRetries: Math.max(0, Math.min(3, Math.floor(maxRetries))) }
      setSnapshot(next)
      void syncTeam(next)
    },
    reset() {
      setSnapshot(DEFAULT_TEAM)
      void syncTeam(DEFAULT_TEAM)
    },
  }

  async function syncTeam(next: DeveAgentTeamSnapshot = snapshot()) {
    if (typeof window === "undefined") return
    const base = ((window as unknown as { __deveagentBaseUrl?: string }).__deveagentBaseUrl ?? "").replace(/\/+$/, "")
    const suffix = sessionID ? `?sessionID=${encodeURIComponent(sessionID)}` : ""
    const url = base ? `${base}/api/deveagent/team${suffix}` : `/api/deveagent/team${suffix}`
    try {
      const request = (window as typeof window & { __deveagentFetch?: ServerFetch }).__deveagentFetch ?? fetch
      await request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sessionID ? { ...next, sessionID } : next),
      })
    } catch {
      // UI state remains authoritative if the backend is not yet ready.
    }
  }

  async function hydrateTeam() {
    if (typeof window === "undefined") return
    const base = ((window as unknown as { __deveagentBaseUrl?: string }).__deveagentBaseUrl ?? "").replace(/\/+$/, "")
    const suffix = sessionID ? `?sessionID=${encodeURIComponent(sessionID)}` : ""
    const url = base ? `${base}/api/deveagent/team${suffix}` : `/api/deveagent/team${suffix}`
    try {
      const request = (window as typeof window & { __deveagentFetch?: ServerFetch }).__deveagentFetch ?? fetch
      const response = await request(url)
      if (!response.ok) return
      const value = (await response.json()) as Partial<DeveAgentTeamSnapshot>
      if (!Array.isArray(value.members) || typeof value.enabled !== "boolean") return
      setSnapshot({
        enabled: value.enabled,
        members: value.members,
        runMode: value.runMode === "parallel" || value.runMode === "debate" ? value.runMode : "sequential",
        maxRounds: typeof value.maxRounds === "number" ? value.maxRounds : DEFAULT_TEAM.maxRounds,
        budgetTokens: typeof value.budgetTokens === "number" ? value.budgetTokens : DEFAULT_TEAM.budgetTokens,
        childTimeoutMs: typeof value.childTimeoutMs === "number" ? value.childTimeoutMs : DEFAULT_TEAM.childTimeoutMs,
        childMaxOutputTokens: typeof value.childMaxOutputTokens === "number" ? value.childMaxOutputTokens : DEFAULT_TEAM.childMaxOutputTokens,
        maxRetries: typeof value.maxRetries === "number" ? value.maxRetries : DEFAULT_TEAM.maxRetries,
      })
    } catch {
      // Keep the local default when the OpenCode server is unavailable.
    }
  }

  void hydrateTeam()
}

export const TEAM_ROLE_PRESETS: Record<DeveAgentTeamRole, { label: string; systemPrompt: string }> = {
  planner: {
    label: "Planner 计划者",
    systemPrompt:
      "You are the Planner in a multi-agent team. Decompose the task into concrete, verifiable steps. Do NOT edit files directly.",
  },
  executor: {
    label: "Executor 执行者",
    systemPrompt:
      "You are the Executor. You are the only role allowed to edit files. Follow the Planner's steps and record each change.",
  },
  reviewer: {
    label: "Reviewer 审查者",
    systemPrompt:
      "You are the Reviewer. Read the Executor's diff and flag regressions, missing tests, or unsafe writes.",
  },
  researcher: {
    label: "Researcher 调研者",
    systemPrompt: "You are the Researcher. Gather context, docs, and prior art. Return sources; do not write files.",
  },
  critic: {
    label: "Critic 挑刺者",
    systemPrompt:
      "You are the Critic. Adopt an adversarial view and try to find the strongest counter-arguments to the current plan.",
  },
  verifier: {
    label: "Verifier 验证者",
    systemPrompt:
      "You are the Verifier. Check whether success criteria are truly met before the loop can stop. Do NOT write files.",
  },
  custom: {
    label: "Custom 自定义",
    systemPrompt: "",
  },
}

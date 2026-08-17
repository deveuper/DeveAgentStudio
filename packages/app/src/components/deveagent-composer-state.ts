import { createRoot, createSignal } from "solid-js"
import type { ServerFetch } from "@/utils/server"

export type DeveAgentMode = "compose" | "craft" | "ask" | "plan" | "build" | "goal" | "loop"
export type DeveAgentPermissionMode = "default" | "auto" | "yolo"
export type DeveAgentToolExecution = "sequential" | "parallel"
export type DeveAgentSkillRisk = "trusted" | "review" | "untrusted"

export type DeveAgentSkillRef = {
  id: string
  name: string
  source: string
  installed: boolean
  enabled: boolean
  risk: DeveAgentSkillRisk
  desc?: string
  url?: string
  pros?: string
  cons?: string
  whenToUse?: string
}

export type DeveAgentExpertRef = {
  id: string
  name: string
  role?: string
}

export type DeveAgentWorkPack = {
  id: string
  name: string
  description: string
  mode: DeveAgentMode
  toolExecution?: DeveAgentToolExecution
  skillIDs: string[]
  // Default role for this pack. Role routing (role -> configured model via
  // roleProfiles) applies only when the user has configured that role; without
  // a profile the role is carried on the message and routing falls back to the
  // default model.
  role?: string
}

export type DeveAgentComposerSnapshot = {
  mode: DeveAgentMode
  permissionMode: DeveAgentPermissionMode
  toolExecution: DeveAgentToolExecution
  tokenSaver: boolean
  remoteSkills: boolean
  remoteMcp: boolean
  unattendedTimezone: string
  selectedSkills: DeveAgentSkillRef[]
  selectedExpert?: DeveAgentExpertRef
  expertTeam: DeveAgentExpertRef[]
  role?: string
}

export const DEVEAGENT_BUILTIN_SKILLS: DeveAgentSkillRef[] = [
  {
    id: "token-saver",
    name: "Token Saver",
    source: "builtin:reasonix/token-saver",
    installed: true,
    enabled: true,
    risk: "trusted",
    desc: "真实的 v1 上下文压缩：>1500 tokens 的文件保留头 200 行 + 尾 80 行，中间以稳定 marker 替换。",
    pros: "真实降低 tokens；稳定 marker 有利于 KV cache 复用；透明可测。",
    cons: "对超长中段代码可能丢关键上下文；需要显式打开。",
    whenToUse: "默认开启。处理超大文件、多文件 pack、跑 Goal loop 时都保留。",
  },
  {
    id: "headroom",
    name: "Headroom",
    source: "builtin:opencode/headroom",
    installed: true,
    enabled: false,
    risk: "trusted",
    desc: "在长编辑之前预留上下文预算，防止 context window 溢出。",
    pros: "避免模型在最后一步 OOM；对超长 Craft/Build 任务稳定性提升明显。",
    cons: "会主动裁掉一些旧对话；对短任务是浪费。",
    whenToUse: "只在超长会话（>50 轮）或 Compose/Build 长任务时开启。",
  },
  {
    id: "context-mode",
    name: "Context Mode",
    source: "builtin:opencode/context-mode",
    installed: true,
    enabled: false,
    risk: "trusted",
    desc: "选择 compact/balanced/expanded 三档 context pack 策略。",
    pros: "根据任务大小调节上下文体积；简单任务用 compact 更快更便宜。",
    cons: "需要用户手动判断档位；容易和 Token Saver 冲突。",
    whenToUse: "只想手动控制上下文粒度、且不希望自动压缩时开启。",
  },
  {
    id: "tool-result-optimizer",
    name: "Tool Result Optimizer",
    source: "builtin:rtk/tool-result-optimizer",
    installed: true,
    enabled: false,
    risk: "trusted",
    desc: "对工具输出（bash、read、grep）做摘要，只保留可行动区间。",
    pros: "针对 shell/grep/日志输出很显著；避免噪声挤占 context。",
    cons: "会隐藏原始输出；需要用户理解摘要边界。",
    whenToUse: "运行大量 shell/grep/日志类工具、输出经常上千行时开启。",
  },
  {
    id: "rtk-caveman",
    name: "RTK Caveman",
    source: "builtin:rtk/caveman",
    installed: true,
    enabled: false,
    risk: "trusted",
    desc: "优先选简单、健壮的实现路径；抑制过度抽象。",
    pros: "对 MVP、原型、bug 修复任务效果好；输出更聚焦。",
    cons: "复杂架构任务里会显得幼稚；不适合 refactor。",
    whenToUse: "写小 fix、原型 demo、教学示例时开启；重构/大项目请关掉。",
  },
  {
    id: "codegraph-context",
    name: "CodeGraph Context",
    source: "builtin:codegraph/context-pack",
    installed: true,
    enabled: false,
    risk: "trusted",
    desc: "根据任务打包相关文件 + diff + 符号上下文再交给模型。",
    pros: "找上下文更准；避免让模型自己 grep。",
    cons: "首轮延迟增加；需要工作区有效索引。",
    whenToUse: "任务描述涉及多个陌生文件/符号时开启；纯问答不需要。",
  },
  {
    id: "code-review",
    name: "Code Review",
    source: "builtin:opencode/review",
    installed: true,
    enabled: false,
    risk: "trusted",
    desc: "对 diff 做 regression / 危险写入 / 测试缺失的审查。",
    pros: "在合并前拦截明显问题；发现遗漏的验证步骤。",
    cons: "增加一轮 LLM 调用；对小改动不划算。",
    whenToUse: "生成 PR、准备 commit、修复关键路径时开启。",
  },
  {
    id: "goal-verifier",
    name: "Goal Verifier",
    source: "builtin:mimo/goal",
    installed: true,
    enabled: false,
    risk: "trusted",
    desc: "Goal 模式下自动校验成功条件，避免过早停止。",
    pros: "让自主执行不容易撒谎；带真实通过标准。",
    cons: "只在 Goal/Loop 模式有意义；其他模式空转。",
    whenToUse: "使用 Goal 模式跑长时间任务时开启。",
  },
  {
    id: "computer-use",
    name: "Computer Use",
    source: "builtin:codex/computer-use",
    installed: true,
    enabled: false,
    risk: "review",
    desc: "使用受权限保护的截图、浏览器和受限桌面动作；原始 shell 执行禁用。",
    pros: "可以做 UI 验收、爬取动态页面、跑图形化步骤。",
    cons: "不支持任意 shell、任意脚本或窗口外坐标；每次动作仍受宿主权限控制。",
    whenToUse: "需要视觉 UI 验证且宿主已注入 tool 时开启，否则请关闭。",
  },
  {
    id: "superpowers",
    name: "Superpowers",
    source: "builtin:codex/superpowers",
    installed: true,
    enabled: false,
    risk: "review",
    desc: "加载 debugging/review/planning/TDD 等技能包并注入到 system prompt。",
    pros: "复用成熟工作流；对陌生领域有引导作用。",
    cons: "增加 system prompt 长度；与 Token Saver 有轻微冲突。",
    whenToUse: "遇到 debug/planning/TDD 明确阶段时开启；日常闲聊关掉。",
  },
  {
    id: "grill-me",
    name: "Grilling Me",
    source: "builtin:deveagent/grilling",
    installed: true,
    enabled: false,
    risk: "trusted",
    desc: "在实现前逐项追问未决决策；每轮只问一个问题，并附推荐答案。",
    pros: "提前暴露模糊需求、隐含假设和取舍；适合架构、产品和长任务启动前。",
    cons: "会延后编码；简单修复和明确任务不需要开启。",
    whenToUse: "需要压力测试方案、梳理需求或避免 AI 自行补全关键决策时开启。",
  },
  {
    id: "prompt-optimizer",
    name: "Prompt Optimizer",
    source: "builtin:deveagent/prompt-optimizer",
    installed: true,
    enabled: false,
    risk: "trusted",
    desc: "在执行前整理目标、约束和验收标准，同时保持用户原意与原始输入不变。",
    pros: "减少含糊任务造成的返工；不额外发起模型请求或产生隐藏费用。",
    cons: "明确的简单任务收益较小；不会替用户补造缺失需求。",
    whenToUse: "需求较长、混合多个目标，或希望先形成清晰任务简报时开启。",
  },
  {
    id: "markitdown",
    name: "MarkItDown",
    source: "builtin:microsoft/markitdown",
    installed: true,
    enabled: true,
    risk: "trusted",
    desc: "附件进入上下文前优先转换为缓存 Markdown，减少模型直接读取二进制文档的开销。",
    pros: "统一文档上下文；支持缓存复用；转换失败会透明回退。",
    cons: "转换会产生少量本地缓存；不支持的格式仍会回退到原始附件路径。",
    whenToUse: "默认开启；上传 DOCX/XLSX/PDF/HTML/CSV 等支持格式时生效。",
  },
]

export const DEVEAGENT_WORK_PACKS: DeveAgentWorkPack[] = [
  {
    id: "coding",
    name: "Coding",
    description: "代码图、审查、测试工作流和长上下文控制。",
    mode: "build",
    role: "coder",
    skillIDs: ["token-saver", "headroom", "tool-result-optimizer", "codegraph-context", "code-review", "superpowers", "markitdown"],
  },
  {
    id: "web-ui",
    name: "Web & UI",
    description: "前端实现、视觉验收和浏览器交互。",
    mode: "build",
    role: "coder",
    skillIDs: ["token-saver", "code-review", "computer-use", "superpowers", "markitdown"],
  },
  {
    id: "gamedev",
    name: "GameDev",
    description: "多文件工程、测试审查和图形界面验收基础能力。",
    mode: "build",
    role: "coder",
    skillIDs: ["token-saver", "headroom", "codegraph-context", "code-review", "superpowers", "computer-use"],
  },
  {
    id: "office-research",
    name: "Office & Research",
    description: "文档先转 Markdown，再做结构化分析和决策追问。",
    mode: "craft",
    role: "planner",
    skillIDs: ["token-saver", "markitdown", "context-mode", "grill-me", "prompt-optimizer"],
  },
  {
    id: "writing",
    name: "Writing & Novel",
    description: "长文本上下文、需求追问和文档输入基础能力。",
    mode: "craft",
    role: "planner",
    skillIDs: ["token-saver", "headroom", "context-mode", "grill-me", "prompt-optimizer", "markitdown"],
  },
  {
    id: "automation-qa",
    name: "Automation & QA",
    description: "并行只读规划、浏览器操作、日志裁剪和代码审查。",
    mode: "plan",
    toolExecution: "parallel",
    role: "verifier",
    skillIDs: ["token-saver", "tool-result-optimizer", "computer-use", "code-review", "superpowers"],
  },
  {
    id: "data-analysis",
    name: "Data & Analysis",
    description: "文档/表格先转 Markdown，再做结构化分析与结论追问。",
    mode: "craft",
    role: "planner",
    skillIDs: ["token-saver", "markitdown", "context-mode", "grill-me", "codegraph-context"],
  },
  {
    id: "security-review",
    name: "Security Review",
    description: "代码图影响面、审查工作流、只读规划与漏洞验证。",
    mode: "plan",
    toolExecution: "parallel",
    role: "reviewer",
    skillIDs: ["token-saver", "code-review", "codegraph-context", "superpowers", "computer-use"],
  },
  {
    id: "devops",
    name: "DevOps & Ops",
    description: "日志/文档处理、浏览器操作与自动化排障工作流。",
    mode: "build",
    role: "coder",
    skillIDs: ["token-saver", "tool-result-optimizer", "computer-use", "markitdown", "code-review"],
  },
  {
    id: "ai-agent",
    name: "AI Agent Dev",
    description: "多 Agent 编排、Goal/验证循环与长任务上下文控制。",
    mode: "goal",
    role: "planner",
    skillIDs: ["token-saver", "goal-verifier", "codegraph-context", "code-review", "superpowers", "computer-use"],
  },
]

const defaults: DeveAgentComposerSnapshot = {
  mode: "craft",
  // The product's requested unattended default. The backend still applies
  // its hard safety denials for dangerous targets and read-only modes.
  permissionMode: "yolo",
  toolExecution: "sequential",
  tokenSaver: true,
  remoteSkills: true,
  remoteMcp: true,
  unattendedTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  selectedSkills: DEVEAGENT_BUILTIN_SKILLS.filter((skill) => skill.enabled),
  selectedExpert: undefined,
  expertTeam: [],
  role: undefined,
}

// Role ids are lowercase kebab, bounded like the backend role-profile keys
// (max 32 chars: 1 leading lowercase letter + up to 31 [a-z0-9-]).
function sanitizeRole(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const role = value.trim()
  return /^[a-z][a-z0-9-]{0,31}$/.test(role) ? role : undefined
}

export function mergeDeveAgentComposerSnapshot(
  previous: DeveAgentComposerSnapshot,
  remote: Partial<DeveAgentComposerSnapshot>,
): DeveAgentComposerSnapshot {
  const mode = ["compose", "craft", "ask", "plan", "build", "goal", "loop"].includes(remote.mode ?? "")
    ? remote.mode as DeveAgentMode
    : previous.mode
  const selectedSkills = Array.isArray(remote.selectedSkills)
    ? remote.selectedSkills
        .filter((skill) => skill && typeof skill.id === "string" && typeof skill.name === "string")
        .map((skill) => normalizeDeveAgentSkill(skill))
        // `selectedSkills` is the Composer's active runtime list. Installed but
        // disabled catalog entries stay in the picker until the user enables one.
        .filter((skill) => skill.enabled)
    : previous.selectedSkills
  return {
    ...previous,
    mode,
    permissionMode: remote.permissionMode === "auto" || remote.permissionMode === "yolo" || remote.permissionMode === "default" ? remote.permissionMode : previous.permissionMode,
    toolExecution: remote.toolExecution === "parallel" && (mode === "ask" || mode === "plan") ? "parallel" : "sequential",
    tokenSaver: typeof remote.tokenSaver === "boolean" ? remote.tokenSaver : previous.tokenSaver,
    remoteSkills: typeof remote.remoteSkills === "boolean" ? remote.remoteSkills : previous.remoteSkills,
    remoteMcp: typeof remote.remoteMcp === "boolean" ? remote.remoteMcp : previous.remoteMcp,
    unattendedTimezone: sanitizeTimezone(remote.unattendedTimezone ?? previous.unattendedTimezone),
    selectedSkills,
    // Mirror the backend normalize semantics: an omitted role keeps the local
    // one (sibling-field symmetry); an explicit null/值 clears or sanitizes.
    role: remote.role === undefined ? previous.role : sanitizeRole(remote.role),
  }
}

export function applyDeveAgentWorkPackSnapshot(
  previous: DeveAgentComposerSnapshot,
  pack: DeveAgentWorkPack,
): DeveAgentComposerSnapshot {
  const builtin = new Set(pack.skillIDs)
  const selectedSkills = [
    ...DEVEAGENT_BUILTIN_SKILLS.filter((skill) => builtin.has(skill.id)).map((skill) => ({ ...skill, enabled: true })),
    ...previous.selectedSkills.filter((skill) => !skill.source.startsWith("builtin:")),
  ].filter((skill, index, list) => list.findIndex((item) => item.id === skill.id) === index)

  return {
    ...previous,
    mode: pack.mode,
    permissionMode: previous.permissionMode,
    toolExecution:
      pack.toolExecution === "parallel" && (pack.mode === "ask" || pack.mode === "plan")
        ? "parallel"
        : "sequential",
    tokenSaver: true,
    // A pack either sets its default role or clears a previously applied one
    // so switching packs never leaves a stale role routed.
    role: sanitizeRole(pack.role),
    selectedSkills: previous.remoteSkills
      ? selectedSkills
      : selectedSkills.filter((skill) => !isRemoteSkillSource(skill.source)),
  }
}

const state = createRoot(() => {
  const [snapshot, setSnapshot] = createSignal<DeveAgentComposerSnapshot>(defaults)
  let hydratedBase = ""
  let localVersion = 0
  let syncedVersion = 0
  let syncing: Promise<void> | undefined

  const updateSnapshot = (updater: (previous: DeveAgentComposerSnapshot) => DeveAgentComposerSnapshot) => {
    localVersion += 1
    setSnapshot(updater)
    void syncServer()
  }

  return {
    snapshot,
    async hydrate() {
      if (typeof window === "undefined") return
      const target = window as typeof window & { __deveagentBaseUrl?: string; __deveagentFetch?: ServerFetch }
      const base = target.__deveagentBaseUrl?.replace(/\/+$/, "") ?? ""
      if (!base || hydratedBase === base) return
      hydratedBase = base
      const hydrateVersion = localVersion
      try {
        const response = await (target.__deveagentFetch ?? fetch)(`${base}/api/deveagent/state`)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const remote = (await response.json()) as Partial<DeveAgentComposerSnapshot>
        // A delayed initial GET must not overwrite a user choice made while it was in flight.
        if (hydrateVersion === localVersion) setSnapshot((previous) => mergeDeveAgentComposerSnapshot(previous, remote))
      } catch {
        hydratedBase = ""
      }
    },
    setMode(mode: DeveAgentMode) {
      updateSnapshot((prev) => ({
        ...prev,
        mode,
        // ponytail: parallel only safe in ask/plan
        toolExecution: mode === "ask" || mode === "plan" ? prev.toolExecution : "sequential",
      }))
    },
    setToolExecution(toolExecution: DeveAgentToolExecution) {
      updateSnapshot((prev) => ({
        ...prev,
        toolExecution:
          toolExecution === "parallel" && (prev.mode === "ask" || prev.mode === "plan")
            ? "parallel"
            : "sequential",
      }))
    },
    setPermissionMode(permissionMode: DeveAgentPermissionMode) {
      updateSnapshot((prev) => ({ ...prev, permissionMode }))
    },
    setTokenSaver(tokenSaver: boolean) {
      updateSnapshot((prev) => ({ ...prev, tokenSaver }))
    },
    setRemoteSkills(remoteSkills: boolean) {
      updateSnapshot((prev) => ({
        ...prev,
        remoteSkills,
        selectedSkills: remoteSkills ? prev.selectedSkills : prev.selectedSkills.filter((skill) => !isRemoteSkillSource(skill.source)),
      }))
    },
    setRemoteMcp(remoteMcp: boolean) {
      updateSnapshot((prev) => ({ ...prev, remoteMcp }))
    },
    setUnattendedTimezone(unattendedTimezone: string) {
      updateSnapshot((prev) => ({ ...prev, unattendedTimezone: sanitizeTimezone(unattendedTimezone) }))
    },
    setRole(role?: string) {
      updateSnapshot((prev) => ({ ...prev, role: sanitizeRole(role) }))
    },
    setSelectedSkills(selectedSkills: DeveAgentSkillRef[]) {
      updateSnapshot((prev) => ({
        ...prev,
        selectedSkills: prev.remoteSkills ? selectedSkills : selectedSkills.filter((skill) => !isRemoteSkillSource(skill.source)),
      }))
    },
    applyWorkPack(id: string) {
      const pack = DEVEAGENT_WORK_PACKS.find((item) => item.id === id)
      if (!pack) return
      updateSnapshot((prev) => applyDeveAgentWorkPackSnapshot(prev, pack))
    },
    setSelectedExpert(selectedExpert?: DeveAgentExpertRef) {
      updateSnapshot((prev) => ({ ...prev, selectedExpert, expertTeam: selectedExpert ? [selectedExpert] : [] }))
    },
    clearSelectedExpert() {
      updateSnapshot((prev) => ({ ...prev, selectedExpert: undefined, expertTeam: [] }))
    },
    reset() {
      updateSnapshot(() => defaults)
    },
    flush() {
      return syncServer()
    },
  }

  async function syncServer() {
    if (!syncing) {
      syncing = (async () => {
        do {
          const version = localVersion
          // role: null is an explicit clear — JSON.stringify drops undefined
          // keys, and the backend would otherwise preserve the previous role.
          const body = JSON.stringify({ ...snapshot(), role: snapshot().role ?? null })
          try {
            const base = (typeof window !== "undefined" && (window as any).__deveagentBaseUrl) || ""
            const url = base ? `${String(base).replace(/\/+$/, "")}/api/deveagent/state` : "/api/deveagent/state"
            const request = (window as typeof window & { __deveagentFetch?: ServerFetch }).__deveagentFetch ?? fetch
            await request(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body,
            })
          } catch {
            // The UI state remains authoritative for rendering if the sidecar is not ready.
          }
          syncedVersion = version
        } while (syncedVersion < localVersion)
      })().finally(() => {
        syncing = undefined
      })
    }

    const current = syncing
    await current
    if (syncedVersion < localVersion) return syncServer()
  }
})

export function useDeveAgentComposerState() {
  return state
}

export function setDeveAgentBaseUrl(url: string | undefined, request?: ServerFetch) {
  if (typeof window === "undefined") return
  const target = window as typeof window & { __deveagentBaseUrl?: string; __deveagentFetch?: ServerFetch }
  target.__deveagentBaseUrl = url ?? ""
  target.__deveagentFetch = request
  void state.hydrate()
}

export function normalizeDeveAgentSkill(input: Partial<DeveAgentSkillRef> & { id: string; name: string }): DeveAgentSkillRef {
  return {
    id: input.id,
    name: input.name,
    source: input.source ?? "local",
    installed: input.installed ?? true,
    enabled: input.enabled ?? true,
    risk: input.risk ?? "trusted",
    desc: input.desc,
    url: input.url,
  }
}

export function isRemoteSkillSource(source: string | undefined) {
  if (!source) return false
  return source.startsWith("remote:") || source.startsWith("github:") || source.startsWith("skillhub.") || source === "clawhub" || source.startsWith("clawhub.") || source.startsWith("http")
}

export function sanitizeTimezone(value: string | undefined) {
  const timezone = value?.trim()
  if (!timezone) return "UTC"
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date())
    return timezone
  } catch {
    return "UTC"
  }
}

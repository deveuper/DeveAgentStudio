import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@/utils/toast"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { usePlatform } from "@/context/platform"
import { DeveagentMcpMarket } from "@/components/deveagent-mcp-market"
import { skillStoreSaveError } from "@/components/deveagent-skillstore-state"
import {
  DEVEAGENT_BUILTIN_SKILLS,
  isRemoteSkillSource,
  normalizeDeveAgentSkill,
  type DeveAgentSkillRef,
  useDeveAgentComposerState,
} from "@/components/deveagent-composer-state"

const LOCAL_SKILLS: DeveAgentSkillRef[] = [
  ...DEVEAGENT_BUILTIN_SKILLS,
  { id: "planner", name: "Planner", desc: "Decompose tasks into safe implementation plans", source: "local", installed: true, enabled: true, risk: "trusted" },
  { id: "security-review", name: "Security Review", desc: "Audit unsafe patterns and permissions", source: "local", installed: true, enabled: true, risk: "trusted" },
]

const MARKET_SKILLS: DeveAgentSkillRef[] = [
  { id: "anthropic-skills", name: "Anthropic Official Skills", desc: "github.com/anthropics/skills", source: "github:anthropics/skills", url: "https://github.com/anthropics/skills", installed: false, enabled: false, risk: "trusted" },
  { id: "mimo-skills", name: "MiMo Skills", desc: "github.com/XiaomiMiMo/MiMo-Skills", source: "github:XiaomiMiMo/MiMo-Skills", url: "https://github.com/XiaomiMiMo/MiMo-Skills", installed: false, enabled: false, risk: "trusted" },
  { id: "superpowers", name: "Superpowers", desc: "github.com/obra/superpowers", source: "github:obra/superpowers", url: "https://github.com/obra/superpowers", installed: false, enabled: false, risk: "review" },
  { id: "tencent-skillhub", name: "Tencent SkillHub", desc: "skillhub.cn / skillhub.cloud.tencent.com", source: "skillhub.tencent", url: "https://skillhub.cloud.tencent.com/skills/find-skills", installed: false, enabled: false, risk: "trusted" },
  { id: "opencode-skillful", name: "OpenCode Skillful", desc: "github.com/zenobi-us/opencode-skillful", source: "github:zenobi-us/opencode-skillful", url: "https://github.com/zenobi-us/opencode-skillful", installed: false, enabled: false, risk: "review" },
  { id: "awesome-agent-skills", name: "Awesome Agent Skills", desc: "github.com/VoltAgent/awesome-agent-skills", source: "github:VoltAgent/awesome-agent-skills", url: "https://github.com/VoltAgent/awesome-agent-skills", installed: false, enabled: false, risk: "review" },
  { id: "awesome-openclaw-skills", name: "Awesome OpenClaw Skills", desc: "github.com/VoltAgent/awesome-openclaw-skills", source: "github:VoltAgent/awesome-openclaw-skills", url: "https://github.com/VoltAgent/awesome-openclaw-skills", installed: false, enabled: false, risk: "review" },
  { id: "clawhub", name: "ClawHub / OpenClaw Sources", desc: "ClawHub/OpenClaw source index", source: "clawhub.ai", url: "https://clawhub.ai/", installed: false, enabled: false, risk: "untrusted" },
]

const MARKET_SOURCE_OPTIONS = [
  { id: "anthropics/skills", label: "Anthropic" },
  { id: "XiaomiMiMo/MiMo-Skills", label: "MiMo" },
  { id: "obra/superpowers", label: "Superpowers" },
  { id: "zenobi-us/opencode-skillful", label: "OpenCode" },
  { id: "VoltAgent/awesome-agent-skills", label: "Awesome Agent" },
  { id: "skillhub.cn", label: "Tencent SkillHub" },
  { id: "clawhub.ai", label: "ClawHub" },
] as const

const MARKET_SOURCE_STORAGE_KEY = "deveagent.skill-market.sources.v1"

function marketSourceStorageKey(directory: string) {
  return `${MARKET_SOURCE_STORAGE_KEY}:${encodeURIComponent(directory)}`
}

function readMarketSources(key: string) {
  try {
    const stored = JSON.parse(localStorage.getItem(key) || "null")
    if (Array.isArray(stored)) {
      const valid = stored.filter((value): value is string => typeof value === "string" && MARKET_SOURCE_OPTIONS.some((source) => source.id === value))
      if (valid.length > 0) return valid
    }
  } catch {
    // Keep the default when storage is unavailable or corrupt.
  }
  return undefined
}

const riskLabel = (risk: DeveAgentSkillRef["risk"]) =>
  risk === "trusted" ? "可信" : risk === "review" ? "需注意" : "不可信"

type SkillStoreTab = "installed" | "local" | "market" | "mcp" | "sources"

type MarketSkill = {
  id: string
  name: string
  description: string
  source: string
  risk: DeveAgentSkillRef["risk"]
  url: string
}

type MarketSkillSource = {
  source: string
  status: "ready" | "unavailable"
  error?: string
}

type MarketSkillResponse = {
  entries: MarketSkill[]
  sources: MarketSkillSource[]
}

const STORE_TABS: { id: SkillStoreTab; label: string }[] = [
  { id: "market", label: "市场" },
  { id: "installed", label: "已安装" },
  { id: "local", label: "本地" },
  { id: "mcp", label: "MCP 市场" },
  { id: "sources", label: "来源" },
]

export function DeveagentSkillStore(props: { initialTab?: Extract<SkillStoreTab, "market" | "mcp"> }) {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const platform = usePlatform()
  const composer = useDeveAgentComposerState()
  const [activeTab, setActiveTab] = createSignal<SkillStoreTab>(props.initialTab ?? "market")
  createEffect(() => {
    if (props.initialTab) setActiveTab(props.initialTab)
  })
  onMount(() => {
    const handleTab = (event: Event) => {
      const value = (event as CustomEvent).detail
      if (value === "installed" || value === "local" || value === "market" || value === "mcp" || value === "sources") setActiveTab(value)
    }
    window.addEventListener("deveagent:skillstore-tab", handleTab)
    onCleanup(() => window.removeEventListener("deveagent:skillstore-tab", handleTab))
  })
  const [query, setQuery] = createSignal("")
  const [marketSource, setMarketSource] = createSignal("all")
  const [enabledMarketSources, setEnabledMarketSources] = createSignal<string[]>(
    readMarketSources(MARKET_SOURCE_STORAGE_KEY) ?? MARKET_SOURCE_OPTIONS.map((source) => source.id),
  )
  const [marketPreferenceState, setMarketPreferenceState] = createSignal<"loading" | "workspace" | "fallback" | "error">("fallback")
  let hydratedDirectory = ""
  const [persistedMarketDirectory, setPersistedMarketDirectory] = createSignal("")
  let marketPreferenceRequest = 0
  createEffect(() => {
    const directory = sdk().directory
    if (!directory) {
      setMarketPreferenceState("fallback")
      return
    }
    if (hydratedDirectory === directory) return
    hydratedDirectory = directory
    const requestID = ++marketPreferenceRequest
    setMarketPreferenceState("loading")
    setPersistedMarketDirectory("")
    setEnabledMarketSources(
      readMarketSources(marketSourceStorageKey(directory)) ??
        readMarketSources(MARKET_SOURCE_STORAGE_KEY) ??
        MARKET_SOURCE_OPTIONS.map((source) => source.id),
    )
    void serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/skill/market-sources?directory=${encodeURIComponent(directory)}`)
      .then(async (response) => (response.ok ? (await response.json()) as { enabledRepositories?: unknown } : undefined))
      .then((preferences) => {
        if (requestID !== marketPreferenceRequest || sdk().directory !== directory) return
        const enabled = Array.isArray(preferences?.enabledRepositories)
          ? preferences.enabledRepositories.filter((value): value is string => typeof value === "string" && MARKET_SOURCE_OPTIONS.some((source) => source.id === value))
          : []
        if (enabled.length > 0) setEnabledMarketSources([...new Set(enabled)])
        setPersistedMarketDirectory(directory)
        setMarketPreferenceState("workspace")
      })
      .catch(() => {
        if (requestID !== marketPreferenceRequest || sdk().directory !== directory) return
        setMarketPreferenceState("error")
      })
  })
  createEffect(() => {
    const directory = sdk().directory
    if (!directory || hydratedDirectory !== directory || persistedMarketDirectory() !== directory) return
    try {
      localStorage.setItem(marketSourceStorageKey(directory), JSON.stringify(enabledMarketSources()))
    } catch {
      // The market remains usable in restricted renderer storage environments.
    }
    void serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/skill/market-sources`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory, enabledRepositories: enabledMarketSources() }),
    }).catch(() => undefined)
  })
  const [marketSkills, { refetch: refetchMarketSkills }] = createResource(
    () => activeTab() === "market" ? { base: serverSDK().url, query: query().trim(), sources: enabledMarketSources().slice().sort().join(",") } : undefined,
    async (input): Promise<MarketSkillResponse> => {
      const response = await serverSDK().fetch(`${input.base.replace(/\/+$/, "")}/api/deveagent/skill/market?q=${encodeURIComponent(input.query)}&sources=${encodeURIComponent(input.sources)}`)
      if (!response.ok) return { entries: [], sources: [] }
      const payload = await response.json()
      if (Array.isArray(payload)) return { entries: payload as MarketSkill[], sources: [] }
      return payload && Array.isArray(payload.entries) && Array.isArray(payload.sources)
        ? payload as MarketSkillResponse
        : { entries: [], sources: [] }
    },
  )
  const marketEntries = createMemo(() => marketSkills()?.entries ?? [])
  const marketSources = createMemo(() => [...new Set(marketEntries().map((skill) => skill.source).filter(Boolean))].sort())
  const marketSourceStatus = createMemo(() => marketSkills()?.sources ?? [])
  const sourceStatus = (repository: string) => marketSourceStatus().find((item) => item.source.includes(repository))
  const visibleMarketSkills = createMemo(() => {
    const source = marketSource()
    const enabled = enabledMarketSources()
    return (source === "all" ? marketEntries() : marketEntries().filter((skill) => skill.source === source)).filter((skill) => enabled.some((repository) => skill.source.includes(repository)))
  })
  createEffect(() => {
    if (marketSource() !== "all" && !marketSources().includes(marketSource())) setMarketSource("all")
  })

  const [installed] = createResource<DeveAgentSkillRef[], string>(
    () => sdk().directory,
    async (directory) => {
      void directory
      const result = await sdk().client.app.skills()
      return (result.data ?? []).map((skill: { name: string; description?: string; location?: string }) =>
        normalizeDeveAgentSkill({
          id: skill.name,
          name: skill.name,
          desc: skill.description,
          source: skill.location,
          installed: true,
          enabled: true,
          risk: "trusted",
        }),
      )
    },
  )
  const [remoteInstalled, { refetch: refetchRemoteInstalled }] = createResource<DeveAgentSkillRef[], { base: string; directory: string }>(
    () => ({ base: serverSDK().url, directory: sdk().directory }),
    async (input) => {
      const response = await serverSDK().fetch(`${input.base.replace(/\/+$/, "")}/api/deveagent/skill/list-remote?directory=${encodeURIComponent(input.directory)}`)
      if (!response.ok) return []
      const skills = (await response.json()) as { id?: string; name?: string; path?: string }[]
      return skills
        .filter((skill): skill is { id: string; name: string; path?: string } => !!skill.id && !!skill.name)
        .map((skill) =>
          normalizeDeveAgentSkill({
            id: skill.id,
            name: skill.name,
            desc: skill.path ? `已安装的远程 Skill: ${skill.path}` : "已安装的远程 Skill",
            source: `remote:${skill.id}`,
            installed: true,
            enabled: false,
            risk: "review",
          }),
        )
    },
  )
  const [markitdownStatus] = createResource<{ available: boolean; command?: string; error?: string }, string>(
    () => serverSDK().url,
    async (base) => {
      const response = await serverSDK().fetch(`${base.replace(/\/+$/, "")}/api/deveagent/markitdown/status`)
      if (!response.ok) return { available: false, error: `HTTP ${response.status}` }
      return (await response.json()) as { available: boolean; command?: string; error?: string }
    },
  )
  const [remoteSkillUrl, setRemoteSkillUrl] = createSignal("")
  const [remoteSkillID, setRemoteSkillID] = createSignal("")
  const [installingRemote, setInstallingRemote] = createSignal(false)
  // Custom skill editor state: null = closed, "new" = creating, otherwise editing existing id
  const [editingSkill, setEditingSkill] = createSignal<string | "new" | null>(null)
  const [skillFormName, setSkillFormName] = createSignal("")
  const [skillFormDesc, setSkillFormDesc] = createSignal("")
  const [skillFormContent, setSkillFormContent] = createSignal("")
  const localSkillContents: Record<string, string> = {}

  const [localCustom, { refetch: refetchLocal }] = createResource<DeveAgentSkillRef[], string>(
    () => serverSDK().url,
    async (base): Promise<DeveAgentSkillRef[]> => {
      try {
        const response = await serverSDK().fetch(`${base.replace(/\/+$/, "")}/api/deveagent/skill/list-local`)
        if (!response.ok) return []
        const text = await response.text()
        if (!text) return []
        const skills = JSON.parse(text) as { id?: string; name?: string; description?: string; prompt?: string }[]
        return skills
          .filter((skill): skill is { id: string; name: string; description?: string; prompt?: string } => !!skill.id && !!skill.name)
          .map((skill) => {
            localSkillContents[skill.id] = skill.prompt ?? ""
            return normalizeDeveAgentSkill({
              id: skill.id,
              name: skill.name,
              desc: skill.description || "用户自定义 Skill",
              source: `local:${skill.id}`,
              installed: true,
              enabled: false,
              risk: "trusted",
            })
          })
      } catch {
        return []
      }
    },
  )

  const openNewSkill = () => {
    setSkillFormName("")
    setSkillFormDesc("")
    setSkillFormContent("")
    setEditingSkill("new")
  }

  const saveSkillForm = async () => {
    const name = skillFormName().trim()
    if (!name) {
      showToast({ title: "需要名称", description: "请为 Skill 填写一个名称。" })
      return
    }
    const editing = editingSkill()
    const payload = {
      ...(editing !== "new" && editing ? { id: editing } : {}),
      name,
      description: skillFormDesc().trim(),
      content: skillFormContent(),
    }
    try {
      const response = await serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/skill/save-local`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
      const result = (await response.json().catch(() => ({}))) as { error?: string; id?: string }
      const saveError = skillStoreSaveError(response, result)
      if (saveError) {
        showToast({ variant: "error", title: "保存失败", description: saveError })
        return
      }
      showToast({ title: "已保存 Skill", description: `${name} 已保存，可在列表中勾选加载到会话。` })
      setEditingSkill(null)
      refetchLocal()
    } catch (error) {
      showToast({
        variant: "error",
        title: "保存失败",
        description: error instanceof Error ? error.message : "无法连接到 Skill Store 服务。",
      })
    }
  }

  const deleteLocalSkill = async (id: string) => {
    await serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/skill/remove-local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => undefined)
    showToast({ title: "已删除 Skill", description: "自定义 Skill 已移除。" })
    publish(selected().filter((item) => item.id !== id))
    refetchLocal()
  }

  const selected = createMemo(() => composer.snapshot().selectedSkills)
  const remoteSkills = createMemo(() => composer.snapshot().remoteSkills)
  const remoteMcp = createMemo(() => composer.snapshot().remoteMcp)
  const selectedIds = createMemo(() => new Set(selected().map((skill) => skill.id)))
  const remoteInstalledByID = createMemo(() => new Map((remoteInstalled() ?? []).map((skill) => [skill.id, skill])))
  const visible = createMemo(() => {
    const customItems = localCustom() ?? []
    const installedItems = [...(installed() ?? []), ...(remoteInstalled() ?? []), ...customItems].filter(
      (skill, index, all) => all.findIndex((item) => item.id === skill.id && item.source === skill.source) === index,
    )
    const base =
      activeTab() === "installed"
        ? installedItems && installedItems.length > 0
          ? installedItems
          : LOCAL_SKILLS
        : activeTab() === "local"
          ? [...customItems, ...LOCAL_SKILLS]
          : activeTab() === "market"
            ? MARKET_SKILLS
            : [...customItems, ...LOCAL_SKILLS, ...MARKET_SKILLS]
    const q = query().trim().toLowerCase()
    if (!q) return base
    return base.filter((skill) => `${skill.name} ${skill.desc ?? ""} ${skill.source} ${skill.url ?? ""}`.toLowerCase().includes(q))
  })

  const publish = (items: DeveAgentSkillRef[]) => {
    composer.setSelectedSkills(items)
    window.dispatchEvent(new CustomEvent("deveagent:skills-change", { detail: items }))
  }

  const installRemoteSkill = async (marketSkill?: MarketSkill) => {
    const url = marketSkill?.url ?? remoteSkillUrl().trim()
    if (!remoteSkills()) {
      showToast({
        title: "远程 Skill 已关闭",
        description: "先开启远程 Skill，才允许从市场或 Markdown 链接安装。",
      })
      return
    }
    if (marketSkill && !enabledMarketSources().some((repository) => marketSkill.source.includes(repository))) {
      showToast({ title: "市场来源未启用", description: "先勾选该来源，才能安装其中的 Skill。" })
      return
    }
    if (marketSkill?.risk === "untrusted" && !window.confirm(`ClawHub / OpenClaw 来源未受信任。安装 ${marketSkill.name} 前请确认你已检查其内容。`)) return
    if (!url || installingRemote()) return
    setInstallingRemote(true)
    try {
      const response = await serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/skill/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, id: marketSkill?.id ?? (remoteSkillID().trim() || undefined), directory: sdk().directory }),
      })
      const result = (await response.json().catch(() => ({}))) as { id?: string; savedPath?: string; error?: string }
      if (!response.ok || result.error || !result.id) throw new Error(result.error || `HTTP ${response.status}`)
      const installedSkill = normalizeDeveAgentSkill({
        id: result.id,
        name: marketSkill?.name ?? result.id,
        desc: marketSkill ? `已安装: ${marketSkill.source}` : `已安装的远程 Skill: ${result.savedPath ?? ""}`,
        source: `remote:${result.id}`,
        installed: true,
        enabled: true,
        risk: marketSkill?.risk ?? "review",
      })
      composer.setRemoteSkills(true)
      publish(selectedIds().has(installedSkill.id) ? selected() : [...selected(), installedSkill])
      setRemoteSkillUrl("")
      setRemoteSkillID("")
      await refetchRemoteInstalled()
      showToast({ title: "已安装并加载 Skill", description: `${marketSkill?.name ?? result.id} 已写入本地远程 Skill 目录，并加入当前会话。` })
    } catch (error) {
      showToast({ variant: "error", title: "Skill 安装失败", description: error instanceof Error ? error.message : "请求失败" })
    } finally {
      setInstallingRemote(false)
    }
  }

  const removeRemoteSkill = async (id: string) => {
    const response = await serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/skill/remove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, directory: sdk().directory }),
    })
    const result = (await response.json().catch(() => ({}))) as { removed?: boolean }
    if (!response.ok || !result.removed) {
      showToast({ variant: "error", title: "无法移除 Skill", description: id })
      return
    }
    publish(selected().filter((item) => item.id !== id))
    await refetchRemoteInstalled()
    showToast({ title: "已移除远程 Skill", description: id })
  }

  const toggleSkill = (skill: DeveAgentSkillRef) => {
    if (!remoteSkills() && isRemoteSkillSource(skill.source)) {
      showToast({
        title: "远程 Skill 已关闭",
        description: "打开上方“远程 Skill”后，才能加载 GitHub / SkillHub / ClawHub 来源。",
      })
      return
    }
    if (!skill.installed) {
      showToast({ title: "这是来源目录", description: "请先安装具体的 SKILL.md；来源目录本身不会注入当前会话。" })
      return
    }
    const next = selectedIds().has(skill.id)
      ? selected().filter((item) => item.id !== skill.id)
      : [...selected(), { ...skill, enabled: true }]
    publish(next)
  }

  const openSource = (skill: DeveAgentSkillRef) => {
    if (!skill.url) {
      showToast({ title: "没有来源链接", description: `${skill.name} 只提供本地来源信息。` })
      return
    }
    try {
      platform.openLink(skill.url)
    } catch {
      showToast({ variant: "error", title: "无法打开来源", description: skill.url })
    }
  }

  return (
    <div class="flex h-full min-h-0 flex-col gap-3 bg-v2-background-bg-base p-3 text-[13px] text-v2-text-text-base">
      <div class="rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-02 p-2">
        <div class="mb-2 text-[11px] font-medium uppercase tracking-wide text-v2-text-text-muted">外部能力开关</div>
        <div class="grid grid-cols-2 gap-2">
          <button
            type="button"
            class={`rounded-md border px-2 py-2 text-left text-[12px] transition-colors ${
              remoteSkills()
                ? "border-v2-border-border-focus bg-v2-background-bg-accent/10 text-v2-text-text-base"
                : "border-v2-border-border-muted bg-v2-background-bg-base text-v2-text-text-muted"
            }`}
            onClick={() => composer.setRemoteSkills(!remoteSkills())}
          >
            <div class="font-medium">远程 Skill</div>
            <div class="mt-0.5 text-[10px] text-v2-text-text-muted">{remoteSkills() ? "GitHub / SkillHub 可加载" : "只允许本地/内置"}</div>
          </button>
          <button
            type="button"
            class={`rounded-md border px-2 py-2 text-left text-[12px] transition-colors ${
              remoteMcp()
                ? "border-v2-border-border-focus bg-v2-background-bg-accent/10 text-v2-text-text-base"
                : "border-v2-border-border-muted bg-v2-background-bg-base text-v2-text-text-muted"
            }`}
            onClick={() => composer.setRemoteMcp(!remoteMcp())}
          >
            <div class="font-medium">远程 MCP</div>
            <div class="mt-0.5 text-[10px] text-v2-text-text-muted">{remoteMcp() ? "允许 App/连接器" : "仅本地 MCP"}</div>
          </button>
        </div>
      </div>

      <div class={`rounded-md border px-2 py-1.5 text-[11px] ${markitdownStatus()?.available ? "border-green-500/30 text-green-700" : "border-amber-500/30 text-amber-700"}`}>
        MarkItDown: {markitdownStatus.loading ? "检测中" : markitdownStatus()?.available ? `可用 (${markitdownStatus()?.command})` : "不可用，自动转换会拒绝读取原始附件"}
      </div>

      <input
        hidden={activeTab() === "mcp"}
        class="h-9 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-3 text-[13px] outline-none"
        value={query()}
        placeholder="搜索技能、本地或远程来源"
        onInput={(event) => setQuery(event.currentTarget.value)}
      />

      <div class="flex items-center gap-1">
        {STORE_TABS.map((tab) => (
          <button
            type="button"
            data-action={`skill-store-tab-${tab.id}`}
            class={`px-3 py-1.5 rounded text-[12px] transition-colors ${
              activeTab() === tab.id ? "bg-v2-background-bg-accent text-white" : "bg-v2-background-bg-layer-02 text-v2-text-text-muted hover:text-v2-text-text-base"
            }`}
            onClick={() => {
              setActiveTab(tab.id)
              if (tab.id === "installed") void refetchRemoteInstalled()
            }}
          >
            {tab.label}
          </button>
        ))}
        <div class="flex-1" />
        <Show when={activeTab() !== "mcp"}>
          <button
            type="button"
            class="rounded bg-v2-background-bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90"
            onClick={openNewSkill}
          >
            + 新建 Skill
          </button>
        </Show>
      </div>

      <Show when={activeTab() === "market"}>
        <div class="flex flex-col gap-2 rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-02 p-3">
          <div class="flex items-center gap-2">
            <div class="flex-1 text-[12px] font-medium text-v2-text-text-base">市场 Skill</div>
            <span
              class={`rounded px-1.5 py-0.5 text-[9px] ${marketPreferenceState() === "workspace" ? "bg-green-500/10 text-green-700" : marketPreferenceState() === "loading" ? "bg-amber-500/10 text-amber-800" : "bg-surface-raised-base text-v2-text-text-muted"}`}
              title={sdk().directory || "未选择工作区"}
            >
              {marketPreferenceState() === "workspace" ? "项目已保存" : marketPreferenceState() === "loading" ? "正在读取项目设置" : marketPreferenceState() === "error" ? "项目设置不可用，使用本地回退" : "本地回退"}
            </span>
            <Button size="small" variant="ghost" onClick={() => void refetchMarketSkills()}>刷新</Button>
          </div>
          <div class="text-[11px] leading-4 text-v2-text-text-muted">搜索框会直接检索已批准 GitHub 来源中的具体 `SKILL.md`，点击安装后会写入本地并加入当前会话。腾讯等没有稳定公开安装 API 的来源仍只显示在“来源”页。</div>
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-2 py-1.5" role="group" aria-label="启用 Skill 市场来源">
            <span class="text-[10px] text-v2-text-text-muted">启用来源</span>
            <For each={MARKET_SOURCE_OPTIONS}>
              {(source) => (
                <label class="flex items-center gap-1 text-[10px] text-v2-text-text-base" title={sourceStatus(source.id)?.error || source.label}>
                  <input
                    type="checkbox"
                    checked={enabledMarketSources().includes(source.id)}
                    disabled={sourceStatus(source.id)?.status === "unavailable"}
                    onChange={(event) => {
                      const current = enabledMarketSources()
                      setEnabledMarketSources(event.currentTarget.checked ? [...new Set([...current, source.id])] : current.filter((id) => id !== source.id))
                    }}
                  />
                  {source.label}
                  <Show when={sourceStatus(source.id)?.status === "unavailable"}>
                    <span class="text-amber-700">不可用</span>
                  </Show>
                </label>
              )}
            </For>
          </div>
          <Show when={marketSources().length > 1}>
            <div class="flex flex-wrap gap-1" role="group" aria-label="Skill 市场来源">
              <button
                type="button"
                class={`rounded border px-2 py-1 text-[10px] ${marketSource() === "all" ? "border-v2-border-border-focus bg-v2-background-bg-accent/10 text-v2-text-text-accent" : "border-v2-border-border-muted text-v2-text-text-muted hover:bg-surface-raised-base"}`}
                data-action="skill-market-source-all"
                aria-pressed={marketSource() === "all"}
                onClick={() => setMarketSource("all")}
              >
                全部来源
              </button>
              <For each={marketSources()}>
                {(source) => (
                  <button
                    type="button"
                    class={`rounded border px-2 py-1 text-[10px] ${marketSource() === source ? "border-v2-border-border-focus bg-v2-background-bg-accent/10 text-v2-text-text-accent" : "border-v2-border-border-muted text-v2-text-text-muted hover:bg-surface-raised-base"}`}
                    data-action={`skill-market-source-${source}`}
                    aria-pressed={marketSource() === source}
                    onClick={() => setMarketSource(source)}
                  >
                    {source}
                  </button>
                )}
              </For>
            </div>
          </Show>
          <Show when={marketSkills.loading}><div class="text-[11px] text-v2-text-text-muted">正在检索市场...</div></Show>
          <Show when={marketSkills.error}><div class="text-[11px] text-red-600">市场读取失败，请稍后重试。</div></Show>
          <Show when={(marketSkills()?.sources ?? []).length > 0}>
            <div class="flex flex-wrap gap-1" aria-label="Skill 市场来源状态">
              <For each={marketSkills()?.sources ?? []}>
                {(source) => (
                  <span
                    class={`rounded px-1.5 py-0.5 text-[9px] ${source.status === "ready" ? "bg-green-500/10 text-green-700" : "bg-amber-500/10 text-amber-800"}`}
                    title={source.error || source.source}
                  >
                    {source.status === "ready" ? "可用" : `不可用${source.error ? `: ${source.error}` : ""}`} · {source.source}
                  </span>
                )}
              </For>
            </div>
          </Show>
          <Show when={!marketSkills.loading && visibleMarketSkills().length === 0}>
            <div class="text-[11px] text-v2-text-text-muted">没有匹配的具体 Skill；可切换来源，或改用下方的受限 Markdown 链接安装。</div>
          </Show>
          <For each={visibleMarketSkills()}>
            {(skill) => {
              const installed = () => remoteInstalledByID().get(skill.id)
              const loaded = () => selectedIds().has(skill.id)
              const loadInstalled = () => {
                const current = installed()
                if (!current) return
                publish(loaded() ? selected().filter((item) => item.id !== current.id) : [...selected(), { ...current, enabled: true }])
              }
              return (
                <div class="flex items-center gap-2 rounded-md border border-v2-border-border-muted bg-surface-base px-2 py-1.5">
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-[12px] font-medium text-v2-text-text-base">{skill.name}</div>
                    <div class="truncate text-[10px] text-v2-text-text-muted">{skill.description}</div>
                    <div class="truncate text-[10px] text-v2-text-text-muted">{skill.source}</div>
                  </div>
                  <span class={`rounded px-1.5 py-0.5 text-[9px] ${skill.risk === "trusted" ? "bg-green-500/10 text-green-600" : skill.risk === "untrusted" ? "bg-red-500/10 text-red-700" : "bg-amber-500/10 text-amber-700"}`}>{riskLabel(skill.risk)}</span>
                  <Show when={installed()}>
                    <span class={`rounded px-1.5 py-0.5 text-[9px] ${loaded() ? "bg-v2-background-bg-accent/15 text-v2-text-text-accent" : "bg-green-500/10 text-green-700"}`}>
                      {loaded() ? "已加载" : "已安装"}
                    </span>
                  </Show>
                  <Button size="small" variant="secondary" disabled={installingRemote() || !remoteSkills() || !enabledMarketSources().some((repository) => skill.source.includes(repository))} onClick={() => installed() ? loadInstalled() : void installRemoteSkill(skill)}>
                    {installingRemote() ? "安装中" : loaded() ? "移出会话" : installed() ? "加载到会话" : "安装并加载"}
                  </Button>
                </div>
              )
            }}
          </For>
          <div class="border-t border-v2-border-border-muted pt-2 text-[11px] text-v2-text-text-muted">手动安装具体 Markdown 链接</div>
          <input
            class="h-8 rounded-md border border-v2-border-border-muted bg-surface-base px-2 text-[12px] outline-none focus:border-v2-border-border-focus"
            placeholder="https://github.com/org/repo/blob/main/path/SKILL.md"
            value={remoteSkillUrl()}
            onInput={(event) => setRemoteSkillUrl(event.currentTarget.value)}
          />
          <div class="flex gap-2">
            <input
              class="h-8 min-w-0 flex-1 rounded-md border border-v2-border-border-muted bg-surface-base px-2 text-[12px] outline-none focus:border-v2-border-border-focus"
              placeholder="本地 ID（可选）"
              value={remoteSkillID()}
              onInput={(event) => setRemoteSkillID(event.currentTarget.value)}
            />
            <Button size="small" variant="primary" disabled={installingRemote() || !remoteSkillUrl().trim() || !remoteSkills()} onClick={installRemoteSkill}>
              {installingRemote() ? "安装中" : "安装并加载"}
            </Button>
          </div>
        </div>
      </Show>

      <Show when={activeTab() === "mcp"}>
        <DeveagentMcpMarket />
      </Show>

      <Show when={activeTab() !== "mcp" && editingSkill() !== null}>
        <div class="flex flex-col gap-2 rounded-lg border border-v2-border-border-focus/40 bg-v2-background-bg-layer-02 p-3">
          <div class="text-[12px] font-medium text-v2-text-text-base">
            {editingSkill() === "new" ? "新建自定义 Skill" : "编辑自定义 Skill"}
          </div>
          <input
            class="h-8 rounded-md border border-v2-border-border-muted bg-surface-base px-2 text-[12px] outline-none focus:border-v2-border-border-focus"
            placeholder="Skill 名称（必填）"
            value={skillFormName()}
            onInput={(event) => setSkillFormName(event.currentTarget.value)}
          />
          <input
            class="h-8 rounded-md border border-v2-border-border-muted bg-surface-base px-2 text-[12px] outline-none focus:border-v2-border-border-focus"
            placeholder="描述（显示在列表中）"
            value={skillFormDesc()}
            onInput={(event) => setSkillFormDesc(event.currentTarget.value)}
          />
          <textarea
            class="h-28 resize-none rounded-md border border-v2-border-border-muted bg-surface-base px-2 py-1.5 text-[12px] outline-none focus:border-v2-border-border-focus"
            placeholder="Skill 内容（选中该 Skill 后会注入到对话上下文的提示词）"
            value={skillFormContent()}
            onInput={(event) => setSkillFormContent(event.currentTarget.value)}
          />
          <div class="flex gap-2">
            <Button size="small" variant="primary" class="flex-1" onClick={saveSkillForm}>
              保存
            </Button>
            <Button size="small" variant="ghost" class="flex-1" onClick={() => setEditingSkill(null)}>
              取消
            </Button>
          </div>
        </div>
      </Show>

      <Show when={activeTab() !== "mcp" && activeTab() !== "market"}>
      <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
        <Show when={activeTab() !== "installed" || (!installed.loading && !remoteInstalled.loading)} fallback={<div class="p-3 text-[12px] text-v2-text-text-muted">读取已安装 skills...</div>}>
          <For
            each={visible()}
            fallback={<div class="p-3 text-[12px] text-v2-text-text-muted">没有找到匹配的 skill。</div>}
          >
            {(skill) => (
              <div
                class={`flex items-start gap-3 rounded-lg border p-3 text-left transition-all ${
                  selectedIds().has(skill.id)
                    ? "border-v2-border-border-focus bg-v2-background-bg-accent/10"
                    : "border-v2-border-border-muted bg-v2-background-bg-layer-02"
                }`}
              >
                <button
                  type="button"
                  class={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border-2 ${
                    selectedIds().has(skill.id) ? "border-v2-border-border-focus bg-v2-background-bg-accent" : "border-v2-border-border-muted"
                  }`}
                  data-action="deveagent-skill-toggle"
                  data-skill-id={skill.id}
                  onClick={() => toggleSkill(skill)}
                  title="加载/取消加载"
                  disabled={!remoteSkills() && isRemoteSkillSource(skill.source)}
                >
                  {selectedIds().has(skill.id) && <Icon name="check-small" size="small" />}
                </button>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <div class="truncate font-medium text-v2-text-text-base">{skill.name}</div>
                    <span
                      class={`shrink-0 rounded px-1.5 py-0.5 text-[9px] ${
                        skill.risk === "trusted"
                          ? "bg-green-500/10 text-green-600"
                          : skill.risk === "review"
                            ? "bg-amber-500/10 text-amber-700"
                            : "bg-red-500/10 text-red-700"
                      }`}
                    >
                      {riskLabel(skill.risk)}
                    </span>
                    <span class="shrink-0 rounded bg-surface-base px-1.5 py-0.5 text-[9px] text-v2-text-text-muted">
                      {skill.installed ? "已安装" : "来源"}
                    </span>
                    <Show when={skill.enabled && skill.id === "token-saver"}>
                      <span class="shrink-0 rounded bg-blue-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-blue-700 dark:text-blue-300">
                        默认开启
                      </span>
                    </Show>
                  </div>
                  <div class="mt-0.5 text-[11px] text-v2-text-text-muted">{skill.desc}</div>
                  <Show when={skill.whenToUse}>
                    <div class="mt-1 rounded bg-v2-background-bg-base px-2 py-1 text-[10px] leading-4 text-v2-text-text-base">
                      <span class="font-semibold text-v2-text-text-accent">何时使用：</span>
                      {skill.whenToUse}
                    </div>
                  </Show>
                  <div class="mt-1 grid grid-cols-2 gap-1">
                    <Show when={skill.pros}>
                      <div class="rounded bg-green-500/5 px-2 py-1 text-[10px] leading-4 text-green-700 dark:text-green-300">
                        <span class="font-semibold">优点：</span>
                        {skill.pros}
                      </div>
                    </Show>
                    <Show when={skill.cons}>
                      <div class="rounded bg-red-500/5 px-2 py-1 text-[10px] leading-4 text-red-700 dark:text-red-300">
                        <span class="font-semibold">缺点：</span>
                        {skill.cons}
                      </div>
                    </Show>
                  </div>
                  <div class="mt-1 text-[10px] text-v2-text-text-muted">{skill.source}</div>
                </div>
                <div class="flex shrink-0 flex-col gap-1">
                  <Show when={skill.url}>
                    <Button variant="ghost" size="small" onClick={() => openSource(skill)}>
                      打开
                    </Button>
                  </Show>
                  <Show when={skill.source.startsWith("local:")}>
                    <Button
                      variant="ghost"
                      size="small"
                      onClick={() => {
                        setSkillFormName(skill.name)
                        setSkillFormDesc(skill.desc ?? "")
                        setSkillFormContent(localSkillContents[skill.id] ?? "")
                        setEditingSkill(skill.id)
                      }}
                    >
                      编辑
                    </Button>
                    <Button variant="ghost" size="small" onClick={() => deleteLocalSkill(skill.id)}>
                      删除
                    </Button>
                  </Show>
                  <Show when={skill.source.startsWith("remote:")}>
                    <Button variant="ghost" size="small" onClick={() => void removeRemoteSkill(skill.id)}>
                      移除
                    </Button>
                  </Show>
                </div>
              </div>
            )}
          </For>
        </Show>
      </div>

      </Show>

      <Show when={activeTab() !== "mcp"}>
      <div class="-mx-3 -mb-3 shrink-0 border-t border-v2-border-border-muted bg-v2-background-bg-base p-3">
        <Button
          variant="primary"
          size="normal"
          class="w-full"
          onClick={() => {
            publish(selected())
            showToast({
              title: "Skill 已加载到当前会话",
              description: `已选择 ${selected().length} 个 Skill。它们会进入 DeveAgent composer state，并在提交时注入运行上下文。`,
            })
            window.dispatchEvent(new CustomEvent("deveagent:close-store"))
          }}
        >
          加载到当前会话：{selected().length} 个 Skill
        </Button>
      </div>
      </Show>
    </div>
  )
}

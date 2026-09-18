import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@/utils/toast"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
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

const riskLabel = (risk: DeveAgentSkillRef["risk"], chinese: boolean) =>
  risk === "trusted"
    ? chinese ? "可信" : "Trusted"
    : risk === "review"
      ? chinese ? "需注意" : "Review required"
      : chinese ? "不可信" : "Untrusted"

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

const VISIBLE_SCROLLBAR =
  "[scrollbar-color:var(--v2-border-border-muted)_transparent] [scrollbar-gutter:stable] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-v2-border-border-muted hover:[&::-webkit-scrollbar-thumb]:bg-v2-border-border-focus"

export function DeveagentSkillStore(props: { initialTab?: Extract<SkillStoreTab, "market" | "mcp"> }) {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const platform = usePlatform()
  const language = useLanguage()
  const chinese = () => language.locale() === "zh" || language.locale() === "zht"
  const storeTabs = () => [
    { id: "market" as const, label: language.t("deveagent.skillstore.tabMarketplace") },
    { id: "installed" as const, label: language.t("deveagent.skillstore.tabInstalled") },
    { id: "local" as const, label: language.t("deveagent.skillstore.tabLocal") },
    { id: "mcp" as const, label: "MCP" },
    { id: "sources" as const, label: language.t("deveagent.skillstore.tabSources") },
  ]
  const composer = useDeveAgentComposerState()
  const [activeTab, setActiveTab] = createSignal<SkillStoreTab>(props.initialTab ?? "market")
  const [marketDetail, setMarketDetail] = createSignal<MarketSkill | null>(null)
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
            desc: skill.path ? (chinese() ? `已安装的远程 Skill: ${skill.path}` : `Remote skill installed: ${skill.path}`) : (chinese() ? "已安装的远程 Skill" : "Remote skill installed"),
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
  // MarkItDown conversion mode (auto / manual / off), read from and written back
  // to the DeveAgent runtime state so the session boundary honors it.
  const [markitdownMode, setMarkitdownMode] = createSignal<"auto" | "manual" | "off">("auto")
  const [markitdownModeLoading, setMarkitdownModeLoading] = createSignal(true)
  createResource(
    () => serverSDK().url,
    async (base) => {
      try {
        const response = await serverSDK().fetch(`${base.replace(/\/+$/, "")}/api/deveagent/state`)
        if (!response.ok) return
        const state = (await response.json()) as { markitdownMode?: "auto" | "manual" | "off" }
        if (state.markitdownMode === "auto" || state.markitdownMode === "manual" || state.markitdownMode === "off") {
          setMarkitdownMode(state.markitdownMode)
        }
      } finally {
        setMarkitdownModeLoading(false)
      }
    },
  )
  const changeMarkitdownMode = async (mode: "auto" | "manual" | "off") => {
    setMarkitdownMode(mode)
    try {
      await serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ markitdownMode: mode }),
      })
    } catch {
      // ponytail: keep the optimistic selection; the next reload reconciles.
    }
  }
  const [remoteSkillUrl, setRemoteSkillUrl] = createSignal("")
  const [remoteSkillID, setRemoteSkillID] = createSignal("")
  const [installingRemote, setInstallingRemote] = createSignal(false)
  type SkillUpdateInfo = { upToDate: boolean; error?: string }
  const [skillUpdates, setSkillUpdates] = createSignal<Record<string, SkillUpdateInfo>>({})
  const [checkingUpdates, setCheckingUpdates] = createSignal(false)
  const [updatingSkill, setUpdatingSkill] = createSignal<string | null>(null)
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
              desc: skill.description || (chinese() ? "用户自定义 Skill" : "User-defined skill"),
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
      showToast({ title: language.t("deveagent.skillstore.nameRequired"), description: language.t("deveagent.skillstore.provideName") })
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
      const saveError = skillStoreSaveError(response, result, language.t("deveagent.skillstore.invalidSaveResponse"))
      if (saveError) {
        showToast({ variant: "error", title: language.t("deveagent.skillstore.saveFailed"), description: saveError })
        return
      }
      showToast({ title: language.t("deveagent.skillstore.skillSaved"), description: language.t("deveagent.skillstore.skillSavedDescription", { name }) })
      setEditingSkill(null)
      refetchLocal()
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("deveagent.skillstore.saveFailed"),
        description: error instanceof Error ? error.message : language.t("deveagent.skillstore.serviceUnreachable"),
      })
    }
  }

  const deleteLocalSkill = async (id: string) => {
    await serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/skill/remove-local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => undefined)
    showToast({ title: language.t("deveagent.skillstore.skillDeleted"), description: language.t("deveagent.skillstore.customSkillRemoved") })
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
    return base.filter((skill) => `${skill.name} ${skill.desc ?? ""} ${skill.descEn ?? ""} ${skill.source} ${skill.url ?? ""}`.toLowerCase().includes(q))
  })

  const publish = (items: DeveAgentSkillRef[]) => {
    composer.setSelectedSkills(items)
    window.dispatchEvent(new CustomEvent("deveagent:skills-change", { detail: items }))
  }

  const installRemoteSkill = async (marketSkill?: MarketSkill) => {
    const url = marketSkill?.url ?? remoteSkillUrl().trim()
    if (!remoteSkills()) {
      showToast({
        title: language.t("deveagent.skillstore.remoteSkillsDisabled"),
        description: language.t("deveagent.skillstore.remoteSkillsDisabledHint"),
      })
      return
    }
    if (marketSkill && !enabledMarketSources().some((repository) => marketSkill.source.includes(repository))) {
      showToast({ title: language.t("deveagent.skillstore.marketSourceDisabled"), description: language.t("deveagent.skillstore.marketSourceDisabledHint") })
      return
    }
    if (marketSkill?.risk === "untrusted" && !window.confirm(language.t("deveagent.skillstore.untrustedConfirm" as Parameters<typeof language.t>[0], { source: marketSkill.source, name: marketSkill.name }))) return
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
        desc: marketSkill ? (chinese() ? `已安装: ${marketSkill.source}` : `Installed: ${marketSkill.source}`) : (chinese() ? `已安装的远程 Skill: ${result.savedPath ?? ""}` : `Remote skill installed: ${result.savedPath ?? ""}`),
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
      showToast({ title: language.t("deveagent.skillstore.installedAndLoaded"), description: language.t("deveagent.skillstore.installedAndLoadedDescription", { name: marketSkill?.name ?? result.id }) })
    } catch (error) {
      showToast({ variant: "error", title: language.t("deveagent.skillstore.installFailed"), description: error instanceof Error ? error.message : language.t("deveagent.skillstore.requestFailed") })
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
      showToast({ variant: "error", title: language.t("deveagent.skillstore.removeFailed"), description: id })
      return
    }
    publish(selected().filter((item) => item.id !== id))
    await refetchRemoteInstalled()
    showToast({ title: language.t("deveagent.skillstore.remoteSkillRemoved"), description: id })
  }

  const checkSkillUpdates = async () => {
    if (checkingUpdates()) return
    setCheckingUpdates(true)
    try {
      const response = await serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/skill/check-updates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directory: sdk().directory }),
      })
      const results = (await response.json().catch(() => [])) as { id: string; upToDate: boolean; error?: string }[]
      if (!response.ok || !Array.isArray(results)) throw new Error(`HTTP ${response.status}`)
      setSkillUpdates(Object.fromEntries(results.map((item) => [item.id, { upToDate: item.upToDate, error: item.error }])))
      const outdated = results.filter((item) => !item.upToDate && !item.error).length
      showToast({
        title: language.t("deveagent.skillstore.updateCheckFinished"),
        description: outdated > 0 ? language.t("deveagent.skillstore.outdatedCount", { count: outdated }) : language.t("deveagent.skillstore.allUpToDate"),
      })
    } catch (error) {
      showToast({ variant: "error", title: language.t("deveagent.skillstore.updateCheckFailed"), description: error instanceof Error ? error.message : language.t("deveagent.skillstore.requestFailed") })
    } finally {
      setCheckingUpdates(false)
    }
  }

  const updateSkill = async (id: string) => {
    if (updatingSkill()) return
    setUpdatingSkill(id)
    try {
      const response = await serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/skill/update`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, directory: sdk().directory }),
      })
      const result = (await response.json().catch(() => ({}))) as { updated?: boolean; error?: string }
      if (!response.ok || result.error || !result.updated) throw new Error(result.error || `HTTP ${response.status}`)
      setSkillUpdates((prev) => ({ ...prev, [id]: { upToDate: true } }))
      await refetchRemoteInstalled()
      showToast({ title: language.t("deveagent.skillstore.skillUpdated"), description: id })
    } catch (error) {
      showToast({ variant: "error", title: language.t("deveagent.skillstore.updateFailed"), description: error instanceof Error ? error.message : language.t("deveagent.skillstore.requestFailed") })
    } finally {
      setUpdatingSkill(null)
    }
  }

  const toggleSkill = (skill: DeveAgentSkillRef) => {
    if (!remoteSkills() && isRemoteSkillSource(skill.source)) {
      showToast({
        title: language.t("deveagent.skillstore.remoteSkillsDisabled"),
        description: language.t("deveagent.skillstore.loadSourcesHint"),
      })
      return
    }
    if (!skill.installed) {
      showToast({ title: language.t("deveagent.skillstore.sourceDirectory"), description: language.t("deveagent.skillstore.sourceDirectoryHint") })
      return
    }
    const next = selectedIds().has(skill.id)
      ? selected().filter((item) => item.id !== skill.id)
      : [...selected(), { ...skill, enabled: true }]
    publish(next)
  }

  const openSource = (skill: DeveAgentSkillRef) => {
    if (!skill.url) {
      showToast({ title: language.t("deveagent.skillstore.noSourceLink"), description: language.t("deveagent.skillstore.localSourceOnly", { name: skill.name }) })
      return
    }
    try {
      platform.openLink(skill.url)
    } catch {
      showToast({ variant: "error", title: language.t("deveagent.skillstore.openSourceFailed"), description: skill.url })
    }
  }

  return (
    <div class="relative flex h-full min-h-0 flex-col gap-3 bg-v2-background-bg-base p-3 text-[13px] text-v2-text-text-base">
      <div class="rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-02 p-2">
        <div class="mb-2 text-[11px] font-medium uppercase tracking-wide text-v2-text-text-muted">{language.t("deveagent.skillstore.capabilityControls")}</div>
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
            <div class="font-medium">{language.t("deveagent.skillstore.remoteSkills")}</div>
            <div class="mt-0.5 text-[10px] text-v2-text-text-muted">{remoteSkills() ? language.t("deveagent.skillstore.remoteAllowed") : language.t("deveagent.skillstore.remoteDenied")}</div>
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
            <div class="font-medium">{language.t("deveagent.skillstore.remoteMcp")}</div>
            <div class="mt-0.5 text-[10px] text-v2-text-text-muted">{remoteMcp() ? language.t("deveagent.skillstore.mcpRemoteAllowed") : language.t("deveagent.skillstore.mcpLocalOnly")}</div>
          </button>
        </div>
      </div>

      <div class={`rounded-md border px-2 py-1.5 text-[11px] ${markitdownStatus()?.available ? "border-green-500/30 text-green-700" : "border-amber-500/30 text-amber-700"}`}>
        MarkItDown: {markitdownStatus.loading ? language.t("deveagent.skillstore.checking") : markitdownStatus()?.available ? language.t("deveagent.skillstore.availableWithCommand", { command: markitdownStatus()?.command ?? "" }) : language.t("deveagent.skillstore.attachmentConversionUnavailable")}
      </div>
      <div class="flex items-center gap-1 rounded-md border border-v2-border-border-muted px-1.5 py-1 text-[11px]">
        <span class="text-v2-text-text-muted">{language.t("deveagent.skillstore.attachmentConversion")}</span>
        <div class="ml-auto flex items-center gap-0.5" data-action="deveagent-markitdown-mode">
          {(["auto", "manual", "off"] as const).map((mode) => (
            <button
              type="button"
              data-action={`deveagent-markitdown-mode-${mode}`}
              class={`rounded px-1.5 py-0.5 text-[11px] ${markitdownMode() === mode ? "bg-v2-background-bg-accent/15 text-v2-text-text-accent" : "text-v2-text-text-muted hover:text-v2-text-text-base"}`}
              disabled={markitdownModeLoading()}
              onClick={() => void changeMarkitdownMode(mode)}
            >
              {mode === "auto" ? language.t("deveagent.skillstore.attachmentAuto") : mode === "manual" ? language.t("deveagent.skillstore.attachmentManual") : language.t("deveagent.skillstore.attachmentOff")}
            </button>
          ))}
        </div>
      </div>

      <input
        hidden={activeTab() === "mcp"}
        class="h-9 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-3 text-[13px] outline-none"
        value={query()}
        placeholder={language.t("deveagent.skillstore.searchPlaceholder")}
        onInput={(event) => setQuery(event.currentTarget.value)}
      />

      <div class="flex min-w-0 items-center gap-1 overflow-x-auto pb-0.5">
        {storeTabs().map((tab) => (
          <button
            type="button"
            data-action={`skill-store-tab-${tab.id}`}
            class={`px-3 py-1.5 rounded text-[12px] transition-colors ${
              activeTab() === tab.id ? "border border-v2-border-border-focus bg-v2-background-bg-accent/10 text-v2-text-text-accent" : "border border-transparent bg-v2-background-bg-layer-02 text-v2-text-text-muted hover:text-v2-text-text-base"
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
            class="rounded border border-v2-border-border-focus bg-v2-background-bg-accent/10 px-3 py-1.5 text-[12px] font-medium text-v2-text-text-accent hover:bg-v2-background-bg-accent/15"
            onClick={openNewSkill}
          >
            + {language.t("deveagent.skillstore.newSkill")}
          </button>
        </Show>
      </div>

      <Show when={activeTab() === "market"}>
        <div data-component="deveagent-skillstore-scroll" class={`min-h-0 flex-1 overflow-y-scroll overscroll-contain pr-1 ${VISIBLE_SCROLLBAR}`}>
        <div class="flex flex-col gap-2 rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-02 p-3">
          <div class="flex items-center gap-2">
            <div class="flex-1 text-[12px] font-medium text-v2-text-text-base">{language.t("deveagent.skillstore.marketplaceSkills")}</div>
            <span
              class={`rounded px-1.5 py-0.5 text-[9px] ${marketPreferenceState() === "workspace" ? "bg-v2-state-bg-success text-v2-state-fg-success" : marketPreferenceState() === "loading" ? "bg-v2-state-bg-warning text-v2-state-fg-warning" : "bg-surface-raised-base text-v2-text-text-muted"}`}
              title={sdk().directory || language.t("deveagent.skillstore.noWorkspace")}
            >
              {marketPreferenceState() === "workspace" ? language.t("deveagent.skillstore.workspaceSaved") : marketPreferenceState() === "loading" ? language.t("deveagent.skillstore.loadingWorkspace") : marketPreferenceState() === "error" ? language.t("deveagent.skillstore.workspaceUnavailable") : language.t("deveagent.skillstore.localFallback")}
            </span>
            <Button size="small" variant="ghost" onClick={() => void refetchMarketSkills()}>{language.t("deveagent.skillstore.refresh")}</Button>
          </div>
          <div class="text-[11px] leading-4 text-v2-text-text-muted">{language.t("deveagent.skillstore.marketplaceHint")}</div>
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-2 py-1.5" role="group" aria-label={language.t("deveagent.skillstore.enableMarketSources")}>
            <span class="text-[10px] text-v2-text-text-muted">{language.t("deveagent.skillstore.enabledSources")}</span>
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
                    <span class="text-amber-700">{language.t("deveagent.skillstore.unavailable")}</span>
                  </Show>
                </label>
              )}
            </For>
          </div>
          <Show when={marketSources().length > 1}>
            <div class="flex flex-wrap gap-1" role="group" aria-label={language.t("deveagent.skillstore.marketSources")}>
              <button
                type="button"
                class={`rounded border px-2 py-1 text-[10px] ${marketSource() === "all" ? "border-v2-border-border-focus bg-v2-background-bg-accent/10 text-v2-text-text-accent" : "border-v2-border-border-muted text-v2-text-text-muted hover:bg-surface-raised-base"}`}
                data-action="skill-market-source-all"
                aria-pressed={marketSource() === "all"}
                onClick={() => setMarketSource("all")}
              >
                {chinese() ? "全部来源" : "All sources"}
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
          <Show when={marketSkills.loading}><div class="text-[11px] text-v2-text-text-muted">{chinese() ? "正在检索市场..." : "Searching the market..."}</div></Show>
          <Show when={marketSkills.error}><div class="text-[11px] text-v2-state-fg-danger">{chinese() ? "市场读取失败，请稍后重试。" : "Market search failed — try again later."}</div></Show>
          <Show when={(marketSkills()?.sources ?? []).length > 0}>
            <div class="flex flex-wrap gap-1" aria-label={language.t("deveagent.skillstore.marketSourceStatus")}>
              <For each={marketSkills()?.sources ?? []}>
                {(source) => (
                  <span
                    class={`rounded px-1.5 py-0.5 text-[9px] ${source.status === "ready" ? "bg-v2-state-bg-success text-v2-state-fg-success" : "bg-v2-state-bg-warning text-v2-state-fg-warning"}`}
                    title={source.error || source.source}
                  >
                    {source.status === "ready" ? (chinese() ? "可用" : "Ready") : (chinese() ? `不可用${source.error ? `: ${source.error}` : ""}` : `Unavailable${source.error ? `: ${source.error}` : ""}`)} · {source.source}
                  </span>
                )}
              </For>
            </div>
          </Show>
          <Show when={!marketSkills.loading && visibleMarketSkills().length === 0}>
            <div class="text-[11px] text-v2-text-text-muted">{chinese() ? "没有匹配的具体 Skill；可切换来源，或改用下方的受限 Markdown 链接安装。" : "No matching concrete skills; switch sources or use the restricted Markdown link install below."}</div>
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
                  <span class={`rounded px-1.5 py-0.5 text-[9px] ${skill.risk === "trusted" ? "bg-v2-state-bg-success text-v2-state-fg-success" : skill.risk === "untrusted" ? "bg-v2-state-bg-danger text-v2-state-fg-danger" : "bg-v2-state-bg-warning text-v2-state-fg-warning"}`}>{riskLabel(skill.risk, chinese())}</span>
                  <Show when={installed()}>
                    <span class={`rounded px-1.5 py-0.5 text-[9px] ${loaded() ? "bg-v2-background-bg-accent/15 text-v2-text-text-accent" : "bg-v2-state-bg-success text-v2-state-fg-success"}`}>
                      {loaded() ? (chinese() ? "已加载" : "Loaded") : (chinese() ? "已安装" : "Installed")}
                    </span>
                  </Show>
                  <div class="flex shrink-0 gap-1">
                    <Button size="small" variant="ghost" onClick={() => setMarketDetail(skill)}>{chinese() ? "详情" : "Details"}</Button>
                    <Button size="small" variant="secondary" disabled={installingRemote() || !remoteSkills() || !enabledMarketSources().some((repository) => skill.source.includes(repository))} onClick={() => installed() ? loadInstalled() : void installRemoteSkill(skill)}>
                      {installingRemote() ? (chinese() ? "安装中" : "Installing") : loaded() ? (chinese() ? "移出会话" : "Remove from session") : installed() ? (chinese() ? "加载到会话" : "Load into session") : (chinese() ? "安装并加载" : "Install & load")}
                    </Button>
                  </div>
                </div>
              )
            }}
          </For>
          <div class="border-t border-v2-border-border-muted pt-2 text-[11px] text-v2-text-text-muted">{language.t("deveagent.skillstore.installMarkdownLink")}</div>
          <input
            class="h-8 rounded-md border border-v2-border-border-muted bg-surface-base px-2 text-[12px] outline-none focus:border-v2-border-border-focus"
            placeholder="https://github.com/org/repo/blob/main/path/SKILL.md"
            value={remoteSkillUrl()}
            onInput={(event) => setRemoteSkillUrl(event.currentTarget.value)}
          />
          <div class="flex gap-2">
            <input
              class="h-8 min-w-0 flex-1 rounded-md border border-v2-border-border-muted bg-surface-base px-2 text-[12px] outline-none focus:border-v2-border-border-focus"
              placeholder={language.t("deveagent.skillstore.fieldLocalId")}
              value={remoteSkillID()}
              onInput={(event) => setRemoteSkillID(event.currentTarget.value)}
            />
            <Button size="small" variant="primary" disabled={installingRemote() || !remoteSkillUrl().trim() || !remoteSkills()} onClick={installRemoteSkill}>
              {installingRemote() ? (chinese() ? "安装中" : "Installing") : (chinese() ? "安装并加载" : "Install & load")}
            </Button>
          </div>
        </div>
        </div>
      </Show>

      <Show when={activeTab() === "mcp"}>
        <DeveagentMcpMarket />
      </Show>

      <Show when={activeTab() !== "mcp" && editingSkill() !== null}>
        <div class="flex flex-col gap-2 rounded-lg border border-v2-border-border-focus/40 bg-v2-background-bg-layer-02 p-3">
          <div class="text-[12px] font-medium text-v2-text-text-base">
            {editingSkill() === "new" ? (chinese() ? "新建自定义 Skill" : "New custom skill") : (chinese() ? "编辑自定义 Skill" : "Edit custom skill")}
          </div>
          <input
            class="h-8 rounded-md border border-v2-border-border-muted bg-surface-base px-2 text-[12px] outline-none focus:border-v2-border-border-focus"
            placeholder={language.t("deveagent.skillstore.fieldName")}
            value={skillFormName()}
            onInput={(event) => setSkillFormName(event.currentTarget.value)}
          />
          <input
            class="h-8 rounded-md border border-v2-border-border-muted bg-surface-base px-2 text-[12px] outline-none focus:border-v2-border-border-focus"
            placeholder={language.t("deveagent.skillstore.fieldDescription")}
            value={skillFormDesc()}
            onInput={(event) => setSkillFormDesc(event.currentTarget.value)}
          />
          <textarea
            class="h-28 resize-none rounded-md border border-v2-border-border-muted bg-surface-base px-2 py-1.5 text-[12px] outline-none focus:border-v2-border-border-focus"
            placeholder={language.t("deveagent.skillstore.fieldContent")}
            value={skillFormContent()}
            onInput={(event) => setSkillFormContent(event.currentTarget.value)}
          />
          <div class="flex gap-2">
            <Button size="small" variant="primary" class="flex-1" onClick={saveSkillForm}>
              {language.t("deveagent.skillstore.save")}
            </Button>
            <Button size="small" variant="ghost" class="flex-1" onClick={() => setEditingSkill(null)}>
              {language.t("deveagent.skillstore.cancel")}
            </Button>
          </div>
        </div>
      </Show>

      <Show when={activeTab() !== "mcp" && activeTab() !== "market"}>
      <div data-component="deveagent-skillstore-scroll" class={`min-h-0 flex-1 overflow-y-scroll overscroll-contain pr-1 ${VISIBLE_SCROLLBAR}`}>
        <div class="flex flex-col gap-2 pb-2">
        <Show when={activeTab() === "installed" && (remoteInstalled() ?? []).length > 0}>
          <div class="flex items-center justify-between gap-2 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-2 py-1.5">
            <span class="text-[11px] text-v2-text-text-muted">{language.t("deveagent.skillstore.updateFromSourceHint")}</span>
            <Button variant="secondary" size="small" disabled={checkingUpdates()} onClick={() => void checkSkillUpdates()}>
              {checkingUpdates() ? language.t("deveagent.skillstore.checking") : language.t("deveagent.skillstore.checkForUpdates")}
            </Button>
          </div>
        </Show>
        <Show when={activeTab() !== "installed" || (!installed.loading && !remoteInstalled.loading)} fallback={<div class="p-3 text-[12px] text-v2-text-text-muted">{language.t("deveagent.skillstore.loadingInstalled")}</div>}>
          <For
            each={visible()}
            fallback={<div class="p-3 text-[12px] text-v2-text-text-muted">{chinese() ? "没有找到匹配的 skill。" : "No matching skills found."}</div>}
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
                  title={language.t("deveagent.skillstore.loadUnload")}
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
                          ? "bg-v2-state-bg-success text-v2-state-fg-success"
                          : skill.risk === "review"
                            ? "bg-v2-state-bg-warning text-v2-state-fg-warning"
                            : "bg-v2-state-bg-danger text-v2-state-fg-danger"
                      }`}
                    >
                      {riskLabel(skill.risk, chinese())}
                    </span>
                    <span class="shrink-0 rounded bg-surface-base px-1.5 py-0.5 text-[9px] text-v2-text-text-muted">
                      {skill.installed ? (chinese() ? "已安装" : "Installed") : (chinese() ? "来源" : "Source")}
                    </span>
                    <Show when={skill.enabled && skill.id === "token-saver"}>
                      <span class="shrink-0 rounded bg-v2-background-bg-accent/15 px-1.5 py-0.5 text-[9px] font-semibold text-v2-text-text-accent">
                        {chinese() ? "默认开启" : "On by default"}
                      </span>
                    </Show>
                  </div>
                  <div class="mt-0.5 text-[11px] text-v2-text-text-muted">{chinese() ? skill.desc : skill.descEn || skill.desc}</div>
                  <Show when={chinese() ? skill.whenToUse : skill.whenToUseEn || skill.whenToUse}>
                    <div class="mt-1 rounded bg-v2-background-bg-base px-2 py-1 text-[10px] leading-4 text-v2-text-text-base">
                      <span class="font-semibold text-v2-text-text-accent">{chinese() ? "何时使用：" : "When to use:"}</span>
                      {chinese() ? skill.whenToUse : skill.whenToUseEn || skill.whenToUse}
                    </div>
                  </Show>
                  <div class="mt-1 grid grid-cols-2 gap-1">
                    <Show when={chinese() ? skill.pros : skill.prosEn || skill.pros}>
                      <div class="rounded bg-v2-state-bg-success px-2 py-1 text-[10px] leading-4 text-v2-state-fg-success">
                        <span class="font-semibold">{chinese() ? "优点：" : "Pros:"}</span>
                        {chinese() ? skill.pros : skill.prosEn || skill.pros}
                      </div>
                    </Show>
                    <Show when={skill.cons}>
                      <div class="rounded bg-v2-state-bg-danger px-2 py-1 text-[10px] leading-4 text-v2-state-fg-danger">
                        <span class="font-semibold">{chinese() ? "缺点：" : "Cons:"}</span>
                        {skill.cons}
                      </div>
                    </Show>
                  </div>
                  <div class="mt-1 text-[10px] text-v2-text-text-muted">{skill.source}</div>
                </div>
                <div class="flex shrink-0 flex-col gap-1">
                  <Show when={skill.url}>
                    <Button variant="ghost" size="small" onClick={() => openSource(skill)}>
                      {chinese() ? "打开" : "Open"}
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
                      {language.t("deveagent.skillstore.edit")}
                    </Button>
                    <Button variant="ghost" size="small" onClick={() => deleteLocalSkill(skill.id)}>
                      {language.t("deveagent.skillstore.delete")}
                    </Button>
                  </Show>
                  <Show when={skill.source.startsWith("remote:")}>
                    <Show when={skillUpdates()[skill.id] && !skillUpdates()[skill.id]!.upToDate}>
                      <Button variant="secondary" size="small" disabled={updatingSkill() !== null} onClick={() => void updateSkill(skill.id)}>
                        {updatingSkill() === skill.id ? language.t("deveagent.skillstore.updating") : language.t("deveagent.skillstore.update")}
                      </Button>
                    </Show>
                    <Button variant="ghost" size="small" onClick={() => void removeRemoteSkill(skill.id)}>
                      {language.t("deveagent.skillstore.remove")}
                    </Button>
                  </Show>
                </div>
              </div>
            )}
          </For>
        </Show>
        </div>
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
              title: language.t("deveagent.skillstore.loadedIntoSession"),
              description: language.t("deveagent.skillstore.selectedCountDescription", { count: selected().length }),
            })
            window.dispatchEvent(new CustomEvent("deveagent:close-store"))
          }}
        >
          {language.t("deveagent.skillstore.loadSelectedIntoSession", { count: selected().length })}
        </Button>
      </div>
      </Show>
      <Show when={marketDetail()} keyed>
        {(skill) => {
          const installed = () => remoteInstalledByID().get(skill.id)
          const loaded = () => selectedIds().has(skill.id)
          const canInstall = () => remoteSkills() && enabledMarketSources().some((source) => skill.source.includes(source))
          return (
            <div class="absolute inset-0 z-20 flex items-end bg-black/30 p-3" data-component="deveagent-skill-detail" onClick={() => setMarketDetail(null)}>
              <section role="dialog" aria-modal="true" aria-label={`${language.t("deveagent.skillstore.details")}: ${skill.name}`} class="max-h-full w-full overflow-y-auto rounded-lg border border-v2-border-border-focus bg-v2-background-bg-base p-4 shadow-lg" onClick={(event) => event.stopPropagation()}>
                <div class="flex items-start gap-3">
                  <div class="min-w-0 flex-1">
                    <div class="text-[14px] font-semibold text-v2-text-text-base">{skill.name}</div>
                    <div class="mt-1 text-[12px] leading-5 text-v2-text-text-muted">{skill.description}</div>
                  </div>
                  <button type="button" class="size-7 rounded-md text-v2-text-text-muted hover:bg-v2-background-bg-layer-02" aria-label={language.t("deveagent.skillstore.closeDetails")} title={language.t("deveagent.skillstore.close")} onClick={() => setMarketDetail(null)}>×</button>
                </div>
                <div class="mt-4 grid gap-2 text-[12px] text-v2-text-text-base">
                  <div><span class="text-v2-text-text-muted">{language.t("deveagent.skillstore.labelSource")}</span>{skill.source}</div>
                  <div><span class="text-v2-text-text-muted">{language.t("deveagent.skillstore.labelRisk")}</span>{riskLabel(skill.risk, chinese())}</div>
                  <div><span class="text-v2-text-text-muted">{language.t("deveagent.skillstore.labelStatus")}</span>{loaded() ? language.t("deveagent.skillstore.stateLoaded") : installed() ? language.t("deveagent.skillstore.stateInstalledNotLoaded") : language.t("deveagent.skillstore.stateNotInstalled")}</div>
                  <div class="break-all"><span class="text-v2-text-text-muted">{language.t("deveagent.skillstore.labelUrl")}</span>{skill.url}</div>
                </div>
                <div class="mt-4 flex justify-end gap-2">
                  <Button size="small" variant="ghost" onClick={() => openSource({ ...skill, installed: !!installed(), enabled: loaded() })}>{language.t("deveagent.skillstore.openSource")}</Button>
                  <Button size="small" variant="secondary" disabled={installingRemote() || !canInstall()} onClick={() => {
                    if (installed()) publish(loaded() ? selected().filter((item) => item.id !== skill.id) : [...selected(), { ...installed()!, enabled: true }])
                    else void installRemoteSkill(skill)
                  }}>
                    {installingRemote() ? language.t("deveagent.skillstore.installing") : loaded() ? language.t("deveagent.skillstore.removeFromSession") : installed() ? language.t("deveagent.skillstore.loadIntoSession") : language.t("deveagent.skillstore.installAndLoad")}
                  </Button>
                </div>
              </section>
            </div>
          )
        }}
      </Show>
    </div>
  )
}

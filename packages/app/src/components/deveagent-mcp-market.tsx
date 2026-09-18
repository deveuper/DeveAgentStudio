import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { mcpInstallConfirmMessage, mcpSourceNameKey, mcpStatusLabelKey, mcpStatusTone, mcpStatusTooltip, type WorkspaceMcpStatusInput } from "./deveagent-mcp-market-state"

import { Button } from "@opencode-ai/ui/button"
import { useDeveAgentComposerState } from "@/components/deveagent-composer-state"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"

type McpRemote = {
  type: "streamable-http" | "sse"
  url: string
  requiresSecret: boolean
  headerNames: string[]
}

type McpEntry = {
  name: string
  description?: string
  descriptionEn?: string
  version?: string
  repositoryUrl?: string
  remotes: McpRemote[]
  packageTypes: string[]
  packageTypesEn?: string[]
}

type McpRegistryResponse = { servers: McpEntry[]; nextCursor?: string; error?: string }
type McpCategory = "all" | "remote" | "credentials" | "local"
// Reuse the state module's shape instead of re-declaring the five-literal union.
type WorkspaceMcpStatus = WorkspaceMcpStatusInput
type McpMarketSource = "official" | "tencent" | "aliyun"

const MCP_MARKET_PREFERENCES_KEY = "deveagent.mcp-market.preferences.v1"

function mcpMarketPreferencesKey(directory: string) {
  return `${MCP_MARKET_PREFERENCES_KEY}:${encodeURIComponent(directory)}`
}

function readMcpMarketPreferences(key = MCP_MARKET_PREFERENCES_KEY): { source: McpMarketSource; category: McpCategory } | undefined {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return undefined
    const value = JSON.parse(raw) as { source?: unknown; category?: unknown } | null
    if (!value) return undefined
    const source = value?.source
    const category = value?.category
    return {
      source: source === "tencent" || source === "aliyun" || source === "official" ? source : "official",
      category: category === "remote" || category === "credentials" || category === "local" || category === "all" ? category : "all",
    }
  } catch {
    return { source: "official", category: "all" }
  }
}

// ponytail: keep vendor records descriptive until a documented public endpoint
// and auth/install API exists; never turn a marketplace page into a guessed URL.
const CURATED_MCP: Record<Exclude<McpMarketSource, "official">, McpEntry[]> = {
  tencent: [
    {
      name: "Tencent TKE MCP",
      description: "腾讯云官方 TKE MCP Server。官方页面提供本地 Python 安装和腾讯云凭据配置；应用不会猜测远程地址，也不会代存 SecretId/SecretKey。",
      descriptionEn: "Official Tencent Cloud TKE MCP Server. The official page covers local Python installation and Tencent Cloud credential setup; the app never guesses remote addresses or stores SecretId/SecretKey.",
      repositoryUrl: "https://cloud.tencent.com/developer/mcp/server/11804",
      remotes: [],
      packageTypes: ["pip:tke-mcp-server", "需要腾讯云凭据"],
      packageTypesEn: ["pip:tke-mcp-server", "requires Tencent Cloud credentials"],
    },
  ],
  aliyun: [
    {
      name: "Alibaba Cloud Native MCP Marketplace",
      description: "阿里云官方原生 MCP 商品市场。商品接入涉及 Marketplace 授权和计量，当前只展示官方入口，不能伪装成通用一键安装。",
      descriptionEn: "Official Alibaba Cloud native MCP marketplace. Marketplace authorization and metering are involved; only the official entry is shown, never disguised as a one-click install.",
      repositoryUrl: "https://bailian.console.aliyun.com/?tab=mcp#/mcp-market",
      remotes: [],
      packageTypes: ["百炼 MCP 市场授权", "需要部署地域与权限"],
      packageTypesEn: ["Bailian MCP marketplace authorization", "requires deploy region and permissions"],
    },
  ],
}

function workspaceMcpName(name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72)
  return `market-${slug || "server"}`
}

/** Embedded registry browser; package installs stay preview-only until a reviewed local installer exists. */
export function DeveagentMcpMarket() {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const composer = useDeveAgentComposerState()
  const language = useLanguage()
  const mcpSourceTabs = (): Array<{ id: McpMarketSource; name: string; note: string }> => [
    { id: "official", name: language.t("deveagent.mcp.officialRegistry"), note: language.t("deveagent.mcp.officialRegistryHint") },
    { id: "tencent", name: language.t("deveagent.mcp.tencentCloudMcp"), note: language.t("deveagent.mcp.tencentCloudHint") },
    { id: "aliyun", name: language.t("deveagent.mcp.alibabaCloudMcp"), note: language.t("deveagent.mcp.alibabaCloudHint") },
  ]
  const [draft, setDraft] = createSignal("")
  const [query, setQuery] = createSignal("")
  const preferences = readMcpMarketPreferences() ?? { source: "official" as const, category: "all" as const }
  const [category, setCategory] = createSignal<McpCategory>(preferences.category)
  const [marketSource, setMarketSource] = createSignal<McpMarketSource>(preferences.source)
  let hydratedDirectory = ""
  const [marketPreferenceState, setMarketPreferenceState] = createSignal<"loading" | "workspace" | "fallback">("fallback")
  const [persistedMarketDirectory, setPersistedMarketDirectory] = createSignal("")
  createEffect(() => {
    const directory = sdk().directory
    if (!directory) {
      setMarketPreferenceState("fallback")
      return
    }
    if (hydratedDirectory === directory) return
    hydratedDirectory = directory
    setMarketPreferenceState("loading")
    setPersistedMarketDirectory("")
    const scoped = readMcpMarketPreferences(mcpMarketPreferencesKey(directory)) ?? readMcpMarketPreferences()
    if (scoped) {
      setMarketSource(scoped.source)
      setCategory(scoped.category)
    }
    void serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/mcp/market-preferences?directory=${encodeURIComponent(directory)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return (await response.json()) as { source?: unknown; category?: unknown }
      })
      .then((remote) => {
        if (sdk().directory !== directory) return
        if (remote?.source === "official" || remote?.source === "tencent" || remote?.source === "aliyun") setMarketSource(remote.source)
        if (remote?.category === "all" || remote?.category === "remote" || remote?.category === "credentials" || remote?.category === "local") setCategory(remote.category)
        setPersistedMarketDirectory(directory)
        setMarketPreferenceState("workspace")
      })
      .catch(() => {
        if (sdk().directory === directory) setMarketPreferenceState("fallback")
      })
  })
  createEffect(() => {
    const directory = sdk().directory
    if (!directory || hydratedDirectory !== directory) return
    try {
      localStorage.setItem(mcpMarketPreferencesKey(directory), JSON.stringify({ source: marketSource(), category: category() }))
    } catch {
      // The MCP market remains usable when renderer storage is unavailable.
    }
    if (persistedMarketDirectory() !== directory) return
    void serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/mcp/market-preferences`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory, source: marketSource(), category: category() }),
    }).catch(() => undefined)
  })
  const [adding, setAdding] = createSignal<string | undefined>()
  const [mcpAction, setMcpAction] = createSignal<string | undefined>()
  const [directName, setDirectName] = createSignal("")
  const [directUrl, setDirectUrl] = createSignal("")
  const [registry] = createResource(
    () => marketSource() === "official" ? query() : undefined,
    async (value): Promise<McpRegistryResponse> => {
      if (marketSource() !== "official") return { servers: [] }
      const base = serverSDK().url.replace(/\/+$/, "")
      const response = await serverSDK().fetch(`${base}/api/deveagent/mcp/registry?q=${encodeURIComponent(value)}`)
      const payload = (await response.json().catch(() => ({ servers: [] }))) as McpRegistryResponse
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
      return payload
    },
  )
  const [workspaceMcpStatus, { refetch: refetchWorkspaceMcpStatus }] = createResource(
    () => sdk().directory,
    async (directory): Promise<Record<string, WorkspaceMcpStatus>> => {
      if (!directory) return {}
      const base = serverSDK().url.replace(/\/+$/, "")
      const response = await serverSDK().fetch(`${base}/mcp?directory=${encodeURIComponent(directory)}`)
      if (!response.ok) return {}
      return (await response.json().catch(() => ({}))) as Record<string, WorkspaceMcpStatus>
    },
  )
  const configuredMcpEntries = createMemo(() => Object.entries(workspaceMcpStatus() ?? {}))
  const toggleWorkspaceMcp = async (name: string, status: WorkspaceMcpStatus) => {
    if (mcpAction()) return
    const action = status.status === "connected" ? "disconnect" : "connect"
    setMcpAction(name)
    try {
      const base = serverSDK().url.replace(/\/+$/, "")
      const response = await serverSDK().fetch(`${base}/mcp/${encodeURIComponent(name)}/${action}?directory=${encodeURIComponent(sdk().directory)}`, {
        method: "POST",
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      await refetchWorkspaceMcpStatus()
      showToast({ title: action === "connect" ? language.t("deveagent.mcp.connected") : language.t("deveagent.mcp.disconnected"), description: name })
    } catch (error) {
      showToast({ variant: "error", title: action === "connect" ? language.t("deveagent.mcp.connectFailed") : language.t("deveagent.mcp.disconnectFailed"), description: error instanceof Error ? error.message : name })
    } finally {
      setMcpAction(undefined)
    }
  }
  const visibleEntries = createMemo(() => {
    const source = marketSource()
    const entries = source === "official" ? registry()?.servers ?? [] : CURATED_MCP[source]
    const queryText = query().trim().toLowerCase()
    const filtered = queryText
      ? entries.filter((entry) => `${entry.name} ${entry.description ?? ""} ${(entry as { descriptionEn?: string }).descriptionEn ?? ""}`.toLowerCase().includes(queryText))
      : entries
    switch (category()) {
      case "remote":
        return filtered.filter((entry) => entry.remotes.some((remote) => !remote.requiresSecret))
      case "credentials":
        return filtered.filter((entry) => entry.remotes.some((remote) => remote.requiresSecret))
      case "local":
        return filtered.filter((entry) => entry.packageTypes.length > 0)
      default:
        return filtered
    }
  })

  // Human-readable name of the currently selected marketplace tab. The source
  // decision itself lives in the unit-tested `mcpSourceNameKey`; unknown tab
  // values fall back to the manual-address label rather than a cloud vendor.
  const marketSourceName = () => language.t(mcpSourceNameKey(marketSource()) as Parameters<typeof language.t>[0])

  const addRemote = async (entry: McpEntry, remote: McpRemote, sourceName: string, validationInProgress = false, configureLater = false) => {
    if (adding() && !validationInProgress) return false
    if (!composer.snapshot().remoteMcp) {
      showToast({
        title: language.t("deveagent.mcp.remoteMcpDisabled"),
        description: language.t("deveagent.mcp.remoteMcpDisabledHint"),
      })
      return false
    }
    if (remote.requiresSecret && !configureLater) {
      showToast({
        title: language.t("deveagent.mcp.credentialsRequired"),
        description: language.t("deveagent.mcp.credentialsRequiredDescription", { headers: remote.headerNames.join(", ") || language.t("deveagent.mcp.keysOrOAuth") }),
      })
      return false
    }
    const confirm = mcpInstallConfirmMessage({ sourceName, entryName: entry.name, url: remote.url, requiresSecret: remote.requiresSecret })
    if (!window.confirm(language.t(confirm.key as Parameters<typeof language.t>[0], confirm.params))) return false
    const name = workspaceMcpName(entry.name)
    setAdding(`${entry.name}:${remote.url}`)
    try {
      const directory = sdk().directory
      const base = serverSDK().url.replace(/\/+$/, "")
      const response = await serverSDK().fetch(`${base}/mcp?directory=${encodeURIComponent(directory)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, config: { type: "remote", url: remote.url, enabled: !configureLater } }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      showToast({
        title: configureLater ? language.t("deveagent.mcp.addedToPending") : language.t("deveagent.mcp.addedToWorkspace"),
        description: configureLater
          ? language.t("deveagent.mcp.addedToPendingDescription", { name: entry.name })
          : language.t("deveagent.mcp.addedToWorkspaceDescription", { name: entry.name }),
      })
      await refetchWorkspaceMcpStatus()
      return true
    } catch (error) {
      showToast({ variant: "error", title: language.t("deveagent.mcp.joinFailed"), description: error instanceof Error ? error.message : language.t("deveagent.mcp.requestFailed") })
      return false
    } finally {
      setAdding(undefined)
    }
  }

  const addDirectRemote = async () => {
    const rawUrl = directUrl().trim()
    if (!rawUrl || adding()) return
    if (!composer.snapshot().remoteMcp) {
      showToast({ title: language.t("deveagent.mcp.remoteMcpDisabled"), description: language.t("deveagent.mcp.remoteMcpRequired") })
      return
    }
    setAdding("direct")
    try {
      const base = serverSDK().url.replace(/\/+$/, "")
      const response = await serverSDK().fetch(`${base}/api/deveagent/mcp/validate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: rawUrl }),
      })
      const result = (await response.json().catch(() => ({}))) as { url?: string; error?: string }
      if (!response.ok || !result.url) throw new Error(result.error || "MCP endpoint validation failed")
      const name = directName().trim() || new URL(result.url).hostname
      const installed = await addRemote(
        { name, remotes: [{ type: "streamable-http", url: result.url, requiresSecret: false, headerNames: [] }], packageTypes: [] },
        { type: "streamable-http", url: result.url, requiresSecret: false, headerNames: [] },
        language.t("deveagent.mcp.sourceManualUrl"),
        true,
      )
      if (installed) {
        setDirectName("")
        setDirectUrl("")
      }
    } catch (error) {
      showToast({ variant: "error", title: language.t("deveagent.mcp.joinFailed"), description: error instanceof Error ? error.message : language.t("deveagent.mcp.invalidConnectionUrl") })
    } finally {
      setAdding(undefined)
    }
  }

  return (
    <section data-component="deveagent-mcp-market-scroll" class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-scroll rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-02 p-3 [scrollbar-color:var(--v2-border-border-muted)_transparent] [scrollbar-gutter:stable] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-v2-border-border-muted hover:[&::-webkit-scrollbar-thumb]:bg-v2-border-border-focus">
      <div>
        <div class="flex items-center gap-2">
          <div class="flex-1 text-[13px] font-medium text-v2-text-text-base">{language.t("deveagent.mcp.title")}</div>
          <span class={`rounded px-1.5 py-0.5 text-[9px] ${marketPreferenceState() === "workspace" ? "bg-green-500/10 text-green-700" : marketPreferenceState() === "loading" ? "bg-amber-500/10 text-amber-800" : "bg-surface-raised-base text-v2-text-text-muted"}`} title={sdk().directory || language.t("deveagent.mcp.noWorkspace")}>
            {marketPreferenceState() === "workspace" ? language.t("deveagent.mcp.workspaceSaved") : marketPreferenceState() === "loading" ? language.t("deveagent.mcp.loadingWorkspace") : language.t("deveagent.mcp.localFallback")}
          </span>
        </div>
        <div class="mt-1 text-[11px] leading-4 text-v2-text-text-muted">
          {language.t("deveagent.mcp.marketplaceHint")}
        </div>
      </div>
      <div class="flex gap-2">
        <input
          class="h-8 min-w-0 flex-1 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-2 text-[12px] outline-none focus:border-v2-border-border-focus"
          value={draft()}
          placeholder={language.t("deveagent.mcp.searchPlaceholder")}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") setQuery(draft().trim())
          }}
        />
        <Button size="small" variant="secondary" onClick={() => setQuery(draft().trim())}>{language.t("deveagent.mcp.search")}</Button>
      </div>
      <div class="flex flex-wrap gap-1.5">
        {([
          ["all", language.t("deveagent.mcp.filterAll")],
          ["remote", language.t("deveagent.mcp.filterReady")],
          ["credentials", language.t("deveagent.mcp.filterCredentials")],
          ["local", language.t("deveagent.mcp.filterLocalPackage")],
        ] as const).map(([id, label]) => (
          <button
            type="button"
            class={`rounded-md border px-2 py-1 text-[11px] ${
              category() === id
                ? "border-v2-border-border-focus bg-v2-background-bg-accent/10 text-v2-text-text-base"
                : "border-v2-border-border-muted bg-v2-background-bg-base text-v2-text-text-muted hover:text-v2-text-text-base"
            }`}
            aria-pressed={category() === id}
            onClick={() => setCategory(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <Show when={!composer.snapshot().remoteMcp}>
        <button
          type="button"
          class="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-left text-[11px] text-amber-800"
          onClick={() => composer.setRemoteMcp(true)}
        >
          {language.t("deveagent.mcp.remoteMcpOffHint")}
        </button>
      </Show>
      <div class="rounded-md border border-v2-border-border-muted bg-v2-background-bg-base p-2.5">
        <div class="text-[11px] font-medium text-v2-text-text-base">{language.t("deveagent.mcp.addConnection")}</div>
        <div class="mt-1 text-[10px] leading-4 text-v2-text-text-muted">{language.t("deveagent.mcp.addConnectionHint")}</div>
        <div class="mt-2 grid grid-cols-[minmax(0,0.45fr)_minmax(0,1fr)_auto] gap-1.5">
          <input class="h-8 min-w-0 rounded-md border border-v2-border-border-muted bg-surface-base px-2 text-[11px] outline-none focus:border-v2-border-border-focus" value={directName()} placeholder={language.t("deveagent.mcp.fieldName")} onInput={(event) => setDirectName(event.currentTarget.value)} />
          <input class="h-8 min-w-0 rounded-md border border-v2-border-border-muted bg-surface-base px-2 text-[11px] outline-none focus:border-v2-border-border-focus" value={directUrl()} placeholder="https://.../mcp" onInput={(event) => setDirectUrl(event.currentTarget.value)} onKeyDown={(event) => event.key === "Enter" && void addDirectRemote()} />
          <Button size="small" variant="secondary" disabled={!directUrl().trim() || !!adding()} onClick={() => void addDirectRemote()}>{adding() === "direct" ? language.t("deveagent.mcp.validating") : language.t("deveagent.mcp.add")}</Button>
        </div>
      </div>
      <div>
        <div class="rounded-md border border-v2-border-border-muted bg-v2-background-bg-base p-2.5">
          <div class="flex items-center justify-between gap-2">
            <div class="text-[11px] font-medium text-v2-text-text-base">{language.t("deveagent.mcp.currentWorkspaceMcp")}</div>
            <Button
              size="small"
              variant="ghost"
              disabled={workspaceMcpStatus.loading}
              onClick={() => void refetchWorkspaceMcpStatus()}
            >
              {workspaceMcpStatus.loading ? language.t("deveagent.mcp.refreshing") : language.t("deveagent.mcp.refreshStatus")}
            </Button>
          </div>
          <Show when={!workspaceMcpStatus.loading} fallback={<div class="mt-2 text-[10px] text-v2-text-text-muted">{language.t("deveagent.mcp.loadingWorkspaceMcp")}</div>}>
          <div class="mt-1 flex flex-col gap-1.5">
            <For each={configuredMcpEntries()} fallback={<div class="text-[10px] text-v2-text-text-muted">{language.t("deveagent.mcp.noMcpConfigured")}</div>}>
              {([name, status]) => (
                <div class="flex items-center gap-2 rounded border border-v2-border-border-muted px-2 py-1.5">
                  <div class="min-w-0 flex-1 truncate text-[10px] text-v2-text-text-base">{name}</div>
                  <span
                    class={`shrink-0 rounded px-1.5 py-0.5 text-[9px] ${
                      mcpStatusTone(status.status) === "ok"
                        ? "bg-green-500/10 text-green-700"
                        : mcpStatusTone(status.status) === "error"
                          ? "bg-red-500/10 text-red-700"
                          : "bg-amber-500/10 text-amber-800"
                    }`}
                    title={mcpStatusTooltip(status, language.t(mcpStatusLabelKey(status.status) as Parameters<typeof language.t>[0]))}
                  >
                    {language.t(mcpStatusLabelKey(status.status) as Parameters<typeof language.t>[0])}
                  </span>
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={!!mcpAction()}
                    onClick={() => void toggleWorkspaceMcp(name, status)}
                  >
                    {mcpAction() === name ? language.t("deveagent.mcp.statusWorking") : status.status === "connected" ? language.t("deveagent.mcp.disconnect") : language.t("deveagent.mcp.connect")}
                  </Button>
                </div>
              )}
            </For>
          </div>
          </Show>
        </div>
      </div>
      <div class="flex flex-wrap gap-1.5" role="tablist" aria-label={language.t("deveagent.mcp.sources")}>
        <For each={mcpSourceTabs()}>
          {(source) => (
            <button
              type="button"
              role="tab"
              aria-selected={marketSource() === source.id}
              title={source.note}
              class={`rounded-md border px-2 py-1 text-[10px] ${marketSource() === source.id ? "border-v2-border-border-focus bg-v2-background-bg-accent/10 text-v2-text-text-base" : "border-v2-border-border-muted bg-v2-background-bg-base text-v2-text-text-muted hover:text-v2-text-text-base"}`}
              onClick={() => setMarketSource(source.id)}
            >
              {source.name}
            </button>
          )}
        </For>
      </div>
      <div class="rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-2.5 py-2 text-[10px] leading-4 text-v2-text-text-muted">
        {mcpSourceTabs().find((source) => source.id === marketSource())?.note}
      </div>
      <Show when={marketSource() === "official" && registry.loading}><div class="text-[12px] text-v2-text-text-muted">{language.t("deveagent.mcp.loadingRegistry")}</div></Show>
      <Show when={marketSource() === "official" && registry.error}><div class="text-[12px] text-red-600">{registry.error instanceof Error ? registry.error.message : language.t("deveagent.mcp.registryFailed")}</div></Show>
      <For each={visibleEntries()} fallback={<Show when={marketSource() !== "official" || !registry.loading}><div class="text-[12px] text-v2-text-text-muted">{language.t("deveagent.mcp.noMetadata")}</div></Show>}>
        {(entry) => (
          <article class="rounded-lg border border-v2-border-border-muted bg-v2-background-bg-base p-3">
            <div class="flex items-start gap-2">
              <div class="min-w-0 flex-1">
                <div class="truncate text-[12px] font-medium text-v2-text-text-base">{entry.name}</div>
                <Show when={entry.version}><div class="mt-0.5 text-[10px] text-v2-text-text-muted">{entry.version}</div></Show>
              </div>
              <span class="shrink-0 rounded bg-surface-base px-1.5 py-0.5 text-[9px] text-v2-text-text-muted">{marketSourceName()}</span>
              <Show when={entry.repositoryUrl}><a class="text-[11px] text-v2-text-text-accent hover:underline" href={entry.repositoryUrl} target="_blank" rel="noreferrer">{language.t("deveagent.mcp.sourceLabel")}</a></Show>
            </div>
            <Show when={entry.description}><div class="mt-1 text-[11px] leading-4 text-v2-text-text-muted">{language.locale().startsWith("zh") ? entry.description : (entry as { descriptionEn?: string }).descriptionEn || entry.description}</div></Show>
            <Show when={entry.remotes.length > 0} fallback={<div class="mt-2 text-[11px] text-amber-700">{language.t("deveagent.mcp.localPackagesReviewHint", { types: entry.packageTypes.join(", ") || language.t("deveagent.mcp.unknownTypes") })}</div>}>
              <div class="mt-2 flex flex-col gap-1.5">
                <For each={entry.remotes}>
                  {(remote) => {
                    const key = () => `${entry.name}:${remote.url}`
                    return (
                      <div class="flex items-center gap-2 rounded border border-v2-border-border-muted px-2 py-1.5">
                        <div class="min-w-0 flex-1">
                          <div class="truncate text-[10px] text-v2-text-text-base">{remote.url}</div>
                          <div class="text-[10px] text-v2-text-text-muted">{remote.type}{remote.requiresSecret ? ` · ${language.t("deveagent.mcp.badgeRequiresSecret")}` : ` · ${language.t("deveagent.mcp.badgeNoSecretRemote")}`}</div>
                        </div>
                        <Button size="small" variant="secondary" disabled={!!adding()} onClick={() => void addRemote(entry, remote, marketSourceName(), false, remote.requiresSecret)}>
                          {adding() === key() ? language.t("deveagent.mcp.adding") : remote.requiresSecret ? language.t("deveagent.mcp.configureFirst") : language.t("deveagent.mcp.add")}
                        </Button>
                      </div>
                    )
                  }}
                </For>
              </div>
            </Show>
          </article>
        )}
      </For>
    </section>
  )
}

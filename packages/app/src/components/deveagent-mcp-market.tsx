import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"

import { Button } from "@opencode-ai/ui/button"
import { useDeveAgentComposerState } from "@/components/deveagent-composer-state"
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
  version?: string
  repositoryUrl?: string
  remotes: McpRemote[]
  packageTypes: string[]
}

type McpRegistryResponse = { servers: McpEntry[]; nextCursor?: string; error?: string }
type McpCategory = "all" | "remote" | "credentials" | "local"
type WorkspaceMcpStatus = { status: "connected" | "disabled" | "failed" | "needs_auth" | "needs_client_registration"; error?: string }
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

const MCP_SOURCE_TABS: Array<{ id: McpMarketSource; name: string; note: string }> = [
  { id: "official", name: "官方 MCP Registry", note: "可直接搜索；无密钥 HTTPS 端点可加入当前工作区。" },
  { id: "tencent", name: "腾讯云 MCP", note: "认证型服务可先写入当前项目为待配置项，凭据仍由用户在原生配置补充。" },
  { id: "aliyun", name: "阿里云 MCP", note: "市场条目通常需要账户授权或密钥；应用内保留待配置入口，不保存凭据。" },
]

// ponytail: keep vendor records descriptive until a documented public endpoint
// and auth/install API exists; never turn a marketplace page into a guessed URL.
const CURATED_MCP: Record<Exclude<McpMarketSource, "official">, McpEntry[]> = {
  tencent: [
    {
      name: "Tencent TKE MCP",
      description: "腾讯云官方 TKE MCP Server。官方页面提供本地 Python 安装和腾讯云凭据配置；应用不会猜测远程地址，也不会代存 SecretId/SecretKey。",
      repositoryUrl: "https://cloud.tencent.com/developer/mcp/server/11804",
      remotes: [],
      packageTypes: ["pip:tke-mcp-server", "需要腾讯云凭据"],
    },
  ],
  aliyun: [
    {
      name: "Alibaba Cloud Native MCP Marketplace",
      description: "阿里云官方原生 MCP 商品市场。商品接入涉及 Marketplace 授权和计量，当前只展示官方入口，不能伪装成通用一键安装。",
      repositoryUrl: "https://bailian.console.aliyun.com/?tab=mcp#/mcp-market",
      remotes: [],
      packageTypes: ["百炼 MCP 市场授权", "需要部署地域与权限"],
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
      showToast({ title: action === "connect" ? "MCP 已连接" : "MCP 已断开", description: name })
    } catch (error) {
      showToast({ variant: "error", title: action === "connect" ? "MCP 连接失败" : "MCP 断开失败", description: error instanceof Error ? error.message : name })
    } finally {
      setMcpAction(undefined)
    }
  }
  const visibleEntries = createMemo(() => {
    const source = marketSource()
    const entries = source === "official" ? registry()?.servers ?? [] : CURATED_MCP[source]
    const queryText = query().trim().toLowerCase()
    const filtered = queryText
      ? entries.filter((entry) => `${entry.name} ${entry.description ?? ""}`.toLowerCase().includes(queryText))
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

  const addRemote = async (entry: McpEntry, remote: McpRemote, validationInProgress = false, configureLater = false) => {
    if (adding() && !validationInProgress) return false
    if (!composer.snapshot().remoteMcp) {
      showToast({ title: "远程 MCP 已关闭", description: "先打开 Skill Store 上方的“远程 MCP”，再加入远程连接。" })
      return false
    }
    if (remote.requiresSecret && !configureLater) {
      showToast({ title: "需要凭据", description: `该服务器要求 ${remote.headerNames.join(", ") || "密钥/OAuth"}；请在应用原生 MCP 配置中添加，市场不会保存密钥。` })
      return false
    }
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
        title: configureLater ? "已加入待配置 MCP" : "已加入当前工作区",
        description: configureLater
          ? `${entry.name} 已写入当前项目但保持禁用。请在原生 MCP 配置中补充授权或密钥后再启用。`
          : `${entry.name} 已作为远程 MCP 加入当前工作区。它不会写入密钥或执行本地包。`,
      })
      await refetchWorkspaceMcpStatus()
      return true
    } catch (error) {
      showToast({ variant: "error", title: "无法加入 MCP", description: error instanceof Error ? error.message : "请求失败" })
      return false
    } finally {
      setAdding(undefined)
    }
  }

  const addDirectRemote = async () => {
    const rawUrl = directUrl().trim()
    if (!rawUrl || adding()) return
    if (!composer.snapshot().remoteMcp) {
      showToast({ title: "远程 MCP 已关闭", description: "先开启远程 MCP，再加入公开 HTTPS 连接。" })
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
      const installed = await addRemote({ name, remotes: [{ type: "streamable-http", url: result.url, requiresSecret: false, headerNames: [] }], packageTypes: [] }, { type: "streamable-http", url: result.url, requiresSecret: false, headerNames: [] }, true)
      if (installed) {
        setDirectName("")
        setDirectUrl("")
      }
    } catch (error) {
      showToast({ variant: "error", title: "无法加入 MCP", description: error instanceof Error ? error.message : "连接地址无效" })
    } finally {
      setAdding(undefined)
    }
  }

  return (
    <section class="flex min-h-0 flex-1 flex-col gap-3 overflow-auto rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-02 p-3">
      <div>
        <div class="flex items-center gap-2">
          <div class="flex-1 text-[13px] font-medium text-v2-text-text-base">MCP 市场</div>
          <span class={`rounded px-1.5 py-0.5 text-[9px] ${marketPreferenceState() === "workspace" ? "bg-green-500/10 text-green-700" : marketPreferenceState() === "loading" ? "bg-amber-500/10 text-amber-800" : "bg-surface-raised-base text-v2-text-text-muted"}`} title={sdk().directory || "未选择工作区"}>
            {marketPreferenceState() === "workspace" ? "项目已保存" : marketPreferenceState() === "loading" ? "正在读取项目设置" : "本地回退"}
          </span>
        </div>
        <div class="mt-1 text-[11px] leading-4 text-v2-text-text-muted">
          搜索官方 MCP Registry。仅可加入不要求密钥的 HTTPS 远程服务；本地包、OAuth 与企业市场条目会保留为可审查信息，不会静默执行安装脚本。
        </div>
      </div>
      <div class="flex gap-2">
        <input
          class="h-8 min-w-0 flex-1 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-2 text-[12px] outline-none focus:border-v2-border-border-focus"
          value={draft()}
          placeholder="搜索 MCP，例如 GitHub、browser、database"
          onInput={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") setQuery(draft().trim())
          }}
        />
        <Button size="small" variant="secondary" onClick={() => setQuery(draft().trim())}>搜索</Button>
      </div>
      <div class="flex flex-wrap gap-1.5">
        {([
          ["all", "全部"],
          ["remote", "可直接加入"],
          ["credentials", "需要凭据"],
          ["local", "本地包"],
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
          远程 MCP 当前关闭。点击开启后，才可以把无密钥的远程服务器加入当前工作区。
        </button>
      </Show>
      <div class="rounded-md border border-v2-border-border-muted bg-v2-background-bg-base p-2.5">
        <div class="text-[11px] font-medium text-v2-text-text-base">从市场连接地址加入</div>
        <div class="mt-1 text-[10px] leading-4 text-v2-text-text-muted">粘贴腾讯、阿里或其他市场提供的公开 HTTPS MCP 地址。应用会先验证公网地址，再仅写入当前工作区的应用 MCP 配置；密钥、OAuth 和本地包仍需在原生配置页处理。</div>
        <div class="mt-2 grid grid-cols-[minmax(0,0.45fr)_minmax(0,1fr)_auto] gap-1.5">
          <input class="h-8 min-w-0 rounded-md border border-v2-border-border-muted bg-surface-base px-2 text-[11px] outline-none focus:border-v2-border-border-focus" value={directName()} placeholder="名称（可选）" onInput={(event) => setDirectName(event.currentTarget.value)} />
          <input class="h-8 min-w-0 rounded-md border border-v2-border-border-muted bg-surface-base px-2 text-[11px] outline-none focus:border-v2-border-border-focus" value={directUrl()} placeholder="https://.../mcp" onInput={(event) => setDirectUrl(event.currentTarget.value)} onKeyDown={(event) => event.key === "Enter" && void addDirectRemote()} />
          <Button size="small" variant="secondary" disabled={!directUrl().trim() || !!adding()} onClick={() => void addDirectRemote()}>{adding() === "direct" ? "验证中" : "加入"}</Button>
        </div>
      </div>
      <Show when={configuredMcpEntries().length > 0}>
        <div class="rounded-md border border-v2-border-border-muted bg-v2-background-bg-base p-2.5">
          <div class="flex items-center justify-between gap-2">
            <div class="text-[11px] font-medium text-v2-text-text-base">当前工作区 MCP</div>
            <Button
              size="small"
              variant="ghost"
              disabled={workspaceMcpStatus.loading}
              onClick={() => void refetchWorkspaceMcpStatus()}
            >
              {workspaceMcpStatus.loading ? "刷新中" : "刷新状态"}
            </Button>
          </div>
          <div class="mt-1 flex flex-col gap-1.5">
            <For each={configuredMcpEntries()}>
              {([name, status]) => (
                <div class="flex items-center gap-2 rounded border border-v2-border-border-muted px-2 py-1.5">
                  <div class="min-w-0 flex-1 truncate text-[10px] text-v2-text-text-base">{name}</div>
                  <span
                    class={`shrink-0 rounded px-1.5 py-0.5 text-[9px] ${
                      status.status === "connected"
                        ? "bg-green-500/10 text-green-700"
                        : status.status === "failed"
                          ? "bg-red-500/10 text-red-700"
                          : "bg-amber-500/10 text-amber-800"
                    }`}
                    title={status.error || status.status}
                  >
                    {status.status === "connected" ? "已连接" : status.status === "needs_auth" ? "需授权" : status.status === "failed" ? "连接失败" : status.status === "disabled" ? "已禁用" : "需注册"}
                  </span>
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={!!mcpAction()}
                    onClick={() => void toggleWorkspaceMcp(name, status)}
                  >
                    {mcpAction() === name ? "处理中" : status.status === "connected" ? "断开" : "连接"}
                  </Button>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
      <div class="flex flex-wrap gap-1.5" role="tablist" aria-label="MCP 市场来源">
        <For each={MCP_SOURCE_TABS}>
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
        {MCP_SOURCE_TABS.find((source) => source.id === marketSource())?.note}
      </div>
      <Show when={marketSource() === "official" && registry.loading}><div class="text-[12px] text-v2-text-text-muted">正在读取官方 Registry...</div></Show>
      <Show when={marketSource() === "official" && registry.error}><div class="text-[12px] text-red-600">{registry.error instanceof Error ? registry.error.message : "Registry 读取失败"}</div></Show>
      <For each={visibleEntries()} fallback={<Show when={marketSource() !== "official" || !registry.loading}><div class="text-[12px] text-v2-text-text-muted">该分类没有可显示的 MCP 元数据。</div></Show>}>
        {(entry) => (
          <article class="rounded-lg border border-v2-border-border-muted bg-v2-background-bg-base p-3">
            <div class="flex items-start gap-2">
              <div class="min-w-0 flex-1">
                <div class="truncate text-[12px] font-medium text-v2-text-text-base">{entry.name}</div>
                <Show when={entry.version}><div class="mt-0.5 text-[10px] text-v2-text-text-muted">{entry.version}</div></Show>
              </div>
              <span class="shrink-0 rounded bg-surface-base px-1.5 py-0.5 text-[9px] text-v2-text-text-muted">{marketSource() === "official" ? "官方 Registry" : marketSource() === "tencent" ? "腾讯云市场" : "阿里云市场"}</span>
              <Show when={entry.repositoryUrl}><a class="text-[11px] text-v2-text-text-accent hover:underline" href={entry.repositoryUrl} target="_blank" rel="noreferrer">来源</a></Show>
            </div>
            <Show when={entry.description}><div class="mt-1 text-[11px] leading-4 text-v2-text-text-muted">{entry.description}</div></Show>
            <Show when={entry.remotes.length > 0} fallback={<div class="mt-2 text-[11px] text-amber-700">仅提供本地包 ({entry.packageTypes.join(", ") || "未知"})，需经过本地安装审查。</div>}>
              <div class="mt-2 flex flex-col gap-1.5">
                <For each={entry.remotes}>
                  {(remote) => {
                    const key = () => `${entry.name}:${remote.url}`
                    return (
                      <div class="flex items-center gap-2 rounded border border-v2-border-border-muted px-2 py-1.5">
                        <div class="min-w-0 flex-1">
                          <div class="truncate text-[10px] text-v2-text-text-base">{remote.url}</div>
                          <div class="text-[10px] text-v2-text-text-muted">{remote.type}{remote.requiresSecret ? " · 需要密钥/OAuth" : " · 无密钥远程端点"}</div>
                        </div>
                        <Button size="small" variant="secondary" disabled={!!adding()} onClick={() => void addRemote(entry, remote, false, remote.requiresSecret)}>
                          {adding() === key() ? "加入中" : remote.requiresSecret ? "需配置" : "加入"}
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

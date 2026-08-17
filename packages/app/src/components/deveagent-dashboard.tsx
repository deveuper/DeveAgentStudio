import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"

import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"
import { createDeveAgentSessionMetrics } from "@/components/deveagent-session-metrics"
import { summarizeDeveAgentCostEntries, type DeveAgentCurrency, type DeveAgentFxRate } from "@/components/deveagent-session-metrics-model"
import { usePrompt } from "@/context/prompt"
import { useFile } from "@/context/file"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { DeveAgentVisionConfigPanel } from "./deveagent-vision-config"
import { DeveAgentSttConfigPanel } from "./deveagent-stt-config"
import { DeveAgentRoleProfilesPanel } from "./deveagent-role-profiles"
import { useLocal } from "@/context/local"
import { useModels } from "@/context/models"
import { useSessionLayout } from "@/pages/session/session-layout"
import { diffs as normalizeDiffs } from "@/utils/diffs"
import { showToast } from "@/utils/toast"
import { createStore } from "solid-js/store"
import { Select } from "@opencode-ai/ui/select"
import { collectDeveAgentMarkItDownEvents } from "./deveagent-markitdown-state"
import { DeveAgentMarkItDownStatus } from "./deveagent-markitdown-status"

const tabLabels = {
  overview: "概览",
  files: "文件",
  changes: "改动",
  codegraph: "CodeGraph",
}

const costCurrencyOptions = ["native", "CNY", "USD", "EUR", "JPY", "KRW", "HKD"] as const
type CostCurrencyOption = (typeof costCurrencyOptions)[number]

function costCurrencyLabel(value: CostCurrencyOption) {
  if (value === "native") return "原币"
  const symbol = value === "CNY" || value === "JPY" ? "¥" : value === "EUR" ? "€" : value === "KRW" ? "₩" : "$"
  return `${symbol} ${value}`
}

function compactTokens(value: number) {
  // Reference-style compact numbers: 50.4K / 128K / 1.5M (one decimal,
  // trailing .0 trimmed). Honest rounding of the real value.
  const trimOne = (n: number) => {
    const r = Math.round(n * 10) / 10
    return Number.isInteger(r) ? String(r) : r.toFixed(1)
  }
  if (value >= 1_000_000) return `${trimOne(value / 1_000_000)}M`
  if (value >= 1_000) return `${trimOne(value / 1_000)}K`
  return value.toLocaleString()
}

type ContextPackFile = {
  path: string
  source: string
  bytes: number
  estimatedTokens: number
  readable: boolean
  reason?: string
  compressed?: boolean
  originalBytes?: number
  originalTokens?: number
  compressionEngine?: string
}

type ContextPack = {
  available: boolean
  engine: string
  generatedAt: string
  files: ContextPackFile[]
  totalEstimatedTokens: number
  totalOriginalTokens?: number
  tokensSaved?: number
  tokenSaverEnabled?: boolean
  warnings: string[]
}

type CodeGraphIndex = {
  engine: string
  generatedAt: string
  outputPath: string
  fileCount: number
  symbolCount: number
  edgeCount: number
  importEdgeCount: number
  callEdgeCount: number
  reusedFileCount: number
  reindexedFileCount: number
  truncated: boolean
  warnings: string[]
}

type CodeGraphIndexStatus = {
  available: boolean
  outputPath: string
  generatedAt?: string
  fileCount: number
  staleFileCount: number
  truncated?: boolean
}

type ReviewScope = {
  available: boolean
  generatedAt: string
  changedFileCount: number
  totalSymbols: number
  files: Array<{
    path: string
    symbols: Array<{ name: string; kind: string; line: number }>
    relatedFiles: Array<{ path: string; score: number }>
  }>
  warnings: string[]
}

type DeveAgentRuntimeState = {
  auxiliary?: {
    vision?: { providerID: string; modelID: string }
    visionChain?: Array<{ providerID: string; modelID: string }>
    fallbackChain?: Array<{ providerID: string; modelID: string }>
    speech?: { providerID: string; modelID: string }
  }
}

type DeveAgentSessionAuxiliaryState = {
  auxiliary?: DeveAgentRuntimeState["auxiliary"]
  overridden?: boolean
}

type GrillingState = {
  started: boolean
  completed?: boolean
  startedAt?: string
  completedAt?: string
  elapsedMs?: number
  decisionCount: number
}

function formatElapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

async function readCodeGraphResponse<T>(response: Response, label: string): Promise<T> {
  const payload = await response.json().catch(() => undefined)
  if (!response.ok) {
    const detail =
      payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : undefined
    throw new Error(detail || `${label} (HTTP ${response.status})`)
  }
  if (payload === undefined) throw new Error(`${label}: empty response`)
  return payload as T
}

export function DeveagentDashboard() {
  const [activeTab, setActiveTab] = createSignal("overview")
  const [preferences, setPreferences] = persisted(
    Persist.global("deveagent.dashboard", ["deveagent.dashboard.v1"]),
    createStore<{ displayCurrency: "native" | DeveAgentCurrency }>({ displayCurrency: "native" }),
  )
  const displayCurrency = () => preferences.displayCurrency
  const setDisplayCurrency = (currency: "native" | DeveAgentCurrency) => setPreferences("displayCurrency", currency)
  const updateDisplayCurrency = (value: string) => {
    if (value === "native" || ["USD", "CNY", "EUR", "JPY", "KRW", "HKD"].includes(value)) {
      setDisplayCurrency(value as "native" | DeveAgentCurrency)
    }
  }
  const language = useLanguage()
  const sessionMetrics = createDeveAgentSessionMetrics()
  const prompt = usePrompt()
  const file = useFile()
  const sync = useSync()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const local = useLocal()
  const models = useModels()
  const { params, tabs, view } = useSessionLayout()
  const [contextPack, setContextPack] = createSignal<ContextPack | undefined>()
  const [contextPackError, setContextPackError] = createSignal<string | undefined>()
  const [contextPackLoading, setContextPackLoading] = createSignal(false)
  const [graphIndex, setGraphIndex] = createSignal<CodeGraphIndex | undefined>()
  const [graphIndexError, setGraphIndexError] = createSignal<string | undefined>()
  const [graphIndexStatus, setGraphIndexStatus] = createSignal<CodeGraphIndexStatus | undefined>()
  const [graphIndexStatusError, setGraphIndexStatusError] = createSignal<string | undefined>()
  const [graphIndexStatusLoading, setGraphIndexStatusLoading] = createSignal(false)
  const [indexing, setIndexing] = createSignal(false)
  const [reviewScope, setReviewScope] = createSignal<ReviewScope | undefined>()
  const [reviewScopeError, setReviewScopeError] = createSignal<string | undefined>()
  const [scopingReview, setScopingReview] = createSignal(false)
  const [fallbackCandidate, setFallbackCandidate] = createSignal("")
  const [visionCandidate, setVisionCandidate] = createSignal("")
  const [savingFallbackChain, setSavingFallbackChain] = createSignal(false)
  const [savingVisionChain, setSavingVisionChain] = createSignal(false)
  const [savingSpeechModel, setSavingSpeechModel] = createSignal(false)
  const [compacting, setCompacting] = createSignal(false)
  const [grillingClock, setGrillingClock] = createSignal(Date.now())
  const [runtimeState, { refetch: refetchRuntimeState }] = createResource(
    () => serverSDK().url,
    async (base): Promise<DeveAgentRuntimeState | undefined> => {
      try {
        const response = await serverSDK().fetch(`${base.replace(/\/+$/, "")}/api/deveagent/state`)
        if (!response.ok) return undefined
        return (await response.json()) as DeveAgentRuntimeState
      } catch {
        return undefined
      }
    },
  )
  const [sessionAuxiliary, { refetch: refetchSessionAuxiliary }] = createResource(
    () => (params.id ? { base: serverSDK().url, sessionID: params.id } : undefined),
    async (input): Promise<DeveAgentSessionAuxiliaryState | undefined> => {
      try {
        const response = await serverSDK().fetch(
          `${input.base.replace(/\/+$/, "")}/api/deveagent/auxiliary?sessionID=${encodeURIComponent(input.sessionID)}`,
        )
        if (!response.ok) return undefined
        return (await response.json()) as DeveAgentSessionAuxiliaryState
      } catch {
        return undefined
      }
    },
  )
  let lastContextPackSignature = ""
  let lastContextPackDirectory = ""
  let contextPackRequest = 0
  let lastGraphStatusDirectory = ""
  let graphStatusRequest = 0
  let graphIndexRequest = 0

  const refreshGraphIndexStatus = async (directory: string) => {
    const requestID = ++graphStatusRequest
    setGraphIndexStatusLoading(true)
    setGraphIndexStatusError(undefined)
    try {
      const response = await serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/codegraph/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directory }),
      })
      const status = await readCodeGraphResponse<CodeGraphIndexStatus>(response, "CodeGraph 状态读取失败")
      if (requestID !== graphStatusRequest || sdk().directory !== directory) return
      setGraphIndexStatus(status)
    } catch (error) {
      if (requestID !== graphStatusRequest || sdk().directory !== directory) return
      setGraphIndexStatus(undefined)
      setGraphIndexStatusError(error instanceof Error ? error.message : "CodeGraph 状态读取失败")
    } finally {
      if (requestID === graphStatusRequest) setGraphIndexStatusLoading(false)
    }
  }

  onMount(() => {
    const handleTab = (event: Event) => {
      const value = (event as CustomEvent).detail
      if (value === "overview" || value === "files" || value === "changes" || value === "codegraph") {
        setActiveTab(value)
      }
    }
    window.addEventListener("deveagent:dashboard-tab", handleTab)
    const timer = window.setInterval(() => setGrillingClock(Date.now()), 1_000)
    onCleanup(() => {
      window.removeEventListener("deveagent:dashboard-tab", handleTab)
      window.clearInterval(timer)
    })
  })

  const [grilling, { refetch: refetchGrilling }] = createResource(
    () =>
      params.id
        ? { base: serverSDK().url, sessionID: params.id, revision: Math.floor(grillingClock() / 5_000) }
        : undefined,
    async (input): Promise<GrillingState> => {
      try {
        const response = await serverSDK().fetch(
          `${input.base.replace(/\/+$/, "")}/api/deveagent/grilling?sessionID=${encodeURIComponent(input.sessionID)}`,
        )
        if (!response.ok) return { started: false, decisionCount: 0 }
        return (await response.json()) as GrillingState
      } catch {
        return { started: false, decisionCount: 0 }
      }
    },
  )
  const grillingDuration = createMemo(() => {
    const value = grilling()
    if (!value?.started) return ""
    const startedAt = value.startedAt ? Date.parse(value.startedAt) : NaN
    const endedAt = value.completedAt ? Date.parse(value.completedAt) : grillingClock()
    return Number.isFinite(startedAt) ? formatElapsed(endedAt - startedAt) : ""
  })

  type PrefixShapeState = {
    systemHash: string | null
    toolsHash: string | null
    lastReason: "none" | "system" | "tools" | "system+tools"
    changes: number
    lastChangedAt: number | null
  }
  const [cacheShape] = createResource(
    () =>
      params.id
        ? { base: serverSDK().url, sessionID: params.id, revision: Math.floor(grillingClock() / 10_000) }
        : undefined,
    async (input): Promise<PrefixShapeState | null> => {
      try {
        const response = await serverSDK().fetch(
          `${input.base.replace(/\/+$/, "")}/api/deveagent/cache-shape?sessionID=${encodeURIComponent(input.sessionID)}`,
        )
        if (!response.ok) return null
        const data = (await response.json()) as { shape?: PrefixShapeState | null }
        return data.shape ?? null
      } catch {
        return null
      }
    },
  )
  const shapeReasonLabel = (reason: PrefixShapeState["lastReason"]) =>
    reason === "system" ? "系统提示" : reason === "tools" ? "工具集" : reason === "system+tools" ? "系统+工具" : "无"
  const [completingGrilling, setCompletingGrilling] = createSignal(false)
  const completeGrillingInterview = async () => {
    if (!params.id || completingGrilling() || grilling()?.completed) return
    setCompletingGrilling(true)
    try {
      const response = await serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/grilling/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionID: params.id }),
      })
      const result = (await response.json().catch(() => ({}))) as { completed?: boolean; error?: string }
      if (!response.ok || result.error) throw new Error(result.error || `HTTP ${response.status}`)
      await refetchGrilling()
      showToast({ title: "Grilling 已结束", description: "采访计时和已确认决策已保留；导出仍需通过原生权限确认。" })
    } catch (error) {
      showToast({ variant: "error", title: "无法结束 Grilling", description: error instanceof Error ? error.message : "请求失败" })
    } finally {
      setCompletingGrilling(false)
    }
  }

  const compactSession = async () => {
    if (!params.id || compacting()) return
    const model = local.model.current()
    if (!model) {
      showToast({ title: "没有可用模型", description: "请先在输入框中选择一个已连接的模型。" })
      return
    }
    setCompacting(true)
    try {
      await sdk().client.session.summarize({
        sessionID: params.id,
        modelID: model.id,
        providerID: model.provider.id,
      })
      showToast({ title: "上下文压缩已完成", description: "已用摘要替换旧上下文，当前会话仍保留。" })
    } catch (error) {
      showToast({ variant: "error", title: "上下文压缩失败", description: error instanceof Error ? error.message : "请求失败" })
    } finally {
      setCompacting(false)
    }
  }

  const number = createMemo(() => new Intl.NumberFormat(language.intl()))
  const formatTimestamp = (value: number | string | undefined) => {
    const timestamp = typeof value === "number" ? value : value ? Date.parse(value) : NaN
    return Number.isFinite(timestamp)
      ? new Intl.DateTimeFormat(language.intl(), { dateStyle: "short", timeStyle: "short" }).format(new Date(timestamp))
      : ""
  }
  const percent = (value: number) =>
    value.toLocaleString(language.intl(), {
      maximumFractionDigits: 2,
    })
  const hasTaskAggregate = () => sessionMetrics.hasTaskAggregate()
  const contextUsage = () => Math.max(0, Math.min(100, sessionMetrics.contextUsage()))
  const cacheHitRate = () => Math.max(0, Math.min(100, sessionMetrics.cacheHitRate()))
  const fallbackChain = createMemo(() => runtimeState()?.auxiliary?.fallbackChain ?? [])
  const visionChain = createMemo(() => sessionAuxiliary()?.auxiliary?.visionChain ?? runtimeState()?.auxiliary?.visionChain ?? [])
  const speechModel = createMemo(() => runtimeState()?.auxiliary?.speech)
  const speechModelValue = createMemo(() => {
    const current = speechModel()
    return current ? `${current.providerID}/${current.modelID}` : ""
  })
  const availableFallbackModels = createMemo(() => {
    const primary = local.model.current()
    const configured = new Set(fallbackChain().map((model) => `${model.providerID}/${model.modelID}`))
    return models
      .list()
      .filter((model) => {
        const key = `${model.provider.id}/${model.id}`
        return !configured.has(key) && !(primary?.provider.id === model.provider.id && primary.id === model.id)
      })
      .slice(0, 200)
  })
  const availableVisionModels = createMemo(() => {
    const configured = new Set(visionChain().map((model) => `${model.providerID}/${model.modelID}`))
    return models
      .list()
      .filter((model) => model.capabilities.input.image && !configured.has(`${model.provider.id}/${model.id}`))
      .slice(0, 200)
  })
  const contextLimitLabel = () => {
    const limit = sessionMetrics.contextLimit()
    return limit ? `${compactTokens(limit)} tokens` : "未知上限"
  }
  const displayMoney = (currency: string, amount: number) =>
    new Intl.NumberFormat(language.intl(), {
      style: "currency",
      currency,
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    }).format(amount)
  const targetCostCurrency = createMemo<DeveAgentCurrency | undefined>(() => {
    const selected = displayCurrency()
    return selected === "native" ? undefined : selected
  })
  const fxPairKey = createMemo(() => {
    const to = targetCostCurrency()
    if (!to) return ""
    return [...new Set(sessionMetrics.costEntries().map((entry) => entry.currency).filter((from): from is DeveAgentCurrency => Boolean(from) && from !== to))]
      .sort()
      .map((from) => `${from}:${to}`)
      .join(",")
  })
  const [fxRates] = createResource(
    fxPairKey,
    async (key): Promise<DeveAgentFxRate[]> => {
      if (!key) return []
      const pairs = key.split(",").map((value) => {
        const [from, to] = value.split(":") as [DeveAgentCurrency, DeveAgentCurrency]
        return { from, to }
      })
      const results = await Promise.all(
        pairs.map(async (pair) => {
          try {
            const response = await fetch(`https://api.frankfurter.dev/v2/rate/${pair.from}/${pair.to}?providers=ECB`)
            if (!response.ok) return undefined
            const payload = (await response.json()) as { rate?: unknown; date?: unknown }
            if (typeof payload.rate !== "number" || !Number.isFinite(payload.rate) || payload.rate <= 0) return undefined
            return {
              ...pair,
              rate: payload.rate,
              source: "ECB via Frankfurter",
              timestamp: typeof payload.date === "string" ? payload.date : new Date().toISOString(),
            }
          } catch {
            return undefined
          }
        }),
      )
      return results.filter((item): item is DeveAgentFxRate => Boolean(item))
    },
  )
  const selectedCostView = createMemo(() => summarizeDeveAgentCostEntries(sessionMetrics.costEntries(), targetCostCurrency(), fxRates() ?? []))
  const costLabel = () => {
    const cost = selectedCostView()
    if (!cost.hasCost) return "未返回"
    const target = targetCostCurrency()
    if (!target) return cost.groups.map((item) => displayMoney(item.currency, item.amount)).join(" + ")
    if (cost.convertedAmount === undefined) return `${target} 未接入`
    return `${displayMoney(target, cost.convertedAmount)}${cost.missingConversions ? ` + ${cost.missingConversions} 项未折算` : ""}`
  }
  const conversionLabel = () => {
    const target = targetCostCurrency()
    const cost = selectedCostView()
    if (!cost.hasCost) return "暂无可用用量数据"
    const entries = sessionMetrics.costEntries()
    const providerReturned = entries.some((entry) => entry.source === "provider")
    const estimated = entries.some((entry) => entry.source !== "provider")
    const source = providerReturned
      ? estimated
        ? "部分 provider 请求费用 + 模型目录估算"
        : "provider 返回的请求费用（非账户账单）"
      : "模型目录估算（非账户账单）"
    if (!target) return `${source}（按模型原币分项）`
    const rate = fxRates()?.[0]
    if (cost.missingConversions) return `${source} · ${cost.missingConversions} 个原币种没有可用实时汇率`
    return rate ? `${source} · 折算: ${rate.source} ${rate.timestamp}` : source
  }
  const contextFiles = createMemo(() =>
    prompt
      .context
      .items()
      .filter((item) => item.type === "file" && !!item.path)
      .map((item) => ({
        key: item.key,
        path: item.path!,
        source: item.comment ? "评论/审查" : "上下文",
      })),
  )
  const openFiles = createMemo(() => {
    const seen = new Set(contextFiles().map((item) => item.path))
    return tabs()
      .tabs()
      .all.flatMap((tab) => {
        const path = file.pathFromTab(tab)
        if (!path || seen.has(path)) return []
        seen.add(path)
        return [{ key: `tab:${tab}`, path, source: "已打开" }]
      })
  })
  const files = createMemo(() => [...contextFiles(), ...openFiles()])
  const packedFile = (value: string) => contextPack()?.files.find((item) => item.path === value.replaceAll("\\", "/"))
  const changes = createMemo(() => (params.id ? normalizeDiffs(sync().data.session_diff[params.id]).filter((item) => !!item.file) : []))
  const markitdownEvents = createMemo(() => {
    const sessionID = params.id
    if (!sessionID) return []
    return collectDeveAgentMarkItDownEvents(sync().data.message[sessionID] ?? [], (messageID) => sync().data.part[messageID] ?? [])
  })
  createEffect(() => {
    const directory = sdk().directory
    if (directory !== lastContextPackDirectory) {
      lastContextPackDirectory = directory || ""
      contextPackRequest++
      lastContextPackSignature = ""
      setContextPack(undefined)
      setContextPackError(undefined)
      setContextPackLoading(false)
    }
    if (!directory) return
    const payloadFiles = [
      ...files().map((item) => ({ path: item.path, source: item.source })),
      ...changes().flatMap((item) => (item.file ? [{ path: item.file, source: "改动" }] : [])),
    ].slice(0, 40)
    const signature = JSON.stringify({ directory, files: payloadFiles.map((item) => `${item.source}:${item.path}`) })
    if (signature === lastContextPackSignature) return
    lastContextPackSignature = signature
    const requestID = ++contextPackRequest
    setContextPackError(undefined)
    setContextPackLoading(true)
    const base = serverSDK().url.replace(/\/+$/, "")
    void serverSDK().fetch(`${base}/api/deveagent/codegraph/context-pack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionID: params.id,
        directory,
        files: payloadFiles,
        maxFiles: 40,
      }),
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<ContextPack>
      })
      .then((pack) => {
        if (requestID !== contextPackRequest) return
        setContextPack(pack)
      })
      .catch((error) => {
        if (requestID !== contextPackRequest) return
        setContextPackError(error instanceof Error ? error.message : "context pack failed")
      })
      .finally(() => {
        if (requestID === contextPackRequest) setContextPackLoading(false)
      })
  })
  createEffect(() => {
    if (activeTab() !== "codegraph") {
      lastGraphStatusDirectory = ""
      return
    }
    const directory = sdk().directory
    if (directory === lastGraphStatusDirectory) return
    lastGraphStatusDirectory = directory || ""
    setGraphIndex(undefined)
    setGraphIndexStatus(undefined)
    setGraphIndexError(undefined)
    setGraphIndexStatusError(undefined)
    if (!directory) {
      graphStatusRequest++
      setGraphIndexStatusLoading(false)
      return
    }
    void refreshGraphIndexStatus(directory)
  })
  const openFile = (path: string) => {
    const tab = file.tab(path)
    void tabs().open(tab)
    void file.load(path)
    tabs().setActive(tab)
  }
  const openChange = (path: string) => {
    view().reviewPanel.open()
    view().review.openPath(path)
  }
  const saveFallbackChain = async (next: Array<{ providerID: string; modelID: string }>) => {
    if (savingFallbackChain()) return
    setSavingFallbackChain(true)
    try {
      const response = await serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/auxiliary`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fallbackChain: next }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      await refetchRuntimeState()
      setFallbackCandidate("")
      showToast({ title: "Fallback chain 已保存", description: next.length ? `已配置 ${next.length} 个候选模型。` : "已清空 fallback chain。" })
    } catch (error) {
      showToast({ variant: "error", title: "无法保存 fallback chain", description: error instanceof Error ? error.message : "请求失败" })
    } finally {
      setSavingFallbackChain(false)
    }
  }
  const addFallbackCandidate = () => {
    const value = fallbackCandidate()
    const separator = value.indexOf("/")
    if (separator <= 0 || fallbackChain().length >= 4) return
    const providerID = value.slice(0, separator)
    const modelID = value.slice(separator + 1)
    if (!providerID || !modelID) return
    void saveFallbackChain([...fallbackChain(), { providerID, modelID }])
  }
  const saveSessionVisionChain = async (next: Array<{ providerID: string; modelID: string }>) => {
    if (!params.id || savingVisionChain()) return
    setSavingVisionChain(true)
    try {
      const response = await serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/auxiliary`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionID: params.id, visionChain: next }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      await refetchSessionAuxiliary()
      setVisionCandidate("")
      showToast({ title: "会话视觉链已保存", description: next.length ? `图片将按顺序尝试 ${next.length} 个视觉模型。` : "当前会话不再指定视觉候选。" })
    } catch (error) {
      showToast({ variant: "error", title: "无法保存会话视觉链", description: error instanceof Error ? error.message : "请求失败" })
    } finally {
      setSavingVisionChain(false)
    }
  }
  const addVisionCandidate = () => {
    const value = visionCandidate()
    const separator = value.indexOf("/")
    if (separator <= 0) return
    const providerID = value.slice(0, separator)
    const modelID = value.slice(separator + 1)
    if (!providerID || !modelID) return
    void saveSessionVisionChain([...visionChain(), { providerID, modelID }])
  }
  const resetSessionVisionChain = async () => {
    if (!params.id || savingVisionChain()) return
    setSavingVisionChain(true)
    try {
      const response = await serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/auxiliary`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionID: params.id, reset: true }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      await refetchSessionAuxiliary()
      setVisionCandidate("")
      showToast({ title: "已恢复全局视觉配置" })
    } catch (error) {
      showToast({ variant: "error", title: "无法恢复全局视觉配置", description: error instanceof Error ? error.message : "请求失败" })
    } finally {
      setSavingVisionChain(false)
    }
  }
  const saveSpeechModel = async (value: string) => {
    if (savingSpeechModel()) return
    const separator = value.indexOf("/")
    const speech =
      separator > 0
        ? { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) }
        : null
    setSavingSpeechModel(true)
    try {
      const response = await serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/auxiliary`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ speech }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      await refetchRuntimeState()
      showToast({
        title: speech ? "语音模型已保存" : "已使用本机语音识别",
        description: speech ? `${speech.providerID}/${speech.modelID}` : "未配置远程 STT 时使用 Chromium Web Speech。",
      })
    } catch (error) {
      showToast({ variant: "error", title: "无法保存语音模型", description: error instanceof Error ? error.message : "请求失败" })
    } finally {
      setSavingSpeechModel(false)
    }
  }
  const refreshGraphIndex = async () => {
    const directory = sdk().directory
    if (!directory || indexing()) return
    const requestID = ++graphIndexRequest
    setIndexing(true)
    setGraphIndexError(undefined)
    setGraphIndexStatusError(undefined)
    try {
      const response = await serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/codegraph/index`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directory }),
      })
      const result = await readCodeGraphResponse<CodeGraphIndex & { error?: string }>(response, "CodeGraph 索引刷新失败")
      if (result.error) throw new Error(result.error)
      if (requestID !== graphIndexRequest || sdk().directory !== directory) return
      setGraphIndex(result)
      setGraphIndexStatus({
        available: true,
        outputPath: result.outputPath,
        generatedAt: result.generatedAt,
        fileCount: result.fileCount,
        staleFileCount: 0,
        truncated: result.truncated,
      })
    } catch (error) {
      if (requestID === graphIndexRequest && sdk().directory === directory) {
        setGraphIndexError(error instanceof Error ? error.message : "CodeGraph 索引刷新失败")
      }
    } finally {
      if (requestID === graphIndexRequest) setIndexing(false)
    }
  }
  const createReviewScope = async () => {
    const directory = sdk().directory
    if (!directory || scopingReview()) return
    let changedFiles = changes().flatMap((item) => item.file ? [item.file] : [])
    // The session.diff event stream may not have delivered yet (it is async);
    // fall back to the session diff API so the review scope is still usable.
    if (changedFiles.length === 0 && params.id) {
      try {
        const diffUrl = new URL(`/session/${encodeURIComponent(params.id)}/diff`, serverSDK().url)
        diffUrl.searchParams.set("directory", directory)
        const diffResponse = await serverSDK().fetch(diffUrl.toString())
        if (diffResponse.ok) {
          const diffData = (await diffResponse.json()) as Array<{ file?: string }>
          changedFiles = diffData.flatMap((item) => (item.file ? [item.file] : []))
        }
      } catch {
        // keep the empty list; the scope request will report the problem
      }
    }
    setScopingReview(true)
    setReviewScopeError(undefined)
    try {
      const response = await serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/codegraph/review-scope`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directory, changedFiles }),
      })
      const result = (await response.json()) as ReviewScope & { error?: string }
      if (!response.ok || result.error) throw new Error(result.error || `HTTP ${response.status}`)
      setReviewScope(result)
    } catch (error) {
      setReviewScopeError(error instanceof Error ? error.message : "review scope failed")
    } finally {
      setScopingReview(false)
    }
  }

  return (
    <div class="flex h-full min-h-0 w-full min-w-0 max-w-full flex-col gap-3 overflow-y-auto overscroll-contain p-3 pb-8 text-[13px] text-v2-text-text-base">
      <div class="flex border-b border-v2-border-border-base">
        {Object.entries(tabLabels).map(([key, label]) => (
          <button
            class={`flex-1 py-2 text-[12px] text-center border-b-2 transition-colors ${
              activeTab() === key
                ? "text-v2-text-text-base font-medium"
                : "border-transparent text-v2-text-text-muted hover:text-v2-text-text-base"
            }`}
            style={activeTab() === key ? { "border-bottom-color": "#fa8c16" } : undefined}
            onClick={() => setActiveTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <Switch>
        <Match when={activeTab() === "overview"}>
       <div class="flex flex-col gap-3 p-4 bg-v2-background-bg-layer-02 rounded-lg border border-v2-border-border-base">
        <div class="flex w-full items-center justify-between gap-2">
          <span class="flex items-center gap-2">
            <span class="rounded px-1.5 py-0.5 text-[11px] font-medium"
              style={!sessionMetrics.hasContext()
                ? { background: "var(--v2-background-bg-layer-03)", color: "var(--v2-text-text-muted)" }
                : contextUsage() > 80
                  ? { background: "var(--v2-state-bg-danger)", color: "var(--v2-state-fg-danger)" }
                  : contextUsage() > 50
                    ? { background: "var(--v2-state-bg-warning)", color: "var(--v2-state-fg-warning)" }
                    : { background: "var(--v2-state-bg-success)", color: "var(--v2-state-fg-success)" }}>
              {!sessionMetrics.hasContext() ? "等待返回" : contextUsage() > 80 ? "即将溢出" : contextUsage() > 50 ? "接近阈值" : "上下文充足"}
            </span>
            <span class="text-[11px] uppercase tracking-wide text-v2-text-text-muted">{hasTaskAggregate() ? "当前任务累计（含子代理）" : "上下文窗口"}</span>
          </span>
          <span class="text-[12px] tabular-nums text-v2-text-text-base">
            {hasTaskAggregate() ? compactTokens(sessionMetrics.sessionTotalTokens()) : sessionMetrics.hasContext() ? `${compactTokens(sessionMetrics.totalTokens())}/${compactTokens(sessionMetrics.contextLimit() ?? 0)}` : "--"}
          </span>
        </div>
        <div class="relative h-2">
          <div class="relative h-full w-full overflow-hidden rounded-full bg-v2-border-border-muted">
            <div
              class="h-full rounded-full transition-all duration-500"
              style={{
                width: sessionMetrics.hasContext() ? contextUsage() + "%" : "0%",
                background: contextUsage() > 80 ? "var(--v2-state-fg-danger)" : "linear-gradient(90deg, #fa8c16, #f5a623)",
              }}
            />
          </div>
          <Show when={sessionMetrics.hasContext()}>
            {/* Reference-style: the used percentage rides on the segment's
                right edge; the compression distance stays below on the right. */}
            <span
              class="absolute top-1/2 z-10 -translate-y-1/2 rounded-[3px] px-1 text-[10px] font-medium leading-[14px] tabular-nums text-white"
              style={{
                left: `${Math.max(contextUsage(), 6)}%`,
                transform: "translateX(-100%) translateY(-50%)",
                background: contextUsage() > 80 ? "var(--v2-state-fg-danger)" : "linear-gradient(90deg, #fa8c16, #f5a623)",
              }}
            >
              {Math.round(contextUsage())}%
            </span>
          </Show>
        </div>
        <div class="flex items-center justify-end text-[11px] text-v2-text-text-muted">
          <span>距压缩 {sessionMetrics.hasContext() && sessionMetrics.contextLimit() ? compactTokens(sessionMetrics.contextLimit()! - sessionMetrics.totalTokens()) : "--"}</span>
        </div>
        <div class="flex w-full items-center justify-end gap-1 border-t border-v2-border-border-muted pt-2">
          <Show when={hasTaskAggregate()}>
            <button
              type="button"
              class="rounded border border-v2-border-border-base px-1.5 py-0.5 text-[10px] text-v2-text-text-muted hover:bg-surface-base-hover hover:text-v2-text-text-base"
              onClick={sessionMetrics.refreshTaskMetrics}
            >
              刷新任务累计
            </button>
          </Show>
          <Show when={params.id}>
            <button
              type="button"
              class="rounded border border-v2-border-border-base px-1.5 py-0.5 text-[10px] text-v2-text-text-muted hover:bg-surface-base-hover hover:text-v2-text-text-base disabled:opacity-50"
              disabled={compacting()}
              onClick={() => void compactSession()}
            >
              {compacting() ? "压缩中…" : "压缩上下文"}
            </button>
          </Show>
        </div>
        <div class="flex gap-3 text-[11px] text-v2-text-text-muted">
          <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-v2-state-fg-success inline-block" /> 提示词 {number().format(hasTaskAggregate() ? sessionMetrics.sessionInputTokens() : sessionMetrics.inputTokens())}</span>
          <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-v2-text-text-accent inline-block" /> 回复 {number().format(hasTaskAggregate() ? sessionMetrics.sessionOutputTokens() : sessionMetrics.outputTokens())}</span>
          <Show when={sessionMetrics.teamUsage().tokens > 0}>
            <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-v2-state-fg-warning inline-block" /> 子代理 {number().format(sessionMetrics.teamUsage().tokens)}</span>
          </Show>
        </div>
      </div>

      <div class="flex flex-col gap-3 p-4 bg-v2-background-bg-layer-02 rounded-lg border border-v2-border-border-base">
        <div class="text-[11px] uppercase tracking-wide text-v2-text-text-muted">会话指标</div>
        <div class="grid grid-cols-2 gap-x-4 gap-y-3">
          <div>
            <div class="text-[11px] text-v2-text-text-muted">平均命中</div>
            <div class="text-[17px] font-semibold tabular-nums" style={{ color: !sessionMetrics.hasUsage() ? "var(--v2-text-text-faint)" : "var(--v2-state-fg-success)" }}>
              {sessionMetrics.hasUsage() ? `${percent(cacheHitRate())}%` : "--"}
            </div>
          </div>
          <div>
            <div class="text-[11px] text-v2-text-text-muted">会话费用</div>
            <div class="text-[17px] font-semibold tabular-nums text-v2-text-text-base">{costLabel()}</div>
          </div>
          <div>
            <div class="text-[11px] text-v2-text-text-muted">运行时间</div>
            <div class="text-[17px] font-semibold tabular-nums text-v2-text-text-base">
              {(() => {
                const elapsed = sessionMetrics.taskTiming().elapsedMs
                return sessionMetrics.hasTaskAggregate() && elapsed !== undefined ? formatElapsed(elapsed) : "--"
              })()}
            </div>
          </div>
          <div>
            <div class="text-[11px] text-v2-text-text-muted">请求数</div>
            <div class="text-[17px] font-semibold tabular-nums text-v2-text-text-base">{sessionMetrics.rounds()}</div>
          </div>
        </div>
        <div class="border-t border-v2-border-border-muted pt-2 text-center">
          <div class="text-[11px] text-v2-text-text-muted">累计 tokens</div>
          <div class="text-[17px] font-semibold tabular-nums text-v2-text-text-base">{number().format(sessionMetrics.sessionTotalTokens())}</div>
        </div>
      </div>

      <div class="flex flex-col gap-3 p-4 bg-v2-background-bg-layer-02 rounded-lg border border-v2-border-border-base">
        <div class="text-[11px] uppercase tracking-wide text-v2-text-text-muted">用量分析</div>
        <Show
          when={sessionMetrics.hasUsage() && (sessionMetrics.sessionTotalTokens() > 0 || sessionMetrics.teamUsage().tokens > 0)}
          fallback={<div class="text-[11px] text-v2-text-text-muted">等待模型返回</div>}
        >
          <div class="flex h-2.5 overflow-hidden rounded-full">
            <div
              class="h-full transition-all duration-500"
              style={{
                width: sessionMetrics.sessionTotalTokens() + sessionMetrics.teamUsage().tokens > 0 ? `${(sessionMetrics.sessionTotalTokens() / (sessionMetrics.sessionTotalTokens() + sessionMetrics.teamUsage().tokens)) * 100}%` : "0%",
                background: "#08979c",
              }}
            />
            <div
              class="h-full transition-all duration-500"
              style={{
                width: sessionMetrics.sessionTotalTokens() + sessionMetrics.teamUsage().tokens > 0 ? `${(sessionMetrics.teamUsage().tokens / (sessionMetrics.sessionTotalTokens() + sessionMetrics.teamUsage().tokens)) * 100}%` : "0%",
                background: "#fa8c16",
              }}
            />
          </div>
          <div class="flex flex-col gap-1 text-[11px] text-v2-text-text-muted">
            <span class="flex items-center gap-1"><span class="size-2 rounded-full" style={{ background: "#08979c" }} /> 主模型 {Math.round((sessionMetrics.sessionTotalTokens() / (sessionMetrics.sessionTotalTokens() + sessionMetrics.teamUsage().tokens)) * 100)}%</span>
            <span class="flex items-center gap-1"><span class="size-2 rounded-full" style={{ background: "#fa8c16" }} /> 子代理 {Math.round((sessionMetrics.teamUsage().tokens / (sessionMetrics.sessionTotalTokens() + sessionMetrics.teamUsage().tokens)) * 100)}%</span>
          </div>
          <div class="flex flex-col gap-1.5 border-t border-v2-border-border-muted pt-2">
            <div class="flex items-center justify-between text-[12px]">
              <span class="flex items-center gap-1.5"><span class="size-2 rounded-full" style={{ background: "#08979c" }} /> <span class="text-v2-text-text-base">主模型</span></span>
              <span class="text-v2-text-text-muted">{number().format(sessionMetrics.sessionTotalTokens())}</span>
            </div>
            <div class="flex items-center justify-between text-[12px]">
              <span class="flex items-center gap-1.5"><span class="size-2 rounded-full" style={{ background: "#fa8c16" }} /> <span class="text-v2-text-text-base">子代理</span></span>
              <span class="text-v2-text-text-muted">{number().format(sessionMetrics.teamUsage().tokens)}</span>
            </div>
          </div>
        </Show>
      </div>

      <div class="p-4 bg-v2-background-bg-layer-02 rounded-lg border border-v2-border-border-base">
        <div class="text-[11px] uppercase tracking-wide text-v2-text-text-faint mb-1">
          缓存命中率
        </div>
        <div
          class="text-[28px] font-bold tabular-nums"
          style={{
            color: !sessionMetrics.hasUsage()
              ? "var(--v2-text-text-faint)"
              : cacheHitRate() >= 80
                ? "var(--v2-state-fg-success)"
                : cacheHitRate() >= 40
                  ? "var(--v2-state-fg-warning)"
                  : "var(--v2-state-fg-danger)",
          }}
        >
          {sessionMetrics.hasUsage() ? `${percent(cacheHitRate())}%` : "--"}
        </div>
        <div class="h-1.5 bg-v2-border-border-muted rounded-full mt-2 overflow-hidden">
          <div
            class="h-full rounded-full transition-all duration-500"
            style={{
              width: sessionMetrics.hasUsage() ? cacheHitRate() + "%" : "0%",
              // The bar color must agree with the number's state above: the
              // old always-green-to-amber gradient showed green for a rate the
              // number painted red (honest visual state).
              background: !sessionMetrics.hasUsage()
                ? "var(--v2-border-border-muted)"
                : cacheHitRate() >= 80
                  ? "var(--v2-state-fg-success)"
                  : cacheHitRate() >= 40
                    ? "var(--v2-state-fg-warning)"
                    : "var(--v2-state-fg-danger)",
            }}
          />
        </div>
        <div class="mt-2 text-[11px] text-v2-text-text-muted">
          {sessionMetrics.hasUsage()
            ? `会话读/写 ${number().format(sessionMetrics.sessionCacheReadTokens())} / ${number().format(sessionMetrics.sessionCacheWriteTokens())}`
            : "等待模型返回"}
        </div>
        <Show when={cacheShape()?.lastReason !== undefined && cacheShape()!.lastReason !== "none"}>
          <div class="mt-1.5 text-[10px] text-v2-text-text-muted">
            前缀形状变化: {shapeReasonLabel(cacheShape()!.lastReason)} · 共 {cacheShape()!.changes} 次{cacheShape()!.lastChangedAt ? ` · ${formatTimestamp(cacheShape()!.lastChangedAt ?? undefined)}` : ""}
          </div>
          <div class="mt-0.5 text-[9px] text-v2-text-text-faint">
            仅表示前缀（系统+工具）变化，可致缓存冷启动，不等于命中率下降
          </div>
        </Show>
      </div>

      <Show when={grilling()?.started}>
        <div class="flex items-center justify-between gap-3 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02 p-3">
          <div>
            <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">Grilling Me</div>
            <div class="mt-1 text-[12px] font-medium text-v2-text-text-base">
              {grilling()?.completed ? "已完成" : "进行中"} · {grillingDuration() || "计时不可用"}
            </div>
            <Show when={grilling()?.completedAt}>
              <div class="mt-0.5 text-[10px] text-v2-text-text-muted">完成于 {formatTimestamp(grilling()?.completedAt)}</div>
            </Show>
            <Show when={grilling()?.startedAt}>
              <div class="mt-0.5 text-[10px] text-v2-text-text-muted">开始于 {formatTimestamp(grilling()?.startedAt)}</div>
            </Show>
            <div class="mt-0.5 text-[10px] text-v2-text-text-muted">
              总耗时 {grillingDuration() || "计时不可用"}
            </div>
          </div>
          <div class="text-right">
            <div class="text-[18px] font-semibold text-v2-text-text-base">{grilling()?.decisionCount ?? 0}</div>
            <div class="text-[10px] text-v2-text-text-muted">已确认决策</div>
            <Show when={!grilling()?.completed}>
              <button
                type="button"
                class="mt-2 rounded border border-v2-border-border-base px-2 py-1 text-[10px] text-v2-text-text-muted hover:bg-surface-base-hover hover:text-v2-text-text-base disabled:opacity-50"
                disabled={completingGrilling()}
                onClick={() => void completeGrillingInterview()}
              >
                {completingGrilling() ? "结束中" : "结束采访"}
              </button>
            </Show>
          </div>
        </div>
      </Show>

      <DeveAgentMarkItDownStatus events={markitdownEvents()} />

      <div class="grid grid-cols-2 gap-2">
        <div class="col-span-2 p-3 bg-v2-background-bg-layer-02 rounded-lg border border-v2-border-border-base">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">费用估算</div>
            <Select<CostCurrencyOption>
              size="normal"
              options={[...costCurrencyOptions]}
              current={displayCurrency() as CostCurrencyOption}
              label={costCurrencyLabel}
              onSelect={(value) => {
                if (value) updateDisplayCurrency(value)
              }}
              class="min-w-[94px] border border-v2-border-border-base bg-v2-background-bg-layer-01 text-[11px] text-v2-text-text-base"
              valueClass="truncate text-[11px] text-v2-text-text-base"
              triggerProps={{ "aria-label": "费用显示币种", value: displayCurrency() }}
            />
          </div>
          <div class="text-[18px] font-semibold tabular-nums text-v2-state-fg-warning">{costLabel()}</div>
          <div class="text-[10px] text-v2-text-text-muted">{conversionLabel()}</div>
        </div>
        <div class="p-3 bg-v2-background-bg-layer-02 rounded-lg border border-v2-border-border-base">
          <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">轮次</div>
          <div class="text-[16px] font-bold">{sessionMetrics.rounds()}</div>
        </div>
        <Show when={sessionMetrics.hasTaskTiming()}>
          <div class="p-3 bg-v2-background-bg-layer-02 rounded-lg border border-v2-border-border-base">
            <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">
              {sessionMetrics.taskTiming().completedElapsedMs !== undefined
                ? sessionMetrics.hasTaskAggregate()
                  ? "任务完成"
                  : "会话完成"
                : sessionMetrics.hasTaskAggregate()
                  ? "任务跨度"
                  : "会话跨度"}
            </div>
            <div class="text-[16px] font-bold">{formatElapsed(sessionMetrics.taskTiming().elapsedMs ?? 0)}</div>
            <div class="mt-0.5 text-[10px] text-v2-text-text-muted">
              {sessionMetrics.taskTiming().completedElapsedMs !== undefined
                ? sessionMetrics.hasTaskAggregate()
                  ? "根会话与全部子任务均已 idle"
                  : "会话已 idle"
                : sessionMetrics.hasTaskAggregate()
                  ? "根会话至最后子任务更新"
                  : "会话创建至最近更新"}
            </div>
            <Show when={sessionMetrics.taskTiming().completedAt !== undefined}>
              <div class="mt-0.5 text-[10px] text-v2-text-text-muted">完成于 {formatTimestamp(sessionMetrics.taskTiming().completedAt)}</div>
            </Show>
          </div>
        </Show>
        <Show when={sessionMetrics.taskAgents().length > 0}>
          <div class="col-span-2 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02 p-3">
            <div class="mb-2 flex items-center justify-between gap-2">
              <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">原生子 Agent</div>
              <div class="text-[11px] font-medium text-v2-text-text-base">{sessionMetrics.taskAgents().length} 个</div>
            </div>
            <div class="flex flex-col gap-1.5">
              <For each={sessionMetrics.taskAgents()}>
                {(agent) => (
                  <div class="flex items-center gap-2 rounded border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1.5">
                    <span class={`size-1.5 shrink-0 rounded-full ${agent.status === "idle" ? "bg-green-500" : "bg-amber-500"}`} />
                    <div class="min-w-0 flex-1 truncate text-[11px] text-v2-text-text-base" title={agent.id}>{agent.title}</div>
                    <span class="shrink-0 text-[10px] text-v2-text-text-muted">{agent.status}</span>
                    <span class="shrink-0 text-[10px] text-v2-text-text-muted">{number().format(agent.tokens)} tokens</span>
                    <Show when={agent.updatedAt}>
                      {(updatedAt) => <span class="shrink-0 text-[10px] text-v2-text-text-muted">{formatTimestamp(updatedAt())}</span>}
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
        <div class="p-3 bg-v2-background-bg-layer-02 rounded-lg border border-v2-border-border-base">
          <div class="text-[10px] text-v2-text-text-muted" title="含已知子代理">累计输入</div>
          <div class="text-[16px] font-bold">{sessionMetrics.hasUsage() ? number().format(sessionMetrics.sessionInputTokens()) : "未返回"}</div>
        </div>
        <div class="p-3 bg-v2-background-bg-layer-02 rounded-lg border border-v2-border-border-base">
          <div class="text-[10px] text-v2-text-text-muted" title="含已知子代理">累计输出</div>
          <div class="text-[16px] font-bold">{sessionMetrics.hasUsage() ? number().format(sessionMetrics.sessionOutputTokens()) : "未返回"}</div>
        </div>
        <div class="p-3 bg-v2-background-bg-layer-02 rounded-lg border border-v2-border-border-base">
          <div class="text-[10px] text-v2-text-text-muted" title="含已知子代理">会话 Tokens</div>
          <div class="text-[16px] font-bold">{sessionMetrics.hasUsage() ? number().format(sessionMetrics.sessionTotalTokens()) : "未返回"}</div>
          <Show when={sessionMetrics.teamUsage().tokens > 0}>
            <div class="text-[10px] text-v2-text-text-muted">
              子代理 {number().format(sessionMetrics.teamUsage().tokens)} · {sessionMetrics.teamUsage().rounds} 轮
              {sessionMetrics.teamUsageSource() === "native-session" ? " · 子会话" : " · 旧账本回退"}
            </div>
          </Show>
        </div>
        <div class="p-3 bg-v2-background-bg-layer-02 rounded-lg border border-v2-border-border-base">
          <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">指标来源</div>
          <div class="text-[12px] font-medium text-v2-text-text-base">
            {sessionMetrics.hasContext() ? "会话数据" : "等待模型返回"}
          </div>
        </div>
      </div>
      <div class="rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02 p-3">
        <div class="flex items-center justify-between gap-2">
          <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">Provider Failover</div>
          <span class="text-[10px] text-v2-text-text-muted">全局默认</span>
        </div>
        <Show
          when={fallbackChain().length > 0}
          fallback={<div class="mt-1 text-[12px] text-v2-text-text-muted">未配置 fallback chain</div>}
        >
          <div class="mt-1 break-words text-[12px] font-medium text-v2-text-text-base">
            {fallbackChain().map((model) => `${model.providerID}/${model.modelID}`).join(" -> ")}
          </div>
        </Show>
        <div class="mt-1 text-[10px] leading-4 text-v2-text-text-muted">
          仅在首个模型于输出、推理或工具调用前发生可重试失败时接管；不会中断已经可见的回答。
        </div>
        <Show when={fallbackChain().length > 0}>
          <div class="mt-2 flex flex-wrap gap-1">
            <For each={fallbackChain()}>
              {(model) => (
                <button
                  type="button"
                  class="inline-flex items-center gap-1 rounded border border-border-weak-base bg-background-base px-1.5 py-0.5 text-[10px] text-text-base hover:border-red-500/50"
                  title={`移除 ${model.providerID}/${model.modelID}`}
                  disabled={savingFallbackChain()}
                  onClick={() => void saveFallbackChain(fallbackChain().filter((item) => item.providerID !== model.providerID || item.modelID !== model.modelID))}
                >
                  <span>{model.providerID}/{model.modelID}</span>
                  <span class="text-text-weak">x</span>
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={fallbackChain().length < 4}>
          <div class="mt-2 flex gap-1">
            <select
              class="min-w-0 flex-1 rounded border border-border-weak-base bg-background-base px-1.5 py-1 text-[11px] text-text-base outline-none"
              value={fallbackCandidate()}
              disabled={savingFallbackChain() || availableFallbackModels().length === 0}
              onChange={(event) => setFallbackCandidate(event.currentTarget.value)}
            >
              <option value="">添加已连接模型</option>
              <For each={availableFallbackModels()}>
                {(model) => <option value={`${model.provider.id}/${model.id}`}>{model.provider.name} · {model.name}</option>}
              </For>
            </select>
            <button
              type="button"
              class="rounded border border-v2-border-border-focus/40 bg-v2-background-bg-accent/10 px-2 text-[11px] font-medium text-text-base disabled:opacity-50"
              disabled={!fallbackCandidate() || savingFallbackChain()}
              onClick={addFallbackCandidate}
            >
              添加
            </button>
          </div>
        </Show>
      </div>
      <Show when={params.id}>
        <div class="rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02 p-3">
          <div class="flex items-center justify-between gap-2">
            <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">Session Vision Chain</div>
            <Show
              when={sessionAuxiliary()?.overridden}
              fallback={<span class="text-[10px] text-v2-text-text-muted">全局默认</span>}
            >
              <button
                type="button"
                class="text-[10px] text-v2-text-text-accent hover:underline disabled:opacity-50"
                disabled={savingVisionChain()}
                onClick={() => void resetSessionVisionChain()}
              >
                恢复全局
              </button>
            </Show>
          </div>
          <Show
            when={visionChain().length > 0}
            fallback={<div class="mt-1 text-[12px] text-v2-text-text-muted">使用全局视觉配置</div>}
          >
            <div class="mt-1 break-words text-[12px] font-medium text-v2-text-text-base">
              {visionChain().map((model) => `${model.providerID}/${model.modelID}`).join(" -> ")}
            </div>
          </Show>
          <div class="mt-1 text-[10px] leading-4 text-v2-text-text-muted">
            仅显示模型目录声明支持图片输入的候选。附图任务优先按此顺序选择；不可用候选会继续检查下一项。
          </div>
          <Show when={visionChain().length > 0}>
            <div class="mt-2 flex flex-wrap gap-1">
              <For each={visionChain()}>
                {(model) => (
                  <button
                    type="button"
                    class="inline-flex items-center gap-1 rounded border border-border-weak-base bg-background-base px-1.5 py-0.5 text-[10px] text-text-base hover:border-red-500/50"
                    title={`移除 ${model.providerID}/${model.modelID}`}
                    disabled={savingVisionChain()}
                    onClick={() => void saveSessionVisionChain(visionChain().filter((item) => item.providerID !== model.providerID || item.modelID !== model.modelID))}
                  >
                    <span>{model.providerID}/{model.modelID}</span>
                    <span class="text-text-weak">x</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
          <Show when={availableVisionModels().length > 0}>
            <div class="mt-2 flex gap-1">
              <select
                aria-label="添加会话视觉模型"
                class="min-w-0 flex-1 rounded border border-border-weak-base bg-background-base px-1.5 py-1 text-[11px] text-text-base outline-none"
                value={visionCandidate()}
                disabled={savingVisionChain()}
                onChange={(event) => setVisionCandidate(event.currentTarget.value)}
              >
                <option value="">添加视觉模型</option>
                <For each={availableVisionModels()}>
                  {(model) => <option value={`${model.provider.id}/${model.id}`}>{model.provider.name} · {model.name}</option>}
                </For>
              </select>
              <button
                type="button"
                class="rounded border border-v2-border-border-focus/40 bg-v2-background-bg-accent/10 px-2 text-[11px] font-medium text-text-base disabled:opacity-50"
                disabled={!visionCandidate() || savingVisionChain()}
                onClick={addVisionCandidate}
              >
                添加
              </button>
            </div>
          </Show>
        </div>
      </Show>
      <DeveAgentVisionConfigPanel />
      <div class="rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02 p-3">
        <div class="flex items-center justify-between gap-2">
          <div>
            <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">Voice STT</div>
            <div class="mt-0.5 text-[10px] leading-4 text-v2-text-text-muted">
              选择已连接的 OpenAI-compatible 转写模型；密钥只在本地引擎使用。
            </div>
          </div>
        </div>
        <select
          aria-label="语音转写模型"
          class="mt-2 w-full rounded border border-border-weak-base bg-background-base px-1.5 py-1 text-[11px] text-text-base outline-none"
          value={speechModelValue()}
          disabled={savingSpeechModel()}
          onChange={(event) => void saveSpeechModel(event.currentTarget.value)}
        >
          <option value="">本机 Chromium Web Speech</option>
          <For each={models.list().slice(0, 300)}>
            {(model) => <option value={`${model.provider.id}/${model.id}`}>{model.provider.name} · {model.name}</option>}
          </For>
        </select>
      </div>
      <DeveAgentSttConfigPanel />
      <DeveAgentRoleProfilesPanel />
        </Match>
        <Match when={activeTab() === "files"}>
          <div class="flex flex-col gap-2">
            <Show
              when={files().length > 0}
              fallback={
                <div class="p-4 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02 text-[12px] text-v2-text-text-muted">
                  当前没有显式上下文文件。添加文件、打开文件或查看改动后会生成真实 Context Pack。
                </div>
              }
            >
              <For each={files()}>
                {(item) => (
                  <div class="p-3 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02">
                    <div class="flex items-center gap-2">
                      <button
                        type="button"
                        class="min-w-0 flex-1 text-left text-[12px] text-v2-text-text-base truncate hover:text-v2-text-text-accent"
                        title={item.path}
                        onClick={() => openFile(item.path)}
                      >
                        {item.path}
                      </button>
                      <Show when={item.key && !item.key.startsWith("tab:")}>
                        <button
                          type="button"
                          class="text-[11px] text-v2-text-text-muted hover:text-v2-text-text-base"
                          onClick={() => item.key && prompt.context.remove(item.key)}
                        >
                          移除
                        </button>
                      </Show>
                    </div>
                    <div class="mt-1 text-[10px] text-v2-text-text-muted">
                      {item.source} · {packedFile(item.path) ? `~${compactTokens(packedFile(item.path)!.estimatedTokens)} tokens${packedFile(item.path)!.compressed ? " · 已压缩" : ""}` : "等待 Context Pack"}
                    </div>
                  </div>
                )}
              </For>
              <For each={(contextPack()?.files ?? []).filter((item) => item.source === "codegraph call" || item.source === "codegraph import")}>
                {(item) => (
                  <button
                    type="button"
                    class="p-3 rounded-lg border border-v2-border-border-focus/30 bg-v2-background-bg-accent/5 text-left hover:border-v2-border-border-focus"
                    title={item.path}
                    onClick={() => openFile(item.path)}
                  >
                    <div class="text-[12px] text-v2-text-text-base truncate">{item.path}</div>
                    <div class="mt-1 text-[10px] text-v2-text-text-muted">
                      CodeGraph {item.source === "codegraph import" ? "import 关联" : "调用关联"} · ~{compactTokens(item.estimatedTokens)} tokens{item.compressed ? " · 已压缩" : ""}
                    </div>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </Match>
        <Match when={activeTab() === "changes"}>
          <div class="flex flex-col gap-2">
            <div class="rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02 p-3">
              <div class="flex items-center gap-2">
                <div class="min-w-0 flex-1 text-[12px] font-medium text-v2-text-text-base">CodeGraph review scope</div>
                <button
                  type="button"
                  class="rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1 text-[11px] text-v2-text-text-base hover:border-v2-border-border-focus disabled:opacity-50"
                  disabled={!sdk().directory || scopingReview()}
                  onClick={createReviewScope}
                >
                  {scopingReview() ? "Generating..." : "Analyze changes"}
                </button>
              </div>
              <div class="mt-1 text-[11px] text-v2-text-text-muted">Uses the current session diff only; it does not invent changed files.</div>
              <Show when={reviewScopeError()}>
                {(error) => <div class="mt-2 text-[11px] text-v2-state-fg-danger">Review scope failed: {error()}</div>}
              </Show>
              <Show when={reviewScope()}>
                {(scope) => (
                  <div class="mt-2 space-y-2">
                    <div class="text-[11px] text-v2-text-text-muted">
                      {scope().changedFileCount} changed file(s), {scope().totalSymbols} symbol(s)
                    </div>
                    <For each={scope().files}>
                      {(item) => (
                        <div class="rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 p-2">
                          <button type="button" class="block max-w-full truncate text-left text-[11px] text-v2-text-text-base hover:text-v2-text-text-accent" onClick={() => openChange(item.path)}>{item.path}</button>
                          <Show when={item.symbols.length > 0}>
                            <div class="mt-1 text-[10px] text-v2-text-text-muted">Symbols: {item.symbols.slice(0, 5).map((symbol) => symbol.name).join(", ")}</div>
                          </Show>
                          <Show when={item.relatedFiles.length > 0}>
                            <div class="mt-1 text-[10px] text-v2-text-text-muted">Related: {item.relatedFiles.map((file) => file.path).join(", ")}</div>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                )}
              </Show>
            </div>
            <Show
              when={changes().length > 0}
              fallback={
                <div class="p-4 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02 text-[12px] text-v2-text-text-muted">
                  当前 session 没有可显示改动。
                </div>
              }
            >
              <For each={changes()}>
                {(item) => (
                  <button
                    type="button"
                    class="p-3 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02 text-left hover:border-v2-border-border-focus"
                    onClick={() => item.file && openChange(item.file)}
                  >
                    <div class="text-[12px] text-v2-text-text-base truncate">{item.file}</div>
                    <div class="mt-1 text-[11px] text-v2-text-text-muted">
                      +{item.additions} / -{item.deletions} {item.status ? `· ${item.status}` : ""}
                    </div>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </Match>
        <Match when={activeTab() === "codegraph"}>
          <div class="flex flex-col gap-2">
            <div class="p-4 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02">
              <div class="flex items-center gap-2">
                <div class="text-[12px] font-semibold text-v2-text-text-base">Context Pack + 持久化图索引</div>
                <div class="flex-1" />
                <button
                  type="button"
                  class="rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1 text-[11px] text-v2-text-text-base hover:border-v2-border-border-focus disabled:opacity-50"
                  disabled={indexing()}
                  onClick={refreshGraphIndex}
                >
                  {indexing() ? "索引中..." : "刷新索引"}
                </button>
              </div>
              <div class="mt-2 text-[12px] leading-5 text-v2-text-text-muted">
                当前接入的是 DeveAgent `context_pack` v1：从当前 workspace 的上下文文件、打开文件和 session 改动读取真实文件大小并估算 token。
                手动刷新会用 Tree-sitter（不可用时回退）持久化文件、符号、import 边和唯一符号调用边；未变文件复用上一轮索引。跨语言语义解析和精确 tokenizer 仍未完成。
              </div>
              <Show when={graphIndex()}>
                {(index) => (
                  <div class="mt-2 rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 p-2 text-[11px] text-v2-text-text-muted">
                    {number().format(index().fileCount)} 文件 · {number().format(index().symbolCount)} 符号 · {number().format(index().importEdgeCount)} import 边 · {number().format(index().callEdgeCount)} call 边
                    <div class="mt-1">复用 {number().format(index().reusedFileCount)} · 重建 {number().format(index().reindexedFileCount)}</div>
                    <div class="mt-1 truncate" title={index().outputPath}>{index().outputPath}</div>
                  </div>
                )}
              </Show>
              <Show when={graphIndexError()}>
                {(error) => <div class="mt-2 text-[11px] text-v2-state-fg-danger">索引失败：{error()}</div>}
              </Show>
              <Show when={graphIndexStatusLoading()}>
                <div class="mt-2 text-[11px] text-v2-text-text-muted">正在读取当前 workspace 的索引状态…</div>
              </Show>
              <Show when={graphIndexStatusError()}>
                {(error) => <div class="mt-2 text-[11px] text-v2-state-fg-danger">索引状态读取失败：{error()}</div>}
              </Show>
              <Show when={graphIndexStatus()}>
                {(status) => (
                  <div class={`mt-2 text-[11px] ${status().available && status().staleFileCount > 0 ? "text-amber-600 dark:text-amber-300" : "text-v2-text-text-muted"}`}>
                    {!status().available
                      ? "尚未建立持久化索引。"
                      : status().staleFileCount > 0
                        ? `索引已陈旧：${number().format(status().staleFileCount)} 个文件已变化或删除，点击刷新重建。`
                        : "索引与当前文件元数据一致。"}
                  </div>
                )}
              </Show>
              <Show when={!sdk().directory}>
                <div class="mt-2 rounded-md border border-dashed border-v2-border-border-base bg-v2-background-bg-layer-01 p-2 text-[11px] text-v2-text-text-muted">
                  尚未选择 workspace，无法读取 CodeGraph 索引。
                </div>
              </Show>
              <Show when={indexing() && sdk().directory}>
                <div class="mt-2 text-[11px] text-v2-text-text-muted">正在建立持久化索引；大型 workspace 可能需要一些时间。</div>
              </Show>
              <Show
                when={
                  sdk().directory &&
                  !indexing() &&
                  !graphIndexStatusLoading() &&
                  !graphIndexStatus() &&
                  !graphIndexError() &&
                  !graphIndexStatusError()
                }
              >
                <div class="mt-2 rounded-md border border-dashed border-v2-border-border-base bg-v2-background-bg-layer-01 p-2 text-[11px] text-v2-text-text-muted">
                  当前尚未读取到索引状态。点击“刷新索引”后才会建立或更新持久化 CodeGraph 索引。
                </div>
              </Show>
              <div class="mt-3 grid grid-cols-2 gap-2">
                <div class="rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 p-2">
                  <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">估算 tokens</div>
                  <div class="text-[18px] font-bold text-v2-text-text-base">
                    {contextPack() ? number().format(contextPack()!.totalEstimatedTokens) : contextPackLoading() ? "读取中" : "--"}
                  </div>
                </div>
                <div class="rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 p-2">
                  <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">Pack 文件</div>
                  <div class="text-[18px] font-bold text-v2-text-text-base">
                    {contextPack() ? contextPack()!.files.length : contextPackLoading() ? "读取中" : "--"}
                  </div>
                </div>
              </div>
              <Show when={contextPack() && (contextPack()!.tokensSaved ?? 0) > 0}>
                <div class="mt-2 rounded-md border border-green-500/40 bg-green-500/10 p-2 text-[11px] font-medium text-green-700 dark:text-green-300">
                  Token Saver v1 已省 ~{number().format(contextPack()!.tokensSaved ?? 0)} tokens
                  <span class="text-[10px] font-normal text-v2-text-text-muted"> · 原始 {number().format(contextPack()!.totalOriginalTokens ?? 0)} → 压缩后 {number().format(contextPack()!.totalEstimatedTokens)}</span>
                </div>
              </Show>
              <Show when={contextPack() && contextPack()!.tokenSaverEnabled === false}>
                <div class="mt-2 rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 p-2 text-[11px] text-v2-text-text-muted">
                  Token Saver 未启用（真实压缩关闭）。开启后会对 &gt;1500 tokens 的文件保留头尾并压缩中间。
                </div>
              </Show>
              <Show when={contextPackError()}>
                {(error) => <div class="mt-2 text-[11px] text-v2-state-fg-danger">context_pack 读取失败：{error()}</div>}
              </Show>
              <Show when={contextPackLoading()}>
                <div class="mt-2 text-[11px] text-v2-text-text-muted">正在读取当前 workspace 的真实 Context Pack…</div>
              </Show>
              <Show when={!sdk().directory}>
                <div class="mt-2 rounded-md border border-dashed border-v2-border-border-base bg-v2-background-bg-layer-01 p-2 text-[11px] text-v2-text-text-muted">
                  尚未选择 workspace，无法生成 Context Pack。
                </div>
              </Show>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div class="p-3 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02">
                <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">当前上下文文件</div>
                <div class="text-[18px] font-bold text-v2-text-text-base">{contextFiles().length}</div>
                <div class="mt-1 text-[10px] text-v2-text-text-muted">来自引擎 prompt context</div>
              </div>
              <div class="p-3 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02">
                <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">当前 session 改动</div>
                <div class="text-[18px] font-bold text-v2-text-text-base">{changes().length}</div>
                <div class="mt-1 text-[10px] text-v2-text-text-muted">来自引擎 session diff</div>
              </div>
            </div>
            <Show
              when={contextPack()?.files.length}
              fallback={
                <div class="p-4 rounded-lg border border-dashed border-v2-border-border-base bg-v2-background-bg-layer-01 text-[12px] text-v2-text-text-muted">
                  当前没有可打包文件。把文件加入上下文、打开文件，或产生 session diff 后这里会显示真实 context_pack。
                </div>
              }
            >
              <div class="flex flex-col gap-2">
                <For each={contextPack()?.files ?? []}>
                  {(item) => (
                    <button
                      type="button"
                      class="rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02 p-3 text-left hover:border-v2-border-border-focus"
                      onClick={() => item.readable && openFile(item.path)}
                    >
                      <div class="flex items-center gap-2">
                        <div class="min-w-0 flex-1 truncate text-[12px] text-v2-text-text-base" title={item.path}>
                          {item.path}
                        </div>
                        <div class="shrink-0 text-[11px] text-v2-text-text-muted">{item.source}</div>
                      </div>
                      <div class="mt-1 text-[11px] text-v2-text-text-muted">
                        {item.readable
                          ? `${number().format(item.estimatedTokens)} tokens · ${number().format(item.bytes)} bytes${item.reason ? ` · ${item.reason}` : ""}`
                          : `不可读 · ${item.reason ?? "unknown"}`}
                      </div>
                      <Show when={item.compressed && item.originalTokens}>
                        <div class="mt-1 inline-flex items-center gap-1 rounded bg-green-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-green-700 dark:text-green-300">
                          压缩 · 原 {number().format(item.originalTokens!)} → 现 {number().format(item.estimatedTokens)} tokens
                        </div>
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Match>
      </Switch>
    </div>
  )
}

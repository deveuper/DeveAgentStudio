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
import { createLowPowerInterval } from "@/context/low-power"
import { DeveagentTrustCard } from "@/components/deveagent-trust-card"
import { DeveagentCuAuditCard } from "@/components/deveagent-cu-audit-card"
import { DeveagentRunsCard } from "@/components/deveagent-runs-card"
import { DeveagentRewindPicker } from "@/components/deveagent-rewind-picker"

import { DeveagentAgentBoard } from "@/components/deveagent-agent-board"
import { DeveagentSessionTree } from "@/components/deveagent-session-tree"
import { DeveagentSkillCandidatesCard } from "@/components/deveagent-skill-candidates-card"
import { DeveagentAutomationsPanel } from "@/components/deveagent-automations-panel"

import { DeveAgentVisionConfigPanel } from "./deveagent-vision-config"
import { DeveAgentSttConfigPanel } from "./deveagent-stt-config"
import { DeveAgentRoleProfilesPanel } from "./deveagent-role-profiles"
import { useLocal } from "@/context/local"
import { useModels } from "@/context/models"
import { isPaidFallbackModelCost } from "@/utils/fallback-cost"
import { useSessionLayout } from "@/pages/session/session-layout"
import { diffs as normalizeDiffs } from "@/utils/diffs"
import { showToast } from "@/utils/toast"
import { createStore } from "solid-js/store"
import { Select } from "@opencode-ai/ui/select"
import { collectDeveAgentMarkItDownEvents } from "./deveagent-markitdown-state"
import { DeveAgentMarkItDownStatus } from "./deveagent-markitdown-status"

const costCurrencyOptions = ["native", "CNY", "USD", "EUR", "JPY", "KRW", "HKD"] as const
type CostCurrencyOption = (typeof costCurrencyOptions)[number]

function costCurrencyLabel(value: CostCurrencyOption, nativeLabel: string) {
  if (value === "native") return nativeLabel
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
    fallbackChainAllowPaid?: boolean
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
  // Non-Chinese locales deliberately use English until complete dictionaries
  // exist. This keeps the workbench coherent instead of leaving Chinese-only
  // control labels after the user switches language.
  const tabLabels = () => ({
    overview: language.t("deveagent.sidebar.overview"),
    files: language.t("deveagent.dashboard.tabFiles"),
    changes: language.t("deveagent.dashboard.tabChanges"),
    codegraph: "CodeGraph",
  })
  const sessionMetrics = createDeveAgentSessionMetrics()
  const prompt = usePrompt()
  const file = useFile()
  const sync = useSync()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  // ponytail: long-run memory watch — sampled server-side per poll (pull
  // model, no timers), surfaced in the Overview so slow leaks are visible.
  const [memoryTick, setMemoryTick] = createSignal(0)
  // Only the Overview tab renders the memory / grilling / cache-shape reads.
  // `<Switch>` unmounts the other tabs' cards, but these resources are created
  // at component scope and would keep polling off-screen — so the tick itself
  // is what has to stop when another tab is showing.
  createLowPowerInterval(() => {
    if (activeTab() !== "overview") return
    setMemoryTick((t) => t + 1)
  }, 5_000)
  const cacheShapeTick = createMemo(() => Math.floor(memoryTick() / 2))
  const [serverMemory] = createResource(
    () => ({ url: serverSDK().url, tick: memoryTick() }),
    async (source) => {
      try {
        const response = await serverSDK().fetch(`${source.url.replace(/\/+$/, "")}/api/deveagent/metrics`)
        if (!response.ok) return undefined
        const data = (await response.json()) as { memory?: { rssMB?: number; heapMB?: number } }
        return data?.memory && typeof data.memory.rssMB === "number" ? data.memory : undefined
      } catch {
        return undefined
      }
    },
  )
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
      const status = await readCodeGraphResponse<CodeGraphIndexStatus>(response, language.t("deveagent.dashboard.codeGraphStatusFailed"))
      if (requestID !== graphStatusRequest || sdk().directory !== directory) return
      setGraphIndexStatus(status)
    } catch (error) {
      if (requestID !== graphStatusRequest || sdk().directory !== directory) return
      setGraphIndexStatus(undefined)
      setGraphIndexStatusError(error instanceof Error ? error.message : language.t("deveagent.dashboard.codeGraphStatusFailed"))
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
    onCleanup(() => {
      window.removeEventListener("deveagent:dashboard-tab", handleTab)
    })
  })

  const [grilling, { refetch: refetchGrilling }] = createResource(
    () =>
      params.id
        ? { base: serverSDK().url, sessionID: params.id, revision: memoryTick() }
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
  // The 1s clock exists only to advance a RUNNING interview's elapsed timer.
  // A completed or absent interview renders from its stored timestamps, so
  // ticking then is pure re-render cost. `grillingClock` is a plain number
  // signal, so an unchanged value is already free under Solid's equality.
  createLowPowerInterval(() => {
    if (activeTab() !== "overview") return
    if (!grilling()?.started || grilling()?.completed) return
    setGrillingClock(Date.now())
  }, 1_000)

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
        ? { base: serverSDK().url, sessionID: params.id, revision: cacheShapeTick() }
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
    reason === "system" ? language.t("deveagent.dashboard.contextKindSystemPrompt") : reason === "tools" ? language.t("deveagent.statusbar.tools") : reason === "system+tools" ? language.t("deveagent.dashboard.contextKindSystemTools") : language.t("deveagent.dashboard.contextKindNone")
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
      showToast({ title: language.t("deveagent.dashboard.grillingFinished"), description: language.t("deveagent.dashboard.grillingFinishedDescription") })
    } catch (error) {
      showToast({ variant: "error", title: language.t("deveagent.dashboard.grillingFinishFailed"), description: error instanceof Error ? error.message : language.t("common.requestFailed") })
    } finally {
      setCompletingGrilling(false)
    }
  }

  const compactSession = async () => {
    if (!params.id || compacting()) return
    const model = local.model.current()
    if (!model) {
      showToast({ title: language.t("deveagent.dashboard.noModelAvailable"), description: language.t("deveagent.dashboard.selectConnectedModel") })
      return
    }
    setCompacting(true)
    try {
      await sdk().client.session.summarize({
        sessionID: params.id,
        modelID: model.id,
        providerID: model.provider.id,
      })
      showToast({ title: language.t("deveagent.dashboard.compactionComplete"), description: language.t("deveagent.dashboard.compactionCompleteDescription") })
    } catch (error) {
      showToast({ variant: "error", title: language.t("deveagent.dashboard.compactionFailed"), description: error instanceof Error ? error.message : language.t("common.requestFailed") })
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
      .map((model) => ({ ...model, paid: isPaidFallbackModelCost(model.cost) }))
      .slice(0, 200)
  })
  const allowPaidFallback = createMemo(() => runtimeState()?.auxiliary?.fallbackChainAllowPaid === true)
  const availableVisionModels = createMemo(() => {
    const configured = new Set(visionChain().map((model) => `${model.providerID}/${model.modelID}`))
    return models
      .list()
      .filter((model) => model.capabilities.input.image && !configured.has(`${model.provider.id}/${model.id}`))
      .slice(0, 200)
  })
  const contextLimitLabel = () => {
    const limit = sessionMetrics.contextLimit()
    return limit ? `${compactTokens(limit)} tokens` : language.t("deveagent.dashboard.unknownLimit")
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
    if (!cost.hasCost) return language.t("deveagent.dashboard.notReturned")
    const target = targetCostCurrency()
    if (!target) return cost.groups.map((item) => displayMoney(item.currency, item.amount)).join(" + ")
    if (cost.convertedAmount === undefined) return `${target} ${language.t("deveagent.dashboard.notConnected")}`
    return `${displayMoney(target, cost.convertedAmount)}${cost.missingConversions ? ` + ${cost.missingConversions}${language.t("deveagent.dashboard.unconvertedSuffix")}` : ""}`
  }
  const conversionLabel = () => {
    const target = targetCostCurrency()
    const cost = selectedCostView()
    if (!cost.hasCost) return language.t("deveagent.dashboard.noUsageData")
    const entries = sessionMetrics.costEntries()
    const providerReturned = entries.some((entry) => entry.source === "provider")
    const estimated = entries.some((entry) => entry.source !== "provider")
    const source = providerReturned
      ? estimated
        ? language.t("deveagent.dashboard.costSourcePartial")
        : language.t("deveagent.dashboard.costSourceProvider")
      : language.t("deveagent.dashboard.costSourceEstimate")
    if (!target) return `${source}${language.t("deveagent.dashboard.perModelCurrencySuffix")}`
    const rate = fxRates()?.[0]
    if (cost.missingConversions) return `${source} · ${cost.missingConversions}${language.t("deveagent.dashboard.noLiveRateSuffix")}`
    return rate ? `${source} · ${language.t("deveagent.dashboard.converted")}: ${rate.source} ${rate.timestamp}` : source
  }
  const contextFiles = createMemo(() =>
    prompt
      .context
      .items()
      .filter((item) => item.type === "file" && !!item.path)
      .map((item) => ({
        key: item.key,
        path: item.path!,
        source: item.comment ? language.t("deveagent.dashboard.fileKindReview") : language.t("deveagent.dashboard.fileKindContext"),
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
        return [{ key: `tab:${tab}`, path, source: language.t("deveagent.dashboard.fileKindOpen") }]
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
      ...changes().flatMap((item) => (item.file ? [{ path: item.file, source: language.t("deveagent.dashboard.fileKindChanges") }] : [])),
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
      showToast({ title: language.t("deveagent.dashboard.fallbackChainSaved"), description: next.length ? language.t("deveagent.dashboard.fallbackChainSavedDescription", { count: next.length }) : language.t("deveagent.dashboard.fallbackChainCleared") })
    } catch (error) {
      showToast({ variant: "error", title: language.t("deveagent.dashboard.fallbackChainSaveFailed"), description: error instanceof Error ? error.message : language.t("common.requestFailed") })
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
  // Explicit opt-in for the red line: paid models are skipped for failover
  // unless this flag is on (enforced server-side).
  const saveAllowPaidFallback = async (value: boolean) => {
    if (savingFallbackChain()) return
    setSavingFallbackChain(true)
    try {
      const response = await serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/auxiliary`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fallbackChainAllowPaid: value }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      await refetchRuntimeState()
    } catch (error) {
      showToast({ variant: "error", title: language.t("deveagent.dashboard.fallbackChainSaveFailed"), description: error instanceof Error ? error.message : language.t("common.requestFailed") })
    } finally {
      setSavingFallbackChain(false)
    }
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
      showToast({ title: language.t("deveagent.dashboard.visionChainSaved"), description: next.length ? language.t("deveagent.dashboard.visionChainSavedDescription", { count: next.length }) : language.t("deveagent.dashboard.visionChainCleared") })
    } catch (error) {
      showToast({ variant: "error", title: language.t("deveagent.dashboard.visionChainSaveFailed"), description: error instanceof Error ? error.message : language.t("common.requestFailed") })
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
      showToast({ title: language.t("deveagent.dashboard.visionConfigRestored") })
    } catch (error) {
      showToast({ variant: "error", title: language.t("deveagent.dashboard.visionConfigRestoreFailed"), description: error instanceof Error ? error.message : language.t("common.requestFailed") })
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
        title: speech ? language.t("deveagent.dashboard.speechModelSaved") : language.t("deveagent.dashboard.speechModelDisabled"),
        description: speech ? `${speech.providerID}/${speech.modelID}` : language.t("deveagent.dashboard.speechModelHint"),
      })
    } catch (error) {
      showToast({ variant: "error", title: language.t("deveagent.dashboard.speechModelSaveFailed"), description: error instanceof Error ? error.message : language.t("common.requestFailed") })
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
      const result = await readCodeGraphResponse<CodeGraphIndex & { error?: string }>(response, language.t("deveagent.codegraph.refreshFailed"))
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
        setGraphIndexError(error instanceof Error ? error.message : language.t("deveagent.codegraph.refreshFailed"))
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
    <div class="flex min-h-full w-full min-w-0 max-w-full flex-col gap-3 p-3 pb-8 text-[13px] text-v2-text-text-base">
      <div class="flex border-b border-v2-border-border-base">
        {Object.entries(tabLabels()).map(([key, label]) => (
          <button
            // min-w-0 + truncate: at a narrow window the rail clamps to 240px and
            // four tabs no longer fit. Without them the labels keep their
            // intrinsic width, overlap each other and bleed past the panel edge.
            class={`min-w-0 flex-1 truncate py-2 text-[12px] text-center border-b-2 transition-colors ${
              activeTab() === key
                ? "text-v2-text-text-base font-medium"
                : "border-transparent text-v2-text-text-muted hover:text-v2-text-text-base"
            }`}
            title={label}
            style={activeTab() === key ? { "border-bottom-color": "var(--v2-border-border-focus)" } : undefined}
            onClick={() => setActiveTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <Switch>
        <Match when={activeTab() === "overview"}>
       {/* Layout (user request): the three metrics the user actually watches —
           usage analysis, cache hit rate, cost estimate — come FIRST. The
           side cards (trust, CU audit, runs, rewind, agents, tree, skills,
           automations) fold into a collapsed section below them. */}
             <Show
               when={sessionMetrics.hasUsage()}
               fallback={
                 <div class="flex flex-col gap-1.5 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02 p-4">
                   <div class="text-[11px] uppercase tracking-wide text-v2-text-text-muted">{language.t("deveagent.dashboard.usageAndCache")}</div>
                   <div class="text-[12px] text-v2-text-text-muted">{language.t("deveagent.dashboard.awaitingModelUsage")}</div>
                 </div>
               }
             >
             <div class="flex flex-col gap-3 p-4 bg-v2-background-bg-layer-02 rounded-lg border border-v2-border-border-base">
               <div class="text-[11px] uppercase tracking-wide text-v2-text-text-muted">{language.t("deveagent.dashboard.usageBreakdown")}</div>
               <Show
                 when={sessionMetrics.hasUsage() && (sessionMetrics.sessionTotalTokens() > 0 || sessionMetrics.teamUsage().tokens > 0)}
                 fallback={<div class="text-[11px] text-v2-text-text-muted">{language.t("deveagent.dashboard.awaitingModelUsage")}</div>}
               >
                 <div class="flex h-2.5 overflow-hidden rounded-full">
                   <div
                     class="h-full transition-all duration-500"
                     style={{
                       width: sessionMetrics.sessionTotalTokens() + sessionMetrics.teamUsage().tokens > 0 ? `${(sessionMetrics.sessionTotalTokens() / (sessionMetrics.sessionTotalTokens() + sessionMetrics.teamUsage().tokens)) * 100}%` : "0%",
                       background: "var(--v2-state-fg-info)",
                     }}
                   />
                   <div
                     class="h-full transition-all duration-500"
                     style={{
                       width: sessionMetrics.sessionTotalTokens() + sessionMetrics.teamUsage().tokens > 0 ? `${(sessionMetrics.teamUsage().tokens / (sessionMetrics.sessionTotalTokens() + sessionMetrics.teamUsage().tokens)) * 100}%` : "0%",
                       background: "var(--v2-state-fg-warning)",
                     }}
                   />
                 </div>
                 <div class="flex flex-col gap-1 text-[11px] text-v2-text-text-muted">
                   <span class="flex items-center gap-1"><span class="size-2 rounded-full" style={{ background: "var(--v2-state-fg-info)" }} /> {language.t("deveagent.dashboard.mainModel")} {Math.round((sessionMetrics.sessionTotalTokens() / (sessionMetrics.sessionTotalTokens() + sessionMetrics.teamUsage().tokens)) * 100)}%</span>
                   <span class="flex items-center gap-1"><span class="size-2 rounded-full" style={{ background: "var(--v2-state-fg-warning)" }} /> {language.t("deveagent.statusbar.subagents")} {Math.round((sessionMetrics.teamUsage().tokens / (sessionMetrics.sessionTotalTokens() + sessionMetrics.teamUsage().tokens)) * 100)}%</span>
                 </div>
                 <div class="flex flex-col gap-1.5 border-t border-v2-border-border-muted pt-2">
                   <div class="flex items-center justify-between text-[12px]">
                     <span class="flex items-center gap-1.5"><span class="size-2 rounded-full" style={{ background: "var(--v2-state-fg-info)" }} /> <span class="text-v2-text-text-base">{language.t("deveagent.dashboard.mainModel")}</span></span>
                     <span class="text-v2-text-text-muted">{number().format(sessionMetrics.sessionTotalTokens())}</span>
                   </div>
                   <div class="flex items-center justify-between text-[12px]">
                     <span class="flex items-center gap-1.5"><span class="size-2 rounded-full" style={{ background: "var(--v2-state-fg-warning)" }} /> <span class="text-v2-text-text-base">{language.t("deveagent.statusbar.subagents")}</span></span>
                     <span class="text-v2-text-text-muted">{number().format(sessionMetrics.teamUsage().tokens)}</span>
                   </div>
                 </div>
               </Show>
             </div>

             <div class="p-4 bg-v2-background-bg-layer-02 rounded-lg border border-v2-border-border-base">
               <div class="text-[11px] uppercase tracking-wide text-v2-text-text-faint mb-1">
                 {language.t("deveagent.dashboard.cacheHitRate")}
               </div>
               <div
                 class="text-[22px] font-bold tabular-nums"
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
                   ? `${language.t("deveagent.dashboard.sessionReadWrite")} ${number().format(sessionMetrics.sessionCacheReadTokens())} / ${number().format(sessionMetrics.sessionCacheWriteTokens())}`
                   : language.t("deveagent.dashboard.awaitingModelUsage")}
               </div>
               <Show when={cacheShape()?.lastReason !== undefined && cacheShape()!.lastReason !== "none"}>
                 <div class="mt-1.5 text-[10px] text-v2-text-text-muted">
                   {language.t("deveagent.dashboard.prefixShapeChanged")}: {shapeReasonLabel(cacheShape()!.lastReason)} · {language.t("deveagent.dashboard.count")} {cacheShape()!.changes}{cacheShape()!.lastChangedAt ? ` · ${formatTimestamp(cacheShape()!.lastChangedAt ?? undefined)}` : ""}
                 </div>
                 <div class="mt-0.5 text-[9px] text-v2-text-text-faint">
                   {language.t("deveagent.dashboard.prefixChangeHint")}
                 </div>
               </Show>
             </div>
             </Show>

             <Show when={grilling()?.started}>
               <div class="flex items-center justify-between gap-3 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02 p-3">
                 <div>
                   <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">Grilling Me</div>
                   <div class="mt-1 text-[12px] font-medium text-v2-text-text-base">
                     {grilling()?.completed ? language.t("deveagent.dashboard.grillingCompleted") : language.t("deveagent.dashboard.grillingInProgress")} · {grillingDuration() || language.t("deveagent.dashboard.timerUnavailable")}
                   </div>
                   <Show when={grilling()?.completedAt}>
                     <div class="mt-0.5 text-[10px] text-v2-text-text-muted">{language.t("deveagent.dashboard.completedAt")} {formatTimestamp(grilling()?.completedAt)}</div>
                   </Show>
                   <Show when={grilling()?.startedAt}>
                     <div class="mt-0.5 text-[10px] text-v2-text-text-muted">{language.t("deveagent.dashboard.startedAt")} {formatTimestamp(grilling()?.startedAt)}</div>
                   </Show>
                   <div class="mt-0.5 text-[10px] text-v2-text-text-muted">
                     {language.t("deveagent.dashboard.totalTime")} {grillingDuration() || language.t("deveagent.dashboard.timerUnavailable")}
                   </div>
                 </div>
                 <div class="text-right">
                   <div class="text-[18px] font-semibold text-v2-text-text-base">{grilling()?.decisionCount ?? 0}</div>
                   <div class="text-[10px] text-v2-text-text-muted">{language.t("deveagent.dashboard.confirmedDecisions")}</div>
                   <Show when={!grilling()?.completed}>
                     <button
                       type="button"
                       class="mt-2 rounded border border-v2-border-border-base px-2 py-1 text-[10px] text-v2-text-text-muted hover:bg-surface-base-hover hover:text-v2-text-text-base disabled:opacity-50"
                       disabled={completingGrilling()}
                       onClick={() => void completeGrillingInterview()}
                     >
                       {completingGrilling() ? language.t("deveagent.dashboard.grillingFinishing") : language.t("deveagent.dashboard.finishInterview")}
                     </button>
                   </Show>
                 </div>
               </div>
             </Show>
       {/* R191-G6: with no usage yet this card was a wall of placeholders
           ("Awaiting usage", "--"). It only renders once the model reported
           usage; the compact action hides with it since there is nothing to
           compact. */}
       <Show when={sessionMetrics.hasContext()}>
       <div class="flex flex-col gap-2.5 p-3 bg-v2-background-bg-layer-02 rounded-lg border border-v2-border-border-base">
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
              {!sessionMetrics.hasContext() ? language.t("deveagent.dashboard.awaitingUsage") : contextUsage() > 80 ? language.t("deveagent.dashboard.nearLimit") : contextUsage() > 50 ? language.t("deveagent.dashboard.approachingLimit") : language.t("deveagent.dashboard.contextAvailable")}
            </span>
            <span class="text-[11px] uppercase tracking-wide text-v2-text-text-muted">{hasTaskAggregate() ? language.t("deveagent.dashboard.taskTotal") : language.t("deveagent.dashboard.contextWindow")}</span>
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
                background: contextUsage() > 80 ? "var(--v2-state-fg-danger)" : "var(--v2-border-border-focus)",
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
                background: contextUsage() > 80 ? "var(--v2-state-fg-danger)" : "var(--v2-border-border-focus)",
              }}
            >
              {Math.round(contextUsage())}%
            </span>
          </Show>
        </div>
        <div class="flex items-center justify-end text-[11px] text-v2-text-text-muted">
          <span>{language.t("deveagent.dashboard.untilCompaction")} {sessionMetrics.hasContext() && sessionMetrics.contextLimit() ? compactTokens(sessionMetrics.contextLimit()! - sessionMetrics.totalTokens()) : "--"}</span>
        </div>
        <div class="flex w-full items-center justify-end gap-1 border-t border-v2-border-border-muted pt-2">
          <Show when={hasTaskAggregate()}>
            <button
              type="button"
              class="rounded border border-v2-border-border-base px-1.5 py-0.5 text-[10px] text-v2-text-text-muted hover:bg-surface-base-hover hover:text-v2-text-text-base"
              onClick={sessionMetrics.refreshTaskMetrics}
            >
              {language.t("deveagent.dashboard.refreshTaskTotal")}
            </button>
          </Show>
          <Show when={params.id}>
            <button
              type="button"
              class="rounded border border-v2-border-border-base px-1.5 py-0.5 text-[10px] text-v2-text-text-muted hover:bg-surface-base-hover hover:text-v2-text-text-base disabled:opacity-50"
              disabled={compacting()}
              onClick={() => void compactSession()}
            >
              {compacting() ? language.t("deveagent.dashboard.compacting") : language.t("deveagent.dashboard.compactContext")}
            </button>
          </Show>
        </div>
        <div class="flex gap-3 text-[11px] text-v2-text-text-muted">
          <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-v2-state-fg-success inline-block" /> {language.t("deveagent.dashboard.usageInput")} {number().format(hasTaskAggregate() ? sessionMetrics.sessionInputTokens() : sessionMetrics.inputTokens())}</span>
          <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-v2-text-text-accent inline-block" /> {language.t("deveagent.dashboard.usageOutput")} {number().format(hasTaskAggregate() ? sessionMetrics.sessionOutputTokens() : sessionMetrics.outputTokens())}</span>
          <Show when={sessionMetrics.teamUsage().tokens > 0}>
            <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-v2-state-fg-warning inline-block" /> {language.t("deveagent.statusbar.subagents")} {number().format(sessionMetrics.teamUsage().tokens)}</span>
          </Show>
        </div>
      </div>

       </Show>

      <div class="flex flex-col gap-1.5 p-3 bg-v2-background-bg-layer-02 rounded-lg border border-v2-border-border-base">
        <div class="text-[11px] uppercase tracking-wide text-v2-text-text-muted">{language.t("deveagent.dashboard.sessionMetrics")}</div>
        {/* R206-G7: uniform key-value rows instead of 17px tiles — same data,
            roughly half the vertical space. */}
        <div class="flex flex-col divide-y divide-v2-border-border-muted/60">
          {(() => {
            const elapsed = sessionMetrics.taskTiming().elapsedMs
            const rows: [string, string, string | undefined][] = [
              [language.t("deveagent.statusbar.cacheHit"), sessionMetrics.hasUsage() ? `${percent(cacheHitRate())}%` : "--", !sessionMetrics.hasUsage() ? "var(--v2-text-text-faint)" : "var(--v2-state-fg-success)"],
              [language.t("deveagent.dashboard.sessionCost"), costLabel(), undefined],
              [language.t("deveagent.dashboard.elapsed"), sessionMetrics.hasTaskAggregate() && elapsed !== undefined ? formatElapsed(elapsed) : "--", undefined],
              [language.t("deveagent.dashboard.requests"), String(sessionMetrics.rounds()), undefined],
              [language.t("deveagent.dashboard.totalTokens"), number().format(sessionMetrics.sessionTotalTokens()), undefined],
            ]
            if (serverMemory()) rows.push([language.t("deveagent.dashboard.memoryRss"), `${serverMemory()!.rssMB} MB`, undefined])
            return rows.map(([label, value, color]) => (
              <div class="flex items-center justify-between py-1">
                <span class="text-[11px] text-v2-text-text-muted">{label}</span>
                <span class="text-[12px] tabular-nums" style={color ? { color } : undefined}>{value}</span>
              </div>
            ))
          })()}
        </div>
      </div>


      <DeveAgentMarkItDownStatus events={markitdownEvents()} />

      <div class="grid grid-cols-2 gap-2">
        <div class="col-span-2 p-3 bg-v2-background-bg-layer-02 rounded-lg border border-v2-border-border-base">
          <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">{language.t("deveagent.dashboard.costEstimate")}</div>
            <Select<CostCurrencyOption>
              size="normal"
              options={[...costCurrencyOptions]}
              current={displayCurrency() as CostCurrencyOption}
              label={(value) => costCurrencyLabel(value, language.t("deveagent.dashboard.costNative"))}
              onSelect={(value) => {
                if (value) updateDisplayCurrency(value)
              }}
              class="min-w-[94px] border border-v2-border-border-base bg-v2-background-bg-layer-01 text-[11px] text-v2-text-text-base"
              valueClass="truncate text-[11px] text-v2-text-text-base"
              triggerProps={{ "aria-label": language.t("deveagent.dashboard.costDisplayCurrency"), value: displayCurrency() }}
            />
          </div>
          <div class="text-[18px] font-semibold tabular-nums text-v2-state-fg-warning">{costLabel()}</div>
          <div class="text-[10px] text-v2-text-text-muted">{conversionLabel()}</div>
        </div>
        <div class="p-3 bg-v2-background-bg-layer-02 rounded-lg border border-v2-border-border-base">
          <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">{language.t("deveagent.statusbar.rounds")}</div>
          <div class="text-[16px] font-bold">{sessionMetrics.rounds()}</div>
        </div>
        <Show when={sessionMetrics.hasTaskTiming()}>
          <div class="p-3 bg-v2-background-bg-layer-02 rounded-lg border border-v2-border-border-base">
            <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">
              {sessionMetrics.taskTiming().completedElapsedMs !== undefined
                ? sessionMetrics.hasTaskAggregate()
                  ? language.t("deveagent.dashboard.taskCompleted")
                  : language.t("deveagent.dashboard.sessionCompleted")
                : sessionMetrics.hasTaskAggregate()
                  ? language.t("deveagent.statusbar.taskSpan")
                  : language.t("deveagent.dashboard.sessionSpan")}
            </div>
            <div class="text-[16px] font-bold">{formatElapsed(sessionMetrics.taskTiming().elapsedMs ?? 0)}</div>
            <div class="mt-0.5 text-[10px] text-v2-text-text-muted">
              {sessionMetrics.taskTiming().completedElapsedMs !== undefined
                ? sessionMetrics.hasTaskAggregate()
                  ? language.t("deveagent.dashboard.allIdle")
                  : language.t("deveagent.dashboard.sessionIdle")
                : sessionMetrics.hasTaskAggregate()
                  ? language.t("deveagent.dashboard.spanRootToLastSubtask")
                  : language.t("deveagent.dashboard.spanCreationToLatest")}
            </div>
            <Show when={sessionMetrics.taskTiming().completedAt !== undefined}>
              <div class="mt-0.5 text-[10px] text-v2-text-text-muted">{language.t("deveagent.dashboard.completedAt")} {formatTimestamp(sessionMetrics.taskTiming().completedAt)}</div>
            </Show>
          </div>
        </Show>
        <Show when={sessionMetrics.taskAgents().length > 0}>
          <div class="col-span-2 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02 p-3">
            <div class="mb-2 flex items-center justify-between gap-2">
              <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">{language.t("deveagent.statusbar.subagents")}</div>
              <div class="text-[11px] font-medium text-v2-text-text-base">{language.t("deveagent.dashboard.subagentCount", { count: sessionMetrics.taskAgents().length })}</div>
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
          <div class="text-[10px] text-v2-text-text-muted" title={language.t("deveagent.dashboard.includesSubagents")}>{language.t("deveagent.dashboard.totalInput")}</div>
          <div class="text-[16px] font-bold">{sessionMetrics.hasUsage() ? number().format(sessionMetrics.sessionInputTokens()) : language.t("deveagent.dashboard.notReturned")}</div>
        </div>
        <div class="p-3 bg-v2-background-bg-layer-02 rounded-lg border border-v2-border-border-base">
          <div class="text-[10px] text-v2-text-text-muted" title={language.t("deveagent.dashboard.includesSubagents")}>{language.t("deveagent.dashboard.totalOutput")}</div>
          <div class="text-[16px] font-bold">{sessionMetrics.hasUsage() ? number().format(sessionMetrics.sessionOutputTokens()) : language.t("deveagent.dashboard.notReturned")}</div>
        </div>
        <div class="p-3 bg-v2-background-bg-layer-02 rounded-lg border border-v2-border-border-base">
          <div class="text-[10px] text-v2-text-text-muted" title={language.t("deveagent.dashboard.includesSubagents")}>{language.t("deveagent.dashboard.sessionTokens")}</div>
          <div class="text-[16px] font-bold">{sessionMetrics.hasUsage() ? number().format(sessionMetrics.sessionTotalTokens()) : language.t("deveagent.dashboard.notReturned")}</div>
          <Show when={sessionMetrics.teamUsage().tokens > 0}>
            <div class="text-[10px] text-v2-text-text-muted">
              {language.t("deveagent.statusbar.subagents")} {number().format(sessionMetrics.teamUsage().tokens)} · {sessionMetrics.teamUsage().rounds} {language.t("deveagent.dashboard.rounds")}
              {sessionMetrics.teamUsageSource() === "native-session" ? ` · ${language.t("deveagent.dashboard.subsessions")}` : ` · ${language.t("deveagent.dashboard.legacyLedgerFallback")}`}
            </div>
          </Show>
        </div>
        <div class="p-3 bg-v2-background-bg-layer-02 rounded-lg border border-v2-border-border-base">
          <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">{language.t("deveagent.dashboard.metricsSource")}</div>
          <div class="text-[12px] font-medium text-v2-text-text-base">
            {sessionMetrics.hasContext() ? language.t("deveagent.dashboard.sessionData") : language.t("deveagent.dashboard.awaitingModelUsage")}
          </div>
        </div>
      </div>
      <div class="rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02 p-3">
        <div class="flex items-center justify-between gap-2">
          <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">Provider Failover</div>
          <span class="text-[10px] text-v2-text-text-muted">{language.t("deveagent.dashboard.globalDefault")}</span>
        </div>
        <Show
          when={fallbackChain().length > 0}
          fallback={<div class="mt-1 text-[12px] text-v2-text-text-muted">{language.t("deveagent.dashboard.noFallbackChain")}</div>}
        >
          <div class="mt-1 break-words text-[12px] font-medium text-v2-text-text-base">
            {fallbackChain().map((model) => `${model.providerID}/${model.modelID}`).join(" -> ")}
          </div>
        </Show>
        <div class="mt-1 text-[10px] leading-4 text-v2-text-text-muted">
          {language.t("deveagent.dashboard.fallbackChainHint")}
        </div>
        <Show when={fallbackChain().length > 0}>
          <div class="mt-2 flex flex-wrap gap-1">
            <For each={fallbackChain()}>
              {(model) => (
                <button
                  type="button"
                  class="inline-flex items-center gap-1 rounded border border-border-weak-base bg-background-base px-1.5 py-0.5 text-[10px] text-text-base hover:border-red-500/50"
                  title={language.t("deveagent.dashboard.removeModel", { model: `${model.providerID}/${model.modelID}` })}
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
              <option value="">{language.t("deveagent.dashboard.addConnectedModel")}</option>
              <For each={availableFallbackModels()}>
                {(model) => (
                  <option value={`${model.provider.id}/${model.id}`}>
                    {model.provider.name} · {model.name} ({model.paid ? language.t("deveagent.dashboard.fallbackPaidTag") : language.t("model.tag.free")})
                  </option>
                )}
              </For>
            </select>
            <button
              type="button"
              class="rounded border border-v2-border-border-focus/40 bg-v2-background-bg-accent/10 px-2 text-[11px] font-medium text-text-base disabled:opacity-50"
              disabled={!fallbackCandidate() || savingFallbackChain()}
              onClick={addFallbackCandidate}
            >
              {language.t("deveagent.dashboard.add")}
            </button>
          </div>
        </Show>
        <div class="mt-1 text-[10px] leading-4 text-v2-text-text-muted">
          {language.t("deveagent.dashboard.fallbackPaidHint")}
        </div>
        <label class="mt-1 flex items-center gap-1.5 text-[10px] text-v2-text-text-muted">
          <input
            type="checkbox"
            checked={allowPaidFallback()}
            disabled={savingFallbackChain()}
            onChange={(event) => void saveAllowPaidFallback(event.currentTarget.checked)}
          />
          <span>{language.t("deveagent.dashboard.fallbackAllowPaid")}</span>
        </label>
      </div>
      <Show when={params.id}>
        <div class="rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02 p-3">
          <div class="flex items-center justify-between gap-2">
            <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">Session Vision Chain</div>
            <Show
              when={sessionAuxiliary()?.overridden}
              fallback={<span class="text-[10px] text-v2-text-text-muted">{language.t("deveagent.dashboard.globalDefault")}</span>}
            >
              <button
                type="button"
                class="text-[10px] text-v2-text-text-accent hover:underline disabled:opacity-50"
                disabled={savingVisionChain()}
                onClick={() => void resetSessionVisionChain()}
              >
                {language.t("deveagent.dashboard.restoreGlobal")}
              </button>
            </Show>
          </div>
          <Show
            when={visionChain().length > 0}
            fallback={<div class="mt-1 text-[12px] text-v2-text-text-muted">{language.t("deveagent.dashboard.usingGlobalVision")}</div>}
          >
            <div class="mt-1 break-words text-[12px] font-medium text-v2-text-text-base">
              {visionChain().map((model) => `${model.providerID}/${model.modelID}`).join(" -> ")}
            </div>
          </Show>
          <div class="mt-1 text-[10px] leading-4 text-v2-text-text-muted">
            {language.t("deveagent.dashboard.visionCandidatesHint")}
          </div>
          <Show when={visionChain().length > 0}>
            <div class="mt-2 flex flex-wrap gap-1">
              <For each={visionChain()}>
                {(model) => (
                  <button
                    type="button"
                    class="inline-flex items-center gap-1 rounded border border-border-weak-base bg-background-base px-1.5 py-0.5 text-[10px] text-text-base hover:border-red-500/50"
                    title={language.t("deveagent.dashboard.removeModel", { model: `${model.providerID}/${model.modelID}` })}
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
                aria-label={language.t("deveagent.dashboard.addSessionVisionModel")}
                class="min-w-0 flex-1 rounded border border-border-weak-base bg-background-base px-1.5 py-1 text-[11px] text-text-base outline-none"
                value={visionCandidate()}
                disabled={savingVisionChain()}
                onChange={(event) => setVisionCandidate(event.currentTarget.value)}
              >
                <option value="">{language.t("deveagent.dashboard.addVisionModel")}</option>
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
                {language.t("deveagent.dashboard.add")}
              </button>
            </div>
          </Show>
        </div>
      </Show>
      <DeveAgentVisionConfigPanel />
      <details class="border-t border-v2-border-border-base pt-3">
        <summary class="cursor-pointer text-[10px] text-v2-text-text-muted hover:text-v2-text-text-base">
          {language.t("deveagent.dashboard.speechAdvanced")}
        </summary>
        <select
          aria-label={language.t("deveagent.dashboard.speechTranscriptionModel")}
          class="mt-2 w-full rounded border border-border-weak-base bg-background-base px-1.5 py-1 text-[11px] text-text-base outline-none"
          value={speechModelValue()}
          disabled={savingSpeechModel()}
          onChange={(event) => void saveSpeechModel(event.currentTarget.value)}
        >
          <option value="">{language.t("deveagent.dashboard.noSpeechModel")}</option>
          <For each={models.list().slice(0, 300)}>
            {(model) => <option value={`${model.provider.id}/${model.id}`}>{model.provider.name} · {model.name}</option>}
          </For>
        </select>
      </details>
      <DeveAgentSttConfigPanel />
      <DeveAgentRoleProfilesPanel />

       <details class="rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02">
        <summary class="cursor-pointer px-3 py-2 text-[11px] text-v2-text-text-muted hover:text-v2-text-text-base">
          {language.t("deveagent.dashboard.moreSections")}
        </summary>
        <div class="flex flex-col gap-2 p-2">
       <DeveagentTrustCard />
       <DeveagentCuAuditCard />
       <DeveagentRunsCard />
       <DeveagentRewindPicker />
       <DeveagentAgentBoard />
       <DeveagentSessionTree />
       <DeveagentSkillCandidatesCard />
       <DeveagentAutomationsPanel />
        </div>
       </details>
        </Match>
        <Match when={activeTab() === "files"}>
          <div class="flex flex-col gap-2">
            <Show
              when={files().length > 0}
              fallback={
                <div class="p-4 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02 text-[12px] text-v2-text-text-muted">
                  {language.t("deveagent.dashboard.noExplicitContextFiles")}
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
                          {language.t("deveagent.shell.remove")}
                        </button>
                      </Show>
                    </div>
                    <div class="mt-1 text-[10px] text-v2-text-text-muted">
                      {item.source} · {packedFile(item.path) ? `~${compactTokens(packedFile(item.path)!.estimatedTokens)} tokens${packedFile(item.path)!.compressed ? ` · ${language.t("deveagent.dashboard.fileCompacted")}` : ""}` : language.t("deveagent.dashboard.awaitingContextPack")}
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
                      CodeGraph {item.source === "codegraph import" ? language.t("deveagent.dashboard.importLink") : language.t("deveagent.dashboard.callLink")} · ~{compactTokens(item.estimatedTokens)} tokens{item.compressed ? ` · ${language.t("deveagent.dashboard.fileCompacted")}` : ""}
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
                  {language.t("deveagent.dashboard.noChanges")}
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
                <div class="text-[12px] font-semibold text-v2-text-text-base">{language.t("deveagent.codegraph.subtitle")}</div>
                <div class="flex-1" />
                <button
                  type="button"
                  class="rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1 text-[11px] text-v2-text-text-base hover:border-v2-border-border-focus disabled:opacity-50"
                  disabled={indexing()}
                  onClick={refreshGraphIndex}
                >
                  {indexing() ? language.t("deveagent.codegraph.indexing") : language.t("deveagent.codegraph.refresh")}
                </button>
              </div>
              <div class="mt-2 text-[12px] leading-5 text-v2-text-text-muted">
                {language.t("deveagent.codegraph.contextPackNote")}
              </div>
              <Show when={graphIndex()}>
                {(index) => (
                  <div class="mt-2 rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 p-2 text-[11px] text-v2-text-text-muted">
                    {number().format(index().fileCount)} {language.t("deveagent.codegraph.countFiles")} · {number().format(index().symbolCount)} {language.t("deveagent.codegraph.countSymbols")} · {number().format(index().importEdgeCount)} {language.t("deveagent.codegraph.importEdges")} · {number().format(index().callEdgeCount)} {language.t("deveagent.codegraph.callEdges")}
                    <div class="mt-1">{language.t("deveagent.codegraph.reused")} {number().format(index().reusedFileCount)} · {language.t("deveagent.codegraph.rebuilt")} {number().format(index().reindexedFileCount)}</div>
                    <div class="mt-1 truncate" title={index().outputPath}>{index().outputPath}</div>
                  </div>
                )}
              </Show>
              <Show when={graphIndexError()}>
                {(error) => <div class="mt-2 text-[11px] text-v2-state-fg-danger">{language.t("deveagent.codegraph.indexFailedPrefix")}{error()}</div>}
              </Show>
              <Show when={graphIndexStatusLoading()}>
                <div class="mt-2 text-[11px] text-v2-text-text-muted">{language.t("deveagent.codegraph.readingStatus")}</div>
              </Show>
              <Show when={graphIndexStatusError()}>
                {(error) => <div class="mt-2 text-[11px] text-v2-state-fg-danger">{language.t("deveagent.codegraph.statusFailedPrefix")}{error()}</div>}
              </Show>
              <Show when={graphIndexStatus()}>
                {(status) => (
                  <div class={`mt-2 text-[11px] ${status().available && status().staleFileCount > 0 ? "text-amber-600 dark:text-amber-300" : "text-v2-text-text-muted"}`}>
                    {!status().available
                      ? language.t("deveagent.codegraph.noIndex")
                      : status().staleFileCount > 0
                        ? language.t("deveagent.codegraph.staleIndex", { count: number().format(status().staleFileCount) })
                        : language.t("deveagent.codegraph.indexMatches")}
                  </div>
                )}
              </Show>
              <Show when={!sdk().directory}>
                <div class="mt-2 rounded-md border border-dashed border-v2-border-border-base bg-v2-background-bg-layer-01 p-2 text-[11px] text-v2-text-text-muted">
                  {language.t("deveagent.codegraph.noWorkspaceForIndex")}
                </div>
              </Show>
              <Show when={indexing() && sdk().directory}>
                <div class="mt-2 text-[11px] text-v2-text-text-muted">{language.t("deveagent.codegraph.buildingIndex")}</div>
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
                  {language.t("deveagent.codegraph.noStatusHint")}
                </div>
              </Show>
              <div class="mt-3 grid grid-cols-2 gap-2">
                <div class="rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 p-2">
                  <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">{language.t("deveagent.codegraph.estimatedTokens")}</div>
                  <div class="text-[18px] font-bold text-v2-text-text-base">
                    {contextPack() ? number().format(contextPack()!.totalEstimatedTokens) : contextPackLoading() ? language.t("deveagent.codegraph.reading") : "--"}
                  </div>
                </div>
                <div class="rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 p-2">
                  <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">{language.t("deveagent.codegraph.packFiles")}</div>
                  <div class="text-[18px] font-bold text-v2-text-text-base">
                    {contextPack() ? contextPack()!.files.length : contextPackLoading() ? language.t("deveagent.codegraph.reading") : "--"}
                  </div>
                </div>
              </div>
              <Show when={contextPack() && (contextPack()!.tokensSaved ?? 0) > 0}>
                <div class="mt-2 rounded-md border border-green-500/40 bg-green-500/10 p-2 text-[11px] font-medium text-green-700 dark:text-green-300">
                  {language.t("deveagent.codegraph.tokenSaverSaved", { count: number().format(contextPack()!.tokensSaved ?? 0) })}
                  <span class="text-[10px] font-normal text-v2-text-text-muted"> · {language.t("deveagent.codegraph.original")} {number().format(contextPack()!.totalOriginalTokens ?? 0)} → {language.t("deveagent.codegraph.afterCompaction")} {number().format(contextPack()!.totalEstimatedTokens)}</span>
                </div>
              </Show>
              <Show when={contextPack() && contextPack()!.tokenSaverEnabled === false}>
                <div class="mt-2 rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 p-2 text-[11px] text-v2-text-text-muted">
                  {language.t("deveagent.codegraph.tokenSaverOffHint")}
                </div>
              </Show>
              <Show when={contextPackError()}>
                {(error) => <div class="mt-2 text-[11px] text-v2-state-fg-danger">{language.t("deveagent.codegraph.contextPackFailedPrefix")}{error()}</div>}
              </Show>
              <Show when={contextPackLoading()}>
                <div class="mt-2 text-[11px] text-v2-text-text-muted">{language.t("deveagent.codegraph.readingContextPack")}</div>
              </Show>
              <Show when={!sdk().directory}>
                <div class="mt-2 rounded-md border border-dashed border-v2-border-border-base bg-v2-background-bg-layer-01 p-2 text-[11px] text-v2-text-text-muted">
                  {language.t("deveagent.codegraph.noWorkspaceForContextPack")}
                </div>
              </Show>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div class="p-3 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02">
                <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">{language.t("deveagent.codegraph.contextFiles")}</div>
                <div class="text-[18px] font-bold text-v2-text-text-base">{contextFiles().length}</div>
                <div class="mt-1 text-[10px] text-v2-text-text-muted">{language.t("deveagent.codegraph.contextFilesSource")}</div>
              </div>
              <div class="p-3 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02">
                <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">{language.t("deveagent.codegraph.sessionChanges")}</div>
                <div class="text-[18px] font-bold text-v2-text-text-base">{changes().length}</div>
                <div class="mt-1 text-[10px] text-v2-text-text-muted">{language.t("deveagent.codegraph.sessionChangesSource")}</div>
              </div>
            </div>
            <Show
              when={contextPack()?.files.length}
              fallback={
                <div class="p-4 rounded-lg border border-dashed border-v2-border-border-base bg-v2-background-bg-layer-01 text-[12px] text-v2-text-text-muted">
                  {language.t("deveagent.codegraph.noFilesToPack")}
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
                          : language.t("deveagent.codegraph.unreadable", { reason: item.reason ?? "unknown" })}
                      </div>
                      <Show when={item.compressed && item.originalTokens}>
                        <div class="mt-1 inline-flex items-center gap-1 rounded bg-green-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-green-700 dark:text-green-300">
                          {language.t("deveagent.codegraph.compacted")} · {language.t("deveagent.codegraph.orig")} {number().format(item.originalTokens!)} → {language.t("deveagent.codegraph.now")} {number().format(item.estimatedTokens)} tokens
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

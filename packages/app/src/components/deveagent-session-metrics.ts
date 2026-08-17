import { createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2/client"

import { useSync } from "@/context/sync"
import { useProviders } from "@/hooks/use-providers"
import { useSessionLayout } from "@/pages/session/session-layout"
import { useServerSDK } from "@/context/server-sdk"
import { getSessionContextMetrics } from "@/components/session/session-context-metrics"
import {
  createDeveAgentCostViewModel,
  deveAgentChildSessionIDs,
  resolveDeveAgentTaskRootSessionID,
  deveAgentTokenTotal,
  detectDeveAgentNativeCurrency,
  summarizeDeveAgentMessageCost,
  summarizeDeveAgentChildSessionUsage,
  summarizeDeveAgentTeamUsage,
  summarizeDeveAgentTaskTiming,
  summarizeDeveAgentSessionUsage,
  preferDeveAgentSessionSnapshots,
  preferDeveAgentSessionSnapshot,
  type DeveAgentCostCurrencyInput,
  type DeveAgentCostEntry,
} from "@/components/deveagent-session-metrics-model"

export function createDeveAgentSessionMetrics() {
  const sync = useSync()
  const providers = useProviders()
  const serverSDK = useServerSDK()
  const { params } = useSessionLayout()

  const messages = createMemo(() => (params.id ? (sync().data.message[params.id] ?? []) : []))
  const assistantMessages = createMemo(() => messages().filter((message) => message.role === "assistant"))
  const assistantMessagesWithTokens = createMemo(() => assistantMessages().filter((message) => deveAgentTokenTotal(message) > 0))
  const currentSessionUsage = createMemo(() => summarizeDeveAgentSessionUsage(messages()))
  const [teamRevision, setTeamRevision] = createSignal(0)
  const refreshTaskMetrics = () => setTeamRevision((value) => value + 1)

  const [taskLineage] = createResource(
    // A TaskTool child can finish after this view has opened. Refresh the
    // lineage with the same cadence as the native child tree so the root's
    // persisted cumulative usage cannot remain stuck on its first snapshot.
    () => (params.id ? { base: serverSDK().url, sessionID: params.id, revision: teamRevision() } : undefined),
    async (input): Promise<Session[]> => {
      const lineage: Session[] = []
      const seen = new Set<string>()
      let sessionID: string | undefined = input.sessionID
      while (sessionID && !seen.has(sessionID) && lineage.length < 12) {
        seen.add(sessionID)
        try {
          const response: { data?: Session } = await serverSDK().client.session.get({ sessionID })
          const session: Session | undefined = response.data
          if (!session) break
          lineage.push(session)
          sessionID = session.parentID
        } catch {
          break
        }
      }
      return lineage
    },
  )
  const knownSessions = createMemo(() => preferDeveAgentSessionSnapshots([...(sync().data.session ?? []), ...(taskLineage() ?? [])]))
  const taskRootSessionID = createMemo(() =>
    resolveDeveAgentTaskRootSessionID(taskLineage() ?? [], knownSessions(), params.id),
  )

  onMount(() => {
    // Child tasks complete independently of the parent message stream.
    const timer = window.setInterval(() => setTeamRevision((value) => value + 1), 3_000)
    onCleanup(() => window.clearInterval(timer))
  })

  const [teamRuns] = createResource(
    // Parent messages and completed child tasks can arrive independently.
    () => (taskRootSessionID() ? { base: serverSDK().url, sessionID: taskRootSessionID()!, revision: messages().length, teamRevision: teamRevision() } : undefined),
    async (input) => {
      try {
        const response = await serverSDK().fetch(
          `${input.base.replace(/\/+$/, "")}/api/deveagent/team-runs?sessionID=${encodeURIComponent(input.sessionID)}`,
        )
        if (!response.ok) return []
        const payload = await response.json()
        return Array.isArray(payload) ? payload : []
      } catch {
        // ponytail: the parent-session metrics remain useful when the optional team ledger is unavailable
        return []
      }
    },
  )
  const ledgerTeamUsage = createMemo(() => summarizeDeveAgentTeamUsage(teamRuns() ?? []))
  const [nativeChildren] = createResource(
    // The synced sidebar session list is paginated. Ask OpenCode for children
    // directly so a completed TaskTool child cannot disappear from metrics just
    // because it was never visible in that list.
    () =>
      taskRootSessionID()
        ? { sessionID: taskRootSessionID()!, revision: teamRevision(), cachedSessions: sync().data.session.length }
        : undefined,
    async (input) => {
      const known = new Set([input.sessionID])
      const pending = [input.sessionID]
      const children: Session[] = []

      while (pending.length > 0 && children.length < 48) {
        const parentID = pending.shift()!
        try {
          const response = await serverSDK().client.session.children({ sessionID: parentID })
          for (const child of response.data ?? []) {
            if (!child?.id || known.has(child.id)) continue
            known.add(child.id)
            // The children endpoint establishes this relationship even when
            // its compact record omits parentID. Preserve it for the later
            // aggregate walk; otherwise the child is discovered but counted
            // as an unrelated session.
            children.push(child.parentID ? child : { ...child, parentID })
            pending.push(child.id)
          }
        } catch {
          // ponytail: the cached tree and team ledger remain useful when a host lacks the children endpoint
          break
        }
      }
      return children
    },
  )
  const nativeChildSessionIDs = createMemo(() =>
    deveAgentChildSessionIDs([...knownSessions(), ...(nativeChildren() ?? [])], taskRootSessionID()),
  )
  const taskSessionIDs = createMemo(() => {
    const root = taskRootSessionID()
    return root ? [root, ...nativeChildSessionIDs()] : []
  })
  const [taskSessionSnapshots] = createResource(
    () => {
      const sessionIDs = taskSessionIDs()
      return sessionIDs.length > 0 ? { sessionIDs: sessionIDs.join(","), revision: teamRevision() } : undefined
    },
    async (input): Promise<Session[]> => {
      const snapshots = await Promise.all(
        input.sessionIDs.split(",").map(async (sessionID) => {
          try {
            return (await serverSDK().client.session.get({ sessionID })).data
          } catch {
            return undefined
          }
        }),
      )
      return snapshots.filter((session): session is Session => Boolean(session))
    },
  )
  const taskSessions = createMemo(() =>
    preferDeveAgentSessionSnapshots([...(sync().data.session ?? []), ...(taskLineage() ?? []), ...(nativeChildren() ?? []), ...(taskSessionSnapshots() ?? [])]),
  )
  const taskTiming = createMemo(() =>
    summarizeDeveAgentTaskTiming(taskSessions(), taskRootSessionID(), sync().data.session_status),
  )
  const hasTaskTiming = createMemo(() => taskTiming().elapsedMs !== undefined)
  createEffect(() => {
    // Child sessions do not stream into the parent timeline. Refresh their own
    // message lists on the existing metrics cadence so a first empty fetch
    // cannot leave the parent permanently stuck with only its own usage.
    teamRevision()
    for (const sessionID of taskSessionIDs()) {
      void sync()
        .session.sync(sessionID, { force: true })
        // A completed/removed child can disappear between the task tree read
        // and this cadence. The parent metrics resource will refresh normally.
        .catch(() => undefined)
    }
  })
  const nativeChildUsage = createMemo(() =>
    // `session.children` can return a completed TaskTool child before the
    // paginated session cache knows about it. Keep that authoritative tree in
    // the usage calculation as well as in the refresh list.
    summarizeDeveAgentChildSessionUsage(taskSessions(), taskRootSessionID(), sync().data.message),
  )
  const taskAgents = createMemo(() =>
    nativeChildSessionIDs().flatMap((sessionID) => {
      const session = taskSessions().find((item) => item.id === sessionID)
      if (!session) return []
      const usage = summarizeDeveAgentSessionUsage(sync().data.message[sessionID] ?? [], session)
      return [{
        id: sessionID,
        title: typeof session.title === "string" && session.title.trim() ? session.title : sessionID,
        status: sync().data.session_status[sessionID]?.type ?? "unknown",
        tokens: usage.total,
        updatedAt: session.time?.updated,
      }]
    }),
  )
  // Native TaskTool sessions are the authoritative record. The legacy ledger
  // remains useful while a just-created child has not written its usage yet.
  const hasNativeChildUsage = createMemo(() => nativeChildUsage().tokens > 0 || ledgerTeamUsage().tasks === 0)
  const teamUsage = createMemo(() => (hasNativeChildUsage() ? nativeChildUsage() : ledgerTeamUsage()))
  const teamUsageSource = createMemo(() => (hasNativeChildUsage() && nativeChildUsage().tasks > 0 ? "native-session" : ledgerTeamUsage().tasks > 0 ? "ledger" : "none"))
  // A child can be opened before the sibling task list has hydrated. Its task
  // root is still authoritative, so do not fall back to the child's local
  // context window merely because the child count is temporarily zero.
  const hasTaskAggregate = createMemo(() => Boolean(params.id && taskRootSessionID() && taskRootSessionID() !== params.id) || teamUsage().tasks > 0)
  const metrics = createMemo(() => getSessionContextMetrics(messages(), [...providers.all().values()]))
  const context = createMemo(() => metrics().context)
  const messageCost = (items: Parameters<typeof summarizeDeveAgentMessageCost>[0]) =>
    summarizeDeveAgentMessageCost(items, (message) => {
      const provider = message.providerID ? providers.all().get(message.providerID) : undefined
      return message.modelID ? provider?.models[message.modelID] : undefined
    })
  const parentCost = createMemo(() => messageCost(messages()))
  const taskRootSession = createMemo(() => {
    const root = taskRootSessionID()
    if (!root) return undefined
    // The lineage fetch can finish before a long task updates its persisted
    // usage. Compare it with the recurring OpenCode sync instead of pinning
    // this view to whichever snapshot arrived first.
    return preferDeveAgentSessionSnapshot(taskSessions(), root)
  })
  const taskRootUsage = createMemo(() => {
    const root = taskRootSessionID()
    return root ? summarizeDeveAgentSessionUsage(sync().data.message[root] ?? [], taskRootSession()) : currentSessionUsage()
  })

  const inputTokens = createMemo(() => context()?.input ?? 0)
  const outputTokens = createMemo(() => context()?.output ?? 0)
  const reasoningTokens = createMemo(() => context()?.reasoning ?? 0)
  const cacheReadTokens = createMemo(() => context()?.cacheRead ?? 0)
  const cacheWriteTokens = createMemo(() => context()?.cacheWrite ?? 0)
  const totalTokens = createMemo(() => context()?.total ?? 0)
  const contextLimit = createMemo(() => context()?.limit)
  const contextUsage = createMemo(() => context()?.usage ?? 0)
  const nativeCurrency = createMemo(() =>
    detectDeveAgentNativeCurrency({
      providerID: context()?.message.providerID,
      providerLabel: context()?.providerLabel,
      modelID: context()?.message.modelID,
      modelLabel: context()?.modelLabel,
      explicitCurrency: context()?.model?.cost?.currency,
    }),
  )
  const costEntries = createMemo<DeveAgentCostEntry[]>(() => {
    const sessions = new Map(taskSessions().map((session) => [session.id, session]))
    const entries: DeveAgentCostEntry[] = []
    const addMessageEntries = (items: Parameters<typeof summarizeDeveAgentMessageCost>[0], fallback: DeveAgentCostCurrencyInput) => {
      for (const message of items ?? []) {
        const amount = messageCost([message]).amount
        if (!amount) continue
        const providerID = message.providerID ?? fallback.providerID
        const modelID = message.modelID ?? fallback.modelID
        const provider = providerID ? providers.all().get(providerID) : undefined
        const model = modelID ? provider?.models[modelID] : undefined
        entries.push({
          amount,
          source: "estimate",
          currency: detectDeveAgentNativeCurrency({
            providerID,
            providerLabel: provider?.name ?? fallback.providerLabel,
            modelID,
            modelLabel: model?.name ?? fallback.modelLabel,
            explicitCurrency: (model?.cost as { currency?: string } | undefined)?.currency ?? fallback.explicitCurrency,
          }),
        })
      }
    }
    for (const sessionID of taskSessionIDs()) {
      const childMetrics = getSessionContextMetrics(sync().data.message[sessionID] ?? [], [...providers.all().values()])
      const session = sessions.get(sessionID)
      const providerID = session?.model?.providerID ?? childMetrics.context?.message.providerID
      const modelID = session?.model?.id ?? childMetrics.context?.message.modelID
      const provider = providerID ? providers.all().get(providerID) : undefined
      const model = modelID ? provider?.models[modelID] : undefined
      const modelCurrency = (model?.cost as { currency?: string } | undefined)?.currency ?? childMetrics.context?.model?.cost?.currency
      const messages = sync().data.message[sessionID] ?? []
      const messageUsage = summarizeDeveAgentSessionUsage(messages)
      const snapshotUsage = summarizeDeveAgentSessionUsage(messages, session)
      const messageCostSummary = messageCost(messages)
      const before = entries.length
      addMessageEntries(messages, { providerID, providerLabel: provider?.name, modelID, modelLabel: model?.name, explicitCurrency: modelCurrency })
      const messageAmount = entries.slice(before).reduce((sum, entry) => sum + (entry.amount ?? 0), 0)
      const persistedCost = session?.cost && session.cost > 0 ? session.cost : 0
      // Session cost is cumulative. Use it when pagination has only priced a
      // partial message page; otherwise retain per-message currencies.
      if (persistedCost > messageAmount) {
        entries.splice(before)
        entries.push({
          amount: persistedCost,
          source: "estimate",
          currency: detectDeveAgentNativeCurrency({ providerID, providerLabel: provider?.name, modelID, modelLabel: model?.name, explicitCurrency: modelCurrency }),
        })
        continue
      }
      // When the synced message page is incomplete, estimate the persisted
      // total from the active OpenCode model catalog.
      const onlyEstimatedMessageCost = messageCostSummary.priced === 0 || messageCostSummary.estimated === messageCostSummary.priced
      if (snapshotUsage.total > messageUsage.total && onlyEstimatedMessageCost && session?.tokens) {
        const snapshotEstimate = messageCost([
          { role: "assistant", providerID, modelID, tokens: session.tokens },
        ]).amount
        if (snapshotEstimate > messageAmount) {
          entries.splice(before)
          entries.push({
            amount: snapshotEstimate,
            source: "estimate",
            currency: detectDeveAgentNativeCurrency({ providerID, providerLabel: provider?.name, modelID, modelLabel: model?.name, explicitCurrency: modelCurrency }),
          })
          continue
        }
      }
      if (before !== entries.length) continue
      const amount = childMetrics.totalCost
      if (amount > 0) {
        entries.push({
          amount,
          source: "estimate",
          currency: detectDeveAgentNativeCurrency({ providerID, providerLabel: provider?.name, modelID, modelLabel: model?.name, explicitCurrency: modelCurrency }),
        })
      }
    }
    return entries
  })
  // The status bar has no chosen display currency, so retain a same-native
  // figure there. Overview uses `costEntries` for mixed-provider conversion.
  const totalCost = createMemo(() => costEntries().filter((entry) => entry.currency === nativeCurrency()).reduce((sum, entry) => sum + (entry.amount ?? 0), 0))
  // Count actual child assistant turns, not merely the number of child sessions.
  const rounds = createMemo(() => taskRootUsage().rounds + teamUsage().rounds)
  const hasContext = createMemo(() => Boolean(context()))
  const hasUsage = createMemo(() => taskRootUsage().hasUsage || teamUsage().tokens > 0)
  const sessionInputTokens = createMemo(() => taskRootUsage().input + teamUsage().input)
  const sessionOutputTokens = createMemo(() => taskRootUsage().output + teamUsage().output)
  const sessionReasoningTokens = createMemo(() => taskRootUsage().reasoning + teamUsage().reasoning)
  const sessionCacheReadTokens = createMemo(() => taskRootUsage().cacheRead + teamUsage().cacheRead)
  const sessionCacheWriteTokens = createMemo(() => taskRootUsage().cacheWrite + teamUsage().cacheWrite)
  const sessionTotalTokens = createMemo(() => taskRootUsage().total + teamUsage().tokens)
  const cacheHitRate = createMemo(() => {
    const denominator = sessionInputTokens() + sessionCacheReadTokens() + sessionCacheWriteTokens()
    if (denominator <= 0) return 0
    return (sessionCacheReadTokens() / denominator) * 100
  })
  const costView = createMemo(() =>
    createDeveAgentCostViewModel({
      totalCost: totalCost(),
      currency: {
        providerID: context()?.message.providerID,
        providerLabel: context()?.providerLabel,
        modelID: context()?.message.modelID,
        modelLabel: context()?.modelLabel,
        // OpenCode model metadata is the only trustworthy currency source here.
        // It still represents model-price estimates, never an account balance.
        explicitCurrency: context()?.model?.cost?.currency,
      },
    }),
  )
  const childCostExcluded = createMemo(() => Math.max(0, costEntries().filter((entry) => entry.currency !== nativeCurrency()).length))

  return {
    messages,
    assistantMessages,
    assistantMessagesWithTokens,
    metrics,
    context,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    contextLimit,
    contextUsage,
    totalCost,
    rounds,
    hasContext,
    hasUsage,
    sessionInputTokens,
    sessionOutputTokens,
    sessionReasoningTokens,
    sessionCacheReadTokens,
    sessionCacheWriteTokens,
    sessionTotalTokens,
    teamUsage,
    taskAgents,
    teamUsageSource,
    hasTaskAggregate,
    hasTaskTiming,
    cacheHitRate,
    costView,
    nativeCurrency,
    costEntries,
    childCostExcluded,
    parentCost,
    taskRootSessionID,
    taskTiming,
    refreshTaskMetrics,
  }
}

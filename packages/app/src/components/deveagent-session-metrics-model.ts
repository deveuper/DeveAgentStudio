export type DeveAgentUsageMessage = {
  role: string
  cost?: number
  providerID?: string
  modelID?: string
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
}

export type DeveAgentTeamRunUsage = {
  tokens?: number
  cost?: number
  members?: Array<{
    tokens?: number
    rounds?: number
    input?: number
    output?: number
    reasoning?: number
    cacheRead?: number
    cacheWrite?: number
  }>
}

/**
 * OpenCode records native TaskTool children as sessions. Prefer this source
 * when it exists: it reflects every real child agent, not only DeveAgent's
 * own team ledger entries.
 */
export type DeveAgentChildSessionUsage = {
  id: string
  parentID?: string
  time?: {
    created?: number
    updated?: number
  }
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: {
      read?: number
      write?: number
    }
  }
  cost?: number
}

export type DeveAgentTaskTiming = {
  startedAt?: number
  updatedAt?: number
  elapsedMs?: number
  completedAt?: number
  completedElapsedMs?: number
}

/**
 * TaskTool work is represented by a root OpenCode session and native child
 * sessions. This reports their observed wall-clock span without claiming that
 * an idle session is completed; Goal completion remains owned by Goal state.
 */
export function summarizeDeveAgentTaskTiming(
  sessions: DeveAgentChildSessionUsage[] = [],
  rootID?: string,
  statuses: Record<string, { type?: string } | undefined> = {},
): DeveAgentTaskTiming {
  if (!rootID) return {}
  const ids = new Set([rootID, ...deveAgentChildSessionIDs(sessions, rootID)])
  let startedAt: number | undefined
  let updatedAt: number | undefined
  for (const session of sessions) {
    if (!ids.has(session.id)) continue
    const created = session.time?.created
    const updated = session.time?.updated
    if (typeof created === "number" && Number.isFinite(created) && created > 0) {
      startedAt = startedAt === undefined ? created : Math.min(startedAt, created)
    }
    if (typeof updated === "number" && Number.isFinite(updated) && updated > 0) {
      updatedAt = updatedAt === undefined ? updated : Math.max(updatedAt, updated)
    }
  }
  const elapsedMs = startedAt !== undefined && updatedAt !== undefined && updatedAt >= startedAt ? updatedAt - startedAt : undefined
  // A plain session is still a task. Only require every known session to be
  // idle; for a TaskTool tree this naturally includes the root and children.
  const completed = ids.size > 0 && [...ids].every((id) => statuses[id]?.type === "idle")
  return {
    startedAt,
    updatedAt,
    elapsedMs,
    completedAt: completed ? updatedAt : undefined,
    completedElapsedMs: completed ? elapsedMs : undefined,
  }
}

export type DeveAgentTeamUsageSummary = {
  tasks: number
  rounds: number
  tokens: number
  cost: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  unclassified: number
}

export type DeveAgentCurrency = "USD" | "CNY" | "EUR" | "JPY" | "KRW" | "HKD"

export type DeveAgentCostCurrencyInput = {
  providerID?: string
  providerLabel?: string
  modelID?: string
  modelLabel?: string
  explicitCurrency?: string
}

export type DeveAgentFxRate = {
  from: DeveAgentCurrency
  to: DeveAgentCurrency
  rate: number
  source: string
  timestamp: string
}

export type DeveAgentCostViewModel = {
  nativeCurrency: DeveAgentCurrency
  nativeAmount: number
  hasCost: boolean
  conversion:
    | {
        status: "converted"
        currency: DeveAgentCurrency
        amount: number
        source: string
        timestamp: string
      }
    | {
        status: "same-currency" | "unavailable"
        currency: DeveAgentCurrency
      }
}

export type DeveAgentCostEntry = {
  amount?: number
  currency?: DeveAgentCurrency
  // Provider-returned request cost and catalog pricing must never look alike.
  source?: "provider" | "estimate"
}

export type DeveAgentCostSummary = {
  hasCost: boolean
  groups: Array<{ currency: DeveAgentCurrency; amount: number }>
  convertedAmount?: number
  targetCurrency?: DeveAgentCurrency
  missingConversions: number
}

export type DeveAgentModelCost = {
  input: number
  output: number
  cache: {
    read: number
    write: number
  }
  tiers?: Array<{
    input: number
    output: number
    cache: { read: number; write: number }
    tier: { type: "context"; size: number }
  }>
  experimentalOver200K?: {
    input: number
    output: number
    cache: { read: number; write: number }
  }
}

export type DeveAgentCostModel = {
  cost?: DeveAgentModelCost
}

export function summarizeDeveAgentCompatibleCost(entries: DeveAgentCostEntry[] = [], currency?: DeveAgentCurrency) {
  return entries.reduce<{ amount: number; excluded: number }>(
    (summary, entry) => {
      const amount = typeof entry.amount === "number" && Number.isFinite(entry.amount) && entry.amount > 0 ? entry.amount : 0
      if (!amount) return summary
      if (!currency || entry.currency !== currency) {
        summary.excluded += 1
        return summary
      }
      summary.amount += amount
      return summary
    },
    { amount: 0, excluded: 0 },
  )
}

/**
 * Keep each provider's native estimate separate until the user explicitly
 * chooses a target currency. Adding USD and CNY directly would be false.
 */
export function summarizeDeveAgentCostEntries(
  entries: DeveAgentCostEntry[] = [],
  targetCurrency?: DeveAgentCurrency,
  fxRates: DeveAgentFxRate[] = [],
): DeveAgentCostSummary {
  const grouped = new Map<DeveAgentCurrency, number>()
  for (const entry of entries) {
    const amount = typeof entry.amount === "number" && Number.isFinite(entry.amount) && entry.amount > 0 ? entry.amount : 0
    if (!amount || !entry.currency) continue
    grouped.set(entry.currency, (grouped.get(entry.currency) ?? 0) + amount)
  }
  const groups = [...grouped.entries()].map(([currency, amount]) => ({ currency, amount })).sort((left, right) => left.currency.localeCompare(right.currency))
  if (!targetCurrency) return { hasCost: groups.length > 0, groups, missingConversions: 0 }

  let convertedAmount = 0
  let missingConversions = 0
  for (const group of groups) {
    if (group.currency === targetCurrency) {
      convertedAmount += group.amount
      continue
    }
    const rate = fxRates.find((item) => item.from === group.currency && item.to === targetCurrency && item.rate > 0)
    if (!rate) {
      missingConversions += 1
      continue
    }
    convertedAmount += group.amount * rate.rate
  }
  return {
    hasCost: groups.length > 0,
    groups,
    convertedAmount: convertedAmount || undefined,
    targetCurrency,
    missingConversions,
  }
}

/**
 * Mirrors OpenCode's Session.getUsage pricing for messages whose provider did
 * not persist a cost. This remains a model-catalog estimate, never an invoice.
 */
export function estimateDeveAgentMessageCost(message: DeveAgentUsageMessage, model?: DeveAgentCostModel) {
  if (message.role !== "assistant" || deveAgentTokenTotal(message) <= 0 || !model?.cost) return undefined
  const base = model.cost
  const contextTokens = (message.tokens?.input ?? 0) + (message.tokens?.cache.read ?? 0) + (message.tokens?.cache.write ?? 0)
  const price =
    base.tiers
      ?.filter((item) => item.tier.type === "context" && contextTokens > item.tier.size)
      .sort((left, right) => right.tier.size - left.tier.size)[0] ??
    (base.experimentalOver200K && contextTokens > 200_000 ? base.experimentalOver200K : base)
  const tokens = message.tokens!
  return (
    (tokens.input * price.input +
      tokens.output * price.output +
      tokens.reasoning * price.output +
      tokens.cache.read * price.cache.read +
      tokens.cache.write * price.cache.write) /
    1_000_000
  )
}

export function summarizeDeveAgentMessageCost(
  messages: DeveAgentUsageMessage[] = [],
  modelForMessage: (message: DeveAgentUsageMessage) => DeveAgentCostModel | undefined,
) {
  return messages.reduce(
    (summary, message) => {
      if (message.role !== "assistant" || deveAgentTokenTotal(message) <= 0) return summary
      if (typeof message.cost === "number" && Number.isFinite(message.cost) && message.cost > 0) {
        summary.amount += message.cost
        summary.priced += 1
        return summary
      }
      const estimate = estimateDeveAgentMessageCost(message, modelForMessage(message))
      if (estimate === undefined) {
        summary.unpriced += 1
        return summary
      }
      summary.amount += estimate
      summary.priced += 1
      summary.estimated += 1
      return summary
    },
    { amount: 0, priced: 0, estimated: 0, unpriced: 0 },
  )
}

export function deveAgentTokenTotal(message: DeveAgentUsageMessage) {
  if (!message.tokens) return 0
  return message.tokens.input + message.tokens.output + message.tokens.reasoning + message.tokens.cache.read + message.tokens.cache.write
}

export function summarizeDeveAgentSessionUsage(messages: DeveAgentUsageMessage[] = [], snapshot?: DeveAgentChildSessionUsage) {
  const assistantMessages = messages.filter((message) => message.role === "assistant")
  const assistantMessagesWithTokens = assistantMessages.filter((message) => deveAgentTokenTotal(message) > 0)
  const messageUsage = {
    rounds: assistantMessages.length,
    hasUsage: assistantMessagesWithTokens.length > 0,
    input: assistantMessagesWithTokens.reduce((sum, message) => sum + (message.tokens?.input ?? 0), 0),
    output: assistantMessagesWithTokens.reduce((sum, message) => sum + (message.tokens?.output ?? 0), 0),
    reasoning: assistantMessagesWithTokens.reduce((sum, message) => sum + (message.tokens?.reasoning ?? 0), 0),
    cacheRead: assistantMessagesWithTokens.reduce((sum, message) => sum + (message.tokens?.cache.read ?? 0), 0),
    cacheWrite: assistantMessagesWithTokens.reduce((sum, message) => sum + (message.tokens?.cache.write ?? 0), 0),
    total: assistantMessagesWithTokens.reduce((sum, message) => sum + deveAgentTokenTotal(message), 0),
    cost: assistantMessagesWithTokens.reduce((sum, message) => sum + (message.cost ?? 0), 0),
  }

  if (snapshot?.tokens) {
    const input = snapshot.tokens.input ?? 0
    const output = snapshot.tokens.output ?? 0
    const reasoning = snapshot.tokens.reasoning ?? 0
    const cacheRead = snapshot.tokens.cache?.read ?? 0
    const cacheWrite = snapshot.tokens.cache?.write ?? 0
    const total = input + output + reasoning + cacheRead + cacheWrite
    if (total > messageUsage.total) {
      // OpenCode persists this cumulative summary before a paginated message
      // sync has necessarily completed. A partial page must not mask it.
      return {
        rounds: messageUsage.rounds,
        hasUsage: true,
        input,
        output,
        reasoning,
        cacheRead,
        cacheWrite,
        total,
        cost: snapshot.cost && snapshot.cost > 0 ? snapshot.cost : messageUsage.cost,
      }
    }
  }

  return messageUsage
}

/**
 * The session list and the direct lineage request can briefly hold different
 * snapshots of the same session. Usage summaries are cumulative, so retain
 * the most complete OpenCode snapshot until paginated messages catch up.
 */
export function preferDeveAgentSessionSnapshot<T extends DeveAgentChildSessionUsage>(sessions: T[] = [], sessionID?: string) {
  let selected: T | undefined
  let selectedTotal = -1
  for (const session of sessions) {
    if (!sessionID || session.id !== sessionID) continue
    const total =
      (session.tokens?.input ?? 0) +
      (session.tokens?.output ?? 0) +
      (session.tokens?.reasoning ?? 0) +
      (session.tokens?.cache?.read ?? 0) +
      (session.tokens?.cache?.write ?? 0)
    // Later equal snapshots are from the current sync list and can carry
    // newer model/cost metadata without discarding an equal usage total.
    if (total >= selectedTotal) {
      selected = session
      selectedTotal = total
    }
  }
  return selected
}

/**
 * `session.children` returns compact records while `session.get` contains the
 * current cumulative usage. Keep one record per session, preferring the
 * largest cumulative usage so an early child summary cannot replace a later
 * direct snapshot.
 */
export function preferDeveAgentSessionSnapshots<T extends DeveAgentChildSessionUsage>(sessions: T[] = []) {
  const snapshots = new Map<string, T>()
  const total = (session: DeveAgentChildSessionUsage) =>
    (session.tokens?.input ?? 0) +
    (session.tokens?.output ?? 0) +
    (session.tokens?.reasoning ?? 0) +
    (session.tokens?.cache?.read ?? 0) +
    (session.tokens?.cache?.write ?? 0)

  for (const candidate of sessions) {
    const current = snapshots.get(candidate.id)
    if (!current) {
      snapshots.set(candidate.id, candidate)
      continue
    }
    const candidateTotal = total(candidate)
    const currentTotal = total(current)
    const candidateUpdated = candidate.time?.updated ?? 0
    const currentUpdated = current.time?.updated ?? 0
    const selected = candidateTotal > currentTotal || (candidateTotal === currentTotal && candidateUpdated >= currentUpdated) ? candidate : current
    const other = selected === candidate ? current : candidate
    snapshots.set(candidate.id, {
      ...selected,
      parentID: selected.parentID ?? other.parentID,
      time: { ...other.time, ...selected.time },
    })
  }
  return [...snapshots.values()]
}

/**
 * Team tasks run in child sessions, so their usage is not part of the parent
 * message list. Preserve unclassified tokens rather than inventing an
 * input/output/cache split for older TaskTool results.
 */
export function summarizeDeveAgentTeamUsage(runs: DeveAgentTeamRunUsage[] = []): DeveAgentTeamUsageSummary {
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0)
  return runs.reduce(
    (summary, run) => {
      const members = run.members ?? []
      const classified = members.reduce(
        (total, member) => total + number(member.input) + number(member.output) + number(member.reasoning) + number(member.cacheRead) + number(member.cacheWrite),
        0,
      )
      const tokens = number(run.tokens)
      summary.tasks += members.length
      summary.rounds += members.reduce((total, member) => total + number(member.rounds), 0)
      summary.tokens += tokens
      summary.cost += number(run.cost)
      for (const member of members) {
        summary.input += number(member.input)
        summary.output += number(member.output)
        summary.reasoning += number(member.reasoning)
        summary.cacheRead += number(member.cacheRead)
        summary.cacheWrite += number(member.cacheWrite)
      }
      summary.unclassified += Math.max(0, tokens - classified)
      return summary
    },
    { tasks: 0, rounds: 0, tokens: 0, cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, unclassified: 0 } as DeveAgentTeamUsageSummary,
  )
}

export function summarizeDeveAgentChildSessionUsage(
  sessions: DeveAgentChildSessionUsage[] = [],
  parentID?: string,
  messagesBySession: Record<string, DeveAgentUsageMessage[] | undefined> = {},
): DeveAgentTeamUsageSummary {
  if (!parentID) return summarizeDeveAgentTeamUsage()

  const known = new Set([parentID])
  const children: DeveAgentChildSessionUsage[] = []
  let changed = true
  while (changed) {
    changed = false
    for (const session of sessions) {
      if (!session.parentID || !known.has(session.parentID) || known.has(session.id)) continue
      known.add(session.id)
      children.push(session)
      changed = true
    }
  }

  return summarizeDeveAgentTeamUsage(
    children.map((session) => {
      // OpenCode stores completed TaskTool usage on assistant messages, not on
      // the session record. Session fields remain only for older cached data.
      // A child can stream only its latest page while OpenCode has already
      // persisted the full cumulative session summary. Pass both sources so a
      // partial page cannot shrink the task total in the parent overview.
      const usage = summarizeDeveAgentSessionUsage(messagesBySession[session.id] ?? [], session)
      const hasMessageUsage = usage.total > 0
      return {
        tokens: hasMessageUsage
          ? usage.total
          : (session.tokens?.input ?? 0) +
            (session.tokens?.output ?? 0) +
            (session.tokens?.reasoning ?? 0) +
            (session.tokens?.cache?.read ?? 0) +
            (session.tokens?.cache?.write ?? 0),
        cost: hasMessageUsage ? usage.cost : session.cost,
        members: [
          {
            rounds: hasMessageUsage ? usage.rounds : 0,
            input: hasMessageUsage ? usage.input : session.tokens?.input,
            output: hasMessageUsage ? usage.output : session.tokens?.output,
            reasoning: hasMessageUsage ? usage.reasoning : session.tokens?.reasoning,
            cacheRead: hasMessageUsage ? usage.cacheRead : session.tokens?.cache?.read,
            cacheWrite: hasMessageUsage ? usage.cacheWrite : session.tokens?.cache?.write,
          },
        ],
      }
    }),
  )
}

export function deveAgentChildSessionIDs(sessions: DeveAgentChildSessionUsage[] = [], parentID?: string) {
  if (!parentID) return []
  const known = new Set([parentID])
  const children: string[] = []
  let changed = true
  while (changed) {
    changed = false
    for (const session of sessions) {
      if (!session.parentID || !known.has(session.parentID) || known.has(session.id)) continue
      known.add(session.id)
      children.push(session.id)
      changed = true
    }
  }
  return children
}

/**
 * A TaskTool child can be opened directly from the session tree. Resolve its
 * top-level task so the task-total metric does not collapse to that child's
 * local context window.
 */
export function deveAgentTaskRootSessionID(sessions: DeveAgentChildSessionUsage[] = [], sessionID?: string) {
  if (!sessionID) return undefined
  const byID = new Map(sessions.map((session) => [session.id, session]))
  const seen = new Set<string>()
  let current = sessionID
  while (!seen.has(current)) {
    seen.add(current)
    const parentID = byID.get(current)?.parentID
    if (!parentID) return current
    current = parentID
  }
  // ponytail: corrupt parent cycles keep the current session usable instead of looping metrics forever.
  return sessionID
}

/**
 * The directory cache can briefly omit a TaskTool child's parentID while the
 * direct session lookup has already walked the full lineage. Prefer the
 * completed direct lineage so opening a child cannot collapse metrics back to
 * that child's local usage.
 */
export function resolveDeveAgentTaskRootSessionID(
  lineage: DeveAgentChildSessionUsage[] = [],
  sessions: DeveAgentChildSessionUsage[] = [],
  sessionID?: string,
) {
  const directRoot = lineage.at(-1)
  if (lineage[0]?.id === sessionID && directRoot && !directRoot.parentID) return directRoot.id
  return deveAgentTaskRootSessionID(sessions, sessionID)
}

const currencyAliases: Record<string, DeveAgentCurrency> = {
  usd: "USD",
  dollar: "USD",
  dollars: "USD",
  cny: "CNY",
  rmb: "CNY",
  yuan: "CNY",
  "¥": "CNY",
  eur: "EUR",
  euro: "EUR",
  jpy: "JPY",
  yen: "JPY",
  krw: "KRW",
  won: "KRW",
  hkd: "HKD",
}

export function normalizeDeveAgentCurrency(input?: string): DeveAgentCurrency | undefined {
  if (!input) return
  return currencyAliases[input.trim().toLowerCase()]
}

export function detectDeveAgentNativeCurrency(input: DeveAgentCostCurrencyInput = {}): DeveAgentCurrency {
  const explicit = normalizeDeveAgentCurrency(input.explicitCurrency)
  if (explicit) return explicit

  // OpenCode derives message cost from models.dev, whose catalog prices are USD.
  // A provider or model name alone cannot reveal the user's billing region.
  return "USD"
}

export function createDeveAgentCostViewModel(args: {
  totalCost: number
  currency: DeveAgentCostCurrencyInput
  targetCurrency?: DeveAgentCurrency
  fxRates?: DeveAgentFxRate[]
}): DeveAgentCostViewModel {
  const nativeCurrency = detectDeveAgentNativeCurrency(args.currency)
  const targetCurrency = args.targetCurrency ?? "CNY"
  const hasCost = Number.isFinite(args.totalCost) && args.totalCost > 0

  if (nativeCurrency === targetCurrency) {
    return {
      nativeCurrency,
      nativeAmount: args.totalCost,
      hasCost,
      conversion: {
        status: "same-currency",
        currency: targetCurrency,
      },
    }
  }

  const rate = args.fxRates?.find((item) => item.from === nativeCurrency && item.to === targetCurrency && item.rate > 0)
  if (!rate) {
    return {
      nativeCurrency,
      nativeAmount: args.totalCost,
      hasCost,
      conversion: {
        status: "unavailable",
        currency: targetCurrency,
      },
    }
  }

  return {
    nativeCurrency,
    nativeAmount: args.totalCost,
    hasCost,
    conversion: {
      status: "converted",
      currency: targetCurrency,
      amount: args.totalCost * rate.rate,
      source: rate.source,
      timestamp: rate.timestamp,
    },
  }
}

export function deveAgentNativeCurrency(providerLabel?: string, modelLabel?: string) {
  return detectDeveAgentNativeCurrency({ providerLabel, modelLabel })
}

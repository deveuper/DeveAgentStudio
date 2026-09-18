import { describe, expect, test } from "bun:test"

import {
  createDeveAgentCostViewModel,
  detectDeveAgentNativeCurrency,
  deveAgentNativeCurrency,
  estimateDeveAgentMessageCost,
  deveAgentTokenTotal,
  normalizeDeveAgentCurrency,
  summarizeDeveAgentCompatibleCost,
  summarizeDeveAgentCostEntries,
  summarizeDeveAgentMessageCost,
  summarizeDeveAgentChildSessionUsage,
  summarizeDeveAgentTeamUsage,
  summarizeDeveAgentSessionUsage,
  summarizeDeveAgentTaskTiming,
  preferDeveAgentSessionSnapshot,
  preferDeveAgentSessionSnapshots,
  deveAgentTaskRootSessionID,
  resolveDeveAgentTaskRootSessionID,
  type DeveAgentUsageMessage,
} from "./deveagent-session-metrics-model"

const message = (
  role: string,
  tokens: { input: number; output: number; reasoning: number; read: number; write: number },
): DeveAgentUsageMessage => ({
  role,
  tokens: {
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cache: {
      read: tokens.read,
      write: tokens.write,
    },
  },
})

describe("DeveAgent session metrics model", () => {
  test("totals a provider usage payload", () => {
    expect(deveAgentTokenTotal(message("assistant", { input: 10, output: 5, reasoning: 3, read: 20, write: 2 }))).toBe(40)
  })

  test("summarizes only assistant messages with real usage while preserving rounds", () => {
    const summary = summarizeDeveAgentSessionUsage([
      message("user", { input: 99, output: 99, reasoning: 99, read: 99, write: 99 }),
      message("assistant", { input: 0, output: 0, reasoning: 0, read: 0, write: 0 }),
      message("assistant", { input: 100, output: 25, reasoning: 10, read: 300, write: 15 }),
      message("assistant", { input: 50, output: 5, reasoning: 0, read: 0, write: 0 }),
    ])

    expect(summary.rounds).toBe(3)
    expect(summary.hasUsage).toBe(true)
    expect(summary.input).toBe(150)
    expect(summary.output).toBe(30)
    expect(summary.reasoning).toBe(10)
    expect(summary.cacheRead).toBe(300)
    expect(summary.cacheWrite).toBe(15)
    expect(summary.total).toBe(505)
  })

  test("returns empty usage without inventing totals", () => {
    const summary = summarizeDeveAgentSessionUsage([
      message("assistant", { input: 0, output: 0, reasoning: 0, read: 0, write: 0 }),
    ])

    expect(summary.rounds).toBe(1)
    expect(summary.hasUsage).toBe(false)
    expect(summary.total).toBe(0)
  })

  test("uses the persisted OpenCode session total while message pagination is still empty", () => {
    const summary = summarizeDeveAgentSessionUsage([], {
      id: "root",
      tokens: { input: 200_000, output: 4_000, reasoning: 0, cache: { read: 117_000, write: 0 } },
      cost: 1.25,
    })

    expect(summary.hasUsage).toBe(true)
    expect(summary.total).toBe(321_000)
    expect(summary.input).toBe(200_000)
    expect(summary.cacheRead).toBe(117_000)
    expect(summary.cost).toBe(1.25)
  })

  test("does not let a partial message page mask a larger persisted session total", () => {
    const summary = summarizeDeveAgentSessionUsage(
      [message("assistant", { input: 5_000, output: 0, reasoning: 0, read: 0, write: 0 })],
      {
        id: "root",
        tokens: { input: 200_000, output: 4_000, reasoning: 0, cache: { read: 117_000, write: 0 } },
        cost: 1.25,
      },
    )

    expect(summary.total).toBe(321_000)
    expect(summary.input).toBe(200_000)
    expect(summary.rounds).toBe(1)
    expect(summary.cost).toBe(1.25)
  })

  test("prefers the later complete root snapshot when lineage was fetched before task usage finished", () => {
    const snapshot = preferDeveAgentSessionSnapshot(
      [
        { id: "root", tokens: { input: 5_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
        { id: "root", tokens: { input: 200_000, output: 4_000, reasoning: 0, cache: { read: 117_000, write: 0 } } },
      ],
      "root",
    )

    expect(snapshot?.tokens?.input).toBe(200_000)
    expect(summarizeDeveAgentSessionUsage([], snapshot).total).toBe(321_000)
  })

  test("keeps the direct task snapshot when the child list still has an older summary", () => {
    const sessions = preferDeveAgentSessionSnapshots([
      { id: "child", parentID: "root", tokens: { input: 5_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { updated: 1 } },
      { id: "child", tokens: { input: 200_000, output: 4_000, reasoning: 0, cache: { read: 117_000, write: 0 } }, time: { updated: 2 } },
    ])

    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.parentID).toBe("root")
    expect(summarizeDeveAgentSessionUsage([], sessions[0]).total).toBe(321_000)
  })

  test("reports the observed root-to-child task span without claiming completion", () => {
    expect(
      summarizeDeveAgentTaskTiming(
        [
          { id: "root", time: { created: 1_000, updated: 2_000 } },
          { id: "child", parentID: "root", time: { created: 1_400, updated: 9_000 } },
          { id: "other", time: { created: 1, updated: 99_999 } },
        ],
        "root",
      ),
    ).toEqual({ startedAt: 1_000, updatedAt: 9_000, elapsedMs: 8_000 })
  })

  test("reports completion only when the root and every child are idle", () => {
    const sessions = [
      { id: "root", time: { created: 1_000, updated: 2_000 } },
      { id: "child", parentID: "root", time: { created: 1_400, updated: 9_000 } },
    ]
    expect(summarizeDeveAgentTaskTiming(sessions, "root", { root: { type: "idle" }, child: { type: "idle" } })).toMatchObject({
      completedAt: 9_000,
      completedElapsedMs: 8_000,
    })
    expect(summarizeDeveAgentTaskTiming(sessions, "root", { root: { type: "idle" }, child: { type: "busy" } }).completedElapsedMs).toBeUndefined()
    expect(
      summarizeDeveAgentTaskTiming(
        [{ id: "root", time: { created: 4_000, updated: 6_000 } }],
        "root",
        { root: { type: "idle" } },
      ),
    ).toMatchObject({ completedAt: 6_000, completedElapsedMs: 2_000 })
  })

  test("keeps child-session totals separate without fabricating a token split", () => {
    const usage = summarizeDeveAgentTeamUsage([
      {
        tokens: 100,
        cost: 0.02,
        members: [
          { tokens: 60, input: 20, output: 10, reasoning: 5, cacheRead: 20, cacheWrite: 5 },
          { tokens: 40 },
        ],
      },
    ])

    expect(usage.tasks).toBe(2)
    expect(usage.rounds).toBe(0)
    expect(usage.tokens).toBe(100)
    expect(usage.input).toBe(20)
    expect(usage.cacheRead).toBe(20)
    expect(usage.unclassified).toBe(40)
    expect(usage.cost).toBe(0.02)
  })

  test("uses real native child messages, including nested task children", () => {
    const usage = summarizeDeveAgentChildSessionUsage(
      [
        { id: "root" },
        { id: "child-a", parentID: "root" },
        { id: "child-b", parentID: "child-a" },
        { id: "other", parentID: "unrelated", tokens: { input: 999, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 9 },
      ],
      "root",
      {
        "child-a": [
          message("assistant", { input: 100, output: 20, reasoning: 5, read: 30, write: 0 }),
          message("assistant", { input: 7, output: 3, reasoning: 0, read: 0, write: 0 }),
        ],
        "child-b": [message("assistant", { input: 10, output: 2, reasoning: 0, read: 0, write: 0 })],
        other: [message("assistant", { input: 999, output: 0, reasoning: 0, read: 0, write: 0 })],
      },
    )

    expect(usage.tasks).toBe(2)
    expect(usage.rounds).toBe(3)
    expect(usage.tokens).toBe(177)
    expect(usage.input).toBe(117)
    expect(usage.cacheRead).toBe(30)
    expect(usage.cost).toBe(0)
  })

  test("does not let a partial child message page hide its persisted task total", () => {
    const usage = summarizeDeveAgentChildSessionUsage(
      [
        { id: "root" },
        {
          id: "child",
          parentID: "root",
          tokens: { input: 200_000, output: 4_000, reasoning: 0, cache: { read: 117_000, write: 0 } },
          cost: 1.25,
        },
      ],
      "root",
      {
        child: [message("assistant", { input: 5_000, output: 0, reasoning: 0, read: 0, write: 0 })],
      },
    )

    expect(usage.tasks).toBe(1)
    expect(usage.tokens).toBe(321_000)
    expect(usage.input).toBe(200_000)
    expect(usage.cacheRead).toBe(117_000)
    expect(usage.cost).toBe(1.25)
  })

  test("resolves a selected child back to its top-level task", () => {
    const sessions = [{ id: "root" }, { id: "child", parentID: "root" }, { id: "leaf", parentID: "child" }]
    expect(deveAgentTaskRootSessionID(sessions, "leaf")).toBe("root")
    expect(deveAgentTaskRootSessionID(sessions, "root")).toBe("root")
    expect(deveAgentTaskRootSessionID([{ id: "a", parentID: "b" }, { id: "b", parentID: "a" }], "a")).toBe("a")
  })

  test("keeps a selected child attached to its task root before sibling usage arrives", () => {
    const sessions = [{ id: "root" }, { id: "child", parentID: "root" }]
    expect(deveAgentTaskRootSessionID(sessions, "child")).toBe("root")
    expect(deveAgentTaskRootSessionID(sessions, "child")).not.toBe("child")
  })

  test("prefers the directly loaded task lineage over a stale child cache entry", () => {
    expect(
      resolveDeveAgentTaskRootSessionID(
        [{ id: "child", parentID: "root" }, { id: "root" }],
        [{ id: "child" }],
        "child",
      ),
    ).toBe("root")
  })

  test("falls back to legacy session usage only before child messages are available", () => {
    const usage = summarizeDeveAgentChildSessionUsage(
      [{ id: "root" }, { id: "child", parentID: "root", tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.002 }],
      "root",
    )
    expect(usage.tokens).toBe(12)
    expect(usage.cost).toBe(0.002)
  })

  test("keeps different child currencies out of a single model estimate", () => {
    const cost = summarizeDeveAgentCompatibleCost(
      [{ amount: 0.1, currency: "USD" }, { amount: 2, currency: "CNY" }, { amount: 0.2, currency: "USD" }],
      "USD",
    )
    expect(cost.amount).toBeCloseTo(0.3)
    expect(cost.excluded).toBe(1)
  })

  test("keeps mixed child currencies separate or converts each with an evidenced rate", () => {
    const entries = [{ amount: 0.1, currency: "USD" as const }, { amount: 2, currency: "CNY" as const }]
    expect(summarizeDeveAgentCostEntries(entries).groups).toEqual([{ currency: "CNY", amount: 2 }, { currency: "USD", amount: 0.1 }])

    const converted = summarizeDeveAgentCostEntries(entries, "CNY", [
      { from: "USD", to: "CNY", rate: 7.2, source: "test", timestamp: "2026-07-26T00:00:00Z" },
    ])
    expect(converted.convertedAmount).toBeCloseTo(2.72)
    expect(converted.missingConversions).toBe(0)
  })

  test("keeps models.dev catalog costs in USD instead of guessing from names", () => {
    expect(deveAgentNativeCurrency("DeepSeek", "deepseek-v4-pro")).toBe("USD")
    expect(deveAgentNativeCurrency("MiMo China", "mimo-v2.5-pro")).toBe("USD")
    expect(deveAgentNativeCurrency("OpenRouter", "deepseek-v4-pro")).toBe("USD")
    expect(deveAgentNativeCurrency("OpenCode Zen", "qwen3-coder")).toBe("USD")
    expect(deveAgentNativeCurrency("OpenAI", "gpt-5")).toBe("USD")
  })

  test("lets explicit model currency metadata override name heuristics", () => {
    expect(detectDeveAgentNativeCurrency({ providerLabel: "OpenRouter", modelLabel: "deepseek-v4", explicitCurrency: "USD" })).toBe(
      "USD",
    )
    expect(detectDeveAgentNativeCurrency({ providerLabel: "OpenAI", modelLabel: "gpt-5", explicitCurrency: "CNY" })).toBe("CNY")
    expect(normalizeDeveAgentCurrency("rmb")).toBe("CNY")
    expect(normalizeDeveAgentCurrency("HKD")).toBe("HKD")
  })

  test("creates an honest cost view without inventing exchange rates", () => {
    const cost = createDeveAgentCostViewModel({
      totalCost: 1.25,
      currency: { providerLabel: "OpenAI", modelLabel: "gpt-5" },
    })

    expect(cost.nativeCurrency).toBe("USD")
    expect(cost.nativeAmount).toBe(1.25)
    expect(cost.hasCost).toBe(true)
    expect(cost.conversion).toEqual({ status: "unavailable", currency: "CNY" })
  })

  test("uses a supplied exchange rate when one exists", () => {
    const cost = createDeveAgentCostViewModel({
      totalCost: 2,
      currency: { providerLabel: "OpenAI", modelLabel: "gpt-5" },
      fxRates: [{ from: "USD", to: "CNY", rate: 7.2, source: "test", timestamp: "2026-06-23T00:00:00Z" }],
    })

    expect(cost.conversion).toEqual({
      status: "converted",
      currency: "CNY",
      amount: 14.4,
      source: "test",
      timestamp: "2026-06-23T00:00:00Z",
    })
  })

  test("marks zero cost as unavailable usage instead of a free paid model", () => {
    const cost = createDeveAgentCostViewModel({
      totalCost: 0,
      currency: { providerLabel: "MiMo", modelLabel: "mimo-v2.5-free" },
    })

    expect(cost.nativeCurrency).toBe("USD")
    expect(cost.hasCost).toBe(false)
    expect(cost.conversion).toEqual({ status: "unavailable", currency: "CNY" })
  })

  test("estimates missing provider cost with the matching model price and cache split", () => {
    const usage = message("assistant", { input: 1_000_000, output: 100_000, reasoning: 10_000, read: 500_000, write: 20_000 })
    const model = { cost: { input: 2, output: 8, cache: { read: 0.5, write: 3 } } }

    expect(estimateDeveAgentMessageCost(usage, model)).toBeCloseTo(3.19)
    expect(summarizeDeveAgentMessageCost([usage], () => model)).toMatchObject({ priced: 1, estimated: 1, unpriced: 0 })
    expect(summarizeDeveAgentMessageCost([usage], () => model).amount).toBeCloseTo(3.19)
  })

  test("preserves a persisted cost and leaves unknown model usage unpriced", () => {
    const persisted = { ...message("assistant", { input: 10, output: 2, reasoning: 0, read: 0, write: 0 }), cost: 0.25 }
    const unknown = message("assistant", { input: 20, output: 1, reasoning: 0, read: 0, write: 0 })

    expect(summarizeDeveAgentMessageCost([persisted, unknown], () => undefined)).toEqual({ amount: 0.25, priced: 1, estimated: 0, unpriced: 1 })
  })
})

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionRetry } from "./retry"
import { Session } from "./session"
import { SessionID } from "./schema"
import { isPaidFallbackCandidate, planFallbackCandidates, providerFallbackEventPayload } from "./prompt"

// E-3 red line (AGENTS.md): a provider fallback must never silently switch to a
// paid model. These tests cover the real, exported decision boundary. The
// Effect-backed retry/failover loop still needs a live SessionPrompt fixture,
// so the "publish, not only log" wiring is asserted against the source below.

const FREE = { input: 0, output: 0, cache: { read: 0, write: 0 } }
const PAID = { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }

describe("isPaidFallbackCandidate", () => {
  test("an all-zero cost is free", () => {
    expect(isPaidFallbackCandidate(FREE)).toBe(false)
  })

  test("any positive billable dimension is paid", () => {
    expect(isPaidFallbackCandidate(PAID)).toBe(true)
    expect(isPaidFallbackCandidate({ input: 0, output: 0, cache: { read: 0, write: 0.001 } })).toBe(true)
  })

  test("indeterminate cost is treated as paid (conservative)", () => {
    expect(isPaidFallbackCandidate(undefined)).toBe(true)
    expect(isPaidFallbackCandidate(null)).toBe(true)
    // Missing cache block: cannot prove free, so refuse to guess.
    expect(isPaidFallbackCandidate({ input: 0, output: 0 })).toBe(true)
    expect(isPaidFallbackCandidate({ input: Number.NaN, output: 0, cache: { read: 0, write: 0 } })).toBe(true)
  })
})

describe("planFallbackCandidates", () => {
  test("drops paid candidates by default", () => {
    expect(
      planFallbackCandidates({
        resolved: [{ providerID: "paid", modelID: "gpt", cost: PAID, imageCapable: true }],
        hasImage: false,
        allowPaid: false,
      }),
    ).toEqual([])
  })

  test("keeps free candidates by default", () => {
    expect(
      planFallbackCandidates({
        resolved: [{ providerID: "free", modelID: "llama", cost: FREE, imageCapable: true }],
        hasImage: false,
        allowPaid: false,
      }),
    ).toEqual([{ providerID: "free", modelID: "llama", paid: false }])
  })

  test("a mixed chain keeps only the free candidates", () => {
    expect(
      planFallbackCandidates({
        resolved: [
          { providerID: "paid", modelID: "gpt", cost: PAID, imageCapable: true },
          { providerID: "free", modelID: "llama", cost: FREE, imageCapable: true },
        ],
        hasImage: false,
        allowPaid: false,
      }),
    ).toEqual([{ providerID: "free", modelID: "llama", paid: false }])
  })

  test("an unknown-cost candidate is not used by default", () => {
    expect(
      planFallbackCandidates({
        resolved: [{ providerID: "mystery", modelID: "x", imageCapable: true }],
        hasImage: false,
        allowPaid: false,
      }),
    ).toEqual([])
  })

  test("paid candidates are used only when explicitly allowed", () => {
    expect(
      planFallbackCandidates({
        resolved: [{ providerID: "paid", modelID: "gpt", cost: PAID, imageCapable: true }],
        hasImage: false,
        allowPaid: true,
      }),
    ).toEqual([{ providerID: "paid", modelID: "gpt", paid: true }])
  })

  test("image requests keep only image-capable candidates", () => {
    expect(
      planFallbackCandidates({
        resolved: [
          { providerID: "free", modelID: "text-only", cost: FREE, imageCapable: false },
          { providerID: "free", modelID: "vision", cost: FREE, imageCapable: true },
        ],
        hasImage: true,
        allowPaid: false,
      }),
    ).toEqual([{ providerID: "free", modelID: "vision", paid: false }])
  })
})

describe("a quota failure never auto-switches to a paid model", () => {
  // Same shape as test/session/retry.test.ts: a Go subscription quota error is
  // retryable, so the failover branch runs. The candidate plan is what decides
  // which model it may actually switch to.
  const quotaError = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
    new SessionV1.APIError({
      message: "Subscription quota exceeded. You can continue using free models.",
      isRetryable: true,
      statusCode: 429,
      responseBody: JSON.stringify({
        type: "error",
        error: { type: "GoUsageLimitError", message: "Subscription quota exceeded." },
        metadata: { workspace: "wrk_test", limitName: "5 hour" },
      }),
    }).toObject(),
  )

  test("the quota failure is retryable, so failover is even considered", () => {
    expect(SessionRetry.retryable(quotaError, "opencode-go")).toBeDefined()
  })

  test("a paid-only chain yields no fallback", () => {
    const plan = planFallbackCandidates({
      resolved: [{ providerID: "anthropic", modelID: "claude", cost: PAID, imageCapable: true }],
      hasImage: false,
      allowPaid: false,
    })
    expect(plan).toEqual([])
  })

  test("a free-only chain is switched to", () => {
    const plan = planFallbackCandidates({
      resolved: [{ providerID: "opencode", modelID: "grok-code", cost: FREE, imageCapable: true }],
      hasImage: false,
      allowPaid: false,
    })
    expect(plan).toEqual([{ providerID: "opencode", modelID: "grok-code", paid: false }])
  })
})

describe("providerFallbackEventPayload", () => {
  test("carries the failed model, the fallback model, and the paid flag", () => {
    const payload = providerFallbackEventPayload({
      sessionID: SessionID.make("ses_test"),
      failedProviderID: "opencode",
      failedModelID: "grok-code",
      fallbackProviderID: "anthropic",
      fallbackModelID: "claude",
      fallbackPaid: true,
      message: "quota exceeded",
    })
    expect(payload).toEqual({
      sessionID: SessionID.make("ses_test"),
      failedProviderID: "opencode",
      failedModelID: "grok-code",
      fallbackProviderID: "anthropic",
      fallbackModelID: "claude",
      fallbackPaid: true,
      message: "quota exceeded",
    })
  })

  test("omits the message when there is none", () => {
    const payload = providerFallbackEventPayload({
      sessionID: SessionID.make("ses_test"),
      failedProviderID: "a",
      failedModelID: "b",
      fallbackProviderID: "c",
      fallbackModelID: "d",
      fallbackPaid: false,
    })
    expect("message" in payload).toBe(false)
  })
})

describe("provider fallback wiring", () => {
  test("session defines the visible fallback event", () => {
    expect(Session.Event.ProviderFallback.type).toBe("session.provider-fallback")
  })

  test("the failover branch publishes the event, not only logs it", () => {
    const source = readFileSync(import.meta.dir + "/prompt.ts", "utf8")
    expect(/events\.publish\(\s*Session\.Event\.ProviderFallback\s*,/.test(source)).toBe(true)
    expect(source.includes("providerFallbackEventPayload({")).toBe(true)
    // The warning log used to be the only signal; the red line requires a
    // user-visible event in addition to it.
    expect(source.includes('Effect.logWarning("provider fallback before observable output"')).toBe(true)
  })
})

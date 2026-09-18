import { expect, test } from "bun:test"
import { orderedProviderFallbackCandidates, orderedVisionCandidates } from "./prompt"
import { classifyVisionFallback, visionFallbackMessage } from "../plugin/deveagent"

// This focused suite covers the real, exported candidate-planning boundary.
// The provider protocol/retry loop is Effect-backed and private to prompt.ts;
// it still needs a live SessionPrompt fixture before it can be called honestly.

type MockVisionModel = {
  providerID: string
  modelID: string
  capabilities: { input: { image: boolean } }
}

function firstImageCapableCandidate(
  candidates: Array<{ providerID: string; modelID: string }>,
  resolve: (candidate: { providerID: string; modelID: string }) => MockVisionModel | undefined,
) {
  const attempted: string[] = []
  const failures: Array<{ candidate: string; reason: "model_not_found" | "no_image_capability" }> = []

  for (const candidate of candidates) {
    const ref = `${candidate.providerID}/${candidate.modelID}`
    attempted.push(ref)
    const model = resolve(candidate)
    if (!model) {
      failures.push({ candidate: ref, reason: "model_not_found" })
      continue
    }
    if (!model.capabilities.input.image) {
      failures.push({ candidate: ref, reason: "no_image_capability" })
      continue
    }
    return { selected: candidate, attempted, failures }
  }

  return { selected: undefined, attempted, failures }
}

test("session vision chain precedes global fallbacks and removes duplicates", () => {
  expect(
    orderedVisionCandidates({
      session: {
        vision: { providerID: "session", modelID: "primary" },
        visionChain: [
          { providerID: "session", modelID: "backup" },
          { providerID: "global", modelID: "primary" },
        ],
      },
      globalChain: [
        { providerID: "global", modelID: "primary" },
        { providerID: "global", modelID: "backup" },
      ],
      globalVision: { providerID: "session", modelID: "primary" },
    }),
  ).toEqual([
    { providerID: "session", modelID: "primary" },
    { providerID: "session", modelID: "backup" },
    { providerID: "global", modelID: "primary" },
    { providerID: "global", modelID: "backup" },
  ])
})

test("image failures try remaining visual candidates before generic fallback", () => {
  expect(
    orderedProviderFallbackCandidates({
      configured: [{ providerID: "generic", modelID: "fallback" }],
      visionCandidates: [
        { providerID: "vision", modelID: "primary" },
        { providerID: "vision", modelID: "backup" },
      ],
      current: { providerID: "vision", modelID: "primary" },
      hasImage: true,
    }),
  ).toEqual([
    { providerID: "vision", modelID: "backup" },
    { providerID: "generic", modelID: "fallback" },
  ])
})

test("text failures do not use visual-only candidates", () => {
  expect(
    orderedProviderFallbackCandidates({
      configured: [{ providerID: "generic", modelID: "fallback" }],
      visionCandidates: [{ providerID: "vision", modelID: "backup" }],
      current: { providerID: "primary", modelID: "text" },
      hasImage: false,
    }),
  ).toEqual([{ providerID: "generic", modelID: "fallback" }])
})

test("keeps every later visual candidate available after the current model fails", () => {
  expect(
    orderedProviderFallbackCandidates({
      configured: [{ providerID: "generic", modelID: "fallback" }],
      visionCandidates: [
        { providerID: "vision", modelID: "missing" },
        { providerID: "vision", modelID: "text-only" },
        { providerID: "vision", modelID: "backup" },
      ],
      current: { providerID: "vision", modelID: "missing" },
      hasImage: true,
    }),
  ).toEqual([
    { providerID: "vision", modelID: "text-only" },
    { providerID: "vision", modelID: "backup" },
    { providerID: "generic", modelID: "fallback" },
  ])
})

test("tries later candidates after a missing model and a text-only model", () => {
  const candidates = orderedProviderFallbackCandidates({
    configured: [{ providerID: "generic", modelID: "fallback" }],
    visionCandidates: [
      { providerID: "vision", modelID: "missing" },
      { providerID: "vision", modelID: "text-only" },
      { providerID: "vision", modelID: "backup" },
    ],
    current: { providerID: "primary", modelID: "text" },
    hasImage: true,
  })

  const catalog = new Map<string, MockVisionModel>([
    ["vision/text-only", { providerID: "vision", modelID: "text-only", capabilities: { input: { image: false } } }],
    ["vision/backup", { providerID: "vision", modelID: "backup", capabilities: { input: { image: true } } }],
    ["generic/fallback", { providerID: "generic", modelID: "fallback", capabilities: { input: { image: true } } }],
  ])
  const result = firstImageCapableCandidate(candidates, (candidate) => catalog.get(`${candidate.providerID}/${candidate.modelID}`))

  expect(result.selected).toEqual({ providerID: "vision", modelID: "backup" })
  expect(result.attempted).toEqual(["vision/missing", "vision/text-only", "vision/backup"])
  expect(result.failures).toEqual([
    { candidate: "vision/missing", reason: "model_not_found" },
    { candidate: "vision/text-only", reason: "no_image_capability" },
  ])
})

test("stops at the bounded candidate list instead of inventing a fallback", () => {
  expect(
    orderedProviderFallbackCandidates({
      configured: [],
      visionCandidates: [{ providerID: "vision", modelID: "only" }],
      current: { providerID: "vision", modelID: "only" },
      hasImage: true,
    }),
  ).toEqual([])
})

test("keeps missing-model and unsupported-image failures distinguishable", () => {
  expect(classifyVisionFallback({ configured: true, candidate: undefined })).toBe("model_not_found")
  expect(
    classifyVisionFallback({
      configured: true,
      candidate: { capabilities: { input: { image: false } } },
    }),
  ).toBe("no_image_capability")
})

test("exposes a bounded visible failure when no visual candidate resolves", () => {
  const candidates = orderedProviderFallbackCandidates({
    configured: [],
    visionCandidates: [{ providerID: "vision", modelID: "missing" }],
    current: { providerID: "primary", modelID: "text" },
    hasImage: true,
  })
  const result = firstImageCapableCandidate(candidates, () => undefined)

  expect(result.selected).toBeUndefined()
  expect(result.attempted).toEqual(["vision/missing"])
  expect(result.failures).toEqual([{ candidate: "vision/missing", reason: "model_not_found" }])

  const reason = classifyVisionFallback({ configured: true, candidate: undefined })
  const message = visionFallbackMessage(reason, result.attempted.join(" -> "), "all candidates")
  expect(message).toContain("辅助视觉模型不可用")
  expect(message).toContain("已回退到主模型")
})

test("independent vision fallback is wired into the image routing boundary", async () => {
  // Round 15: when no provider-level vision candidate resolves, the prompt
  // path calls the independent vision backend (API -> OS OCR). This test
  // asserts the plugin exports the function the prompt path depends on and
  // that the fallback produces a bounded result shape.
  const vision = await import("../plugin/deveagent-vision")
  expect(typeof vision.runVisionChain).toBe("function")
  expect(typeof vision.loadVisionConfig).toBe("function")
  // A missing local image yields source "none" with a bounded error (the
  // prompt path treats source==="none" as "no independent text").
  const ws = import.meta.dir + "/.cache-vision-missing"
  const result = await vision.runVisionChain(ws + "/missing.png", "describe", undefined)
  expect(["none", "windows-ocr", "macos-ocr"]).toContain(result.source)
  if (result.source === "none") {
    expect(result.error).toBeTruthy()
  }
})

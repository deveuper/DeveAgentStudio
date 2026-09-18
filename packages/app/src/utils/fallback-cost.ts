// Display-only mirror of the server red line
// (packages/opencode/src/session/prompt.ts `isPaidFallbackCandidate`): a
// fallback model is "paid" when any billable dimension is > 0, and a cost that
// cannot be verified counts as paid. The authoritative decision of whether a
// paid candidate may actually be used stays on the server.
export type FallbackModelCost =
  | { input?: number; output?: number; cache?: { read?: number; write?: number } | undefined }
  | null
  | undefined

export function isPaidFallbackModelCost(cost: FallbackModelCost): boolean {
  if (!cost || typeof cost !== "object") return true
  const values = [cost.input, cost.output, cost.cache?.read, cost.cache?.write]
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) return true
    if (value > 0) return true
  }
  return false
}

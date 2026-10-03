export type SkillUpdateInfo = { id: string; upToDate: boolean; error?: string }

export function summarizeSkillUpdates(payload: unknown) {
  if (!Array.isArray(payload)) throw new Error("Invalid Skill update response")
  const results: SkillUpdateInfo[] = payload.map((value) => {
    if (!value || typeof value !== "object" || typeof value.id !== "string" || !value.id.trim() ||
      typeof value.upToDate !== "boolean" || (value.error !== undefined && typeof value.error !== "string")) {
      throw new Error("Invalid Skill update response")
    }
    return value
  })
  return {
    results,
    outdated: results.filter((item) => !item.upToDate && !item.error).length,
    failed: results.filter((item) => !!item.error).length,
  }
}

export function skillStoreSaveError(
  response: { ok: boolean; status: number },
  payload: unknown,
  invalidLabel = "invalid save response",
): string | undefined {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: unknown }).error
    if (typeof error === "string" && error.trim()) return error.trim()
  }
  if (!response.ok) return `HTTP ${response.status}`
  const id = payload && typeof payload === "object" ? (payload as { id?: unknown }).id : undefined
  if (typeof id !== "string" || !id.trim()) {
    return invalidLabel
  }
  return undefined
}

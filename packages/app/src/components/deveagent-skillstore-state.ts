export function skillStoreSaveError(
  response: { ok: boolean; status: number },
  payload: unknown,
): string | undefined {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: unknown }).error
    if (typeof error === "string" && error.trim()) return error.trim()
  }
  if (!response.ok) return `HTTP ${response.status}`
  const id = payload && typeof payload === "object" ? (payload as { id?: unknown }).id : undefined
  if (typeof id !== "string" || !id.trim()) {
    return "保存响应无效"
  }
  return undefined
}

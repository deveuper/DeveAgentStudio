// Session export (R160): assemble a portable Markdown/JSON snapshot of a
// session from data the session page already has in memory — no backend
// round-trip. Usage numbers pass through verbatim; missing values render as
// "未返回" / "not returned" instead of zeroes.

export type SessionExportMessage = {
  role: "user" | "assistant" | string
  text: string
}

export type SessionExportInput = {
  title: string
  sessionID: string
  messages: SessionExportMessage[]
  usage?: {
    tokens?: number
    cost?: number
  }
}

export function buildSessionExportMarkdown(input: SessionExportInput): string {
  const notReturned = "not returned"
  const tokensText =
    typeof input.usage?.tokens === "number" ? String(input.usage.tokens) : notReturned
  const costText =
    typeof input.usage?.cost === "number" ? `$${input.usage.cost.toFixed(4)}` : notReturned
  const out: string[] = []
  out.push(`# ${input.title}`)
  out.push("")
  out.push(`- Session: ${input.sessionID}`)
  out.push(`- Exported: ${new Date().toISOString()}`)
  out.push(`- Tokens: ${tokensText}`)
  out.push(`- Cost: ${costText}`)
  out.push("")
  for (const message of input.messages) {
    const label = message.role === "user" ? "## User" : message.role === "assistant" ? "## Assistant" : `## ${message.role}`
    out.push(label)
    out.push("")
    out.push(message.text)
    out.push("")
  }
  return out.join("\n")
}

export function buildSessionExportJson(input: SessionExportInput): string {
  return JSON.stringify(
    {
      title: input.title,
      sessionID: input.sessionID,
      exportedAt: new Date().toISOString(),
      usage: input.usage ?? { tokens: "not returned", cost: "not returned" },
      messages: input.messages,
    },
    null,
    2,
  )
}

export function buildSessionExport(
  format: "md" | "json",
  input: SessionExportInput,
): { body: string; contentType: string; filename: string } {
  const safe = (input.title || "session").replace(/[^\w.-]+/g, "_").slice(0, 60)
  const body =
    format === "json"
      ? buildSessionExportJson(input)
      : buildSessionExportMarkdown(input)
  return {
    body,
    contentType: format === "json" ? "application/json" : "text/markdown",
    filename: `${safe}.${format}`,
  }
}

/** Browser download trigger (no-op guard for non-DOM test environments). */
export function downloadExport(exported: { body: string; contentType: string; filename: string }) {
  if (typeof document === "undefined") return
  const blob = new Blob([exported.body], { type: exported.contentType })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = exported.filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

import type { Message, Part } from "@opencode-ai/sdk/v2/client"

export type DeveAgentMarkItDownEvent = {
  messageID: string
  partID: string
  status: "converted" | "failed"
  sourceRelativePath?: string
  markdownRelativePath?: string
  sourceBytes?: number
  sourceSha256?: string
  sourceModifiedAt?: number
  runtimeCommand?: string
  cached?: boolean
  attempts?: Array<{ command?: string; error?: string }>
  rawDocumentForwardedToModel?: false
  text: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function toEvent(messageID: string, part: Part): DeveAgentMarkItDownEvent | undefined {
  if (part.type !== "text" || !isRecord(part.metadata)) return undefined
  const raw = part.metadata.deveagentMarkItDown
  if (!isRecord(raw) || (raw.status !== "converted" && raw.status !== "failed")) return undefined

  const attempts = Array.isArray(raw.attempts)
    ? raw.attempts.flatMap((attempt) => {
        if (!isRecord(attempt)) return []
        return [
          {
            ...(typeof attempt.command === "string" ? { command: attempt.command } : {}),
            ...(typeof attempt.error === "string" ? { error: attempt.error } : {}),
          },
        ]
      })
    : undefined

  return {
    messageID,
    partID: part.id,
    status: raw.status,
    ...(typeof raw.sourceRelativePath === "string" ? { sourceRelativePath: raw.sourceRelativePath } : {}),
    ...(typeof raw.markdownRelativePath === "string" ? { markdownRelativePath: raw.markdownRelativePath } : {}),
    ...(typeof raw.sourceBytes === "number" ? { sourceBytes: raw.sourceBytes } : {}),
    ...(typeof raw.sourceSha256 === "string" ? { sourceSha256: raw.sourceSha256 } : {}),
    ...(typeof raw.sourceModifiedAt === "number" ? { sourceModifiedAt: raw.sourceModifiedAt } : {}),
    ...(typeof raw.runtimeCommand === "string" ? { runtimeCommand: raw.runtimeCommand } : {}),
    ...(typeof raw.cached === "boolean" ? { cached: raw.cached } : {}),
    ...(attempts?.length ? { attempts } : {}),
    ...(raw.rawDocumentForwardedToModel === false ? { rawDocumentForwardedToModel: false } : {}),
    text: part.text,
  }
}

export function collectDeveAgentMarkItDownEvents(messages: Message[], getParts: (messageID: string) => Part[]) {
  return messages
    .flatMap((message) => getParts(message.id).flatMap((part) => toEvent(message.id, part)))
    .filter((event): event is DeveAgentMarkItDownEvent => Boolean(event))
}

export function formatDeveAgentMarkItDownBytes(bytes: number | undefined) {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "大小未知"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function formatDeveAgentMarkItDownTime(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return "时间未知"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toISOString()
}

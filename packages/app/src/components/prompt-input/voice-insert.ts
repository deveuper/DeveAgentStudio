import type { ContentPart, Prompt, TextPart } from "@/context/prompt"
import { promptLength } from "./history"

/**
 * Length of a prompt part in the flat prompt offset space.
 *
 * Text, file and agent parts each contribute the length of their `content`
 * (the rendered pill text for `@` mentions); image parts are attachments that
 * live outside the text flow and contribute nothing. This mirrors
 * {@link promptLength} so a cursor offset maps to the same part the editor
 * renders the caret in.
 */
function partLength(part: ContentPart): number {
  return "content" in part ? part.content.length : 0
}

/**
 * Recompute every text/file/agent part's `start`/`end` as running offsets over
 * the prompt. Image parts are left untouched (they carry no offsets). This
 * keeps `@` mention offsets valid after the prompt content shifts — request
 * building forwards `file`/`agent` `start`/`end` as `source.text` positions.
 */
function withPositions(parts: Prompt): Prompt {
  let position = 0
  return parts.map((part) => {
    if (part.type === "image") return part
    const next = { ...part, start: position, end: position + part.content.length }
    position += part.content.length
    return next
  })
}

/** Index of the nearest text part from `from` walking in `dir`; -1 when none. */
function nearestTextPart(parts: Prompt, from: number, dir: -1 | 1): number {
  for (let index = from + dir; index >= 0 && index < parts.length; index += dir) {
    if (parts[index].type === "text") return index
  }
  return -1
}

/** Concatenated text of every content-bearing part, in order. */
function flatContent(parts: Prompt): string {
  return parts.map((part) => ("content" in part ? part.content : "")).join("")
}

export type VoiceInsertResult = { parts: Prompt; cursor: number }

/**
 * Splice a voice transcription into a prompt at the current cursor.
 *
 * The transcription is inserted verbatim into the text part that owns the
 * caret, so a caret mid-sentence keeps the surrounding text intact. Every
 * non-text part (file/agent `@` mentions and image attachments) is preserved in
 * place and in order. The returned cursor sits at the end of the inserted run,
 * and all part offsets are recomputed so `@` mention `start`/`end` stay valid.
 *
 * Edge cases:
 * - Empty / whitespace-only transcriptions are a no-op (the prompt is returned
 *   unchanged and the cursor is only clamped to the prompt bounds).
 * - A caret that lands on a non-text part is anchored to the nearest adjacent
 *   text part rather than dropping the transcription.
 * - When the prompt has no text part at all (empty prompt or only pills) a new
 *   text part is appended.
 */
export function insertVoiceText(parts: Prompt, cursor: number, text: string): VoiceInsertResult {
  const total = promptLength(parts)
  const position = Math.max(0, Math.min(cursor, total))

  if (!text.trim()) return { parts, cursor: position }

  // Only the append-at-end case gets a separating space, and only when it would
  // otherwise glue two non-whitespace characters together ("hello" + "world" ->
  // "hello world", but "hel|lo" + "world" -> "helworldlo"). Everything else
  // keeps the verbatim splice semantics.
  const before = position > 0 ? flatContent(parts)[position - 1] : ""
  const separator = position === total && !!before && !/\s/.test(before) && !/^\s/.test(text) ? " " : ""
  const insert = separator + text

  let remaining = position
  let target = -1
  let offset = 0

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]
    const length = partLength(part)

    if (part.type === "text") {
      if (remaining <= length) {
        target = index
        offset = remaining
        break
      }
      remaining -= length
      continue
    }

    // Caret lands on a non-text part (an `@` pill, or a zero-length image).
    // Anchor to the nearest adjacent text part instead of dropping the text.
    if (remaining < length) {
      target = nearestTextPart(parts, index, -1)
      offset = target === -1 ? 0 : partLength(parts[target])
      if (target === -1) {
        target = nearestTextPart(parts, index, 1)
        offset = 0
      }
      break
    }
    remaining -= length
  }

  if (target === -1) {
    const appended: TextPart = { type: "text", content: insert, start: 0, end: insert.length }
    const next = withPositions([...parts, appended])
    return { parts: next, cursor: promptLength(next) }
  }

  const part = parts[target]
  if (part.type !== "text") {
    // Defensive: `target` always resolves to a text part above.
    return { parts, cursor: position }
  }

  const content = part.content.slice(0, offset) + insert + part.content.slice(offset)
  const spliced = parts.slice()
  spliced[target] = { ...part, content }

  const next = withPositions(spliced)
  const updated = next[target]
  const nextCursor = updated.type === "text" ? updated.start + offset + insert.length : promptLength(next)
  return { parts: next, cursor: nextCursor }
}

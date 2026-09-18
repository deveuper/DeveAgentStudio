// Tolerant reading for the DeveAgent append-only JSONL logs
// (`.deveagent/deveagent-runs.log`, `checkpoints.log`, `guardian-trace.log`,
// `cu-audit.log`). A crash mid-append leaves a torn line, and a reader that
// `split("\n")`s and bails on the first parse error either loses every older
// record or hides the damage from the caller. These helpers walk from the
// newest line backwards — the direction every existing reader already uses —
// step over a bad line instead of stopping, and report what was stepped over
// so the caller can surface it. Pure functions: no I/O, no dependencies.

export type JsonlReadResult<T> = {
  records: T[]
  damaged: boolean
  droppedBytes: number
}

/** Parse a line, treating both a JSON error and a rejected shape as "damage". */
function parseTolerant<T>(line: string, parse: (value: unknown) => T | undefined): T | undefined {
  try {
    // The caller's `parse` runs inside the try on purpose: a validator that
    // throws on an unexpected shape must not take the whole reader down.
    return parse(JSON.parse(line))
  } catch {
    return undefined
  }
}

/**
 * Read as many newest records as the caller asks for, skipping damaged lines.
 *
 * Records come back newest-first, matching the order the existing readers
 * return. Damage is only reported for the part of the file that was actually
 * scanned: the walk stops with `max`, so a bad line older than the cut-off is
 * never seen and never counted.
 */
export function readJsonlTolerant<T>(input: {
  text: string
  parse: (value: unknown) => T | undefined
  max?: number
}): JsonlReadResult<T> {
  const max = input.max === undefined || !Number.isFinite(input.max) ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(input.max))
  const records: T[] = []
  let damaged = false
  let droppedBytes = 0
  // Scan backwards by line boundary instead of splitting the whole file: the
  // logs are read newest-first, and slicing one line at a time keeps a single
  // pass over the text no matter how large it is.
  let end = input.text.length
  while (records.length < max && end > 0) {
    const newline = input.text.lastIndexOf("\n", end - 1)
    const line = input.text.slice(newline + 1, end)
    end = newline // -1 on the first line, which ends the walk
    const trimmed = line.trim()
    if (!trimmed) continue // blank separator, not damage
    const record = parseTolerant(trimmed, input.parse)
    if (record === undefined) {
      damaged = true
      // Byte length, not character count: callers report this as unreadable
      // file bytes, and these logs hold multi-byte CJK text.
      droppedBytes += Buffer.byteLength(line, "utf8")
      continue
    }
    records.push(record)
  }
  return { records, damaged, droppedBytes }
}

/**
 * Split off a final line that never finished being written.
 *
 * A writer calls this before appending: appending after a torn fragment would
 * glue the next record onto it and produce a line no reader can parse.
 */
export function truncateTornTail(input: { text: string }): { text: string; torn: string | undefined } {
  const { text } = input
  // Ending in a newline means the file stopped on a line boundary; a crash
  // cannot have left a partial line behind one.
  if (!text || text.endsWith("\n")) return { text, torn: undefined }
  const newline = text.lastIndexOf("\n")
  const tail = text.slice(newline + 1)
  try {
    JSON.parse(tail)
    return { text, torn: undefined }
  } catch {}
  // Drop the newline that preceded the fragment too, so `text + torn`
  // reconstructs the input byte for byte.
  return { text: newline === -1 ? "" : text.slice(0, newline + 1), torn: tail }
}

// R158: hunk-level diff tooling. Pure string-in/string-out helpers — no I/O —
// so the review UI can apply or revert ONE hunk of a unified diff while the
// file's other hunks stay untouched. Unified-diff shape only (what
// @@ -a,b +c,d @@ headers plus context/-/+ lines), matching what the review
// tab and SnapshotFileDiff already produce.

export type DiffHunk = {
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  body: string
  /** full raw text including the @@ header line */
  raw: string
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** Split a unified patch into its hunks (raw text per hunk, header included). */
export function splitPatchByHunks(patch: string): DiffHunk[] {
  const lines = patch.split("\n")
  const hunks: DiffHunk[] = []
  let current: DiffHunk | undefined
  let currentRaw: string[] = []

  const flush = () => {
    if (current) {
      current.body = currentRaw.join("\n")
      current.raw = [current.header, current.body].filter(Boolean).join("\n")
      hunks.push(current)
    }
    current = undefined
    currentRaw = []
  }

  for (const line of lines) {
    const match = HUNK_HEADER.exec(line)
    if (match) {
      flush()
      current = {
        header: line,
        oldStart: Number(match[1]),
        oldLines: match[2] ? Number(match[2]) : 1,
        newStart: Number(match[3]),
        newLines: match[4] ? Number(match[4]) : 1,
        body: "",
        raw: "",
      } as DiffHunk
      continue
    }
    if (current) currentRaw.push(line)
  }
  flush()
  return hunks
}

/** Apply ONE hunk (raw text with @@ header) to file content. */
export function applyHunkToContent(content: string, hunkRaw: string): { ok: boolean; result?: string; error?: string } {
  const lines = hunkRaw.split("\n")
  const header = lines.find((line) => HUNK_HEADER.test(line))
  if (!header) return { ok: false, error: "no @@ header in hunk" }
  const match = HUNK_HEADER.exec(header)
  if (!match) return { ok: false, error: "no @@ header in hunk" }
  const oldStart = Number(match[1])

  const body: string[] = []
  for (let i = lines.indexOf(header) + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.startsWith("\\")) continue // "\ No newline at end of file"
    body.push(line)
  }

  const fileLines = content.split("\n")
  // oldStart is 1-based; context lines above the first change start there.
  let cursor = oldStart - 1
  const out = [...fileLines]
  let applied = 0
  for (const line of body) {
    if (line.startsWith("+")) {
      out.splice(cursor, 0, line.slice(1))
      cursor += 1
      applied += 1
      continue
    }
    if (line.startsWith("-")) {
      if (cursor >= out.length) return { ok: false, error: "hunk removed past end of file" }
      out.splice(cursor, 1)
      applied += 1
      continue
    }
    // context
    if (line.startsWith(" ") || line === "") {
      cursor += 1
      continue
    }
  }
  if (applied === 0) return { ok: false, error: "hunk changed nothing" }
  return { ok: true, result: out.join("\n") }
}

/** Extract just hunk `index` (0-based) of a patch as a standalone patch text. */
export function hunkPatch(patch: string, index: number): string | undefined {
  return splitPatchByHunks(patch)[index]?.raw
}

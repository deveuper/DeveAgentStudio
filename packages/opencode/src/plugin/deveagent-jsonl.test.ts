import { describe, expect, test } from "bun:test"
import { readJsonlTolerant, truncateTornTail } from "./deveagent-jsonl"

type Entry = { n: number }

// Mirrors the normalizers the real readers use: a parsed value that is not a
// usable record must count as damage, not as a record.
function parseEntry(value: unknown): Entry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const n = (value as Record<string, unknown>).n
  return typeof n === "number" ? { n } : undefined
}

const line = (n: number) => JSON.stringify({ n })
const numbers = (result: { records: Entry[] }) => result.records.map((entry) => entry.n)

describe("readJsonlTolerant", () => {
  test("empty and whitespace-only input read as clean and empty", () => {
    for (const text of ["", "\n", "   ", "\n\n  \n"]) {
      expect(readJsonlTolerant({ text, parse: parseEntry })).toEqual({ records: [], damaged: false, droppedBytes: 0 })
    }
  })

  test("a single valid line without a trailing newline is read", () => {
    expect(readJsonlTolerant({ text: line(1), parse: parseEntry })).toEqual({
      records: [{ n: 1 }],
      damaged: false,
      droppedBytes: 0,
    })
  })

  test("records come back newest-first and damaged stays false when nothing was skipped", () => {
    const text = [line(1), line(2), line(3)].map((entry) => `${entry}\n`).join("")
    const result = readJsonlTolerant({ text, parse: parseEntry })
    expect(numbers(result)).toEqual([3, 2, 1])
    expect(result.damaged).toBe(false)
    expect(result.droppedBytes).toBe(0)
  })

  test("a torn final line is skipped, reported, and does not hide older records", () => {
    const torn = '{"n": 4, "note": "cut off mid-'
    const result = readJsonlTolerant({ text: `${line(1)}\n${line(2)}\n${torn}`, parse: parseEntry })
    expect(numbers(result)).toEqual([2, 1])
    expect(result.damaged).toBe(true)
    expect(result.droppedBytes).toBe(torn.length)
  })

  test("a torn line in the middle does not hide later records", () => {
    const torn = '{"n": 2'
    const text = `${line(1)}\n${torn}\n${line(3)}\n${line(4)}\n`
    const result = readJsonlTolerant({ text, parse: parseEntry })
    expect(numbers(result)).toEqual([4, 3, 1])
    expect(result.damaged).toBe(true)
    expect(result.droppedBytes).toBe(torn.length)
  })

  test("damage is true only when something was actually skipped", () => {
    // Lines that parse to a shape the caller rejects are damage...
    expect(readJsonlTolerant({ text: `{"other": true}\n`, parse: parseEntry }).damaged).toBe(true)
    expect(readJsonlTolerant({ text: `nope\n`, parse: parseEntry }).damaged).toBe(true)
    // ...while a caller that accepts the same shapes reports a clean read.
    const permissive = readJsonlTolerant({ text: `{"other": true}\n[1,2]\n`, parse: (value) => value })
    expect(permissive.records).toEqual([[1, 2], { other: true }])
    expect(permissive.damaged).toBe(false)
  })

  test("a parse function that throws is damage, not a crash", () => {
    const result = readJsonlTolerant({
      text: `${line(1)}\n${line(2)}\n`,
      parse: (value) => {
        if ((value as Entry).n === 2) throw new Error("validator exploded")
        return parseEntry(value)
      },
    })
    expect(numbers(result)).toEqual([1])
    expect(result.damaged).toBe(true)
  })

  test("non-object JSON values are handed to the caller and rejected as damage by default", () => {
    const text = ["1", '"two"', "null", "true", "[]"].map((value) => `${value}\n`).join("")
    const strict = readJsonlTolerant({ text, parse: parseEntry })
    expect(strict.records).toEqual([])
    expect(strict.damaged).toBe(true)
    // The newline separators are not part of any line's bytes.
    expect(strict.droppedBytes).toBe(Buffer.byteLength(text, "utf8") - 5)

    const permissive = readJsonlTolerant({ text, parse: (value) => value })
    expect(permissive.records).toEqual([[], true, null, "two", 1])
    expect(permissive.damaged).toBe(false)
  })

  test("max is honored from the newest end", () => {
    const text = [1, 2, 3, 4, 5].map((n) => `${line(n)}\n`).join("")
    expect(numbers(readJsonlTolerant({ text, parse: parseEntry, max: 2 }))).toEqual([5, 4])
    expect(numbers(readJsonlTolerant({ text, parse: parseEntry, max: 1 }))).toEqual([5])
    expect(readJsonlTolerant({ text, parse: parseEntry, max: 0 }).records).toEqual([])
    expect(numbers(readJsonlTolerant({ text, parse: parseEntry, max: 99 }))).toEqual([5, 4, 3, 2, 1])
    // The walk stops at the cut-off, so damage older than the requested window
    // is outside what this read scanned and is not reported.
    const withOldDamage = `${line(1)}\ntorn-old\n${line(3)}\n`
    const windowed = readJsonlTolerant({ text: withOldDamage, parse: parseEntry, max: 1 })
    expect(numbers(windowed)).toEqual([3])
    expect(windowed.damaged).toBe(false)
  })

  test("max counts records, so damage inside the window does not shorten the result", () => {
    const text = `${line(1)}\nbad\n${line(3)}\nbad\n${line(5)}\n`
    const result = readJsonlTolerant({ text, parse: parseEntry, max: 2 })
    expect(numbers(result)).toEqual([5, 3])
    expect(result.droppedBytes).toBe(Buffer.byteLength("bad", "utf8"))
  })

  test("droppedBytes counts UTF-8 bytes, not characters", () => {
    const torn = `{"note": "中文损坏的记录", "n":`
    const result = readJsonlTolerant({ text: `${line(1)}\n${torn}`, parse: parseEntry })
    expect(numbers(result)).toEqual([1])
    expect(result.droppedBytes).toBe(Buffer.byteLength(torn, "utf8"))
    expect(result.droppedBytes).toBeGreaterThan(torn.length)
  })

  test("oversized input is read in a single pass and stays fast", () => {
    const total = 40_000
    const lines: string[] = []
    for (let i = 0; i < total; i++) lines.push(line(i))
    lines[total - 500] = "torn-in-the-middle"
    const text = `${lines.join("\n")}\n`
    const started = performance.now()
    const result = readJsonlTolerant({ text, parse: parseEntry, max: 10 })
    const elapsed = performance.now() - started
    expect(numbers(result)).toEqual([total - 1, total - 2, total - 3, total - 4, total - 5, total - 6, total - 7, total - 8, total - 9, total - 10])
    expect(result.damaged).toBe(false)
    // Generous bound: a quadratic walk over this file takes seconds, a single
    // backward pass a few milliseconds.
    expect(elapsed).toBeLessThan(1500)
  })

  test("the whole file can be read without a max", () => {
    const lines = Array.from({ length: 500 }, (_, i) => line(i))
    const result = readJsonlTolerant({ text: `${lines.join("\n")}\n`, parse: parseEntry })
    expect(result.records).toHaveLength(500)
    expect(numbers(result)).toEqual(lines.map((_, i) => 499 - i))
  })
})

describe("truncateTornTail", () => {
  test("a newline-terminated file has nothing torn", () => {
    const text = `${line(1)}\n${line(2)}\n`
    expect(truncateTornTail({ text })).toEqual({ text, torn: undefined })
    expect(truncateTornTail({ text: "\n" })).toEqual({ text: "\n", torn: undefined })
  })

  test("a complete final line without a trailing newline is not torn", () => {
    const text = `${line(1)}\n${line(2)}`
    expect(truncateTornTail({ text })).toEqual({ text, torn: undefined })
  })

  test("a torn final line is split off and can be reattached byte for byte", () => {
    const torn = '{"n": 2, "note": "half'
    const text = `${line(1)}\n${torn}`
    const result = truncateTornTail({ text })
    expect(result.text).toBe(`${line(1)}\n`)
    expect(result.torn).toBe(torn)
    expect(`${result.text}${result.torn}`).toBe(text)
  })

  test("a torn first line with no newline leaves empty text", () => {
    expect(truncateTornTail({ text: '{"n": 1' })).toEqual({ text: "", torn: '{"n": 1' })
  })

  test("empty input is untouched", () => {
    expect(truncateTornTail({ text: "" })).toEqual({ text: "", torn: undefined })
  })

  test("a truncated file plus a re-append round-trips through the reader", () => {
    const torn = '{"n": 9, "n'
    const text = `${line(1)}\n${torn}`
    const repaired = truncateTornTail({ text })
    const appended = `${repaired.text}${line(2)}\n`
    const result = readJsonlTolerant({ text: appended, parse: parseEntry })
    expect(numbers(result)).toEqual([2, 1])
    expect(result.damaged).toBe(false)
  })
})

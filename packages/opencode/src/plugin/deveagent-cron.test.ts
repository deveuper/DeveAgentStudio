import { describe, expect, test } from "bun:test"
import { isValidTimeZone, nextCronRun, parseCron } from "./deveagent-cron"

describe("cron parsing", () => {
  test("accepts a plain 5-field expression", () => {
    const fields = parseCron("30 9 * * *")
    expect(fields).toBeDefined()
    expect(fields!.minutes).toEqual([30])
    expect(fields!.hours).toEqual([9])
    expect(fields!.daysOfMonth).toBeNull()
    expect(fields!.months).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(fields!.daysOfWeek).toBeNull()
  })

  test("supports lists, ranges, and steps", () => {
    const fields = parseCron("0,30 8-10/2 * 3,6 1-5")
    expect(fields).toBeDefined()
    expect(fields!.minutes).toEqual([0, 30])
    expect(fields!.hours).toEqual([8, 10])
    expect(fields!.daysOfMonth).toBeNull()
    expect(fields!.months).toEqual([3, 6])
    expect(fields!.daysOfWeek).toEqual([1, 2, 3, 4, 5])
    expect(parseCron("*/15 * * * *")!.minutes).toEqual([0, 15, 30, 45])
  })

  test("normalizes day-of-week 7 to Sunday", () => {
    expect(parseCron("* * * * 7")!.daysOfWeek).toEqual([0])
    expect(parseCron("* * * * 0,7")!.daysOfWeek).toEqual([0])
  })

  test("rejects malformed expressions", () => {
    expect(parseCron("30 9 * *")).toBeUndefined()
    expect(parseCron("30 9 * * * *")).toBeUndefined()
    expect(parseCron("60 9 * * *")).toBeUndefined()
    expect(parseCron("30 25 * * *")).toBeUndefined()
    expect(parseCron("30 9 32 * *")).toBeUndefined()
    expect(parseCron("30 9 * 13 *")).toBeUndefined()
    expect(parseCron("abc 9 * * *")).toBeUndefined()
    expect(parseCron("30/0 9 * * *")).toBeUndefined()
    expect(parseCron("5-1 9 * * *")).toBeUndefined()
  })
})

describe("nextCronRun", () => {
  test("returns the next matching minute strictly after the reference time", () => {
    const from = Date.UTC(2026, 0, 1, 10, 0, 30)
    expect(nextCronRun("*/15 * * * *", from)).toBe(Date.UTC(2026, 0, 1, 10, 15))
    expect(nextCronRun("0 10 * * *", from)).toBe(Date.UTC(2026, 0, 2, 10, 0))
  })

  test("computes the next run on the wall clock of a non-UTC timezone", () => {
    // 09:30 Asia/Shanghai on 2026-09-11 == 01:30 UTC.
    const from = Date.UTC(2026, 8, 10, 23, 0, 0)
    expect(nextCronRun("30 9 * * *", from, "Asia/Shanghai")).toBe(Date.UTC(2026, 8, 11, 1, 30))
    // The same expression in UTC stays at 09:30 UTC.
    expect(nextCronRun("30 9 * * *", from, "UTC")).toBe(Date.UTC(2026, 8, 11, 9, 30))
  })

  test("falls back to UTC for an unknown timezone instead of throwing", () => {
    const from = Date.UTC(2026, 0, 1, 10, 0, 0)
    expect(nextCronRun("0 11 * * *", from, "Mars/Olympus")).toBe(Date.UTC(2026, 0, 1, 11, 0))
  })

  test("skips the DST spring-forward gap (America/New_York, 2026-03-08)", () => {
    // 02:30 local does not exist on 2026-03-08; the run lands at 03:00 EDT (07:00 UTC).
    const from = Date.UTC(2026, 2, 8, 5, 0, 0) // 00:00 EST
    const next = nextCronRun("30 2 * * *", from, "America/New_York")
    expect(next).toBe(Date.UTC(2026, 2, 8, 7, 0))
    expect(new Date(next!).getUTCHours()).toBe(7)
  })

  test("resolves the DST fall-back repeated hour to the earlier instant", () => {
    // 01:30 happens twice on 2026-11-01; this implementation picks 01:30 EDT (05:30 UTC).
    const from = Date.UTC(2026, 10, 1, 4, 0, 0) // 00:00 EDT
    expect(nextCronRun("30 1 * * *", from, "America/New_York")).toBe(Date.UTC(2026, 10, 1, 5, 30))
  })

  test("uses OR semantics when day-of-month and day-of-week are both restricted", () => {
    // 2026-09-13 (Sun) and 09-14 (Mon) match via dom 13-15; 2026-09-18 (Fri)
    // matches via dow 5 — each proves one half of the OR rule.
    expect(nextCronRun("0 9 13-15 * 5", Date.UTC(2026, 8, 11, 12, 0, 0))).toBe(Date.UTC(2026, 8, 13, 9, 0))
    expect(nextCronRun("0 9 13-15 * 5", Date.UTC(2026, 8, 15, 12, 0, 0))).toBe(Date.UTC(2026, 8, 18, 9, 0))
  })

  test("never skips a match that is the next whole minute (off-by-one)", () => {
    // Regression: startSlot is derived from the NEXT whole minute, so a slot
    // equal to it must match — a strict compare is required.
    expect(nextCronRun("*/5 * * * *", Date.UTC(2026, 0, 1, 10, 4, 30))).toBe(Date.UTC(2026, 0, 1, 10, 5))
    expect(nextCronRun("*/15 * * * *", Date.UTC(2026, 0, 1, 10, 14, 30))).toBe(Date.UTC(2026, 0, 1, 10, 15))
    // A daily job created at 09:59:30 must run the same day, not the next.
    expect(nextCronRun("0 10 * * *", Date.UTC(2026, 0, 1, 9, 59, 30))).toBe(Date.UTC(2026, 0, 1, 10, 0))
    // Strictly-after still holds when the start is exactly on the boundary.
    expect(nextCronRun("0 10 * * *", Date.UTC(2026, 0, 1, 10, 0, 0))).toBe(Date.UTC(2026, 0, 2, 10, 0))
  })
  test("returns undefined when the expression can never match", () => {
    expect(nextCronRun("0 2 31 2 *", Date.UTC(2026, 0, 1))).toBeUndefined()
    expect(nextCronRun("not a cron", Date.UTC(2026, 0, 1))).toBeUndefined()
  })

  test("isValidTimeZone accepts IANA names and rejects garbage", () => {
    expect(isValidTimeZone("Asia/Shanghai")).toBe(true)
    expect(isValidTimeZone("America/New_York")).toBe(true)
    expect(isValidTimeZone("Not/AZone")).toBe(false)
  })
})

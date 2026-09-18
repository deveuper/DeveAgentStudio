// DeveAgent cron scheduling for Automations (NIGHT_RUN plan R147/R148).
// ========================================
// A tiny, dependency-free 5-field cron implementation so `loop-set` can accept
// standard cron expressions plus an IANA timezone, next to the legacy
// `intervalSeconds` schedule.
//
// Fields: minute (0-59) hour (0-23) day-of-month (1-31) month (1-12)
// day-of-week (0-6, 0 = Sunday; 7 is normalized to Sunday).
// Supported syntax per field: `*`, `a`, `a-b`, `*/step`, `a/step`, `a-b/step`,
// and comma-separated lists of those. Standard cron day semantics apply: if
// both day-of-month and day-of-week are restricted, a day matches when EITHER
// matches.
//
// Timezone math uses Intl.DateTimeFormat only (no new deps): wall-clock parts
// are read through the formatter, and a wall time is converted back to UTC by
// subtracting the zone offset, then verified by re-reading the wall clock.
// Minutes that fall inside a DST spring-forward gap are skipped (the run moves
// to the next matching minute); the DST fall-back repeated hour deterministically
// resolves to the earlier instant.

export type CronFields = {
  minutes: number[]
  hours: number[]
  daysOfMonth: number[] | null
  months: number[]
  daysOfWeek: number[] | null
}

const FIELD_BOUNDS: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
]

function parseCronField(field: string, min: number, max: number): number[] | undefined {
  const values = new Set<number>()
  for (const part of field.split(",")) {
    if (!part) return undefined
    let body = part
    let step = 1
    const slash = part.indexOf("/")
    if (slash >= 0) {
      body = part.slice(0, slash)
      const stepText = part.slice(slash + 1)
      if (!/^\d+$/.test(stepText)) return undefined
      step = Number(stepText)
      if (step < 1) return undefined
    }
    let rangeStart = min
    let rangeEnd = max
    if (body !== "*") {
      const dash = body.indexOf("-")
      if (dash >= 0) {
        const startText = body.slice(0, dash)
        const endText = body.slice(dash + 1)
        if (!/^\d+$/.test(startText) || !/^\d+$/.test(endText)) return undefined
        rangeStart = Number(startText)
        rangeEnd = Number(endText)
      } else {
        if (!/^\d+$/.test(body)) return undefined
        rangeStart = Number(body)
        // `a/step` means "starting at a, every step to the field maximum".
        rangeEnd = slash >= 0 ? max : rangeStart
      }
    } else if (slash < 0) {
      // plain `*`
      for (let value = min; value <= max; value++) values.add(value)
      continue
    }
    if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd)) return undefined
    if (rangeStart < min || rangeEnd > max || rangeStart > rangeEnd) return undefined
    for (let value = rangeStart; value <= rangeEnd; value += step) values.add(value)
  }
  return [...values].sort((a, b) => a - b)
}

/**
 * Parse a 5-field cron expression. Returns undefined when the expression is
 * malformed so callers can reject it with a clear message.
 */
export function parseCron(expr: string): CronFields | undefined {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return undefined
  const parsed = fields.map((field, index) => parseCronField(field, FIELD_BOUNDS[index]![0], FIELD_BOUNDS[index]![1]))
  if (parsed.some((values) => values === undefined)) return undefined
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parsed as number[][]
  // day-of-week: 7 is an accepted alias for Sunday (0); dedupe after mapping.
  const dows = [...new Set(daysOfWeek.map((value) => (value === 7 ? 0 : value)))].sort((a, b) => a - b)
  return {
    minutes,
    hours,
    daysOfMonth: fields[2] === "*" ? null : daysOfMonth,
    months,
    daysOfWeek: fields[4] === "*" ? null : dows,
  }
}

export function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date())
    return true
  } catch {
    return false
  }
}

type ZonedParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function zonedFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
    formatterCache.set(timezone, formatter)
  }
  return formatter
}

function zonedParts(timezone: string, atMs: number): ZonedParts {
  const parts = zonedFormatter(timezone).formatToParts(new Date(atMs))
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  }
}

// wall - utc, in milliseconds, at the given instant.
function zonedOffsetMs(timezone: string, atMs: number): number {
  const parts = zonedParts(timezone, atMs)
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return asUtc - Math.floor(atMs / 1000) * 1000
}

/**
 * Convert a wall-clock time in `timezone` to a UTC instant. Returns undefined
 * when the wall time does not exist in the zone (DST spring-forward gap) —
 * callers simply try the next matching minute instead of guessing.
 */
function wallToUtcMs(timezone: string, year: number, month: number, day: number, hour: number, minute: number): number | undefined {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0)
  let instant = wallAsUtc - zonedOffsetMs(timezone, wallAsUtc)
  // Second pass converges when the first guess crossed a DST boundary.
  instant = wallAsUtc - zonedOffsetMs(timezone, instant)
  const wall = zonedParts(timezone, instant)
  if (wall.year !== year || wall.month !== month || wall.day !== day || wall.hour !== hour || wall.minute !== minute) return undefined
  return instant
}

function dayMatches(fields: CronFields, year: number, month: number, day: number): boolean {
  if (!fields.months.includes(month)) return false
  const domRestricted = fields.daysOfMonth !== null
  const dowRestricted = fields.daysOfWeek !== null
  if (!domRestricted && !dowRestricted) return true
  const domOk = domRestricted && fields.daysOfMonth!.includes(day)
  // Standard cron: when both are restricted, either one matching is enough.
  const dowOk = dowRestricted && fields.daysOfWeek!.includes(new Date(Date.UTC(year, month - 1, day)).getUTCDay())
  return domOk || dowOk
}

function minutesOfDay(fields: CronFields): number[] {
  const slots: number[] = []
  for (const hour of fields.hours) for (const minute of fields.minutes) slots.push(hour * 60 + minute)
  return slots.sort((a, b) => a - b)
}

/**
 * Next instant (UTC ms) strictly after `fromMs` matching the cron expression,
 * evaluated on the wall clock of `timezone` (defaults to UTC). Returns
 * undefined when the expression is malformed or has no match within four
 * years (e.g. `0 2 31 2 *`).
 */
export function nextCronRun(expr: string, fromMs: number, timezone?: string): number | undefined {
  const fields = parseCron(expr)
  if (!fields) return undefined
  const zone = timezone && isValidTimeZone(timezone) ? timezone : "UTC"
  // Candidate minutes start at the next whole minute strictly after fromMs.
  const startMs = Math.floor(fromMs / 60_000) * 60_000 + 60_000
  const start = zonedParts(zone, startMs)
  const startSlot = start.hour * 60 + start.minute
  const slots = minutesOfDay(fields)
  let year = start.year
  let month = start.month
  let day = start.day
  for (let dayIndex = 0; dayIndex < 4 * 366; dayIndex++) {
    if (dayMatches(fields, year, month, day)) {
      for (const slot of slots) {
        // startSlot is the NEXT whole minute (startMs already advanced one
        // minute), so a slot equal to it is a valid match — strict compare.
        if (dayIndex === 0 && slot < startSlot) continue
        let instant = wallToUtcMs(zone, year, month, day, Math.floor(slot / 60), slot % 60)
        // Wall time vanished into a DST spring-forward gap: run right after
        // the gap ends, at the first wall minute that exists that day
        // (02:30 -> 03:00 on the transition day).
        for (let probe = 1; instant === undefined && probe <= 120; probe++) {
          const probeSlot = slot + probe
          if (probeSlot >= 24 * 60) break
          instant = wallToUtcMs(zone, year, month, day, Math.floor(probeSlot / 60), probeSlot % 60)
        }
        if (instant !== undefined && instant > fromMs) return instant
      }
    }
    const next = new Date(Date.UTC(year, month - 1, day + 1))
    year = next.getUTCFullYear()
    month = next.getUTCMonth() + 1
    day = next.getUTCDate()
  }
  return undefined
}

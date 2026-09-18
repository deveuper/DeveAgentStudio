import { describe, expect, test } from "bun:test"
import { assertDesktopWindowHandle, filterDesktopWindows, parseDesktopWindows, parseWindowElements, parseHotkeyCombo, typeInputPlan, windowRelativeToScreen, WINDOW_LIST_SCRIPT } from "./computer-use-windows"

const SAMPLE = [
  { handle: "1", title: "DeveAgent Studio", pid: 10, bounds: { x: 0, y: 0, width: 800, height: 600 }, focused: true },
  { handle: "2", title: "Notepad", pid: 20, bounds: { x: 0, y: 0, width: 400, height: 300 }, focused: false },
  { handle: "3", title: "deveagent docs - Chrome", pid: 30, bounds: { x: 0, y: 0, width: 500, height: 500 }, focused: false },
]

describe("computer-use-windows", () => {
  test("filterDesktopWindows matches titles case-insensitively and pid exactly", () => {
    expect(filterDesktopWindows(SAMPLE, { title: "deveagent" })).toHaveLength(2)
    expect(filterDesktopWindows(SAMPLE, { title: "  NOTEPAD " })).toEqual([SAMPLE[1]])
    expect(filterDesktopWindows(SAMPLE, { pid: 30 })).toEqual([SAMPLE[2]])
    expect(filterDesktopWindows(SAMPLE, { title: "deveagent", pid: 10 })).toEqual([SAMPLE[0]])
    expect(filterDesktopWindows(SAMPLE, { title: "deveagent", pid: 20 })).toEqual([])
    expect(filterDesktopWindows(SAMPLE, undefined)).toHaveLength(3)
    expect(filterDesktopWindows(SAMPLE, {})).toHaveLength(3)
    // Non-string/number junk is ignored, not thrown.
    expect(filterDesktopWindows(SAMPLE, { title: 42 as unknown as string, pid: "x" as unknown as number })).toHaveLength(3)
  })

  test("parses a JSON array of windows", () => {
    const windows = parseDesktopWindows(
      JSON.stringify([
        { handle: "132456", title: "Notepad", pid: 4242, x: 10, y: 20, width: 800, height: 600, focused: true },
        { handle: "999", title: "  Explorer  ", pid: 7, x: 0, y: 0, width: 1920, height: 1080, focused: false },
      ]),
    )
    expect(windows).toHaveLength(2)
    expect(windows[0]).toEqual({ handle: "132456", title: "Notepad", pid: 4242, bounds: { x: 10, y: 20, width: 800, height: 600 }, focused: true })
    expect(windows[1]?.title).toBe("Explorer")
  })

  test("tolerates a single-object payload and drops unusable entries", () => {
    expect(parseDesktopWindows(JSON.stringify({ handle: "1", title: "Solo", pid: 1, focused: false }))).toHaveLength(1)
    expect(parseDesktopWindows(JSON.stringify([{ handle: "", title: "x" }, { title: "no handle" }, { handle: "2", title: "   " }]))).toEqual([])
    expect(parseDesktopWindows("not json")).toEqual([])
    expect(parseDesktopWindows("")).toEqual([])
  })

  test("normalizes missing numeric fields to zero and caps titles", () => {
    const [window] = parseDesktopWindows(JSON.stringify([{ handle: "5", title: "t".repeat(400), pid: "nope", x: "nope", focused: "yes" }]))
    expect(window?.pid).toBe(0)
    expect(window?.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    expect(window?.focused).toBe(false)
    expect(window?.title.length).toBe(200)
  })

  test("accepts numeric handles and rejects anything else", () => {
    expect(assertDesktopWindowHandle("132456")).toBe("132456")
    expect(assertDesktopWindowHandle(132456)).toBe("132456")
    expect(assertDesktopWindowHandle(" 42 ")).toBe("42")
    expect(() => assertDesktopWindowHandle("0x1f")).toThrow()
    expect(() => assertDesktopWindowHandle("-1")).toThrow()
    expect(() => assertDesktopWindowHandle("")).toThrow()
    expect(() => assertDesktopWindowHandle(undefined)).toThrow()
    expect(() => assertDesktopWindowHandle("1; rm -rf /")).toThrow()
  })

  test("parseWindowElements normalizes roles, drops junk and caps the count", () => {
    const elements = parseWindowElements(
      JSON.stringify([
        { name: "Send", role: "ControlType.Button", enabled: true, x: 1, y: 2, w: 80, h: 24 },
        { name: "", role: "", x: 0, y: 0, w: 0, h: 0 },
        { name: "query box", role: "ControlType.Edit", enabled: false, x: "x", w: 10.9, h: 2 },
      ]),
      200,
    )
    expect(elements).toHaveLength(2)
    expect(elements[0]).toEqual({ name: "Send", role: "Button", enabled: true, bounds: { x: 1, y: 2, width: 80, height: 24 } })
    expect(elements[1]?.role).toBe("Edit")
    expect(elements[1]?.enabled).toBe(false)
    expect(elements[1]?.bounds).toEqual({ x: 0, y: 0, width: 11, height: 2 })
    expect(parseWindowElements("not json", 5)).toEqual([])
    expect(parseWindowElements("", 5)).toEqual([])
    expect(parseWindowElements(JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ name: `n${i}`, role: "Button" }))), 4)).toHaveLength(4)
  })

  test("the inventory script never interpolates untrusted input", () => {
    expect(WINDOW_LIST_SCRIPT).toContain("EnumWindows")
    expect(WINDOW_LIST_SCRIPT).toContain("ConvertTo-Json")
    expect(WINDOW_LIST_SCRIPT).not.toContain("$args")
  })
})

describe("window coordinate math", () => {
  test("windowRelativeToScreen converts relative to screen and rounds", () => {
    expect(windowRelativeToScreen({ x: 100, y: 50, width: 800, height: 600 }, 10, 20)).toEqual({ x: 110, y: 70 })
    // Rounding happens on rect and point separately (Math.round each addend).
    expect(windowRelativeToScreen({ x: -20.4, y: 10.6, width: 800, height: 600 }, 0.5, 0.5)).toEqual({ x: -19, y: 12 })
    // Negative relative coordinates (e.g. the title bar area of a maximized
    // window at 0,0) pass through unchanged.
    expect(windowRelativeToScreen({ x: 0, y: 0, width: 800, height: 600 }, -5, 12)).toEqual({ x: -5, y: 12 })
  })
})

describe("type + hotkey planning", () => {
  test("typeInputPlan caps length and drops control characters", () => {
    const plan = typeInputPlan("ab\n cd")
    expect(plan.chars).toEqual([..."ab\n cd"])
    expect(plan.truncated).toBe(false)
    const long = typeInputPlan("x".repeat(600))
    expect(long.chars).toHaveLength(500)
    expect(long.truncated).toBe(true)
    // Control characters other than newline are dropped (SendInput would misbehave).
    const filtered = typeInputPlan("a\tb\u0000c")
    expect(filtered.chars).toEqual([..."abc"])
    expect(filtered.truncated).toBe(true)
    expect(typeInputPlan("").chars).toEqual([])
  })

  test("parseHotkeyCombo orders modifiers before the base key and rejects junk", () => {
    expect(parseHotkeyCombo("ctrl+s")).toEqual({ vks: [0x11, 0x53] })
    expect(parseHotkeyCombo(" Ctrl + Shift + S ")).toEqual({ vks: [0x11, 0x10, 0x53] })
    expect(parseHotkeyCombo("f15")).toEqual({ vks: [0x7e] })
    expect(parseHotkeyCombo("")).toEqual({ error: "keys is empty" })
    expect(parseHotkeyCombo("ctrl")).toEqual({ vks: [0x11] })
    expect(parseHotkeyCombo("ctrl+ctrl+s").error).toContain("duplicate")
    expect(parseHotkeyCombo("ctrl+s+d").error).toContain("one base key")
    expect(parseHotkeyCombo("ctrl+smith").error).toContain("unsupported")
    expect(parseHotkeyCombo("a+b+c+d+e+f").error).toContain("too many")
  })
})

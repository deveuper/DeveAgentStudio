import { describe, expect, test } from "bun:test"
import { HeadTailBuffer, clampYieldFor } from "./pty"

describe("pty head/tail buffer", () => {
  test("small writes come back verbatim", () => {
    const buffer = new HeadTailBuffer(1024, 1024)
    buffer.push(Buffer.from("hello "))
    buffer.push(Buffer.from("world"))
    expect(buffer.take()).toBe("hello world")
    expect(buffer.take()).toBe("")
  })

  test("overflow keeps head and tail with an omission marker", () => {
    const buffer = new HeadTailBuffer(10, 10)
    buffer.push(Buffer.from("HEADSTART"))
    buffer.push(Buffer.from("MIDDLE-MIDDLE-MIDDLE"))
    buffer.push(Buffer.from("TAILFINE"))
    const text = buffer.take()
    expect(text.startsWith("HEADSTART")).toBe(true)
    expect(text.endsWith("TAILFINE")).toBe(true)
    expect(text).toContain("bytes omitted")
    expect(text).not.toContain("MIDDLE")
  })

  test("size tracks head + tail + omitted", () => {
    const buffer = new HeadTailBuffer(4, 4)
    buffer.push(Buffer.from("1234567890"))
    // 4 head + 4 tail + 2 omitted
    expect(buffer.size).toBe(10)
  })

  test("take drains to head + marker + tail and resets size", () => {
    const buffer = new HeadTailBuffer(1024, 1024)
    buffer.push(Buffer.from("a".repeat(5000)))
    const text = buffer.take()
    expect(text.startsWith("a".repeat(1024))).toBe(true)
    expect(text.endsWith("a".repeat(1024))).toBe(true)
    expect(text).toContain("bytes omitted")
    expect(buffer.size).toBe(0)
  })

  test("multi-byte utf8 survives concat boundaries", () => {
    const buffer = new HeadTailBuffer(1024, 1024)
    const text = "中文输出" + "x".repeat(2000)
    buffer.push(Buffer.from(text, "utf8"))
    expect(buffer.take()).toBe(text)
  })
})

describe("pty yield clamp", () => {
  test("windows floor applies", () => {
    expect(clampYieldFor(100, "win32")).toBe(10_000)
    expect(clampYieldFor(250, "linux")).toBe(250)
    expect(clampYieldFor(999_999, "win32")).toBe(30_000)
  })
})

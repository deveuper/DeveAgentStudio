import { describe, expect, test } from "bun:test"
import type { AgentPart, ContentPart, FileAttachmentPart, ImageAttachmentPart, TextPart } from "@/context/prompt"
import { insertVoiceText } from "./voice-insert"

const text = (content: string): TextPart => ({ type: "text", content, start: 0, end: content.length })
const file = (path: string): FileAttachmentPart => ({ type: "file", path, content: "@" + path, start: 0, end: 0 })
const agent = (name: string): AgentPart => ({ type: "agent", name, content: "@" + name, start: 0, end: 0 })
const image = (id: string): ImageAttachmentPart => ({
  type: "image",
  id,
  filename: id + ".png",
  mime: "image/png",
  dataUrl: "data:image/png;base64," + id,
})

describe("insertVoiceText", () => {
  test("splices the transcription into the text part at the cursor", () => {
    const result = insertVoiceText([text("abcd")], 2, "XY")

    expect(result.parts).toEqual([{ type: "text", content: "abXYcd", start: 0, end: 6 }])
    expect(result.cursor).toBe(4)
  })

  test("keeps a trailing @ file mention and shifts its offsets", () => {
    const parts: ContentPart[] = [text("ab"), file("src/a.ts")]

    const result = insertVoiceText(parts, 2, "ZZ")

    expect(result.parts).toEqual([
      { type: "text", content: "abZZ", start: 0, end: 4 },
      { type: "file", path: "src/a.ts", content: "@src/a.ts", start: 4, end: 13 },
    ])
    expect(result.cursor).toBe(4)
  })

  test("keeps an @ agent mention that precedes the caret", () => {
    const parts: ContentPart[] = [agent("build"), text("xy")]

    const result = insertVoiceText(parts, 7, "ZZ")

    expect(result.parts).toEqual([
      { type: "agent", name: "build", content: "@build", start: 0, end: 6 },
      { type: "text", content: "xZZy", start: 6, end: 10 },
    ])
    expect(result.cursor).toBe(9)
  })

  test("keeps an image attachment in place without offsets", () => {
    const parts: ContentPart[] = [text("abcd"), image("img1")]

    const result = insertVoiceText(parts, 2, "ZZ")

    expect(result.parts).toEqual([{ type: "text", content: "abZZcd", start: 0, end: 6 }, image("img1")])
    expect(result.cursor).toBe(4)
  })

  test("inserts into an empty prompt at cursor 0", () => {
    const result = insertVoiceText([text("")], 0, "hi")

    expect(result.parts).toEqual([{ type: "text", content: "hi", start: 0, end: 2 }])
    expect(result.cursor).toBe(2)
  })

  test("adds a separating space when dictating at the end of existing text", () => {
    const result = insertVoiceText([text("hello")], 5, "world")

    expect(result.parts).toEqual([{ type: "text", content: "hello world", start: 0, end: 11 }])
    expect(result.cursor).toBe(11)
  })

  test("does not double the space when the text already ends with whitespace", () => {
    const result = insertVoiceText([text("hello ")], 6, "world")

    expect(result.parts).toEqual([{ type: "text", content: "hello world", start: 0, end: 11 }])
    expect(result.cursor).toBe(11)
  })

  test("does not add a space for a mid-text insertion", () => {
    const result = insertVoiceText([text("hello")], 3, "world")

    expect(result.parts).toEqual([{ type: "text", content: "helworldlo", start: 0, end: 10 }])
    expect(result.cursor).toBe(8)
  })

  test("treats empty and whitespace-only transcriptions as a no-op", () => {
    const parts: ContentPart[] = [text("abc")]

    const blank = insertVoiceText(parts, 1, "")
    expect(blank.parts).toBe(parts)
    expect(blank.cursor).toBe(1)

    const spaces = insertVoiceText(parts, 1, "   ")
    expect(spaces.parts).toBe(parts)
    expect(spaces.cursor).toBe(1)

    const clamped = insertVoiceText(parts, 99, " ")
    expect(clamped.parts).toBe(parts)
    expect(clamped.cursor).toBe(3)
  })

  test("appends a text part when the prompt has no text part", () => {
    const withPill = insertVoiceText([file("a.ts")], 5, "ZZ")
    expect(withPill.parts).toEqual([
      { type: "file", path: "a.ts", content: "@a.ts", start: 0, end: 5 },
      { type: "text", content: " ZZ", start: 5, end: 8 },
    ])
    expect(withPill.cursor).toBe(8)

    const empty = insertVoiceText([], 0, "hi")
    expect(empty.parts).toEqual([{ type: "text", content: "hi", start: 0, end: 2 }])
    expect(empty.cursor).toBe(2)
  })

  test("anchors a caret on a pill to the adjacent text part", () => {
    const parts: ContentPart[] = [text("ab"), file("a.ts")]

    const result = insertVoiceText(parts, 3, "ZZ")

    expect(result.parts).toEqual([
      { type: "text", content: "abZZ", start: 0, end: 4 },
      { type: "file", path: "a.ts", content: "@a.ts", start: 4, end: 9 },
    ])
    expect(result.cursor).toBe(4)
  })
})

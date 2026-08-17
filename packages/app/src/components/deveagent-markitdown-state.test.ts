import { describe, expect, test } from "bun:test"

import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { collectDeveAgentMarkItDownEvents, formatDeveAgentMarkItDownBytes, formatDeveAgentMarkItDownTime } from "./deveagent-markitdown-state"

const message = (id: string): Message =>
  ({ id, role: "assistant", sessionID: "ses_test", time: { created: 1 } }) as Message

const part = (id: string, messageID: string, metadata: Record<string, unknown>, text: string): Part =>
  ({ id, messageID, sessionID: "ses_test", type: "text", synthetic: true, metadata, text }) as Part

describe("DeveAgent MarkItDown state", () => {
  test("extracts real conversion provenance and keeps event order", () => {
    const events = collectDeveAgentMarkItDownEvents([message("msg_a"), message("msg_b")], (messageID) => [
      messageID === "msg_a"
        ? part("part_b", messageID, { deveagentMarkItDown: { status: "converted", sourceRelativePath: "input.docx", markdownRelativePath: ".deveagent/markitdown/input.md", sourceBytes: 2048, sourceModifiedAt: 1_700_000_000_000, cached: true } }, "converted")
        : part("part_a", messageID, { deveagentMarkItDown: { status: "failed", rawDocumentForwardedToModel: false, attempts: [{ command: "python", error: "module missing" }] } }, "failed"),
    ])

    expect(events.map((event) => event.status)).toEqual(["converted", "failed"])
    expect(events[0]!).toMatchObject({ sourceRelativePath: "input.docx", markdownRelativePath: ".deveagent/markitdown/input.md", sourceModifiedAt: 1_700_000_000_000, cached: true })
    expect(events[1]!).toMatchObject({ rawDocumentForwardedToModel: false, attempts: [{ error: "module missing" }] })
  })

  test("ignores unrelated text metadata and does not invent byte values", () => {
    const events = collectDeveAgentMarkItDownEvents([message("msg")], () => [
      part("plain", "msg", { other: { status: "converted" } }, "plain"),
    ])

    expect(events).toEqual([])
    expect(formatDeveAgentMarkItDownBytes(undefined)).toBe("大小未知")
    expect(formatDeveAgentMarkItDownBytes(2048)).toBe("2.0 KB")
    expect(formatDeveAgentMarkItDownTime(undefined)).toBe("时间未知")
    expect(formatDeveAgentMarkItDownTime(1_700_000_000_000)).toBe("2023-11-14T22:13:20.000Z")
  })
})

import { describe, expect, test } from "bun:test"
import { buildSessionExport, buildSessionExportJson, buildSessionExportMarkdown } from "./session-export"

const input = {
  title: "My session",
  sessionID: "ses_123",
  messages: [
    { role: "user", text: "Fix the bug" },
    { role: "assistant", text: "Fixed it." },
  ],
  usage: { tokens: 1234, cost: 0.0567 },
}

describe("session-export", () => {
  test("markdown contains title, session, usage and messages in order", () => {
    const md = buildSessionExportMarkdown(input)
    expect(md).toContain("# My session")
    expect(md).toContain("- Session: ses_123")
    expect(md).toContain("- Tokens: 1234")
    expect(md).toContain("- Cost: $0.0567")
    expect(md).toContain("## User\n\nFix the bug")
    expect(md).toContain("## Assistant\n\nFixed it.")
    expect(md.indexOf("## User")).toBeLessThan(md.indexOf("## Assistant"))
  })

  test("missing usage renders as not returned, never as zero", () => {
    const md = buildSessionExportMarkdown({ ...input, usage: undefined })
    expect(md).toContain("Tokens: not returned")
    expect(md).toContain("Cost: not returned")
    const json = JSON.parse(buildSessionExportJson({ ...input, usage: undefined }))
    expect(json.usage.tokens).toBe("not returned")
    expect(json.usage.cost).toBe("not returned")
  })

  test("json export round-trips messages and metadata", () => {
    const parsed = JSON.parse(buildSessionExportJson(input))
    expect(parsed.title).toBe("My session")
    expect(parsed.sessionID).toBe("ses_123")
    expect(parsed.messages).toHaveLength(2)
    expect(parsed.exportedAt).toBeTruthy()
  })

  test("buildSessionExport picks content type and safe filename", () => {
    const md = buildSessionExport("md", input)
    expect(md.contentType).toBe("text/markdown")
    expect(md.filename).toBe("My_session.md")
    const json = buildSessionExport("json", input)
    expect(json.contentType).toBe("application/json")
    expect(json.filename).toBe("My_session.json")
    const weird = buildSessionExport("md", { ...input, title: "a/b:c???" })
    expect(weird.filename).not.toContain("/")
  })
})

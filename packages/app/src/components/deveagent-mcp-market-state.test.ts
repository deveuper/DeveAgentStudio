import { describe, expect, test } from "bun:test"

import { mcpInstallConfirmMessage, mcpSourceNameKey, mcpStatusLabelKey, mcpStatusTone, mcpStatusTooltip, type WorkspaceMcpState } from "./deveagent-mcp-market-state"

describe("MCP marketplace status mapping", () => {
  test("keeps the five server states as five distinct dictionary keys", () => {
    const keys = [
      mcpStatusLabelKey("connected"),
      mcpStatusLabelKey("disabled"),
      mcpStatusLabelKey("failed"),
      mcpStatusLabelKey("needs_auth"),
      mcpStatusLabelKey("needs_client_registration"),
    ]
    expect(new Set(keys).size).toBe(5)
    expect(keys).toEqual([
      "deveagent.mcp.statusConnected",
      "deveagent.mcp.statusDisabled",
      "deveagent.mcp.statusConnectionFailed",
      "deveagent.mcp.statusAuthorizationRequired",
      "deveagent.mcp.statusRegistrationRequired",
    ])
  })

  test("assigns one tone per state: connected ok, failed error, the rest warn", () => {
    expect(mcpStatusTone("connected")).toBe("ok")
    expect(mcpStatusTone("failed")).toBe("error")
    expect(mcpStatusTone("disabled")).toBe("warn")
    expect(mcpStatusTone("needs_auth")).toBe("warn")
    expect(mcpStatusTone("needs_client_registration")).toBe("warn")
  })

  test("an out-of-union status falls back to a real key, never undefined", () => {
    // A server may report a state this build does not know. The label resolver
    // must still return a dictionary key: `language.t(undefined)` throws inside
    // @solid-primitives/i18n, so returning undefined would crash the render.
    const unknown = "needs_reauth" as unknown as WorkspaceMcpState
    expect(mcpStatusLabelKey(unknown)).toBe("deveagent.mcp.statusRegistrationRequired")
    expect(mcpStatusLabelKey(unknown)).not.toBeUndefined()
    expect(mcpStatusTone(unknown)).toBe("warn")
  })

  test("a failed status surfaces its error text in the tooltip", () => {
    expect(mcpStatusTooltip({ status: "failed", error: "ECONNREFUSED 127.0.0.1:3333" }, "x")).toBe("ECONNREFUSED 127.0.0.1:3333")
    expect(mcpStatusTooltip({ status: "failed", error: "   " }, "failed")).toBe("failed")
    expect(mcpStatusTooltip({ status: "connected" }, "connected")).toBe("connected")
  })
})

describe("MCP marketplace source naming", () => {
  test("maps the official registry tab to its own key", () => {
    expect(mcpSourceNameKey("official")).toBe("deveagent.mcp.sourceOfficialRegistry")
  })

  test("maps the Tencent Cloud tab to its own key", () => {
    expect(mcpSourceNameKey("tencent")).toBe("deveagent.mcp.sourceTencentCloud")
  })

  test("maps the Alibaba Cloud tab to its own key", () => {
    expect(mcpSourceNameKey("aliyun")).toBe("deveagent.mcp.sourceAlibabaCloud")
  })

  test("never labels a manual/unknown source as a cloud vendor", () => {
    // A directly pasted URL (undefined) or a corrupted tab preference must fall
    // back to the manual-address label, not to Alibaba Cloud.
    expect(mcpSourceNameKey(undefined)).toBe("deveagent.mcp.sourceManualUrl")
    expect(mcpSourceNameKey("")).toBe("deveagent.mcp.sourceManualUrl")
    expect(mcpSourceNameKey("something-else")).toBe("deveagent.mcp.sourceManualUrl")
    expect(mcpSourceNameKey("something-else")).not.toBe("deveagent.mcp.sourceAlibabaCloud")
  })
})

describe("MCP marketplace install confirmation", () => {
  test("names the source, entry, and URL for a no-secret remote", () => {
    const confirm = mcpInstallConfirmMessage({
      sourceName: "Official Registry",
      entryName: "tke-mcp",
      url: "https://mcp.example.com/mcp",
      requiresSecret: false,
    })
    expect(confirm.key).toBe("deveagent.mcp.installConfirm")
    expect(confirm.params).toEqual({ source: "Official Registry", name: "tke-mcp", url: "https://mcp.example.com/mcp" })
  })

  test("uses the secret variant when credentials are required", () => {
    const confirm = mcpInstallConfirmMessage({
      sourceName: "Tencent Cloud",
      entryName: "tke",
      url: "https://mcp.tencentcloud.com/mcp",
      requiresSecret: true,
    })
    expect(confirm.key).toBe("deveagent.mcp.installConfirmSecret")
    expect(confirm.params.source).toBe("Tencent Cloud")
  })
})

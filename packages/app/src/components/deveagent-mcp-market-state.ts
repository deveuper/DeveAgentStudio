export type WorkspaceMcpState = "connected" | "disabled" | "failed" | "needs_auth" | "needs_client_registration"

export interface WorkspaceMcpStatusInput {
  status: WorkspaceMcpState
  error?: string
}

// The marketplace panel renders one of five distinct states per configured MCP
// server. Keeping the mapping here (instead of inline JSX ternaries) makes the
// "five states stay separate" contract unit-testable: each state must resolve to
// its own dictionary key, and a failed status must carry its error text so the
// tooltip can explain the failure. Badge tones collapse to three buckets
// (ok / error / warn) on purpose.
export type McpStatusTone = "ok" | "warn" | "error"

export function mcpStatusLabelKey(status: WorkspaceMcpStatusInput["status"]): string {
  switch (status) {
    case "connected":
      return "deveagent.mcp.statusConnected"
    case "needs_auth":
      return "deveagent.mcp.statusAuthorizationRequired"
    case "failed":
      return "deveagent.mcp.statusConnectionFailed"
    case "disabled":
      return "deveagent.mcp.statusDisabled"
    case "needs_client_registration":
      return "deveagent.mcp.statusRegistrationRequired"
    default:
      // Out-of-union statuses (a newer server emitting a state this build does
      // not know, a skewed/misbehaving response) must not return `undefined`:
      // the caller feeds the key straight into `language.t`, and
      // `@solid-primitives/i18n` throws on an undefined path. Fall back to the
      // same "registration required" copy the old inline ternary chain used.
      return "deveagent.mcp.statusRegistrationRequired"
  }
}

export function mcpStatusTone(status: WorkspaceMcpStatusInput["status"]): McpStatusTone {
  if (status === "connected") return "ok"
  if (status === "failed") return "error"
  return "warn"
}

export function mcpStatusTooltip(status: WorkspaceMcpStatusInput, fallback: string): string {
  const error = status.error?.trim()
  return error || fallback
}

// Dictionary key naming where an MCP endpoint came from. The marketplace tabs
// ("official" / "tencent" / "aliyun") each have their own label; anything else
// (a directly pasted URL, or a corrupted tab preference) is a manual address —
// it must never be labelled as a cloud vendor. Returns a key so the caller can
// resolve it through `language.t`; keeping it pure makes it unit-testable.
export function mcpSourceNameKey(source: string | undefined): string {
  if (source === "official") return "deveagent.mcp.sourceOfficialRegistry"
  if (source === "tencent") return "deveagent.mcp.sourceTencentCloud"
  if (source === "aliyun") return "deveagent.mcp.sourceAlibabaCloud"
  return "deveagent.mcp.sourceManualUrl"
}

// Confirm text for installing a marketplace MCP endpoint: the dialog must name
// the marketplace source, the exact endpoint URL, and the permission posture
// (whether the caller has to supply credentials/headers).
export function mcpInstallConfirmMessage(input: {
  sourceName: string
  entryName: string
  url: string
  requiresSecret: boolean
}): { key: string; params: Record<string, string> } {
  return {
    key: input.requiresSecret ? "deveagent.mcp.installConfirmSecret" : "deveagent.mcp.installConfirm",
    params: {
      source: input.sourceName,
      name: input.entryName,
      url: input.url,
    },
  }
}

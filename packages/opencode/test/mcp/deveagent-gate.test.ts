import { afterEach, describe, expect, test } from "bun:test"
import { isDeveAgentMcpConfigVisible } from "../../src/mcp/deveagent-gate"

describe("DeveAgent MCP exposure gate", () => {
  afterEach(() => {
    delete (globalThis as any).__deveagent_remote_mcp
  })

  test("hides remote MCP configurations only when the runtime switch is disabled", () => {
    ;(globalThis as any).__deveagent_remote_mcp = false

    expect(isDeveAgentMcpConfigVisible({ type: "remote" })).toBe(false)
    expect(isDeveAgentMcpConfigVisible({ type: "local" })).toBe(true)
  })

  test("keeps OpenCode MCP behavior enabled by default", () => {
    expect(isDeveAgentMcpConfigVisible({ type: "remote" })).toBe(true)
    expect(isDeveAgentMcpConfigVisible(undefined)).toBe(true)
  })
})

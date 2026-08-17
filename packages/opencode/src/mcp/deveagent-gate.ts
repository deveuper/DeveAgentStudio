export function isDeveAgentMcpConfigVisible(config: unknown) {
  if (!config || typeof config !== "object" || !("type" in config)) return true
  return config.type !== "remote" || (globalThis as any).__deveagent_remote_mcp !== false
}

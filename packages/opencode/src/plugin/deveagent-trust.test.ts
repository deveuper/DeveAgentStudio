import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  getProjectTrust,
  isInsideProject,
  isProjectOriginBlocked,
  normalizeProjectDir,
  projectFingerprint,
  scanProjectResources,
  setProjectTrust,
} from "./deveagent-trust"

let storeRoot: string
let originalConfigHome: string | undefined

beforeEach(() => {
  storeRoot = mkdtempSync(join(tmpdir(), "trust-store-"))
  originalConfigHome = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = storeRoot
})

afterEach(() => {
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalConfigHome
  rmSync(storeRoot, { recursive: true, force: true })
})

function projectWith(input: { plugins?: string[]; config?: Record<string, unknown> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "trust-ws-"))
  if (input.plugins?.length) {
    mkdirSync(join(directory, ".opencode", "plugin"), { recursive: true })
    for (const name of input.plugins) writeFileSync(join(directory, ".opencode", "plugin", name), "export const x = 1\n")
  }
  if (input.config) writeFileSync(join(directory, ".opencode", "opencode.json"), JSON.stringify(input.config))
  return directory
}

describe("deveagent-trust", () => {
  test("scanProjectResources finds project plugins and project-declared MCP servers", () => {
    const directory = projectWith({
      plugins: ["one.ts", "two.js", "notes.txt"],
      config: { mcp: { local: { type: "local", command: ["node", "server.js"] }, remote: { type: "remote", url: "https://mcp.example/sse" } } },
    })
    try {
      const resources = scanProjectResources(directory)
      const plugins = resources.filter((item) => item.kind === "plugin").map((item) => item.target)
      expect(plugins).toEqual([".opencode/plugin/one.ts", ".opencode/plugin/two.js"])
      const mcp = resources.filter((item) => item.kind === "mcp").map((item) => item.target)
      expect(mcp.some((item) => item.includes("node server.js"))).toBe(true)
      expect(mcp.some((item) => item.includes("https://mcp.example/sse"))).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("projectFingerprint is order independent and changes with the resource set", () => {
    const a = [{ kind: "plugin" as const, target: "a.ts" }, { kind: "mcp" as const, target: "m1" }]
    const b = [{ kind: "mcp" as const, target: "m1" }, { kind: "plugin" as const, target: "a.ts" }]
    expect(projectFingerprint(a)).toBe(projectFingerprint(b))
    expect(projectFingerprint(a)).not.toBe(projectFingerprint([...a, { kind: "plugin", target: "b.ts" }]))
  })

  test("trust starts unknown, persists a decision, and a changed resource set re-arms it", async () => {
    const directory = projectWith({ plugins: ["one.ts"] })
    try {
      expect(getProjectTrust(directory).status).toBe("unknown")

      const trusted = await setProjectTrust(directory, "trusted")
      expect(trusted.status).toBe("trusted")
      expect(getProjectTrust(directory).status).toBe("trusted")
      expect(getProjectTrust(directory).changed).toBe(false)

      // A different process reads the same store file.
      writeFileSync(join(directory, ".opencode", "plugin", "two.ts"), "export const y = 2\n")
      const after = getProjectTrust(directory)
      expect(after.status).toBe("unknown")
      expect(after.changed).toBe(true)
      expect(after.fingerprint).not.toBe(trusted.fingerprint)

      expect((await setProjectTrust(directory, "untrusted")).status).toBe("untrusted")
      expect(getProjectTrust(directory).status).toBe("untrusted")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("isProjectOriginBlocked gates only project-controlled origins in untrusted workspaces", async () => {
    const directory = projectWith({ plugins: ["one.ts"] })
    try {
      const inside = join(directory, ".opencode")
      const outside = join(storeRoot, "elsewhere")
      expect(isProjectOriginBlocked({ directory, source: inside, scope: "local" })).toBe(true)
      expect(isProjectOriginBlocked({ directory, source: outside, scope: "local" })).toBe(false)
      expect(isProjectOriginBlocked({ directory, source: inside, scope: "global" })).toBe(false)
      expect(isProjectOriginBlocked({ directory, source: "OPENCODE_CONFIG_CONTENT", scope: "local" })).toBe(false)
      expect(isProjectOriginBlocked({ directory: undefined, source: inside, scope: "local" })).toBe(false)

      await setProjectTrust(directory, "trusted")
      expect(isProjectOriginBlocked({ directory, source: inside, scope: "local" })).toBe(false)
      await setProjectTrust(directory, "untrusted")
      expect(isProjectOriginBlocked({ directory, source: inside, scope: "local" })).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("a workspace without executable resources is never gated", () => {
    const directory = mkdtempSync(join(tmpdir(), "trust-empty-"))
    try {
      expect(scanProjectResources(directory)).toEqual([])
      expect(isProjectOriginBlocked({ directory, source: join(directory, ".opencode"), scope: "local" })).toBe(false)
      expect(getProjectTrust(directory).status).toBe("unknown")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("isInsideProject is path-boundary safe", () => {
    const base = join(tmpdir(), "trust-base")
    expect(isInsideProject(base, base)).toBe(true)
    expect(isInsideProject(base, join(base, "sub", "file.ts"))).toBe(true)
    expect(isInsideProject(base, join(tmpdir(), "trust-base-evil", "file.ts"))).toBe(false)
    expect(isInsideProject(base, "")).toBe(false)
    expect(normalizeProjectDir(base)).toBe(normalizeProjectDir(base))
  })
})

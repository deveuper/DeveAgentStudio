import { describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Layer } from "effect"
import { CodemodeLimits, CodemodeTool } from "../../src/tool/codemode"
import { TestInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { testEffect } from "../lib/effect"
import { Git } from "@/git"

const toolLayer = () =>
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    FSUtil.defaultLayer,
    Ripgrep.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    Git.defaultLayer,
  )

const it = testEffect(toolLayer())

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const write = (dir: string, name: string, content: string) =>
  Effect.promise(async () => {
    const file = path.join(dir, name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, content)
  })

describe("tool.codemode", () => {
  it.instance("orchestrates glob -> read -> grep -> list in one call", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* write(test.directory, "src/a.ts", "const needle = 42\nexport const answer = needle\n")
      yield* write(test.directory, "src/b.ts", "const needle = 41\nexport const other = needle\n")
      yield* write(test.directory, "README.md", "# demo\n")
      const info = yield* CodemodeTool
      const codemode = yield* info.init()
      const result = yield* codemode.execute(
        {
          code: `
const files = await glob("**/*");
const ts = files.filter((f) => f.endsWith(".ts"));
const content = await read(ts[0]);
const hits = await grep("needle");
const entries = await list("src");
console.log("helpers done");
return { total: files.length, tsCount: ts.length, hasNeedle: content.includes("needle"), grepHasA: hits.includes("a.ts"), entries };
`,
        },
        ctx,
      )
      expect(result.metadata.helperCalls).toBe(4)
      expect(result.output).toContain('"total":3')
      expect(result.output).toContain('"tsCount":2')
      expect(result.output).toContain('"hasNeedle":true')
      expect(result.output).toContain('"grepHasA":true')
      expect(result.output).toContain('"entries":["a.ts","b.ts"]')
      expect(result.output).toContain("--- console ---")
      expect(result.output).toContain("helpers done")
    }),
  )

  it.instance("rejects helper paths that escape the workspace", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const outside = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-codemode-outside-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
      )
      const secret = path.join(outside, "secret.txt")
      yield* Effect.promise(() => Bun.write(secret, "TOPSECRET-CONTENT"))
      const relativeEscape = path.relative(test.directory, secret).split(path.sep).join("/")
      const info = yield* CodemodeTool
      const codemode = yield* info.init()
      const result = yield* codemode.execute(
        {
          code: `
let viaRelative = "";
try { viaRelative = await read(${JSON.stringify(relativeEscape)}); } catch (e) { viaRelative = "rejected: " + e.message; }
let viaAbsolute = "";
try { viaAbsolute = await read(${JSON.stringify(secret)}); } catch (e) { viaAbsolute = "rejected: " + e.message; }
return { viaRelative, viaAbsolute };
`,
        },
        ctx,
      )
      expect(result.output).toContain('"viaRelative":"rejected: read: path')
      expect(result.output).toContain('"viaAbsolute":"rejected: read: path')
      expect(result.output).toContain("outside the workspace")
      expect(result.output).not.toContain("TOPSECRET-CONTENT")
    }),
  )

  it.instance("times out scripts whose async work outlives the budget", () =>
    Effect.gen(function* () {
      const previous = CodemodeLimits.timeoutMs
      CodemodeLimits.timeoutMs = 200
      try {
        const info = yield* CodemodeTool
        const codemode = yield* info.init()
        // A never-resolving helper wait is the deterministic timeout path: the
        // host-side race fires. A tight sync loop instead relies on the vm
        // watchdog, which Bun overshoots by seconds (see codemode.ts caveat).
        const result = yield* codemode.execute({ code: "await new Promise(() => {});" }, ctx)
        expect(result.metadata.error).toBe(true)
        expect(result.output).toContain("timed out after 200ms")
      } finally {
        CodemodeLimits.timeoutMs = previous
      }
    }),
  )

  it.instance("truncates oversized returned values", () =>
    Effect.gen(function* () {
      const info = yield* CodemodeTool
      const codemode = yield* info.init()
      const result = yield* codemode.execute({ code: 'return "x".repeat(40000);' }, ctx)
      expect(result.output).toContain("...[truncated]")
      expect(result.output.length).toBe(CodemodeLimits.outputChars + "...[truncated]".length)
    }),
  )

  it.instance("keeps process, require, and the host bridge out of the sandbox", () =>
    Effect.gen(function* () {
      const info = yield* CodemodeTool
      const codemode = yield* info.init()
      const result = yield* codemode.execute(
        {
          code: `
let requireCall = "callable";
try { require("fs"); } catch (e) { requireCall = "throws"; }
let constructorEscape = "escaped";
try { const F = [].constructor.constructor("return process"); constructorEscape = typeof F(); } catch (e) { constructorEscape = "throws"; }
return { proc: typeof process, requireGlobal: typeof require, requireCall, constructorEscape, host: typeof __host };
`,
        },
        ctx,
      )
      expect(result.output).toContain('"proc":"undefined"')
      expect(result.output).toContain('"requireGlobal":"undefined"')
      expect(result.output).toContain('"requireCall":"throws"')
      // The constructor-chain escape attempt throws inside the sandbox realm
      // ("process is not defined") instead of reaching host globals.
      expect(result.output).toContain('"constructorEscape":"throws"')
      expect(result.output).toContain('"host":"undefined"')
    }),
  )

  it.instance("reports syntax errors as error output", () =>
    Effect.gen(function* () {
      const info = yield* CodemodeTool
      const codemode = yield* info.init()
      const result = yield* codemode.execute({ code: "return (" }, ctx)
      expect(result.metadata.error).toBe(true)
      expect(result.output).toContain("Error:")
    }),
  )
})

import path from "path"
import { Effect, Schema } from "effect"
import vm from "node:vm"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { containsPath, type InstanceContext } from "../project/instance-context"
import DESCRIPTION from "./codemode.txt"
import * as Tool from "./tool"

// Mutable so tests can shrink the timeout without a second execute path.
// Everything in here is a hard budget: intermediate helper results stay in the
// sandbox, so the caps exist to stop one giant helper result from eating the
// final 16k output budget.
export const CodemodeLimits = {
  timeoutMs: 30_000,
  outputChars: 16_000,
  consoleChars: 2_000,
  readChars: 10_000,
  grepChars: 8_000,
  grepLimit: 100,
  globLimit: 200,
  listLimit: 1_000,
}

export const Parameters = Schema.Struct({
  code: Schema.String.annotate({
    description:
      "Body of an async function. Await the injected read-only helpers glob/grep/read/list and return a JSON-serializable summary.",
  }),
})

type Metadata = {
  helperCalls: number
  consoleChars: number
  error?: boolean
}

// Everything the sandbox can do crosses this bridge as strings. The host side
// resolves to a JSON envelope string and the sandbox side parses it with its own
// realm's JSON, so no host-realm objects (arrays, Errors, promises held by user
// code) ever become reachable - otherwise `value.constructor.constructor` would
// hand user code the host Function constructor and break the sandbox.
const SANDBOX_SETUP = `(function (__host) {
  var __call = function (op, args) {
    return Promise.resolve(__host(op, args)).then(function (json) {
      var parsed = JSON.parse(json)
      if (parsed.ok) return parsed.value
      throw new Error(parsed.error)
    })
  }
  var __emit = function () { __host("console", Array.prototype.slice.call(arguments)) }
  globalThis.console = { log: __emit, info: __emit, warn: __emit, error: __emit }
  globalThis.glob = function (pattern) { return __call("glob", [pattern]) }
  globalThis.grep = function (pattern, searchPath) { return __call("grep", [pattern, searchPath]) }
  globalThis.read = function (filePath) { return __call("read", [filePath]) }
  globalThis.list = function (dirPath) { return __call("list", [dirPath]) }
})(__host);
globalThis.__host = undefined;`

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

// Same containment pattern the read/glob tools enforce through
// assertExternalDirectoryEffect, minus the permission ask: codemode is a single
// read-only tool that inherits the session's default tool permission, and a
// helper-level escape is rejected outright instead of prompting.
// ponytail: lexical check only (plus win32 realpath normalization), matching the
// read tool's strictness; a symlink planted inside the workspace pointing out is
// not chased here in v1.
function resolveInsideWorkspace(input: string | undefined, ins: InstanceContext): string {
  const raw = input && input.trim().length > 0 ? input : "."
  const joined = path.isAbsolute(raw) ? raw : path.resolve(ins.directory, raw)
  const full = process.platform === "win32" ? FSUtil.normalizePath(joined) : path.resolve(joined)
  if (!containsPath(full, ins)) {
    throw new Error(
      `path "${input}" resolves outside the workspace (${ins.directory}); codemode helpers are restricted to the workspace`,
    )
  }
  return full
}

export const CodemodeTool = Tool.define<typeof Parameters, Metadata, FSUtil.Service | Ripgrep.Service>(
  "codemode",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    const limits = CodemodeLimits

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const toRelative = (absolute: string): string => {
            const rel = path.relative(ins.directory, absolute)
            return rel === "" ? "." : rel.split(path.sep).join("/")
          }

          let consoleUsed = 0
          const consoleLines: string[] = []
          const pushConsole = (args: unknown[]) => {
            if (consoleUsed >= limits.consoleChars) return
            const line = args
              .map((value) => {
                if (typeof value === "string") return value
                try {
                  return JSON.stringify(value) ?? String(value)
                } catch {
                  return String(value)
                }
              })
              .join(" ")
            const taken =
              line.length > limits.consoleChars - consoleUsed ? line.slice(0, limits.consoleChars - consoleUsed) : line
            consoleLines.push(taken)
            consoleUsed += taken.length
          }
          const withConsole = (text: string) => {
            const consoleText = consoleLines.join("\n")
            return consoleText ? `${text}\n\n--- console ---\n${consoleText}` : text
          }

          let helperCalls = 0
          const fail = (message: string): Tool.ExecuteResult<Metadata> => ({
            title: "codemode",
            metadata: { helperCalls, consoleChars: consoleUsed, error: true },
            output: withConsole(`Error: ${message}`),
          })

          const globImpl = async (pattern: string): Promise<string[]> => {
            helperCalls++
            const entries = await Effect.runPromise(
              ripgrep.glob({ cwd: ins.directory, pattern, limit: limits.globLimit, signal: ctx.abort }),
            )
            return entries
              .map((entry) => path.resolve(ins.directory, entry.path))
              .filter((absolute) =>
                containsPath(process.platform === "win32" ? FSUtil.normalizePath(absolute) : absolute, ins),
              )
              .map(toRelative)
          }

          const grepImpl = async (pattern: string, searchPath?: string): Promise<string> => {
            helperCalls++
            if (!pattern) throw new Error("pattern is required")
            const target = resolveInsideWorkspace(searchPath, ins)
            const info = await Effect.runPromise(
              fs.stat(target).pipe(Effect.catch(() => Effect.succeed(undefined))),
            )
            const isDirectory = info?.type === "Directory"
            const cwd = isDirectory ? target : path.dirname(target)
            const matches = await Effect.runPromise(
              ripgrep.grep({
                cwd,
                pattern,
                file: isDirectory ? undefined : target,
                limit: limits.grepLimit,
                signal: ctx.abort,
              }),
            )
            const rows = matches.map(
              (match) => `${toRelative(path.resolve(cwd, match.entry.path))}:${match.line}: ${match.text.trimEnd()}`,
            )
            if (rows.length === 0) return "No matches"
            let text = rows.join("\n")
            if (text.length > limits.grepChars) {
              text = text.slice(0, limits.grepChars) + `\n...[grep results truncated at ${limits.grepChars} chars]`
            }
            return text
          }

          const readImpl = async (input: string): Promise<string> => {
            helperCalls++
            const full = resolveInsideWorkspace(input, ins)
            const text = await Effect.runPromise(fs.readFileStringSafe(full))
            if (text === undefined) throw new Error(`file not found: ${toRelative(full)}`)
            // ponytail: v1 reads any file as text with a size cap; it does not
            // replicate the read tool's binary sniffing or PDF/image attachment handling.
            if (text.length > limits.readChars) {
              return text.slice(0, limits.readChars) + `\n...[file truncated at ${limits.readChars} chars]`
            }
            return text
          }

          const listImpl = async (input?: string): Promise<string[]> => {
            helperCalls++
            const full = resolveInsideWorkspace(input, ins)
            const entries = await Effect.runPromise(fs.readDirectoryEntries(full))
            return entries
              .slice(0, limits.listLimit)
              .map((entry) => (entry.type === "directory" ? entry.name + "/" : entry.name))
          }

          const bridge = (op: string, args: unknown[]): Promise<string> => {
            const envelope = (result: { ok: true; value: unknown } | { ok: false; error: string }) =>
              JSON.stringify(result)
            const failure = (op: string, cause: unknown) =>
              Promise.resolve(envelope({ ok: false, error: `${op}: ${errorMessage(cause) || "failed"}` }))
            try {
              switch (op) {
                case "console":
                  pushConsole(args)
                  return Promise.resolve("")
                case "glob":
                  return globImpl(String(args[0])).then(
                    (value) => envelope({ ok: true, value }),
                    (cause) => failure(op, cause),
                  )
                case "grep":
                  return grepImpl(String(args[0]), args[1] === undefined ? undefined : String(args[1])).then(
                    (value) => envelope({ ok: true, value }),
                    (cause) => failure(op, cause),
                  )
                case "read":
                  return readImpl(String(args[0])).then(
                    (value) => envelope({ ok: true, value }),
                    (cause) => failure(op, cause),
                  )
                case "list":
                  return listImpl(args[0] === undefined ? undefined : String(args[0])).then(
                    (value) => envelope({ ok: true, value }),
                    (cause) => failure(op, cause),
                  )
                default:
                  return Promise.resolve(envelope({ ok: false, error: `unknown helper "${op}"` }))
              }
            } catch (cause) {
              return failure(op, cause)
            }
          }

          const sandbox = { __host: bridge }
          const context = vm.createContext(sandbox)
          new vm.Script(SANDBOX_SETUP).runInContext(context)

          // ponytail: vm.Script rejects a top-level `return`, so the requested
          // `return await (async () => { ... })()` wrapper shape is realized as
          // the equivalent IIFE expression; awaiting the sandbox promise from the
          // host works because `await` assimilates the foreign thenable.
          let pending: Promise<unknown>
          try {
            const script = new vm.Script(`(async () => {\n${params.code}\n})()`, {
              filename: "codemode-user-code.js",
            })
            pending = script.runInContext(context, { timeout: limits.timeoutMs }) as Promise<unknown>
          } catch (cause) {
            return fail(errorMessage(cause))
          }

          // Hard wall-clock budget. The vm timeout option only covers the
          // synchronous prefix of the script (node:vm cannot interrupt a running
          // script), and the race covers host-side waits after that.
          // ponytail: known limitations - (1) a synchronous infinite loop that
          // starts after the first `await` blocks the shared event loop, so
          // neither the vm watchdog nor this timer can fire; (2) on Bun/JSC the
          // watchdog lands late for tight loops before the first `await`
          // (measured ~8s of overshoot for a `while (true) {}` with a 200ms
          // budget) because it only engages after the loop tiers up. Fully
          // killing such loops needs a subprocess sandbox (worker.terminate()
          // is the upgrade path — an eval Worker hosting this same vm realm was
          // prototyped but Bun 1.3 eval workers self-exit mid-helper-call);
          // v1 accepts the hang risk for read-only helpers.
          let timer: ReturnType<typeof setTimeout> | undefined
          let rejectRace: (cause: Error) => void = () => undefined
          const raced = new Promise<never>((_, reject) => {
            rejectRace = reject
            timer = setTimeout(
              () => reject(new Error(`codemode script timed out after ${limits.timeoutMs}ms`)),
              limits.timeoutMs,
            )
          })
          const onAbort = () => rejectRace(new Error("codemode script aborted"))
          ctx.abort.addEventListener("abort", onAbort, { once: true })

          const outcome = yield* Effect.promise(() =>
            Promise.race([Promise.resolve(pending), raced]).then(
              (value) => ({ ok: true as const, value }),
              (cause) => ({ ok: false as const, error: errorMessage(cause) }),
            ),
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (timer) clearTimeout(timer)
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          )

          if (!outcome.ok) return fail(outcome.error)

          let serialized: string
          try {
            serialized = JSON.stringify(outcome.value) ?? String(outcome.value)
          } catch {
            serialized = String(outcome.value)
          }
          if (serialized.length > limits.outputChars) {
            serialized = serialized.slice(0, limits.outputChars) + "...[truncated]"
          }

          return {
            title: "codemode",
            metadata: { helperCalls, consoleChars: consoleUsed },
            output: withConsole(serialized),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

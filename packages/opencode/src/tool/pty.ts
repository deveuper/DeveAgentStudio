import { Effect, Schema } from "effect"
import path from "path"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION_PTY from "./pty.txt"
import DESCRIPTION_PTY_WRITE from "./pty-write.txt"
import * as Tool from "./tool"

// ponytail: interactive PTY execution (Codex unified_exec parity, trimmed to
// what a desktop product needs). A `pty` tool starts a command inside a real
// pseudo-terminal and either returns its completed output or a session id the
// model can later feed input to and poll via `pty_write`. Output is kept in a
// head+tail buffer so unbounded programs (build logs, REPL banners) can never
// exhaust memory while the model still sees the beginning and the end.

// Yield clamp mirrors Codex: 250ms..30s, with a 10s floor on Windows where
// ConPTY output arrives late (a short yield would return an empty first read).
const MIN_YIELD_MS = 250
const MAX_YIELD_MS = 30_000
const WINDOWS_YIELD_FLOOR_MS = 10_000
const DEFAULT_YIELD_MS = 10_000
const DEFAULT_WRITE_YIELD_MS = 1_000
const APPROX_BYTES_PER_TOKEN = 4

// Head+tail budget per session (Codex uses 512 KiB per side for 1 MiB total;
// a desktop product with a 16-session cap keeps half of that).
const HEAD_BUDGET_BYTES = 256 * 1024
const TAIL_BUDGET_BYTES = 256 * 1024

// Soft session cap; LRU eviction prefers exited sessions and protects the
// most recently used ones.
const MAX_SESSIONS = 16
const PROTECTED_SESSIONS = 4

export const clampYieldFor = (ms: number, platform: string) => {
  const floor = platform === "win32" ? Math.max(MIN_YIELD_MS, WINDOWS_YIELD_FLOOR_MS) : MIN_YIELD_MS
  return Math.min(Math.max(ms, floor), MAX_YIELD_MS)
}
const clampYield = (ms: number) => clampYieldFor(ms, process.platform)

// ponytail: even with TERM=dumb, ConPTY still emits control sequences
// (cursor hide/show, clear, mode set). Strip them when draining so the model
// sees plain text, not escape garbage.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[=>]|\r/g

export class HeadTailBuffer {
  constructor(private headBudget = HEAD_BUDGET_BYTES, private tailBudget = TAIL_BUDGET_BYTES) {}
  private head: Buffer = Buffer.alloc(0)
  private tail: Buffer = Buffer.alloc(0)
  private omitted = 0

  push(chunk: Buffer) {
    // Head fills first; once full, new bytes append to the tail ring and the
    // bytes that no longer fit are counted and dropped.
    if (this.head.length < this.headBudget) {
      const take = Math.min(chunk.length, this.headBudget - this.head.length)
      this.head = Buffer.concat([this.head, chunk.subarray(0, take)])
      chunk = chunk.subarray(take)
    }
    if (chunk.length === 0) return
    const combined = Buffer.concat([this.tail, chunk])
    if (combined.length > this.tailBudget) {
      this.omitted += combined.length - this.tailBudget
      this.tail = combined.subarray(combined.length - this.tailBudget)
    } else {
      this.tail = combined
    }
  }

  /** Total bytes seen so far (head + tail + dropped middle). */
  get size() {
    return this.head.length + this.tail.length + this.omitted
  }

  /** Drain head + omission marker + tail as text. */
  take(): string {
    const head = this.head
    const tail = this.tail
    const omitted = this.omitted
    this.head = Buffer.alloc(0)
    this.tail = Buffer.alloc(0)
    this.omitted = 0
    const parts = [head]
    if (omitted > 0) parts.push(Buffer.from(`\n... ${omitted} bytes omitted ...\n`))
    parts.push(tail)
    return Buffer.concat(parts).toString("utf8").replace(ANSI_PATTERN, "")
  }
}

interface PtySession {
  id: string
  pid: number
  startedAt: number
  lastUsed: number
  buffer: HeadTailBuffer
  exited: boolean
  exitCode: number | null
  write: (data: string) => void
  dispose: () => void
}

const sessions = new Map<string, PtySession>()

let sessionCounter = 0
const newSessionID = () => `pty_${Date.now().toString(36)}_${(sessionCounter += 1).toString(36)}`

function disposeSession(session: PtySession) {
  try {
    session.dispose()
  } catch {}
}

function evictIfNeeded() {
  if (sessions.size < MAX_SESSIONS) return
  const entries = [...sessions.values()].sort((a, b) => b.lastUsed - a.lastUsed)
  // Prefer already-exited sessions, then LRU beyond the protected head.
  const victim = entries.filter((s) => s.exited).slice(PROTECTED_SESSIONS)[0] ?? entries.slice(PROTECTED_SESSIONS).at(-1)
  if (victim && !victim.exited) {
    // Evicting a live session: kill it so the process does not leak.
    disposeSession(victim)
  }
  if (victim) sessions.delete(victim.id)
}

function pruneExited() {
  for (const [id, session] of sessions) {
    if (session.exited && Date.now() - session.lastUsed > 60_000) {
      sessions.delete(id)
      disposeSession(session)
    }
  }
}

async function loadNodePty(): Promise<typeof import("@lydell/node-pty")> {
  try {
    return await import("@lydell/node-pty")
  } catch (cause) {
    throw new Error(
      `node-pty native module is unavailable in this build: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
}

function resolveShellCommand(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    const userShell = process.env.SHELL
    if (userShell && userShell.toLowerCase().includes("bash")) {
      return { file: userShell, args: ["-lc", command] }
    }
    const comspec = process.env.COMSPEC || "cmd.exe"
    return { file: comspec, args: ["/d", "/s", "/c", command] }
  }
  const shell = process.env.SHELL || "/bin/bash"
  return { file: shell, args: ["-lc", command] }
}

const PTY_ENV = () => ({
  ...process.env,
  // Codex parity: force plain, page-free output so control sequences and
  // pagers never flood the buffer with noise the model cannot use.
  NO_COLOR: "1",
  TERM: "dumb",
  COLORTERM: "",
  PAGER: "cat",
  GIT_PAGER: "cat",
  GH_PAGER: "cat",
  DEVEAGENT_PTY: "1",
})

async function spawnSession(command: string, workdir: string): Promise<PtySession> {
  const pty = await loadNodePty()
  const { file, args } = resolveShellCommand(command)
  const buffer = new HeadTailBuffer()
  const term = pty.spawn(file, args, {
    name: "dumb",
    cols: 120,
    rows: 30,
    cwd: workdir,
    env: PTY_ENV() as Record<string, string>,
  })
  const session: PtySession = {
    id: "",
    pid: term.pid,
    startedAt: Date.now(),
    lastUsed: Date.now(),
    buffer,
    exited: false,
    exitCode: null,
    write: (data) => term.write(data),
    dispose: () => {
      try {
        term.kill()
      } catch {}
    },
  }
  term.onData((data) => buffer.push(Buffer.from(data, "utf8")))
  term.onExit(({ exitCode: code }) => {
    session.exited = true
    session.exitCode = code
  })
  session.id = newSessionID()
  evictIfNeeded()
  sessions.set(session.id, session)
  return session
}

const header = (wallTimeSec: number, status: string) =>
  [`Wall time: ${wallTimeSec.toFixed(2)} seconds`, status, "Output:"].join("\n") + "\n"

const sleep = (ms: number) => Effect.sleep(`${ms} millis`)

export const PtyParameters = Schema.Struct({
  command: Schema.String.annotate({ description: "The command to run inside a PTY (interactive programs allowed)" }),
  workdir: Schema.optional(Schema.String).annotate({
    description: "Working directory for the command. Defaults to the current working directory.",
  }),
  yield_ms: Schema.optional(Schema.Number).annotate({
    description: `How long to wait for the command to finish before returning (default ${DEFAULT_YIELD_MS}). If it is still running, the output so far is returned together with a session id for pty_write.`,
  }),
})

export const PtyTool = Tool.define(
  "pty",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION_PTY,
      parameters: PtyParameters,
      execute: (params: { command: string; workdir?: string; yield_ms?: number }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const workdir = params.workdir
            ? (path.isAbsolute(params.workdir) ? params.workdir : path.resolve(ins.directory, params.workdir))
            : ins.directory
          yield* assertExternalDirectoryEffect(ctx, workdir, { bypass: false, kind: "directory" })
          yield* ctx.ask({
            permission: "bash",
            patterns: ["*"],
            always: ["*"],
            metadata: { command: params.command, description: "pty session" },
          })

          pruneExited()
          const session = yield* Effect.promise(() => spawnSession(params.command, workdir))
          // Poll instead of a single sleep: the Windows 10s yield floor exists
          // because ConPTY output arrives late for STILL-RUNNING processes,
          // but a process that already exited can return immediately —
          // waiting the full floor made trivial commands report 10s wall
          // time. Give trailing output a short settle window after exit.
          const deadline = Date.now() + clampYield(params.yield_ms ?? DEFAULT_YIELD_MS)
          while (!session.exited && Date.now() < deadline) {
            yield* sleep(Math.min(250, Math.max(1, deadline - Date.now())))
          }
          if (session.exited) yield* sleep(300)
          const wallTime = (Date.now() - session.startedAt) / 1000
          const tokens = Math.ceil(session.buffer.size / APPROX_BYTES_PER_TOKEN)
          const output = session.buffer.take()
          const meta: { exited: boolean; exitCode?: number; sessionID?: string; pid?: number } = session.exited
            ? { exited: true, exitCode: session.exitCode ?? 0 }
            : { exited: false, sessionID: session.id, pid: session.pid }
          const status = meta.exited
            ? `Process exited with code ${meta.exitCode}`
            : `Process running with session ID ${meta.sessionID} (original token count: ${tokens})`
          return {
            title: params.command.slice(0, 80),
            metadata: meta,
            output: header(wallTime, status) + (output || "(no output)"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const PtyWriteParameters = Schema.Struct({
  session_id: Schema.String.annotate({ description: "Session id returned by the pty tool" }),
  chars: Schema.optional(Schema.String).annotate({
    description: 'Text to write to the session. Omit or pass "" to only poll for new output. Use "\\u0003" for Ctrl+C.',
  }),
  yield_ms: Schema.optional(Schema.Number).annotate({
    description: `How long to wait for new output after writing (default ${DEFAULT_WRITE_YIELD_MS}).`,
  }),
})

export const PtyWriteTool = Tool.define(
  "pty_write",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION_PTY_WRITE,
      parameters: PtyWriteParameters,
      execute: (params: { session_id: string; chars?: string; yield_ms?: number }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const session = sessions.get(params.session_id)
          if (!session) {
            throw new Error(`Unknown or finished pty session: ${params.session_id}. Start a new session with the pty tool.`)
          }
          session.lastUsed = Date.now()
          const chars = params.chars ?? ""
          if (chars.length > 0) {
            if (chars.includes("\0")) {
              throw new Error("pty_write input contains a NUL byte and cannot be written safely")
            }
            // Codex parity: typing into a live terminal is its own reviewable
            // action — without this gate a model could answer password/sudo/y-N
            // prompts in an elevated shell with no permission check. Reading
            // (poll-only writes) stays ungated.
            yield* ctx.ask({
              permission: "pty_write",
              patterns: ["*"],
              always: ["*"],
              metadata: { sessionID: session.id, pid: session.pid, chars: chars.slice(0, 200) },
            })
            session.write(chars)
          }
          yield* sleep(Math.min(Math.max(params.yield_ms ?? DEFAULT_WRITE_YIELD_MS, MIN_YIELD_MS), MAX_YIELD_MS))
          const wallTime = (Date.now() - session.lastUsed) / 1000
          const output = session.buffer.take()
          const meta: { exited: boolean; exitCode?: number; sessionID?: string } = session.exited
            ? { exited: true, exitCode: session.exitCode ?? 0 }
            : { exited: false, sessionID: session.id }
          if (session.exited) sessions.delete(session.id)
          const status = meta.exited
            ? `Process exited with code ${meta.exitCode}`
            : `Process running with session ID ${meta.sessionID}`
          return {
            title: `pty_write ${params.session_id}`,
            metadata: meta,
            output: header(wallTime, status) + (output || "(no output)"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

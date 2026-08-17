import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { BackgroundJob as CoreBackgroundJob } from "@opencode-ai/core/background-job"
import { InstanceState } from "@/effect/instance-state"
import { Effect, Layer } from "effect"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

export {
  Service,
  type ExtendInput,
  type Info,
  type Interface,
  type StartInput,
  type Status,
  type WaitInput,
  type WaitResult,
} from "@opencode-ai/core/background-job"

const MAX_PERSISTED_JOBS = 128
const MAX_PERSISTED_TEXT = 8_000
const RESTART_INTERRUPTED_ERROR = "Background job was interrupted when OpenCode restarted."

type PersistedState = {
  live: CoreBackgroundJob.Interface
  file: string
  jobs: Map<string, CoreBackgroundJob.Info>
  write: Promise<void>
}

function storePath(directory: string) {
  return path.join(directory, ".deveagent", "background-jobs.json")
}

function cloneMetadata(metadata: Record<string, unknown> | undefined) {
  if (!metadata) return undefined
  try {
    return JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function snapshot(info: CoreBackgroundJob.Info): CoreBackgroundJob.Info {
  return {
    ...info,
    ...(info.output ? { output: info.output.slice(0, MAX_PERSISTED_TEXT) } : {}),
    ...(info.error ? { error: info.error.slice(0, MAX_PERSISTED_TEXT) } : {}),
    ...(info.metadata ? { metadata: cloneMetadata(info.metadata) } : {}),
  }
}

function normalizePersisted(value: unknown): CoreBackgroundJob.Info | undefined {
  if (!value || typeof value !== "object") return
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== "string" || !raw.id || typeof raw.type !== "string") return
  if (raw.status !== "running" && raw.status !== "completed" && raw.status !== "error" && raw.status !== "cancelled") return
  if (typeof raw.started_at !== "number" || !Number.isFinite(raw.started_at)) return
  const info: CoreBackgroundJob.Info = {
    id: raw.id.slice(0, 200),
    type: raw.type.slice(0, 120),
    ...(typeof raw.title === "string" ? { title: raw.title.slice(0, 500) } : {}),
    status: raw.status,
    started_at: raw.started_at,
    ...(typeof raw.completed_at === "number" ? { completed_at: raw.completed_at } : {}),
    ...(typeof raw.output === "string" ? { output: raw.output.slice(0, MAX_PERSISTED_TEXT) } : {}),
    ...(typeof raw.error === "string" ? { error: raw.error.slice(0, MAX_PERSISTED_TEXT) } : {}),
    ...(raw.metadata && typeof raw.metadata === "object" ? { metadata: cloneMetadata(raw.metadata as Record<string, unknown>) } : {}),
  }
  if (info.status !== "running") return info
  // The Effect itself cannot survive a process restart. Keep the evidence, but
  // never expose a stale running job as if it were still executing.
  return {
    ...info,
    status: "error",
    completed_at: Date.now(),
    error: RESTART_INTERRUPTED_ERROR,
    metadata: { ...info.metadata, deveagentRestartState: "interrupted" },
  }
}

async function readStore(file: string) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { jobs?: unknown }
    const jobs = new Map<string, CoreBackgroundJob.Info>()
    for (const item of Array.isArray(parsed.jobs) ? parsed.jobs.slice(-MAX_PERSISTED_JOBS) : []) {
      const info = normalizePersisted(item)
      if (info) jobs.set(info.id, info)
    }
    return jobs
  } catch {
    return new Map<string, CoreBackgroundJob.Info>()
  }
}

function remember(state: PersistedState, info: CoreBackgroundJob.Info) {
  state.jobs.set(info.id, snapshot(info))
  while (state.jobs.size > MAX_PERSISTED_JOBS) {
    const oldest = state.jobs.keys().next().value
    if (typeof oldest !== "string") break
    state.jobs.delete(oldest)
  }
}

function persist(state: PersistedState) {
  const payload = JSON.stringify({ version: 1, jobs: [...state.jobs.values()] })
  const temp = `${state.file}.${process.pid}.${Date.now()}.tmp`
  state.write = state.write
    .catch(() => undefined)
    .then(async () => {
      await mkdir(path.dirname(state.file), { recursive: true })
      await writeFile(temp, payload, "utf8")
      await rename(temp, state.file)
    })
  return Effect.promise(() => state.write)
}

/**
 * Keeps the native process-local runner, while persisting bounded snapshots.
 * A restart can report what happened and why it stopped; it cannot resume an
 * Effect closure that no longer exists. Team replay still owns explicit work
 * reconstruction and permission checks.
 */
export const layer = Layer.effect(
  CoreBackgroundJob.Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make((ctx) =>
      Effect.gen(function* () {
        const live = yield* CoreBackgroundJob.make
        const file = storePath(ctx.directory)
        const jobs = yield* Effect.promise(() => readStore(file))
        return { live, file, jobs, write: Promise.resolve() } satisfies PersistedState
      }),
    )
    return CoreBackgroundJob.Service.of({
      list: () => InstanceState.useEffect(state, (current) =>
        Effect.gen(function* () {
          const live = yield* current.live.list()
          for (const info of live) remember(current, info)
          if (live.length) yield* persist(current)
          const liveIDs = new Set(live.map((info) => info.id))
          return [...live, ...[...current.jobs.values()].filter((info) => !liveIDs.has(info.id))]
            .toSorted((a, b) => a.started_at - b.started_at)
        }),
      ),
      get: (id) => InstanceState.useEffect(state, (current) =>
        Effect.gen(function* () {
          const live = yield* current.live.get(id)
          if (live) {
            remember(current, live)
            yield* persist(current)
            return live
          }
          return current.jobs.get(id)
        }),
      ),
      start: (input) => InstanceState.useEffect(state, (current) =>
        Effect.gen(function* () {
          const info = yield* current.live.start(input)
          remember(current, info)
          yield* persist(current)
          return info
        }),
      ),
      extend: (input) => InstanceState.useEffect(state, (current) => current.live.extend(input)),
      wait: (input) => InstanceState.useEffect(state, (current) =>
        Effect.gen(function* () {
          const live = yield* current.live.get(input.id)
          if (!live) {
            const persisted = current.jobs.get(input.id)
            return persisted ? { info: persisted, timedOut: false } : { timedOut: false }
          }
          const result = yield* current.live.wait(input)
          if (result.info) {
            remember(current, result.info)
            yield* persist(current)
          }
          return result
        }),
      ),
      waitForPromotion: (id) => InstanceState.useEffect(state, (current) => current.live.waitForPromotion(id)),
      promote: (id) => InstanceState.useEffect(state, (current) =>
        Effect.gen(function* () {
          const info = yield* current.live.promote(id)
          if (info) {
            remember(current, info)
            yield* persist(current)
          }
          return info
        }),
      ),
      cancel: (id) => InstanceState.useEffect(state, (current) =>
        Effect.gen(function* () {
          const info = yield* current.live.cancel(id)
          if (info) {
            remember(current, info)
            yield* persist(current)
          }
          return info
        }),
      ),
    })
  }),
)

export const defaultLayer = layer

export const node = LayerNode.make(layer, [])

export * as BackgroundJob from "./job"

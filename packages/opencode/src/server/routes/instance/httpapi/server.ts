import { Config as EffectConfig, Context, Effect, Layer } from "effect"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import { HttpClient, HttpMiddleware, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { lstat, realpath } from "node:fs/promises"
import path from "node:path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Observability from "@opencode-ai/core/observability"
import { Flag } from "@opencode-ai/core/flag/flag"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Account } from "@/account/account"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { BackgroundJob } from "@/background/job"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { Workspace } from "@/control-plane/workspace"
import { WorkspaceAdapterRuntime } from "@/control-plane/workspace-adapter-runtime"
import { Env } from "@/env"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { Git } from "@/git"
import { Installation } from "@/installation"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { PluginPtyEnvironment } from "@/plugin/pty-environment"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import type { InstanceContext } from "@/project/instance-context"
import { Project } from "@/project/project"
import { Vcs } from "@/project/vcs"
import { ProviderAuth } from "@/provider/auth"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { SessionCompaction } from "@/session/compaction"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { SessionShare } from "@/share/session"
import { ShareNext } from "@/share/share-next"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import type { TaskPromptOps } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import { Worktree } from "@/worktree"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EffectBridge } from "@/effect/bridge"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/layer-node-platform"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { ModelV2 } from "@opencode-ai/core/model"
import { Npm } from "@opencode-ai/core/npm"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectCopy } from "@opencode-ai/core/project/copy"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { PtyTicket } from "@opencode-ai/core/pty/ticket"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { lazy } from "@/util/lazy"
import { CorsConfig, isAllowedCorsOrigin, type CorsOptions } from "@opencode-ai/server/cors"
import { serveUIEffect } from "@/server/shared/ui"
import { ServerAuth } from "@/server/auth"
import { InstanceHttpApi, RootHttpApi } from "./api"
import { Api } from "@opencode-ai/server/api"
import { PublicApi } from "./public"
import {
  authorizationLayer,
  authorizationRouterMiddleware,
  ptyConnectAuthorizationLayer,
  serverAuthorizationLayer,
} from "./middleware/authorization"
import { EventApi } from "./groups/event"
import { PtyConnectApi } from "./groups/pty"
import { eventHandlers } from "./handlers/event"
import { configHandlers } from "./handlers/config"
import { controlHandlers } from "./handlers/control"
import { controlPlaneHandlers } from "./handlers/control-plane"
import { experimentalHandlers } from "./handlers/experimental"
import { fileHandlers } from "./handlers/file"
import { globalHandlers } from "./handlers/global"
import { instanceHandlers } from "./handlers/instance"
import { mcpHandlers } from "./handlers/mcp"
import { permissionHandlers } from "./handlers/permission"
import { projectHandlers } from "./handlers/project"
import { projectCopyHandlers } from "./handlers/project-copy"
import { providerHandlers } from "./handlers/provider"
import { ptyConnectHandlers, ptyHandlers } from "./handlers/pty"
import { questionHandlers } from "./handlers/question"
import { sessionHandlers } from "./handlers/session"
import { syncHandlers } from "./handlers/sync"
import { tuiHandlers } from "./handlers/tui"
import { handlers } from "@opencode-ai/server/handlers"
import { schemaErrorLayer as v2SchemaErrorLayer } from "@opencode-ai/server/middleware/schema-error"
import { workspaceHandlers } from "./handlers/workspace"
import { instanceContextLayer } from "./middleware/instance-context"
import { workspaceRoutingLayer } from "./middleware/workspace-routing"
import { disposeMiddleware } from "./lifecycle"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { compressionLayer } from "./middleware/compression"
import { corsVaryFix } from "./middleware/cors-vary"
import { errorLayer } from "./middleware/error"
import { fenceLayer } from "./middleware/fence"
import { schemaErrorLayer } from "./middleware/schema-error"

export const context = Context.makeUnsafe<unknown>(new Map())

const cors = (corsOptions?: CorsOptions) =>
  HttpRouter.middleware(
    HttpMiddleware.cors({
      allowedOrigins: (origin) => isAllowedCorsOrigin(origin, corsOptions),
      maxAge: 86_400,
    }),
    { global: true },
  )

// Route tree:
// - rootApiRoutes: typed /global/* and control routes; auth is declared by RootHttpApi.
// - eventApiRoutes: typed SSE route with instance routing context and its existing API contract.
// - ptyConnectApiRoutes: typed WebSocket upgrade route with ticket-aware auth.
// - instanceApiRoutes: remaining typed instance routes.
// - uiRoute: raw catch-all fallback; auth is router middleware so public static assets can bypass it.
const authOnlyRouterLayer = authorizationRouterMiddleware.layer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const httpApiAuthLayer = authorizationLayer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const ptyConnectHttpApiAuthLayer = ptyConnectAuthorizationLayer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const serverHttpApiAuthLayer = serverAuthorizationLayer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const workspaceRoutingLive = workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal))
const rootApiRoutes = HttpApiBuilder.layer(RootHttpApi).pipe(
  Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
  Layer.provide(schemaErrorLayer),
  Layer.provide(httpApiAuthLayer),
)
const eventApiRoutes = HttpApiBuilder.layer(EventApi).pipe(
  Layer.provide(eventHandlers),
  Layer.provide([httpApiAuthLayer, workspaceRoutingLive, instanceContextLayer]),
)
const ptyConnectApiRoutes = HttpApiBuilder.layer(PtyConnectApi).pipe(
  Layer.provide(ptyConnectHandlers),
  Layer.provide([ptyConnectHttpApiAuthLayer, workspaceRoutingLive, instanceContextLayer]),
)
const instanceApiRoutes = HttpApiBuilder.layer(InstanceHttpApi).pipe(
  Layer.provide([
    configHandlers,
    experimentalHandlers,
    fileHandlers,
    instanceHandlers,
    mcpHandlers,
    projectHandlers,
    projectCopyHandlers,
    ptyHandlers,
    questionHandlers,
    permissionHandlers,
    providerHandlers,
    sessionHandlers,
    syncHandlers,
    tuiHandlers,
    workspaceHandlers,
  ]),
)

const instanceRoutes = instanceApiRoutes.pipe(
  Layer.provide([httpApiAuthLayer, workspaceRoutingLive, instanceContextLayer, schemaErrorLayer]),
)
const serverRoutes = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(handlers),
  Layer.provide(PluginPtyEnvironment.layer),
  Layer.provide([serverHttpApiAuthLayer, v2SchemaErrorLayer]),
)

// `OpenApi.fromApi` is non-trivial; defer until /doc is actually hit so
// processes that never serve it (CLI, scripts) don't pay at module load.
// `HttpServerResponse.jsonUnsafe` runs JSON.stringify eagerly, so caching
// the response also caches the serialized body — every /doc request reuses
// the same Uint8Array instead of re-stringifying the spec.
const docResponse = lazy(() => HttpServerResponse.jsonUnsafe(OpenApi.fromApi(PublicApi)))

const docRoute = HttpRouter.use((router) => router.add("GET", "/doc", () => Effect.succeed(docResponse()))).pipe(
  Layer.provide(authOnlyRouterLayer),
)

class DeveAgentBoundaryError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403,
  ) {
    super(message)
    this.name = "DeveAgentBoundaryError"
  }
}

type DeveAgentInstanceScope = {
  readonly instance: InstanceContext
  readonly directory: string
  readonly workspaceID?: WorkspaceV2.ID
}

function samePath(left: string, right: string) {
  const normalize = (value: string) => path.normalize(path.resolve(value))
  const a = normalize(left)
  const b = normalize(right)
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

async function assertNoSymlinkPath(input: string, label: string) {
  const absolute = path.resolve(input)
  const root = path.parse(absolute).root
  let current = root
  for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new DeveAgentBoundaryError(`${label} must not contain a symlink.`, 400)
      }
    } catch (error) {
      if (error instanceof DeveAgentBoundaryError) throw error
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return
      throw new DeveAgentBoundaryError(`${label} could not be validated.`, 400)
    }
  }
}

async function assertRealDirectory(input: string, label: string) {
  const lexical = path.resolve(input)
  let resolved: string
  try {
    resolved = await realpath(lexical)
  } catch {
    throw new DeveAgentBoundaryError(`${label} does not exist.`, 400)
  }
  if (!samePath(lexical, resolved)) {
    throw new DeveAgentBoundaryError(`${label} must not be a symlink.`, 400)
  }
  await assertNoSymlinkPath(lexical, label)
  return resolved
}

function requestDirectory(request: HttpServerRequest.HttpServerRequest, url: URL) {
  return url.searchParams.get("directory") || request.headers["x-opencode-directory"] || process.cwd()
}

function boundaryResponse(error: unknown, fallback: { status: number; message: string }) {
  if (error instanceof DeveAgentBoundaryError) {
    return HttpServerResponse.jsonUnsafe({ error: error.message }, { status: error.status })
  }
  return HttpServerResponse.jsonUnsafe({ error: fallback.message }, { status: fallback.status })
}

function resolveDeveAgentInstanceScope(
  request: HttpServerRequest.HttpServerRequest,
  instances: InstanceStore.Interface,
  workspaces: Workspace.Interface,
): Effect.Effect<DeveAgentInstanceScope, unknown> {
  return Effect.gen(function* () {
    const url = new URL(request.url, "http://localhost")
    const requestedDirectory = requestDirectory(request, url)
    const baseDirectory = yield* Effect.tryPromise({
      try: () => assertRealDirectory(requestedDirectory, "Current instance workspace"),
      catch: (error) => error,
    })
    let instance = yield* instances.load({ directory: baseDirectory })
    const configuredWorkspaceID = Flag.OPENCODE_WORKSPACE_ID
      ? WorkspaceV2.ID.make(Flag.OPENCODE_WORKSPACE_ID)
      : undefined
    const requestedWorkspaceID = url.searchParams.get("workspace")
    const workspaceID = configuredWorkspaceID ?? (requestedWorkspaceID ? WorkspaceV2.ID.make(requestedWorkspaceID) : undefined)

    if (requestedWorkspaceID && !configuredWorkspaceID) {
      const workspace = yield* workspaces.get(workspaceID as WorkspaceV2.ID)
      if (!workspace) return yield* Effect.fail(new DeveAgentBoundaryError("Current workspace was not found.", 403))
      const target = yield* WorkspaceAdapterRuntime.target(workspace).pipe(
        Effect.provideService(InstanceRef, instance),
        Effect.provideService(WorkspaceRef, workspaceID),
        Effect.catch(() => Effect.fail(new DeveAgentBoundaryError("Current workspace could not be resolved.", 403))),
      )
      if (target.type !== "local") return yield* Effect.fail(new DeveAgentBoundaryError("Remote workspaces cannot use this local route.", 403))
      const directory = yield* Effect.tryPromise({
        try: () => assertRealDirectory(target.directory, "Current workspace"),
        catch: (error) => error,
      })
      instance = yield* instances.load({ directory })
      return { instance, directory, workspaceID }
    }

    const directory = yield* Effect.tryPromise({
      try: () => assertRealDirectory(instance.directory, "Current instance workspace"),
      catch: (error) => error,
    })
    if (!samePath(directory, baseDirectory)) {
      return yield* Effect.fail(new DeveAgentBoundaryError("Current instance workspace changed during routing.", 403))
    }
    return { instance, directory, workspaceID }
  })
}

function verifyDeveAgentSessionScope(
  scope: DeveAgentInstanceScope,
  sessionID: string,
  sessions: Session.Interface,
  workspaces: Workspace.Interface,
): Effect.Effect<Session.Info, unknown> {
  return Effect.gen(function* () {
    if (!/^[a-zA-Z0-9._-]{1,160}$/.test(sessionID)) {
      return yield* Effect.fail(new DeveAgentBoundaryError("Invalid sessionID.", 403))
    }
    const session = yield* sessions.get(SessionID.make(sessionID)).pipe(
      Effect.catch(() => Effect.fail(new DeveAgentBoundaryError("Session does not belong to this instance.", 403))),
    )
    const sessionDirectory = yield* Effect.tryPromise({
      try: () => assertRealDirectory(session.directory, "Session workspace"),
      catch: (error) => error,
    })
    if (!samePath(sessionDirectory, scope.directory)) {
      return yield* Effect.fail(new DeveAgentBoundaryError("Session does not belong to this instance workspace.", 403))
    }

    if (!session.workspaceID) {
      if (scope.workspaceID) return yield* Effect.fail(new DeveAgentBoundaryError("Session does not belong to this workspace.", 403))
      return session
    }

    if (scope.workspaceID && session.workspaceID !== scope.workspaceID) {
      return yield* Effect.fail(new DeveAgentBoundaryError("Session does not belong to this workspace.", 403))
    }
    const workspace = yield* workspaces.get(session.workspaceID)
    const workspaceDirectoryValue = workspace?.directory
    if (typeof workspaceDirectoryValue !== "string" || !workspaceDirectoryValue) {
      return yield* Effect.fail(new DeveAgentBoundaryError("Session workspace was not found.", 403))
    }
    const workspaceDirectory = yield* Effect.tryPromise({
      try: () => assertRealDirectory(workspaceDirectoryValue, "Session workspace"),
      catch: (error) => error,
    })
    if (!samePath(workspaceDirectory, scope.directory)) {
      return yield* Effect.fail(new DeveAgentBoundaryError("Session does not belong to this workspace.", 403))
    }
    return session
  })
}

// DeveAgent metrics endpoint
const deveagentMetricsRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const providers = yield* Provider.Service
    const auth = yield* Auth.Service
    const instances = yield* InstanceStore.Service
    const deveagentSnapshot = yield* Snapshot.Service
    const deveagentRevert = yield* SessionRevert.Service
    const workspaces = yield* Workspace.Service
    const background = yield* BackgroundJob.Service
    const agents = yield* Agent.Service
    const permission = yield* Permission.Service
    const sessions = yield* Session.Service
    const sessionPrompt = yield* SessionPrompt.Service
    const toolRegistry = yield* ToolRegistry.Service

    // S3: the native TaskTool bridge shared by team dispatch AND team retry.
    // Both drive member subagents through the same permission.ask +
    // nativeTask.execute + background.wait seam (including the child-turn
    // error check), so a retried member runs exactly like a first-run one.
    const buildTeamTaskBridge = (input: {
      sessionID: SessionID
      parentMessage: { info: { id: Tool.Context["messageID"] } }
      parentAgent: { name: string; permission?: Parameters<typeof Permission.merge>[0] | undefined }
      parentSession: { permission?: Parameters<typeof Permission.merge>[1] | null | undefined }
      history: Tool.Context["messages"]
    }) =>
      Effect.gen(function* () {
        const bridge = yield* EffectBridge.make()
        const nativeTask = (yield* toolRegistry.named()).task
        const callID = `deveagent-team-${Date.now().toString(36)}`
        const abortController = new AbortController()
        const context: Tool.Context & {
          runTask: (taskInput: unknown) => Promise<unknown>
          waitTask: (waitInput: { jobID: string; timeout_ms?: number }) => Promise<unknown>
        } = {
          sessionID: input.sessionID,
          messageID: input.parentMessage.info.id,
          agent: input.parentAgent.name,
          abort: abortController.signal,
          messages: input.history,
          extra: {
            promptOps: {
              cancel: (childSessionID: SessionID) => sessionPrompt.cancel(childSessionID),
              resolvePromptParts: (template: string) => sessionPrompt.resolvePromptParts(template),
              prompt: (promptInput: Parameters<TaskPromptOps["prompt"]>[0]) => sessionPrompt.prompt(promptInput).pipe(Effect.catch(Effect.die)),
            } satisfies TaskPromptOps,
          },
          metadata: () => Effect.void,
          ask: (askInput) =>
            permission
              .ask({
                ...askInput,
                sessionID: input.sessionID,
                tool: { messageID: input.parentMessage.info.id, callID },
                ruleset: Permission.merge(input.parentAgent.permission ?? [], input.parentSession.permission ?? []),
              })
              .pipe(Effect.orDie),
          runTask: (taskInput: unknown) => bridge.promise(nativeTask.execute(taskInput as never, context)),
          waitTask: (waitInput: { jobID: string; timeout_ms?: number }) =>
            bridge.promise(
              Effect.gen(function* () {
                const timeout = typeof waitInput.timeout_ms === "number"
                  ? Math.max(1_000, Math.min(10 * 60_000, Math.floor(waitInput.timeout_ms)))
                  : undefined
                const waited = yield* background.wait({ id: waitInput.jobID, timeout })
                if (!waited.info) return yield* Effect.fail(new Error("Native background task is unavailable; it may have ended after a server restart."))
                if (waited.timedOut) {
                  yield* background.cancel(waitInput.jobID)
                  return yield* Effect.fail(new Error(`Task timed out after ${timeout}ms`))
                }
                if (waited.info.status === "error") return yield* Effect.fail(new Error(waited.info.error ?? "Background task failed"))
                if (waited.info.status === "cancelled") return yield* Effect.fail(new Error("Background task cancelled"))
                const childID = typeof waited.info.metadata?.sessionId === "string" ? waited.info.metadata.sessionId : undefined
                const child = childID ? yield* sessions.get(SessionID.make(childID)) : undefined
                if (childID) {
                  const recent = yield* sessions.messages({ sessionID: SessionID.make(childID), limit: 3 })
                  const lastAssistant = [...recent].reverse().find((message) => message.info.role === "assistant")
                  const childError = (lastAssistant?.info as { error?: unknown } | undefined)?.error
                  if (childError) {
                    const message = typeof childError === "string"
                      ? childError
                      : ((childError as { message?: unknown }).message as string | undefined) ?? "Child session turn errored"
                    return yield* Effect.fail(Object.assign(new Error(message.slice(0, 200)), { childTurnError: true }))
                  }
                }
                return {
                  title: waited.info.title ?? "Background task",
                  output: waited.info.output ?? "",
                  metadata: { ...waited.info.metadata, jobId: waited.info.id, sessionId: childID, usage: child?.tokens, cost: child?.cost },
                }
              }),
            ),
        }
        return { context, abortController }
      })

    yield* router.add("GET", "/api/deveagent/metrics", () =>
      Effect.tryPromise(async () => {
        const { getDeveAgentMetrics } = await import("../../../../plugin/deveagent")
        return HttpServerResponse.jsonUnsafe(getDeveAgentMetrics())
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "unavailable" })))),
    )
    yield* router.add("GET", "/api/deveagent/state", () =>
      Effect.tryPromise(async () => {
        const { getDeveAgentState } = await import("../../../../plugin/deveagent")
        return HttpServerResponse.jsonUnsafe(getDeveAgentState())
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "unavailable" })))),
    )
    yield* router.add("GET", "/api/deveagent/background-jobs", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const sessionID = new URL(request.url, "http://localhost").searchParams.get("sessionID") || undefined
        const directory = new URL(request.url, "http://localhost").searchParams.get("directory") || undefined
        // BackgroundJob needs the instance scope; raw routes run outside it so
        // the call goes through InstanceStore.provide (same fix as Rewind).
        const jobs = yield* instances.provide({ directory: directory || process.cwd() }, background.list())
        return HttpServerResponse.jsonUnsafe(
          jobs
            .filter((job) => job.type === "task")
            .filter((job) => !sessionID || job.metadata?.parentSessionId === sessionID)
            .map((job) => ({
              id: job.id,
              type: job.type,
              ...(job.title ? { title: job.title } : {}),
              status: job.status,
              started_at: job.started_at,
              ...(job.completed_at ? { completed_at: job.completed_at } : {}),
              ...(job.error ? { error: job.error } : {}),
              metadata: {
                parentSessionId: job.metadata?.parentSessionId,
                sessionId: job.metadata?.sessionId,
                background: job.metadata?.background,
                deveagentTeam: job.metadata?.deveagentTeam,
                deveagentRestartState: job.metadata?.deveagentRestartState,
                // The task runner already records real usage on the job; forward
                // it so the sub-agent strip shows tokens/cost instead of an
                // unknown marker. Absent fields stay absent - the UI renders an
                // explicit unknown rather than a fabricated zero.
                ...(typeof job.metadata?.usage === "number" ? { usage: job.metadata.usage } : {}),
                ...(typeof job.metadata?.cost === "number" ? { cost: job.metadata.cost } : {}),
              },
            })),
        )
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "unavailable" })))),
    )
    yield* router.add("POST", "/api/deveagent/background-jobs/cancel", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = yield* Effect.try({
          try: () => JSON.parse(body || "{}") as { jobID?: unknown; sessionID?: unknown; directory?: unknown },
          catch: () => new Error("invalid JSON"),
        })
        const jobID = typeof payload.jobID === "string" ? payload.jobID.trim() : ""
        const sessionID = typeof payload.sessionID === "string" ? payload.sessionID.trim() : ""
        const directory = typeof payload.directory === "string" && payload.directory.trim() ? payload.directory.trim() : undefined
        if (!/^[a-zA-Z0-9._-]{1,200}$/.test(jobID)) {
          return HttpServerResponse.jsonUnsafe({ error: "valid jobID is required" }, { status: 400 })
        }
        if (!/^[a-zA-Z0-9._-]{1,160}$/.test(sessionID)) {
          return HttpServerResponse.jsonUnsafe({ error: "valid sessionID is required" }, { status: 400 })
        }
        // Same instance-scope fix as the GET route: the job registry lives in
        // the workspace instance, not the process-cwd one. Cancelling a task
        // job interrupts its run Effect, which triggers the task tool's
        // onInterrupt -> ops.cancel(child session) teardown.
        const cancelled = yield* instances.provide(
          { directory: directory || process.cwd() },
          Effect.gen(function* () {
            const job = yield* background.get(jobID)
            if (!job) return yield* Effect.fail(new Error("background job not found"))
            if (job.type !== "task") {
              return yield* Effect.fail(new Error("only task jobs can be cancelled here"))
            }
            if (job.metadata?.parentSessionId !== sessionID) {
              return yield* Effect.fail(new Error("job does not belong to this session"))
            }
            return yield* background.cancel(jobID)
          }),
        )
        return HttpServerResponse.jsonUnsafe({ job: cancelled })
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              { error: error instanceof Error ? error.message.slice(0, 500) : "background job cancellation failed" },
              { status: 400 },
            ),
          ),
        ),
      ),
    )
    yield* router.add("GET", "/api/deveagent/mcp/registry", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const search = new URL(request.url, "http://localhost").searchParams
        const { searchDeveAgentMcpRegistry } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe(
          yield* Effect.promise(() => searchDeveAgentMcpRegistry({ query: search.get("q") ?? undefined, cursor: search.get("cursor") ?? undefined })),
        )
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ servers: [], error: "MCP Registry unavailable" }, { status: 502 })))),
    )
    yield* router.add("POST", "/api/deveagent/mcp/validate", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = JSON.parse((yield* Effect.orDie(request.text)) || "{}")
        const { validateDeveAgentMcpRemoteUrl } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe({ url: yield* Effect.promise(() => validateDeveAgentMcpRemoteUrl(String(body.url || ""))) })
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "Invalid public HTTPS MCP endpoint" }, { status: 400 })))),
    )
    yield* router.add("POST", "/api/deveagent/state", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        const { setDeveAgentState } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe(setDeveAgentState(payload))
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "invalid request" }, { status: 400 })))),
    )
    yield* router.add("GET", "/api/deveagent/auxiliary", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const sessionID = new URL(request.url, "http://localhost").searchParams.get("sessionID")
        const scope = sessionID !== null ? yield* resolveDeveAgentInstanceScope(request, instances, workspaces) : undefined
        if (sessionID !== null && scope) yield* verifyDeveAgentSessionScope(scope, sessionID, sessions, workspaces)
        const { getDeveAgentState, getEffectiveAuxiliary, getSessionAuxiliary } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        const override = sessionID ? getSessionAuxiliary(sessionID) : undefined
        const auxiliary = sessionID ? getEffectiveAuxiliary(sessionID) : getDeveAgentState().auxiliary
        return HttpServerResponse.jsonUnsafe({ sessionID: sessionID ?? undefined, auxiliary, overridden: Boolean(override) })
      }).pipe(Effect.catch((error) => Effect.succeed(boundaryResponse(error, { status: 502, message: "auxiliary unavailable" })))),
    )
    yield* router.add("POST", "/api/deveagent/auxiliary", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        const { clearSessionAuxiliary, getDeveAgentState, setDeveAgentState, setSessionAuxiliary } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        // ponytail: if sessionID present, persist per-session (sanitized); else global
        if (payload.sessionID !== undefined && payload.sessionID !== null) {
          const sessionID = String(payload.sessionID)
          const scope = yield* resolveDeveAgentInstanceScope(request, instances, workspaces)
          yield* verifyDeveAgentSessionScope(scope, sessionID, sessions, workspaces)
          if (payload.reset === true) {
            return HttpServerResponse.jsonUnsafe({ sessionID, auxiliary: clearSessionAuxiliary(sessionID), overridden: false })
          }
          const { sessionID: _sid, ...fields } = payload
          const auxiliary = setSessionAuxiliary(sessionID, fields)
          return HttpServerResponse.jsonUnsafe({ sessionID, auxiliary, overridden: true })
        }
        return HttpServerResponse.jsonUnsafe(setDeveAgentState({
          auxiliary: { ...getDeveAgentState().auxiliary, ...payload },
        }))
      }).pipe(Effect.catch((error) => Effect.succeed(boundaryResponse(error, { status: 400, message: "invalid auxiliary model" }))))
    )
    yield* router.add("GET", "/api/deveagent/vision-config", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const workspaceParam = new URL(request.url, "http://localhost").searchParams.get("workspace")
        const { visionStatus, VISION_PROVIDER_PRESETS } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe({ presets: VISION_PROVIDER_PRESETS, status: visionStatus(workspaceParam ?? undefined) })
      }).pipe(Effect.catch((error) => Effect.succeed(boundaryResponse(error, { status: 502, message: "vision config unavailable" })))),
    )
    yield* router.add("POST", "/api/deveagent/vision-config", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}") as {
          provider?: string
          baseUrl?: string
          apiKey?: string
          model?: string
          language?: string
          clear?: boolean
          workspace?: boolean
        }
        const { clearVisionConfig, loadVisionConfig, saveVisionConfig, validateVisionConfig, visionStatus } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        if (payload.clear === true) {
          return HttpServerResponse.jsonUnsafe({ cleared: clearVisionConfig(payload.workspace ? process.cwd() : undefined).cleared })
        }
        const existing = loadVisionConfig(payload.workspace ? process.cwd() : undefined) ?? { provider: "openai", baseUrl: "", apiKey: "", model: "" }
        const next = {
          provider: payload.provider ?? existing.provider,
          baseUrl: payload.baseUrl ?? existing.baseUrl,
          // Empty/absent apiKey keeps the stored key (same rule as stt-config).
          apiKey: payload.apiKey ? payload.apiKey : existing.apiKey,
          model: payload.model ?? existing.model,
          language: payload.language ?? existing.language,
        }
        const invalid = validateVisionConfig(next)
        if (invalid) return HttpServerResponse.jsonUnsafe({ ok: false, error: invalid }, { status: 400 })
        const { path } = saveVisionConfig(next, payload.workspace ? process.cwd() : undefined)
        return HttpServerResponse.jsonUnsafe({ ok: true, path })
      }).pipe(Effect.catch((error) => Effect.succeed(boundaryResponse(error, { status: 400, message: "invalid vision config" })))),
    )
    yield* router.add("GET", "/api/deveagent/role-profile", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const role = new URL(request.url, "http://localhost").searchParams.get("role")
        const { getRoleProfile, listRoleProfiles } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        if (role !== null && !/^[a-z][a-z0-9-]{0,31}$/.test(role)) {
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "invalid role" }, { status: 400 })
        }
        const profiles = listRoleProfiles()
        return HttpServerResponse.jsonUnsafe(role !== null ? { ok: true, profiles, role: getRoleProfile(role) } : { ok: true, profiles })
      }).pipe(Effect.catch((error) => Effect.succeed(boundaryResponse(error, { status: 502, message: "role profile unavailable" })))),
    )
    yield* router.add("POST", "/api/deveagent/role-profile", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}") as { action?: string; role?: string; providerID?: string; modelID?: string }
        const { checkRoleProfileModel, clearRoleProfile, listRoleProfiles, setRoleProfile } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        if (payload.action === "clear") {
          if (!payload.role) return HttpServerResponse.jsonUnsafe({ ok: false, error: "role is required" }, { status: 400 })
          const result = clearRoleProfile(payload.role)
          if (!result.ok) return HttpServerResponse.jsonUnsafe(result, { status: 400 })
          return HttpServerResponse.jsonUnsafe({ ok: true, profiles: listRoleProfiles() })
        }
        if (payload.action === undefined || payload.action === "set") {
          if (!payload.role) return HttpServerResponse.jsonUnsafe({ ok: false, error: "role is required" }, { status: 400 })
          const result = setRoleProfile(payload.role, { providerID: payload.providerID, modelID: payload.modelID })
          if (!result.ok) return HttpServerResponse.jsonUnsafe(result, { status: 400 })
          const warning = yield* Effect.promise(() => checkRoleProfileModel(result.profile.providerID, result.profile.modelID))
          return HttpServerResponse.jsonUnsafe({
            ok: true,
            role: result.role,
            profile: result.profile,
            profiles: listRoleProfiles(),
            ...(warning ? { warning } : {}),
          })
        }
        return HttpServerResponse.jsonUnsafe({ ok: false, error: "unknown action" }, { status: 400 })
      }).pipe(Effect.catch((error) => Effect.succeed(boundaryResponse(error, { status: 400, message: "invalid role profile" })))),
    )
    yield* router.add("POST", "/api/deveagent/vision-test", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}") as { workspace?: boolean }
        const { loadVisionConfig, newVisionTelemetry, testVisionConnection } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        const config = loadVisionConfig(payload.workspace ? process.cwd() : undefined)
        if (!config) return HttpServerResponse.jsonUnsafe({ ok: false, detail: "未配置独立视觉 API。" })
        // Diagnostic probes record into a throwaway sink so they never pollute
        // the production telemetry counters the dashboard reads.
        const result = yield* Effect.promise(() => testVisionConnection(config, payload.workspace ? process.cwd() : undefined, newVisionTelemetry()))
        return HttpServerResponse.jsonUnsafe(result)
      }).pipe(Effect.catch((error) => Effect.succeed(boundaryResponse(error, { status: 502, message: "vision test failed" })))),
    )
    yield* router.add("GET", "/api/deveagent/stt-config", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const workspaceParam = new URL(request.url, "http://localhost").searchParams.get("workspace")
        const { STT_PROVIDER_PRESETS, localSttStatus, sttStatus } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe({
          presets: STT_PROVIDER_PRESETS,
          status: sttStatus(workspaceParam ?? undefined),
          local: localSttStatus(),
        })
      }).pipe(Effect.catch((error) => Effect.succeed(boundaryResponse(error, { status: 502, message: "stt config unavailable" })))),
    )
    yield* router.add("POST", "/api/deveagent/stt-config", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}") as {
          provider?: string
          baseUrl?: string
          apiKey?: string
          model?: string
          language?: string
          clear?: boolean
          workspace?: boolean
        }
        const { clearSttConfig, loadSttConfig, saveSttConfig, validateSttConfig } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        if (payload.clear === true) {
          return HttpServerResponse.jsonUnsafe({ cleared: clearSttConfig(payload.workspace ? process.cwd() : undefined).cleared })
        }
        const existing = loadSttConfig(payload.workspace ? process.cwd() : undefined) ?? { provider: "openai", baseUrl: "", apiKey: "", model: "" }
        const next = {
          provider: payload.provider ?? existing.provider,
          baseUrl: payload.baseUrl ?? existing.baseUrl,
          // Empty/absent apiKey keeps the stored key: the panel never echoes the
          // real key back, so a partial re-save (edit baseUrl/model) must not
          // wipe it. Use clear:true to remove the whole config.
          apiKey: payload.apiKey ? payload.apiKey : existing.apiKey,
          model: payload.model ?? existing.model,
          language: payload.language ?? existing.language,
        }
        const invalid = validateSttConfig(next)
        if (invalid) return HttpServerResponse.jsonUnsafe({ ok: false, error: invalid }, { status: 400 })
        const { path } = saveSttConfig(next, payload.workspace ? process.cwd() : undefined)
        return HttpServerResponse.jsonUnsafe({ ok: true, path })
      }).pipe(Effect.catch((error) => Effect.succeed(boundaryResponse(error, { status: 400, message: "invalid stt config" })))),
    )
    yield* router.add("POST", "/api/deveagent/stt-test", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}") as { workspace?: boolean }
        const { loadSttConfig, testSttConnection } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        const config = loadSttConfig(payload.workspace ? process.cwd() : undefined)
        if (!config) return HttpServerResponse.jsonUnsafe({ ok: false, detail: "未配置独立 STT API。" })
        const result = yield* Effect.promise(() => testSttConnection(config, payload.workspace ? process.cwd() : undefined))
        return HttpServerResponse.jsonUnsafe(result)
      }).pipe(Effect.catch((error) => Effect.succeed(boundaryResponse(error, { status: 502, message: "stt test failed" })))),
    )
    yield* router.add("POST", "/api/deveagent/stt-local/install", () =>
      Effect.gen(function* () {
        const { installLocalStt } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe(yield* Effect.promise(() => installLocalStt()))
      }).pipe(Effect.catch((error) => Effect.succeed(boundaryResponse(error, { status: 502, message: "local stt install failed" })))),
    )

    yield* router.add("GET", "/api/deveagent/goal-telemetry", () =>
      Effect.gen(function* () {
        const { goalTelemetrySnapshot } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe(goalTelemetrySnapshot())
      }).pipe(Effect.catch((error) => Effect.succeed(boundaryResponse(error, { status: 502, message: "goal telemetry unavailable" })))),
    )

    yield* router.add("GET", "/api/deveagent/cache-shape", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const sessionID = new URL(request.url, "http://localhost").searchParams.get("sessionID")
        const { prefixShapeSnapshot } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe({ shape: sessionID ? prefixShapeSnapshot(sessionID) : null })
      }).pipe(Effect.catch((error) => Effect.succeed(boundaryResponse(error, { status: 502, message: "cache shape unavailable" })))),
    )

    yield* router.add("POST", "/api/deveagent/vision-analyze", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}") as { image?: string; prompt?: string; workspace?: boolean }
        if (!payload.image) return HttpServerResponse.jsonUnsafe({ ok: false, error: "image 不能为空" }, { status: 400 })
        const { newVisionTelemetry, runVisionChain } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        // Manual/E2E calls record into a throwaway sink so they never pollute
        // the production counters the dashboard reads.
        const telemetry = newVisionTelemetry()
        const result = yield* Effect.promise(() =>
          runVisionChain(payload.image!, payload.prompt || "Describe this image in detail.", payload.workspace ? process.cwd() : undefined, telemetry),
        )
        return HttpServerResponse.jsonUnsafe({ ...result, telemetry })
      }).pipe(Effect.catch((error) => Effect.succeed(boundaryResponse(error, { status: 502, message: "vision analyze failed" })))),
    )
    yield* router.add("POST", "/api/deveagent/skill/install", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        if (!payload.url) return HttpServerResponse.jsonUnsafe({ error: "url required" }, { status: 400 })
        const scope = yield* resolveDeveAgentInstanceScope(request, instances, workspaces)
        if (payload.directory !== undefined) {
          if (typeof payload.directory !== "string" || !payload.directory.trim()) {
            return yield* Effect.fail(new DeveAgentBoundaryError("Skill workspace must be a directory.", 400))
          }
          const callerDirectory = yield* Effect.tryPromise({
            try: () => assertRealDirectory(payload.directory, "Skill workspace"),
            catch: (error) => error,
          })
          if (!samePath(callerDirectory, scope.directory)) {
            return yield* Effect.fail(new DeveAgentBoundaryError("Skill workspace must match the current instance workspace.", 400))
          }
        }
        yield* Effect.tryPromise({
          try: () => assertNoSymlinkPath(path.join(scope.directory, ".deveagent", "skills", "remote"), "Remote Skill directory"),
          catch: (error) => error,
        })
        const { installRemoteSkill } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        const result = yield* Effect.promise(() => installRemoteSkill({ url: payload.url, id: payload.id, directory: scope.directory }))
        return HttpServerResponse.jsonUnsafe(result)
      }).pipe(Effect.catch((error) => Effect.succeed(boundaryResponse(error, { status: 500, message: "install failed" }))))
    )
    yield* router.add("GET", "/api/deveagent/skill/list-remote", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const scope = yield* resolveDeveAgentInstanceScope(request, instances, workspaces)
        const { loadRemoteSkills } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        const requestedDirectory = new URL(request.url, "http://localhost").searchParams.get("directory")
        const headerDirectory = request.headers["x-opencode-directory"]
        if (requestedDirectory !== null && headerDirectory) {
          const headerRealDirectory = yield* Effect.tryPromise({
            try: () => assertRealDirectory(headerDirectory, "Current instance workspace"),
            catch: (error) => error,
          })
          if (!samePath(headerRealDirectory, scope.directory)) {
            return yield* Effect.fail(new DeveAgentBoundaryError("Skill workspace must match the current instance workspace.", 400))
          }
        }
        if (requestedDirectory !== null) {
          const callerDirectory = yield* Effect.tryPromise({
            try: () => assertRealDirectory(requestedDirectory, "Skill workspace"),
            catch: (error) => error,
          })
          if (!samePath(callerDirectory, scope.directory)) {
            return yield* Effect.fail(new DeveAgentBoundaryError("Skill workspace must match the current instance workspace.", 400))
          }
        }
        yield* Effect.tryPromise({
          try: () => assertNoSymlinkPath(path.join(scope.directory, ".deveagent", "skills", "remote"), "Remote Skill directory"),
          catch: (error) => error,
        })
        const result = yield* Effect.promise(() => loadRemoteSkills(scope.directory))
        return HttpServerResponse.jsonUnsafe(result)
      }).pipe(Effect.catch((error) => Effect.succeed(boundaryResponse(error, { status: 500, message: "list failed" }))))
    )
    yield* router.add("POST", "/api/deveagent/skill/remove", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        if (!payload.id) return HttpServerResponse.jsonUnsafe({ error: "id required" }, { status: 400 })
        const scope = yield* resolveDeveAgentInstanceScope(request, instances, workspaces)
        if (payload.directory !== undefined) {
          if (typeof payload.directory !== "string" || !payload.directory.trim()) {
            return yield* Effect.fail(new DeveAgentBoundaryError("Skill workspace must be a directory.", 400))
          }
          const callerDirectory = yield* Effect.tryPromise({
            try: () => assertRealDirectory(payload.directory, "Skill workspace"),
            catch: (error) => error,
          })
          if (!samePath(callerDirectory, scope.directory)) {
            return yield* Effect.fail(new DeveAgentBoundaryError("Skill workspace must match the current instance workspace.", 400))
          }
        }
        yield* Effect.tryPromise({
          try: () => assertNoSymlinkPath(path.join(scope.directory, ".deveagent", "skills", "remote"), "Remote Skill directory"),
          catch: (error) => error,
        })
        const { removeRemoteSkill } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        const result = yield* Effect.promise(() => removeRemoteSkill(payload.id, scope.directory))
        return HttpServerResponse.jsonUnsafe(result)
      }).pipe(Effect.catch((error) => Effect.succeed(boundaryResponse(error, { status: 500, message: "remove failed" }))))
    )
    yield* router.add("POST", "/api/deveagent/skill/check-updates", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        const scope = yield* resolveDeveAgentInstanceScope(request, instances, workspaces)
        if (payload.directory !== undefined) {
          if (typeof payload.directory !== "string" || !payload.directory.trim()) {
            return yield* Effect.fail(new DeveAgentBoundaryError("Skill workspace must be a directory.", 400))
          }
          const callerDirectory = yield* Effect.tryPromise({
            try: () => assertRealDirectory(payload.directory, "Skill workspace"),
            catch: (error) => error,
          })
          if (!samePath(callerDirectory, scope.directory)) {
            return yield* Effect.fail(new DeveAgentBoundaryError("Skill workspace must match the current instance workspace.", 400))
          }
        }
        yield* Effect.tryPromise({
          try: () => assertNoSymlinkPath(path.join(scope.directory, ".deveagent", "skills", "remote"), "Remote Skill directory"),
          catch: (error) => error,
        })
        const { checkRemoteSkillUpdates } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        const result = yield* Effect.promise(() => checkRemoteSkillUpdates({ directory: scope.directory }))
        return HttpServerResponse.jsonUnsafe(result)
      }).pipe(Effect.catch((error) => Effect.succeed(boundaryResponse(error, { status: 500, message: "check failed" }))))
    )
    yield* router.add("POST", "/api/deveagent/skill/update", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        if (!payload.id) return HttpServerResponse.jsonUnsafe({ error: "id required" }, { status: 400 })
        const scope = yield* resolveDeveAgentInstanceScope(request, instances, workspaces)
        if (payload.directory !== undefined) {
          if (typeof payload.directory !== "string" || !payload.directory.trim()) {
            return yield* Effect.fail(new DeveAgentBoundaryError("Skill workspace must be a directory.", 400))
          }
          const callerDirectory = yield* Effect.tryPromise({
            try: () => assertRealDirectory(payload.directory, "Skill workspace"),
            catch: (error) => error,
          })
          if (!samePath(callerDirectory, scope.directory)) {
            return yield* Effect.fail(new DeveAgentBoundaryError("Skill workspace must match the current instance workspace.", 400))
          }
        }
        yield* Effect.tryPromise({
          try: () => assertNoSymlinkPath(path.join(scope.directory, ".deveagent", "skills", "remote"), "Remote Skill directory"),
          catch: (error) => error,
        })
        const { updateRemoteSkill } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        const result = yield* Effect.promise(() => updateRemoteSkill({ id: payload.id, directory: scope.directory }))
        return HttpServerResponse.jsonUnsafe(result)
      }).pipe(Effect.catch((error) => Effect.succeed(boundaryResponse(error, { status: 500, message: "update failed" }))))
    )
    yield* router.add("POST", "/api/deveagent/skill/save-local", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        if (!payload.name) return HttpServerResponse.jsonUnsafe({ error: "name required" }, { status: 400 })
        const { saveLocalSkill } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        const result = yield* Effect.promise(() => saveLocalSkill(payload))
        return HttpServerResponse.jsonUnsafe(result)
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "save failed" }, { status: 500 }))))
    )
    yield* router.add("GET", "/api/deveagent/skill/list-local", () =>
      Effect.gen(function* () {
        const { loadLocalSkills } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        const result = yield* Effect.promise(() => loadLocalSkills())
        return HttpServerResponse.jsonUnsafe(result)
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "list failed" }, { status: 500 }))))
    )
    yield* router.add("POST", "/api/deveagent/skill/remove-local", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        if (!payload.id) return HttpServerResponse.jsonUnsafe({ error: "id required" }, { status: 400 })
        const { removeLocalSkill } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        const result = yield* Effect.promise(() => removeLocalSkill(payload.id))
        return HttpServerResponse.jsonUnsafe(result)
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "remove failed" }, { status: 500 }))))
    )
    yield* router.add("POST", "/api/deveagent/goal", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        const { setGoal, clearGoal, getGoal } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        const sessionID = typeof payload.sessionID === "string" ? payload.sessionID : undefined
        if (payload.clear) return HttpServerResponse.jsonUnsafe(clearGoal(sessionID))
        if (payload.description && Array.isArray(payload.criteria)) {
          if (typeof payload.directory !== "string" || !payload.directory.trim()) {
            return HttpServerResponse.jsonUnsafe({ error: "directory is required when creating a Goal" }, { status: 400 })
          }
          return HttpServerResponse.jsonUnsafe(setGoal({
            description: payload.description,
            criteria: payload.criteria,
            sessionID,
            directory: payload.directory,
            ...(typeof payload.budgetTokens === "number" ? { budgetTokens: payload.budgetTokens } : {}),
            ...(typeof payload.budgetCostUsd === "number" ? { budgetCostUsd: payload.budgetCostUsd } : {}),
            ...(payload.autoIterate === true
              ? { autoIterate: true, maxIterations: typeof payload.maxIterations === "number" ? payload.maxIterations : 3 }
              : {}),
          }))
        }
        return HttpServerResponse.jsonUnsafe(getGoal(sessionID))
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "invalid goal" }, { status: 400 }))))
    )
    yield* router.add("POST", "/api/deveagent/recap", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        const { summarizeAway } = yield* Effect.promise(() => import("../../../../plugin/deveagent-recap"))
        const result = yield* Effect.promise(() =>
          summarizeAway({
            directory: typeof payload.directory === "string" ? payload.directory : undefined,
            awayMinutes: typeof payload.awayMinutes === "number" ? payload.awayMinutes : 0,
            texts: payload.texts,
          }),
        )
        return HttpServerResponse.jsonUnsafe(result)
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ summary: null }))))
    )
    yield* router.add("POST", "/api/deveagent/goal/criteria", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        const { toggleGoalCriterion } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        const sessionID = typeof payload.sessionID === "string" ? payload.sessionID : undefined
        return HttpServerResponse.jsonUnsafe(toggleGoalCriterion(sessionID, Number(payload.index) || 0, payload.done === true))
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "invalid request" }, { status: 400 }))))
    )
    yield* router.add("POST", "/api/deveagent/goal/auto-iterate", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        const { setGoalAutoIterate } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        const sessionID = typeof payload.sessionID === "string" ? payload.sessionID : undefined
        if (typeof payload.enabled !== "boolean") return HttpServerResponse.jsonUnsafe({ error: "enabled boolean required" }, { status: 400 })
        return HttpServerResponse.jsonUnsafe(setGoalAutoIterate(sessionID, payload.enabled, typeof payload.maxIterations === "number" ? payload.maxIterations : 3))
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "invalid request" }, { status: 400 }))))
    )
    yield* router.add("POST", "/api/deveagent/worktree", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        const directory = typeof payload.directory === "string" ? payload.directory : ""
        if (!directory.trim()) {
          return HttpServerResponse.jsonUnsafe({ error: "directory is required" }, { status: 400 })
        }
        const wt = yield* Effect.promise(() => import("../../../../plugin/deveagent-worktree"))
        const { getActiveGoalByDirectory } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        if (payload.action === "list") {
          const worktrees = wt.listWorktrees(directory).map((entry) => ({
            ...entry,
            goal: getActiveGoalByDirectory(entry.path),
          }))
          return HttpServerResponse.jsonUnsafe({ worktrees, root: wt.worktreeRoot(directory) })
        }
        if (payload.action === "create") {
          return HttpServerResponse.jsonUnsafe(wt.createWorktree({ directory, name: payload.name, base: payload.base }))
        }
        if (payload.action === "merge") {
          return HttpServerResponse.jsonUnsafe(wt.mergeWorktree(directory, String(payload.name ?? "")))
        }
        if (payload.action === "remove") {
          return HttpServerResponse.jsonUnsafe(wt.removeWorktree(directory, String(payload.name ?? "")))
        }
        return HttpServerResponse.jsonUnsafe({ worktrees: wt.listWorktrees(directory) })
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(HttpServerResponse.jsonUnsafe({ error: String(error).slice(0, 300) || "worktree operation failed" }, { status: 400 })),
        ),
      )
    )
    yield* router.add("POST", "/api/deveagent/runs", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        const { readDeveAgentRuns } = yield* Effect.promise(() => import("../../../../plugin/deveagent-run"))
        const limit = typeof payload.limit === "number" ? payload.limit : 50
        const runs = yield* Effect.promise(() => readDeveAgentRuns(typeof payload.directory === "string" ? payload.directory : undefined, limit))
        return HttpServerResponse.jsonUnsafe({ runs })
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ runs: [] })))),
    )
    yield* router.add("POST", "/api/deveagent/cu-level", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        const directory = typeof payload.directory === "string" ? payload.directory : ""
        if (!directory.trim()) {
          return HttpServerResponse.jsonUnsafe({ error: "directory is required" }, { status: 400 })
        }
        const cuLevel = yield* Effect.promise(() => import("../../../../plugin/deveagent-cu-level"))
        if (payload.level === "default" || payload.level === "auto" || payload.level === "full") {
          const level = yield* Effect.promise(() => cuLevel.setCuPermissionLevel(directory, payload.level))
          return HttpServerResponse.jsonUnsafe({ level })
        }
        return HttpServerResponse.jsonUnsafe({ level: cuLevel.getCuPermissionLevel(directory) })
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ level: "default" })))),
    )
    yield* router.add("POST", "/api/deveagent/cu-audit", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        const directory = typeof payload.directory === "string" ? payload.directory : ""
        const { readCuAuditLog } = yield* Effect.promise(() => import("../../../../plugin/deveagent-cu-audit"))
        const { readDeveAgentRuns } = yield* Effect.promise(() => import("../../../../plugin/deveagent-run"))
        const limit = typeof payload.limit === "number" ? payload.limit : 50
        const entries = yield* Effect.promise(() => readCuAuditLog(directory || undefined, limit))
        const runs = yield* Effect.promise(() => readDeveAgentRuns(directory || undefined, 8))
        return HttpServerResponse.jsonUnsafe({ entries, runs })
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ entries: [] })))),
    )
    yield* router.add("POST", "/api/deveagent/checkpoints/list", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}") as { directory?: unknown; sessionID?: unknown; limit?: unknown }
        const directory = typeof payload.directory === "string" ? payload.directory : ""
        const sessionID = typeof payload.sessionID === "string" ? payload.sessionID : undefined
        const limit = typeof payload.limit === "number" ? payload.limit : 100
        const { readCheckpoints } = yield* Effect.promise(() => import("../../../../plugin/deveagent-checkpoints"))
        const entries = yield* Effect.promise(() => readCheckpoints(directory || undefined, sessionID, limit))
        return HttpServerResponse.jsonUnsafe({ entries })
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ entries: [] })))),
    )
    yield* router.add("GET", "/api/deveagent/checkpoints", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        const directory = url.searchParams.get("directory") ?? ""
        const sessionID = url.searchParams.get("sessionID") ?? undefined
        const limitParam = Number(url.searchParams.get("limit") ?? "")
        const { readCheckpoints } = yield* Effect.promise(() => import("../../../../plugin/deveagent-checkpoints"))
        const entries = yield* Effect.promise(() => readCheckpoints(directory || undefined, sessionID || undefined, Number.isFinite(limitParam) ? limitParam : 100))
        return HttpServerResponse.jsonUnsafe({ entries })
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ entries: [] })))),
    )
    yield* router.add("POST", "/api/deveagent/checkpoints", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}") as { directory?: unknown; sessionID?: unknown; messageID?: unknown }
        const directory = typeof payload.directory === "string" ? payload.directory : ""
        if (!directory.trim()) {
          return HttpServerResponse.jsonUnsafe({ error: "directory is required" }, { status: 400 })
        }
        // track() needs the instance scope (git worktree state); raw routes run
        // outside it, so the whole capture runs through InstanceStore.provide.
        // Services come from the router build scope via closure — yielding a
        // service tag inside a request callback fails with "Service not found".
        const result = yield* instances.provide({ directory }, Effect.gen(function* () {
          // Capture BEFORE the agent acts on the turn: this hash is the state a
          // later rewind restores. No git-backed snapshot (bare workspace) is an
          // honest no-record, not an error.
          const snapshotHash = yield* Effect.option(deveagentSnapshot.track())
          if (snapshotHash._tag === "None") return { recorded: false as const, reason: "snapshot unavailable (no git-backed snapshot)" }
          const { recordCheckpoint } = yield* Effect.promise(() => import("../../../../plugin/deveagent-checkpoints"))
          const entry = yield* Effect.promise(() =>
            recordCheckpoint(directory, {
              sessionID: typeof payload.sessionID === "string" ? payload.sessionID : undefined,
              messageID: typeof payload.messageID === "string" ? payload.messageID : undefined,
              snapshotHash: snapshotHash.value,
            }),
          )
          return { recorded: entry !== undefined } as const
        })).pipe(Effect.catchDefect((defect: unknown) => Effect.succeed({ recorded: false as const, reason: "defect: " + String(defect).slice(0, 250) })), Effect.catch((error: unknown) => Effect.succeed({ recorded: false as const, reason: error instanceof Error ? error.message.slice(0, 200) : "capture failed" })))
        return HttpServerResponse.jsonUnsafe(result)
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ recorded: false })))),
    )
    yield* router.add("POST", "/api/deveagent/checkpoints/restore", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}") as { directory?: unknown; sessionID?: unknown; messageID?: unknown; snapshotHash?: unknown }
        const sessionID = typeof payload.sessionID === "string" ? payload.sessionID : ""
        const messageID = typeof payload.messageID === "string" ? payload.messageID : ""
        const snapshotHash = typeof payload.snapshotHash === "string" ? payload.snapshotHash : ""
        if (!snapshotHash && !(sessionID && messageID)) {
          return HttpServerResponse.jsonUnsafe({ error: "snapshotHash, or sessionID + messageID, is required" }, { status: 400 })
        }
        const directory = typeof payload.directory === "string" && payload.directory.trim() ? payload.directory : ""
        // Services come from the router build scope via closure (see record).
        const result = yield* instances.provide({ directory: directory || process.cwd() }, Effect.gen(function* () {
          let filesRestored = false
          let messagesReverted = false
          if (snapshotHash) {
            // File bytes first: the conversation revert below snapshots the
            // CURRENT tree as its undo point, so restoring files before that
            // capture would be recorded as the undo state.
            yield* deveagentSnapshot.restore(snapshotHash)
            filesRestored = true
          }
          if (sessionID && messageID) {
            const input = { sessionID, messageID } as Parameters<typeof deveagentRevert.revert>[0]
            yield* deveagentRevert.revert(input)
            messagesReverted = true
          }
          return { restored: true, filesRestored, messagesReverted }
        })).pipe(Effect.catchDefect((defect) => Effect.succeed({ restored: false, error: "defect: " + String(defect).slice(0, 250) })), Effect.catch((error: unknown) => Effect.succeed({ restored: false, error: error instanceof Error ? error.message.slice(0, 300) : "restore failed" })))
        return HttpServerResponse.jsonUnsafe(result, { status: result.restored ? 200 : 502 })
      }).pipe(Effect.catch((error: unknown) => Effect.succeed(HttpServerResponse.jsonUnsafe({ restored: false, error: error instanceof Error ? error.message.slice(0, 300) : "restore failed" }, { status: 502 })))),
    )
    yield* router.add("POST", "/api/deveagent/diff/apply-hunk", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}") as { directory?: unknown; filePath?: unknown; hunkPatch?: unknown }
        const directory = typeof payload.directory === "string" ? payload.directory : ""
        const rawFilePath = typeof payload.filePath === "string" ? payload.filePath : ""
        const hunkPatch = typeof payload.hunkPatch === "string" ? payload.hunkPatch : ""
        if (!rawFilePath.trim() || !hunkPatch.trim()) {
          return HttpServerResponse.jsonUnsafe({ error: "filePath and hunkPatch are required" }, { status: 400 })
        }
        // The review tab carries workspace-relative diff paths ("notes.txt"),
        // so a bare readFileSync resolved against the server cwd and missed.
        // Resolve against the workspace the client named, and refuse to touch
        // anything outside it.
        const pathMod = require("node:path") as typeof import("node:path")
        const workspace = directory.trim() ? pathMod.resolve(directory) : undefined
        const filePath = pathMod.isAbsolute(rawFilePath)
          ? pathMod.resolve(rawFilePath)
          : pathMod.resolve(workspace ?? process.cwd(), rawFilePath)
        // Containment is only meaningful when the caller named a workspace —
        // callers that pass an absolute path without `directory` (the packaged
        // probe does) keep the original contract.
        if (workspace !== undefined) {
          const relativeToWorkspace = pathMod.relative(workspace, filePath)
          if (!relativeToWorkspace || relativeToWorkspace.startsWith("..") || pathMod.isAbsolute(relativeToWorkspace)) {
            return HttpServerResponse.jsonUnsafe({ ok: false, error: "filePath escapes the workspace" }, { status: 400 })
          }
        }
        const { applyHunkToContent } = yield* Effect.promise(() => import("../../../../plugin/deveagent-diff-hunks"))
        const current = yield* Effect.try({
          try: () => require("node:fs").readFileSync(filePath, "utf8"),
          catch: () => new Error("file not readable"),
        })
        const applied = applyHunkToContent(current, hunkPatch)
        if (!applied.ok || applied.result === undefined) {
          return HttpServerResponse.jsonUnsafe({ ok: false, error: applied.error ?? "apply failed" }, { status: 409 })
        }
        yield* Effect.try({
          try: () => require("node:fs").writeFileSync(filePath, applied.result, "utf8"),
          catch: () => new Error("file not writable"),
        })
        return HttpServerResponse.jsonUnsafe({ ok: true, filePath })
      }).pipe(Effect.catch((error: unknown) => Effect.succeed(HttpServerResponse.jsonUnsafe({ ok: false, error: error instanceof Error ? error.message.slice(0, 300) : "apply-hunk failed" }, { status: 502 }))))),

    yield* router.add("GET", "/api/deveagent/automations", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        const directory = url.searchParams.get("directory") ?? ""
        const { getLoopQueue } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe({ entries: getLoopQueue(directory || undefined) })
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ entries: [] })))),
    )
    yield* router.add("POST", "/api/deveagent/automations/pause", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}") as { sessionID?: unknown }
        if (typeof payload.sessionID !== "string" || !payload.sessionID.trim()) {
          return HttpServerResponse.jsonUnsafe({ error: "sessionID is required" }, { status: 400 })
        }
        const { pauseLoop } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        const loop = pauseLoop(payload.sessionID)
        // No loop for this session (it completed or was cancelled between the
        // poll and the click): say so instead of reporting a successful pause.
        if (!loop.active) return HttpServerResponse.jsonUnsafe({ ok: false, reason: "no active loop for this session" }, { status: 404 })
        return HttpServerResponse.jsonUnsafe({ ok: true, loop })
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "pause failed" }, { status: 502 })))),
    )
    yield* router.add("POST", "/api/deveagent/automations/resume", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}") as { sessionID?: unknown }
        if (typeof payload.sessionID !== "string" || !payload.sessionID.trim()) {
          return HttpServerResponse.jsonUnsafe({ error: "sessionID is required" }, { status: 400 })
        }
        const { resumeLoop } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        const loop = resumeLoop(payload.sessionID)
        if (!loop.active) return HttpServerResponse.jsonUnsafe({ ok: false, reason: "no paused loop for this session" }, { status: 404 })
        return HttpServerResponse.jsonUnsafe({ ok: true, loop })
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "resume failed" }, { status: 502 })))),
    )
    yield* router.add("POST", "/api/deveagent/automations/run-now", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}") as { sessionID?: unknown }
        if (typeof payload.sessionID !== "string" || !payload.sessionID.trim()) {
          return HttpServerResponse.jsonUnsafe({ error: "sessionID is required" }, { status: 400 })
        }
        const { runLoopNow } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe(runLoopNow(payload.sessionID))
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ ok: false, reason: "run-now failed" }, { status: 502 })))),
    )
    yield* router.add("POST", "/api/deveagent/trust", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        const directory = typeof payload.directory === "string" ? payload.directory : ""
        if (!directory.trim()) {
          return HttpServerResponse.jsonUnsafe({ error: "directory is required" }, { status: 400 })
        }
        const trust = yield* Effect.promise(() => import("../../../../plugin/deveagent-trust"))
        if (payload.decision === "trusted" || payload.decision === "untrusted") {
          return HttpServerResponse.jsonUnsafe(yield* Effect.promise(() => trust.setProjectTrust(directory, payload.decision)))
        }
        return HttpServerResponse.jsonUnsafe(trust.getProjectTrust(directory))
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "invalid trust request" }, { status: 400 })))),
    )
    yield* router.add("POST", "/api/deveagent/goal/verify", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        const { verifyGoal } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe(verifyGoal({
          met: payload.met === true,
          reason: payload.reason,
          sessionID: typeof payload.sessionID === "string" ? payload.sessionID : undefined,
        }))
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "invalid verify" }, { status: 400 }))))
    )
    yield* router.add("POST", "/api/deveagent/goal/draft", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        const { clearGoalDraft, confirmGoal, getGoalDraft, prepareGoal } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        const sessionID = typeof payload.sessionID === "string" ? payload.sessionID : undefined
        if (payload.action === "prepare") {
          if (typeof payload.description !== "string") return HttpServerResponse.jsonUnsafe({ error: "description required" }, { status: 400 })
          return HttpServerResponse.jsonUnsafe(prepareGoal({
            sessionID,
            description: payload.description,
            directory: typeof payload.directory === "string" ? payload.directory : undefined,
          }))
        }
        if (payload.action === "confirm") {
          if (!Array.isArray(payload.criteria)) return HttpServerResponse.jsonUnsafe({ error: "criteria required" }, { status: 400 })
          return HttpServerResponse.jsonUnsafe(confirmGoal({
            sessionID,
            criteria: payload.criteria.filter((item: unknown): item is string => typeof item === "string"),
            directory: typeof payload.directory === "string" ? payload.directory : undefined,
            ...(payload.autoIterate === true
              ? { autoIterate: true, maxIterations: typeof payload.maxIterations === "number" ? payload.maxIterations : 3 }
              : {}),
          }))
        }
        if (payload.action === "clear") return HttpServerResponse.jsonUnsafe(clearGoalDraft(sessionID))
        return HttpServerResponse.jsonUnsafe(getGoalDraft(sessionID))
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "invalid goal draft" }, { status: 400 }))))
    )
    yield* router.add("POST", "/api/deveagent/loop", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        const { clearLoop, getLoop, pauseLoop, resumeLoop, setLoop } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        const sessionID = typeof payload.sessionID === "string" ? payload.sessionID : undefined
        if (payload.action === "cancel") return HttpServerResponse.jsonUnsafe(clearLoop(sessionID))
        if (payload.action === "pause") return HttpServerResponse.jsonUnsafe(pauseLoop(sessionID))
        if (payload.action === "resume") return HttpServerResponse.jsonUnsafe(resumeLoop(sessionID))
        if (typeof payload.task === "string" && payload.task.trim()) {
          const __setResult = setLoop({
            task: payload.task,
            sessionID,
            directory: payload.directory,
            intervalSeconds: payload.intervalSeconds,
            cron: payload.cron,
            timezone: payload.timezone,
            budgetTokens: payload.budgetTokens,
            budgetCostUsd: payload.budgetCostUsd,
            maxRuns: payload.maxRuns,
            maxRetries: payload.maxRetries,
            maxDurationMinutes: payload.maxDurationMinutes,
          })
          return HttpServerResponse.jsonUnsafe(__setResult)
        }
        return HttpServerResponse.jsonUnsafe(getLoop(sessionID))
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "invalid loop" }, { status: 400 }))))
    )
    yield* router.add("POST", "/api/deveagent/expert", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}") as { id?: string; sessionID?: string }
        const { setDeveAgentExpert } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe(setDeveAgentExpert(payload.id, payload.sessionID))
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "invalid request" }, { status: 400 })))),
    )
    yield* router.add("GET", "/api/deveagent/experts", () =>
      Effect.gen(function* () {
        const { listAllExperts } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe({ experts: listAllExperts() })
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ experts: [] })))),
    )
    yield* router.add("POST", "/api/deveagent/experts", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        const { addCustomExpert } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe(addCustomExpert(payload))
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "invalid request" }, { status: 400 })))),
    )
    yield* router.add("PUT", "/api/deveagent/experts", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}") as { id?: string } & Record<string, unknown>
        const { updateCustomExpert } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        if (!payload.id) return HttpServerResponse.jsonUnsafe({ error: "id required" }, { status: 400 })
        const { id, ...patch } = payload
        const updated = updateCustomExpert(id, patch)
        if (!updated) return HttpServerResponse.jsonUnsafe({ error: "not found" }, { status: 404 })
        return HttpServerResponse.jsonUnsafe(updated)
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "invalid request" }, { status: 400 })))),
    )
    yield* router.add("DELETE", "/api/deveagent/experts", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}") as { id?: string }
        const { deleteCustomExpert } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        if (!payload.id) return HttpServerResponse.jsonUnsafe({ error: "id required" }, { status: 400 })
        return HttpServerResponse.jsonUnsafe({ deleted: deleteCustomExpert(payload.id) })
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "invalid request" }, { status: 400 })))),
    )
    yield* router.add("POST", "/api/deveagent/codegraph/context-pack", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        const { createDeveAgentContextPack, setDeveAgentSessionContextPack } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        const pack = yield* Effect.promise(() => createDeveAgentContextPack(payload))
        setDeveAgentSessionContextPack(typeof payload.sessionID === "string" ? payload.sessionID : undefined, pack)
        return HttpServerResponse.jsonUnsafe(pack)
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "invalid request" }, { status: 400 })))),
    )
    yield* router.add("POST", "/api/deveagent/codegraph/review-scope", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        const { createReviewScope } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        const scope = yield* Effect.promise(() => createReviewScope(payload))
        return HttpServerResponse.jsonUnsafe(scope)
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "invalid request" }, { status: 400 })))),
    )
    yield* router.add("GET", "/api/deveagent/grilling", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const sessionID = new URL(request.url, "http://localhost").searchParams.get("sessionID") || undefined
        const { getGrillingStatus } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe(getGrillingStatus(sessionID))
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ started: false, decisionCount: 0 }))))
    )
    yield* router.add("POST", "/api/deveagent/grilling/complete", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        const sessionID = typeof payload.sessionID === "string" ? payload.sessionID.trim() : ""
        if (!sessionID) return HttpServerResponse.jsonUnsafe({ completed: false, error: "sessionID is required" }, { status: 400 })
        const { completeGrilling } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe(completeGrilling({ sessionID }))
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ completed: false, error: "invalid request" }, { status: 400 }))))
    )
    yield* router.add("POST", "/api/deveagent/obsidian/export", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        const { exportWorkspaceMarkdownForObsidian } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe(yield* Effect.promise(() => exportWorkspaceMarkdownForObsidian({
          directory: typeof payload.directory === "string" ? payload.directory : undefined,
          sourcePath: typeof payload.sourcePath === "string" ? payload.sourcePath : undefined,
        })))
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ exported: false, error: "export failed" }, { status: 400 }))))
    )
    yield* router.add("GET", "/api/deveagent/memory", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const params = new URL(request.url, "http://localhost").searchParams
        const { getDeveAgentMemoryTree } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe(yield* Effect.promise(() => getDeveAgentMemoryTree({
          directory: params.get("directory") || undefined,
          query: params.get("q") || undefined,
        })))
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ entries: [], groups: [], error: "memory unavailable" }, { status: 500 }))))
    )
    yield* router.add("POST", "/api/deveagent/memory/consolidate", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const payload = JSON.parse((yield* Effect.orDie(request.text)) || "{}")
        const { consolidateDeveAgentMemory } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe(yield* Effect.promise(() => consolidateDeveAgentMemory({
          directory: typeof payload.directory === "string" ? payload.directory : undefined,
          limit: typeof payload.limit === "number" ? payload.limit : undefined,
        })))
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ consolidated: false, error: "memory consolidation failed" }, { status: 400 }))))
    )
    yield* router.add("POST", "/api/deveagent/skill-candidates/rollback", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}") as { directory?: unknown; skillPath?: unknown }
        const directory = typeof payload.directory === "string" ? payload.directory : ""
        const skillPath = typeof payload.skillPath === "string" ? payload.skillPath : ""
        if (!directory.trim() || !skillPath.trim()) {
          return HttpServerResponse.jsonUnsafe({ error: "directory and skillPath are required" }, { status: 400 })
        }
        const { rollbackPromotedSkill } = yield* Effect.promise(() => import("../../../../plugin/deveagent-skill-rollback"))
        const result = rollbackPromotedSkill({ directory, skillPath })
        return HttpServerResponse.jsonUnsafe(result, { status: result.rolledBack ? 200 : 409 })
      }).pipe(Effect.catch((error: unknown) => Effect.succeed(HttpServerResponse.jsonUnsafe({ rolledBack: false, error: error instanceof Error ? error.message.slice(0, 300) : "rollback failed" }, { status: 502 }))))),

    yield* router.add("POST", "/api/deveagent/memory/candidate/promote", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const payload = JSON.parse((yield* Effect.orDie(request.text)) || "{}")
        const { promoteDeveAgentMemoryCandidate } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe(yield* Effect.promise(() => promoteDeveAgentMemoryCandidate({
          directory: typeof payload.directory === "string" ? payload.directory : undefined,
          id: typeof payload.id === "string" ? payload.id : undefined,
        })))
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ promoted: false, error: "candidate promotion failed" }, { status: 400 }))))
    )
    yield* router.add("POST", "/api/deveagent/memory/candidate/dismiss", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const payload = JSON.parse((yield* Effect.orDie(request.text)) || "{}")
        const { dismissDeveAgentMemoryCandidate } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe(yield* Effect.promise(() => dismissDeveAgentMemoryCandidate({
          directory: typeof payload.directory === "string" ? payload.directory : undefined,
          id: typeof payload.id === "string" ? payload.id : undefined,
        })))
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ dismissed: false, error: "candidate dismissal failed" }, { status: 400 }))))
    )
    yield* router.add("GET", "/api/deveagent/skill/market", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const params = new URL(request.url, "http://localhost").searchParams
        const query = params.get("q") || ""
        const sources = params.get("sources")?.split(",").map((value) => value.trim()).filter(Boolean)
        const { getDeveAgentSkillMarket } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        const result = yield* Effect.promise(() => getDeveAgentSkillMarket(query, sources))
        return HttpServerResponse.jsonUnsafe(result)
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ entries: [], sources: [] }))))
    )
    yield* router.add("GET", "/api/deveagent/skill/market-sources", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const directory = new URL(request.url, "http://localhost").searchParams.get("directory") || undefined
        const { readDeveAgentSkillMarketPreferences } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe(yield* Effect.promise(() => readDeveAgentSkillMarketPreferences(directory)))
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ version: 1, enabledRepositories: [] }, { status: 400 }))))
    )
    yield* router.add("POST", "/api/deveagent/skill/market-sources", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        const { writeDeveAgentSkillMarketPreferences } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe(yield* Effect.promise(() => writeDeveAgentSkillMarketPreferences({ directory: payload.directory, enabledRepositories: payload.enabledRepositories })))
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "invalid market preferences" }, { status: 400 }))))
    )
    yield* router.add("GET", "/api/deveagent/mcp/market-preferences", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const directory = new URL(request.url, "http://localhost").searchParams.get("directory") || undefined
        const { readDeveAgentMcpMarketPreferences } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe(yield* Effect.promise(() => readDeveAgentMcpMarketPreferences(directory)))
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ version: 1, source: "official", category: "all" }, { status: 400 }))))
    )
    yield* router.add("POST", "/api/deveagent/mcp/market-preferences", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        const { writeDeveAgentMcpMarketPreferences } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe(yield* Effect.promise(() => writeDeveAgentMcpMarketPreferences({
          directory: payload.directory,
          source: payload.source,
          category: payload.category,
        })))
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "invalid MCP market preferences" }, { status: 400 }))))
    )
    yield* router.add("POST", "/api/deveagent/codegraph/index", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        const { createDeveAgentCodeGraphIndex } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe(yield* Effect.promise(() => createDeveAgentCodeGraphIndex(payload)))
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "invalid request" }, { status: 400 })))),
    )
    yield* router.add("POST", "/api/deveagent/codegraph/status", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        const { getDeveAgentCodeGraphIndexStatus } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe(yield* Effect.promise(() => getDeveAgentCodeGraphIndexStatus(payload)))
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "invalid request" }, { status: 400 })))),
    )
    yield* router.add("POST", "/api/deveagent/voice/transcribe", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const payload = JSON.parse((yield* Effect.orDie(request.text)) || "{}") as Record<string, unknown>
        const { getEffectiveAuxiliary, loadSttConfig, transcribeLocalAudio, transcribeOpenAICompatibleAudio } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        // ponytail: an independently configured STT API (deveagent-stt) takes
        // precedence over the auxiliary `speech` provider-registry path below.
        const sttConfig = loadSttConfig(typeof payload.directory === "string" && payload.directory.trim() ? payload.directory : undefined)
        if (sttConfig?.provider === "local-whisper") {
          if (typeof payload.audioBase64 !== "string") {
            return HttpServerResponse.jsonUnsafe({ error: "audioBase64 is required" }, { status: 400 })
          }
          const text = yield* Effect.promise(() => transcribeLocalAudio({
            audioBase64: payload.audioBase64 as string,
            mimeType: typeof payload.mimeType === "string" ? payload.mimeType : undefined,
            language: sttConfig.language ?? (typeof payload.language === "string" ? payload.language : undefined),
          }))
          return HttpServerResponse.jsonUnsafe({
            available: true,
            engine: "local-whisper",
            providerID: "local-whisper",
            modelID: sttConfig.model,
            text,
          })
        }
        if (sttConfig && sttConfig.baseUrl && sttConfig.apiKey && sttConfig.model) {
          if (typeof payload.audioBase64 !== "string") {
            return HttpServerResponse.jsonUnsafe({ error: "audioBase64 is required" }, { status: 400 })
          }
          const text = yield* Effect.promise(() =>
            transcribeOpenAICompatibleAudio({
              baseURL: sttConfig.baseUrl,
              apiKey: sttConfig.apiKey,
              modelID: sttConfig.model,
              audioBase64: payload.audioBase64 as string,
              mimeType: typeof payload.mimeType === "string" ? payload.mimeType : undefined,
              language: sttConfig.language ?? (typeof payload.language === "string" ? payload.language : undefined),
            }),
          )
          return HttpServerResponse.jsonUnsafe({
            available: true,
            engine: "stt-config",
            providerID: sttConfig.provider,
            modelID: sttConfig.model,
            text,
          })
        }
        const speech = getEffectiveAuxiliary(typeof payload.sessionID === "string" ? payload.sessionID : "").speech
        if (!speech) {
          return HttpServerResponse.jsonUnsafe(
            { error: "No speech transcription model is configured. Chromium Web Speech remains available." },
            { status: 409 },
          )
        }
        if (typeof payload.audioBase64 !== "string") {
          return HttpServerResponse.jsonUnsafe({ error: "audioBase64 is required" }, { status: 400 })
        }
        if (typeof payload.directory !== "string" || !payload.directory.trim()) {
          return HttpServerResponse.jsonUnsafe({ error: "directory is required" }, { status: 400 })
        }

        const providerID = ProviderV2.ID.make(speech.providerID)
        const modelID = ModelV2.ID.make(speech.modelID)
        const [provider, model, credential] = yield* instances.provide(
          { directory: payload.directory },
          Effect.all([
            providers.getProvider(providerID),
            providers.getModel(providerID, modelID),
            auth.get(providerID),
          ]),
        )
        const optionHeaders =
          provider.options.headers && typeof provider.options.headers === "object"
            ? Object.fromEntries(Object.entries(provider.options.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
            : {}
        const apiKey =
          credential?.type === "oauth"
            ? credential.access
            : credential?.type === "api"
              ? credential.key
              : credential?.type === "wellknown"
                ? credential.token
                : typeof provider.options.apiKey === "string"
                  ? provider.options.apiKey
                  : provider.key
        const baseURL = typeof provider.options.baseURL === "string" ? provider.options.baseURL : model.api.url
        const text = yield* Effect.promise(() =>
          transcribeOpenAICompatibleAudio({
            baseURL,
            apiKey,
            modelID: model.id,
            audioBase64: payload.audioBase64 as string,
            mimeType: typeof payload.mimeType === "string" ? payload.mimeType : undefined,
            language: typeof payload.language === "string" ? payload.language : undefined,
            headers: { ...optionHeaders, ...model.headers },
          }),
        )
        return HttpServerResponse.jsonUnsafe({
          available: true,
          engine: "openai-compatible",
          providerID,
          modelID,
          text,
        })
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              { error: error instanceof Error ? error.message : "speech transcription failed" },
              { status: 502 },
            ),
          ),
        ),
      ),
    )
    yield* router.add("GET", "/api/deveagent/team", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        const sessionID = url.searchParams.get("sessionID") || undefined
        const directory = url.searchParams.get("directory") || undefined
        const result = yield* instances.provide({ directory: directory || process.cwd() }, Effect.gen(function* () {
          const { getDeveAgentTeam } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
          return getDeveAgentTeam(sessionID)
        }))
        return HttpServerResponse.jsonUnsafe(result)
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "unavailable" })))),
    )
    yield* router.add("GET", "/api/deveagent/markitdown/status", () =>
      Effect.tryPromise(async () => {
        const { getMarkItDownRuntimeStatus } = await import("../../../../deveagent/document-transform")
        return HttpServerResponse.jsonUnsafe(await getMarkItDownRuntimeStatus())
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ available: false, error: "unavailable" })))),
    )
    yield* router.add("GET", "/api/deveagent/message-modes", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        const sessionID = url.searchParams.get("sessionID") || ""
        const { getMessageModes } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        // Read-only view over a bounded in-memory map; no workspace state.
        return HttpServerResponse.jsonUnsafe({ modes: sessionID.startsWith("ses_") ? getMessageModes(sessionID.slice(0, 160)) : {} })
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ modes: {} })))),
    )

    yield* router.add("GET", "/api/deveagent/team-runs", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        const sessionID = url.searchParams.get("sessionID") || undefined
        const directory = url.searchParams.get("directory") || undefined
        const result = yield* instances.provide({ directory: directory || process.cwd() }, Effect.gen(function* () {
          const { getDeveAgentTeamRuns } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
          return getDeveAgentTeamRuns(sessionID)
        }))
        return HttpServerResponse.jsonUnsafe(result)
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "unavailable" })))),
    )
    yield* router.add("GET", "/api/deveagent/goals", () =>
      Effect.tryPromise(async () => {
        const { getGoalQueue } = await import("../../../../plugin/deveagent")
        return HttpServerResponse.jsonUnsafe(getGoalQueue())
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "unavailable" })))),
    )
    yield* router.add("GET", "/api/deveagent/loops", () =>
      Effect.tryPromise(async () => {
        const { getLoopQueue } = await import("../../../../plugin/deveagent")
        return HttpServerResponse.jsonUnsafe(getLoopQueue())
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "unavailable" })))),
    )
    yield* router.add("POST", "/api/deveagent/team", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = JSON.parse(body || "{}")
        const { setDeveAgentTeam } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe(setDeveAgentTeam(payload))
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "invalid request" }, { status: 400 })))),
    )
    // S3: retry the failed members of the latest failed team/moa run for a
    // session. Scoped to the workspace instance like every team route.
    yield* router.add("POST", "/api/deveagent/team/retry", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = yield* Effect.try({
          try: () => JSON.parse(body || "{}") as { sessionID?: unknown; directory?: unknown },
          catch: () => new Error("invalid JSON"),
        })
        const rawSessionID = typeof payload.sessionID === "string" ? payload.sessionID.trim() : ""
        const directory = typeof payload.directory === "string" ? payload.directory.trim() : ""
        if (!rawSessionID || !/^[a-zA-Z0-9._-]{1,160}$/.test(rawSessionID)) {
          return HttpServerResponse.jsonUnsafe({ ok: false, reason: "sessionID is required" }, { status: 400 })
        }
        const result = yield* instances.provide({ directory }, Effect.gen(function* () {
          const { retryFailedTeamMembers } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
          // The retry drives members through the SAME native TaskTool bridge
          // as the dispatch route: read the parent session's last assistant
          // turn (the bridge's permission.ask anchors to it), then re-execute
          // each failed member task for real.
          const retrySessionID = SessionID.make(rawSessionID)
          const parentSession = yield* sessions.get(retrySessionID)
          const history = yield* sessions.messages({ sessionID: retrySessionID, limit: 50 })
          const parentMessage = [...history].reverse().find((message) => message.info.role === "assistant")
          if (!parentMessage || parentMessage.info.role !== "assistant") {
            return HttpServerResponse.jsonUnsafe({ ok: false, reason: "retry requires an existing assistant turn in the parent session" }, { status: 409 })
          }
          const parentAgent = yield* agents.get(parentSession.agent || "build")
          const { context: retryContext } = yield* buildTeamTaskBridge({
            sessionID: retrySessionID,
            parentMessage,
            parentAgent,
            parentSession,
            history,
          })
          return yield* Effect.promise(() => retryFailedTeamMembers({ sessionID: rawSessionID }, retryContext))
        }))
        const failed = result && typeof result === "object" && "ok" in result && result.ok === false
        return HttpServerResponse.jsonUnsafe(result, failed ? { status: 409 } : {})
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ ok: false, reason: "unavailable" })))),
    )

    yield* router.add("POST", "/api/deveagent/team/dispatch", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = yield* Effect.try({
          try: () => JSON.parse(body || "{}") as { sessionID?: unknown; task?: unknown; directory?: unknown },
          catch: () => new Error("invalid JSON"),
        })
        const rawSessionID = typeof payload.sessionID === "string" ? payload.sessionID.trim() : ""
        const task = typeof payload.task === "string" ? payload.task.trim().slice(0, 4_000) : ""
        const directory = typeof payload.directory === "string" ? payload.directory.trim() : ""
        if (!rawSessionID || !task) {
          return HttpServerResponse.jsonUnsafe({ error: "sessionID and task are required" }, { status: 400 })
        }
        if (!/^[a-zA-Z0-9._-]{1,160}$/.test(rawSessionID)) {
          return HttpServerResponse.jsonUnsafe({ error: "invalid sessionID" }, { status: 400 })
        }

        const sessionID = SessionID.make(rawSessionID)
        const runResult = yield* instances.provide({ directory }, Effect.gen(function* () {
          // Use the router's captured services; provide() adds the workspace
          // context, not the application service layer to this request.
          const parentSession = yield* sessions.get(sessionID)
          const history = yield* sessions.messages({ sessionID, limit: 50 })
          const parentMessage = [...history].reverse().find((message) => message.info.role === "assistant")
          if (!parentMessage || parentMessage.info.role !== "assistant") {
            return HttpServerResponse.jsonUnsafe(
              { error: "Team dispatch requires an existing assistant turn in the parent session." },
              { status: 409 },
            )
          }
          const parentAgent = yield* agents.get(parentSession.agent || "build")
          const teamTool = (yield* toolRegistry.all()).find((tool) => tool.id === "team-dispatch-all")
          const nativeTask = (yield* toolRegistry.named()).task
          if (!teamTool) {
            return HttpServerResponse.jsonUnsafe({ error: "DeveAgent Team runtime is unavailable." }, { status: 503 })
          }
  
          const { context, abortController } = yield* buildTeamTaskBridge({
            sessionID,
            parentMessage,
            parentAgent,
            parentSession,
            history,
          })
          const info = yield* background.start({
            type: "task",
            title: `DeveAgent Team: ${task.slice(0, 120)}`,
            metadata: { parentSessionId: sessionID, deveagentTeam: true, background: true },
            run: teamTool.execute({ task }, context).pipe(
              Effect.map((result) => result.output),
              Effect.onInterrupt(() => Effect.sync(() => abortController.abort())),
            ),
          })
          return HttpServerResponse.jsonUnsafe({ jobID: info.id, status: info.status, title: info.title })
        }))
        return runResult
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              { error: error instanceof Error ? error.message.slice(0, 500) : "Team dispatch failed" },
              { status: 502 },
            ),
          ),
        ),
      ),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

const uiRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const client = yield* HttpClient.HttpClient
    const flags = yield* RuntimeFlags.Service
    yield* router.add("*", "/*", (request) =>
      serveUIEffect(request, { fs, client, disableEmbeddedWebUi: flags.disableEmbeddedWebUi }),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

type RouteRequirements =
  | HttpRouter.HttpRouter
  | HttpRouter.Request<"Error", unknown>
  | HttpRouter.Request<"GlobalError", unknown>
  | HttpRouter.Request<"Requires", unknown>
  | HttpRouter.Request<"GlobalRequires", never>

const app = LayerNode.group([
  Npm.node,
  FSUtil.node,
  Database.node,
  Auth.node,
  Account.node,
  Config.node,
  Env.node,
  Git.node,
  Ripgrep.node,
  Storage.node,
  Snapshot.node,
  Plugin.node,
  ModelsDev.node,
  Provider.node,
  ProviderAuth.node,
  Agent.node,
  Skill.node,
  Discovery.node,
  Question.node,
  Permission.node,
  Todo.node,
  Session.node,
  SessionProjector.node,
  SessionStatus.node,
  BackgroundJob.node,
  RuntimeFlags.node,
  EventV2Bridge.node,
  SessionRunState.node,
  SessionProcessor.node,
  SessionCompaction.node,
  SessionRevert.node,
  SessionSummary.node,
  SessionPrompt.node,
  Instruction.node,
  LLM.node,
  LSP.node,
  MCP.node,
  McpAuth.node,
  Command.node,
  Truncate.node,
  ToolRegistry.node,
  Format.node,
  Project.node,
  Vcs.node,
  Workspace.node,
  Worktree.node,
  Installation.node,
  ShareNext.node,
  SessionShare.node,
  InstanceStore.node,
  httpClient,
  EventV2.node,
  ProjectV2.node,
  ProjectCopy.node,
  PtyTicket.node,
])

export function createRoutes(
  corsOptions?: CorsOptions,
): Layer.Layer<never, EffectConfig.ConfigError, RouteRequirements> {
  return Layer.mergeAll(
    rootApiRoutes,
    eventApiRoutes,
    ptyConnectApiRoutes,
    instanceRoutes,
    serverRoutes,
    docRoute,
    deveagentMetricsRoute,
    uiRoute,
  ).pipe(
    Layer.provide([
      errorLayer,
      compressionLayer,
      corsVaryFix,
      fenceLayer,
      cors(corsOptions),
      MoveSession.defaultLayer,
      HttpServer.layerServices,
    ]),
    Layer.provide(LayerNode.buildLayer(app)),
    Layer.provide(Layer.succeed(CorsConfig)(corsOptions)),
    Layer.provide(Observability.layer),
  )
}

export const routes = createRoutes()

export const webHandler = lazy(() =>
  HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    memoMap,
    middleware: disposeMiddleware,
  }),
)

export * as HttpApiApp from "./server"

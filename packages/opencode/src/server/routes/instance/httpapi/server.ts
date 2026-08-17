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
    const workspaces = yield* Workspace.Service
    const background = yield* BackgroundJob.Service
    const agents = yield* Agent.Service
    const permission = yield* Permission.Service
    const sessions = yield* Session.Service
    const sessionPrompt = yield* SessionPrompt.Service
    const toolRegistry = yield* ToolRegistry.Service

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
        const jobs = yield* background.list()
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
          try: () => JSON.parse(body || "{}") as { jobID?: unknown; sessionID?: unknown },
          catch: () => new Error("invalid JSON"),
        })
        const jobID = typeof payload.jobID === "string" ? payload.jobID.trim() : ""
        const sessionID = typeof payload.sessionID === "string" ? payload.sessionID.trim() : ""
        if (!/^[a-zA-Z0-9._-]{1,200}$/.test(jobID)) {
          return HttpServerResponse.jsonUnsafe({ error: "valid jobID is required" }, { status: 400 })
        }
        if (!/^[a-zA-Z0-9._-]{1,160}$/.test(sessionID)) {
          return HttpServerResponse.jsonUnsafe({ error: "valid sessionID is required" }, { status: 400 })
        }
        const job = yield* background.get(jobID)
        if (!job) return HttpServerResponse.jsonUnsafe({ error: "background job not found" }, { status: 404 })
        if (job.type !== "task" || job.metadata?.deveagentTeam !== true) {
          return HttpServerResponse.jsonUnsafe({ error: "only DeveAgent team jobs can be cancelled here" }, { status: 403 })
        }
        if (job.metadata?.parentSessionId !== sessionID) {
          return HttpServerResponse.jsonUnsafe({ error: "job does not belong to this session" }, { status: 403 })
        }
        const cancelled = yield* background.cancel(jobID)
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
        const { STT_PROVIDER_PRESETS, sttStatus } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        return HttpServerResponse.jsonUnsafe({ presets: STT_PROVIDER_PRESETS, status: sttStatus(workspaceParam ?? undefined) })
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
          return HttpServerResponse.jsonUnsafe(setGoal({ description: payload.description, criteria: payload.criteria, sessionID, directory: payload.directory }))
        }
        return HttpServerResponse.jsonUnsafe(getGoal(sessionID))
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "invalid goal" }, { status: 400 }))))
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
          return HttpServerResponse.jsonUnsafe(setLoop({
            task: payload.task,
            sessionID,
            intervalSeconds: payload.intervalSeconds,
            maxRuns: payload.maxRuns,
            maxRetries: payload.maxRetries,
            maxDurationMinutes: payload.maxDurationMinutes,
          }))
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
        const { getEffectiveAuxiliary, loadSttConfig, transcribeOpenAICompatibleAudio } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        // ponytail: an independently configured STT API (deveagent-stt) takes
        // precedence over the auxiliary `speech` provider-registry path below.
        const sttConfig = loadSttConfig(typeof payload.directory === "string" && payload.directory.trim() ? payload.directory : undefined)
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
        const { getDeveAgentTeam } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        const sessionID = new URL(request.url, "http://localhost").searchParams.get("sessionID") || undefined
        return HttpServerResponse.jsonUnsafe(getDeveAgentTeam(sessionID))
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "unavailable" })))),
    )
    yield* router.add("GET", "/api/deveagent/markitdown/status", () =>
      Effect.tryPromise(async () => {
        const { getMarkItDownRuntimeStatus } = await import("../../../../deveagent/document-transform")
        return HttpServerResponse.jsonUnsafe(await getMarkItDownRuntimeStatus())
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ available: false, error: "unavailable" })))),
    )
    yield* router.add("GET", "/api/deveagent/team-runs", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const { getDeveAgentTeamRuns } = yield* Effect.promise(() => import("../../../../plugin/deveagent"))
        const sessionID = new URL(request.url, "http://localhost").searchParams.get("sessionID") || undefined
        return HttpServerResponse.jsonUnsafe(getDeveAgentTeamRuns(sessionID))
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
    yield* router.add("POST", "/api/deveagent/team/dispatch", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Effect.orDie(request.text)
        const payload = yield* Effect.try({
          try: () => JSON.parse(body || "{}") as { sessionID?: unknown; task?: unknown },
          catch: () => new Error("invalid JSON"),
        })
        const rawSessionID = typeof payload.sessionID === "string" ? payload.sessionID.trim() : ""
        const task = typeof payload.task === "string" ? payload.task.trim().slice(0, 4_000) : ""
        if (!rawSessionID || !task) {
          return HttpServerResponse.jsonUnsafe({ error: "sessionID and task are required" }, { status: 400 })
        }
        if (!/^[a-zA-Z0-9._-]{1,160}$/.test(rawSessionID)) {
          return HttpServerResponse.jsonUnsafe({ error: "invalid sessionID" }, { status: 400 })
        }

        const sessionID = SessionID.make(rawSessionID)
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

        const callID = `deveagent-team-${Date.now().toString(36)}`
        const abortController = new AbortController()
        const bridge = yield* EffectBridge.make()
        const context: Tool.Context & {
          runTask: (input: unknown) => Promise<unknown>
          waitTask: (input: { jobID: string; timeout_ms?: number }) => Promise<unknown>
        } = {
          sessionID,
          messageID: parentMessage.info.id,
          agent: parentAgent.name,
          abort: abortController.signal,
          messages: history,
          extra: {
            promptOps: {
              cancel: (childSessionID: SessionID) => sessionPrompt.cancel(childSessionID),
              resolvePromptParts: (template: string) => sessionPrompt.resolvePromptParts(template),
              prompt: (input: Parameters<TaskPromptOps["prompt"]>[0]) => sessionPrompt.prompt(input).pipe(Effect.catch(Effect.die)),
            } satisfies TaskPromptOps,
          },
          metadata: () => Effect.void,
          ask: (input) =>
            permission
              .ask({
                ...input,
                sessionID,
                tool: { messageID: parentMessage.info.id, callID },
                ruleset: Permission.merge(parentAgent.permission, parentSession.permission ?? []),
              })
              .pipe(Effect.orDie),
          runTask: (input) => bridge.promise(nativeTask.execute(input as never, context)),
          waitTask: (input) => bridge.promise(
            Effect.gen(function* () {
              const timeout = typeof input.timeout_ms === "number"
                ? Math.max(1_000, Math.min(10 * 60_000, Math.floor(input.timeout_ms)))
                : undefined
              const waited = yield* background.wait({ id: input.jobID, timeout })
              if (!waited.info) return yield* Effect.fail(new Error("Native background task is unavailable; it may have ended after a server restart."))
              if (waited.timedOut) {
                yield* background.cancel(input.jobID)
                return yield* Effect.fail(new Error(`Task timed out after ${timeout}ms`))
              }
              if (waited.info.status === "error") return yield* Effect.fail(new Error(waited.info.error ?? "Background task failed"))
              if (waited.info.status === "cancelled") return yield* Effect.fail(new Error("Background task cancelled"))
              const childID = typeof waited.info.metadata?.sessionId === "string" ? waited.info.metadata.sessionId : undefined
              const child = childID ? yield* sessions.get(SessionID.make(childID)) : undefined
              return {
                title: waited.info.title ?? "Background task",
                output: waited.info.output ?? "",
                metadata: {
                  ...waited.info.metadata,
                  jobId: waited.info.id,
                  sessionId: childID,
                  usage: child?.tokens,
                  cost: child?.cost,
                },
              }
            }),
          ),
        }
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

import {
  batch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  ParentProps,
  Show,
  untrack,
  type Accessor,
} from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { useLayout, LocalProject } from "@/context/layout"
import { useServerSync } from "@/context/server-sync"
import { Persist, persisted } from "@/utils/persist"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { decode64 } from "@/utils/base64"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Dialog } from "@opencode-ai/ui/dialog"
import { getFilename } from "@opencode-ai/core/util/path"
import { Session, type Message } from "@opencode-ai/sdk/v2/client"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { createStore, produce, reconcile } from "solid-js/store"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { useProviders } from "@/hooks/use-providers"
import { toaster } from "@opencode-ai/ui/toast"
import { setV2Toast, showToast, ToastRegion } from "@/utils/toast"
import { useServerSDK } from "@/context/server-sdk"
import { clearWorkspaceTerminals } from "@/context/terminal"
import { dropSessionCaches, pickSessionCacheEvictions } from "@/context/global-sync/session-cache"
import {
  clearSessionPrefetchInflight,
  clearSessionPrefetch,
  getSessionPrefetch,
  isSessionPrefetchCurrent,
  runSessionPrefetch,
  setSessionPrefetch,
  shouldSkipSessionPrefetch,
} from "@/context/global-sync/session-prefetch"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { type DraftTab, useTabs } from "@/context/tabs"
import { Binary } from "@opencode-ai/core/util/binary"
import { retry } from "@opencode-ai/core/util/retry"
import { playSoundById } from "@/utils/sound"
import { createAim } from "@/utils/aim"
import { setNavigate } from "@/utils/notification-click"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { setSessionHandoff } from "@/pages/session/handoff"
import { SessionRouteKey, SessionStateKey } from "@/utils/server-scope"
import { cancelSessionAutomation } from "@/utils/session-automation"

import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme/context"
import { useCommand, type CommandOption } from "@/context/command"
import { ConstrainDragXAxis, getDraggableId } from "@/utils/solid-dnd"
import { DebugBar } from "@/components/debug-bar"
import { HelpButton } from "@/components/help-button"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { useDirectoryPicker } from "@/components/directory-picker"
import { ServerConnection, useServer } from "@/context/server"
import { useLanguage, type Locale } from "@/context/language"
import { pathKey } from "@/utils/path-key"
import {
  displayName,
  effectiveWorkspaceOrder,
  errorMessage,
  latestRootSession,
  sortedRootSessions,
} from "./layout/helpers"
import {
  collectNewSessionDeepLinks,
  collectOpenProjectDeepLinks,
  deepLinkEvent,
  drainPendingDeepLinks,
} from "./layout/deep-links"
import { createInlineEditorController } from "./layout/inline-editor"
import {
  LocalWorkspace,
  SortableWorkspace,
  WorkspaceDragOverlay,
  type WorkspaceSidebarContext,
} from "./layout/sidebar-workspace"
import { ProjectDragOverlay, SortableProject, type ProjectSidebarContext } from "./layout/sidebar-project"
import { SidebarContent } from "./layout/sidebar-shell"
import { useSessionPrefetch } from "./layout/session-prefetch"
import { DialogDeleteWorkspace, DialogResetWorkspace, type WorkspaceDialogApi } from "./layout/workspace-dialogs"
import { registerLayoutCommands } from "./layout/commands"
import { DeveagentLayoutSidebar } from "@/components/deveagent-layout-sidebar"
import { DeveagentGlobalMarketDrawer } from "@/components/deveagent-global-market-drawer"
import { DeveagentGlobalExpertsDrawer } from "@/components/deveagent-global-experts-drawer"

export default function Layout(props: ParentProps) {
  const serverSDK = useServerSDK()
  const [store, setStore, , ready] = persisted(
    Persist.serverGlobal(serverSDK().scope, "layout.page", ["layout.page.v1"]),
    createStore({
      lastProjectSession: {} as { [directory: string]: { directory: string; id: string; at: number } },
      activeProject: undefined as string | undefined,
      activeWorkspace: undefined as string | undefined,
      workspaceOrder: {} as Record<string, string[]>,
      workspaceName: {} as Record<string, string>,
      workspaceBranchName: {} as Record<string, Record<string, string>>,
      workspaceExpanded: {} as Record<string, boolean>,
      archivedProjects: {} as Record<string, { directory: string; at: number }>,
      hiddenProjects: {} as Record<string, { directory: string; at: number }>,
      pinnedProjects: {} as Record<string, { directory: string; at: number }>,
      gettingStartedDismissed: true,
      deveagentSidebarOpen: true,
    }),
  )

  const pageReady = createMemo(() => ready())
  const deveagentSidebarOpen = () => store.deveagentSidebarOpen !== false
  const setDeveagentSidebarOpen = (open: boolean) => setStore("deveagentSidebarOpen", open)
  const [deveagentProjectsOpen, setDeveagentProjectsOpen] = createSignal(true)
  const [deveagentProjectMenu, setDeveagentProjectMenu] = createSignal<string>()

  let scrollContainerRef: HTMLDivElement | undefined
  let dialogRun = 0
  let dialogDead = false

  const params = useParams()
  const serverSync = useServerSync()
  const layout = useLayout()
  const layoutReady = createMemo(() => layout.ready())
  const platform = usePlatform()
  const pickDirectory = useDirectoryPicker()
  const settings = useSettings()
  const server = useServer()
  const tabs = useTabs()
  const notification = useNotification()
  const permission = usePermission()
  const navigate = useNavigate()
  setNavigate(navigate)
  const providers = useProviders()
  const dialog = useDialog()
  const command = useCommand()
  const theme = useTheme()
  const language = useLanguage()
  const newDesign = createMemo(() => settings.general.newLayoutDesigns())
  createEffect(() => setV2Toast(newDesign()))
  const initialDirectory = decode64(params.dir)
  const location = useLocation()
  const route = createMemo(() => {
    const slug = params.dir
    if (!slug) return { slug, dir: "" }
    const dir = decode64(slug)
    if (!dir) return { slug, dir: "" }
    const store = serverSync().peek(dir, { bootstrap: false })
    return {
      slug,
      store,
      dir: store[0].path.directory || dir,
    }
  })
  const availableThemeEntries = createMemo(() => theme.ids().map((id) => [id, theme.themes()[id]] as const))
  const colorSchemeOrder: ColorScheme[] = ["system", "light", "dark"]
  const colorSchemeKey: Record<ColorScheme, "theme.scheme.system" | "theme.scheme.light" | "theme.scheme.dark"> = {
    system: "theme.scheme.system",
    light: "theme.scheme.light",
    dark: "theme.scheme.dark",
  }
  const colorSchemeLabel = (scheme: ColorScheme) => language.t(colorSchemeKey[scheme])
  const currentDir = createMemo(() => route().dir)
  const openCurrentDirectory = (app?: string) => {
    const directory = currentDir()
    if (!directory) {
      showToast({ variant: "error", title: "没有可打开的工作区", description: "请先选择一个项目。" })
      return
    }
    if (!platform.openPath) {
      showToast({ variant: "error", title: "当前环境不支持打开外部应用", description: directory })
      return
    }
    platform.openPath(directory, app).catch((error: unknown) => {
      showToast({
        variant: "error",
        title: "打开工作区失败",
        description: error instanceof Error ? error.message : String(error),
      })
    })
  }
  const marketDirectory = createMemo(() => {
    if (currentDir()) return currentDir()
    const draftID = location.query.draftId
    if (!draftID) return ""
    const draft = tabs.store.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === draftID)
    return draft?.directory ?? ""
  })

  makeEventListener(window, "deveagent:new-session", () => {
    const directory = currentDir() || serverSync().data.path.directory || serverSync().data.path.home
    if (!directory) {
      showToast({ variant: "error", title: "无法创建新会话", description: "当前没有可用工作目录。" })
      return
    }
    tabs.newDraft({ server: server.key, directory })
  })

  const [state, setState] = createStore({
    autoselect: !initialDirectory && !newDesign(),
    busyWorkspaces: {} as Record<string, boolean>,
    hoverProject: undefined as string | undefined,
    scrollSessionKey: undefined as string | undefined,
    nav: undefined as HTMLElement | undefined,
    sortNow: Date.now(),
    sizing: false,
    peek: undefined as string | undefined,
    peeked: false,
  })

  const updateVersion = () => {
    const state = platform.updater?.state()
    if (state?.status !== "ready") return
    return state.version
  }
  const installUpdate = () => void platform.updater?.install()
  const titlebarUpdate: TitlebarUpdate = {
    version: updateVersion,
    installing: () => platform.updater?.state().status === "installing",
    install: installUpdate,
  }

  const editor = createInlineEditorController()
  const setBusy = (directory: string, value: boolean) => {
    const key = pathKey(directory)
    if (value) {
      setState("busyWorkspaces", key, true)
      return
    }
    setState(
      "busyWorkspaces",
      produce((draft) => {
        delete draft[key]
      }),
    )
  }
  const isBusy = (directory: string) => !!state.busyWorkspaces[pathKey(directory)]
  const navLeave = { current: undefined as number | undefined }
  const sortNow = () => state.sortNow
  let sizet: number | undefined
  let sortNowInterval: ReturnType<typeof setInterval> | undefined
  const sortNowTimeout = setTimeout(
    () => {
      setState("sortNow", Date.now())
      sortNowInterval = setInterval(() => setState("sortNow", Date.now()), 60_000)
    },
    60_000 - (Date.now() % 60_000),
  )

  const aim = createAim({
    enabled: () => !layout.sidebar.opened(),
    active: () => state.hoverProject,
    el: () => state.nav?.querySelector<HTMLElement>("[data-component='sidebar-rail']") ?? state.nav,
    onActivate: (directory) => {
      serverSync().child(directory)
      setState("hoverProject", directory)
    },
  })

  onCleanup(() => {
    dialogDead = true
    dialogRun += 1
    if (navLeave.current !== undefined) clearTimeout(navLeave.current)
    clearTimeout(sortNowTimeout)
    if (sortNowInterval) clearInterval(sortNowInterval)
    if (sizet !== undefined) clearTimeout(sizet)
    if (peekt !== undefined) clearTimeout(peekt)
    aim.reset()
  })

  onMount(() => {
    const stop = () => setState("sizing", false)
    const blur = () => reset()
    const hide = () => {
      if (document.visibilityState !== "hidden") return
      reset()
    }
    makeEventListener(window, "pointerup", stop)
    makeEventListener(window, "pointercancel", stop)
    makeEventListener(window, "blur", stop)
    makeEventListener(window, "blur", blur)
    makeEventListener(document, "visibilitychange", hide)
  })

  const sidebarHovering = createMemo(() => !layout.sidebar.opened() && state.hoverProject !== undefined)
  const sidebarExpanded = createMemo(() => layout.sidebar.opened() || sidebarHovering())
  const setHoverProject = (value: string | undefined) => {
    setState("hoverProject", value)
    if (value !== undefined) return
    aim.reset()
  }
  const clearHoverProjectSoon = () => queueMicrotask(() => setHoverProject(undefined))

  const disarm = () => {
    if (navLeave.current === undefined) return
    clearTimeout(navLeave.current)
    navLeave.current = undefined
  }

  const reset = () => {
    disarm()
    setHoverProject(undefined)
  }

  const arm = () => {
    if (layout.sidebar.opened()) return
    if (state.hoverProject === undefined) return
    disarm()
    navLeave.current = window.setTimeout(() => {
      navLeave.current = undefined
      setHoverProject(undefined)
    }, 300)
  }

  let peekt: number | undefined

  const hoverProjectData = createMemo(() => {
    const id = state.hoverProject
    if (!id) return
    return layout.projects.list().find((project) => project.worktree === id)
  })

  const peekProject = createMemo(() => {
    const id = state.peek
    if (!id) return
    return layout.projects.list().find((project) => project.worktree === id)
  })

  createEffect(() => {
    const p = hoverProjectData()
    if (p) {
      if (peekt !== undefined) {
        clearTimeout(peekt)
        peekt = undefined
      }
      setState("peek", p.worktree)
      setState("peeked", true)
      return
    }

    setState("peeked", false)
    if (state.peek === undefined) return
    if (peekt !== undefined) clearTimeout(peekt)
    peekt = window.setTimeout(() => {
      peekt = undefined
      setState("peek", undefined)
    }, 180)
  })

  createEffect(() => {
    if (!layout.sidebar.opened()) return
    setHoverProject(undefined)
  })

  createEffect(() => {
    if (!state.autoselect) return
    const dir = params.dir
    if (!dir) return
    const directory = decode64(dir)
    if (!directory) return
    setState("autoselect", false)
  })

  const editorOpen = editor.editorOpen
  const openEditor = editor.openEditor
  const closeEditor = editor.closeEditor
  const setEditor = editor.setEditor
  const InlineEditor = editor.InlineEditor

  const clearSidebarHoverState = () => {
    if (layout.sidebar.opened()) return
    reset()
  }

  const navigateWithSidebarReset = (href: string) => {
    clearSidebarHoverState()
    navigate(href)
    layout.mobileSidebar.hide()
  }

  const useSDKNotificationToasts = () =>
    onMount(() => {
      const toastBySession = new Map<string, number>()
      const alertedAtBySession = new Map<string, number>()
      const cooldownMs = 5000

      const dismissSessionAlert = (sessionKey: string) => {
        const toastId = toastBySession.get(sessionKey)
        if (toastId === undefined) return
        toaster.dismiss(toastId)
        toastBySession.delete(sessionKey)
        alertedAtBySession.delete(sessionKey)
      }

      const unsub = serverSDK().event.listen((e) => {
        if (e.details?.type === "worktree.ready") {
          setBusy(e.name, false)
          WorktreeState.ready(serverSDK().scope, e.name)
          return
        }

        if (e.details?.type === "worktree.failed") {
          setBusy(e.name, false)
          WorktreeState.failed(
            serverSDK().scope,
            e.name,
            e.details.properties?.message ?? language.t("common.requestFailed"),
          )
          return
        }

        if (
          e.details?.type === "question.replied" ||
          e.details?.type === "question.rejected" ||
          e.details?.type === "permission.replied"
        ) {
          const props = e.details.properties as { sessionID: string }
          const sessionKey = `${e.name}:${props.sessionID}`
          dismissSessionAlert(sessionKey)
          return
        }

        if (e.details?.type !== "permission.asked" && e.details?.type !== "question.asked") return
        const title =
          e.details.type === "permission.asked"
            ? language.t("notification.permission.title")
            : language.t("notification.question.title")
        const icon = e.details.type === "permission.asked" ? ("checklist" as const) : ("bubble-5" as const)
        const directory = e.name
        const props = e.details.properties
        if (e.details.type === "permission.asked" && permission.autoResponds(e.details.properties, directory)) return

        const [store] = serverSync().child(directory, { bootstrap: false })
        const session = store.session.find((s) => s.id === props.sessionID)
        const sessionKey = `${directory}:${props.sessionID}`

        const sessionTitle = session?.title ?? language.t("command.session.new")
        const projectName = getFilename(directory)
        const description =
          e.details.type === "permission.asked"
            ? language.t("notification.permission.description", { sessionTitle, projectName })
            : language.t("notification.question.description", { sessionTitle, projectName })
        const href = `/${base64Encode(directory)}/session/${props.sessionID}`

        const now = Date.now()
        const lastAlerted = alertedAtBySession.get(sessionKey) ?? 0
        if (now - lastAlerted < cooldownMs) return
        alertedAtBySession.set(sessionKey, now)

        if (e.details.type === "permission.asked") {
          if (settings.sounds.permissionsEnabled()) {
            void playSoundById(settings.sounds.permissions())
          }
          if (settings.notifications.permissions()) {
            void platform.notify(title, description, href)
          }
        }

        if (e.details.type === "question.asked") {
          if (settings.notifications.agent()) {
            void platform.notify(title, description, href)
          }
        }

        const currentSession = params.id
        if (pathKey(directory) === pathKey(currentDir()) && props.sessionID === currentSession) return
        if (pathKey(directory) === pathKey(currentDir()) && session?.parentID === currentSession) return

        dismissSessionAlert(sessionKey)

        const toastId = showToast({
          persistent: true,
          icon,
          title,
          description,
          actions: [
            {
              label: language.t("notification.action.goToSession"),
              onClick: () => navigate(href),
            },
            {
              label: language.t("common.dismiss"),
              onClick: "dismiss",
            },
          ],
        })
        toastBySession.set(sessionKey, toastId)
      })
      onCleanup(unsub)

      createEffect(() => {
        const currentSession = params.id
        if (!currentDir() || !currentSession) return
        const sessionKey = `${currentDir()}:${currentSession}`
        dismissSessionAlert(sessionKey)
        const [store] = serverSync().child(currentDir(), { bootstrap: false })
        const childSessions = store.session.filter((s) => s.parentID === currentSession)
        for (const child of childSessions) {
          dismissSessionAlert(`${currentDir()}:${child.id}`)
        }
      })
    })

  useSDKNotificationToasts()

  function scrollToSession(sessionId: string, sessionKey: string) {
    if (!scrollContainerRef) return
    if (state.scrollSessionKey === sessionKey) return
    const element = scrollContainerRef.querySelector(`[data-session-id="${sessionId}"]`)
    if (!element) return
    const containerRect = scrollContainerRef.getBoundingClientRect()
    const elementRect = element.getBoundingClientRect()
    if (elementRect.top >= containerRect.top && elementRect.bottom <= containerRect.bottom) {
      setState("scrollSessionKey", sessionKey)
      return
    }
    setState("scrollSessionKey", sessionKey)
    element.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }

  const currentProject = createMemo(() => {
    const directory = currentDir()
    if (!directory) return
    const key = pathKey(directory)

    const projects = layout.projects.list()

    const sandbox = projects.find((p) => p.sandboxes?.some((item) => pathKey(item) === key))
    if (sandbox) return sandbox

    const direct = projects.find((p) => pathKey(p.worktree) === key)
    if (direct) return direct

    const [child] = serverSync().child(directory, { bootstrap: false })
    const id = child.project
    if (!id) return

    const meta = serverSync().data.project.find((p) => p.id === id)
    const root = meta?.worktree
    if (!root) return

    return projects.find((p) => p.worktree === root)
  })

  const [autoselecting] = createResource(async () => {
    await ready.promise
    await layout.ready.promise
    if (!untrack(() => state.autoselect)) return

    const list = layout.projects.list().filter((project) => !store.hiddenProjects[pathKey(projectRoot(project.worktree))])
    const last = server.projects.last()

    if (list.length === 0) {
      return
    } else {
      const next = list.find((project) => project.worktree === last) ?? list[0]
      if (!next) return
      await openProject(next.worktree, true)
    }
  })

  const workspaceName = (directory: string, projectId?: string, branch?: string) => {
    const key = pathKey(directory)
    const direct = store.workspaceName[key] ?? store.workspaceName[directory]
    if (direct) return direct
    if (!projectId) return
    if (!branch) return
    return store.workspaceBranchName[projectId]?.[branch]
  }

  const setWorkspaceName = (directory: string, next: string, projectId?: string, branch?: string) => {
    const key = pathKey(directory)
    setStore("workspaceName", key, next)
    if (!projectId) return
    if (!branch) return
    if (!store.workspaceBranchName[projectId]) {
      setStore("workspaceBranchName", projectId, {})
    }
    setStore("workspaceBranchName", projectId, branch, next)
  }

  const workspaceLabel = (directory: string, branch?: string, projectId?: string) =>
    workspaceName(directory, projectId, branch) ?? branch ?? getFilename(directory)

  const workspaceSetting = createMemo(() => {
    const project = currentProject()
    if (!project) return false
    if (project.vcs !== "git") return false
    return layout.sidebar.workspaces(project.worktree)()
  })

  const visibleSessionDirs = createMemo(() => {
    const project = currentProject()
    if (!project) return [] as string[]
    if (!workspaceSetting()) return [project.worktree]

    const activeDir = currentDir()
    return workspaceIds(project).filter((directory) => {
      const expanded = store.workspaceExpanded[directory] ?? directory === project.worktree
      const active = pathKey(directory) === pathKey(activeDir)
      return expanded || active
    })
  })

  createEffect(() => {
    if (!pageReady()) return
    if (!layoutReady()) return
    const projects = layout.projects.list()
    for (const [directory, expanded] of Object.entries(store.workspaceExpanded)) {
      if (!expanded) continue
      const key = pathKey(directory)
      const project = projects.find(
        (item) => pathKey(item.worktree) === key || item.sandboxes?.some((sandbox) => pathKey(sandbox) === key),
      )
      if (!project) continue
      if (project.vcs === "git" && layout.sidebar.workspaces(project.worktree)()) continue
      setStore("workspaceExpanded", directory, false)
    }
  })

  const currentSessions = createMemo(() => {
    const now = Date.now()
    const dirs = visibleSessionDirs()
    if (dirs.length === 0) return [] as Session[]

    const result: Session[] = []
    for (const dir of dirs) {
      const [dirStore] = serverSync().child(dir, { bootstrap: true })
      const dirSessions = sortedRootSessions(dirStore, now)
      result.push(...dirSessions)
    }
    return result
  })

  const { prefetchSession, warm } = useSessionPrefetch({
    visibleSessionDirs,
    currentSessions,
    route,
    params: () => params,
    currentDir,
  })

  function navigateSessionByOffset(offset: number) {
    const sessions = currentSessions()
    if (sessions.length === 0) return

    const sessionIndex = params.id ? sessions.findIndex((s) => s.id === params.id) : -1

    let targetIndex: number
    if (sessionIndex === -1) {
      targetIndex = offset > 0 ? 0 : sessions.length - 1
    } else {
      targetIndex = (sessionIndex + offset + sessions.length) % sessions.length
    }

    const session = sessions[targetIndex]
    if (!session) return

    prefetchSession(session, "high")
    warm(sessions, targetIndex)

    navigateToSession(session)
  }

  function navigateProjectByOffset(offset: number) {
    const projects = layout.projects.list()
    if (projects.length === 0) return

    const current = currentProject()?.worktree
    const fallback = currentDir() ? projectRoot(currentDir()) : undefined
    const active = current ?? fallback
    const index = active ? projects.findIndex((project) => project.worktree === active) : -1

    const target =
      index === -1
        ? offset > 0
          ? projects[0]
          : projects[projects.length - 1]
        : projects[(index + offset + projects.length) % projects.length]
    if (!target) return

    // warm up child store to prevent flicker
    serverSync().child(target.worktree)
    void openProject(target.worktree)
  }

  function navigateToProjectIndex(index: number) {
    const projects = layout.projects.list()
    const target = projects[index]
    if (!target) return

    serverSync().child(target.worktree)
    void openProject(target.worktree)
  }

  function navigateSessionByUnseen(offset: number) {
    const sessions = currentSessions()
    if (sessions.length === 0) return

    const hasUnseen = sessions.some((session) => notification.session.unseenCount(session.id) > 0)
    if (!hasUnseen) return

    const activeIndex = params.id ? sessions.findIndex((s) => s.id === params.id) : -1
    const start = activeIndex === -1 ? (offset > 0 ? -1 : 0) : activeIndex

    for (let i = 1; i <= sessions.length; i++) {
      const index = offset > 0 ? (start + i) % sessions.length : (start - i + sessions.length) % sessions.length
      const session = sessions[index]
      if (!session) continue
      if (notification.session.unseenCount(session.id) === 0) continue

      prefetchSession(session, "high")
      warm(sessions, index)

      navigateToSession(session)
      return
    }
  }

  async function archiveSession(session: Session) {
    const [store, setStore] = serverSync().child(session.directory)
    const sessions = store.session ?? []
    const index = sessions.findIndex((s) => s.id === session.id)
    const nextSession = sessions[index + 1] ?? sessions[index - 1]

    await serverSDK().client.session.update({
      directory: session.directory,
      sessionID: session.id,
      time: { archived: Date.now() },
    })
    setStore(
      produce((draft) => {
        const match = Binary.search(draft.session, session.id, (s) => s.id)
        if (match.found) draft.session.splice(match.index, 1)
      }),
    )
    if (session.id === params.id) {
      if (nextSession) {
        navigate(`/${params.dir}/session/${nextSession.id}`)
      } else {
        navigate(`/${params.dir}/session`)
      }
    }
  }

  function connectProvider() {
    const run = ++dialogRun
    void import("@/components/dialog-select-provider").then((x) => {
      if (dialogDead || dialogRun !== run) return
      dialog.show(() => <x.DialogSelectProvider />)
    })
  }

  function openServer() {
    const run = ++dialogRun
    void import("@/components/dialog-select-server").then((x) => {
      if (dialogDead || dialogRun !== run) return
      dialog.show(() => <x.DialogSelectServer />)
    })
  }

  function openSettings() {
    const run = ++dialogRun
    const module = settings.general.newLayoutDesigns()
      ? import("@/components/settings-v2")
      : import("@/components/dialog-settings")
    void module.then((x) => {
      if (dialogDead || dialogRun !== run) return
      dialog.show(() => <x.DialogSettings />)
    })
  }

  function projectRoot(directory: string) {
    const key = pathKey(directory)
    const project = layout.projects
      .list()
      .find((item) => pathKey(item.worktree) === key || item.sandboxes?.some((sandbox) => pathKey(sandbox) === key))
    if (project) return project.worktree

    const known = Object.entries(store.workspaceOrder).find(
      ([root, dirs]) => pathKey(root) === key || dirs.some((item) => pathKey(item) === key),
    )
    if (known) return known[0]

    const [child] = serverSync().child(directory, { bootstrap: false })
    const id = child.project
    if (!id) return directory

    const meta = serverSync().data.project.find((item) => item.id === id)
    return meta?.worktree ?? directory
  }

  function activeProjectRoot(directory: string) {
    return currentProject()?.worktree ?? projectRoot(directory)
  }

  function rememberSessionRoute(directory: string, id: string, root = activeProjectRoot(directory)) {
    setStore("lastProjectSession", root, { directory, id, at: Date.now() })
    return root
  }

  function clearLastProjectSession(root: string) {
    if (!store.lastProjectSession[root]) return
    setStore(
      "lastProjectSession",
      produce((draft) => {
        delete draft[root]
      }),
    )
  }

  function syncSessionRoute(directory: string, id: string, root = activeProjectRoot(directory)) {
    rememberSessionRoute(directory, id, root)
    notification.session.markViewed(id)
    const expanded = untrack(() => store.workspaceExpanded[directory])
    if (expanded === false) {
      setStore("workspaceExpanded", directory, true)
    }
    requestAnimationFrame(() => scrollToSession(id, `${directory}:${id}`))
    return root
  }

  async function navigateToProject(directory: string | undefined) {
    if (!directory) return
    const root = projectRoot(directory)
    server.projects.touch(root)
    const project = layout.projects.list().find((item) => item.worktree === root)
    let dirs = project
      ? effectiveWorkspaceOrder(root, [root, ...(project.sandboxes ?? [])], store.workspaceOrder[root])
      : [root]
    const canOpen = (value: string | undefined) => {
      if (!value) return false
      return dirs.some((item) => pathKey(item) === pathKey(value))
    }
    const refreshDirs = async (target?: string) => {
      if (!target || target === root || canOpen(target)) return canOpen(target)
      const listed = await serverSDK()
        .client.worktree.list({ directory: root })
        .then((x) => x.data ?? [])
        .catch(() => [] as string[])
      dirs = effectiveWorkspaceOrder(root, [root, ...listed], store.workspaceOrder[root])
      return canOpen(target)
    }
    const openSession = async (target: { directory: string; id: string }) => {
      if (!canOpen(target.directory)) return false
      const [data] = serverSync().child(target.directory, { bootstrap: false })
      if (data.session.some((item) => item.id === target.id)) {
        setStore("lastProjectSession", root, { directory: target.directory, id: target.id, at: Date.now() })
        navigateWithSidebarReset(`/${base64Encode(target.directory)}/session/${target.id}`)
        return true
      }
      const resolved = await serverSDK()
        .client.session.get({ sessionID: target.id })
        .then((x) => x.data)
        .catch(() => undefined)
      if (!resolved?.directory) return false
      if (!canOpen(resolved.directory)) return false
      setStore("lastProjectSession", root, { directory: resolved.directory, id: resolved.id, at: Date.now() })
      navigateWithSidebarReset(`/${base64Encode(resolved.directory)}/session/${resolved.id}`)
      return true
    }

    const projectSession = store.lastProjectSession[root]
    if (projectSession?.id) {
      await refreshDirs(projectSession.directory)
      const opened = await openSession(projectSession)
      if (opened) return
      clearLastProjectSession(root)
    }

    const latest = latestRootSession(
      dirs.map((item) => serverSync().child(item, { bootstrap: false })[0]),
      Date.now(),
    )
    if (latest && (await openSession(latest))) {
      return
    }

    const fetched = latestRootSession(
      await Promise.all(
        dirs.map(async (item) => ({
          path: { directory: item },
          session: await serverSDK()
            .client.session.list({ directory: item })
            .then((x) => x.data ?? [])
            .catch(() => []),
        })),
      ),
      Date.now(),
    )
    if (fetched && (await openSession(fetched))) {
      return
    }

    navigateWithSidebarReset(`/${base64Encode(root)}/session`)
  }

  function navigateToSession(session: Session | undefined) {
    if (!session) return
    navigateWithSidebarReset(`/${base64Encode(session.directory)}/session/${session.id}`)
  }

  let projectOpenRequest = 0
  async function loadProjectSessionsWithRetry(directory: string) {
    const loaded = await serverSync().project.loadSessions(directory)
    if (loaded !== false) return true

    // A cold desktop start can race the first sidecar/session request. Give
    // the already-open project one quiet retry before abandoning navigation.
    await new Promise<void>((resolve) => setTimeout(resolve, 180))
    return serverSync().project.loadSessions(directory, { notifyOnError: false })
  }

  async function openProject(directory: string, navigate = true) {
    const request = ++projectOpenRequest
    if (navigate) setState("autoselect", false)
    // Keep route selection after project/session state is ready. The desktop
    // shell uses a memory router, so an early navigation can be overwritten by
    // the project bootstrap and leave the user on Home.
    layout.projects.open(directory)
    await loadProjectSessionsWithRetry(directory)
    if (request !== projectOpenRequest) return
    const rootKey = pathKey(projectRoot(directory))
    if (store.archivedProjects[rootKey] || store.hiddenProjects[rootKey]) {
      setStore(
        produce((draft) => {
          delete draft.archivedProjects[rootKey]
          delete draft.hiddenProjects[rootKey]
        }),
      )
    }
    if (navigate) return navigateToProject(directory)
  }

  const handleDeepLinks = async (urls: string[]) => {
    if (!server.isLocal()) return

    // Deep links are an explicit user target. Disable startup auto-selection
    // before entering the route so a late project bootstrap cannot navigate
    // back to Home and overwrite the requested project.
    if (collectOpenProjectDeepLinks(urls).length > 0 || collectNewSessionDeepLinks(urls).length > 0) {
      setState("autoselect", false)
    }

    for (const directory of collectOpenProjectDeepLinks(urls)) {
      await openProject(directory)
    }

    for (const link of collectNewSessionDeepLinks(urls)) {
      // Use the same awaited project/session bootstrap as a sidebar project
      // click before entering the requested new-session route.
      await openProject(link.directory, false)
      const slug = base64Encode(link.directory)
      if (link.prompt) {
        setSessionHandoff(SessionStateKey.from(server.scope(), SessionRouteKey.fromLegacy(slug)), {
          prompt: link.prompt,
        })
      }
      const href = link.prompt ? `/${slug}/session?prompt=${encodeURIComponent(link.prompt)}` : `/${slug}/session`
      navigateWithSidebarReset(href)
    }
  }

  onMount(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ urls: string[] }>).detail
      const urls = detail?.urls ?? []
      if (urls.length === 0) return
      void handleDeepLinks(urls)
    }

    void handleDeepLinks(drainPendingDeepLinks(window))
    makeEventListener(window, deepLinkEvent, handler as EventListener)
  })

  async function renameProject(project: LocalProject, next: string) {
    const current = displayName(project)
    if (next === current) return
    const name = next === getFilename(project.worktree) ? "" : next

    if (project.id && project.id !== "global") {
      await serverSDK().client.project.update({ projectID: project.id, directory: project.worktree, name })
      return
    }

    serverSync().project.meta(project.worktree, { name })
  }

  const renameWorkspace = (directory: string, next: string, projectId?: string, branch?: string) => {
    const current = workspaceName(directory, projectId, branch) ?? branch ?? getFilename(directory)
    if (current === next) return
    setWorkspaceName(directory, next, projectId, branch)
  }

  function closeProject(directory: string) {
    projectOpenRequest += 1
    const list = layout.projects.list()
    const key = pathKey(directory)
    const index = list.findIndex((x) => pathKey(x.worktree) === key)
    const active = pathKey(currentProject()?.worktree ?? "") === key
    if (index === -1) return

    if (!active) {
      layout.projects.close(directory)
      return
    }

    if (list.length === 1) {
      layout.projects.close(directory)
      navigate("/")
      return
    }

    const next = list[index + 1] ?? list[index - 1]

    navigateWithSidebarReset(`/${base64Encode(next.worktree)}/session`)
    layout.projects.close(directory)
    queueMicrotask(() => {
      void navigateToProject(next.worktree)
    })
  }

  function archiveProject(directory: string) {
    const root = projectRoot(directory)
    const key = pathKey(root)
    setDeveagentProjectMenu(undefined)
    // Pointer activation can reach both the headless menu select handler and
    // the native click fallback. Keep the state transition idempotent so a
    // single user click cannot close/reopen the project twice.
    if (store.archivedProjects[key]) return
    setStore("archivedProjects", key, { directory: root, at: Date.now() })
    queueMicrotask(() => closeProject(root))
  }

  function forgetProjectEntry(directory: string) {
    const root = projectRoot(directory)
    const key = pathKey(root)
    setDeveagentProjectMenu(undefined)
    setStore(
      "archivedProjects",
      produce((draft) => {
        delete draft[key]
      }),
    )
    setStore("hiddenProjects", key, { directory: root, at: Date.now() })
    closeProject(root)
  }

  function toggleProjectWorkspaces(project: LocalProject) {
    const enabled = layout.sidebar.workspaces(project.worktree)()
    if (enabled) {
      layout.sidebar.toggleWorkspaces(project.worktree)
      return
    }
    if (project.vcs !== "git") return
    layout.sidebar.toggleWorkspaces(project.worktree)
  }

  const showEditProjectDialog = (conn: ServerConnection.Any, project: LocalProject) => {
    const run = ++dialogRun
    void import("@/components/dialog-edit-project").then((x) => {
      if (dialogDead || dialogRun !== run) return
      dialog.show(() => <x.DialogEditProject server={conn} project={project} />)
    })
  }

  function chooseProject() {
    const conn = server.current
    if (!conn) return
    function resolve(result: string | string[] | null) {
      if (Array.isArray(result)) {
        for (const directory of result) {
          void openProject(directory, false)
        }
        void navigateToProject(result[0])
      } else if (result) {
        void openProject(result)
      }
    }

    pickDirectory({
      server: conn,
      title: language.t("command.project.open"),
      multiple: true,
      onSelect: resolve,
    })
  }

  const deleteWorkspace = async (root: string, directory: string, leaveDeletedWorkspace = false) => {
    if (directory === root) return

    const current = currentDir()
    const currentKey = pathKey(current)
    const deletedKey = pathKey(directory)
    const shouldLeave = leaveDeletedWorkspace || (!!params.dir && currentKey === deletedKey)
    if (!leaveDeletedWorkspace && shouldLeave) {
      navigateWithSidebarReset(`/${base64Encode(root)}/session`)
    }

    setBusy(directory, true)

    const result = await serverSDK()
      .client.worktree.remove({ directory: root, worktreeRemoveInput: { directory } })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("workspace.delete.failed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return false
      })

    setBusy(directory, false)

    if (!result) return

    if (pathKey(store.lastProjectSession[root]?.directory ?? "") === pathKey(directory)) {
      clearLastProjectSession(root)
    }

    serverSync().set(
      "project",
      produce((draft) => {
        const project = draft.find((item) => item.worktree === root)
        if (!project) return
        project.sandboxes = (project.sandboxes ?? []).filter((sandbox) => sandbox !== directory)
      }),
    )
    setStore("workspaceOrder", root, (order) => (order ?? []).filter((workspace) => workspace !== directory))

    layout.projects.close(directory)
    layout.projects.open(root)

    if (shouldLeave) return

    const nextCurrent = currentDir()
    const nextKey = pathKey(nextCurrent)
    const project = layout.projects.list().find((item) => item.worktree === root)
    const dirs = project
      ? effectiveWorkspaceOrder(root, [root, ...(project.sandboxes ?? [])], store.workspaceOrder[root])
      : [root]
    const valid = dirs.some((item) => pathKey(item) === nextKey)

    if (params.dir && projectRoot(nextCurrent) === root && !valid) {
      navigateWithSidebarReset(`/${base64Encode(root)}/session`)
    }
  }

  const resetWorkspace = async (root: string, directory: string) => {
    if (directory === root) return
    setBusy(directory, true)

    const progress = showToast({
      persistent: true,
      title: language.t("workspace.resetting.title"),
      description: language.t("workspace.resetting.description"),
    })
    const dismiss = () => toaster.dismiss(progress)

    const sessions: Session[] = await serverSDK()
      .client.session.list({ directory })
      .then((x) => x.data ?? [])
      .catch(() => [])

    clearWorkspaceTerminals(
      directory,
      sessions.map((s) => s.id),
      platform,
      serverSDK().scope,
    )
    await serverSDK()
      .client.instance.dispose({ directory })
      .catch(() => undefined)

    const result = await serverSDK()
      .client.worktree.reset({ directory: root, worktreeResetInput: { directory } })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("workspace.reset.failed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return false
      })

    if (!result) {
      setBusy(directory, false)
      dismiss()
      return
    }

    const archivedAt = Date.now()
    await Promise.all(
      sessions
        .filter((session) => session.time.archived === undefined)
        .map((session) =>
          serverSDK()
            .client.session.update({
              sessionID: session.id,
              directory: session.directory,
              time: { archived: archivedAt },
            })
            .catch(() => undefined),
        ),
    )

    setBusy(directory, false)
    dismiss()

    showToast({
      title: language.t("workspace.reset.success.title"),
      description: language.t("workspace.reset.success.description"),
      actions: [
        {
          label: language.t("command.session.new"),
          onClick: () => {
            const href = `/${base64Encode(directory)}/session`
            navigate(href)
            layout.mobileSidebar.hide()
          },
        },
        {
          label: language.t("common.dismiss"),
          onClick: "dismiss",
        },
      ],
    })
  }



  const activeRoute = {
    session: "",
    sessionProject: "",
    directory: "",
  }

  createEffect(
    on(
      () => {
        return [pageReady(), route().slug, params.id, currentProject()?.worktree, currentDir()] as const
      },
      ([ready, slug, id, root, dir]) => {
        if (!ready || !slug || !dir) {
          activeRoute.session = ""
          activeRoute.sessionProject = ""
          activeRoute.directory = ""
          return
        }

        if (!id) {
          activeRoute.session = ""
          activeRoute.sessionProject = ""
          activeRoute.directory = ""
          return
        }

        const session = `${slug}/${id}`

        if (!root) {
          activeRoute.session = session
          activeRoute.directory = dir
          activeRoute.sessionProject = ""
          return
        }

        if (server.projects.last() !== root) server.projects.touch(root)

        const changed = session !== activeRoute.session || dir !== activeRoute.directory
        if (changed) {
          activeRoute.session = session
          activeRoute.directory = dir
          activeRoute.sessionProject = syncSessionRoute(dir, id, root)
          return
        }

        if (root === activeRoute.sessionProject) return
        activeRoute.directory = dir
        activeRoute.sessionProject = rememberSessionRoute(dir, id, root)
      },
    ),
  )

  createEffect(() => {
    document.documentElement.style.setProperty(
      "--dialog-left-margin",
      newDesign() ? "0px" : `${layout.sidebar.opened() ? layout.sidebar.width() : 48}px`,
    )
  })

  const side = createMemo(() => Math.max(layout.sidebar.width(), 244))
  const panel = createMemo(() => Math.max(side() - 64, 0))

  const loadedSessionDirs = new Set<string>()

  createEffect(
    on(
      visibleSessionDirs,
      (dirs) => {
        if (dirs.length === 0) {
          loadedSessionDirs.clear()
          return
        }

        const next = new Set(dirs)
        for (const directory of next) {
          if (loadedSessionDirs.has(directory)) continue
          void serverSync().project.loadSessions(directory, { notifyOnError: false })
        }

        loadedSessionDirs.clear()
        for (const directory of next) {
          loadedSessionDirs.add(directory)
        }
      },
      { defer: true },
    ),
  )

  function handleDragStart(event: unknown) {
    const id = getDraggableId(event)
    if (!id) return
    setHoverProject(undefined)
    setStore("activeProject", id)
  }

  function handleDragOver(event: DragEvent) {
    const { draggable, droppable } = event
    if (draggable && droppable) {
      const projects = layout.projects.list()
      const fromIndex = projects.findIndex((p) => p.worktree === draggable.id.toString())
      const toIndex = projects.findIndex((p) => p.worktree === droppable.id.toString())
      if (fromIndex !== toIndex && toIndex !== -1) {
        layout.projects.move(draggable.id.toString(), toIndex)
      }
    }
  }

  function handleDragEnd() {
    setStore("activeProject", undefined)
  }

  function workspaceIds(project: LocalProject | undefined) {
    if (!project) return []
    const local = project.worktree
    const dirs = [local, ...(project.sandboxes ?? [])]
    const active = currentProject()
    const directory = pathKey(active?.worktree ?? "") === pathKey(project.worktree) ? currentDir() : undefined
    const extra =
      directory && pathKey(directory) !== pathKey(local) && !dirs.some((item) => pathKey(item) === pathKey(directory))
        ? directory
        : undefined
    const pending = extra ? WorktreeState.get(serverSDK().scope, extra)?.status === "pending" : false

    const ordered = effectiveWorkspaceOrder(local, dirs, store.workspaceOrder[project.worktree])
    if (pending && extra) return [local, extra, ...ordered.filter((item) => item !== local)]
    if (!extra) return ordered
    if (pending) return ordered
    return [...ordered, extra]
  }

  const sidebarProject = createMemo(() => {
    if (layout.sidebar.opened()) return currentProject()
    const hovered = hoverProjectData()
    if (hovered) return hovered
    return currentProject()
  })

  function handleWorkspaceDragStart(event: unknown) {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeWorkspace", id)
  }

  function handleWorkspaceDragOver(event: DragEvent) {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const project = sidebarProject()
    if (!project) return

    const ids = workspaceIds(project)
    const fromIndex = ids.findIndex((dir) => dir === draggable.id.toString())
    const toIndex = ids.findIndex((dir) => dir === droppable.id.toString())
    if (fromIndex === -1 || toIndex === -1) return
    if (fromIndex === toIndex) return

    const result = ids.slice()
    const [item] = result.splice(fromIndex, 1)
    if (!item) return
    result.splice(toIndex, 0, item)
    setStore(
      "workspaceOrder",
      project.worktree,
      result.filter((directory) => pathKey(directory) !== pathKey(project.worktree)),
    )
  }

  function handleWorkspaceDragEnd() {
    setStore("activeWorkspace", undefined)
  }

  const createWorkspace = async (project: LocalProject) => {
    clearSidebarHoverState()
    const created = await serverSDK()
      .client.worktree.create({ directory: project.worktree })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("workspace.create.failed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return undefined
      })

    if (!created?.directory) return

    setWorkspaceName(created.directory, created.branch ?? getFilename(created.directory), project.id, created.branch)

    const local = project.worktree
    const key = pathKey(created.directory)
    const root = pathKey(local)

    setBusy(created.directory, true)
    WorktreeState.pending(serverSDK().scope, created.directory)
    setStore("workspaceExpanded", key, true)
    if (key !== created.directory) {
      setStore("workspaceExpanded", created.directory, true)
    }
    setStore("workspaceOrder", project.worktree, (prev) => {
      const existing = prev ?? []
      const next = existing.filter((item) => {
        const id = pathKey(item)
        return id !== root && id !== key
      })
      return [created.directory, ...next]
    })

    serverSync().child(created.directory)
    navigateWithSidebarReset(`/${base64Encode(created.directory)}/session`)
  }

  registerLayoutCommands({
    language,
    theme,
    colorSchemeOrder,
    colorSchemeLabel,
    layout,
    params,
    currentSessions,
    currentProject,
    workspaceSetting,
    availableThemeEntries,
    newDesign,
    platform,
    command,
    navigateProjectByOffset,
    navigateSessionByOffset,
    navigateSessionByUnseen,
    archiveSession,
    navigateToProjectIndex,
    createWorkspace,
    chooseProject,
    openServer,
    openSettings,
    connectProvider,
  })

  const workspaceDialogApi: WorkspaceDialogApi = {
    params,
    currentDir,
    navigateWithSidebarReset,
    deleteWorkspace,
    resetWorkspace,
  }

  const workspaceSidebarCtx: WorkspaceSidebarContext = {
    currentDir,
    navList: currentSessions,
    sidebarExpanded,
    sidebarHovering,
    clearHoverProjectSoon,
    prefetchSession,
    archiveSession,
    workspaceName,
    renameWorkspace,
    editorOpen,
    openEditor,
    closeEditor,
    setEditor,
    InlineEditor,
    isBusy,
    workspaceExpanded: (directory, local) => store.workspaceExpanded[directory] ?? local,
    setWorkspaceExpanded: (directory, value) => setStore("workspaceExpanded", directory, value),
    showResetWorkspaceDialog: (root, directory) =>
      dialog.show(() => <DialogResetWorkspace root={root} directory={directory} api={workspaceDialogApi} />),
    showDeleteWorkspaceDialog: (root, directory) =>
      dialog.show(() => <DialogDeleteWorkspace root={root} directory={directory} api={workspaceDialogApi} />),
    setScrollContainerRef: (el, mobile) => {
      if (!mobile) scrollContainerRef = el
    },
  }

  const projectSidebarCtx: ProjectSidebarContext = {
    currentDir,
    currentProject,
    sidebarOpened: () => layout.sidebar.opened(),
    sidebarHovering,
    hoverProject: () => state.hoverProject,
    onProjectMouseEnter: (worktree, event) => aim.enter(worktree, event),
    onProjectMouseLeave: (worktree) => aim.leave(worktree),
    onProjectFocus: (worktree) => aim.activate(worktree),
    onHoverOpenChanged: (worktree, hoverOpen) => {
      if (!hoverOpen && state.hoverProject && state.hoverProject !== worktree) return
      setState("hoverProject", hoverOpen ? worktree : undefined)
    },
    navigateToProject,
    openSidebar: () => layout.sidebar.open(),
    closeProject,
    showEditProjectDialog: (proj) => showEditProjectDialog(server.current!, proj),
    toggleProjectWorkspaces,
    workspacesEnabled: (project) => project.vcs === "git" && layout.sidebar.workspaces(project.worktree)(),
    workspaceIds,
    workspaceLabel,
    sessionProps: {
      navList: currentSessions,
      sidebarExpanded,
      clearHoverProjectSoon,
      prefetchSession,
      archiveSession,
    },
  }

  const SidebarPanel = (panelProps: {
    project: Accessor<LocalProject | undefined>
    mobile?: boolean
    merged?: boolean
  }) => {
    const project = panelProps.project
    const merged = createMemo(() => panelProps.mobile || (panelProps.merged ?? layout.sidebar.opened()))
    const hover = createMemo(() => !panelProps.mobile && panelProps.merged === false && !layout.sidebar.opened())
    const empty = createMemo(() => !params.dir && layout.projects.list().length === 0)
    const projectName = createMemo(() => {
      const item = project()
      if (!item) return ""
      return item.name || getFilename(item.worktree)
    })
    const projectId = createMemo(() => project()?.id ?? "")
    const worktree = createMemo(() => project()?.worktree ?? "")
    const slug = createMemo(() => {
      const dir = worktree()
      if (!dir) return ""
      return base64Encode(dir)
    })
    const workspaces = createMemo(() => {
      const item = project()
      if (!item) return [] as string[]
      return workspaceIds(item)
    })
    const unseenCount = createMemo(() =>
      workspaces().reduce((total, directory) => total + notification.project.unseenCount(directory), 0),
    )
    const clearNotifications = () =>
      workspaces()
        .filter((directory) => notification.project.unseenCount(directory) > 0)
        .forEach((directory) => notification.project.markViewed(directory))
    const workspacesEnabled = createMemo(() => {
      const item = project()
      if (!item) return false
      if (item.vcs !== "git") return false
      return layout.sidebar.workspaces(item.worktree)()
    })
    const [archivedState, setArchivedState] = createStore({
      open: false,
      loading: false,
      directory: "",
      items: [] as Session[],
      error: undefined as string | undefined,
    })
    let archivedRequest = 0
    const loadArchivedSessions = async () => {
      const directories = workspaces()
      if (directories.length === 0) return
      const directoryKey = directories.join("\0")
      const request = ++archivedRequest
      setArchivedState({ loading: true, directory: directoryKey, error: undefined })
      try {
        const lists = await Promise.all(
          directories.map(async (directory) => {
            const url = new URL("/session", serverSDK().url)
            url.searchParams.set("directory", directory)
            url.searchParams.set("roots", "true")
            url.searchParams.set("archived", "true")
            url.searchParams.set("limit", "50")
            const response = await serverSDK().fetch(url.toString())
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const value: unknown = await response.json()
            return Array.isArray(value) ? (value as Session[]) : []
          }),
        )
        const seen = new Set<string>()
        const items = lists
          .flat()
          .filter((session) => {
            if (!session?.id || !session.time.archived || seen.has(session.id)) return false
            seen.add(session.id)
            return true
          })
          .sort((a, b) => (b.time.archived ?? 0) - (a.time.archived ?? 0))
        if (request !== archivedRequest || archivedState.directory !== directoryKey) return
        setArchivedState({ items, loading: false, directory: directoryKey })
      } catch (error) {
        if (request !== archivedRequest || archivedState.directory !== directoryKey) return
        setArchivedState({ loading: false, items: [], error: errorMessage(error, "归档会话加载失败") })
      }
    }
    const toggleArchivedSessions = () => {
      if (archivedState.open) {
        setArchivedState("open", false)
        return
      }
      setArchivedState("open", true)
      void loadArchivedSessions()
    }
    createEffect(() => {
      const directoryKey = workspaces().join("\0")
      if (archivedState.directory === directoryKey) return

      // ponytail: the drawer is scoped to the selected project; stale items are worse than an empty loading state.
      archivedRequest += 1
      setArchivedState({ directory: directoryKey, items: [], error: undefined, loading: false })
      if (archivedState.open) void loadArchivedSessions()
    })
    const restoreArchivedSession = async (session: Session) => {
      const url = new URL(`/session/${encodeURIComponent(session.id)}`, serverSDK().url)
      url.searchParams.set("directory", session.directory)
      const response = await serverSDK().fetch(url.toString(), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ time: { archived: null } }),
      })
      if (!response.ok) {
        setArchivedState("error", `HTTP ${response.status}`)
        return
      }
      setArchivedState("items", (items) => items.filter((item) => item.id !== session.id))
      await serverSync().project.loadSessions(session.directory)
    }
    const deleteArchivedSession = async (session: Session) => {
      if (!window.confirm(`永久删除会话“${session.title || "未命名会话"}”？此操作不会删除项目文件。`)) return
      try {
        // Cancel any goal/loop on this session first (best-effort) so the
        // workers never retry a dead session.
        await cancelSessionAutomation(serverSDK(), session.id)
        const result = await serverSDK().client.session.delete({ sessionID: session.id, directory: session.directory })
        if (!result.data) throw new Error("删除会话未获确认")
        setArchivedState("items", (items) => items.filter((item) => item.id !== session.id))
        showToast({ title: "会话已永久删除", description: "仅删除会话记录和历史消息，项目文件未改变。" })
      } catch (error) {
        setArchivedState("error", errorMessage(error, "归档会话删除失败"))
        showToast({ variant: "error", title: "无法删除归档会话", description: errorMessage(error, "请求失败") })
      }
    }
    const canToggle = createMemo(() => {
      const item = project()
      if (!item) return false
      return item.vcs === "git" || layout.sidebar.workspaces(item.worktree)()
    })
    const homedir = createMemo(() => serverSync().data.path.home)

    return (
      <div
        classList={{
          "flex flex-col min-h-0 min-w-0 box-border rounded-tl-[12px] px-3": true,
          "border border-b-0 border-border-weak-base": !merged(),
          "border-l border-t border-border-weaker-base": merged(),
          "bg-background-base": merged() || hover(),
          "bg-background-stronger": !merged() && !hover(),
          "flex-1 min-w-0": panelProps.mobile,
          "max-w-full overflow-hidden": panelProps.mobile,
        }}
        style={{
          width: panelProps.mobile ? undefined : `${panel()}px`,
        }}
      >
        <Show
          when={project()}
          fallback={
            <Show when={empty()}>
              <div class="flex-1 min-h-0 -mt-4 flex items-center justify-center px-6 pb-64 text-center">
                <div class="mt-8 flex max-w-60 flex-col items-center gap-6 text-center">
                  <div class="flex flex-col gap-3">
                    <div class="text-14-medium text-text-strong">{language.t("sidebar.empty.title")}</div>
                    <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                      {language.t("sidebar.empty.description")}
                    </div>
                  </div>
                  <Button size="large" icon="folder-add-left" onClick={chooseProject}>
                    {language.t("command.project.open")}
                  </Button>
                </div>
              </div>
            </Show>
          }
          keyed
        >
          {(project) => (
            <>
              <div class="shrink-0 pl-1 py-1">
                <div class="group/project flex items-start justify-between gap-2 py-2 pl-2 pr-0">
                  <div class="flex flex-col min-w-0">
                    <InlineEditor
                      id={`project:${projectId()}`}
                      value={projectName}
                      onSave={(next) => {
                        void renameProject(project, next)
                      }}
                      class="text-14-medium text-text-strong truncate"
                      displayClass="text-14-medium text-text-strong truncate"
                      stopPropagation
                    />

                    <Tooltip
                      placement="bottom"
                      gutter={2}
                      value={worktree()}
                      class="shrink-0"
                      contentStyle={{
                        "max-width": "640px",
                        transform: "translate3d(52px, 0, 0)",
                      }}
                    >
                      <span class="text-12-regular text-text-base truncate select-text">
                        {worktree().replace(homedir(), "~")}
                      </span>
                    </Tooltip>
                  </div>

                  <DropdownMenu modal={!sidebarHovering()}>
                    <DropdownMenu.Trigger
                      as={IconButton}
                      icon="dot-grid"
                      variant="ghost"
                      data-action="project-menu"
                      data-project={slug()}
                      class="shrink-0 size-6 rounded-md transition-opacity data-[expanded]:bg-surface-base-active"
                      classList={{
                        "opacity-100": panelProps.mobile || merged(),
                        "opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100 data-[expanded]:opacity-100":
                          !panelProps.mobile && !merged(),
                      }}
                      aria-label={language.t("common.moreOptions")}
                    />
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content class="mt-1">
                        <DropdownMenu.Item
                          data-action="project-pin-toggle"
                          data-project={slug()}
                          onSelect={() => togglePinned(project)}
                        >
                          <DropdownMenu.ItemLabel>
                            {isPinned(project) ? "取消置顶" : "置顶项目"}
                          </DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          data-action="project-create-delivery-worktree"
                          onSelect={() => void createIsolatedWorktree(project)}
                        >
                          <DropdownMenu.ItemLabel>创建隔离的交付工作区</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          onSelect={() => {
                            showEditProjectDialog(server.current!, project)
                          }}
                        >
                          <DropdownMenu.ItemLabel>{language.t("common.edit")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          data-action="project-reveal-in-explorer"
                          disabled={!worktree()}
                          onSelect={() => {
                            const dir = worktree()
                            if (!dir) return
                            if (!platform.openPath) {
                              showToast({ variant: "error", title: "当前环境不支持打开外部应用", description: dir })
                              return
                            }
                            // Same helper the "open workspace" flow uses:
                            // resolves local-server guards and surfaces failures
                            // as a toast instead of a silent rejection.
                            platform.openPath(dir).catch((error: unknown) => {
                              showToast({
                                variant: "error",
                                title: "无法在文件管理器中显示",
                                description: error instanceof Error ? error.message : String(error),
                              })
                            })
                          }}
                        >
                          <DropdownMenu.ItemLabel>在文件资源管理器中显示</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          data-action="project-workspaces-toggle"
                          data-project={slug()}
                          disabled={!canToggle()}
                          onSelect={() => {
                            toggleProjectWorkspaces(project)
                          }}
                        >
                          <DropdownMenu.ItemLabel>
                            {workspacesEnabled()
                              ? language.t("sidebar.workspaces.disable")
                              : language.t("sidebar.workspaces.enable")}
                          </DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          data-action="project-clear-notifications"
                          data-project={slug()}
                          disabled={unseenCount() === 0}
                          onSelect={clearNotifications}
                        >
                          <DropdownMenu.ItemLabel>
                            {language.t("sidebar.project.clearNotifications")}
                          </DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator />
                        <DropdownMenu.Item
                          data-action="project-archive"
                          onSelect={() => archiveProject(project.worktree)}
                        >
                          <DropdownMenu.ItemLabel>归档项目（移出列表）</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          data-action="project-delete-entry"
                          onSelect={() => {
                            if (!window.confirm("删除这个项目条目？不会删除磁盘上的文件。")) return
                            forgetProjectEntry(project.worktree)
                          }}
                        >
                          <DropdownMenu.ItemLabel>删除项目条目（不删磁盘）</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator />
                        <DropdownMenu.Item
                          data-action="project-close-menu"
                          data-project={slug()}
                          onSelect={() => {
                            const dir = worktree()
                            if (!dir) return
                            closeProject(dir)
                          }}
                        >
                          <DropdownMenu.ItemLabel>{language.t("common.close")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu>
                </div>
              </div>

              <div class="flex-1 min-h-0 flex flex-col">
                <Show
                  when={workspacesEnabled()}
                  fallback={
                    <>
                      <div class="shrink-0 py-4">
                        <Button
                          size="large"
                          icon="new-session"
                          class="w-full"
                          onClick={() => {
                            const dir = worktree()
                            if (!dir) return
                            navigateWithSidebarReset(`/${base64Encode(dir)}/session`)
                          }}
                        >
                          {language.t("command.session.new")}
                        </Button>
                      </div>
                      <div class="flex-1 min-h-0">
                        <LocalWorkspace
                          ctx={workspaceSidebarCtx}
                          project={project}
                          sortNow={sortNow}
                          mobile={panelProps.mobile}
                        />
                      </div>
                    </>
                  }
                >
                  <>
                    <div class="shrink-0 py-4">
                      <Button
                        size="large"
                        icon="plus-small"
                        class="w-full"
                        onClick={() => {
                          void createWorkspace(project)
                        }}
                      >
                        {language.t("workspace.new")}
                      </Button>
                    </div>
                    <div class="relative flex-1 min-h-0">
                      <DragDropProvider
                        onDragStart={handleWorkspaceDragStart}
                        onDragEnd={handleWorkspaceDragEnd}
                        onDragOver={handleWorkspaceDragOver}
                        collisionDetector={closestCenter}
                      >
                        <DragDropSensors />
                        <ConstrainDragXAxis />
                        <div
                          ref={(el) => {
                            if (!panelProps.mobile) scrollContainerRef = el
                          }}
                          class="size-full flex flex-col py-2 gap-4 overflow-y-auto no-scrollbar [overflow-anchor:none]"
                        >
                          <SortableProvider ids={workspaces()}>
                            <For each={workspaces()}>
                              {(directory) => (
                                <SortableWorkspace
                                  ctx={workspaceSidebarCtx}
                                  directory={directory}
                                  project={project}
                                  sortNow={sortNow}
                                  mobile={panelProps.mobile}
                                />
                              )}
                            </For>
                          </SortableProvider>
                        </div>
                        <DragOverlay>
                          <WorkspaceDragOverlay
                            sidebarProject={sidebarProject}
                            activeWorkspace={() => store.activeWorkspace}
                            workspaceLabel={workspaceLabel}
                          />
                        </DragOverlay>
                      </DragDropProvider>
                    </div>
                  </>
                </Show>
                <div class="shrink-0 border-t border-border-weaker-base px-2 py-1" data-component="archived-sessions">
                  <button
                    type="button"
                    class="flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-12-medium text-text-weak hover:bg-surface-raised-base"
                    data-action="toggle-archived-sessions"
                    aria-expanded={archivedState.open}
                    onClick={toggleArchivedSessions}
                  >
                    <Icon name="archive" size="small" class="shrink-0 text-icon-weak" />
                    <span class="min-w-0 flex-1 truncate">已归档会话</span>
                    <Show when={archivedState.loading} fallback={<span>{archivedState.items.length}</span>}>
                      <span class="size-3 animate-spin rounded-full border border-text-faint border-t-v2-text-text-accent" />
                    </Show>
                  </button>
                  <Show when={archivedState.open}>
                    <div class="max-h-44 overflow-y-auto py-1">
                      <Show
                        when={!archivedState.error}
                        fallback={<div class="px-2 py-2 text-11-regular text-text-weak">归档会话加载失败</div>}
                      >
                        <Show
                          when={archivedState.items.length > 0}
                          fallback={<div class="px-2 py-2 text-11-regular text-text-weak">暂无已归档会话</div>}
                        >
                          <For each={archivedState.items}>
                            {(session) => (
                              <div class="group/archived-session flex min-w-0 items-center gap-1 rounded-md px-1 hover:bg-surface-raised-base">
                                <button
                                  type="button"
                                  class="min-w-0 flex-1 truncate px-1 py-1 text-left text-12-regular text-text-weak hover:text-text-strong"
                                  onClick={() => navigateWithSidebarReset(`/${base64Encode(session.directory)}/session/${session.id}`)}
                                  title={session.title}
                                >
                                  {session.title || "未命名会话"}
                                </button>
                                <button
                                  type="button"
                                  class="shrink-0 rounded px-1 py-1 text-11-regular text-text-faint opacity-0 hover:text-text-strong group-hover/archived-session:opacity-100"
                                  onClick={() => void restoreArchivedSession(session)}
                                  title="恢复到会话列表"
                                >
                                  恢复
                                </button>
                                <button
                                  type="button"
                                  class="shrink-0 rounded px-1 py-1 text-11-regular text-text-faint opacity-0 hover:text-text-critical-base group-hover/archived-session:opacity-100"
                                  data-action="delete-archived-session"
                                  onClick={() => void deleteArchivedSession(session)}
                                  title="永久删除会话记录，不删除项目文件"
                                >
                                  删除
                                </button>
                              </div>
                            )}
                          </For>
                        </Show>
                      </Show>
                    </div>
                  </Show>
                </div>
              </div>
            </>
          )}
        </Show>

        <div
          class="shrink-0 px-3 py-3"
          classList={{
            hidden: store.gettingStartedDismissed || !(providers.all().size > 0 && providers.paid().length === 0),
          }}
        >
          <div class="rounded-xl bg-background-base shadow-xs-border-base" data-component="getting-started">
            <div class="p-3 flex flex-col gap-6">
              <div class="flex flex-col gap-2">
                <div class="text-14-medium text-text-strong">{language.t("sidebar.gettingStarted.title")}</div>
                <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                  {language.t("sidebar.gettingStarted.line1")}
                </div>
                <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                  {language.t("sidebar.gettingStarted.line2")}
                </div>
              </div>
              <div data-component="getting-started-actions">
                <Button size="large" icon="plus-small" onClick={connectProvider}>
                  {language.t("command.provider.connect")}
                </Button>
                <Button size="large" variant="ghost" onClick={() => setStore("gettingStartedDismissed", true)}>
                  {language.t("toast.update.action.notYet")}
                </Button>
              </div>
            </div>
          </div>
        </div>
        {/* DeveAgent Sidebar moved to layout-level flex regions */}
      </div>
    )
  }

  const pinnedKey = (directory: string) => pathKey(projectRoot(directory))
  const isPinned = (project: LocalProject) => !!store.pinnedProjects[pinnedKey(project.worktree)]
  const togglePinned = (project: LocalProject) => {
    const key = pinnedKey(project.worktree)
    setStore(
      "pinnedProjects",
      produce((draft) => {
        if (draft[key]) delete draft[key]
        else draft[key] = { directory: projectRoot(project.worktree), at: Date.now() }
      }),
    )
  }
  const createIsolatedWorktree = async (project: LocalProject) => {
    const directory = projectRoot(project.worktree)
    try {
      const created = (await serverSDK().client.worktree.create({ directory })).data
      if (!created?.directory) throw new Error("未返回工作区目录")
      // Same pending marker the other worktree.create call sites set: guards
      // a fast sidebar click + submit before the server emits worktree.ready.
      WorktreeState.pending(serverSDK().scope, created.directory)
      // Register the new worktree as a sidebar project without navigating away
      // (the user opens it when ready).
      await openProject(created.directory, false)
      showToast({ title: "已创建隔离的交付工作区", description: created.directory })
    } catch (error) {
      showToast({
        variant: "error",
        title: "创建隔离的交付工作区失败",
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const projects = createMemo(() =>
    layout
      .projects.list()
      .filter((project) => !store.hiddenProjects[pathKey(projectRoot(project.worktree))])
      // Pinned projects stay on top; relative order is otherwise preserved
      // (Array#sort is stable, and filter already copied the list).
      .sort((a, b) => Number(isPinned(b)) - Number(isPinned(a))),
  )
  const archivedProjects = createMemo(() => Object.values(store.archivedProjects).sort((a, b) => b.at - a.at))
  const [archivedProjectsOpen, setArchivedProjectsOpen] = createSignal(false)
  const projectWorking = (project: LocalProject) => {
    // ponytail: only inspect the active project; scanning every project on every render made the sidebar noisy and slow.
    if (pathKey(currentProject()?.worktree ?? "") !== pathKey(project.worktree)) return false
    return workspaceIds(project).some((directory) => {
      const [data] = serverSync().child(directory, { bootstrap: false })
      // Ignore status entries for sessions that are no longer in the loaded
      // project list. They can survive a restart briefly and otherwise make a
      // project look like it started work when the user only selected it.
      const sessions = new Set(data.session.filter((session) => !session.time.archived).map((session) => session.id))
      return [...sessions].some((id) => data.session_working(id))
    })
  }
  const projectOverlay = () => <ProjectDragOverlay projects={projects} activeProject={() => store.activeProject} />
  const sidebarContent = (mobile?: boolean) => (
    <SidebarContent
      mobile={mobile}
      opened={() => newDesign() || layout.sidebar.opened()}
      aimMove={aim.move}
      projects={projects}
      renderProject={(project) => (
        <SortableProject ctx={projectSidebarCtx} project={project} sortNow={sortNow} mobile={mobile} />
      )}
      handleDragStart={handleDragStart}
      handleDragEnd={handleDragEnd}
      handleDragOver={handleDragOver}
      openProjectLabel={language.t("command.project.open")}
      openProjectKeybind={() => command.keybind("project.open")}
      onOpenProject={chooseProject}
      renderProjectOverlay={projectOverlay}
      settingsLabel={() => language.t("sidebar.settings")}
      settingsKeybind={() => command.keybind("settings.open")}
      onOpenSettings={openSettings}
      renderPanel={() =>
        mobile ? <SidebarPanel project={currentProject} mobile /> : <SidebarPanel project={currentProject} merged />
      }
    />
  )

  return (
    <>
    <Show
      // ponytail: DeveAgent owns the outer workbench in both OpenCode layout modes.
      // The new-layout setting still selects OpenCode's composer/session internals.
      // ponytail: the DeveAgent workbench is the product shell; retain the native branch below only as an emergency recovery path.
      when={false}
      fallback={
        <div class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text">
          {autoselecting() ?? ""}
          <Titlebar update={titlebarUpdate} />
          <Show when={updateVersion() !== undefined}>
            <UpdateAvailableToast version={updateVersion() ?? ""} install={installUpdate} language={language} />
          </Show>
          <div class="flex-1 min-h-0 min-w-0 flex">
            <Show
              when={deveagentSidebarOpen()}
              fallback={
                <aside
                  class="flex w-11 shrink-0 flex-col items-center gap-2 border-r border-border-weaker-base bg-surface-base py-2"
                  data-component="deveagent-workbench-rail"
                >
                  <div
                    class="flex size-7 items-center justify-center rounded-md bg-v2-background-bg-accent text-[10px] font-semibold text-white"
                    title="DeveAgent Studio"
                  >
                    DA
                  </div>
                  <IconButton
                    icon="arrow-right"
                    variant="ghost"
                    size="small"
                    title="显示左侧 DeveAgent 面板"
                    aria-label="显示左侧 DeveAgent 面板"
                    onClick={() => setDeveagentSidebarOpen(true)}
                  />
                </aside>
              }
            >
              <aside class="flex min-h-0 w-[clamp(224px,20vw,296px)] shrink-0 flex-col border-r border-border-weaker-base bg-surface-base">
                <div class="flex items-start gap-3 border-b border-border-weaker-base bg-background-base px-3 py-3">
                  <div class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-v2-background-bg-accent text-[11px] font-semibold text-white">
                    DA
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="text-13-medium text-text-strong">DeveAgent Studio</div>
                    <div class="mt-0.5 text-11-regular text-text-weak">项目 · 会话 · 智能工作台</div>
                  </div>
                  <IconButton
                    icon="arrow-left"
                    variant="ghost"
                    size="small"
                    class="!rounded-md"
                    title="隐藏左侧面板"
                    aria-label="隐藏左侧面板"
                    onClick={() => setDeveagentSidebarOpen(false)}
                  />
                </div>
                <div
                  class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto bg-background-base"
                  data-component="deveagent-sidebar-scroll"
                >
                  <DeveagentLayoutSidebar
                    workspaceContent={
                      <>
                        <Show when={projects().length > 0}>
                          <div class="px-2 py-1" data-component="deveagent-sidebar-projects">
                            <button
                              type="button"
                              data-action="deveagent-sidebar-toggle-projects"
                              class="flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-[10px] font-medium uppercase tracking-wide text-text-faint hover:bg-surface-raised-base hover:text-text-weak"
                              aria-expanded={deveagentProjectsOpen()}
                              onClick={() => setDeveagentProjectsOpen((open) => !open)}
                            >
                              <Icon
                                name="chevron-down"
                                size="small"
                                class={deveagentProjectsOpen() ? "transition-transform" : "rotate-[-90deg] transition-transform"}
                              />
                              <span class="flex-1">项目</span>
                              <span>{projects().length}</span>
                            </button>
                            <Show when={deveagentProjectsOpen()}>
                              <For each={projects()}>
                                {(project) => {
                                  const working = createMemo(() => projectWorking(project))
                                  return (
                                    <div
                                      class="group/project flex h-8 w-full items-center gap-1 rounded-md px-1 text-12-medium text-text-weak hover:bg-surface-raised-base hover:text-text-strong"
                                      classList={{
                                        "bg-v2-background-bg-accent/10 text-v2-text-text-accent":
                                          pathKey(currentProject()?.worktree ?? "") === pathKey(project.worktree),
                                      }}
                                    >
                                      <button
                                        type="button"
                                        class="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left"
                                        title={project.worktree}
                                        onClick={() => {
                                          setDeveagentProjectMenu(undefined)
                                          void openProject(project.worktree)
                                        }}
                                      >
                                        <Show when={working()} fallback={<Icon name="folder" size="small" class="shrink-0 text-icon-weak" />}>
                                          <span
                                            class="size-3 shrink-0 animate-spin rounded-full border-2 border-text-faint border-t-v2-text-text-accent"
                                            data-component="deveagent-project-spinner"
                                            title="项目正在运行任务"
                                          />
                                        </Show>
                                        <span class="truncate">{project.name || getFilename(project.worktree)}</span>
                                      </button>
                                      <div class="relative shrink-0">
                                        <IconButton
                                          icon="dot-grid"
                                          variant="ghost"
                                          type="button"
                                          data-action="deveagent-project-menu"
                                          data-project={base64Encode(project.worktree)}
                                          class="size-6 rounded-md opacity-70 transition-opacity hover:opacity-100 group-hover/project:opacity-100 group-focus-within/project:opacity-100"
                                          aria-label="项目操作"
                                          aria-expanded={deveagentProjectMenu() === pathKey(projectRoot(project.worktree))}
                                          onMouseDown={(event) => {
                                            event.stopPropagation()
                                            const key = pathKey(projectRoot(project.worktree))
                                            if (deveagentProjectMenu() !== key) setDeveagentProjectMenu(key)
                                          }}
                                        />
                                        <Show when={deveagentProjectMenu() === pathKey(projectRoot(project.worktree))}>
                                          <div
                                            role="menu"
                                            data-component="deveagent-project-menu-content"
                                            class="absolute right-0 top-7 z-50 min-w-52 rounded-md border border-border-weak-base bg-background-base p-1 shadow-lg"
                                            onPointerDown={(event) => event.stopPropagation()}
                                          >
                                            <button
                                              type="button"
                                              role="menuitem"
                                              data-action="deveagent-project-archive"
                                              class="flex w-full items-center rounded px-2 py-1.5 text-left text-12-medium text-text-strong hover:bg-surface-raised-base"
                                              onMouseDown={(event) => {
                                                event.stopPropagation()
                                                archiveProject(project.worktree)
                                              }}
                                            >
                                              归档项目（移出列表）
                                            </button>
                                            <button
                                              type="button"
                                              role="menuitem"
                                              data-action="deveagent-project-delete-entry"
                                              class="flex w-full items-center rounded px-2 py-1.5 text-left text-12-medium text-text-strong hover:bg-surface-raised-base"
                                              onMouseDown={(event) => {
                                                event.stopPropagation()
                                                if (!window.confirm("删除这个项目条目？不会删除磁盘上的文件。")) return
                                                forgetProjectEntry(project.worktree)
                                              }}
                                            >
                                              删除项目条目（不删磁盘）
                                            </button>
                                          </div>
                                        </Show>
                                      </div>
                                    </div>
                                  )
                                }}
                              </For>
                            </Show>
                          </div>
                        </Show>
                        <Show when={archivedProjects().length > 0}>
                          <div
                            class="border-t border-border-weaker-base px-2 py-1"
                            data-component="deveagent-sidebar-archived-projects"
                          >
                            <button
                              type="button"
                              data-action="deveagent-sidebar-toggle-archived-projects"
                              class="flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-[10px] font-medium uppercase tracking-wide text-text-faint hover:bg-surface-raised-base hover:text-text-weak"
                              aria-expanded={archivedProjectsOpen()}
                              onClick={() => setArchivedProjectsOpen((open) => !open)}
                            >
                              <Icon
                                name="chevron-down"
                                size="small"
                                class={archivedProjectsOpen() ? "transition-transform" : "rotate-[-90deg] transition-transform"}
                              />
                              <span class="flex-1">已归档项目</span>
                              <span>{archivedProjects().length}</span>
                            </button>
                            <Show when={archivedProjectsOpen()}>
                              <For each={archivedProjects()}>
                                {(archived) => (
                                  <div class="group/archived flex h-8 items-center gap-1 rounded-md px-1 text-12-medium text-text-weak hover:bg-surface-raised-base">
                                    <button
                                      type="button"
                                      class="min-w-0 flex-1 truncate px-1 text-left hover:text-text-strong"
                                      data-action="deveagent-project-restore"
                                      data-project={base64Encode(archived.directory)}
                                      title={archived.directory}
                                      onClick={() => void openProject(archived.directory)}
                                    >
                                      {getFilename(archived.directory)}
                                    </button>
                                    <button
                                      type="button"
                                      class="rounded px-1 text-[10px] text-text-faint opacity-0 hover:text-text-strong group-hover/archived:opacity-100"
                                      data-action="deveagent-project-forget-archive"
                                      title="从归档记录中移除，不删除磁盘文件"
                                      onClick={() => forgetProjectEntry(archived.directory)}
                                    >
                                      移除
                                    </button>
                                  </div>
                                )}
                              </For>
                            </Show>
                          </div>
                        </Show>
                        <div class="border-t border-border-weaker-base bg-background-base" data-component="deveagent-sidebar-sessions">
                          <SidebarPanel project={currentProject} merged />
                        </div>
                      </>
                    }
                  />
                </div>
                <div class="flex h-10 shrink-0 items-center gap-1 border-t border-border-weaker-base bg-background-base px-2" data-component="deveagent-sidebar-footer">
                  <button
                    type="button"
                    class="flex h-7 flex-1 items-center gap-2 rounded-md px-2 text-left text-12-medium text-text-weak hover:bg-surface-raised-base hover:text-text-strong"
                    onClick={openSettings}
                  >
                    <Icon name="settings-gear" size="small" />
                    <span>设置</span>
                  </button>
                </div>
              </aside>
            </Show>
            <main class="flex min-h-0 min-w-0 basis-0 flex-1 flex-col overflow-x-hidden contain-strict">
              <div
                class="flex h-11 w-full shrink-0 items-center gap-2 border-b border-border-weaker-base bg-background-base px-3"
                data-component="deveagent-current-route"
                data-route-dir={params.dir || ""}
              >
                <div class="min-w-0 flex-1">
                  <div class="truncate text-12-medium text-text-strong" data-component="deveagent-current-project">
                    {currentProject()?.name || getFilename(currentDir()) || "DeveAgent Studio"}
                  </div>
                  <div class="truncate text-[10px] text-text-faint" data-component="deveagent-current-directory">
                    {currentDir() || "打开项目后可使用文件、终端与市场安装"}
                  </div>
                </div>
                <DropdownMenu modal={true}>
                  <DropdownMenu.Trigger
                    as={IconButton}
                    icon="folder"
                    variant="ghost"
                    size="small"
                    class="!rounded-md"
                    title="打开工作区"
                    aria-label="打开工作区"
                    data-action="deveagent-open-workspace"
                  />
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content class="mt-1" data-component="deveagent-open-workspace-menu">
                      <DropdownMenu.Item onSelect={() => openCurrentDirectory()}>
                        <DropdownMenu.ItemLabel>文件管理器</DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item onSelect={() => openCurrentDirectory("code")}>
                        <DropdownMenu.ItemLabel>VS Code</DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item onSelect={() => openCurrentDirectory("cursor")}>
                        <DropdownMenu.ItemLabel>Cursor</DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item onSelect={() => openCurrentDirectory("windsurf")}>
                        <DropdownMenu.ItemLabel>Windsurf</DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item onSelect={() => {
                        const directory = currentDir()
                        if (!directory) return
                        void navigator.clipboard.writeText(directory).then(
                          () => showToast({ variant: "success", title: "路径已复制", description: directory }),
                          (error: unknown) => showToast({ variant: "error", title: "复制路径失败", description: String(error) }),
                        )
                      }}>
                        <DropdownMenu.ItemLabel>复制路径</DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu>
                <button
                  type="button"
                  class="rounded-md px-2 py-1 text-[11px] text-text-weak hover:bg-surface-raised-base hover:text-text-strong"
                  title="打开独立概览面板"
                  onClick={() => window.dispatchEvent(new CustomEvent("deveagent:open-panel", { detail: "metrics" }))}
                >
                  概览
                </button>
                <button
                  type="button"
                  class="rounded-md px-2 py-1 text-[11px] text-text-weak hover:bg-surface-raised-base hover:text-text-strong"
                  title="打开原生审查面板"
                  onClick={() => window.dispatchEvent(new CustomEvent("deveagent:open-panel", { detail: "review" }))}
                >
                  审查
                </button>
                <IconButton
                  icon="plus"
                  variant="ghost"
                  size="small"
                  class="!rounded-md"
                  title="新建会话"
                  aria-label="新建会话"
                  onClick={() => window.dispatchEvent(new CustomEvent("deveagent:new-session"))}
                />
              </div>
              <div class="flex min-h-0 w-full flex-1 flex-col">
                <Show when={!autoselecting.loading} fallback={<div class="size-full" />}>
                  {props.children}
                </Show>
              </div>
            </main>
          </div>
          {import.meta.env.DEV && import.meta.env.VITE_DISABLE_DEBUG_BAR !== "1" && <DebugBar />}
          <HelpButton />
          <ToastRegion v2={newDesign()} />
        </div>
      }
    >
      <div class="relative bg-background-base flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text">
        {autoselecting() ?? ""}
        <Titlebar update={titlebarUpdate} />
        <Show when={updateVersion() !== undefined}>
          <UpdateAvailableToast version={updateVersion() ?? ""} install={installUpdate} language={language} />
        </Show>
        <div class="flex-1 min-h-0 min-w-0 flex">
          <div class="flex-1 min-h-0 relative">
            <div class="size-full relative overflow-x-hidden">
              <nav
                aria-label={language.t("sidebar.nav.projectsAndSessions")}
                data-component="sidebar-nav-desktop"
                classList={{
                  "hidden xl:block": true,
                  "absolute inset-y-0 left-0": true,
                  "z-10": true,
                }}
                style={{ width: `${side()}px` }}
                ref={(el) => {
                  setState("nav", el)
                }}
                onMouseEnter={() => {
                  disarm()
                }}
                onMouseLeave={() => {
                  aim.reset()
                  if (!sidebarHovering()) return

                  arm()
                }}
              >
                <div class="@container w-full h-full contain-strict">{sidebarContent()}</div>
              </nav>

              <Show when={layout.sidebar.opened()}>
                <div
                  class="hidden xl:block absolute inset-y-0 z-30 w-0 overflow-visible"
                  style={{ left: `${side()}px` }}
                  onPointerDown={() => setState("sizing", true)}
                >
                  <ResizeHandle
                    direction="horizontal"
                    size={layout.sidebar.width()}
                    min={244}
                    max={typeof window === "undefined" ? 1000 : window.innerWidth * 0.3 + 64}
                    onResize={(w) => {
                      setState("sizing", true)
                      if (sizet !== undefined) clearTimeout(sizet)
                      sizet = window.setTimeout(() => setState("sizing", false), 120)
                      layout.sidebar.resize(w)
                    }}
                  />
                </div>
              </Show>

              <div
                class="hidden xl:block pointer-events-none absolute top-0 right-0 z-0 border-t border-border-weaker-base"
                style={{ left: "calc(4rem + 12px)" }}
              />

              <div class="xl:hidden">
                <div
                  classList={{
                    "fixed inset-x-0 top-10 bottom-0 z-40 transition-opacity duration-200": true,
                    "opacity-100 pointer-events-auto": layout.mobileSidebar.opened(),
                    "opacity-0 pointer-events-none": !layout.mobileSidebar.opened(),
                  }}
                  onClick={(e) => {
                    if (e.target === e.currentTarget) layout.mobileSidebar.hide()
                  }}
                />
                <nav
                  aria-label={language.t("sidebar.nav.projectsAndSessions")}
                  data-component="sidebar-nav-mobile"
                  classList={{
                    "@container fixed top-10 bottom-0 left-0 z-50 w-full max-w-[400px] overflow-hidden border-r border-border-weaker-base bg-background-base transition-transform duration-200 ease-out": true,
                    "translate-x-0": layout.mobileSidebar.opened(),
                    "-translate-x-full": !layout.mobileSidebar.opened(),
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  {sidebarContent(true)}
                </nav>
              </div>

              <div
                classList={{
                  "absolute inset-0": true,
                  "xl:inset-y-0 xl:right-0 xl:left-[var(--main-left)]": true,
                  "z-20": true,
                  "transition-[left] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[left] motion-reduce:transition-none":
                    !state.sizing,
                }}
                style={{
                  "--main-left": layout.sidebar.opened() ? `${side()}px` : "4rem",
                }}
              >
                <main
                  classList={{
                    "size-full overflow-x-hidden flex flex-col items-start contain-strict border-t border-border-weak-base bg-background-base xl:border-l xl:rounded-tl-[12px]": true,
                  }}
                >
                  <Show when={!autoselecting.loading} fallback={<div class="size-full" />}>
                    {props.children}
                  </Show>
                </main>
              </div>

              <div
                classList={{
                  "hidden xl:flex absolute inset-y-0 left-16 z-30": true,
                  "opacity-100 translate-x-0 pointer-events-auto": state.peeked && !layout.sidebar.opened(),
                  "opacity-0 -translate-x-2 pointer-events-none": !state.peeked || layout.sidebar.opened(),
                  "transition-[opacity,transform] motion-reduce:transition-none": true,
                  "duration-180 ease-out": state.peeked && !layout.sidebar.opened(),
                  "duration-120 ease-in": !state.peeked || layout.sidebar.opened(),
                }}
                onMouseMove={disarm}
                onMouseEnter={() => {
                  disarm()
                  aim.reset()
                }}
                onPointerDown={disarm}
                onMouseLeave={() => {
                  arm()
                }}
              >
                <Show when={peekProject()}>
                  <SidebarPanel project={peekProject} merged={false} />
                </Show>
              </div>

              <div
                classList={{
                  "hidden xl:block pointer-events-none absolute inset-y-0 right-0 z-25 overflow-hidden": true,
                  "opacity-100 translate-x-0": state.peeked && !layout.sidebar.opened(),
                  "opacity-0 -translate-x-2": !state.peeked || layout.sidebar.opened(),
                  "transition-[opacity,transform] motion-reduce:transition-none": true,
                  "duration-180 ease-out": state.peeked && !layout.sidebar.opened(),
                  "duration-120 ease-in": !state.peeked || layout.sidebar.opened(),
                }}
                style={{ left: `calc(4rem + ${panel()}px)` }}
              >
                <div class="h-full w-px" style={{ "box-shadow": "var(--shadow-xs)" }} />
              </div>
            </div>
          </div>
          {import.meta.env.DEV && import.meta.env.VITE_DISABLE_DEBUG_BAR !== "1" && <DebugBar />}
        </div>
        <HelpButton />
        <ToastRegion v2={newDesign()} />
      </div>
    </Show>
    <DeveagentGlobalMarketDrawer directory={marketDirectory} />
    <DeveagentGlobalExpertsDrawer sessionID={() => params.id} />
    </>
  )
}

function UpdateAvailableToast(props: {
  version: string
  install: () => void
  language: ReturnType<typeof useLanguage>
}) {
  let toastId: number | undefined

  onMount(() => {
    toastId = showToast({
      persistent: true,
      icon: "download",
      title: props.language.t("toast.update.title"),
      description: props.language.t("toast.update.description", { version: props.version }),
      actions: [
        {
          label: props.language.t("toast.update.action.installRestart"),
          onClick: props.install,
        },
        {
          label: props.language.t("toast.update.action.notYet"),
          onClick: "dismiss",
        },
      ],
    })
  })

  onCleanup(() => {
    if (toastId === undefined) return
    toaster.dismiss(toastId)
  })

  return null
}

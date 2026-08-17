// Layout command palette registration, extracted from `pages/layout.tsx`.
// Theme/scheme/language cycling helpers are private to this module; the
// layout passes its local state and actions through `api`.

import { type CommandOption, useCommand } from "@/context/command"
import { type Locale, useLanguage } from "@/context/language"
import { useLayout, type LocalProject } from "@/context/layout"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme/context"
import { type DesktopTheme } from "@opencode-ai/ui/theme/types"
import { type Platform } from "@/context/platform"
import { type Session } from "@opencode-ai/sdk/v2"
import { showToast } from "@/utils/toast"

export interface LayoutCommandsApi {
  language: ReturnType<typeof useLanguage>
  theme: ReturnType<typeof useTheme>
  colorSchemeOrder: ColorScheme[]
  colorSchemeLabel: (scheme: ColorScheme) => string
  layout: ReturnType<typeof useLayout>
  params: { dir?: string; id?: string }
  currentSessions: () => Session[]
  currentProject: () => LocalProject | undefined
  workspaceSetting: () => boolean
  availableThemeEntries: () => Array<readonly [string, DesktopTheme]>
  newDesign: () => boolean
  platform: Platform
  command: ReturnType<typeof useCommand>
  navigateProjectByOffset: (offset: number) => void
  navigateSessionByOffset: (offset: number) => void
  navigateSessionByUnseen: (offset: number) => void
  archiveSession: (session: Session) => Promise<void>
  navigateToProjectIndex: (index: number) => void
  createWorkspace: (project: LocalProject) => Promise<void>
  chooseProject: () => void
  openServer: () => void
  openSettings: () => void
  connectProvider: () => void
}

export function registerLayoutCommands(api: LayoutCommandsApi) {
  const {
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
  } = api

function cycleTheme(direction = 1) {
  const ids = availableThemeEntries().map(([id]) => id)
  if (ids.length === 0) return
  const currentIndex = ids.indexOf(theme.themeId())
  const nextIndex = currentIndex === -1 ? 0 : (currentIndex + direction + ids.length) % ids.length
  const nextThemeId = ids[nextIndex]
  theme.setTheme(nextThemeId)
  showToast({
    title: language.t("toast.theme.title"),
    description: theme.name(nextThemeId),
  })
}

function cycleColorScheme(direction = 1) {
  const current = theme.colorScheme()
  const currentIndex = colorSchemeOrder.indexOf(current)
  const nextIndex =
    currentIndex === -1 ? 0 : (currentIndex + direction + colorSchemeOrder.length) % colorSchemeOrder.length
  const next = colorSchemeOrder[nextIndex]
  theme.setColorScheme(next)
  showToast({
    title: language.t("toast.scheme.title"),
    description: colorSchemeLabel(next),
  })
}

function setLocale(next: Locale) {
  if (next === language.locale()) return
  language.setLocale(next)
  showToast({
    title: language.t("toast.language.title"),
    description: language.t("toast.language.description", { language: language.label(next) }),
  })
}

function cycleLanguage(direction = 1) {
  const locales = language.locales
  const currentIndex = locales.indexOf(language.locale())
  const nextIndex = currentIndex === -1 ? 0 : (currentIndex + direction + locales.length) % locales.length
  const next = locales[nextIndex]
  if (!next) return
  setLocale(next)
}

  command.register("layout", () => {
    const commands: CommandOption[] = [
      {
        id: "sidebar.toggle",
        title: language.t("command.sidebar.toggle"),
        category: language.t("command.category.view"),
        keybind: newDesign() ? undefined : "mod+b",
        onSelect: () => layout.sidebar.toggle(),
      },
      {
        id: "project.open",
        title: language.t("command.project.open"),
        category: language.t("command.category.project"),
        keybind: "mod+o",
        onSelect: () => chooseProject(),
      },
      {
        id: "project.previous",
        title: language.t("command.project.previous"),
        category: language.t("command.category.project"),
        keybind: "mod+alt+arrowup",
        onSelect: () => navigateProjectByOffset(-1),
      },
      {
        id: "project.next",
        title: language.t("command.project.next"),
        category: language.t("command.category.project"),
        keybind: "mod+alt+arrowdown",
        onSelect: () => navigateProjectByOffset(1),
      },
      {
        id: "provider.connect",
        title: language.t("command.provider.connect"),
        category: language.t("command.category.provider"),
        onSelect: () => connectProvider(),
      },
      {
        id: "server.switch",
        title: language.t("command.server.switch"),
        category: language.t("command.category.server"),
        onSelect: () => openServer(),
      },
      {
        id: "settings.open",
        title: language.t("command.settings.open"),
        category: language.t("command.category.settings"),
        keybind: "mod+comma",
        onSelect: () => openSettings(),
      },
      ...(platform.platform === "desktop" && platform.exportDebugLogs
        ? [
            {
              id: "logs.export",
              title: "Export logs",
              category: language.t("command.category.settings"),
              onSelect: () => {
                void platform.exportDebugLogs?.()
              },
            },
          ]
        : []),
      {
        id: "session.previous",
        title: language.t("command.session.previous"),
        category: language.t("command.category.session"),
        keybind: "alt+arrowup",
        onSelect: () => navigateSessionByOffset(-1),
      },
      {
        id: "session.next",
        title: language.t("command.session.next"),
        category: language.t("command.category.session"),
        keybind: "alt+arrowdown",
        onSelect: () => navigateSessionByOffset(1),
      },
      {
        id: "session.previous.unseen",
        title: language.t("command.session.previous.unseen"),
        category: language.t("command.category.session"),
        keybind: "shift+alt+arrowup",
        onSelect: () => navigateSessionByUnseen(-1),
      },
      {
        id: "session.next.unseen",
        title: language.t("command.session.next.unseen"),
        category: language.t("command.category.session"),
        keybind: "shift+alt+arrowdown",
        onSelect: () => navigateSessionByUnseen(1),
      },
      {
        id: "session.archive",
        title: language.t("command.session.archive"),
        category: language.t("command.category.session"),
        keybind: "mod+shift+backspace",
        disabled: !params.dir || !params.id,
        onSelect: () => {
          const session = currentSessions().find((s) => s.id === params.id)
          if (session) void archiveSession(session)
        },
      },
      {
        id: "workspace.new",
        title: language.t("workspace.new"),
        category: language.t("command.category.workspace"),
        keybind: "mod+shift+w",
        disabled: !workspaceSetting(),
        onSelect: () => {
          const project = currentProject()
          if (!project) return
          return createWorkspace(project)
        },
      },
      {
        id: "workspace.toggle",
        title: language.t("command.workspace.toggle"),
        description: language.t("command.workspace.toggle.description"),
        category: language.t("command.category.workspace"),
        slash: "workspace",
        disabled: !currentProject() || currentProject()?.vcs !== "git",
        onSelect: () => {
          const project = currentProject()
          if (!project) return
          if (project.vcs !== "git") return
          const wasEnabled = layout.sidebar.workspaces(project.worktree)()
          layout.sidebar.toggleWorkspaces(project.worktree)
          showToast({
            title: wasEnabled
              ? language.t("toast.workspace.disabled.title")
              : language.t("toast.workspace.enabled.title"),
            description: wasEnabled
              ? language.t("toast.workspace.disabled.description")
              : language.t("toast.workspace.enabled.description"),
          })
        },
      },
      {
        id: "theme.cycle",
        title: language.t("command.theme.cycle"),
        category: language.t("command.category.theme"),
        keybind: "mod+shift+t",
        onSelect: () => cycleTheme(1),
      },
    ]

    if (!newDesign())
      Array.from({ length: 9 }, (_, i) => {
        const index = i
        const number = index + 1
        commands.push({
          id: `project.${number}`,
          category: language.t("command.category.project"),
          title: `Open Project {number}`,
          keybind: `mod+${number}`,
          disabled: layout.projects.list().length <= index,
          hidden: true,
          onSelect: () => navigateToProjectIndex(index),
        })
      })

    for (const [id] of availableThemeEntries()) {
      commands.push({
        id: `theme.set.${id}`,
        title: language.t("command.theme.set", { theme: theme.name(id) }),
        category: language.t("command.category.theme"),
        onSelect: () => theme.commitPreview(),
        onHighlight: () => {
          theme.previewTheme(id)
          return () => theme.cancelPreview()
        },
      })
    }

    commands.push({
      id: "theme.scheme.cycle",
      title: language.t("command.theme.scheme.cycle"),
      category: language.t("command.category.theme"),
      keybind: "mod+shift+s",
      onSelect: () => cycleColorScheme(1),
    })

    for (const scheme of colorSchemeOrder) {
      commands.push({
        id: `theme.scheme.${scheme}`,
        title: language.t("command.theme.scheme.set", { scheme: colorSchemeLabel(scheme) }),
        category: language.t("command.category.theme"),
        onSelect: () => theme.commitPreview(),
        onHighlight: () => {
          theme.previewColorScheme(scheme)
          return () => theme.cancelPreview()
        },
      })
    }

    commands.push({
      id: "language.cycle",
      title: language.t("command.language.cycle"),
      category: language.t("command.category.language"),
      onSelect: () => cycleLanguage(1),
    })

    for (const locale of language.locales) {
      commands.push({
        id: `language.set.${locale}`,
        title: language.t("command.language.set", { language: language.label(locale) }),
        category: language.t("command.category.language"),
        onSelect: () => setLocale(locale),
      })
    }

    return commands
  })


}

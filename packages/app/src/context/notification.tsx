import { createStore, reconcile } from "solid-js/store"
import { batch, createEffect, createMemo, onCleanup } from "solid-js"
import { useParams } from "@solidjs/router"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useServerSDK } from "./server-sdk"
import { useServerSync } from "./server-sync"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { Binary } from "@opencode-ai/core/util/binary"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { decode64 } from "@/utils/base64"
import { EventSessionError } from "@opencode-ai/sdk/v2"
import { Persist, persisted } from "@/utils/persist"
import { playSoundById } from "@/utils/sound"
import { showToast } from "@/utils/toast"
import { planProviderFallbackAnnouncement } from "@/utils/provider-fallback-announce"

type NotificationBase = {
  directory?: string
  session?: string
  metadata?: unknown
  time: number
  viewed: boolean
}

type TurnCompleteNotification = NotificationBase & {
  type: "turn-complete"
}

type ErrorNotification = NotificationBase & {
  type: "error"
  error: EventSessionError["properties"]["error"]
}

export type Notification = TurnCompleteNotification | ErrorNotification

// Red line (AGENTS.md): a provider fallback must never happen silently. The
// server publishes "session.provider-fallback" so the user sees which model
// failed, which one took over, and whether that one is billable. The SDK event
// union is generated, so this payload is narrowed locally instead of
// regenerating the whole SDK for one event.
type ProviderFallbackEvent = {
  type: "session.provider-fallback"
  properties: {
    sessionID?: string
    failedProviderID: string
    failedModelID: string
    fallbackProviderID: string
    fallbackModelID: string
    fallbackPaid: boolean
    message?: string
  }
}

function isProviderFallbackEvent(event: { type?: string } | undefined): event is ProviderFallbackEvent {
  return event?.type === "session.provider-fallback"
}

type NotificationIndex = {
  session: {
    all: Record<string, Notification[]>
    unseen: Record<string, Notification[]>
    unseenCount: Record<string, number>
    unseenHasError: Record<string, boolean>
  }
  project: {
    all: Record<string, Notification[]>
    unseen: Record<string, Notification[]>
    unseenCount: Record<string, number>
    unseenHasError: Record<string, boolean>
  }
}

const MAX_NOTIFICATIONS = 500
const NOTIFICATION_TTL_MS = 1000 * 60 * 60 * 24 * 30

function pruneNotifications(list: Notification[]) {
  const cutoff = Date.now() - NOTIFICATION_TTL_MS
  const pruned = list.filter((n) => n.time >= cutoff)
  if (pruned.length <= MAX_NOTIFICATIONS) return pruned
  return pruned.slice(pruned.length - MAX_NOTIFICATIONS)
}

function createNotificationIndex(): NotificationIndex {
  return {
    session: {
      all: {},
      unseen: {},
      unseenCount: {},
      unseenHasError: {},
    },
    project: {
      all: {},
      unseen: {},
      unseenCount: {},
      unseenHasError: {},
    },
  }
}

function buildNotificationIndex(list: Notification[]) {
  const index = createNotificationIndex()

  list.forEach((notification) => {
    if (notification.session) {
      const all = index.session.all[notification.session] ?? []
      index.session.all[notification.session] = [...all, notification]
      if (!notification.viewed) {
        const unseen = index.session.unseen[notification.session] ?? []
        index.session.unseen[notification.session] = [...unseen, notification]
        index.session.unseenCount[notification.session] = unseen.length + 1
        if (notification.type === "error") index.session.unseenHasError[notification.session] = true
      }
    }

    if (notification.directory) {
      const all = index.project.all[notification.directory] ?? []
      index.project.all[notification.directory] = [...all, notification]
      if (!notification.viewed) {
        const unseen = index.project.unseen[notification.directory] ?? []
        index.project.unseen[notification.directory] = [...unseen, notification]
        index.project.unseenCount[notification.directory] = unseen.length + 1
        if (notification.type === "error") index.project.unseenHasError[notification.directory] = true
      }
    }
  })

  return index
}

export const { use: useNotification, provider: NotificationProvider } = createSimpleContext({
  name: "Notification",
  gate: false,
  init: () => {
    const params = useParams()
    const serverSDK = useServerSDK()
    const serverSync = useServerSync()
    const platform = usePlatform()
    const settings = useSettings()
    const language = useLanguage()

    const empty: Notification[] = []

    const currentDirectory = createMemo(() => {
      return decode64(params.dir)
    })

    const currentSession = createMemo(() => params.id)

    const [store, setStore, _, ready] = persisted(
      Persist.serverGlobal(serverSDK().scope, "notification", ["notification.v1"]),
      createStore({
        list: [] as Notification[],
      }),
    )
    const [index, setIndex] = createStore<NotificationIndex>(buildNotificationIndex(store.list))

    const meta = { pruned: false, disposed: false }

    const updateUnseen = (scope: "session" | "project", key: string, unseen: Notification[]) => {
      setIndex(scope, "unseen", key, unseen)
      setIndex(scope, "unseenCount", key, unseen.length)
      setIndex(
        scope,
        "unseenHasError",
        key,
        unseen.some((notification) => notification.type === "error"),
      )
    }

    const appendToIndex = (notification: Notification) => {
      if (notification.session) {
        setIndex("session", "all", notification.session, (all = []) => [...all, notification])
        if (!notification.viewed) {
          setIndex("session", "unseen", notification.session, (unseen = []) => [...unseen, notification])
          setIndex("session", "unseenCount", notification.session, (count = 0) => count + 1)
          if (notification.type === "error") setIndex("session", "unseenHasError", notification.session, true)
        }
      }

      if (notification.directory) {
        setIndex("project", "all", notification.directory, (all = []) => [...all, notification])
        if (!notification.viewed) {
          setIndex("project", "unseen", notification.directory, (unseen = []) => [...unseen, notification])
          setIndex("project", "unseenCount", notification.directory, (count = 0) => count + 1)
          if (notification.type === "error") setIndex("project", "unseenHasError", notification.directory, true)
        }
      }
    }

    const removeFromIndex = (notification: Notification) => {
      if (notification.session) {
        setIndex("session", "all", notification.session, (all = []) => all.filter((n) => n !== notification))
        if (!notification.viewed) {
          const unseen = (index.session.unseen[notification.session] ?? empty).filter((n) => n !== notification)
          updateUnseen("session", notification.session, unseen)
        }
      }

      if (notification.directory) {
        setIndex("project", "all", notification.directory, (all = []) => all.filter((n) => n !== notification))
        if (!notification.viewed) {
          const unseen = (index.project.unseen[notification.directory] ?? empty).filter((n) => n !== notification)
          updateUnseen("project", notification.directory, unseen)
        }
      }
    }

    createEffect(() => {
      if (!ready()) return
      if (meta.pruned) return
      meta.pruned = true
      const list = pruneNotifications(store.list)
      batch(() => {
        setStore("list", list)
        setIndex(reconcile(buildNotificationIndex(list), { merge: false }))
      })
    })

    const append = (notification: Notification) => {
      const list = pruneNotifications([...store.list, notification])
      const keep = new Set(list)
      const removed = store.list.filter((n) => !keep.has(n))

      batch(() => {
        if (keep.has(notification)) appendToIndex(notification)
        removed.forEach((n) => removeFromIndex(n))
        setStore("list", list)
      })
    }

    const lookup = async (directory: string, sessionID?: string) => {
      if (!sessionID) return undefined
      const [syncStore] = serverSync().child(directory, { bootstrap: false })
      const match = Binary.search(syncStore.session, sessionID, (s) => s.id)
      if (match.found) return syncStore.session[match.index]
      return serverSDK()
        .client.session.get({ directory, sessionID })
        .then((x) => x.data)
        .catch(() => undefined)
    }

    const viewedInCurrentSession = (directory: string, sessionID?: string) => {
      const activeDirectory = currentDirectory()
      const activeSession = currentSession()
      if (!activeDirectory) return false
      if (!activeSession) return false
      if (!sessionID) return false
      if (directory !== activeDirectory) return false
      return sessionID === activeSession
    }

    const handleSessionIdle = (directory: string, event: { properties: { sessionID?: string } }, time: number) => {
      const sessionID = event.properties.sessionID
      void lookup(directory, sessionID).then((session) => {
        if (meta.disposed) return
        if (!session) return
        if (session.parentID) return

        if (settings.sounds.agentEnabled()) {
          void playSoundById(settings.sounds.agent())
        }

        append({
          directory,
          time,
          viewed: viewedInCurrentSession(directory, sessionID),
          type: "turn-complete",
          session: sessionID,
        })

        const href = `/${base64Encode(directory)}/session/${sessionID}`
        if (settings.notifications.agent()) {
          void platform.notify(language.t("notification.session.responseReady.title"), session.title ?? sessionID, href)
        }
      })
    }

    const handleSessionError = (
      directory: string,
      event: { properties: { sessionID?: string; error?: EventSessionError["properties"]["error"] } },
      time: number,
    ) => {
      const sessionID = event.properties.sessionID
      void lookup(directory, sessionID).then((session) => {
        if (meta.disposed) return
        if (session?.parentID) return

        if (settings.sounds.errorsEnabled()) {
          void playSoundById(settings.sounds.errors())
        }

        const error = "error" in event.properties ? event.properties.error : undefined
        append({
          directory,
          time,
          viewed: viewedInCurrentSession(directory, sessionID),
          type: "error",
          session: sessionID ?? "global",
          error,
        })
        const description =
          session?.title ??
          (typeof error === "string" ? error : language.t("notification.session.error.fallbackDescription"))
        const href = sessionID ? `/${base64Encode(directory)}/session/${sessionID}` : `/${base64Encode(directory)}`
        if (settings.notifications.errors()) {
          void platform.notify(language.t("notification.session.error.title"), description, href)
        }
      })
    }

    const handleProviderFallback = (directory: string, event: ProviderFallbackEvent) => {
      const sessionID = event.properties.sessionID
      const failed = `${event.properties.failedProviderID}/${event.properties.failedModelID}`
      const fallback = `${event.properties.fallbackProviderID}/${event.properties.fallbackModelID}`
      const description = language.t("notification.session.providerFallback.description", { failed, fallback })
      const href = sessionID ? `/${base64Encode(directory)}/session/${sessionID}` : `/${base64Encode(directory)}`
      const title = language.t("notification.session.providerFallback.title")
      // Always announced, even when the sound/notification toggles are off: the
      // red line forbids a silent provider fallback. platform.notify is an OS
      // notification the desktop shell suppresses while the window is focused —
      // exactly when the user is watching — so the in-app toast carries the
      // announcement on the surface they can actually see.
      const announcement = planProviderFallbackAnnouncement({ failed, fallback, title, description, href })
      if (announcement.system) void platform.notify(announcement.title, announcement.description, announcement.href)
      if (announcement.inApp) showToast({ title: announcement.title, description: announcement.description })
    }

    const unsub = serverSDK().event.listen((e) => {
      const event = e.details
      const raw: { type?: string } = event
      if (isProviderFallbackEvent(raw)) {
        handleProviderFallback(e.name, raw)
        return
      }
      if (event.type !== "session.idle" && event.type !== "session.error") return

      const directory = e.name
      const time = Date.now()
      if (event.type === "session.idle") {
        handleSessionIdle(directory, event, time)
        return
      }
      handleSessionError(directory, event, time)
    })
    onCleanup(() => {
      meta.disposed = true
      unsub()
    })

    return {
      ready,
      session: {
        all(session: string) {
          return index.session.all[session] ?? empty
        },
        unseen(session: string) {
          return index.session.unseen[session] ?? empty
        },
        unseenCount(session: string) {
          return index.session.unseenCount[session] ?? 0
        },
        unseenHasError(session: string) {
          return index.session.unseenHasError[session] ?? false
        },
        markViewed(session: string) {
          const unseen = index.session.unseen[session] ?? empty
          if (!unseen.length) return

          const projects = [
            ...new Set(unseen.flatMap((notification) => (notification.directory ? [notification.directory] : []))),
          ]
          batch(() => {
            setStore("list", (n) => n.session === session && !n.viewed, "viewed", true)
            updateUnseen("session", session, [])
            projects.forEach((directory) => {
              const next = (index.project.unseen[directory] ?? empty).filter(
                (notification) => notification.session !== session,
              )
              updateUnseen("project", directory, next)
            })
          })
        },
      },
      project: {
        all(directory: string) {
          return index.project.all[directory] ?? empty
        },
        unseen(directory: string) {
          return index.project.unseen[directory] ?? empty
        },
        unseenCount(directory: string) {
          return index.project.unseenCount[directory] ?? 0
        },
        unseenHasError(directory: string) {
          return index.project.unseenHasError[directory] ?? false
        },
        markViewed(directory: string) {
          const unseen = index.project.unseen[directory] ?? empty
          if (!unseen.length) return

          const sessions = [
            ...new Set(unseen.flatMap((notification) => (notification.session ? [notification.session] : []))),
          ]
          batch(() => {
            setStore("list", (n) => n.directory === directory && !n.viewed, "viewed", true)
            updateUnseen("project", directory, [])
            sessions.forEach((session) => {
              const next = (index.session.unseen[session] ?? empty).filter(
                (notification) => notification.directory !== directory,
              )
              updateUnseen("session", session, next)
            })
          })
        },
      },
    }
  },
})

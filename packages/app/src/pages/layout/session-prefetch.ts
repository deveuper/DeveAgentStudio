// Session message prefetch queue, extracted from `pages/layout.tsx`.
//
// The layout keeps a per-directory prefetch queue with bounded concurrency,
// an LRU cap per directory, and a global generation token so a route change
// invalidates in-flight prefetches. Messages are merged into the child store
// with `reconcile` and cache eviction via the shared global-sync helpers.
//
// Extracted verbatim; do not change behavior here without re-running the
// packaged click-through E2E.

import { batch, createEffect, untrack, type Accessor } from "solid-js"
import { produce, reconcile } from "solid-js/store"
import { retry } from "@opencode-ai/core/util/retry"
import { type Message, type Session } from "@opencode-ai/sdk/v2/client"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import {
  clearSessionPrefetch,
  clearSessionPrefetchInflight,
  getSessionPrefetch,
  isSessionPrefetchCurrent,
  runSessionPrefetch,
  setSessionPrefetch,
  shouldSkipSessionPrefetch,
} from "@/context/global-sync/session-prefetch"
import { dropSessionCaches, pickSessionCacheEvictions } from "@/context/global-sync/session-cache"
import { pathKey } from "@/utils/path-key"

type PrefetchQueue = {
  inflight: Set<string>
  pending: string[]
  pendingSet: Set<string>
  running: number
}

const prefetchChunk = 200
const prefetchConcurrency = 2
const prefetchPendingLimit = 10
const span = 4
const PREFETCH_MAX_SESSIONS_PER_DIR = 10

export interface SessionPrefetchOptions {
  visibleSessionDirs: Accessor<string[]>
  currentSessions: Accessor<Session[]>
  route: () => unknown
  params: () => { id?: string; dir?: string }
  currentDir: () => string
}

export function useSessionPrefetch(opts: SessionPrefetchOptions) {
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const params = opts.params
  const currentDir = opts.currentDir

  const prefetchToken = { value: 0 }
  const prefetchQueues = new Map<string, PrefetchQueue>()
  const prefetchedByDir = new Map<string, Set<string>>()

  const lruFor = (directory: string) => {
    const existing = prefetchedByDir.get(directory)
    if (existing) return existing
    const created = new Set<string>()
    prefetchedByDir.set(directory, created)
    return created
  }

  const markPrefetched = (directory: string, sessionID: string) => {
    const lru = lruFor(directory)
    const id = params().id
    return pickSessionCacheEvictions({
      seen: lru,
      keep: sessionID,
      limit: PREFETCH_MAX_SESSIONS_PER_DIR,
      preserve: id && pathKey(directory) === pathKey(currentDir()) ? [id] : undefined,
    })
  }

  createEffect(() => {
    const active = new Set(opts.visibleSessionDirs())
    for (const directory of prefetchedByDir.keys()) {
      if (active.has(directory)) continue
      prefetchedByDir.delete(directory)
    }
  })

  createEffect(() => {
    opts.route()
    serverSDK().url

    prefetchToken.value += 1
    clearSessionPrefetchInflight(serverSDK().scope)
    prefetchQueues.clear()
  })

  createEffect(() => {
    const visible = new Set(opts.visibleSessionDirs())
    for (const [directory, q] of prefetchQueues) {
      if (visible.has(directory)) continue
      q.pending.length = 0
      q.pendingSet.clear()
      if (q.running === 0) prefetchQueues.delete(directory)
    }
  })

  const queueFor = (directory: string) => {
    const existing = prefetchQueues.get(directory)
    if (existing) return existing

    const created: PrefetchQueue = {
      inflight: new Set(),
      pending: [],
      pendingSet: new Set(),
      running: 0,
    }
    prefetchQueues.set(directory, created)
    return created
  }

  const mergeByID = <T extends { id: string }>(current: T[], incoming: T[]) => {
    if (current.length === 0) {
      return incoming.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    }

    const map = new Map<string, T>()
    for (const item of current) {
      map.set(item.id, item)
    }
    for (const item of incoming) {
      map.set(item.id, item)
    }
    return [...map.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  async function prefetchMessages(directory: string, sessionID: string, token: number) {
    const [store, setStore] = serverSync().child(directory, { bootstrap: false })

    return runSessionPrefetch({
      scope: serverSDK().scope,
      directory,
      sessionID,
      task: (rev) =>
        retry(() => serverSDK().client.session.messages({ directory, sessionID, limit: prefetchChunk }))
          .then((messages) => {
            if (prefetchToken.value !== token) return
            if (!isSessionPrefetchCurrent(serverSDK().scope, directory, sessionID, rev)) return

            const items = (messages.data ?? []).filter((x) => !!x?.info?.id)
            const next = items.map((x) => x.info).filter((m): m is Message => !!m?.id)
            const sorted = mergeByID([], next)
            const stale = markPrefetched(directory, sessionID)
            const cursor = messages.response.headers.get("x-next-cursor") ?? undefined
            const meta = {
              limit: sorted.length,
              cursor,
              complete: !cursor,
              at: Date.now(),
            }

            if (stale.length > 0) {
              clearSessionPrefetch(serverSDK().scope, directory, stale)
              for (const id of stale) {
                serverSync().todo.set(id, undefined)
              }
            }

            const current = store.message[sessionID] ?? []
            const merged = mergeByID(
              current.filter((item): item is Message => !!item?.id),
              sorted,
            )

            if (!isSessionPrefetchCurrent(serverSDK().scope, directory, sessionID, rev)) return

            batch(() => {
              if (stale.length > 0) {
                setStore(
                  produce((draft) => {
                    dropSessionCaches(draft, stale)
                  }),
                )
              }

              setStore("message", sessionID, reconcile(merged, { key: "id" }))
              setSessionPrefetch({ scope: serverSDK().scope, directory, sessionID, ...meta })

              for (const message of items) {
                const currentParts = store.part[message.info.id] ?? []
                const mergedParts = mergeByID(
                  currentParts.filter((item): item is (typeof currentParts)[number] & { id: string } => !!item?.id),
                  message.parts.filter((item): item is (typeof message.parts)[number] & { id: string } => !!item?.id),
                )

                setStore("part", message.info.id, reconcile(mergedParts, { key: "id" }))
              }
            })

            return meta
          })
          .catch(() => undefined),
    })
  }

  const pumpPrefetch = (directory: string) => {
    const q = queueFor(directory)
    if (q.running >= prefetchConcurrency) return

    const sessionID = q.pending.shift()
    if (!sessionID) return

    q.pendingSet.delete(sessionID)
    q.inflight.add(sessionID)
    q.running += 1

    const token = prefetchToken.value

    void prefetchMessages(directory, sessionID, token).finally(() => {
      q.running -= 1
      q.inflight.delete(sessionID)
      pumpPrefetch(directory)
    })
  }

  const prefetchSession = (session: Session, priority: "high" | "low" = "low") => {
    const directory = session.directory
    if (!directory) return

    const [store] = serverSync().child(directory, { bootstrap: false })
    const cached = untrack(() => {
      const info = getSessionPrefetch(serverSDK().scope, directory, session.id)
      return shouldSkipSessionPrefetch({
        message: store.message[session.id] !== undefined,
        info,
        chunk: prefetchChunk,
      })
    })
    if (cached) return

    const q = queueFor(directory)
    if (q.inflight.has(session.id)) return
    if (q.pendingSet.has(session.id)) {
      if (priority !== "high") return
      const index = q.pending.indexOf(session.id)
      if (index > 0) {
        q.pending.splice(index, 1)
        q.pending.unshift(session.id)
      }
      return
    }

    const lru = lruFor(directory)
    const known = lru.has(session.id)
    if (!known && lru.size >= PREFETCH_MAX_SESSIONS_PER_DIR && priority !== "high") return

    if (priority === "high") q.pending.unshift(session.id)
    if (priority !== "high") q.pending.push(session.id)
    q.pendingSet.add(session.id)

    while (q.pending.length > prefetchPendingLimit) {
      const dropped = q.pending.pop()
      if (!dropped) continue
      q.pendingSet.delete(dropped)
    }

    pumpPrefetch(directory)
  }

  const warm = (sessions: Session[], index: number) => {
    for (let offset = 1; offset <= span; offset++) {
      const next = sessions[index + offset]
      if (next) prefetchSession(next, offset === 1 ? "high" : "low")

      const prev = sessions[index - offset]
      if (prev) prefetchSession(prev, offset === 1 ? "high" : "low")
    }
  }

  createEffect(() => {
    const sessions = opts.currentSessions()
    if (sessions.length === 0) return

    const index = params().id ? sessions.findIndex((s) => s.id === params().id) : 0
    if (index === -1) return

    if (!params().id) {
      const first = sessions[index]
      if (first) prefetchSession(first, "high")
    }

    warm(sessions, index)
  })

  return { prefetchSession, warm }
}

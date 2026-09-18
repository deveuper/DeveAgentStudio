import { createResource, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useSDK } from "@/context/sdk"
import { showToast } from "@/utils/toast"

// ponytail: managed-worktree panel (Codex WorktreeManager UI parity) — list
// the project's isolated worktrees, create new ones, remove stale ones, and
// open a session straight into a worktree via the existing deep-link flow.

export function DeveagentWorktreePanel() {
  const language = useLanguage()  const serverSDK = useServerSDK()
  const sdk = useSDK()
  const base = () => serverSDK().url.replace(/\/+$/, "")
  const directory = () => sdk().directory || ""

  const [root, setRoot] = createSignal("")
  const [mergedNames, setMergedNames] = createSignal<Set<string>>(new Set())
  const [name, setName] = createSignal("")
  const [baseBranch, setBaseBranch] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  const call = async (body: Record<string, unknown>) => {
    const response = await serverSDK().fetch(`${base()}/api/deveagent/worktree`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, directory: directory() }),
    })
    const data = (await response.json().catch(() => ({}))) as { error?: string; worktrees?: unknown }
    if (!response.ok) throw new Error(data.error || language.t("deveagent.worktree.requestFailed"))
    return data
  }

  const [worktrees, { refetch }] = createResource(
    () => directory(),
    async (dir) => {
      if (!dir) return []
      try {
        const data = await call({ action: "list" })
        setRoot(typeof (data as { root?: string }).root === "string" ? (data as { root?: string }).root! : "")
        return Array.isArray(data.worktrees) ? (data.worktrees as Array<{ name: string; path: string; createdAt: string; branch?: string; goal?: { sessionID?: string; description: string; status: string; reentries?: number; maxReentries?: number; criteriaDone?: boolean[] } }>) : []
      } catch {
        return []
      }
    },
    { initialValue: [] },
  )

  const create = async () => {
    if (!name().trim() || busy()) return
    // Immediate client-side duplicate check (backend also rejects, but this
    // avoids a network round-trip and shows the error at the input).
    if (worktrees().some((w) => w.name === name().trim())) {
      showToast({ variant: "error", title: language.t("deveagent.worktree.nameExists"), description: language.t("deveagent.worktree.nameExistsHint") })
      return
    }
    setBusy(true)
    try {
      await call({ action: "create", name: name().trim(), ...(baseBranch().trim() ? { base: baseBranch().trim() } : {}) })
      showToast({ title: language.t("deveagent.worktree.created"), description: name().trim() })
      setName("")
      await refetch()
    } catch (error) {
      showToast({ variant: "error", title: language.t("deveagent.worktree.createFailed"), description: error instanceof Error ? error.message : language.t("deveagent.worktree.requestFailed") })
    } finally {
      setBusy(false)
    }
  }

  const copyPath = async (worktreePath: string) => {
    try {
      await navigator.clipboard.writeText(worktreePath)
      showToast({ title: language.t("deveagent.worktree.pathCopied"), description: worktreePath })
    } catch {
      showToast({ variant: "error", title: language.t("deveagent.worktree.copyFailed"), description: worktreePath })
    }
  }

  const [armedRemove, setArmedRemove] = createSignal<string | undefined>()

  const cleanupMerged = async () => {
    const done = [...mergedNames()]
    for (const worktreeName of done) {
      try {
        await call({ action: "remove", name: worktreeName })
        setMergedNames((prev) => {
          const next = new Set(prev)
          next.delete(worktreeName)
          return next
        })
      } catch (error) {
        showToast({ variant: "error", title: language.t("deveagent.worktree.removeFailed"), description: error instanceof Error ? error.message : worktreeName })
      }
    }
    if (done.length) showToast({ title: language.t("deveagent.worktree.cleanedUp"), description: done.join(", ") })
    await refetch()
  }

  const remove = async (worktreeName: string) => {
    try {
      await call({ action: "remove", name: worktreeName })
      showToast({ title: language.t("deveagent.worktree.removed"), description: worktreeName })
      await refetch()
    } catch (error) {
      showToast({ variant: "error", title: language.t("deveagent.worktree.removeFailed"), description: error instanceof Error ? error.message : language.t("deveagent.worktree.requestFailed") })
    }
  }

  const merge = async (worktreeName: string) => {
    try {
      const data = (await call({ action: "merge", name: worktreeName })) as { output?: string }
      setMergedNames((prev) => new Set(prev).add(worktreeName))
      showToast({ title: language.t("deveagent.worktree.mergedIntoMain"), description: data.output?.slice(0, 200) || worktreeName })
      await refetch()
    } catch (error) {
      showToast({ variant: "error", title: language.t("deveagent.worktree.mergeFailed"), description: error instanceof Error ? error.message : language.t("deveagent.worktree.requestFailed") })
    }
  }

  const openIn = (worktreePath: string) => {
    window.dispatchEvent(
      new CustomEvent("deveagent:deep-link", {
        detail: { urls: [`${"deveagent://new-session?directory="}${encodeURIComponent(worktreePath)}`] },
      }),
    )
  }

  return (
    <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <Show when={root()}>
        <div class="text-11-regular text-text-faint" title={root()}>
          {language.t("deveagent.worktree.managedRoot")}: {root()}
        </div>
      </Show>
      <div class="sticky top-0 z-10 -mx-4 flex items-center justify-between border-b border-border-weak-base bg-background-base px-4 py-2">
        <div class="text-12-medium text-text-strong">{language.t("deveagent.worktree.title")}</div>
        <button
          type="button"
          class="size-6 rounded text-text-weak hover:bg-surface-base hover:text-text-base"
          aria-label={language.t("deveagent.worktree.refreshList")}
          title={language.t("deveagent.worktree.refreshList")}
          onClick={() => void refetch()}
          data-action="deveagent-worktree-refresh"
        >
          ↻
        </button>
      </div>
      <div class="sticky top-[41px] z-10 -mx-4 flex items-center gap-2 bg-background-base px-4 py-2">
        <input
          class="min-w-0 flex-1 rounded-md border border-border-weak-base bg-background-base px-2.5 py-1.5 text-12-regular text-text-base outline-none placeholder:text-text-faint focus:border-border-strong-base"
          placeholder={language.t("deveagent.worktree.namePlaceholder")}
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create()
          }}
          data-action="deveagent-worktree-name"
        />
        <input
          class="min-w-0 flex-1 rounded-md border border-border-weak-base bg-background-base px-2.5 py-1.5 text-12-regular text-text-base outline-none placeholder:text-text-faint focus:border-border-strong-base"
          placeholder={language.t("deveagent.worktree.basePlaceholder")}
          value={baseBranch()}
          onInput={(e) => setBaseBranch(e.currentTarget.value)}
          data-action="deveagent-worktree-base"
        />
        <button
          type="button"
          class="shrink-0 rounded-md border border-border-weak-base bg-surface-base px-3 py-1.5 text-12-medium text-text-base hover:bg-background-base disabled:opacity-50"
          disabled={busy() || !name().trim()}
          onClick={() => void create()}
          data-action="deveagent-worktree-create"
        >
          {busy() ? language.t("deveagent.worktree.creating") : language.t("deveagent.worktree.create")}
        </button>
      </div>
      <Show
        when={worktrees().length > 0}
        fallback={
          <div class="flex flex-col items-start gap-2 text-12-regular text-text-weak">
            <span>{language.t("deveagent.worktree.empty")}</span>
            <button
              type="button"
              class="rounded-md border border-border-weak-base px-2.5 py-1 text-12-medium text-text-base hover:bg-background-base"
              onClick={() => void create()}
              data-action="deveagent-worktree-quick-create"
            >
              {language.t("deveagent.worktree.quickCreate")}
            </button>
          </div>
        }
      >
        <For each={worktrees()}>
          {(worktree) => (
            <div class="rounded-lg border border-border-weak-base bg-surface-base px-3 py-2.5" data-component="deveagent-worktree-item">
              <div class="flex items-center gap-2">
                <span class="min-w-0 flex-1 truncate text-13-medium text-text-strong">{worktree.name}</span>
                <Show when={mergedNames().has(worktree.name)}>
                  <span class="shrink-0 rounded bg-v2-state-fg-success/15 px-1.5 py-0.5 text-11-medium text-v2-state-fg-success">
                    {language.t("deveagent.worktree.merged")}
                  </span>
                </Show>
                <Show when={worktree.goal}>
                  {(goal) => (
                    <span
                      class="shrink-0 rounded px-1.5 py-0.5 text-11-medium text-v2-text-text-accent"
                      classList={{ "bg-v2-background-bg-accent/10": goal().status !== "verified" }}
                      title={`${goal().status} · ${goal().description}`}
                    >
                      {worktree.goal!.status === "verified" ? "✓" : "●"} {goal().reentries ?? 0}/{goal().maxReentries ?? 0}
                      <Show when={(goal().criteriaDone ?? []).length > 0}>
                        {" · "}{(goal().criteriaDone ?? []).filter(Boolean).length}/{(goal().criteriaDone ?? []).length}
                      </Show>
                    </span>
                  )}
                </Show>
                <button
                  type="button"
                  class="shrink-0 rounded-md border border-border-weak-base px-2 py-1 text-11-medium text-text-base hover:bg-background-base"
                  title={language.t("deveagent.worktree.openSessionTitle")}
                  onClick={() => openIn(worktree.path)}
                  data-action="deveagent-worktree-open"
                >
                  {language.t("deveagent.worktree.openSession")}
                </button>
                <button
                  type="button"
                  class="shrink-0 rounded-md border border-border-weak-base px-2 py-1 text-11-medium text-text-base hover:bg-background-base"
                  title={language.t("deveagent.worktree.mergeTitle")}
                  onClick={() => void merge(worktree.name)}
                  data-action="deveagent-worktree-merge"
                >
                  {language.t("deveagent.worktree.merge")}
                </button>
                <button
                  type="button"
                  class="size-6 shrink-0 rounded text-text-weak hover:bg-surface-base hover:text-text-base"
                  aria-label={language.t("deveagent.worktree.copyPathTitle")}
                  title={language.t("deveagent.worktree.copyPath")}
                  onClick={() => void copyPath(worktree.path)}
                  data-action="deveagent-worktree-copy-path"
                >
                  ⧉
                </button>
                <button
                  type="button"
                  class="size-6 shrink-0 rounded text-text-weak hover:bg-surface-base hover:text-text-base"
                  classList={{ "text-v2-state-fg-danger": armedRemove() === worktree.name }}
                  aria-label={language.t("deveagent.worktree.removeTitle")}
                  title={armedRemove() === worktree.name ? language.t("deveagent.worktree.confirmRemove") : language.t("deveagent.worktree.remove")}
                  onClick={() => {
                    if (armedRemove() !== worktree.name) {
                      setArmedRemove(worktree.name)
                      window.setTimeout(() => setArmedRemove(undefined), 3000)
                      return
                    }
                    setArmedRemove(undefined)
                    void remove(worktree.name)
                  }}
                  data-action="deveagent-worktree-remove"
                >
                  {armedRemove() === worktree.name ? "✓" : "×"}
                </button>
              </div>
              <div class="mt-1 flex items-center gap-2">
                <Show when={worktree.branch}>
                  <span class="shrink-0 rounded bg-v2-background-bg-accent/10 px-1.5 py-0.5 text-11-medium text-v2-text-text-accent">{worktree.branch}</span>
                </Show>
                <span class="min-w-0 truncate text-11-regular text-text-faint" title={worktree.path}>
                  {worktree.path}
                </span>
                <span class="shrink-0 text-11-regular text-text-faint">
                  {(() => {
                    const minutes = Math.max(0, Math.floor((Date.now() - new Date(worktree.createdAt).getTime()) / 60000))
                    if (minutes < 1) return language.t("deveagent.worktree.timeJustNow")
                    if (minutes < 60) return language.t("deveagent.worktree.timeMinutesAgo", { count: minutes })
                    const hours = Math.floor(minutes / 60)
                    if (hours < 24) return language.t("deveagent.worktree.timeHoursAgo", { count: hours })
                    return language.t("deveagent.worktree.timeDaysAgo", { count: Math.floor(hours / 24) })
                  })()}
                </span>
              </div>
            </div>
          )}
        </For>
      </Show>
      <Show when={mergedNames().size > 0}>
        <button
          type="button"
          class="rounded-md border border-v2-state-fg-success/40 px-3 py-1.5 text-12-medium text-v2-state-fg-success hover:bg-v2-background-bg-layer-02"
          onClick={() => void cleanupMerged()}
          data-action="deveagent-worktree-cleanup-merged"
        >
          {language.t("deveagent.worktree.cleanUp")}
        </button>
      </Show>
    </div>
  )
}

import { createEffect, createMemo, onCleanup, onMount, Show, untrack } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { createStore } from "solid-js/store"
import { useSearchParams } from "@solidjs/router"
import { DeveagentDashboard } from "@/components/deveagent-dashboard"
import { DeveagentMemoryBrowser } from "@/components/deveagent-memory-browser"
import { DeveagentStatusBar } from "@/components/deveagent-statusbar"
import { DeveagentTeamPanel } from "@/components/deveagent-team-panel"
import { setDeveAgentBaseUrl } from "@/components/deveagent-composer-state"
import { NewSessionDesignView } from "@/components/session"
import { useComments } from "@/context/comments"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useSync } from "@/context/sync"
import { createSessionComposerState, SessionComposerRegion } from "@/pages/session/composer"

/**
 * The `/new-session` draft page. Unlike `session.tsx`, this only renders the prompt
 * composer for a brand-new session — no terminal, review pane, file tree, or message
 * timeline. Submitting promotes the draft into a real session (see prompt-input/submit).
 */
export default function NewSessionPage() {
  const prompt = usePrompt()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const sync = useSync()
  const comments = useComments()
  const [searchParams, setSearchParams] = useSearchParams<{ prompt?: string }>()

  let inputRef: HTMLDivElement | undefined

  const composer = createSessionComposerState()
  const isDesktop = createMediaQuery("(min-width: 768px)")

  const [store, setStore] = createStore({
    worktree: "main",
    memoryPanelOpen: false,
    teamPanelOpen: false,
    reviewPanelOpen: false,
    // Keep the real overview available on a fresh session too. The user can
    // still close it, but opening Review/Skill/Team must not make the only
    // metrics entry point a detached button.
    metricsPanelOpen: true,
  })

  const newSessionWorktree = createMemo(() => {
    if (store.worktree === "create") return "create"
    const project = sync().project
    if (project && sdk().directory !== project.worktree) return sdk().directory
    return "main"
  })

  createEffect(() => {
    if (!prompt.ready()) return
    untrack(() => {
      const text = searchParams.prompt
      if (!text) return
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      setSearchParams({ ...searchParams, prompt: undefined })
    })
  })

  onMount(() => {
    setDeveAgentBaseUrl(serverSDK().url, serverSDK().fetch)
    requestAnimationFrame(() => inputRef?.focus())
    const handleOpenPanel = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail === "close") {
        setStore("memoryPanelOpen", false)
        setStore("teamPanelOpen", false)
        setStore("reviewPanelOpen", false)
        return
      }
      // Tool drawers are mutually exclusive; the Overview rail owns an independent lifecycle.
      setStore("memoryPanelOpen", false)
      setStore("teamPanelOpen", false)
      setStore("reviewPanelOpen", false)
      if (detail === "skill-store") {
        // ponytail: use the single layout-level market host so every entry shares one SDK context.
        window.dispatchEvent(new CustomEvent("deveagent:open-store", { detail: "market" }))
      }
      if (detail === "team") setStore("teamPanelOpen", true)
      if (detail === "memory") setStore("memoryPanelOpen", true)
      if (detail === "review") setStore("reviewPanelOpen", true)
      if (detail === "metrics" || detail === "token") {
        setStore("metricsPanelOpen", true)
        window.dispatchEvent(new CustomEvent("deveagent:dashboard-tab", { detail: "overview" }))
      }
      if (detail === "codegraph") {
        setStore("metricsPanelOpen", true)
        window.dispatchEvent(new CustomEvent("deveagent:dashboard-tab", { detail: "codegraph" }))
      }
    }
    window.addEventListener("deveagent:open-panel", handleOpenPanel)
    onCleanup(() => {
      window.removeEventListener("deveagent:open-panel", handleOpenPanel)
    })
  })

  return (
    <div class="relative size-full min-h-0 min-w-0 overflow-hidden flex flex-col">
      <div
        class="grid flex-1 min-h-0 min-w-0 gap-2 p-2"
        style={{
          "grid-template-columns": isDesktop() && store.metricsPanelOpen ? "minmax(0, 1fr) clamp(240px, 22vw, 340px)" : "minmax(0, 1fr)",
        }}
      >
        <div class="flex-1 min-h-0 min-w-0 flex flex-col">
          <div class="@container relative flex flex-col min-h-0 h-full bg-background-stronger flex-1">
            <div class="flex-1 min-h-0 overflow-hidden rounded-[10px]">
              <NewSessionDesignView directory={sdk().directory}>
                <SessionComposerRegion
                  state={composer}
                  ready
                  centered={false}
                  placement="inline"
                  inputRef={(el) => {
                    inputRef = el
                  }}
                  newSessionWorktree={newSessionWorktree()}
                  onNewSessionWorktreeReset={() => setStore("worktree", "main")}
                  onSubmit={() => comments.clear()}
                  onResponseSubmit={() => {}}
                  setPromptDockRef={() => {}}
                />
              </NewSessionDesignView>
            </div>
          </div>
        </div>
        <Show when={isDesktop() && store.metricsPanelOpen}>
          <aside data-component="deveagent-overview-panel" class="relative z-20 flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden border-l border-border-weak-base bg-background-base shadow-[var(--v2-elevation-raised)]">
            <div class="flex h-10 items-center gap-2 border-b border-border-weak-base px-3">
              <div class="text-13-medium text-text-strong">概览</div>
              <div class="text-11-regular text-text-weak">上下文 · 成本 · 缓存</div>
              <div class="flex-1" />
              <button
                type="button"
                class="size-7 rounded-md text-text-weak hover:bg-surface-base hover:text-text-base"
                title="隐藏右侧指标栏"
                onClick={() => setStore("metricsPanelOpen", false)}
              >
                ×
              </button>
            </div>
            <div class="min-h-0 flex-1 overflow-y-auto bg-background-base">
              <DeveagentDashboard />
            </div>
          </aside>
        </Show>
      </div>
      <Show when={isDesktop() && !store.metricsPanelOpen}>
        <button
          type="button"
          class="fixed right-3 top-14 z-40 rounded-md border border-border-weak-base bg-background-base px-2.5 py-1.5 text-12-medium text-text-base shadow-[var(--v2-elevation-raised)] hover:bg-surface-base"
          title="打开 DeveAgent 右侧指标栏"
          onClick={() => setStore("metricsPanelOpen", true)}
        >
          概览
        </button>
      </Show>
      <Show when={store.memoryPanelOpen}>
        <div class="fixed inset-x-0 bottom-6 top-10 z-50 flex" onClick={() => setStore("memoryPanelOpen", false)}>
          <div class="min-w-0 flex-1" />
          <div
            class="flex h-full w-[420px] max-w-[86vw] flex-col overflow-hidden border-l border-border-weak-base bg-background-base shadow-[var(--v2-elevation-raised)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="flex shrink-0 items-center justify-between border-b border-border-weak-base bg-background-base px-4 py-3">
              <span class="text-[14px] font-medium">Memory</span>
              <button class="text-text-weak hover:text-text-base" onClick={() => setStore("memoryPanelOpen", false)}>
                ×
              </button>
            </div>
            <div class="min-h-0 flex-1 overflow-hidden bg-background-base">
              <DeveagentMemoryBrowser />
            </div>
          </div>
        </div>
      </Show>
      <Show when={store.teamPanelOpen}>
        <div class="fixed inset-x-0 bottom-6 top-10 z-50 flex" onClick={() => setStore("teamPanelOpen", false)}>
          <div class="min-w-0 flex-1" />
          <div
            class="flex h-full w-[420px] max-w-[86vw] flex-col overflow-hidden border-l border-border-weak-base bg-background-base shadow-[var(--v2-elevation-raised)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="flex shrink-0 items-center justify-between border-b border-border-weak-base bg-background-base px-4 py-3">
              <span class="text-[14px] font-medium">多 Agent 团队</span>
              <button class="text-text-weak hover:text-text-base" onClick={() => setStore("teamPanelOpen", false)}>
                ×
              </button>
            </div>
            <div class="min-h-0 flex-1 overflow-hidden bg-background-base">
              <DeveagentTeamPanel />
            </div>
          </div>
        </div>
      </Show>
      <Show when={store.reviewPanelOpen}>
        <div class="fixed inset-x-0 bottom-6 top-10 z-50 flex" onClick={() => setStore("reviewPanelOpen", false)}>
          <div class="min-w-0 flex-1" />
          <div
            class="flex h-full w-[420px] max-w-[86vw] flex-col overflow-hidden border-l border-border-weak-base bg-background-base shadow-[var(--v2-elevation-raised)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="flex shrink-0 items-center justify-between border-b border-border-weak-base bg-background-base px-4 py-3">
              <span class="text-[14px] font-medium">审查</span>
              <button type="button" class="text-text-weak hover:text-text-base" onClick={() => setStore("reviewPanelOpen", false)}>
                ×
              </button>
            </div>
            <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-background-base px-6 text-center">
              <div class="text-13-medium text-text-strong">新会话暂无改动</div>
              <div class="text-12-regular text-text-weak">提交任务并产生文件改动后，这里会显示当前会话的真实审查内容。</div>
            </div>
          </div>
        </div>
      </Show>
      <div class="relative z-30 h-6 min-h-6 shrink-0 overflow-hidden bg-\[var\(--surface-raised-base\)\]">
        <DeveagentStatusBar showTerminalToggle={false} />
      </div>
    </div>
  )
}

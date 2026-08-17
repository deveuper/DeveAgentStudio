import { type Accessor, createSignal, onCleanup, onMount, Show } from "solid-js"

import { DeveagentExpertPanel } from "@/components/deveagent-expert-panel"
import { useServerSDK } from "@/context/server-sdk"

/**
 * Layout-level expert host so the expert list can be browsed, created, edited
 * and applied BEFORE a session exists (home / project screens). When a session
 * is open the expert applies to that session; otherwise it applies globally.
 */
export function DeveagentGlobalExpertsDrawer(props: { sessionID: Accessor<string | undefined> }) {
  const serverSDK = useServerSDK()
  const [open, setOpen] = createSignal(false)

  onMount(() => {
    const handleOpenPanel = (event: Event) => {
      if ((event as CustomEvent<string>).detail === "experts") setOpen(true)
    }
    const handleSelect = (event: Event) => {
      const expert = (event as CustomEvent).detail as { id?: string; name?: string; role?: string } | undefined
      const base = serverSDK().url.replace(/\/+$/, "")
      serverSDK()
        .fetch(`${base}/api/deveagent/expert`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            expert?.id
              ? { id: expert.id, name: expert.name, role: expert.role || "Advisor", sessionID: props.sessionID() }
              : { sessionID: props.sessionID() },
          ),
        })
        .catch(() => {})
      // Keep the drawer open: the panel's explicit "应用专家选择" step closes
      // it so applying a selection returns focus to the Composer.
    }
    const handleClose = () => setOpen(false)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    window.addEventListener("deveagent:open-panel", handleOpenPanel)
    window.addEventListener("deveagent:select-expert", handleSelect)
    window.addEventListener("deveagent:close-store", handleClose)
    window.addEventListener("keydown", handleKeyDown)
    onCleanup(() => {
      window.removeEventListener("deveagent:open-panel", handleOpenPanel)
      window.removeEventListener("deveagent:select-expert", handleSelect)
      window.removeEventListener("deveagent:close-store", handleClose)
      window.removeEventListener("keydown", handleKeyDown)
    })
  })

  return (
    <Show when={open()}>
      <div
        data-component="deveagent-global-experts-drawer"
        // transparent backdrop: the drawer floats above the conversation instead of hiding it
        class="fixed inset-x-0 bottom-0 top-10 z-[70] flex"
        onClick={() => setOpen(false)}
      >
        <div class="min-w-0 flex-1" />
        <section
          role="dialog"
          aria-modal="true"
          aria-label="专家"
          class="flex h-full w-[460px] max-w-[92vw] flex-col overflow-hidden border-l border-border-weak-base bg-background-base shadow-[var(--v2-elevation-raised)]"
          onClick={(event) => event.stopPropagation()}
        >
          <header class="flex shrink-0 items-center justify-between border-b border-border-weak-base px-4 py-3">
            <div>
              <div class="text-[14px] font-medium text-text-strong">专家 · 召唤专家</div>
              <div class="mt-0.5 text-[10px] text-text-weak">浏览、编辑并应用领域专家（无需打开会话）</div>
            </div>
            <button class="size-7 rounded-md text-text-weak hover:bg-surface-base hover:text-text-base" type="button" aria-label="关闭专家" title="关闭专家" onClick={() => setOpen(false)}>
              ×
            </button>
          </header>
          <div class="min-h-0 flex-1 bg-background-base">
            <DeveagentExpertPanel onApplied={() => setOpen(false)} />
          </div>
        </section>
      </div>
    </Show>
  )
}

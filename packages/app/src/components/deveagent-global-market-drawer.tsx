import { type Accessor, createSignal, onCleanup, onMount, Show } from "solid-js"

import { DeveagentSkillStore } from "@/components/deveagent-skillstore"
import { SDKProvider } from "@/context/sdk"

type StoreTab = "market" | "mcp"

/** Layout-level market host so Workbench navigation works before a session exists. */
export function DeveagentGlobalMarketDrawer(props: { directory: Accessor<string> }) {
  const [open, setOpen] = createSignal(false)
  const [requestedTab, setRequestedTab] = createSignal<StoreTab>("market")

  onMount(() => {
    const openStore = (tab: StoreTab = "market") => {
      setRequestedTab(tab)
      setOpen(true)
    }
    const handleOpen = (event: Event) => {
      const tab = (event as CustomEvent<StoreTab>).detail
      openStore(tab === "mcp" ? "mcp" : "market")
    }
    const handlePanel = (event: Event) => {
      if ((event as CustomEvent<string>).detail === "skill-store") openStore()
    }
    window.addEventListener("deveagent:open-store", handleOpen)
    window.addEventListener("deveagent:open-panel", handlePanel)
    const handleClose = () => setOpen(false)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    window.addEventListener("deveagent:close-store", handleClose)
    window.addEventListener("keydown", handleKeyDown)
    onCleanup(() => {
      window.removeEventListener("deveagent:open-store", handleOpen)
      window.removeEventListener("deveagent:open-panel", handlePanel)
      window.removeEventListener("deveagent:close-store", handleClose)
      window.removeEventListener("keydown", handleKeyDown)
    })
  })

  return (
    <Show when={open()}>
      <div
        data-component="deveagent-global-market-drawer"
        // transparent backdrop: the drawer floats above the conversation instead of hiding it
        class="fixed inset-x-0 bottom-0 top-10 z-[70] flex"
        onClick={() => setOpen(false)}
      >
        <div class="min-w-0 flex-1" />
        <section role="dialog" aria-modal="true" aria-label="Skill 与 MCP 市场" class="flex h-full w-[760px] max-w-[96vw] flex-col overflow-hidden border-l border-border-weak-base bg-background-base shadow-[var(--v2-elevation-raised)]" onClick={(event) => event.stopPropagation()}>
          <header class="flex shrink-0 items-center justify-between border-b border-border-weak-base px-4 py-3">
            <div>
              <div class="text-[14px] font-medium text-text-strong">Skill 与 MCP 市场</div>
              <div class="mt-0.5 text-[10px] text-text-weak">安装、加载与当前工作区连接</div>
            </div>
            <button class="size-7 rounded-md text-text-weak hover:bg-surface-base hover:text-text-base" type="button" title="关闭市场" onClick={() => setOpen(false)}>×</button>
          </header>
          <div class="min-h-0 flex-1 bg-background-base">
            <Show
              when={props.directory()}
              fallback={<div class="p-4 text-12-regular text-text-weak">请先打开一个项目，再安装或加载 Skill 与 MCP。</div>}
            >
              {(directory) => (
                <SDKProvider directory={directory()}>
                  <DeveagentSkillStore initialTab={requestedTab()} />
                </SDKProvider>
              )}
            </Show>
          </div>
        </section>
      </div>
    </Show>
  )
}

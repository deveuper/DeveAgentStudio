import { createResource, For, onCleanup, onMount, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { buildSessionLineage, type SessionTreeNode } from "./deveagent-session-tree-model"

/**
 * Session tree (Plan.2026.7.29 R157, Pi-style lineage): shows the current
 * session's ancestors and fork/task children from the flat session list and
 * navigates on click. The tree is built client-side from the standard session
 * endpoint — no extra backend state.
 */
export function DeveagentSessionTree() {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const params = useParams()

  const currentID = () => params.id
  const dir = () => params.dir ?? ""

  const [tree, { refetch }] = createResource(
    () => ({ dir: dir(), sessionID: currentID() }),
    async (source): Promise<SessionTreeNode[]> => {
      if (!source.dir || !source.sessionID) return []
      try {
        const url = `${serverSDK().url.replace(/\/+$/, "")}/session?directory=${encodeURIComponent(source.dir)}&limit=100`
        const response = await serverSDK().fetch(url)
        if (!response.ok) return []
        const sessions = (await response.json()) as { id: string; parentID?: string; title?: string }[]
        if (!Array.isArray(sessions)) return []
        return buildSessionLineage(sessions, source.sessionID)
      } catch {
        return []
      }
    },
  )

  // Forks and task children appear while the panel is open — poll so the
  // lineage stays current (house pattern: automations/rewind cards).
  onMount(() => {
    const timer = window.setInterval(() => void refetch(), 15_000)
    onCleanup(() => window.clearInterval(timer))
  })

  return (
    <Show when={(tree()?.length ?? 0) > 1}>
      <div data-component="deveagent-session-tree" class="rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-3">
        <div class="mb-2 text-[11px] font-[520] uppercase tracking-wide text-v2-text-text-muted">{language.t("deveagent.sessionTree.title")}</div>
        <div class="flex flex-col gap-0.5">
          <For each={tree()!}>
            {(node) => (
              <button
                type="button"
                data-component="deveagent-session-tree-node"
                data-session-id={node.id}
                class="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] hover:bg-v2-background-bg-layer-02"
                classList={{ "text-v2-text-text-accent font-[520]": node.isCurrent, "text-v2-text-text-muted": !node.isCurrent }}
                style={{ "padding-left": `${4 + node.depth * 12}px` }}
                title={node.title ?? node.id}
                onClick={() => {
                  window.dispatchEvent(new CustomEvent("deveagent:deep-link", {
                    detail: { urls: [`${window.location.origin}/${dir()}/session/${node.id}`] },
                  }))
                }}
              >
                <span class="truncate">{node.title || node.id}</span>
              </button>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}

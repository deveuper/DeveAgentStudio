import { createSignal, For, onMount, Show } from "solid-js"

import { useFile } from "@/context/file"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useSessionLayout } from "@/pages/session/session-layout"
import { showToast } from "@/utils/toast"

const memoryFiles = (sessionID?: string) => [
  {
    path: ".deveagent/memory/MEMORY.md",
    title: "Project Memory",
    desc: "Durable project context, rules, decisions, and knowledge.",
  },
  ...(sessionID ? [
    {
      path: `.deveagent/memory/sessions/${sessionID.replace(/[^a-zA-Z0-9._-]/g, "-")}/checkpoint.md`,
      title: "Session Checkpoint",
      desc: "The latest bounded state snapshot used to resume this session.",
    },
    {
      path: `.deveagent/memory/sessions/${sessionID.replace(/[^a-zA-Z0-9._-]/g, "-")}/notes.md`,
      title: "Session Notes",
      desc: "Short-lived notes collected during this session.",
    },
  ] : []),
  {
    path: "docs/AI_HANDLE/CURRENT.md",
    title: "AI Current",
    desc: "Compact current implementation status for the next AI worker.",
  },
  {
    path: "docs/AI_HANDLE/TASK_QUEUE.md",
    title: "AI Task Queue",
    desc: "Verified next tasks and their runtime evidence requirements.",
  },
  {
    path: "docs/AI_HANDLE/RULES.md",
    title: "AI Rules",
    desc: "Product boundaries and multi-AI handoff rules.",
  },
]

type RuntimeMemoryEntry = {
  id: string
  kind: string
  title: string
  summary: string
  snippet?: string
  updatedAt: number
}

type RuntimeMemoryTree = {
  groups: { kind: string; label: string; entries: RuntimeMemoryEntry[] }[]
}

export function DeveagentMemoryBrowser() {
  const file = useFile()
  const { tabs, params } = useSessionLayout()
  const platform = usePlatform()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const [exporting, setExporting] = createSignal<string>()
  const [memoryTree, setMemoryTree] = createSignal<RuntimeMemoryTree>({ groups: [] })
  const [memoryQuery, setMemoryQuery] = createSignal("")
  const [memoryLoading, setMemoryLoading] = createSignal(false)
  const [memoryConsolidating, setMemoryConsolidating] = createSignal(false)
  const [candidateAction, setCandidateAction] = createSignal<string>()

  const loadRuntimeMemory = async () => {
    const directory = sdk().directory
    if (!directory) return
    setMemoryLoading(true)
    try {
      const base = serverSDK().url.replace(/\/+$/, "")
      const params = new URLSearchParams({ directory })
      if (memoryQuery().trim()) params.set("q", memoryQuery().trim())
      const response = await serverSDK().fetch(`${base}/api/deveagent/memory?${params}`)
      if (!response.ok) throw new Error("Memory index unavailable")
      setMemoryTree(await response.json() as RuntimeMemoryTree)
    } catch (error) {
      showToast({ title: "Memory index unavailable", description: error instanceof Error ? error.message : String(error), variant: "error" })
    } finally {
      setMemoryLoading(false)
    }
  }

  onMount(() => void loadRuntimeMemory())

  const consolidateMemory = async () => {
    const directory = sdk().directory
    if (!directory) return showToast({ title: "Open a workspace before consolidating Memory.", variant: "error" })
    setMemoryConsolidating(true)
    try {
      const base = serverSDK().url.replace(/\/+$/, "")
      const response = await serverSDK().fetch(`${base}/api/deveagent/memory/consolidate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directory }),
      })
      const result = await response.json() as { consolidated?: boolean; entries?: number; error?: string }
      if (!response.ok || !result.consolidated) throw new Error(result.error || "Memory consolidation failed")
      showToast({ title: "Project Memory consolidated", description: `${result.entries ?? 0} durable entries written to MEMORY.md.`, variant: "success" })
      await loadRuntimeMemory()
    } catch (error) {
      showToast({ title: "Memory consolidation failed", description: error instanceof Error ? error.message : String(error), variant: "error" })
    } finally {
      setMemoryConsolidating(false)
    }
  }

  const reviewCandidate = async (id: string, action: "promote" | "dismiss") => {
    const directory = sdk().directory
    if (!directory) return showToast({ title: "Open a workspace before reviewing Memory candidates.", variant: "error" })
    setCandidateAction(id)
    try {
      const base = serverSDK().url.replace(/\/+$/, "")
      const response = await serverSDK().fetch(`${base}/api/deveagent/memory/candidate/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directory, id }),
      })
      const result = await response.json() as { promoted?: boolean; dismissed?: boolean; error?: string }
      if (!response.ok || result.error || (!result.promoted && !result.dismissed)) throw new Error(result.error || "Candidate review failed")
      showToast({
        title: action === "promote" ? "Local Skill draft created" : "Memory candidate dismissed",
        description: action === "promote" ? "Review and load it manually from Skill Store." : undefined,
        variant: "success",
      })
      await loadRuntimeMemory()
    } catch (error) {
      showToast({ title: "Memory candidate review failed", description: error instanceof Error ? error.message : String(error), variant: "error" })
    } finally {
      setCandidateAction(undefined)
    }
  }

  const openMemoryFile = (path: string) => {
    const tab = file.tab(path)
    void tabs().open(tab)
    void file.load(path)
    tabs().setActive(tab)
  }
  const openInObsidian = (path: string) => {
    const directory = sdk().directory
    if (!directory) return
    const absolutePath = `${directory.replace(/[\\/]+$/, "")}/${path}`.replace(/\\/g, "/")
    platform.openLink(`obsidian://open?path=${encodeURIComponent(absolutePath)}`)
  }
  const exportForObsidian = async (path: string) => {
    const directory = sdk().directory
    if (!directory) return showToast({ title: "Open a workspace before exporting to Obsidian.", variant: "error" })
    setExporting(path)
    try {
      const base = serverSDK().url.replace(/\/+$/, "")
      const response = await serverSDK().fetch(`${base}/api/deveagent/obsidian/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directory, sourcePath: path }),
      })
      const result = await response.json() as { exported?: boolean; path?: string; error?: string }
      if (!result.exported || !result.path) throw new Error(result.error || "Export failed")
      openInObsidian(result.path)
      showToast({ title: "Obsidian copy exported", description: result.path, variant: "success" })
    } catch (error) {
      showToast({ title: "Obsidian export failed", description: error instanceof Error ? error.message : String(error), variant: "error" })
    } finally {
      setExporting(undefined)
    }
  }

  return (
    <div class="flex h-full flex-col bg-background-base text-[13px] text-text-base">
      <div class="border-b border-v2-border-border-muted px-4 py-3">
        <div class="text-[14px] font-medium text-text-strong">Memory</div>
        <div class="mt-1 text-[11px] leading-4 text-v2-text-text-muted">
          打开真实项目记忆文件。Obsidian 入口只打开当前 Vault 中的 Markdown，不扫描或自动同步文件。
        </div>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto p-3">
        <section class="mb-4 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02 p-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-[13px] font-medium text-text-base">Runtime Memory</div>
              <div class="mt-1 text-[11px] text-v2-text-text-muted">Only matching notes are injected into a request. Repeated tasks become review-only Skill candidates.</div>
            </div>
            <div class="flex shrink-0 gap-2">
              <button type="button" class="rounded border border-v2-border-border-muted px-2 py-1 text-[11px] text-v2-text-text-muted hover:bg-surface-base-hover hover:text-text-base disabled:opacity-50" disabled={memoryConsolidating()} onClick={() => void consolidateMemory()}>
                {memoryConsolidating() ? "Consolidating..." : "Consolidate"}
              </button>
              <button type="button" class="rounded border border-v2-border-border-muted px-2 py-1 text-[11px] text-v2-text-text-muted hover:bg-surface-base-hover hover:text-text-base" onClick={() => void loadRuntimeMemory()}>
                {memoryLoading() ? "Loading..." : "Refresh"}
              </button>
            </div>
          </div>
          <form class="mt-3 flex gap-2" onSubmit={(event) => { event.preventDefault(); void loadRuntimeMemory() }}>
            <input
              class="min-w-0 flex-1 rounded border border-v2-border-border-muted bg-v2-background-bg-base px-2 py-1.5 text-[12px] outline-none focus:border-v2-border-border-focus"
              value={memoryQuery()}
              placeholder="Search project memory"
              onInput={(event) => setMemoryQuery(event.currentTarget.value)}
            />
            <button type="submit" class="rounded border border-v2-border-border-muted px-2 py-1 text-[11px] text-v2-text-text-muted hover:bg-surface-base-hover hover:text-text-base">Search</button>
          </form>
          <Show when={memoryTree().groups.some((group) => group.entries.length > 0)} fallback={<div class="mt-3 text-[11px] text-v2-text-text-faint">No persisted task notes yet.</div>}>
            <div class="mt-3 space-y-3">
              <For each={memoryTree().groups.filter((group) => group.entries.length > 0)}>
                {(group) => (
                  <div>
                    <div class="mb-1 text-[11px] font-medium text-v2-text-text-muted">{group.label} ({group.entries.length})</div>
                    <div class="space-y-1">
                      <For each={group.entries.slice(0, 8)}>
                        {(entry) => (
                          <div class="rounded border border-v2-border-border-muted bg-v2-background-bg-base px-2 py-1.5">
                            <div class="truncate text-[12px] text-text-base">{entry.title}</div>
                            <div class="mt-0.5 line-clamp-2 text-[11px] leading-4 text-v2-text-text-muted">{entry.snippet ?? entry.summary}</div>
                            <Show when={entry.kind === "skill-candidate"}>
                              <div class="mt-2 flex gap-2">
                                <button
                                  type="button"
                                  data-action="memory-candidate-promote"
                                  disabled={candidateAction() === entry.id}
                                  class="rounded border border-v2-border-border-focus px-2 py-1 text-[11px] text-v2-text-text-accent hover:bg-v2-overlay-simple-overlay-hover disabled:opacity-50"
                                  onClick={() => void reviewCandidate(entry.id, "promote")}
                                >
                                  Create draft Skill
                                </button>
                                <button
                                  type="button"
                                  data-action="memory-candidate-dismiss"
                                  disabled={candidateAction() === entry.id}
                                  class="rounded border border-v2-border-border-muted px-2 py-1 text-[11px] text-v2-text-text-muted hover:bg-surface-base-hover hover:text-text-base disabled:opacity-50"
                                  onClick={() => void reviewCandidate(entry.id, "dismiss")}
                                >
                                  Dismiss
                                </button>
                              </div>
                            </Show>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </section>
        <For each={memoryFiles(params.id)}>
          {(item) => (
            <div class="mb-2 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02 p-3 hover:border-v2-border-border-focus hover:bg-surface-base-hover">
              <button type="button" class="w-full text-left" onClick={() => openMemoryFile(item.path)}>
                <div class="text-[13px] font-medium text-text-base">{item.title}</div>
                <div class="mt-1 text-[11px] leading-4 text-v2-text-text-muted">{item.desc}</div>
                <div class="mt-2 truncate font-mono text-[11px] text-v2-text-text-faint" title={item.path}>{item.path}</div>
              </button>
              <button
                type="button"
                class="mt-2 rounded border border-v2-border-border-muted bg-v2-background-bg-base px-2 py-1 text-[11px] text-v2-text-text-muted hover:bg-surface-base-hover hover:text-text-base"
                title="当前工作区已加入 Obsidian Vault 时，使用 Obsidian 打开此 Markdown"
                onClick={() => openInObsidian(item.path)}
              >
                在 Obsidian 打开
              </button>
              <button
                type="button"
                disabled={exporting() === item.path}
                class="mt-2 ml-2 rounded border border-v2-border-border-muted bg-v2-background-bg-base px-2 py-1 text-[11px] text-v2-text-text-muted hover:bg-surface-base-hover hover:text-text-base disabled:cursor-wait disabled:opacity-60"
                title="显式复制到工作区 .deveagent/obsidian，不会修改外部 Vault"
                onClick={() => void exportForObsidian(item.path)}
              >
                {exporting() === item.path ? "正在导出…" : "导出 Obsidian 副本"}
              </button>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

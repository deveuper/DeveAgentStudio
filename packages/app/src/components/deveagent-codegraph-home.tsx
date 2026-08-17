import { For, createSignal, onMount, Show } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"

// Home-page (no session) CodeGraph browser: project-level index + context pack.
// Session-scoped parts (session diff, prompt context files) are intentionally
// omitted — this panel reads only what a directory alone can provide.

type CodeGraphIndexStatus = {
  available: boolean
  outputPath: string
  generatedAt?: string
  fileCount: number
  staleFileCount: number
  truncated?: boolean
}

type CodeGraphIndexResult = {
  fileCount: number
  symbolCount: number
  importEdgeCount: number
  callEdgeCount: number
  reusedFileCount: number
  reindexedFileCount: number
  truncated: boolean
  warnings: string[]
}

type ContextPack = {
  available?: boolean
  engine?: string
  files: Array<{ path: string; source: string; estimatedTokens: number; compressed?: boolean }>
  totalEstimatedTokens: number
  totalOriginalTokens: number
  tokensSaved: number
  tokenSaverEnabled: boolean
  warnings: string[]
}

async function readCodeGraphResponse<T>(response: Response, label: string): Promise<T> {
  const payload = await response.json().catch(() => undefined)
  if (!response.ok) {
    const detail =
      payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : undefined
    throw new Error(detail || `${label} (HTTP ${response.status})`)
  }
  if (payload === undefined) throw new Error(`${label}: empty response`)
  return payload as T
}

export function DeveagentCodeGraphHomePanel(props: { directory: string }) {
  const serverSDK = useServerSDK()
  const [status, setStatus] = createSignal<CodeGraphIndexStatus>()
  const [statusLoading, setStatusLoading] = createSignal(false)
  const [statusError, setStatusError] = createSignal<string>()
  const [indexResult, setIndexResult] = createSignal<CodeGraphIndexResult>()
  const [indexing, setIndexing] = createSignal(false)
  const [indexError, setIndexError] = createSignal<string>()
  const [pack, setPack] = createSignal<ContextPack>()
  const [packLoading, setPackLoading] = createSignal(false)
  const [packError, setPackError] = createSignal<string>()

  const base = () => serverSDK().url.replace(/\/+$/, "")

  const refreshStatus = async () => {
    setStatusLoading(true)
    setStatusError(undefined)
    try {
      const response = await serverSDK().fetch(`${base()}/api/deveagent/codegraph/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directory: props.directory }),
      })
      setStatus(await readCodeGraphResponse<CodeGraphIndexStatus>(response, "CodeGraph 状态读取失败"))
    } catch (error) {
      setStatus(undefined)
      setStatusError(error instanceof Error ? error.message : "CodeGraph 状态读取失败")
    } finally {
      setStatusLoading(false)
    }
  }

  const refreshPack = async () => {
    setPackLoading(true)
    setPackError(undefined)
    try {
      const response = await serverSDK().fetch(`${base()}/api/deveagent/codegraph/context-pack`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directory: props.directory, files: [], maxFiles: 40 }),
      })
      setPack(await readCodeGraphResponse<ContextPack>(response, "context_pack 读取失败"))
    } catch (error) {
      setPack(undefined)
      setPackError(error instanceof Error ? error.message : "context_pack 读取失败")
    } finally {
      setPackLoading(false)
    }
  }

  const refreshIndex = async () => {
    if (indexing()) return
    setIndexing(true)
    setIndexError(undefined)
    try {
      const response = await serverSDK().fetch(`${base()}/api/deveagent/codegraph/index`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directory: props.directory }),
      })
      setIndexResult(await readCodeGraphResponse<CodeGraphIndexResult>(response, "CodeGraph 索引失败"))
      await refreshStatus()
      await refreshPack()
    } catch (error) {
      setIndexError(error instanceof Error ? error.message : "CodeGraph 索引失败")
    } finally {
      setIndexing(false)
    }
  }

  onMount(() => {
    void refreshStatus()
    void refreshPack()
  })

  return (
    <div class="flex flex-col gap-2 p-4">
      <div class="rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02 p-4">
        <div class="flex items-center gap-2">
          <div class="text-[12px] font-semibold text-v2-text-text-base">持久化图索引</div>
          <div class="flex-1" />
          <button
            type="button"
            data-action="codegraph-home-refresh"
            class="rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1 text-[11px] text-v2-text-text-base hover:border-v2-border-border-focus disabled:opacity-50"
            disabled={indexing()}
            onClick={() => void refreshIndex()}
          >
            {indexing() ? "索引中..." : "刷新索引"}
          </button>
        </div>
        <div class="mt-2 text-[12px] leading-5 text-v2-text-text-muted">
          项目级 CodeGraph 索引（Tree-sitter 解析文件/符号/import 边/调用边，未变文件复用上一轮）。Context Pack
          依赖会话内的上下文文件与 session diff——本页只能展示索引本身，Pack 需打开会话后才有真实内容。
        </div>
        <Show when={indexResult()}>
          {(index) => (
            <div class="mt-2 rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 p-2 text-[11px] text-v2-text-text-muted">
              {index().fileCount} 文件 · {index().symbolCount} 符号 · {index().importEdgeCount} import 边 ·{" "}
              {index().callEdgeCount} call 边
              <div class="mt-1">复用 {index().reusedFileCount} · 重建 {index().reindexedFileCount}</div>
            </div>
          )}
        </Show>
        <Show when={indexError()}>{(error) => <div class="mt-2 text-[11px] text-v2-state-fg-danger">索引失败：{error()}</div>}</Show>
        <Show when={statusLoading()}>
          <div class="mt-2 text-[11px] text-v2-text-text-muted">正在读取索引状态…</div>
        </Show>
        <Show when={statusError()}>
          {(error) => <div class="mt-2 text-[11px] text-v2-state-fg-danger">索引状态读取失败：{error()}</div>}
        </Show>
        <Show when={status()}>
          {(value) => (
            <div class={`mt-2 text-[11px] ${value().available && value().staleFileCount > 0 ? "text-amber-600 dark:text-amber-300" : "text-v2-text-text-muted"}`}>
              {!value().available
                ? "尚未建立持久化索引。"
                : value().staleFileCount > 0
                  ? `索引已陈旧：${value().staleFileCount} 个文件已变化或删除，点击刷新重建。`
                  : "索引与当前文件元数据一致。"}
            </div>
          )}
        </Show>
      </div>

      <div class="rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02 p-4">
        <div class="text-[12px] font-semibold text-v2-text-text-base">Context Pack</div>
        <div class="mt-2 grid grid-cols-2 gap-2">
          <div class="rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 p-2">
            <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">估算 tokens</div>
            <div class="text-[18px] font-bold text-v2-text-text-base">
              {pack() ? pack()!.totalEstimatedTokens.toLocaleString() : packLoading() ? "读取中" : "--"}
            </div>
          </div>
          <div class="rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 p-2">
            <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">Pack 文件</div>
            <div class="text-[18px] font-bold text-v2-text-text-base">{pack() ? pack()!.files.length : packLoading() ? "读取中" : "--"}</div>
          </div>
        </div>
        <Show when={pack() && (pack()!.tokensSaved ?? 0) > 0}>
          <div class="mt-2 rounded-md border border-green-500/40 bg-green-500/10 p-2 text-[11px] font-medium text-green-700 dark:text-green-300">
            Token Saver v1 已省 ~{pack()!.tokensSaved.toLocaleString()} tokens
            <span class="text-[10px] font-normal text-v2-text-text-muted">
              {" "}
              · 原始 {pack()!.totalOriginalTokens.toLocaleString()} → 压缩后 {pack()!.totalEstimatedTokens.toLocaleString()}
            </span>
          </div>
        </Show>
        <Show when={packLoading()}>
          <div class="mt-2 text-[11px] text-v2-text-text-muted">正在读取 workspace 的真实 Context Pack…</div>
        </Show>
        <Show when={packError()}>{(error) => <div class="mt-2 text-[11px] text-v2-state-fg-danger">context_pack 读取失败：{error()}</div>}</Show>
        <Show when={pack() && pack()!.files.length === 0 && !packLoading()}>
          <div class="mt-2 rounded-md border border-dashed border-v2-border-border-base bg-v2-background-bg-layer-01 p-2 text-[11px] text-v2-text-text-muted">
            当前没有可打包文件——上下文文件与 session diff 只在会话内产生；打开会话并添加文件后这里会显示真实 Context Pack。
          </div>
        </Show>
        <Show when={pack() && pack()!.files.length > 0}>
          <div class="mt-2 flex flex-col gap-1">
            <For each={pack()!.files.slice(0, 12)}>
              {(item) => (
                <div class="flex items-center gap-2 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-2 py-1 text-[11px]">
                  <span class="min-w-0 flex-1 truncate text-v2-text-text-base" title={item.path}>
                    {item.path}
                  </span>
                  <span class="shrink-0 text-v2-text-text-muted">
                    {item.source} · ~{item.estimatedTokens.toLocaleString()} tokens{item.compressed ? " · 已压缩" : ""}
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}

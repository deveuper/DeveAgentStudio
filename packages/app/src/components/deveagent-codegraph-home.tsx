import { For, createSignal, onMount, Show } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"

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
  const language = useLanguage()
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
      setStatus(await readCodeGraphResponse<CodeGraphIndexStatus>(response, language.t("deveagent.codegraph.statusReadFailed")))
    } catch (error) {
      setStatus(undefined)
      setStatusError(error instanceof Error ? error.message : language.t("deveagent.codegraph.statusReadFailed"))
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
      setPack(await readCodeGraphResponse<ContextPack>(response, language.t("deveagent.codegraph.packReadFailed")))
    } catch (error) {
      setPack(undefined)
      setPackError(error instanceof Error ? error.message : language.t("deveagent.codegraph.packReadFailed"))
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
      setIndexResult(await readCodeGraphResponse<CodeGraphIndexResult>(response, language.t("deveagent.codegraph.indexFailed")))
      await refreshStatus()
      await refreshPack()
    } catch (error) {
      setIndexError(error instanceof Error ? error.message : language.t("deveagent.codegraph.indexFailed"))
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
          <div class="text-[12px] font-semibold text-v2-text-text-base">{language.t("deveagent.codegraph.title")}</div>
          <div class="flex-1" />
          <button
            type="button"
            data-action="codegraph-home-refresh"
            class="rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1 text-[11px] text-v2-text-text-base hover:border-v2-border-border-focus disabled:opacity-50"
            disabled={indexing()}
            onClick={() => void refreshIndex()}
          >
            {indexing() ? language.t("deveagent.codegraph.indexing") : language.t("deveagent.codegraph.refreshIndex")}
          </button>
        </div>
        <div class="mt-2 text-[12px] leading-5 text-v2-text-text-muted">
          {language.t("deveagent.codegraph.subtitle")}
        </div>
        <Show when={indexResult()}>
          {(index) => (
            <div class="mt-2 rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 p-2 text-[11px] text-v2-text-text-muted">
              {index().fileCount} {language.t("deveagent.codegraph.files")} · {index().symbolCount} {language.t("deveagent.codegraph.symbols")} · {index().importEdgeCount} {language.t("deveagent.codegraph.importEdges")} ·{" "}
              {index().callEdgeCount} {language.t("deveagent.codegraph.callEdges")}
              <div class="mt-1">{language.t("deveagent.codegraph.reused")} {index().reusedFileCount} · {language.t("deveagent.codegraph.rebuilt")} {index().reindexedFileCount}</div>
            </div>
          )}
        </Show>
        <Show when={indexError()}>{(error) => <div class="mt-2 text-[11px] text-v2-state-fg-danger">{language.t("deveagent.codegraph.indexFailedLabel")}{error()}</div>}</Show>
        <Show when={statusLoading()}>
          <div class="mt-2 text-[11px] text-v2-text-text-muted">{language.t("deveagent.codegraph.readingStatus")}</div>
        </Show>
        <Show when={statusError()}>
          {(error) => <div class="mt-2 text-[11px] text-v2-state-fg-danger">{language.t("deveagent.codegraph.statusReadFailedLabel")}{error()}</div>}
        </Show>
        <Show when={status()}>
          {(value) => (
            <div class={`mt-2 text-[11px] ${value().available && value().staleFileCount > 0 ? "text-amber-600 dark:text-amber-300" : "text-v2-text-text-muted"}`}>
              {!value().available
                ? language.t("deveagent.codegraph.noIndex")
                : value().staleFileCount > 0
                  ? language.t("deveagent.codegraph.staleIndex", { count: value().staleFileCount })
                  : language.t("deveagent.codegraph.indexMatches")}
            </div>
          )}
        </Show>
      </div>

      <div class="rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02 p-4">
        <div class="text-[12px] font-semibold text-v2-text-text-base">Context Pack</div>
        <div class="mt-2 grid grid-cols-2 gap-2">
          <div class="rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 p-2">
            <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">{language.t("deveagent.codegraph.estimatedTokens")}</div>
            <div class="text-[18px] font-bold text-v2-text-text-base">
              {pack() ? pack()!.totalEstimatedTokens.toLocaleString() : packLoading() ? language.t("deveagent.codegraph.reading") : "--"}
            </div>
          </div>
          <div class="rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 p-2">
            <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">{language.t("deveagent.codegraph.packFiles")}</div>
            <div class="text-[18px] font-bold text-v2-text-text-base">{pack() ? pack()!.files.length : packLoading() ? language.t("deveagent.codegraph.reading") : "--"}</div>
          </div>
        </div>
        <Show when={pack() && (pack()!.tokensSaved ?? 0) > 0}>
          <div class="mt-2 rounded-md border border-green-500/40 bg-green-500/10 p-2 text-[11px] font-medium text-green-700 dark:text-green-300">
            {language.t("deveagent.codegraph.tokenSaverSaved")}{pack()!.tokensSaved.toLocaleString()} tokens
            <span class="text-[10px] font-normal text-v2-text-text-muted">
              {" "}
              · {language.t("deveagent.codegraph.original")} {pack()!.totalOriginalTokens.toLocaleString()} → {language.t("deveagent.codegraph.compacted")} {pack()!.totalEstimatedTokens.toLocaleString()}
            </span>
          </div>
        </Show>
        <Show when={packLoading()}>
          <div class="mt-2 text-[11px] text-v2-text-text-muted">{language.t("deveagent.codegraph.readingPack")}</div>
        </Show>
        <Show when={packError()}>{(error) => <div class="mt-2 text-[11px] text-v2-state-fg-danger">{language.t("deveagent.codegraph.packReadFailedLabel")}{error()}</div>}</Show>
        <Show when={pack() && pack()!.files.length === 0 && !packLoading()}>
          <div class="mt-2 rounded-md border border-dashed border-v2-border-border-base bg-v2-background-bg-layer-01 p-2 text-[11px] text-v2-text-text-muted">
            {language.t("deveagent.codegraph.noFilesToPack")}
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
                    {item.source} · ~{item.estimatedTokens.toLocaleString()} tokens{item.compressed ? ` · ${language.t("deveagent.codegraph.compacted")}` : ""}
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

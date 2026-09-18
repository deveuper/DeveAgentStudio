// Speech-to-text engine configuration. Local Whisper is the honest offline
// default; online OpenAI-compatible APIs and Web Speech remain explicit options.

import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"

type SttPreset = { id: string; name: string; baseUrl: string; model: string; builtin?: boolean }
type SttStatus = {
  configured: boolean
  config?: { provider: string; baseUrl: string; model: string; language?: string; apiKey: string; apiKeySet: boolean }
  path?: string
}
type LocalSttStatus = {
  supported: boolean
  ready: boolean
  installing: boolean
  phase: "idle" | "binary" | "extract" | "model" | "ready" | "error"
  received: number
  total: number
  version: string
  model: string
  modelBytes: number
  root: string
  error?: string
}
type TestResult = {
  ok: boolean
  provider?: string
  model?: string
  baseUrl?: string
  status?: number
  detail?: string
  apiKeySet?: boolean
}

export function DeveAgentSttConfigPanel() {
  const lang = useLanguage()
  const serverSDK = useServerSDK()
  const base = () => serverSDK().url.replace(/\/+$/, "")

  const [presets, setPresets] = createSignal<SttPreset[]>([])
  const [status, setStatus] = createSignal<SttStatus | null>(null)
  const [local, setLocal] = createSignal<LocalSttStatus | null>(null)
  const [provider, setProvider] = createSignal("")
  const [baseUrl, setBaseUrl] = createSignal("")
  const [apiKey, setApiKey] = createSignal("")
  const [model, setModel] = createSignal("")
  const [language, setLanguage] = createSignal("")
  const [testResult, setTestResult] = createSignal<TestResult | null>(null)
  const [saving, setSaving] = createSignal(false)
  const [testing, setTesting] = createSignal(false)
  const [installing, setInstalling] = createSignal(false)
  // Download-progress poll, owned by the component so unmounting the panel
  // (closing the Overview) always stops it.
  let installTimer: ReturnType<typeof setInterval> | undefined
  onCleanup(() => clearInterval(installTimer))

  const refresh = async () => {
    try {
      const response = await serverSDK().fetch(`${base()}/api/deveagent/stt-config`)
      if (!response.ok) return
      const data = (await response.json()) as { presets?: SttPreset[]; status?: SttStatus; local?: LocalSttStatus }
      setPresets(data.presets ?? [])
      setLocal(data.local ?? null)
      const s = data.status
      setStatus(s ?? null)
      if (s?.config) {
        setProvider(s.config.provider)
        setBaseUrl(s.config.baseUrl)
        setModel(s.config.model)
        setLanguage(s.config.language ?? "")
        // apiKey is masked server-side; user only re-enters it to change it.
      } else if (!provider() && data.presets?.[0]) {
        applyPreset(data.presets[0].id, data.presets)
      }
    } catch {}
  }
  onMount(() => void refresh())

  const applyPreset = (id: string, source = presets()) => {
    setProvider(id)
    const preset = source.find((p) => p.id === id)
    if (preset) {
      setBaseUrl(preset.baseUrl)
      setModel(preset.model)
      if (id === "browser" || id === "local-whisper") {
        setBaseUrl("")
        if (id === "browser") setModel("")
      }
    }
  }

  const save = async () => {
    setSaving(true)
    setTestResult(null)
    try {
      const response = await serverSDK().fetch(`${base()}/api/deveagent/stt-config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: provider(), baseUrl: baseUrl(), apiKey: apiKey(), model: model(), language: language() || undefined }),
      })
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; path?: string }
      if (!response.ok || data.ok === false) {
        setTestResult({ ok: false, detail: data.error ?? `HTTP ${response.status}` })
        return
      }
      setApiKey("")
      await refresh()
      setTestResult({ ok: true, detail: lang.t("deveagent.stt.saved"), baseUrl: baseUrl(), model: model(), provider: provider() })
    } catch (error) {
      setTestResult({ ok: false, detail: error instanceof Error ? error.message : String(error) })
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const response = await serverSDK().fetch(`${base()}/api/deveagent/stt-test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      const data = (await response.json().catch(() => ({}))) as TestResult
      setTestResult(data)
    } catch (error) {
      setTestResult({ ok: false, detail: error instanceof Error ? error.message : String(error) })
    } finally {
      setTesting(false)
    }
  }

  const clear = async () => {
    setSaving(true)
    try {
      await serverSDK().fetch(`${base()}/api/deveagent/stt-config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clear: true }),
      })
      setApiKey("")
      setTestResult(null)
      await refresh()
    } finally {
      setSaving(false)
    }
  }

  const installLocal = async () => {
    if (installing()) return
    setInstalling(true)
    setTestResult(null)
    // Live download progress: this one must stay at 750ms (the user is watching
    // the byte counter). The handle lives at component scope and is cleared by
    // the onCleanup below, because a delegated event handler does not run under
    // this component's owner — an onCleanup registered in here would be a no-op
    // and closing the panel mid-install would leave the interval polling forever.
    installTimer = setInterval(() => void refresh(), 750)
    try {
      const response = await serverSDK().fetch(`${base()}/api/deveagent/stt-local/install`, { method: "POST" })
      const data = (await response.json().catch(() => ({}))) as LocalSttStatus & { error?: string }
      if (!response.ok || !data.ready) throw new Error(data.error ?? `HTTP ${response.status}`)
      setLocal(data)
      applyPreset("local-whisper")
      await save()
      setTestResult({ ok: true, provider: "local-whisper", model: data.model, detail: lang.t("deveagent.stt.whisperInstalled") })
    } catch (error) {
      setTestResult({ ok: false, detail: error instanceof Error ? error.message : String(error) })
    } finally {
      clearInterval(installTimer)
      installTimer = undefined
      setInstalling(false)
      await refresh()
    }
  }

  const formatBytes = (value: number) => value ? `${(value / 1024 / 1024).toFixed(value > 10 * 1024 * 1024 ? 0 : 1)} MB` : ""
  const installProgress = () => {
    const value = local()
    if (!value?.total) return undefined
    return Math.min(100, Math.round(value.received / value.total * 100))
  }

  return (
    <section class="mt-3 border-t border-v2-border-border-base pt-3" data-action="deveagent-stt-config">
      <div class="flex items-center justify-between gap-2">
        <div class="text-[11px] font-medium text-v2-text-text-base">{lang.t("deveagent.stt.title")}</div>
        <Show when={status()?.configured} fallback={<span class="text-[10px] text-v2-text-text-muted">{lang.t("deveagent.stt.notConfigured")}</span>}>
          <span class="text-[10px] text-v2-text-text-accent">{status()?.config?.provider}</span>
        </Show>
      </div>
      <div class="mt-1 text-[10px] leading-4 text-v2-text-text-muted">
        {lang.t("deveagent.stt.hint")}
      </div>

      <div class="mt-2 flex flex-col gap-1.5">
        <select
          aria-label={lang.t("deveagent.stt.provider")}
          data-action="deveagent-stt-provider"
          class="min-w-0 rounded border border-v2-border-border-muted bg-v2-background-bg-base px-1.5 py-1 text-[11px] text-v2-text-text-base outline-none"
          value={provider()}
          onChange={(event) => applyPreset(event.currentTarget.value)}
        >
          <For each={presets()}>
            {(preset) => <option value={preset.id}>{preset.name}</option>}
          </For>
        </select>
        <Show when={provider() === "local-whisper"} fallback={<Show when={provider() === "browser"} fallback={
          <>
            <input
              aria-label="Base URL"
              data-action="deveagent-stt-base-url"
              class="min-w-0 rounded border border-v2-border-border-muted bg-v2-background-bg-base px-1.5 py-1 text-[11px] text-v2-text-text-base outline-none focus:border-v2-border-border-focus"
              placeholder={lang.t("deveagent.stt.baseUrlPlaceholder")}
              value={baseUrl()}
              onInput={(event) => setBaseUrl(event.currentTarget.value)}
            />
            <input
              aria-label="API Key"
              type="password"
              data-action="deveagent-stt-api-key"
              class="min-w-0 rounded border border-v2-border-border-muted bg-v2-background-bg-base px-1.5 py-1 text-[11px] text-v2-text-text-base outline-none focus:border-v2-border-border-focus"
              placeholder={status()?.config?.apiKeySet ? lang.t("deveagent.stt.configuredPlaceholder") : "API Key"}
              value={apiKey()}
              onInput={(event) => setApiKey(event.currentTarget.value)}
            />
            <input
              aria-label={lang.t("deveagent.stt.model")}
              data-action="deveagent-stt-model"
              class="min-w-0 rounded border border-v2-border-border-muted bg-v2-background-bg-base px-1.5 py-1 text-[11px] text-v2-text-text-base outline-none focus:border-v2-border-border-focus"
              placeholder={lang.t("deveagent.stt.modelPlaceholder")}
              value={model()}
              onInput={(event) => setModel(event.currentTarget.value)}
            />
            <input
              aria-label={lang.t("deveagent.stt.language")}
              data-action="deveagent-stt-language"
              class="min-w-0 rounded border border-v2-border-border-muted bg-v2-background-bg-base px-1.5 py-1 text-[11px] text-v2-text-text-base outline-none focus:border-v2-border-border-focus"
              placeholder={lang.t("deveagent.stt.languagePlaceholder")}
              value={language()}
              onInput={(event) => setLanguage(event.currentTarget.value)}
            />
          </>
        }>
          <div class="text-[10px] leading-4 text-v2-text-text-muted">
            {lang.t("deveagent.stt.webSpeechFallbackHint")}
          </div>
        </Show>}>
          <div class="rounded border border-v2-border-border-muted bg-v2-background-bg-base p-2">
            <div class="flex items-center justify-between gap-2 text-[10px]">
              <span class="text-v2-text-text-base">whisper.cpp {local()?.version} · {formatBytes(local()?.modelBytes ?? 0)}</span>
              <span class={local()?.ready ? "text-v2-state-fg-success" : "text-v2-text-text-muted"}>
                {local()?.ready ? lang.t("deveagent.stt.statusReady") : installing() || local()?.installing ? lang.t("deveagent.stt.statusInstalling") : lang.t("deveagent.stt.statusNotInstalled")}
              </span>
            </div>
            <Show when={installProgress() !== undefined}>
              <div class="mt-2 h-1 overflow-hidden rounded bg-v2-background-bg-layer-03">
                <div class="h-full bg-v2-background-bg-accent transition-[width]" style={{ width: `${installProgress()}%` }} />
              </div>
            </Show>
            <div class="mt-1 break-all text-[9px] leading-4 text-v2-text-text-faint">{local()?.root}</div>
            <Show when={!local()?.ready}>
              <button
                type="button"
                data-action="deveagent-stt-install-local"
                class="mt-2 rounded border border-v2-border-border-focus/40 bg-v2-background-bg-accent/10 px-2 py-1 text-[11px] font-medium text-v2-text-text-accent disabled:opacity-50"
                disabled={installing() || local()?.installing || local()?.supported === false}
                onClick={() => void installLocal()}
              >
                {installing() || local()?.installing ? lang.t("deveagent.stt.statusDownloading") : lang.t("deveagent.stt.downloadLocalSpeech")}
              </button>
            </Show>
          </div>
        </Show>
      </div>

      <div class="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          data-action="deveagent-stt-save"
          class="rounded border border-v2-border-border-focus/40 bg-v2-background-bg-accent/10 px-2 py-1 text-[11px] font-medium text-v2-text-text-accent disabled:opacity-50"
          disabled={saving()}
          onClick={() => void save()}
        >
          {lang.t("deveagent.stt.save")}
        </button>
        <button
          type="button"
          data-action="deveagent-stt-test"
          class="rounded border border-v2-border-border-muted px-2 py-1 text-[11px] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover disabled:opacity-50"
          disabled={testing() || !status()?.configured || provider() === "local-whisper" && !local()?.ready}
          onClick={() => void test()}
        >
          {lang.t("deveagent.stt.testConnection")}
        </button>
        <Show when={status()?.configured}>
          <button
            type="button"
            data-action="deveagent-stt-clear"
            class="rounded border border-v2-border-border-muted px-2 py-1 text-[11px] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover disabled:opacity-50"
            disabled={saving()}
            onClick={() => void clear()}
          >
            {lang.t("deveagent.stt.clear")}
          </button>
        </Show>
      </div>

      <Show when={testResult()}>
        {(result) => (
          <div
            class={`mt-2 rounded border px-2 py-1.5 text-[10px] leading-4 break-words ${
              result().ok ? "border-v2-state-border-success text-v2-state-fg-success" : "border-v2-state-border-danger text-v2-state-fg-danger"
            }`}
          >
            <Show when={result().status}>
              <span class="font-semibold">HTTP {result().status}</span>{" "}
            </Show>
            <Show when={!result().ok && !result().status && result().provider}>
              <span class="font-semibold">{result().provider}/{result().model}</span>{" "}
            </Show>
            {result().detail}
          </div>
        )}
      </Show>
    </section>
  )
}

// Independent STT (speech-to-text) API configuration panel (right-side dashboard).
// Mirrors the vision config panel: provider presets, base URL, API key, model and
// language are stored separately from the primary provider. A test button surfaces
// the real HTTP status/response body so 403-class errors are diagnosable.
// When no independent STT config is set, transcription falls back to the
// Chromium Web Speech engine.

import { createSignal, For, onMount, Show } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"

type SttPreset = { id: string; name: string; baseUrl: string; model: string; builtin?: boolean }
type SttStatus = {
  configured: boolean
  config?: { provider: string; baseUrl: string; model: string; language?: string; apiKey: string; apiKeySet: boolean }
  path?: string
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
  const serverSDK = useServerSDK()
  const base = () => serverSDK().url.replace(/\/+$/, "")

  const [presets, setPresets] = createSignal<SttPreset[]>([])
  const [status, setStatus] = createSignal<SttStatus | null>(null)
  const [provider, setProvider] = createSignal("")
  const [baseUrl, setBaseUrl] = createSignal("")
  const [apiKey, setApiKey] = createSignal("")
  const [model, setModel] = createSignal("")
  const [language, setLanguage] = createSignal("")
  const [testResult, setTestResult] = createSignal<TestResult | null>(null)
  const [saving, setSaving] = createSignal(false)
  const [testing, setTesting] = createSignal(false)

  const refresh = async () => {
    try {
      const response = await serverSDK().fetch(`${base()}/api/deveagent/stt-config`)
      if (!response.ok) return
      const data = (await response.json()) as { presets?: SttPreset[]; status?: SttStatus }
      setPresets(data.presets ?? [])
      const s = data.status
      setStatus(s ?? null)
      if (s?.config) {
        setProvider(s.config.provider)
        setBaseUrl(s.config.baseUrl)
        setModel(s.config.model)
        setLanguage(s.config.language ?? "")
        // apiKey is masked server-side; user only re-enters it to change it.
      }
    } catch {}
  }
  onMount(() => void refresh())

  const applyPreset = (id: string) => {
    setProvider(id)
    const preset = presets().find((p) => p.id === id)
    if (preset) {
      setBaseUrl(preset.baseUrl)
      setModel(preset.model)
      // The browser built-in is a mode, not an API: clear any API fields.
      if (id === "browser") {
        setBaseUrl("")
        setModel("")
        setLanguage("")
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
      setTestResult({ ok: true, detail: "已保存。", baseUrl: baseUrl(), model: model(), provider: provider() })
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

  return (
    <div class="mt-3 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02 p-3" data-action="deveagent-stt-config">
      <div class="flex items-center justify-between gap-2">
        <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">独立 STT API（可选）</div>
        <Show when={status()?.configured} fallback={<span class="text-[10px] text-v2-text-text-muted">未配置</span>}>
          <span class="text-[10px] text-v2-text-text-accent">已配置 · {status()?.config?.provider}（点击"测试连接"验证连通性）</span>
        </Show>
      </div>
      <div class="mt-1 text-[10px] leading-4 text-v2-text-text-muted">
        单独填写语音转写模型（不依赖主模型 Provider）。未配置独立 STT 时使用 Chromium Web Speech。
      </div>

      <div class="mt-2 flex flex-col gap-1.5">
        <select
          aria-label="语音提供商"
          data-action="deveagent-stt-provider"
          class="min-w-0 rounded border border-v2-border-border-muted bg-v2-background-bg-base px-1.5 py-1 text-[11px] text-v2-text-text-base outline-none"
          value={provider()}
          onChange={(event) => applyPreset(event.currentTarget.value)}
        >
          <For each={presets()}>
            {(preset) => <option value={preset.id}>{preset.name}</option>}
          </For>
        </select>
        <Show when={provider() === "browser"} fallback={
          <>
            <input
              aria-label="Base URL"
              data-action="deveagent-stt-base-url"
              class="min-w-0 rounded border border-v2-border-border-muted bg-v2-background-bg-base px-1.5 py-1 text-[11px] text-v2-text-text-base outline-none focus:border-v2-border-border-focus"
              placeholder="Base URL，如 https://api.openai.com/v1"
              value={baseUrl()}
              onInput={(event) => setBaseUrl(event.currentTarget.value)}
            />
            <input
              aria-label="API Key"
              type="password"
              data-action="deveagent-stt-api-key"
              class="min-w-0 rounded border border-v2-border-border-muted bg-v2-background-bg-base px-1.5 py-1 text-[11px] text-v2-text-text-base outline-none focus:border-v2-border-border-focus"
              placeholder={status()?.config?.apiKeySet ? "已配置（输入以更换）" : "API Key"}
              value={apiKey()}
              onInput={(event) => setApiKey(event.currentTarget.value)}
            />
            <input
              aria-label="模型"
              data-action="deveagent-stt-model"
              class="min-w-0 rounded border border-v2-border-border-muted bg-v2-background-bg-base px-1.5 py-1 text-[11px] text-v2-text-text-base outline-none focus:border-v2-border-border-focus"
              placeholder="模型名，如 whisper-1"
              value={model()}
              onInput={(event) => setModel(event.currentTarget.value)}
            />
            <input
              aria-label="转写语言"
              data-action="deveagent-stt-language"
              class="min-w-0 rounded border border-v2-border-border-muted bg-v2-background-bg-base px-1.5 py-1 text-[11px] text-v2-text-text-base outline-none focus:border-v2-border-border-focus"
              placeholder="转写语言（可选，如 zh / zh-CN）"
              value={language()}
              onInput={(event) => setLanguage(event.currentTarget.value)}
            />
          </>
        }>
          <div class="text-[10px] leading-4 text-v2-text-text-muted">
            使用 Chromium Web Speech 本机识别，无需填写任何 API 配置。点击"保存"即退出远程 STT。
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
          保存
        </button>
        <button
          type="button"
          data-action="deveagent-stt-test"
          class="rounded border border-v2-border-border-muted px-2 py-1 text-[11px] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover disabled:opacity-50"
          disabled={testing() || !status()?.configured}
          onClick={() => void test()}
        >
          测试连接
        </button>
        <Show when={status()?.configured}>
          <button
            type="button"
            data-action="deveagent-stt-clear"
            class="rounded border border-v2-border-border-muted px-2 py-1 text-[11px] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover disabled:opacity-50"
            disabled={saving()}
            onClick={() => void clear()}
          >
            清除
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
    </div>
  )
}

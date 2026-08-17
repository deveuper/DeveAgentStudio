// Independent vision API configuration panel (right-side dashboard).
// Provider presets, base URL, API key and model are stored separately from the
// primary provider (Hermes-style auxiliary model). A test button surfaces the
// real HTTP status/response body so 403-class errors are diagnosable.

import { createSignal, For, onMount, Show } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"

type VisionPreset = { id: string; name: string; baseUrl: string; model: string; builtin?: boolean }
type VisionStatus = {
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

export function DeveAgentVisionConfigPanel() {
  const serverSDK = useServerSDK()
  const base = () => serverSDK().url.replace(/\/+$/, "")

  const [presets, setPresets] = createSignal<VisionPreset[]>([])
  const [status, setStatus] = createSignal<VisionStatus | null>(null)
  const [provider, setProvider] = createSignal("mimo-token-plan")
  const [baseUrl, setBaseUrl] = createSignal("")
  const [apiKey, setApiKey] = createSignal("")
  const [model, setModel] = createSignal("")
  const [language, setLanguage] = createSignal("")
  const [testResult, setTestResult] = createSignal<TestResult | null>(null)
  const [saving, setSaving] = createSignal(false)
  const [testing, setTesting] = createSignal(false)

  const refresh = async () => {
    try {
      const response = await serverSDK().fetch(`${base()}/api/deveagent/vision-config`)
      if (!response.ok) return
      const data = (await response.json()) as { presets?: VisionPreset[]; status?: VisionStatus }
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
    }
  }

  const save = async () => {
    setSaving(true)
    setTestResult(null)
    try {
      const response = await serverSDK().fetch(`${base()}/api/deveagent/vision-config`, {
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
      const response = await serverSDK().fetch(`${base()}/api/deveagent/vision-test`, {
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
      await serverSDK().fetch(`${base()}/api/deveagent/vision-config`, {
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
    <div class="mt-3 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02 p-3">
      <div class="flex items-center justify-between gap-2">
        <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">独立视觉 API（可选）</div>
        <Show when={status()?.configured} fallback={<span class="text-[10px] text-v2-text-text-muted">未配置</span>}>
          <span class="text-[10px] text-v2-text-text-accent">已配置 · {status()?.config?.provider}</span>
        </Show>
      </div>
      <div class="mt-1 text-[10px] leading-4 text-v2-text-text-muted">
        单独填写视觉模型（不依赖主模型 Provider）。图片识别失败时自动回退 Windows/macOS 自带 OCR。
      </div>

      <div class="mt-2 flex flex-col gap-1.5">
        <select
          aria-label="视觉提供商"
          class="min-w-0 rounded border border-v2-border-border-muted bg-v2-background-bg-base px-1.5 py-1 text-[11px] text-v2-text-text-base outline-none"
          value={provider()}
          onChange={(event) => applyPreset(event.currentTarget.value)}
        >
          <For each={presets()}>
            {(preset) => <option value={preset.id}>{preset.name}</option>}
          </For>
        </select>
        <Show when={provider() !== "windows-ocr"}>
          <input
            aria-label="Base URL"
            class="min-w-0 rounded border border-v2-border-border-muted bg-v2-background-bg-base px-1.5 py-1 text-[11px] text-v2-text-text-base outline-none focus:border-v2-border-border-focus"
            placeholder="Base URL，如 https://token-plan-cn.xiaomimimo.com/v1"
            value={baseUrl()}
            onInput={(event) => setBaseUrl(event.currentTarget.value)}
          />
          <input
            aria-label="API Key"
            type="password"
            class="min-w-0 rounded border border-v2-border-border-muted bg-v2-background-bg-base px-1.5 py-1 text-[11px] text-v2-text-text-base outline-none focus:border-v2-border-border-focus"
            placeholder={status()?.config?.apiKeySet ? "已配置（输入以更换）" : "API Key"}
            value={apiKey()}
            onInput={(event) => setApiKey(event.currentTarget.value)}
          />
          <input
            aria-label="模型"
            class="min-w-0 rounded border border-v2-border-border-muted bg-v2-background-bg-base px-1.5 py-1 text-[11px] text-v2-text-text-base outline-none focus:border-v2-border-border-focus"
            placeholder="模型名，如 mimo-v2.5 / glm-4.7v"
            value={model()}
            onInput={(event) => setModel(event.currentTarget.value)}
          />
          <input
            aria-label="OCR 语言"
            class="min-w-0 rounded border border-v2-border-border-muted bg-v2-background-bg-base px-1.5 py-1 text-[11px] text-v2-text-text-base outline-none focus:border-v2-border-border-focus"
            placeholder="OCR 语言（可选，如 zh-Hans-CN）"
            value={language()}
            onInput={(event) => setLanguage(event.currentTarget.value)}
          />
        </Show>
      </div>

      <div class="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          class="rounded border border-v2-border-border-focus/40 bg-v2-background-bg-accent/10 px-2 py-1 text-[11px] font-medium text-v2-text-text-accent disabled:opacity-50"
          disabled={saving()}
          onClick={() => void save()}
        >
          保存
        </button>
        <button
          type="button"
          class="rounded border border-v2-border-border-muted px-2 py-1 text-[11px] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover disabled:opacity-50"
          disabled={testing() || !status()?.configured}
          onClick={() => void test()}
        >
          测试连接
        </button>
        <Show when={status()?.configured}>
          <button
            type="button"
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

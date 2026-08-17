import { createSignal, onCleanup, Show } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { useSDK } from "@/context/sdk"
import { showToast } from "@/utils/toast"

// Browser API typing — kept local because @types/dom does not expose it.
type SpeechRecognitionEvent = Event & {
  results: SpeechRecognitionResultList
  resultIndex: number
}
type SpeechRecognitionErrorEvent = Event & { error: string; message?: string }
type SpeechRecognitionInstance = {
  lang: string
  interimResults: boolean
  continuous: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
}

type SpeechRecognitionCtor = new () => SpeechRecognitionInstance

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

function blobBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read recorded audio"))
    reader.onload = () => resolve(String(reader.result ?? "").split(",", 2)[1] ?? "")
    reader.readAsDataURL(blob)
  })
}

export function DeveagentVoiceInput(props: {
  onTranscribe(text: string): void
  language?: string
}) {
  const serverSDK = useServerSDK()
  const sdk = useSDK()
  const [recording, setRecording] = createSignal(false)
  const [processing, setProcessing] = createSignal(false)
  const [interim, setInterim] = createSignal("")
  const [engine, setEngine] = createSignal<"browser" | "api">("browser")
  let recognition: SpeechRecognitionInstance | undefined
  let recorder: MediaRecorder | undefined
  let stream: MediaStream | undefined
  let chunks: Blob[] = []
  let recordingTimeout: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const releaseStream = () => {
    stream?.getTracks().forEach((track) => track.stop())
    stream = undefined
  }

  const stop = () => {
    if (recordingTimeout) clearTimeout(recordingTimeout)
    recordingTimeout = undefined
    if (recorder && recorder.state !== "inactive") {
      recorder.stop()
      setRecording(false)
      return
    }
    if (recognition) {
      try {
        recognition.stop()
      } catch {
        // ignore
      }
    }
    setRecording(false)
    setInterim("")
  }

  const startBrowser = () => {
    const Ctor = getSpeechRecognitionCtor()
    if (!Ctor) {
      showToast({
        variant: "error",
        title: "本机不支持语音识别",
        description: "当前 Chromium 内核未暴露 SpeechRecognition。请在正式版 Electron 中使用。",
      })
      return
    }
    setEngine("browser")
    recognition = new Ctor()
    recognition.lang = props.language ?? "zh-CN"
    recognition.interimResults = true
    recognition.continuous = true

    recognition.onresult = (event) => {
      let finalText = ""
      let interimText = ""
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (!result) continue
        const transcript = result[0]?.transcript ?? ""
        if (result.isFinal) finalText += transcript
        else interimText += transcript
      }
      if (finalText.trim()) props.onTranscribe(finalText.trim())
      setInterim(interimText)
    }
    recognition.onerror = (event) => {
      showToast({
        variant: "error",
        title: "语音识别错误",
        description: event.error || "unknown",
      })
      stop()
    }
    recognition.onend = () => {
      setRecording(false)
      setInterim("")
    }
    try {
      recognition.start()
      setRecording(true)
    } catch (error) {
      showToast({
        variant: "error",
        title: "无法启动语音识别",
        description: error instanceof Error ? error.message : "unknown",
      })
      setRecording(false)
    }
  }

  const hasSpeechModel = async () => {
    // 1) Provider registry (auxiliary speech model) wins if configured.
    try {
      const response = await serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/state`)
      if (response.ok) {
        const state = (await response.json()) as { auxiliary?: { speech?: { providerID?: string; modelID?: string } } }
        if (state.auxiliary?.speech?.providerID && state.auxiliary.speech.modelID) return true
      }
    } catch {
      // fall through to the independent STT config check below
    }
    // 2) Independent STT config (separate provider preset) also enables API mode.
    try {
      const response = await serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/stt-config`)
      if (!response.ok) return false
      const data = (await response.json()) as {
        status?: { configured?: boolean; config?: { provider?: string; baseUrl?: string; apiKeySet?: boolean; model?: string } }
      }
      const config = data.status?.config
      // A browser-marker or incomplete independent STT config must NOT enable
      // the API-recording path: it would POST to /voice/transcribe, hit a 409,
      // and silently disable voice input. Only a real baseUrl+key+model counts.
      return Boolean(
        data.status?.configured &&
          config?.provider !== "browser" &&
          config?.baseUrl &&
          config?.apiKeySet &&
          config?.model,
      )
    } catch {
      return false
    }
  }

  const transcribeRecording = async (blob: Blob) => {
    if (disposed || !blob.size) return
    setProcessing(true)
    try {
      const response = await serverSDK().fetch(`${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/voice/transcribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          audioBase64: await blobBase64(blob),
          mimeType: blob.type || "audio/webm",
          language: props.language ?? "zh",
          directory: sdk().directory,
        }),
      })
      const result = (await response.json().catch(() => ({}))) as { text?: string; error?: string }
      if (!response.ok || !result.text?.trim()) throw new Error(result.error || `HTTP ${response.status}`)
      props.onTranscribe(result.text.trim())
    } catch (error) {
      // Remote transcription failed (bad config, network, 409). Degrade to the
      // built-in browser speech recognition instead of silently disabling voice
      // input. releaseStream frees the mic so SpeechRecognition can take over.
      showToast({
        variant: "error",
        title: "远程转写失败，改用本机语音识别",
        description: error instanceof Error ? error.message : "unknown",
      })
      releaseStream()
      startBrowser()
    } finally {
      setProcessing(false)
    }
  }

  const startApi = async () => {
    try {
      const mediaDevices = (navigator as Navigator & { mediaDevices?: MediaDevices }).mediaDevices
      if (!mediaDevices) throw new Error("当前桌面环境不支持麦克风录音。")
      stream = await mediaDevices.getUserMedia({ audio: true })
      const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type))
      recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined)
      chunks = []
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data)
      }
      recorder.onerror = () => {
        releaseStream()
        setRecording(false)
        showToast({ variant: "error", title: "录音失败", description: "MediaRecorder 无法继续录音。" })
      }
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder?.mimeType || "audio/webm" })
        chunks = []
        releaseStream()
        setRecording(false)
        void transcribeRecording(blob)
      }
      recorder.start()
      setEngine("api")
      setRecording(true)
      recordingTimeout = setTimeout(stop, 120_000)
    } catch (error) {
      releaseStream()
      showToast({
        variant: "error",
        title: "无法启动录音",
        description: error instanceof Error ? error.message : "unknown",
      })
    }
  }

  const toggle = async () => {
    if (processing()) return
    if (recording()) {
      stop()
      return
    }
    const useApi = await hasSpeechModel()
    if (useApi && typeof MediaRecorder !== "undefined") {
      await startApi()
      return
    }
    startBrowser()
  }

  onCleanup(() => {
    disposed = true
    if (recordingTimeout) clearTimeout(recordingTimeout)
    recognition?.abort()
    if (recorder) recorder.onstop = null
    if (recorder?.state !== "inactive") recorder?.stop()
    releaseStream()
  })

  return (
    <button
      type="button"
      title={processing() ? "正在调用语音转写模型" : recording() ? `停止录音（${engine() === "api" ? "API" : "Web Speech"}）` : "按下开始中英文语音输入"}
      class={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[12px] font-medium transition-colors ${
        recording()
          ? "border-red-500/50 bg-red-500/10 text-red-600 hover:bg-red-500/20 dark:text-red-300"
          : "border-border-weak-base bg-v2-background-bg-layer-02 text-text-base hover:bg-surface-raised-base"
      }`}
      disabled={processing()}
      onClick={() => void toggle()}
      data-component="deveagent-voice-input"
      data-engine={engine()}
    >
      <span aria-hidden>{recording() ? "●" : "🎙"}</span>
      <span>{processing() ? "转写中" : recording() ? "录音中" : "语音"}</span>
      <Show when={interim()}>
        <span class="ml-1 max-w-[120px] truncate text-[10px] text-text-weak">{interim()}</span>
      </Show>
    </button>
  )
}

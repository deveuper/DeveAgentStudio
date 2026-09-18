import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"

type SkillCandidate = {
  id: string
  title?: string
  kind?: string
  keywords?: string[]
  createdAt?: number
}

/**
 * Skill candidate review (Plan.2026.7.29 R164/R165): recurring workflows
 * recorded as Memory candidates surface here for an explicit promote (creates
 * a disabled local Skill draft via the existing memory-candidate promote
 * route) or reject. Nothing is auto-enabled; the card hides when there are no
 * candidates.
 */
export function DeveagentSkillCandidatesCard() {
  const language = useLanguage()
  const sdk = useSDK()
  const serverSDK = useServerSDK()

  const [busy, setBusy] = createSignal<string | undefined>(undefined)
  // A failed read is NOT "no candidates". Without this the card hid itself on
  // error and silently claimed there was nothing to review.
  const [loadFailed, setLoadFailed] = createSignal(false)

  const [candidates, { refetch }] = createResource(
    () => ({ directory: sdk().directory }),
    async (source): Promise<SkillCandidate[]> => {
      if (!source.directory) {
        setLoadFailed(false)
        return []
      }
      try {
        const url = `${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/memory?directory=${encodeURIComponent(source.directory)}`
        const response = await serverSDK().fetch(url)
        if (!response.ok) {
          setLoadFailed(true)
          return []
        }
        const data = (await response.json()) as { entries?: SkillCandidate[] }
        setLoadFailed(false)
        return (data.entries ?? []).filter((entry) => entry.kind === "skill-candidate")
      } catch {
        setLoadFailed(true)
        return []
      }
    },
  )

  onMount(() => {
    const timer = window.setInterval(() => void refetch(), 15_000)
    onCleanup(() => window.clearInterval(timer))
  })

  const act = async (candidate: SkillCandidate, action: "promote" | "dismiss") => {
    if (busy()) return
    setBusy(candidate.id + action)
    try {
      const url = `${serverSDK().url.replace(/\/+$/, "")}/api/deveagent/memory/candidate/${action}`
      const response = await serverSDK().fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directory: sdk().directory, id: candidate.id }),
      })
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
      // The routes answer {promoted|dismissed: false} with HTTP 200 when they
      // did nothing; an absent error key must not be read as success.
      const ok = response.ok
        && data.error === undefined
        && data.ok !== false
        && data.promoted !== false
        && data.dismissed !== false
      showToast({
        title: ok
          ? action === "promote"
            ? language.t("deveagent.candidates.draftCreated")
            : language.t("deveagent.candidates.dismissed")
          : language.t("deveagent.candidates.actionFailed"),
        description: action === "promote" && ok ? String(data.savedPath ?? "") : undefined,
      })
      void refetch()
    } catch {
      showToast({ title: language.t("deveagent.candidates.actionFailed") })
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <>
      <Show when={loadFailed() && (candidates()?.length ?? 0) === 0}>
        <div class="rounded-md border border-v2-border-border-muted px-2 py-1.5 text-[11px] text-v2-text-text-muted" data-component="deveagent-skill-candidates-error">
          {language.t("deveagent.candidates.memoryReadFailed")}
          <button
            type="button"
            data-action="deveagent-skill-candidates-retry"
            class="ml-2 rounded border border-v2-border-border-muted px-1.5 py-0.5 text-[10px] text-v2-text-text-base"
            onClick={() => void refetch()}
          >
            {language.t("deveagent.candidates.retry")}
          </button>
        </div>
      </Show>
      <Show when={(candidates()?.length ?? 0) > 0}>
      <div data-component="deveagent-skill-candidates" class="rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-3">
        <div class="mb-2 flex items-center justify-between">
          <span class="text-[11px] font-[520] uppercase tracking-wide text-v2-text-text-muted">{language.t("deveagent.candidates.title")}</span>
          <span class="text-[10px] text-v2-text-text-faint">{candidates()!.length}</span>
        </div>
        <div class="flex max-h-48 flex-col gap-1.5 overflow-y-auto">
          <For each={candidates()!}>
            {(candidate) => (
              <div class="rounded-md border border-v2-border-border-muted px-2 py-1.5" data-candidate-id={candidate.id}>
                <div class="min-w-0 truncate text-[11px] text-v2-text-text-base" title={candidate.title ?? candidate.id}>
                  {candidate.title || candidate.id}
                </div>
                <div class="mt-1 flex items-center justify-between gap-2">
                  <span class="text-[10px] text-v2-text-text-faint">
                    {candidate.createdAt ? new Date(candidate.createdAt).toLocaleString(language.locale()) : ""}
                  </span>
                  <div class="flex shrink-0 gap-1">
                    <button
                      type="button"
                      data-action="deveagent-skill-candidate-promote"
                      class="rounded border border-v2-border-border-muted px-1.5 py-0.5 text-[10px] text-v2-text-text-base hover:bg-v2-background-bg-layer-02"
                      onClick={() => void act(candidate, "promote")}
                    >
                      {language.t("deveagent.candidates.promote")}
                    </button>
                    <button
                      type="button"
                      data-action="deveagent-skill-candidate-dismiss"
                      class="rounded border border-v2-border-border-muted px-1.5 py-0.5 text-[10px] text-v2-text-text-base hover:bg-v2-background-bg-layer-02"
                      onClick={() => void act(candidate, "dismiss")}
                    >
                      {language.t("deveagent.candidates.dismiss")}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </For>
        </div>
        <div class="mt-1.5 text-[10px] leading-4 text-v2-text-text-faint">
          {language.t("deveagent.candidates.promoteHint")}
        </div>
      </div>
      </Show>
    </>
  )
}

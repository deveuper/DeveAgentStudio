import { For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import type { DeveAgentMarkItDownEvent } from "./deveagent-markitdown-state"
import { formatDeveAgentMarkItDownBytes, formatDeveAgentMarkItDownTime } from "./deveagent-markitdown-state"

export function DeveAgentMarkItDownStatus(props: { events: DeveAgentMarkItDownEvent[] }) {
  const language = useLanguage()
  const latest = () => props.events[props.events.length - 1]

  return (
    <div class="rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-3">
      <div class="flex items-center justify-between gap-2">
        <div class="text-[11px] font-[520] uppercase tracking-wide text-v2-text-text-muted">{language.t("deveagent.markitdown.title")}</div>
        <div class="text-[10px] text-v2-text-text-faint">{language.t("deveagent.markitdown.sessionMetadata")}</div>
      </div>
      <Show
        when={latest()}
        fallback={
          <div class="mt-1 text-[11px] leading-4 text-v2-text-text-faint">
            {language.t("deveagent.markitdown.waiting")}
          </div>
        }
      >
        {(event) => (
          <div class="mt-2 flex flex-col gap-1.5 text-[11px] leading-5">
            <div class={`font-medium ${event().status === "converted" ? "text-v2-state-fg-success" : "text-v2-state-fg-danger"}`}>
              {event().status === "converted"
                ? event().cached
                  ? language.t("deveagent.markitdown.usedCached")
                  : language.t("deveagent.markitdown.converted")
                : language.t("deveagent.markitdown.conversionFailed")}
            </div>
            <Show when={event().sourceRelativePath || event().markdownRelativePath}>
              <div class="grid gap-1 text-v2-text-text-muted">
                <Show when={event().sourceRelativePath}>
                  {(path) => (
                    <div class="truncate" title={path()}>
                      {language.t("deveagent.markitdown.source")}: {path()}
                    </div>
                  )}
                </Show>
                <Show when={event().markdownRelativePath}>
                  {(path) => (
                    <div class="truncate" title={path()}>
                      Markdown: {path()}
                    </div>
                  )}
                </Show>
              </div>
            </Show>
            <Show when={event().status === "converted"}>
              <div class="text-[10px] text-v2-text-text-muted">
                {formatDeveAgentMarkItDownBytes(event().sourceBytes, language.t("deveagent.markitdown.sizeUnknown"))}
                {event().sourceSha256 ? ` · SHA-256 ${event().sourceSha256?.slice(0, 12)}…` : ""}
                {event().sourceModifiedAt !== undefined
                  ? ` · ${language.t("deveagent.markitdown.modified")} ${formatDeveAgentMarkItDownTime(event().sourceModifiedAt, language.t("deveagent.markitdown.timeUnknown"))}`
                  : ""}
                {event().runtimeCommand ? ` · ${event().runtimeCommand}` : ""}
              </div>
            </Show>
            <Show when={event().status === "failed"}>
              <div class="text-[10px] leading-4 text-v2-state-fg-danger">
                {language.t("deveagent.markitdown.originalNotForwarded")}
              </div>
              <For each={event().attempts?.slice(0, 3) ?? []}>
                {(attempt) => (
                  <div class="truncate text-[10px] leading-4 text-v2-text-text-muted" title={attempt.error}>
                    {attempt.command ?? language.t("deveagent.markitdown.runtime")}:{attempt.error ?? language.t("deveagent.markitdown.failed")}
                  </div>
                )}
              </For>
            </Show>
            <Show when={props.events.length > 1}>
              <div class="text-[10px] tabular-nums text-v2-text-text-faint">
                {language.t("deveagent.markitdown.eventsRecorded", { count: props.events.length })}
              </div>
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}

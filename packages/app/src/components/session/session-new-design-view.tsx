import { Show, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"

const SUGGESTIONS: Array<{ zh: string; en: string; promptZh: string; promptEn: string }> = [
  {
    zh: "实现一个功能",
    en: "Build a feature",
    promptZh: "在当前项目里实现一个新功能：",
    promptEn: "Implement a new feature in this project: ",
  },
  {
    zh: "修复一个 bug",
    en: "Fix a bug",
    promptZh: "修复这个问题：",
    promptEn: "Fix this bug: ",
  },
  {
    zh: "解释这段代码",
    en: "Explain code",
    promptZh: "解释这段代码的作用与设计：",
    promptEn: "Explain what this code does and why: ",
  },
  {
    zh: "审查当前改动",
    en: "Review changes",
    promptZh: "审查当前未提交的改动，给出风险与改进建议。",
    promptEn: "Review the current uncommitted changes and flag risks.",
  },
]

export function NewSessionDesignView(props: { directory?: string; children: JSX.Element }) {
  const language = useLanguage()
  const prompt = usePrompt()
  const zh = () => language.locale() === "zh" || language.locale() === "zht"
  const name = () => props.directory?.split(/[\\/]/).filter(Boolean).at(-1)

  const pick = (suggestion: (typeof SUGGESTIONS)[number]) => {
    const text = zh() ? suggestion.promptZh : suggestion.promptEn
    prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
    // Focus the composer so the user can keep typing right away.
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLElement>('[data-component="session-new-design-text"]')
      input?.focus()
    })
  }

  return (
    <div data-component="session-new-design" class="relative size-full overflow-hidden bg-background-base">
      <div class="flex size-full flex-col items-center justify-center px-8">
        <div class={NEW_SESSION_CONTENT_WIDTH}>
          <div class="mb-6 flex flex-col items-center gap-1.5 text-center">
            <h1 class="text-[22px] font-semibold leading-7 text-text-strong">
              {language.t("deveagent.newSession.title")}
            </h1>
            <p class="text-13-regular text-text-weak">
              {language.t("deveagent.newSession.subtitle")}
            </p>
          </div>
          {props.children}
          <div class="mt-3 flex flex-wrap items-center justify-center gap-2">
            {SUGGESTIONS.map((suggestion) => (
              <button
                type="button"
                class="rounded-full border border-border-weak-base bg-surface-base px-3 py-1.5 text-12-medium text-text-base transition-colors hover:border-border-strong-base hover:bg-background-base"
                data-action="deveagent-draft-suggestion"
                onClick={() => pick(suggestion)}
              >
                {/* Suggestion copy is content data carried by SUGGESTIONS, not a
                    UI label, so it keeps its own bilingual pair. */}
                {language.locale() === "zh" || language.locale() === "zht" ? suggestion.zh : suggestion.en}
              </button>
            ))}
          </div>
          <div class="mt-4 flex items-center justify-center gap-2 text-12-medium text-text-weak">
            <span class="size-1.5 rounded-full bg-v2-background-bg-accent" />
            <span>{language.t("deveagent.newSession.newSession")}</span>
            {/* The draft targets a concrete project directory; surface it so the
                header shows where a submitted prompt will run (also the E2E
                identity marker for the draft route). */}
            <Show when={props.directory}>
              <span
                class="truncate text-11-regular text-text-faint"
                title={props.directory}
                data-component="deveagent-draft-directory"
              >
                {name()}
              </span>
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}

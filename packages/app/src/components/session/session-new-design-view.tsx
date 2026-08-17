import { Show, type JSX } from "solid-js"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"

export function NewSessionDesignView(props: { directory?: string; children: JSX.Element }) {
  const name = () => props.directory?.split(/[\\/]/).filter(Boolean).at(-1)
  return (
    <div data-component="session-new-design" class="relative size-full overflow-hidden bg-background-base">
      <div class="flex size-full items-center justify-center px-8">
        <div class={NEW_SESSION_CONTENT_WIDTH}>
          <div class="mb-3 flex items-center gap-2 px-1 text-12-medium text-text-weak">
            <span class="size-1.5 rounded-full bg-v2-background-bg-accent" />
            <span>新会话</span>
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
          {props.children}
        </div>
      </div>
    </div>
  )
}

import { For, Show } from "solid-js"
import type { DeveAgentMarkItDownEvent } from "./deveagent-markitdown-state"
import { formatDeveAgentMarkItDownBytes, formatDeveAgentMarkItDownTime } from "./deveagent-markitdown-state"

export function DeveAgentMarkItDownStatus(props: { events: DeveAgentMarkItDownEvent[] }) {
  const latest = () => props.events[props.events.length - 1]

  return (
    <div class="rounded-lg border border-[var(--border-base)] bg-\[var\(--surface-raised-base\)\] p-3">
      <div class="flex items-center justify-between gap-2">
        <div class="text-[10px] uppercase tracking-wide text-[var(--text-weak)]">MarkItDown 文档转换</div>
        <div class="text-[10px] text-[var(--text-weak)]">会话元数据</div>
      </div>
      <Show
        when={latest()}
        fallback={<div class="mt-1 text-[11px] text-[var(--text-weak)]">等待附件转换事件；没有事件时不显示推测数据。</div>}
      >
        {(event) => (
          <div class="mt-2 flex flex-col gap-1.5 text-[11px]">
            <div class={`font-medium ${event().status === "converted" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
              {event().status === "converted" ? (event().cached ? "已使用缓存 Markdown" : "已转换为 Markdown") : "转换失败"}
            </div>
            <Show when={event().sourceRelativePath || event().markdownRelativePath}>
              <div class="grid gap-1 text-[var(--text-weak)]">
                <Show when={event().sourceRelativePath}>
                  {(path) => <div class="truncate" title={path()}>源文件：{path()}</div>}
                </Show>
                <Show when={event().markdownRelativePath}>
                  {(path) => <div class="truncate" title={path()}>Markdown：{path()}</div>}
                </Show>
              </div>
            </Show>
            <Show when={event().status === "converted"}>
              <div class="text-[10px] text-[var(--text-weak)]">
                {formatDeveAgentMarkItDownBytes(event().sourceBytes)}{event().sourceSha256 ? ` · SHA-256 ${event().sourceSha256?.slice(0, 12)}…` : ""}
                {event().sourceModifiedAt !== undefined ? ` · 修改于 ${formatDeveAgentMarkItDownTime(event().sourceModifiedAt)}` : ""}
                {event().runtimeCommand ? ` · ${event().runtimeCommand}` : ""}
              </div>
            </Show>
            <Show when={event().status === "failed"}>
              <div class="text-[10px] text-red-600/80 dark:text-red-300/80">原始文档未转发给模型；请查看失败详情或关闭自动转换后重试。</div>
              <For each={event().attempts?.slice(0, 3) ?? []}>
                {(attempt) => <div class="truncate text-[10px] text-[var(--text-weak)]" title={attempt.error}>{attempt.command ?? "运行时"}：{attempt.error ?? "失败"}</div>}
              </For>
            </Show>
            <Show when={props.events.length > 1}>
              <div class="text-[10px] text-[var(--text-weak)]">本会话已记录 {props.events.length} 次转换事件</div>
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}

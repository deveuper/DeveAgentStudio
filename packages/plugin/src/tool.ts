import { z } from "zod"

export type ToolContext = {
  sessionID: string
  messageID: string
  agent: string
  /**
   * Current project directory for this session.
   * Prefer this over process.cwd() when resolving relative paths.
   */
  directory: string
  /**
   * Project worktree root for this session.
   * Useful for generating stable relative paths (e.g. path.relative(worktree, absPath)).
   */
  worktree: string
  abort: AbortSignal
  metadata(input: { title?: string; metadata?: { [key: string]: any } }): void
  ask(input: AskInput): Promise<void>
  /**
   * Run a native OpenCode subagent through the host Task tool. Plugins never
   * receive the underlying prompt/session internals, so the host remains the
   * authority for permissions, cancellation, and child-session creation.
   */
  runTask?(input: {
    description: string
    prompt: string
    subagent_type: string
    /** Resume a previously persisted native child session instead of creating a new one. */
    task_id?: string
    background?: boolean
    read_only?: boolean
    /** Foreground task deadline. The native Task tool cancels the child on expiry. */
    timeout_ms?: number
    model?: { providerID: string; modelID: string }
  }): Promise<{ title: string; output: string; metadata: { [key: string]: any } }>
  /**
   * Wait for a native background Task created by `runTask({ background: true })`.
   * The host owns cancellation and returns the child session's final usage.
   */
  waitTask?(input: {
    jobID: string
    /** Native deadline in milliseconds. The host cancels the job on expiry. */
    timeout_ms?: number
  }): Promise<{ title: string; output: string; metadata: { [key: string]: any } }>
}

type AskInput = {
  permission: string
  patterns: string[]
  always: string[]
  metadata: { [key: string]: any }
}

export type ToolAttachment = {
  type: "file"
  mime: string
  url: string
  filename?: string
}

export type ToolResult =
  | string
  | {
      title?: string
      output: string
      metadata?: { [key: string]: any }
      attachments?: ToolAttachment[]
    }

export function tool<Args extends z.ZodRawShape>(input: {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>
}) {
  return input
}
tool.schema = z

export type ToolDefinition = ReturnType<typeof tool>

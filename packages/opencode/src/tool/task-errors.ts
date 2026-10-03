// Error classes shared by the task tool, the tool registry and the DeveAgent
// plugin's team driver.
//
// They live in their own dependency-free module on purpose. Putting them in
// `tool/registry.ts` or `tool/task.ts` and importing them from the plugin made
// the plugin pull the whole tool graph in at module-init time, which reordered
// the app's effect-layer construction and broke sidecar startup with
// "Cannot read properties of undefined (reading 'dependencies')" in
// `core/src/effect/layer-node.ts`. Nothing here may import anything.

/**
 * A child session's provider turn ended with an errored assistant message.
 *
 * A distinct class rather than a marker property on a plain Error so callers
 * can branch on `instanceof` instead of matching a string. The previous
 * `Object.assign(new Error(...), { childTurnError: true })` marker was written
 * in two places and read nowhere.
 */
export class ChildTurnError extends Error {
  readonly childTurnError = true as const
  constructor(message: string) {
    super(message)
    this.name = "ChildTurnError"
  }
}

/**
 * `background: true` was requested but the runtime flag is off.
 *
 * A distinct class so the team driver can detect the "fall back to a foreground
 * child" case with `instanceof` instead of matching this message's text. The
 * driver used to string-match "Background subagents require", which meant any
 * unrelated failure whose message happened to contain that phrase was silently
 * retried as a foreground task.
 */
export class BackgroundSubagentsUnavailableError extends Error {
  readonly backgroundSubagentsUnavailable = true as const
  constructor() {
    super("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true")
    this.name = "BackgroundSubagentsUnavailableError"
  }
}

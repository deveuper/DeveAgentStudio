// DeveAgent brand mark: the gradient diamond "agent node" with a white core.
// Replaces every OpenCode "O" logo usage in the renderer (splash, empty
// states, watermarks). Unique gradient id per instance so multiple marks on
// one page never collide.

let markSeq = 0

export function DeveAgentMark(props: { class?: string }) {
  const id = `deveagent-mark-${++markSeq}`
  return (
    <svg
      data-component="deveagent-brand-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`deveagent-g-${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#79C0FF" />
          <stop offset="1" stop-color="#1F6FED" />
        </linearGradient>
      </defs>
      <polygon points="256,66 446,256 256,446 66,256" fill={`url(#deveagent-g-${id})`} />
      <circle cx="256" cy="256" r="46" fill="#FFFFFF" />
    </svg>
  )
}

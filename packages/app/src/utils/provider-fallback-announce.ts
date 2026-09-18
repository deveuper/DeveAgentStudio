// E-3 red line: a provider fallback must never be silent. The desktop shell's
// OS notification is suppressed while the window is focused, so the switch has
// to be announced on the in-app surface as well — otherwise a user watching the
// app sees the model change with no explanation at all.
//
// Pure so the "which surfaces get the announcement" rule is unit-testable.
export type ProviderFallbackAnnouncement = {
  title: string
  description: string
  href: string
  /** OS notification (visible when the window is unfocused). */
  system: true
  /** In-app toast (the only surface a focused window shows). */
  inApp: true
}

export function planProviderFallbackAnnouncement(input: {
  failed: string
  fallback: string
  title: string
  description: string
  href: string
}): ProviderFallbackAnnouncement {
  return {
    title: input.title,
    description: input.description,
    href: input.href,
    system: true,
    inApp: true,
  }
}

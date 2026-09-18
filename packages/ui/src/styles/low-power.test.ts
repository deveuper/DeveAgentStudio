import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const styles = join(import.meta.dir, "..", "styles")

describe("low power stylesheet", () => {
  test("is imported by the style entrypoint", () => {
    const index = readFileSync(join(styles, "index.css"), "utf8")
    expect(index).toContain('@import "./low-power.css"')
  })

  test("collapses decorative motion but keeps the loading spinner alive", () => {
    const css = readFileSync(join(styles, "low-power.css"), "utf8")
    expect(css).toContain('[data-low-power="true"]')
    expect(css).toContain("animation-duration: 0.01ms !important")
    expect(css).toContain("transition-duration: 0.01ms !important")
    expect(css).toContain('--animate-pulse: none')
    // A frozen spinner reads as a hang; it must stay excluded.
    expect(css).toContain('[data-component="spinner"]')
  })
})

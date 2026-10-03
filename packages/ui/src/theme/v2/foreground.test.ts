import { describe, expect, test } from "bun:test"
import { contrastRatio } from "../color"
import type { HexColor, V2ColorValue } from "../types"
import { DEFAULT_THEMES } from "../default-themes"
import { resolveThemeVariantV2 } from "./resolve"

// The quiet text tiers (muted/faint) come from an unclamped lightness shift,
// and a theme's `text-weak` override lands in the same slot. Either can end up
// under the surface it renders on. Measured on the packaged app: text-faint sat
// at 1.92:1 on the dark card, and one theme's muted tier at 1.38:1 on its own
// light surface — the user-reported "colors too pale", where the text is
// effectively invisible rather than merely quiet.
//
// These tests run the REAL resolver over every shipped theme. The contract is
// deliberately conditional, because two shipped themes (catppuccin-frappe and
// catppuccin-macchiato, light) have a BODY tier of only 2.57:1 against their own
// background — a pre-existing palette bug in the theme data. Demanding 4.5:1
// from their quiet tiers would be demanding that the quietest tier out-read the
// body tier, which is not the fix. So:
//   - a theme whose body tier is readable must have readable quiet tiers, and
//   - a theme whose body tier is not must not have its quiet tiers made WORSE.
const AA = 4.5

// The muted/faint split is a visual hierarchy: "faint" must read as the quieter
// of the two. A contrast floor is a readability requirement and the hierarchy is
// a design requirement; where they conflict, the two tiers are separated rather
// than collapsed. Floors alone left three shipped themes inverted — deveagent
// forest light measured faint 4.99 against muted 4.52 — so the floor pass also
// keeps each tier above the one below it.
const ORDER_EPSILON = 0.005

const SURFACES = ["v2-background-bg-base", "v2-background-bg-layer-01", "v2-background-bg-layer-02"] as const

function asHex(value: V2ColorValue | undefined, label: string, tokens: Record<string, V2ColorValue>): HexColor {
  let current = value
  // Resolved tokens keep their `var(--...)` indirection on purpose (the CSS
  // layer performs the final substitution), so follow one or more hops to the
  // concrete primitive before measuring.
  for (let hop = 0; hop < 8; hop++) {
    if (typeof current !== "string") break
    if (current.startsWith("#")) return current as HexColor
    const ref = current.match(/^var\(--([^)]+)\)$/)?.[1]
    if (!ref) break
    current = tokens[ref]
  }
  throw new Error(`${label} is not a concrete hex: ${String(value)}`)
}

describe("v2 foreground contrast", () => {
  for (const [name, theme] of Object.entries(DEFAULT_THEMES)) {
    for (const isDark of [false, true]) {
      const scheme = isDark ? "dark" : "light"
      const variant = isDark ? theme.dark : theme.light

      test(`${name} (${scheme}): the clamp never lowers a quiet tier`, () => {
        // The clamp exists to raise legibility. A theme this cannot help (its
        // own body tier is below the floor) must be left as its author wrote
        // it — not nudged somewhere arbitrary. Measured against the raw theme
        // value, ignoring the clamp entirely.
        const resolved = resolveThemeVariantV2(variant, isDark)
        const backgrounds = SURFACES.map((key) => asHex(resolved[key], `${name}/${scheme}/${key}`, resolved))
        const worst = (token: string) => {
          const fg = asHex(resolved[token], `${name}/${scheme}/${token}`, resolved)
          return Math.min(...backgrounds.map((bg) => contrastRatio(fg, bg)))
        }
        const overrides = (variant as { v2Overrides?: Record<string, V2ColorValue> }).v2Overrides ?? {}
        for (const token of ["v2-text-text-muted", "v2-text-text-faint"] as const) {
          const raw = overrides[token]
          // Only concrete hex overrides can be compared; a var(...) is passed
          // through by design and has no measurable baseline here.
          if (typeof raw !== "string" || !raw.startsWith("#")) continue
          const baseline = Math.min(...backgrounds.map((bg) => contrastRatio(raw as HexColor, bg)))
          const after = worst(token)
          expect(after >= baseline - 0.01 ? "ok" : `${name} ${scheme} ${token} lowered ${baseline.toFixed(2)} -> ${after.toFixed(2)}`).toBe("ok")
        }
      })

      test(`${name} (${scheme}): faint is never brighter than muted`, () => {
        const resolved = resolveThemeVariantV2(variant, isDark)
        const backgrounds = SURFACES.map((key) => asHex(resolved[key], `${name}/${scheme}/${key}`, resolved))
        const worst = (token: string) => {
          const fg = asHex(resolved[token], `${name}/${scheme}/${token}`, resolved)
          return Math.min(...backgrounds.map((bg) => contrastRatio(fg, bg)))
        }
        // The floor pass keeps the hierarchy by raising the stronger tier, so
        // this holds for every theme whose tiers it could act on — including
        // the 26 combinations that shipped inverted before any floor existed.
        // Two themes are exempt on the same grounds as the floor test above:
        // their light body tier is itself below AA, so both quiet tiers bottom
        // out on the same value and there is no hierarchy to measure.
        if (worst("v2-text-text-base") < AA) return
        const muted = worst("v2-text-text-muted")
        const faint = worst("v2-text-text-faint")
        expect(
          faint <= muted + ORDER_EPSILON
            ? "ok"
            : `${name} ${scheme} faint ${faint.toFixed(2)}:1 out-reads muted ${muted.toFixed(2)}:1`,
        ).toBe("ok")
      })

      test(`${name} (${scheme}): quiet text clears ${AA}:1 whenever the body tier does`, () => {
        const resolved = resolveThemeVariantV2(variant, isDark)
        const backgrounds = SURFACES.map((key) => asHex(resolved[key], `${name}/${scheme}/${key}`, resolved))
        const worst = (token: string) => {
          const fg = asHex(resolved[token], `${name}/${scheme}/${token}`, resolved)
          return Math.min(...backgrounds.map((bg) => contrastRatio(fg, bg)))
        }
        // The theme's own body tier is the ceiling on what the quiet tiers can
        // be blamed for; see the header comment.
        if (worst("v2-text-text-base") < AA) return
        for (const token of ["v2-text-text-muted", "v2-text-text-faint"] as const) {
          const ratio = worst(token)
          expect(ratio >= AA ? "ok" : `${name} ${scheme} ${token} only ${ratio.toFixed(2)}:1`).toBe("ok")
        }
      })
    }
  }

  test("a var(...) override is passed through untouched", () => {
    // A non-hex override is a deliberate author choice and cannot be measured;
    // the clamp must not rewrite it into a hex.
    const resolved = resolveThemeVariantV2(
      { ...(DEFAULT_THEMES["oc-2"]!.dark as object), v2Overrides: { "v2-text-text-faint": "var(--custom-faint)" } } as never,
      true,
    )
    expect(resolved["v2-text-text-faint"]).toBe("var(--custom-faint)")
  })
})

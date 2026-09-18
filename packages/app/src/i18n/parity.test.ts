import { describe, expect, test } from "bun:test"
import { dict as en } from "./en"
import { dict as ar } from "./ar"
import { dict as br } from "./br"
import { dict as bs } from "./bs"
import { dict as da } from "./da"
import { dict as de } from "./de"
import { dict as es } from "./es"
import { dict as fr } from "./fr"
import { dict as ja } from "./ja"
import { dict as ko } from "./ko"
import { dict as no } from "./no"
import { dict as pl } from "./pl"
import { dict as ru } from "./ru"
import { dict as uk } from "./uk"
import { dict as th } from "./th"
import { dict as zh } from "./zh"
import { dict as zht } from "./zht"
import { dict as tr } from "./tr"
import { dict as it } from "./it"
import { dict as nl } from "./nl"
import { dict as sv } from "./sv"
import { dict as fi } from "./fi"
import { dict as cs } from "./cs"
import { dict as hu } from "./hu"
import { dict as ro } from "./ro"
import { dict as el } from "./el"
import { dict as vi } from "./vi"
import { dict as id } from "./id"
import { dict as hi } from "./hi"

const locales = [ar, br, bs, da, de, es, fr, ja, ko, no, pl, ru, uk, th, tr, zh, zht, it, nl, sv, fi, cs, hu, ro, el, vi, id, hi]
const keys = ["command.session.previous.unseen", "command.session.next.unseen"] as const

const named: Record<string, unknown> = {
  ar,
  br,
  bs,
  da,
  de,
  es,
  fr,
  ja,
  ko,
  no,
  pl,
  ru,
  uk,
  th,
  tr,
  zh,
  zht,
  it,
  nl,
  sv,
  fi,
  cs,
  hu,
  ro,
  el,
  vi,
  id,
  hi,
}

// DeveAgent surfaces (sidebar, shell, marketplace, status bar) route through the
// dictionary under the "deveagent." prefix. English must define them; every other
// locale must ship a real string instead of silently inheriting the English base.
//
// The fallback check is a ratio, not a per-key allowlist: many languages share
// spellings with English for real reasons (Dutch "Context", German "Terminal",
// the "s"/"min" unit suffixes, Portuguese "Serial"). An exact-match allowlist
// would have to grow with every new key and would keep flagging correct
// translations. Instead each locale must differ from English for at least 85% of
// the keys — a threshold that sits well above the current worst locale (~6%) and
// far below a wholesale English paste (~100%).
const PRODUCT_NAMES = new Set([
  "deveagent.sidebar.skillStore",
  "deveagent.sidebar.codeGraph",
  "deveagent.sidebar.memory",
  "deveagent.statusbar.provider",
])
const MIN_TRANSLATED_RATIO = 0.85

// Surfaces that must be translated everywhere, not just present. Keeping this a
// prefix list (rather than one namespace) means a new maintained surface is
// covered by adding its prefix here, and the ratio gate then guards it.
const SURFACE_PREFIXES = ["deveagent.", "settings.general.", "home.", "sidebar."]

// Locales maintained as complete dictionaries (the other 11 are still partial:
// they only carry the DeveAgent surfaces so far).
// The former 11 partial locales (it/nl/sv/fi/cs/hu/ro/el/vi/id/hi) were filled
// with the remaining ~880 basic keys in the B-class batch, so every locale
// except en is now complete and guarded by the same zero-missing gate.
const FULL_LOCALES = ["ar", "br", "bs", "da", "de", "es", "fr", "ja", "ko", "no", "pl", "ru", "th", "tr", "uk", "zh", "zht", "it", "nl", "sv", "fi", "cs", "hu", "ro", "el", "vi", "id", "hi"]

const deveagentKeys = Object.keys(en).filter((key) => key.startsWith("deveagent."))
// Keys on the maintained surfaces. `deveagentKeys` stays as the strict
// "must exist in every locale, including the partial ones" set.
const surfaceKeys = Object.keys(en).filter((key) => SURFACE_PREFIXES.some((prefix) => key.startsWith(prefix)))

function read(dict: unknown, key: string): string | undefined {
  return (dict as Record<string, string | undefined>)[key]
}

describe("i18n parity", () => {
  test("non-English locales translate targeted unseen session keys", () => {
    for (const locale of locales) {
      for (const key of keys) {
        expect(locale[key]).toBeDefined()
        expect(locale[key]).not.toBe(en[key])
      }
    }
  })

  test("English defines the DeveAgent surface keys", () => {
    expect(deveagentKeys.length).toBeGreaterThanOrEqual(104)
    for (const key of deveagentKeys) {
      expect(read(en, key)).toBeTruthy()
    }
  })

  test("every locale defines a non-empty string for every DeveAgent key", () => {
    for (const [name, locale] of Object.entries(named)) {
      for (const key of deveagentKeys) {
        const value = read(locale, key)
        // Comparing a composed string keeps the failing locale+key readable.
        expect(value ? "ok" : `${name} missing ${key}`).toBe("ok")
      }
    }
  })

  test("no locale silently falls back to the English wording", () => {
    const translatable = deveagentKeys.filter((key) => !PRODUCT_NAMES.has(key))
    for (const [name, locale] of Object.entries(named)) {
      const translated = translatable.filter((key) => read(locale, key) !== read(en, key)).length
      const ratio = translated / translatable.length
      expect(ratio >= MIN_TRANSLATED_RATIO ? "ok" : `${name} only ${Math.round(ratio * 100)}% translated`).toBe("ok")
    }
  })

  test("the fully translated locales leave no non-WSL key on the English base", () => {
    // These locales are maintained as complete dictionaries. WSL onboarding is
    // excluded because it is a Windows-only flow that has not been translated
    // yet; everything else must exist, otherwise the packaged app renders
    // English for that key (this is what the vr193 screenshot showed).
    for (const name of FULL_LOCALES) {
      const locale = named[name]
      // WSL onboarding used to be excluded (Windows-only flow, untranslated);
      // the B-class/WSL batches filled every locale, so the gate is now absolute.
      const absent = Object.keys(en).filter((key) => !(key in (locale as object)))
      expect(absent.length === 0 ? "ok" : `${name} missing ${absent.slice(0, 5).join(", ")}`).toBe("ok")
    }
  })

  test("the maintained surfaces are actually translated, not copied from English", () => {
    // Presence is not enough: a key can exist and still hold the English string
    // (settings.general.row.terminalFont.* sat untranslated in 16 locales). This
    // ratio gate covers the maintained surfaces for the complete locales.
    const translatable = surfaceKeys.filter((key) => !PRODUCT_NAMES.has(key))
    expect(surfaceKeys.length).toBeGreaterThanOrEqual(200)
    for (const name of FULL_LOCALES) {
      const locale = named[name]
      const translated = translatable.filter((key) => read(locale, key) !== read(en, key)).length
      const ratio = translated / translatable.length
      expect(ratio >= MIN_TRANSLATED_RATIO ? "ok" : `${name} only ${Math.round(ratio * 100)}% translated`).toBe("ok")
    }
  })
})

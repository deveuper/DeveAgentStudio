import { describe, expect, test } from "bun:test"

import { detectLocale, loadLocaleDict, localeDictionary, normalizeLocale, SUPPORTED_LOCALES } from "./language"

// Locales that carry a partial app dictionary rather than a full one.
const SEEDED_LOCALES = ["it", "nl", "sv", "fi", "cs", "hu", "ro", "el", "vi", "id", "hi"] as const

function withNavigatorLanguages(languages: string[], run: () => void) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator")
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { language: languages[0], languages },
  })
  try {
    run()
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original)
    else delete (globalThis as { navigator?: unknown }).navigator
  }
}

describe("language locale safety", () => {
  test("loads every exposed locale without rejecting", async () => {
    await expect(Promise.all(SUPPORTED_LOCALES.map((locale) => loadLocaleDict(locale)))).resolves.toHaveLength(
      SUPPORTED_LOCALES.length,
    )
  })

  test("keeps unsupported persisted locale values on the readable English fallback", () => {
    expect(normalizeLocale("unknown-locale")).toBe("en")
  })

  test("keeps more than twenty locale choices available", () => {
    expect(SUPPORTED_LOCALES.length).toBeGreaterThanOrEqual(20)
  })

  test("registers every seeded locale in the resolver instead of dropping it", () => {
    const english = localeDictionary("en")["deveagent.sidebar.workspace"]
    for (const locale of SEEDED_LOCALES) {
      expect(SUPPORTED_LOCALES).toContain(locale)
      const resolved = localeDictionary(locale)["deveagent.sidebar.workspace"]
      // Registered => translated; unregistered => the English base leaks through.
      expect(resolved && resolved !== english ? "ok" : `${locale} not wired`).toBe("ok")
    }
  })

  test("detects the system language instead of falling back to English", () => {
    // The desktop shell used to hardcode "en" here, so a fresh install on a
    // Chinese Windows machine started in English even though Chromium reports
    // zh-CN. These cases pin the detection down.
    const cases: Array<[string[], string]> = [
      [["zh-CN", "zh-Hans-CN", "en-US"], "zh"],
      [["zh-Hant-TW"], "zht"],
      [["en-US"], "en"],
      [["ja-JP"], "ja"],
      [["ko-KR"], "ko"],
      [["fr-FR"], "fr"],
      [["ar-EG"], "ar"],
    ]
    for (const [languages, expected] of cases) {
      withNavigatorLanguages(languages, () => {
        expect(`${languages[0]}=${detectLocale()}`).toBe(`${languages[0]}=${expected}`)
      })
    }
  })
})

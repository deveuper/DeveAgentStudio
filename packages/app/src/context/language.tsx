import * as i18n from "@solid-primitives/i18n"
import { createEffect, createMemo, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { Persist, persisted } from "@/utils/persist"
import { dict as en } from "@/i18n/en"
import { dict as uiEn } from "@opencode-ai/ui/i18n/en"
import { dict as zh } from "@/i18n/zh"
import { dict as zht } from "@/i18n/zht"
import { dict as ko } from "@/i18n/ko"
import { dict as de } from "@/i18n/de"
import { dict as es } from "@/i18n/es"
import { dict as fr } from "@/i18n/fr"
import { dict as da } from "@/i18n/da"
import { dict as ja } from "@/i18n/ja"
import { dict as pl } from "@/i18n/pl"
import { dict as ru } from "@/i18n/ru"
import { dict as uk } from "@/i18n/uk"
import { dict as ar } from "@/i18n/ar"
import { dict as no } from "@/i18n/no"
import { dict as br } from "@/i18n/br"
import { dict as th } from "@/i18n/th"
import { dict as bs } from "@/i18n/bs"
import { dict as tr } from "@/i18n/tr"
import { dict as it } from "@/i18n/it"
import { dict as nl } from "@/i18n/nl"
import { dict as sv } from "@/i18n/sv"
import { dict as fi } from "@/i18n/fi"
import { dict as cs } from "@/i18n/cs"
import { dict as hu } from "@/i18n/hu"
import { dict as ro } from "@/i18n/ro"
import { dict as el } from "@/i18n/el"
import { dict as vi } from "@/i18n/vi"
import { dict as id } from "@/i18n/id"
import { dict as hi } from "@/i18n/hi"
import { dict as uiZh } from "@opencode-ai/ui/i18n/zh"
import { dict as uiZht } from "@opencode-ai/ui/i18n/zht"
import { dict as uiKo } from "@opencode-ai/ui/i18n/ko"
import { dict as uiDe } from "@opencode-ai/ui/i18n/de"
import { dict as uiEs } from "@opencode-ai/ui/i18n/es"
import { dict as uiFr } from "@opencode-ai/ui/i18n/fr"
import { dict as uiDa } from "@opencode-ai/ui/i18n/da"
import { dict as uiJa } from "@opencode-ai/ui/i18n/ja"
import { dict as uiPl } from "@opencode-ai/ui/i18n/pl"
import { dict as uiRu } from "@opencode-ai/ui/i18n/ru"
import { dict as uiUk } from "@opencode-ai/ui/i18n/uk"
import { dict as uiAr } from "@opencode-ai/ui/i18n/ar"
import { dict as uiNo } from "@opencode-ai/ui/i18n/no"
import { dict as uiBr } from "@opencode-ai/ui/i18n/br"
import { dict as uiTh } from "@opencode-ai/ui/i18n/th"
import { dict as uiBs } from "@opencode-ai/ui/i18n/bs"
import { dict as uiTr } from "@opencode-ai/ui/i18n/tr"

export type Locale =
  | "en"
  | "zh"
  | "zht"
  | "ko"
  | "de"
  | "es"
  | "fr"
  | "da"
  | "ja"
  | "pl"
  | "ru"
  | "uk"
  | "ar"
  | "no"
  | "br"
  | "th"
  | "bs"
  | "tr"
  | "it"
  | "nl"
  | "sv"
  | "fi"
  | "cs"
  | "hu"
  | "ro"
  | "el"
  | "vi"
  | "id"
  | "hi"

type RawDictionary = typeof en & typeof uiEn
type Dictionary = i18n.Flatten<RawDictionary>
function cookie(locale: Locale) {
  return `oc_locale=${encodeURIComponent(locale)}; Path=/; Max-Age=31536000; SameSite=Lax`
}

export const SUPPORTED_LOCALES: readonly Locale[] = [
  "en",
  "zh",
  "zht",
  "ko",
  "de",
  "es",
  "fr",
  "da",
  "ja",
  "pl",
  "ru",
  "uk",
  "bs",
  "ar",
  "no",
  "br",
  "th",
  "tr",
  "it",
  "nl",
  "sv",
  "fi",
  "cs",
  "hu",
  "ro",
  "el",
  "vi",
  "id",
  "hi",
]

const LOCALES = SUPPORTED_LOCALES

const INTL: Record<Locale, string> = {
  en: "en",
  zh: "zh-Hans",
  zht: "zh-Hant",
  ko: "ko",
  de: "de",
  es: "es",
  fr: "fr",
  da: "da",
  ja: "ja",
  pl: "pl",
  ru: "ru",
  uk: "uk",
  ar: "ar",
  no: "nb-NO",
  br: "pt-BR",
  th: "th",
  bs: "bs",
  tr: "tr",
  it: "it",
  nl: "nl",
  sv: "sv",
  fi: "fi",
  cs: "cs",
  hu: "hu",
  ro: "ro",
  el: "el",
  vi: "vi",
  id: "id",
  hi: "hi",
}

const LABEL_KEY: Partial<Record<Locale, keyof Dictionary>> = {
  en: "language.en",
  zh: "language.zh",
  zht: "language.zht",
  ko: "language.ko",
  de: "language.de",
  es: "language.es",
  fr: "language.fr",
  da: "language.da",
  ja: "language.ja",
  pl: "language.pl",
  ru: "language.ru",
  uk: "language.uk",
  ar: "language.ar",
  no: "language.no",
  br: "language.br",
  th: "language.th",
  bs: "language.bs",
  tr: "language.tr",
}

// The upstream dictionaries cover the original OpenCode locales. The remaining
// exposed locales are being filled in surface by surface: each one carries a
// partial app dictionary, and any key it does not define yet inherits the
// English base. Choosing such a locale must never crash or leave the renderer
// in a pending resource state.
const FALLBACK_LABELS: Partial<Record<Locale, string>> = {
  it: "Italiano",
  nl: "Nederlands",
  sv: "Svenska",
  fi: "Suomi",
  cs: "Čeština",
  hu: "Magyar",
  ro: "Română",
  el: "Ελληνικά",
  vi: "Tiếng Việt",
  id: "Bahasa Indonesia",
  hi: "हिन्दी",
}

const base = i18n.flatten({ ...en, ...uiEn })
const dicts = new Map<Locale, Dictionary>([["en", base]])

const localizedSources: Partial<Record<Locale, Dictionary>> = {
  zh: { ...base, ...i18n.flatten({ ...zh, ...uiZh }) } as Dictionary,
  zht: { ...base, ...i18n.flatten({ ...zht, ...uiZht }) } as Dictionary,
  ko: { ...base, ...i18n.flatten({ ...ko, ...uiKo }) } as Dictionary,
  de: { ...base, ...i18n.flatten({ ...de, ...uiDe }) } as Dictionary,
  es: { ...base, ...i18n.flatten({ ...es, ...uiEs }) } as Dictionary,
  fr: { ...base, ...i18n.flatten({ ...fr, ...uiFr }) } as Dictionary,
  da: { ...base, ...i18n.flatten({ ...da, ...uiDa }) } as Dictionary,
  ja: { ...base, ...i18n.flatten({ ...ja, ...uiJa }) } as Dictionary,
  pl: { ...base, ...i18n.flatten({ ...pl, ...uiPl }) } as Dictionary,
  ru: { ...base, ...i18n.flatten({ ...ru, ...uiRu }) } as Dictionary,
  uk: { ...base, ...i18n.flatten({ ...uk, ...uiUk }) } as Dictionary,
  ar: { ...base, ...i18n.flatten({ ...ar, ...uiAr }) } as Dictionary,
  no: { ...base, ...i18n.flatten({ ...no, ...uiNo }) } as Dictionary,
  br: { ...base, ...i18n.flatten({ ...br, ...uiBr }) } as Dictionary,
  th: { ...base, ...i18n.flatten({ ...th, ...uiTh }) } as Dictionary,
  bs: { ...base, ...i18n.flatten({ ...bs, ...uiBs }) } as Dictionary,
  tr: { ...base, ...i18n.flatten({ ...tr, ...uiTr }) } as Dictionary,
  // These locales have no upstream UI dictionary yet. They ship a partial app
  // dictionary, so the keys that are reviewed are translated and everything
  // else keeps the English base per key instead of per locale.
  it: { ...base, ...i18n.flatten(it) } as Dictionary,
  nl: { ...base, ...i18n.flatten(nl) } as Dictionary,
  sv: { ...base, ...i18n.flatten(sv) } as Dictionary,
  fi: { ...base, ...i18n.flatten(fi) } as Dictionary,
  cs: { ...base, ...i18n.flatten(cs) } as Dictionary,
  hu: { ...base, ...i18n.flatten(hu) } as Dictionary,
  ro: { ...base, ...i18n.flatten(ro) } as Dictionary,
  el: { ...base, ...i18n.flatten(el) } as Dictionary,
  vi: { ...base, ...i18n.flatten(vi) } as Dictionary,
  id: { ...base, ...i18n.flatten(id) } as Dictionary,
  hi: { ...base, ...i18n.flatten(hi) } as Dictionary,
}

function loadDict(locale: Locale): Promise<Dictionary> {
  const hit = dicts.get(locale)
  if (hit) return Promise.resolve(hit)
  // All currently translated dictionaries are static imports. A locale switch
  // therefore never waits on a runtime chunk request, which was the remaining
  // failure/hang risk in packaged desktop builds. Locales without a complete
  // dictionary explicitly use English until a reviewed translation exists.
  const next = localizedSources[locale] ?? base
  dicts.set(locale, next)
  return Promise.resolve(next)
}

export function loadLocaleDict(locale: Locale) {
  return loadDict(locale).then(() => undefined)
}

// Read-only accessor for the dictionary a locale renders with. Lets tests
// assert that a locale is actually wired into `localizedSources` — a locale
// whose file exists but is not registered here would silently render English.
export function localeDictionary(locale: Locale): Dictionary {
  return localizedSources[normalizeLocale(locale)] ?? base
}

const localeMatchers: Array<{ locale: Locale; match: (language: string) => boolean }> = [
  { locale: "en", match: (language) => language.startsWith("en") },
  { locale: "zht", match: (language) => language.startsWith("zh") && language.includes("hant") },
  { locale: "zh", match: (language) => language.startsWith("zh") },
  { locale: "ko", match: (language) => language.startsWith("ko") },
  { locale: "de", match: (language) => language.startsWith("de") },
  { locale: "es", match: (language) => language.startsWith("es") },
  { locale: "fr", match: (language) => language.startsWith("fr") },
  { locale: "da", match: (language) => language.startsWith("da") },
  { locale: "ja", match: (language) => language.startsWith("ja") },
  { locale: "pl", match: (language) => language.startsWith("pl") },
  { locale: "ru", match: (language) => language.startsWith("ru") },
  { locale: "uk", match: (language) => language.startsWith("uk") },
  { locale: "ar", match: (language) => language.startsWith("ar") },
  {
    locale: "no",
    match: (language) => language.startsWith("no") || language.startsWith("nb") || language.startsWith("nn"),
  },
  { locale: "br", match: (language) => language.startsWith("pt") },
  { locale: "th", match: (language) => language.startsWith("th") },
  { locale: "bs", match: (language) => language.startsWith("bs") },
  { locale: "tr", match: (language) => language.startsWith("tr") },
  { locale: "it", match: (language) => language.startsWith("it") },
  { locale: "nl", match: (language) => language.startsWith("nl") },
  { locale: "sv", match: (language) => language.startsWith("sv") },
  { locale: "fi", match: (language) => language.startsWith("fi") },
  { locale: "cs", match: (language) => language.startsWith("cs") },
  { locale: "hu", match: (language) => language.startsWith("hu") },
  { locale: "ro", match: (language) => language.startsWith("ro") },
  { locale: "el", match: (language) => language.startsWith("el") },
  { locale: "vi", match: (language) => language.startsWith("vi") },
  { locale: "id", match: (language) => language.startsWith("id") },
  { locale: "hi", match: (language) => language.startsWith("hi") },
]

// Exported so the desktop shell can use the same detection as the web app
// instead of hardcoding a fallback. On a Chinese Windows machine Chromium
// reports navigator.language "zh-CN", so this resolves to zh — a hardcoded
// "en" fallback is what made a fresh install start in English.
export function detectLocale(): Locale {
  if (typeof navigator !== "object") return "en"

  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    const normalized = language.toLowerCase()
    const match = localeMatchers.find((entry) => entry.match(normalized))
    if (match) return match.locale
  }

  return "en"
}

export function normalizeLocale(value: string): Locale {
  return LOCALES.includes(value as Locale) ? (value as Locale) : "en"
}

// Locales written right-to-left. Only Arabic is exposed today; add others here
// rather than special-casing them at the call site.
const RTL_LOCALES: readonly Locale[] = ["ar"]

function readStoredLocale() {
  if (typeof localStorage !== "object") return
  try {
    const raw = localStorage.getItem("opencode.global.dat:language")
    if (!raw) return
    const next = JSON.parse(raw) as { locale?: string }
    if (typeof next?.locale !== "string") return
    return normalizeLocale(next.locale)
  } catch {
    return
  }
}

const warm = readStoredLocale() ?? detectLocale()
if (warm !== "en") void loadDict(warm)

export const { use: useLanguage, provider: LanguageProvider } = createSimpleContext({
  name: "Language",
  gate: false,
  init: (props: { locale?: Locale }) => {
    const initial = props.locale ?? readStoredLocale() ?? detectLocale()
    const [store, setStore, _, ready] = persisted(
      Persist.global("language", ["language.v1"]),
      createStore({
        locale: initial,
      }),
    )

    const locale = createMemo<Locale>(() => normalizeLocale(store.locale))
    const intl = createMemo(() => INTL[locale()])

    const [dict] = createResource(locale, loadDict, {
      initialValue: dicts.get(initial) ?? base,
    })
    const t = i18n.translator(() => dict() ?? base, i18n.resolveTemplate) as (
      key: keyof Dictionary,
      params?: Record<string, string | number | boolean>,
    ) => string

    const label = (value: Locale) => {
      const key = LABEL_KEY[value]
      return key ? t(key) : FALLBACK_LABELS[value] ?? value
    }

    createEffect(() => {
      if (typeof document !== "object") return
      const next = locale()
      document.documentElement.lang = next
      // Arabic lays out right-to-left. Without this the strings are Arabic but
      // the whole shell still flows left-to-right.
      document.documentElement.dir = RTL_LOCALES.includes(next) ? "rtl" : "ltr"
      document.cookie = cookie(next)
    })

    return {
      ready,
      locale,
      intl,
      locales: LOCALES,
      label,
      t,
      setLocale(next: Locale) {
        const normalized = normalizeLocale(next)
        if (normalized === locale()) return
        // `loadDict` is now synchronous-from-cache/static. Store the selected
        // locale in the same turn so rapid clicks cannot leave the renderer
        // waiting on an obsolete asynchronous dictionary request.
        void loadDict(normalized)
        setStore("locale", normalized)
      },
    }
  },
})

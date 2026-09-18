#!/usr/bin/env node
// i18n scan: report user-facing CJK strings that are not routed through one of
// the project's locale helpers.
//
// Wrapped = the line calls one of the helpers the app already uses:
//   ui(zh, en) / trl(zh, en) / chinese(...) / t("key") / t.("key")
// Anything else that contains CJK is reported, so the i18n long tail can be
// worked down file by file without re-inventing a grep every round
// (backlog E41 / R181-R187).
//
// Usage:
//   node script/i18n-scan.mjs                 # scan packages/app/src
//   node script/i18n-scan.mjs packages/ui/src
//   node script/i18n-scan.mjs --json          # machine-readable output
//   node script/i18n-scan.mjs --limit 30      # show N worst files (default 25)
//
// Exit code: 0 always unless --fail-over N is given and the total exceeds N.

import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const productRoot = path.dirname(here)

const argv = process.argv.slice(2)
const json = argv.includes("--json")
const limitIndex = argv.indexOf("--limit")
const limit = limitIndex >= 0 ? Number(argv[limitIndex + 1]) || 25 : 25
const failIndex = argv.indexOf("--fail-over")
const failOver = failIndex >= 0 ? Number(argv[failIndex + 1]) : undefined
const targets = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--limit" && argv[i - 1] !== "--fail-over")

const roots = (targets.length > 0 ? targets : ["packages/app/src"]).map((rel) =>
  path.isAbsolute(rel) ? rel : path.join(productRoot, rel),
)

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
// A line counts as already localized when it routes text through a helper or
// through one of the project's data-driven locale keys:
//   ui(zh, en) / trl(zh, en) / chinese(...) / t("key")
//   chinese ? "中文" : "English"        <- inline ternary
//   { zh: "…", en: "…" }                <- data table
//   descEn / prosEn / whenToUseEn       <- bilingual field pairs
const WRAPPER = /(?<![\w$.])(ui|trl|tz|t)\(|\bchinese\b|language\.locale\(\)|\b(zh|zht|ja|ko|ru|ar)\s*:|\b[a-zA-Z]+Zh\s*:|\b[a-zA-Z]+En\s*:/
const SKIP_FILE = /\.(test|spec)\.(ts|tsx|js|mjs)$|\.d\.ts$/
// The dictionary files are the translations themselves, not call sites.
const SKIP_PATH = /(^|[\\/])i18n[\\/]/

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name === "out") continue
    const full = path.join(dir, name)
    let info
    try {
      info = statSync(full)
    } catch {
      continue
    }
    if (info.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name) && !SKIP_FILE.test(name) && !SKIP_PATH.test(full)) out.push(full)
  }
  return out
}

function isComment(trimmed) {
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")
}

const files = roots.flatMap((root) => walk(root))
if (!files.length) {
  console.error("i18n scan: no source files found; check the target directory.")
  process.exit(2)
}
const results = []
let total = 0

for (const file of files) {
  let text
  try {
    text = readFileSync(file, "utf8")
  } catch {
    continue
  }
  // Bilingual data tables keep the Chinese and English values on separate
  // lines (`desc: "…"` followed by `descEn: "…"`). A `desc:` line is therefore
  // already localized when the same file declares `descEn:` — collect those
  // bases up front so the table pattern is not reported as a long-tail hit.
  const bilingual = new Set()
  for (const match of text.matchAll(/\b([a-zA-Z][a-zA-Z0-9]*?)En\s*:/g)) bilingual.add(match[1])

  const lines = text.split(/\r?\n/)
  const hits = []
  // `ui(zh, en)` calls are often formatted across lines, so the helper call and
  // the Chinese argument are not on the same physical line. Track the last
  // non-empty line to recognise a bare localized string argument.
  const isStringArg = (t) => /^[`"'][\s\S]*[`"'],?\s*\)?,?;?\s*$/.test(t) && !/=>/.test(t)
  let previous = ""
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    const wrappedByMultiline =
      isStringArg(trimmed) && (WRAPPER.test(previous) || isStringArg(previous))
    if (trimmed) previous = trimmed
    if (!CJK.test(line)) return
    if (!trimmed || isComment(trimmed)) return
    if (WRAPPER.test(line)) return
    if (wrappedByMultiline) return
    const key = /^["']?([a-zA-Z][a-zA-Z0-9]*)["']?\s*:/.exec(trimmed)
    if (key && bilingual.has(key[1])) return
    hits.push({ line: index + 1, text: trimmed.slice(0, 120) })
  })
  if (hits.length > 0) {
    total += hits.length
    results.push({ file: path.relative(productRoot, file).replace(/\\/g, "/"), count: hits.length, hits })
  }
}

results.sort((a, b) => b.count - a.count)

if (json) {
  console.log(JSON.stringify({ total, files: results.length, scannedFiles: files.length, results }, null, 2))
} else {
  console.log(`i18n scan: scanned ${files.length} files; ${total} unwrapped CJK line(s) in ${results.length} files. This is a wrapper audit, not translation coverage.\n`)
  for (const entry of results.slice(0, limit)) {
    console.log(`${String(entry.count).padStart(4)}  ${entry.file}`)
    for (const hit of entry.hits.slice(0, 3)) {
      console.log(`      ${hit.line}: ${hit.text}`)
    }
    if (entry.hits.length > 3) console.log(`      ... ${entry.hits.length - 3} more`)
  }
  if (results.length > limit) console.log(`\n... ${results.length - limit} more file(s) (use --limit N)`)
}

if (failOver !== undefined && total > failOver) {
  console.error(`\ni18n gate: ${total} unwrapped lines exceeds the allowed ${failOver}.`)
  process.exit(1)
}

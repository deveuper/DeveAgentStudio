#!/usr/bin/env node
// Brand color gate: deep-blue / off-palette literals must not re-enter the
// product UI. Syntax-highlight code colors (syntax-* keys, highlight.js styles)
// are allowed by convention — code content is not brand surface.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const ROOTS = ["packages/app/src", "packages/ui/src"]
const EXT = /\.(tsx?|css|json)$/
// Brand-relevant blues only; #79C0FF/#A5D6FF survive inside syntax-* keys.
const BLUE_HEX = /#(2F6FED|1F5FD0|1F6FED|4096ff|58A6FF|1F6FEB|388BFD)/gi
const BLUE_CLASS = /(?:text|bg|border|ring|from|to|via)-(?:blue|indigo|sky|slate)-\d{2,3}/g

const hits = []
function walk(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === "out") continue
      walk(full)
      continue
    }
    if (!EXT.test(entry)) continue
    let text
    try {
      text = readFileSync(full, "utf8")
    } catch {
      continue
    }
    const rel = relative(".", full).replaceAll("\\", "/")
    // Bundled third-party theme JSONs are content, not brand surface; only
    // DeveAgent's own theme files are gated.
    if (/themes[/\\].*\.json$/.test(rel) && !/deveagent-/.test(rel)) continue
    const lines = text.split("\n")
    lines.forEach((line, i) => {
      // Skip syntax-* token lines in theme JSON: code-color convention.
      if (/["']syntax-/.test(line) && /json$/.test(entry)) return
      // Skip highlight.js / code-content css blocks marked by comment.
      if (/hljs|syntax-highlight/i.test(line)) return
      const hex = line.match(BLUE_HEX)
      if (hex) hits.push(`${rel}:${i + 1} hex ${hex.join(",")}`)
      const cls = line.match(BLUE_CLASS)
      if (cls) hits.push(`${rel}:${i + 1} class ${cls.join(",")}`)
    })
  }
}

for (const root of ROOTS) walk(root)

if (hits.length > 0) {
  console.error(`brand-color gate: ${hits.length} hit(s)`)
  for (const hit of hits) console.error("  " + hit)
  process.exit(1)
}
console.log("brand-color gate: clean")

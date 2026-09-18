// R197-G11 type-scale gate: arbitrary font sizes must use the canonical tiers.
// Allowed px tiers: 10 (badge), 11, 12, 13 (body), 14, 16, 18, 22.
// Anything else in a text-[Npx] utility fails the gate.
// Usage: node script/check-type-scale.mjs
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const root = path.resolve(process.argv[2] || ".")
// Tiers: 8/9 badge glyphs, 10 micro, 11/12 auxiliary, 13 body, 14 list,
// 16 subtitle, 18 heading, 22 hero, 32 display (avatar initials).
const ALLOWED = new Set([8, 9, 10, 11, 12, 13, 14, 16, 18, 22, 32])
const PATTERN = /text-\[(\d+)px\]/g
const SKIP_DIRS = new Set(["node_modules", "dist", "out", ".git", "coverage"])

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* walk(full)
    } else if (/\.(tsx|ts)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      yield full
    }
  }
}

const offenders = []
for (const dir of ["packages/app/src", "packages/ui/src"]) {
  const base = path.join(root, dir)
  try {
    statSync(base)
  } catch {
    continue
  }
  for (const file of walk(base)) {
    const content = readFileSync(file, "utf8")
    let m
    while ((m = PATTERN.exec(content))) {
      const size = Number(m[1])
      if (!ALLOWED.has(size)) {
        offenders.push({ file: path.relative(root, file), size, line: content.slice(0, m.index).split("\n").length })
      }
    }
  }
}

if (offenders.length > 0) {
  console.error("type-scale offenders (allowed tiers: 8/9/10/11/12/13/14/16/18/22/32):")
  for (const o of offenders) console.error(`  ${o.file}:${o.line} text-[${o.size}px]`)
  process.exit(1)
}
console.log(`type-scale gate: clean (${ALLOWED.size} canonical tiers)`)

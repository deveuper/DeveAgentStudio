#!/usr/bin/env node
// Correct full-chain desktop packaging for DeveAgent Studio.
//
// Refresh the backend once, build Electron, then package into a new directory.
// An existing output is preserved and publishing is always disabled.
//
// Usage:
//   node script/package-desktop.mjs             # -> dist-local
//   node script/package-desktop.mjs vr142       # -> dist-vr142
//   VR=vr142 node script/package-desktop.mjs
//
// Exit code is non-zero on any failed step, so it is safe to use in CI.

import { existsSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const here = path.dirname(fileURLToPath(import.meta.url))
const productRoot = path.dirname(here) // references/00-opencode-active
const desktopDir = path.join(productRoot, "packages", "desktop")

const label = (process.argv[2] || process.env.VR || "local").trim()
if (!/^[a-zA-Z0-9._-]+$/.test(label)) {
  console.error(`Invalid build label: ${label}. Use letters, digits, dot, dash, underscore.`)
  process.exit(2)
}
const outputDir = `dist-${label}`
const outputPath = path.join(desktopDir, outputDir)

function run(command, args, cwd) {
  console.log(`\n$ ${command} ${args.join(" ")}   (cwd: ${path.relative(productRoot, cwd) || "."})`)
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" })
  if (result.error) {
    console.error(`failed to spawn ${command}: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`\nstep failed (exit ${result.status}): ${command} ${args.join(" ")}`)
    process.exit(result.status ?? 1)
  }
}

// Build alongside existing packages; never terminate a user's running session
// or delete their last known-good build just to make packaging succeed.
if (existsSync(outputPath)) {
  console.error(`Output already exists: ${outputDir}. Choose a new build label.`)
  process.exit(2)
}

// Order matters: the desktop bundle consumes the generated backend.
run("bun", ["run", "prebuild"], desktopDir)
run("bunx", ["electron-vite", "build"], desktopDir)
run(
  "bunx",
  ["electron-builder", "--win", "--publish", "never", "--config", "electron-builder.config.ts", `-c.directories.output=${outputDir}`],
  desktopDir,
)

// 4. Report what was actually produced (honesty: no claiming success without
//    naming the artifact).
const exeFiles = existsSync(outputPath)
  ? readdirSync(outputPath).filter((name) => name.toLowerCase().endsWith(".exe"))
  : []
if (exeFiles.length === 0) {
  console.error(`\nNo .exe found in ${outputDir} — the build did not produce an installer.`)
  process.exit(1)
}
for (const name of exeFiles) {
  const full = path.join(outputPath, name)
  const mb = (statSync(full).size / 1024 / 1024).toFixed(1)
  console.log(`\nartifact: ${path.relative(productRoot, full)}  (${mb} MB)`)
}
console.log(`\nnext: point tests/probe-vr68-windows.mjs at ${outputDir}, or run it with E2E_EXE.`)

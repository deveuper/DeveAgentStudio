#!/usr/bin/env bun
import { resolve } from "node:path"

import { resolveChannel } from "./utils"

const channel = resolveChannel()

const desktopRoot = resolve(import.meta.dir, "..")
const opencodeRoot = resolve(desktopRoot, "..", "opencode")

async function runBun(label: string, cwd: string, args: string[]) {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await child.exited
  if (code !== 0) throw new Error(`${label} failed with exit code ${code}`)
}

await runBun("copy-icons", desktopRoot, ["scripts/copy-icons.ts", channel])
await runBun("copy-metainfo", desktopRoot, ["scripts/copy-metainfo.ts", channel])
await runBun("prepare-python-runtime", desktopRoot, ["scripts/prepare-python-runtime.ts"])
await runBun("build-node", opencodeRoot, ["script/build-node.ts"])

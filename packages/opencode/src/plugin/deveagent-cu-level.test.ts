import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cuAskSkipped, getCuPermissionLevel, normalizeCuLevel, setCuLevelWriter, setCuPermissionLevel } from "./deveagent-cu-level"

function workspace() {
  return mkdtempSync(join(tmpdir(), "cu-level-"))
}

describe("deveagent-cu-level", () => {
  test("normalizeCuLevel falls back to default on junk", () => {
    expect(normalizeCuLevel("auto")).toBe("auto")
    expect(normalizeCuLevel("full")).toBe("full")
    expect(normalizeCuLevel("default")).toBe("default")
    expect(normalizeCuLevel("yolo")).toBe("default")
    expect(normalizeCuLevel(undefined)).toBe("default")
    expect(normalizeCuLevel(42)).toBe("default")
  })

  test("set + get round-trips through the workspace file", async () => {
    const directory = workspace()
    try {
      expect(getCuPermissionLevel(directory)).toBe("default")
      await setCuPermissionLevel(directory, "auto")
      expect(getCuPermissionLevel(directory)).toBe("auto")
      const raw = JSON.parse(readFileSync(join(directory, ".deveagent", "cu-level.json"), "utf8")) as { level: string; updatedAt?: string }
      expect(raw.level).toBe("auto")
      expect(typeof raw.updatedAt).toBe("string")
      await setCuPermissionLevel(directory, "full")
      expect(getCuPermissionLevel(directory)).toBe("full")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("cuAskSkipped is true only for auto/full", async () => {
    const directory = workspace()
    try {
      expect(cuAskSkipped(directory)).toBe(false)
      await setCuPermissionLevel(directory, "auto")
      expect(cuAskSkipped(directory)).toBe(true)
      await setCuPermissionLevel(directory, "full")
      expect(cuAskSkipped(directory)).toBe(true)
      await setCuPermissionLevel(directory, "default")
      expect(cuAskSkipped(directory)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("undefined directory and corrupt files degrade to default", async () => {
    expect(getCuPermissionLevel(undefined)).toBe("default")
    expect(cuAskSkipped(undefined)).toBe(false)
    const directory = workspace()
    try {
      mkdirSync(join(directory, ".deveagent"), { recursive: true })
      writeFileSync(join(directory, ".deveagent", "cu-level.json"), "{corrupt")
      expect(getCuPermissionLevel(directory)).toBe("default")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("set without a directory is a no-op returning default", async () => {
    expect(await setCuPermissionLevel(undefined, "full")).toBe("default")
  })

  test("the writer injection keeps the module standalone", async () => {
    const directory = workspace()
    const written: string[] = []
    setCuLevelWriter(async (file, content) => {
      written.push(file + "::" + content)
    })
    try {
      await setCuPermissionLevel(directory, "full")
      expect(written).toHaveLength(1)
      expect(written[0]).toContain("full")
      expect(existsSync(join(directory, ".deveagent", "cu-level.json"))).toBe(false)
    } finally {
      setCuLevelWriter(undefined as unknown as (file: string, content: string) => Promise<void>)
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

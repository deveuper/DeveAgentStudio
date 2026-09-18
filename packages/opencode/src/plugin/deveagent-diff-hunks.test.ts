import { describe, expect, test } from "bun:test"
import { applyHunkToContent, hunkPatch, splitPatchByHunks } from "./deveagent-diff-hunks"

const twoHunkPatch = `@@ -1,4 +1,5 @@
 line1
-line2
+line2-changed
 line3
 line4
+line4b
@@ -10,3 +11,4 @@
 line10
-line11
+line11-changed
 line12`

const original = [
  "line1", "line2", "line3", "line4",
  "line5", "line6", "line7", "line8", "line9",
  "line10", "line11", "line12",
].join("\n")

describe("deveagent-diff-hunks", () => {
  test("splitPatchByHunks finds both hunks with correct ranges", () => {
    const hunks = splitPatchByHunks(twoHunkPatch)
    expect(hunks).toHaveLength(2)
    expect(hunks[0]?.oldStart).toBe(1)
    expect(hunks[0]?.newStart).toBe(1)
    expect(hunks[1]?.oldStart).toBe(10)
    expect(hunks[1]?.raw.startsWith("@@ -10,3 +11,4 @@")).toBe(true)
  })

  test("hunkPatch returns the standalone raw text of one hunk", () => {
    const raw = hunkPatch(twoHunkPatch, 0)
    expect(raw).toContain("@@ -1,4 +1,5 @@")
    expect(raw).toContain("line2-changed")
    expect(raw).not.toContain("line10")
  })

  test("applyHunkToContent applies hunk 0 and leaves the rest untouched", () => {
    const raw = hunkPatch(twoHunkPatch, 0)!
    const applied = applyHunkToContent(original, raw)
    expect(applied.ok).toBe(true)
    const lines = applied.result!.split("\n")
    expect(lines[1]).toBe("line2-changed")
    expect(lines[2]).toBe("line3")
    expect(lines[4]).toBe("line4b")
    expect(lines[5]).toBe("line5")
    expect(lines[10]).toBe("line10")
  })

  test("applying hunk 1 only touches its own lines", () => {
    const raw = hunkPatch(twoHunkPatch, 1)!
    const applied = applyHunkToContent(original, raw)
    expect(applied.ok).toBe(true)
    const lines = applied.result!.split("\n")
    expect(lines[0]).toBe("line1")
    expect(lines[10]).toBe("line11-changed")
    expect(lines[11]).toBe("line12")
  })

  test("a hunk removing past the file end fails with a readable error", () => {
    const bad = `@@ -50,2 +50,1 @@
 line50
-line51`
    const applied = applyHunkToContent(original, bad)
    expect(applied.ok).toBe(false)
    expect(applied.error).toBeTruthy()
  })

  test("hunk without a header is rejected", () => {
    expect(applyHunkToContent(original, "no header here").ok).toBe(false)
  })
})

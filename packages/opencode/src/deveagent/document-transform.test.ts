import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  isMarkItDownSupported,
  convertWithMarkItDown,
  getMarkItDownRuntimeStatus,
  MarkItDownConversionError,
} from "./document-transform"

async function withPythonEnv(vars: { override?: string; bundled?: string }, run: () => Promise<void>) {
  const savedOverride = process.env.DEVEAGENT_PYTHON
  const savedBundled = process.env.DEVEAGENT_BUNDLED_PYTHON
  if (vars.override === undefined) delete process.env.DEVEAGENT_PYTHON
  else process.env.DEVEAGENT_PYTHON = vars.override
  if (vars.bundled === undefined) delete process.env.DEVEAGENT_BUNDLED_PYTHON
  else process.env.DEVEAGENT_BUNDLED_PYTHON = vars.bundled
  try {
    await run()
  } finally {
    if (savedOverride === undefined) delete process.env.DEVEAGENT_PYTHON
    else process.env.DEVEAGENT_PYTHON = savedOverride
    if (savedBundled === undefined) delete process.env.DEVEAGENT_BUNDLED_PYTHON
    else process.env.DEVEAGENT_BUNDLED_PYTHON = savedBundled
  }
}

describe("MarkItDown document transform", () => {
  test("recognizes supported document formats only", () => {
    expect(isMarkItDownSupported("brief.docx")).toBe(true)
    expect(isMarkItDownSupported("table.xlsx")).toBe(true)
    expect(isMarkItDownSupported("image.png")).toBe(false)
    expect(isMarkItDownSupported("script.ts")).toBe(false)
  })

  test("rejects files outside the workspace before invoking Python", async () => {
    await expect(convertWithMarkItDown({ filePath: "../secret.docx", workspace: "F:/workspace" })).rejects.toThrow(
      "current workspace",
    )
  })

  test("converts a workspace CSV and reuses the cached Markdown", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "deveagent-markitdown-"))
    const source = path.join(workspace, "data.csv")
    await writeFile(source, "name,value\nalpha,42\n", "utf8")
    try {
      const first = await convertWithMarkItDown({ filePath: source, workspace })
      const second = await convertWithMarkItDown({ filePath: source, workspace })
      expect(first.cached).toBe(false)
      expect(second.cached).toBe(true)
      expect(first.provenance).toMatchObject({
        converter: "microsoft/markitdown",
        sourceRelativePath: "data.csv",
        sourceBytes: 20,
        markdownRelativePath: expect.stringMatching(/^\.deveagent\/converted\/[0-9a-f]{24}\.md$/),
      })
      expect(first.provenance.sourceSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(typeof first.provenance.runtimeCommand).toBe("string")
      expect(second.provenance.sourceSha256).toBe(first.provenance.sourceSha256)
      expect(await readFile(second.markdownPath, "utf8")).toContain("alpha")
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }, 20_000)

  test("rejects a symlink that resolves outside the workspace", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "deveagent-markitdown-link-workspace-"))
    const outside = await mkdtemp(path.join(os.tmpdir(), "deveagent-markitdown-link-outside-"))
    const source = path.join(outside, "secret.csv")
    const link = path.join(workspace, "linked.csv")
    await writeFile(source, "secret,value\nno,7\n", "utf8")
    try {
      try {
        await symlink(source, link)
      } catch {
        // Windows may deny symlink creation when developer mode is disabled.
        return
      }
      await expect(convertWithMarkItDown({ filePath: link, workspace })).rejects.toThrow("current workspace")
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("falls back to system Python when the bundled runtime is unusable", async () => {
    await withPythonEnv({ bundled: "F:/nonexistent/bundled-python.exe" }, async () => {
      const status = await getMarkItDownRuntimeStatus()
      expect(status.available).toBe(true)
      expect(status.command).not.toBe("F:/nonexistent/bundled-python.exe")
    })
  })

  test("DEVEAGENT_PYTHON override wins over the bundled runtime", async () => {
    await withPythonEnv({ override: "F:/nonexistent/override-python.exe", bundled: "F:/nonexistent/bundled-python.exe" }, async () => {
      const status = await getMarkItDownRuntimeStatus()
      expect(status.available).toBe(false)
      expect(status.attempts).toHaveLength(1)
      expect(status.attempts?.[0]?.command).toBe("F:/nonexistent/override-python.exe")
    })
  })

  test("reports bounded runtime attempts without forwarding the raw document", async () => {
    await withPythonEnv({ override: "F:/nonexistent/markitdown-python.exe" }, async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), "deveagent-markitdown-failure-"))
      const source = path.join(workspace, "failed.csv")
      await writeFile(source, "name,value\nfailed,1\n", "utf8")
      try {
        let thrown: unknown
        try {
          await convertWithMarkItDown({ filePath: source, workspace })
        } catch (error) {
          thrown = error
        }
        expect(thrown).toBeInstanceOf(MarkItDownConversionError)
        const report = (thrown as MarkItDownConversionError).report
        expect(report).toMatchObject({
          converter: "microsoft/markitdown",
          kind: "runtime",
          sourceRelativePath: "failed.csv",
          sourceBytes: 20,
          rawDocumentForwardedToModel: false,
        })
        expect(report.sourceSha256).toMatch(/^[0-9a-f]{64}$/)
        expect(report.attempts).toEqual([
          expect.objectContaining({ command: "F:/nonexistent/markitdown-python.exe" }),
        ])
      } finally {
        await rm(workspace, { recursive: true, force: true })
      }
    })
  })

  test("probes the bundled runtime before system Python", async () => {
    const bundled = process.platform === "win32" ? "F:/nonexistent/bundled-python.exe" : "/nonexistent/bundled-python"
    await withPythonEnv({ bundled }, async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), "deveagent-markitdown-bundled-"))
      const source = path.join(workspace, "data.csv")
      await writeFile(source, "name,value\nbeta,7\n", "utf8")
      try {
        // Bundled candidate fails, system Python still performs the conversion.
        const result = await convertWithMarkItDown({ filePath: source, workspace })
        expect(await readFile(result.markdownPath, "utf8")).toContain("beta")
      } finally {
        await rm(workspace, { recursive: true, force: true })
      }
    })
  })
})

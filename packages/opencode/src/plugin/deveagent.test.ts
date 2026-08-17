import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"
import deveagentPlugin, { assertPublicBrowserUrl, buildTeamTaskInput, cancelTeamRun, captureDeveAgentCompactionMemory, checkRoleProfileModel, classifyVisionFallback, clearGoal, clearGoalDraft, clearGrillingDecisions, clearLoop, clearSessionAuxiliary, completeGrilling, computePrefixShape, confirmGoal, createDeveAgentCodeGraphIndex, createDeveAgentContextPack, createDeveAgentRuntimePrompt, createReviewScope, createSessionToolQueue, dispatchTeamAll, dispatchTeamMember, estimateDeveAgentCost, exportGrillingDecisions, exportWorkspaceMarkdownForObsidian, extractSymbols, extractSymbolsFromFiles, getDeveAgentCodeGraphIndexStatus, getDeveAgentCodeGraphNeighbors, getDeveAgentMemoryTree, getDeveAgentSkillMarket, getDeveAgentState, getDeveAgentTeam, getDeveAgentTeamPhases, getDeveAgentTeamRuns, getGoal, getGoalDraft, getGoalQueue, getGrillingDecisions, getGrillingStatus, getLoop, getLoopQueue, getSessionAuxiliary, getSuperpowersPrompt, getSuperpowersPromptAsync, getTeamMemberByRole, goalBackoffMs, installRemoteSkill, isDangerousPermissionTarget, isGrillingWriteBlocked, isTreeSitterAvailable, loadDeveAgentTeamState, loadDeveAgentTeamRuns, loadLocalSkills, loadRemoteSkills, loopBackoffMs, normalizeDeveAgentClawHubMarket, normalizeDeveAgentMcpRegistryResponse, normalizeDeveAgentSkillHubMarket, normalizeDeveAgentSkillMarketTree, normalizeDeveAgentState, normalizeGrillingTimingEntries, normalizeRemoteSkillUrl, parseDeveAgentComputerUseShellCommand, pauseLoop, prefixShapeSnapshot, prepareGoal, projectDeveAgentSessionContextPack, promoteDeveAgentMemoryCandidate, queryDeveAgentMemory, rankFiles, readDeveAgentMcpMarketPreferences, readDeveAgentSkillMarketPreferences, readDeveAgentRecentSessionMessages, recordGrillingDecision, recordPrefixShape, recordProviderPromptTokens, recordRequestChars, recoverInterruptedTeamRuns, reconcileTeamRunChildren, rememberDeveAgentMemory, removeLocalSkill, removeRemoteSkill, renewTeamPhaseLease, reserveGoalReentry, resolveEffectiveToolExecution, resumeLoop, reviewTeamSynthesisArtifacts, scanGoalQueueOnce, scanLoopQueueOnce, setDeveAgentSessionContextPack, setDeveAgentState, setSessionAuxiliary, setGoal, setLoop, syncDeveAgentRuntimeGlobals, transcribeOpenAICompatibleAudio, treeSitterExtractSymbols, treeSitterExtractSymbolsFromFiles, validateDeveAgentMcpRemoteUrl, verifyGoal, visionFallbackMessage, voiceTranscriptionUrl, waitForGoalStoreFlush, waitForLoopStoreFlush, waitForTeamStateFlush, writeDeveAgentMcpMarketPreferences, writeDeveAgentSkillMarketPreferences } from "./deveagent"

import { appendDeveAgentMemoryNote, consolidateDeveAgentMemory, ensureDeveAgentMemoryScaffold, rebuildDeveAgentMemoryContext, reconcileDeveAgentMemory, writeDeveAgentMemoryCheckpoint, writeDeveAgentMemoryProgress } from "./deveagent"
import { resetTurnTailState } from "./deveagent"
import { tokenProjectionSnapshot } from "./deveagent"
import { setDeveAgentTeam } from "./deveagent"
import { rebuildDeveAgentMemoryFts, searchDeveAgentMemoryFts } from "./deveagent-memory-fts"
import { assertBrowserNavigationUrl } from "./deveagent"

describe("DeveAgent runtime state", () => {
  test("initializes the MarkItDown runtime hook without a persisted state write", () => {
    const previous = getDeveAgentState()
    try {
      setDeveAgentState({
        selectedSkills: [{ id: "markitdown", name: "MarkItDown", source: "builtin:microsoft/markitdown", installed: true, enabled: true, risk: "trusted" }],
        markitdownMode: "auto",
      })
      delete (globalThis as any).__deveagent_markitdown_mode
      syncDeveAgentRuntimeGlobals()
      expect((globalThis as any).__deveagent_markitdown_mode).toBe("auto")
    } finally {
      setDeveAgentState(previous)
    }
  })

  test("synchronizes the remote MCP hard gate with runtime state", () => {
    const previous = getDeveAgentState()
    try {
      setDeveAgentState({ remoteMcp: false })
      expect((globalThis as any).__deveagent_remote_mcp).toBe(false)
      setDeveAgentState({ remoteMcp: true })
      expect((globalThis as any).__deveagent_remote_mcp).toBe(true)
    } finally {
      setDeveAgentState(previous)
    }
  })

  test("uses CJK FTS terms and drops weak relative matches when the sidecar is available", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-memory-fts-ranking-"))
    try {
      const commonMemory = Array.from({ length: 40 }, (_, index) => ({
        id: `weak-${index}`,
        kind: "project",
        title: "记忆",
        body: "记忆",
        keywords: ["记忆"],
      }))
      await rebuildDeveAgentMemoryFts(directory, [
        { id: "strong", kind: "project", title: "中文记忆", body: "中文记忆检索", keywords: ["中文", "文记", "记忆", "忆检", "检索"] },
        ...commonMemory,
      ])
      const hits = await searchDeveAgentMemoryFts(directory, "记忆检索", 50)
      if (hits === undefined) return
      expect(hits[0]?.id).toBe("strong")
      expect(hits.some((hit) => hit.id.startsWith("weak-"))).toBe(false)
      expect(hits[0]?.score).toBeGreaterThan(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("uses MiMo-style Markdown project and session memory with a bounded retrieval budget", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-memory-markdown-"))
    const sessionID = "memory-session"
    try {
      await ensureDeveAgentMemoryScaffold(directory)
      await writeFile(path.join(directory, ".deveagent", "memory", "MEMORY.md"), "# Project memory\n\n## Rules\nProvider fallback requires a bounded retry budget.\n", "utf8")
      await mkdir(path.join(directory, ".deveagent", "memory", "custom"), { recursive: true })
      await writeFile(path.join(directory, ".deveagent", "memory", "custom", "decision.md"), "# Imported decision\n\nProvider fallback retry policy is recorded in this user note.\n", "utf8")
      await writeFile(path.join(directory, ".deveagent", "memory", "custom", "deep.md"), `# Deep note\n\n${"noise ".repeat(400)}\nLate memory anchor retrieval phrase.\n`, "utf8")
      await writeDeveAgentMemoryCheckpoint({ directory, sessionID, summary: "The provider fallback timeout was fixed.", nextAction: "Run the focused provider test." })
      await appendDeveAgentMemoryNote({ directory, sessionID, text: "Keep the retry budget visible in the next review." })
      await writeDeveAgentMemoryProgress({ directory, sessionID, taskID: "provider-fallback", status: "in_progress", summary: "The focused provider test is pending.", nextAction: "Run the provider test and record the result." })

      const results = await queryDeveAgentMemory({ directory, sessionID, query: "provider fallback retry", limit: 10, tokenBudget: 128 })
      expect(results.some((entry) => entry.kind === "project")).toBe(true)
      expect(results.some((entry) => entry.sourcePath?.endsWith("custom/decision.md"))).toBe(true)
      const deepMatches = await queryDeveAgentMemory({ directory, query: "late memory anchor retrieval", limit: 10 })
      expect(deepMatches.some((entry) => entry.sourcePath?.endsWith("custom/deep.md"))).toBe(true)
      expect(deepMatches.find((entry) => entry.sourcePath?.endsWith("custom/deep.md"))?.snippet).toContain("Late memory anchor retrieval phrase")
      expect(results.some((entry) => entry.kind === "checkpoint")).toBe(true)
      expect(results.every((entry) => entry.summary.length <= 500)).toBe(true)
      const injectedChars = results.reduce((total, entry) => total + entry.title.length + (entry.snippet ?? entry.summary).length + 32, 0)
      expect(injectedChars).toBeLessThanOrEqual(2_048)
      const tree = await getDeveAgentMemoryTree({ directory })
      expect(tree.groups.some((group) => group.kind === "checkpoint" && group.entries.length === 1)).toBe(true)
      expect(tree.groups.some((group) => group.kind === "progress" && group.entries.length === 1)).toBe(true)
      expect(await readFile(path.join(directory, ".deveagent", "memory", "sessions", sessionID, "checkpoint.md"), "utf8")).toContain("Run the focused provider test.")
      expect(await readFile(path.join(directory, ".deveagent", "memory", "sessions", sessionID, "tasks", "provider-fallback", "progress.md"), "utf8")).toContain("Status: in_progress")
      const sessionOnly = await queryDeveAgentMemory({ directory, sessionID: "other", query: "provider fallback", scope: "session" })
      expect(sessionOnly.every((entry) => entry.sessionID === sessionID)).toBe(true)
      const taskOnly = await queryDeveAgentMemory({ directory, query: "provider test", scope: "task", kind: "progress" })
      expect(taskOnly).toHaveLength(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("rebuilds a bounded context with active-session memory before durable workspace memory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-memory-context-"))
    try {
      const sessionID = "context-session"
      await writeDeveAgentMemoryCheckpoint({ directory, sessionID, summary: "The active provider fallback task is paused.", nextAction: "Resume from the checkpoint and verify the fallback." })
      await appendDeveAgentMemoryNote({ directory, sessionID, text: "The last provider attempt returned a timeout." })
      await writeDeveAgentMemoryProgress({ directory, sessionID, taskID: "fallback", status: "in_progress", summary: "Fallback verification is pending.", nextAction: "Run the provider test." })
      await rememberDeveAgentMemory({ directory, kind: "decision", title: "Fallback rule", summary: "Keep the provider fallback chain bounded and visible." })

      const rebuilt = await rebuildDeveAgentMemoryContext({ directory, sessionID, query: "provider fallback", tokenBudget: 256 })
      expect(rebuilt.context).toContain("## Current session memory")
      expect(rebuilt.context).toContain("Fallback verification is pending")
      expect(rebuilt.context).toContain("## Workspace durable memory")
      expect(rebuilt.context.length).toBeLessThanOrEqual(1_024)
      expect(rebuilt.tokenEstimate).toBe(Math.ceil(rebuilt.context.length / 4))
      expect(rebuilt.entries).toBeGreaterThanOrEqual(3)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("retains the real OpenCode session tail without copying tool output into rebuilt memory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-memory-transcript-"))
    try {
      const client = {
        session: {
          messages: async () => ({
            data: [
              { info: { role: "user" }, parts: [{ type: "text", text: "Keep the provider fallback decision." }] },
              { info: { role: "assistant" }, parts: [{ type: "tool", output: "do not inject this tool output" }] },
              { info: { role: "assistant" }, parts: [{ type: "text", text: "The bounded fallback is ready for verification." }] },
            ],
          }),
        },
      }
      const recent = await readDeveAgentRecentSessionMessages({ client, sessionID: "transcript-session", directory })
      const rebuilt = await rebuildDeveAgentMemoryContext({ directory, sessionID: "transcript-session", recentMessages: recent, tokenBudget: 256 })
      expect(recent).toHaveLength(2)
      expect(rebuilt.retainedMessages).toBe(2)
      expect(rebuilt.context).toContain("Keep the provider fallback decision.")
      expect(rebuilt.context).toContain("The bounded fallback is ready for verification.")
      expect(rebuilt.context).not.toContain("do not inject this tool output")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("reserves context budget for recent session messages when durable memory is crowded", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-memory-tail-budget-"))
    try {
      for (let index = 0; index < 8; index++) {
        await rememberDeveAgentMemory({
          directory,
          kind: "decision",
          title: `Old decision ${index}`,
          summary: `Historical provider decision ${index} ${"detail ".repeat(40)}`,
        })
      }
      const rebuilt = await rebuildDeveAgentMemoryContext({
        directory,
        tokenBudget: 256,
        recentMessages: [{ role: "user", text: "Keep this latest session intent after compaction." }],
      })
      expect(rebuilt.retainedMessages).toBe(1)
      expect(rebuilt.context).toContain("Keep this latest session intent after compaction.")
      expect(rebuilt.context.length).toBeLessThanOrEqual(1_024)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("persists bounded workspace memory, retrieves only matching notes, and queues repeated work for review", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-memory-"))
    try {
      await rememberDeveAgentMemory({ directory, sessionID: "one", summary: "Fix provider fallback timeout for the vision model." })
      await rememberDeveAgentMemory({ directory, sessionID: "two", summary: "Review provider fallback timeout handling for the model." })
      const third = await rememberDeveAgentMemory({ directory, sessionID: "three", summary: "Test provider fallback timeout recovery for a model." })
      expect(third.stored).toBe(true)
      expect(third.candidate?.kind).toBe("skill-candidate")

      const matches = await queryDeveAgentMemory({ directory, sessionID: "current", query: "model fallback timeout", limit: 4 })
      expect(matches.some((entry) => entry.kind === "task")).toBe(true)
      expect(matches.every((entry) => entry.summary.includes("fallback") || entry.kind === "skill-candidate")).toBe(true)

      const tree = await getDeveAgentMemoryTree({ directory })
      expect(tree.groups.find((group) => group.kind === "skill-candidate")?.entries).toHaveLength(1)
      expect(await readFile(path.join(directory, ".deveagent", "memory", "index.json"), "utf8")).toContain("skill-candidate")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("consolidates reviewed durable memory into MEMORY.md without touching the index", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-memory-consolidate-"))
    try {
      const decision = await rememberDeveAgentMemory({
        directory,
        kind: "decision",
        title: "Use bounded provider fallback",
        summary: "Retry the primary provider before a configured fallback and stop after visible output.",
      })
      await rememberDeveAgentMemory({
        directory,
        kind: "bug",
        title: "Stale session recovery",
        summary: "A missing session must return to the new-session route instead of reaching the renderer error boundary.",
      })

      const first = await consolidateDeveAgentMemory({ directory })
      const memoryFile = path.join(directory, ".deveagent", "memory", "MEMORY.md")
      const content = await readFile(memoryFile, "utf8")
      const index = await readFile(path.join(directory, ".deveagent", "memory", "index.json"), "utf8")
      expect(first.consolidated).toBe(true)
      expect(first.entries).toBe(2)
      expect(content).toContain("Use bounded provider fallback")
      expect(content).toContain("Stale session recovery")
      expect(index).toContain(decision.entry!.id)

      const second = await consolidateDeveAgentMemory({ directory })
      expect(second.entries).toBe(2)
      expect((await readFile(memoryFile, "utf8")).match(/Use bounded provider fallback/g)?.length).toBe(1)
      const matches = await queryDeveAgentMemory({ directory, query: "provider fallback", limit: 10 })
      expect(matches.filter((entry) => entry.title === "Use bounded provider fallback")).toHaveLength(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("reconciles edited Markdown memory into the canonical index before search", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-memory-reconcile-"))
    const memoryFile = path.join(directory, ".deveagent", "memory", "MEMORY.md")
    try {
      await ensureDeveAgentMemoryScaffold(directory)
      await writeFile(memoryFile, "# Project memory\n\n## Rules\nPrefer the local provider fallback ledger.\n", "utf8")
      const first = await reconcileDeveAgentMemory(directory)
      expect(first.reconciled).toBe(true)
      expect(first.indexed).toBe(1)
      const firstMatches = await queryDeveAgentMemory({ directory, query: "provider fallback ledger" })
      expect(firstMatches.some((entry) => entry.kind === "project" && entry.summary.includes("provider fallback"))).toBe(true)

      await writeFile(memoryFile, "# Project memory\n\n## Rules\nUse the bounded memory reconcile checkpoint.\n", "utf8")
      const secondMatches = await queryDeveAgentMemory({ directory, query: "memory reconcile checkpoint" })
      expect(secondMatches.some((entry) => entry.kind === "project" && entry.summary.includes("memory reconcile"))).toBe(true)
      expect(secondMatches.some((entry) => entry.summary.includes("provider fallback"))).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("persists only OpenCode-marked compaction summaries, never ordinary assistant text", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-compaction-memory-"))
    const client = {
      session: {
        messages: async () => ({ data: [
          { info: { id: "summary-message", role: "assistant", summary: true } },
          { info: { id: "ordinary-message", role: "assistant", summary: false } },
        ] }),
      },
    }
    try {
      expect((await captureDeveAgentCompactionMemory({ client, directory, sessionID: "session", messageID: "ordinary-message", text: "Ordinary assistant reply." })).stored).toBe(false)
      expect((await captureDeveAgentCompactionMemory({ client, directory, sessionID: "session", messageID: "summary-message", text: "Compacted summary of resolved provider fallback work." })).stored).toBe(true)
      const summaries = (await getDeveAgentMemoryTree({ directory })).groups.find((group) => group.kind === "summary")?.entries ?? []
      expect(summaries).toHaveLength(1)
      expect(summaries[0]?.summary).toContain("Compacted summary")
      expect(await readFile(path.join(directory, ".deveagent", "memory", "sessions", "session", "checkpoint.md"), "utf8")).toContain("Compacted summary")
      expect(await readFile(path.join(directory, ".deveagent", "memory", "MEMORY.md"), "utf8")).toContain("Compacted summary")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("injects bounded rebuilt memory into the real compaction hook", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-compaction-context-"))
    const sessionID = "compaction-context-session"
    try {
      await writeDeveAgentMemoryCheckpoint({
        directory,
        sessionID,
        summary: "The active memory restore task is waiting for compaction.",
        nextAction: "Resume the memory restore verification.",
      })
      const client = {
        session: {
          messages: async () => ({ data: [{ info: { role: "user" }, parts: [{ type: "text", text: "Continue the memory restore verification." }] }] }),
        },
      }
      const hooks = await deveagentPlugin.server({ client, directory } as unknown as Parameters<typeof deveagentPlugin.server>[0])
      const output: { context?: string[] } = { context: [] }
      await (hooks as any)["experimental.session.compacting"]({ sessionID }, output)
      const context = output.context?.join("\n") ?? ""
      expect(context).toContain("# DeveAgent rebuilt memory context")
      expect(context).toContain("The active memory restore task")
      expect(context).toContain("Continue the memory restore verification.")
      expect(context.length).toBeLessThanOrEqual(4_800)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("records real Goal tool steps as bounded task progress", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-memory-progress-"))
    const sessionID = "memory-progress-session"
    try {
      setGoal({ sessionID, description: "Verify the memory progress path", criteria: ["A real tool step is recorded"] })
      const hooks = await deveagentPlugin.server({ client: {}, directory } as unknown as Parameters<typeof deveagentPlugin.server>[0])
      await (hooks as any)["tool.execute.after"]({
        sessionID,
        callID: "progress-call",
        tool: "read",
        args: { filePath: "src/main.ts" },
      }, {})
      await (hooks as any)["tool.execute.after"]({
        sessionID,
        callID: "progress-call-2",
        tool: "grep",
        args: { pattern: "memory", path: "src" },
      }, {})
      const progress = await readFile(path.join(directory, ".deveagent", "memory", "sessions", sessionID, "tasks", `goal-${sessionID}`, "progress.md"), "utf8")
      expect(progress).toContain("Goal step completed: read (src/main.ts)")
      expect(progress).toContain("Goal step completed: grep (src)")
      expect(progress).toContain("## Task tree")
      expect(progress).toContain("- [ ] A real tool step is recorded")
      const history = progress.slice(progress.indexOf("## Step history"))
      expect(history.indexOf("Goal step completed: read (src/main.ts)")).toBeLessThan(history.indexOf("Goal step completed: grep (src)"))
      expect(progress).toContain("A real tool step is recorded")
    } finally {
      clearGoal(sessionID)
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("injects only matching workspace memory into the current turn", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-memory-runtime-"))
    try {
      await rememberDeveAgentMemory({ directory, sessionID: "past", summary: "Provider fallback timeout needs a retry budget." })
      await rememberDeveAgentMemory({ directory, sessionID: "past", summary: "Unrelated terminal color theme preference." })
      setDeveAgentState({ mode: "ask", selectedSkills: [], selectedExpert: undefined, expertTeam: [] })
      const hooks = await deveagentPlugin.server({ client: {}, directory } as unknown as Parameters<typeof deveagentPlugin.server>[0])
      const parts: any[] = [{ type: "text", text: "How should provider fallback timeout retries work?" }]
      await (hooks as any)["chat.message"]({ sessionID: "current" }, { message: {}, parts })
      const snapshot = parts.at(-1) as { type: string; synthetic?: boolean; text: string }
      expect(snapshot.type).toBe("text")
      expect(snapshot.synthetic).toBe(true)
      expect(snapshot.text).toContain("## Retrieved Project Memory")
      expect(snapshot.text).toContain("Provider fallback timeout")
      expect(snapshot.text).not.toContain("terminal color theme")
      expect(snapshot.text).toContain("<deveagent-runtime-state")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("auto-activates matching builtin Skills for one turn without persisting them", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-auto-skill-"))
    try {
      setDeveAgentState({ mode: "ask", selectedSkills: [], selectedExpert: undefined, expertTeam: [] })
      const hooks = await deveagentPlugin.server({ client: {}, directory } as unknown as Parameters<typeof deveagentPlugin.server>[0])
      const matchedParts: any[] = [{ type: "text", text: "优化这个提示词，并明确验收标准。" }]
      await (hooks as any)["chat.message"]({ sessionID: "auto-skill" }, { message: {}, parts: matchedParts })
      const matched = matchedParts.at(-1).text
      expect(matched).toContain("## Auto-Activated Builtin Skills")
      expect(matched).toContain("Prompt Optimizer (prompt-optimizer, builtin:deveagent/auto)")
      expect(matched).toContain("## Prompt Optimization")

      const unrelatedParts: any[] = [{ type: "text", text: "你好" }]
      await (hooks as any)["chat.message"]({ sessionID: "auto-skill" }, { message: {}, parts: unrelatedParts })
      const unrelated = unrelatedParts.at(-1).text
      expect(unrelated).not.toContain("## Auto-Activated Builtin Skills")
      expect(unrelated).not.toContain("## Prompt Optimization")

      // The system prompt stays byte-stable: dynamic blocks never enter it.
      const systemOutput: { system?: string[] } = {}
      await (hooks as any)["experimental.chat.system.transform"]({
        sessionID: "auto-skill",
        message: { parts: [{ type: "text", text: "优化这个提示词，并明确验收标准。" }] },
      }, systemOutput)
      expect(systemOutput.system?.join("\n")).not.toContain("## Auto-Activated Builtin Skills")
      expect(systemOutput.system?.join("\n")).not.toContain("## DeveAgent Runtime State")
      expect(systemOutput.system?.join("\n")).toContain("<deveagent-runtime-state>")
    } finally {
      setDeveAgentState({ selectedSkills: [] })
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("promotes a reviewed Memory candidate into a disabled local Skill draft", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-memory-promote-"))
    let localSkillID: string | undefined
    try {
      await rememberDeveAgentMemory({ directory, sessionID: "one", summary: "Review the provider retry policy for a coding model." })
      await rememberDeveAgentMemory({ directory, sessionID: "two", summary: "Check the provider retry policy for the same model." })
      const third = await rememberDeveAgentMemory({ directory, sessionID: "three", summary: "Verify provider retry policy before using the model." })
      const promoted = await promoteDeveAgentMemoryCandidate({ directory, id: third.candidate?.id })
      expect(promoted.promoted).toBe(true)
      localSkillID = promoted.id
      expect((await loadLocalSkills()).some((skill) => skill.id === localSkillID && skill.prompt.includes("Draft workflow") && skill.prompt.includes("Memory candidate:"))).toBe(true)
      expect((await getDeveAgentMemoryTree({ directory })).groups.find((group) => group.kind === "skill-candidate")?.entries).toHaveLength(0)
    } finally {
      if (localSkillID) await removeLocalSkill(localSkillID)
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("keeps MCP market metadata read-only and only exposes safe remote endpoints", () => {
    const result = normalizeDeveAgentMcpRegistryResponse({
      servers: [
        {
          server: {
            name: "io.example/safe",
            description: "Safe endpoint",
            remotes: [
              { type: "streamable-http", url: "https://example.com/mcp", headers: [{ name: "Authorization", isSecret: true }] },
              { type: "sse", url: "http://example.com/sse" },
            ],
            packages: [{ registryType: "npm" }],
          },
        },
      ],
    })

    expect(result.servers).toEqual([
      {
        name: "io.example/safe",
        description: "Safe endpoint",
        remotes: [{ type: "streamable-http", url: "https://example.com/mcp", requiresSecret: true, headerNames: ["Authorization"] }],
        packageTypes: ["npm"],
      },
    ])
  })

  test("rejects non-HTTPS direct MCP endpoints before workspace configuration", async () => {
    await expect(validateDeveAgentMcpRemoteUrl("http://example.com/mcp")).rejects.toThrow("HTTPS")
    await expect(validateDeveAgentMcpRemoteUrl("https://localhost/mcp")).rejects.toThrow("private or local")
  })

  test("turns only allowlisted repository SKILL.md files into concrete market installs", () => {
    const entries = normalizeDeveAgentSkillMarketTree(
      { id: "official", label: "Official", repository: "owner/repo", risk: "trusted" },
      { tree: [{ type: "blob", path: "skills/review/SKILL.md" }, { type: "blob", path: "README.md" }] },
    )

    expect(entries).toEqual([{
      id: "official-skills-review-SKILL",
      name: "review",
      description: "Official · skills/review/SKILL.md",
      source: "Official (owner/repo)",
      risk: "trusted",
      url: "https://raw.githubusercontent.com/owner/repo/HEAD/skills/review/SKILL.md",
    }])
  })

  test("normalizes SkillHub search results into reviewed SKILL.md installs", () => {
    const entries = normalizeDeveAgentSkillHubMarket(
      { id: "skillhub", label: "Tencent SkillHub", repository: "skillhub.cn", risk: "review", kind: "skillhub" },
      { data: { skills: [{ slug: "browser-auto", name: "Browser Auto", description_zh: "Browser helper", verified: false }] } },
      "browser",
    )

    expect(entries).toEqual([{
      id: "skillhub-browser-auto",
      name: "Browser Auto",
      description: "Browser helper",
      source: "Tencent SkillHub (skillhub.cn)",
      risk: "review",
      url: "https://api.skillhub.cn/api/v1/skills/browser-auto/file?path=SKILL.md",
    }])
  })

  test("normalizes ClawHub search results as untrusted concrete SKILL.md installs", () => {
    const entries = normalizeDeveAgentClawHubMarket(
      { id: "clawhub", label: "ClawHub / OpenClaw", repository: "clawhub.ai", risk: "untrusted", kind: "clawhub" },
      { results: [{ slug: "browser-helper", displayName: "Browser Helper", summary: "Browser automation", ownerHandle: "example" }] },
    )

    expect(entries).toEqual([{
      id: "clawhub-browser-helper",
      name: "Browser Helper",
      description: "Browser automation",
      source: "ClawHub / OpenClaw (clawhub.ai)",
      risk: "untrusted",
      url: "https://clawhub.ai/api/v1/skills/browser-helper/file?path=SKILL.md",
    }])
  })

  test("reports unavailable Skill Market sources instead of silently returning an empty market", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch
    try {
      const result = await getDeveAgentSkillMarket("status-regression")
      expect(result.entries).toEqual([])
      expect(result.sources).toHaveLength(7)
      expect(result.sources.every((source) => source.status === "unavailable" && source.error === "HTTP 429")).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("does not query disabled Skill Market sources", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => {
      throw new Error("disabled source was queried")
    }) as unknown as typeof fetch
    try {
      const result = await getDeveAgentSkillMarket("disabled-source-regression", [])
      expect(result).toEqual({ entries: [], sources: [] })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("persists only approved Skill Market sources inside the workspace", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-market-preferences-"))
    try {
      const defaults = await readDeveAgentSkillMarketPreferences(directory)
      expect(defaults.enabledRepositories).toContain("anthropics/skills")
      const saved = await writeDeveAgentSkillMarketPreferences({
        directory,
        enabledRepositories: ["anthropics/skills", "not-an-approved-source", "obra/superpowers"],
      })
      expect(saved.enabledRepositories).toEqual(["anthropics/skills", "obra/superpowers"])
      expect((await readDeveAgentSkillMarketPreferences(directory)).enabledRepositories).toEqual(saved.enabledRepositories)
      expect(await readFile(path.join(directory, ".deveagent", "skill-market.json"), "utf8")).toContain("anthropics/skills")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("persists MCP market source and category inside the workspace", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-mcp-preferences-"))
    try {
      expect(await readDeveAgentMcpMarketPreferences(directory)).toEqual({ version: 1, source: "official", category: "all" })
      const saved = await writeDeveAgentMcpMarketPreferences({ directory, source: "aliyun", category: "credentials" })
      expect(saved).toEqual({ version: 1, source: "aliyun", category: "credentials" })
      expect(await readDeveAgentMcpMarketPreferences(directory)).toEqual(saved)
      expect(await readFile(path.join(directory, ".deveagent", "mcp-market.json"), "utf8")).toContain('"aliyun"')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("tracks Grilling Me duration from first confirmed decision to completion", () => {
    clearGrillingDecisions("grilling-timing")
    expect(getGrillingStatus("grilling-timing")).toEqual({ started: false, completed: false, elapsedMs: 0, decisionCount: 0 })
    recordGrillingDecision({ sessionID: "grilling-timing", question: "Q", answer: "A" })
    expect(getGrillingStatus("grilling-timing").started).toBe(true)
    const completed = completeGrilling({ sessionID: "grilling-timing" })
    expect(completed.completed).toBe(true)
    expect(completed.elapsedMs).toBeGreaterThanOrEqual(0)
    clearGrillingDecisions("grilling-timing")
  })

  test("does not create a timer when completing an inactive interview", () => {
    clearGrillingDecisions("grilling-not-started")
    const result = completeGrilling({ sessionID: "grilling-not-started" })
    expect(result.error).toBe("Grilling Me has not started for this session")
    expect(getGrillingStatus("grilling-not-started").started).toBe(false)
  })

  test("goal verification completes the same session's Grilling timer", () => {
    clearGrillingDecisions("grilling-goal")
    recordGrillingDecision({ sessionID: "grilling-goal", question: "Q", answer: "A" })
    setGoal({ sessionID: "grilling-goal", description: "Finish", criteria: ["Done"] })
    expect(verifyGoal({ sessionID: "grilling-goal", met: true }).status).toBe("verified")
    expect(getGrillingStatus("grilling-goal").completed).toBe(true)
    clearGrillingDecisions("grilling-goal")
    clearGoal("grilling-goal")
  })

  test("restores only valid Grilling timing metadata without persisting interview content", () => {
    expect(
      normalizeGrillingTimingEntries([
        ["valid", { startedAt: "2026-07-26T00:00:00.000Z", completedAt: "2026-07-26T00:03:00.000Z", decisionCount: 3, answer: "must not survive" }],
        ["broken", { startedAt: "not-a-date" }],
      ]),
    ).toEqual([["valid", { startedAt: "2026-07-26T00:00:00.000Z", completedAt: "2026-07-26T00:03:00.000Z", decisionCount: 3 }]])
  })

  test("does not invent a fallback price for an unknown model", () => {
    expect(estimateDeveAgentCost("unknown-provider-model", 1_000_000, 1_000_000, 0, 1_000_000)).toBe(0)
    expect(estimateDeveAgentCost("mimo-v2.5-pro", 1_000_000, 1_000_000, 0, 1_000_000)).toBe(0)
    expect(estimateDeveAgentCost("DEEPSEEK-CHAT", 1_000_000, 0, 0, 1_000_000)).toBeGreaterThan(0)
  })

  test("browser navigation rejects private, credentialed, and reserved targets before fetching", async () => {
    for (const value of ["http://0.0.0.0/", "http://100.64.0.1/", "http://[::ffff:127.0.0.1]/", "https://user:secret@example.com/", "https://sub.localhost/"]) {
      await expect(assertPublicBrowserUrl(value)).rejects.toThrow()
    }
  })

  test("browser navigation allows document-local fixtures but MCP URL validation stays public-only", async () => {
    for (const value of ["about:blank", "about:srcdoc", "data:text/html,<p>fixture</p>", "blob:https://example.com/fixture"]) {
      await expect(assertBrowserNavigationUrl(value)).resolves.toBeInstanceOf(URL)
    }
    await expect(assertPublicBrowserUrl("data:text/html,<p>fixture</p>")).rejects.toThrow("URL must use http or https")
  })

  test("blocks dangerous permission targets across Windows separators and casing", () => {
    expect(isDangerousPermissionTarget("C:\\Repo\\.git\\config")).toBe(true)
    expect(isDangerousPermissionTarget("C:\\Repo\\.ENV")).toBe(true)
    expect(isDangerousPermissionTarget("src\\safe-file.ts")).toBe(false)
  })

  test("sanitizes invalid incoming state", () => {
    const state = normalizeDeveAgentState({
      mode: "oops" as any,
      permissionMode: "root" as any,
      tokenSaver: false,
      selectedSkills: [
        {
          id: "review",
          name: "Review",
          source: "local",
          installed: true,
          enabled: true,
          risk: "unknown" as any,
          desc: "Reads diffs",
        },
        { id: 42, name: "bad" } as any,
      ],
      selectedExpert: { id: "planner", name: "Planner", role: "Plan only" },
    })

    expect(state.mode).toBe("craft")
    expect(state.permissionMode).toBe("default")
    expect(state.tokenSaver).toBe(false)
    expect(state.selectedSkills).toHaveLength(1)
    expect(state.selectedSkills[0]?.risk).toBe("trusted")
    expect(state.selectedExpert?.id).toBe("planner")
    expect(state.expertTeam).toHaveLength(1)
  })

  test("defaults fresh runtime state to unattended approval", () => {
    expect(normalizeDeveAgentState({}).permissionMode).toBe("yolo")
  })

  test("round-trips a composer role with the profile-key bound", () => {
    expect(normalizeDeveAgentState({ role: "reviewer" }).role).toBe("reviewer")
    expect(normalizeDeveAgentState({ role: "Bad Role!" }).role).toBeUndefined()
    expect(normalizeDeveAgentState({ role: "a" + "b".repeat(32) }).role).toBeUndefined()
    const previous = normalizeDeveAgentState({ role: "coder" })
    expect(normalizeDeveAgentState({ mode: "plan" }, previous).role).toBe("coder")
    // The app sends role: null as an explicit clear (JSON.stringify drops
    // undefined keys); null must clear the previous role, not preserve it.
    expect(normalizeDeveAgentState({ role: null as any }, previous).role).toBeUndefined()
  })

  test("auto-approves ordinary permissions while retaining hard safety denials", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-permission-default-"))
    const previous = getDeveAgentState()
    try {
      setDeveAgentState({ mode: "craft", permissionMode: "yolo", selectedSkills: [], selectedExpert: undefined, expertTeam: [] })
      const hooks = await deveagentPlugin.server({ client: {}, directory } as unknown as Parameters<typeof deveagentPlugin.server>[0])
      const ordinary: { status?: string } = {}
      await (hooks as any)["permission.ask"]({ filepath: "src/App.tsx", action: "write", agent: "build" }, ordinary)
      expect(ordinary.status).toBe("allow")

      const dangerous: { status?: string } = {}
      await (hooks as any)["permission.ask"]({ filepath: ".env", action: "read", agent: "build" }, dangerous)
      expect(dangerous.status).toBe("deny")

      setDeveAgentState({ mode: "plan", permissionMode: "yolo" })
      const readonly: { status?: string } = {}
      await (hooks as any)["permission.ask"]({ filepath: "src/App.tsx", action: "write", agent: "build" }, readonly)
      expect(readonly.status).toBe("deny")

      const readonlyComputerUse: { status?: string } = {}
      await (hooks as any)["permission.ask"]({ permission: "computer-use", action: "computer-use", agent: "plan" }, readonlyComputerUse)
      expect(readonlyComputerUse.status).toBe("deny")
    } finally {
      setDeveAgentState(previous)
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("does not let yolo auto-allow workspace-external directory permissions", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-permission-workspace-"))
    const outside = await mkdtemp(path.join(tmpdir(), "deveagent-permission-outside-"))
    const previous = getDeveAgentState()
    try {
      setDeveAgentState({ mode: "craft", permissionMode: "yolo", selectedSkills: [], selectedExpert: undefined, expertTeam: [] })
      const hooks = await deveagentPlugin.server({ client: {}, directory } as unknown as Parameters<typeof deveagentPlugin.server>[0])

      const inside: { status?: string } = {}
      await (hooks as any)["permission.ask"]({
        permission: "external_directory",
        patterns: [path.join(directory, "src", "*")],
        metadata: { filepath: path.join(directory, "src", "new-file.ts"), parentDir: path.join(directory, "src") },
      }, inside)
      expect(inside.status).toBe("allow")

      const external: { status?: string } = {}
      await (hooks as any)["permission.ask"]({
        permission: "external_directory",
        patterns: [path.join(outside, "*")],
        metadata: { filepath: path.join(outside, "new-file.ts"), parentDir: outside },
      }, external)
      expect(external.status).toBe("ask")
    } finally {
      setDeveAgentState(previous)
      await rm(directory, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("uses realpath containment for yolo external_directory symlink escapes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-permission-symlink-workspace-"))
    const outside = await mkdtemp(path.join(tmpdir(), "deveagent-permission-symlink-outside-"))
    const link = path.join(directory, "linked")
    const previous = getDeveAgentState()
    try {
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir")
      setDeveAgentState({ mode: "craft", permissionMode: "yolo", selectedSkills: [], selectedExpert: undefined, expertTeam: [] })
      const hooks = await deveagentPlugin.server({ client: {}, directory } as unknown as Parameters<typeof deveagentPlugin.server>[0])
      const escaped: { status?: string } = {}
      await (hooks as any)["permission.ask"]({
        permission: "external_directory",
        patterns: [path.join(link, "*")],
        metadata: { directories: [link] },
      }, escaped)
      expect(escaped.status).toBe("ask")
    } finally {
      setDeveAgentState(previous)
      await unlink(link).catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("does not treat disabled catalog skills as selected runtime skills", () => {
    const state = normalizeDeveAgentState({
      selectedSkills: [
        { id: "enabled", name: "Enabled", source: "local", installed: true, enabled: true, risk: "trusted" },
        { id: "catalog-only", name: "Catalog only", source: "builtin", installed: true, enabled: false, risk: "trusted" },
      ],
    })

    expect(state.selectedSkills.map((skill) => skill.id)).toEqual(["enabled"])
  })

  test("preserves previous values for partial updates", () => {
    const previous = normalizeDeveAgentState({
      mode: "build",
      permissionMode: "auto",
      tokenSaver: true,
      selectedSkills: [{ id: "token", name: "Token Saver", source: "local", installed: true, enabled: true, risk: "trusted" }],
    })

    const next = normalizeDeveAgentState({ tokenSaver: false }, previous)

    expect(next.mode).toBe("build")
    expect(next.permissionMode).toBe("auto")
    expect(next.selectedSkills[0]?.id).toBe("token")
    expect(next.tokenSaver).toBe(false)
  })

  test("normalizes loop as a real serial runtime mode", () => {
    const state = normalizeDeveAgentState({ mode: "loop", toolExecution: "parallel" })
    expect(state.mode).toBe("loop")
    expect(state.toolExecution).toBe("sequential")
    expect(createDeveAgentRuntimePrompt(state, "loop-mode-test")).toContain("submitted task will create a bounded loop")
  })

  test("preserves selected skills and limits expert team size", () => {
    const state = normalizeDeveAgentState({
      selectedSkills: Array.from({ length: 20 }, (_, index) => ({
        id: `skill-${index}`,
        name: `Skill ${index}`,
        source: "test",
        installed: true,
        enabled: true,
        risk: "trusted",
      })),
      expertTeam: Array.from({ length: 20 }, (_, index) => ({
        id: `expert-${index}`,
        name: `Expert ${index}`,
      })),
    })

    expect(state.selectedSkills).toHaveLength(20)
    expect(state.expertTeam).toHaveLength(9)
  })

  test("rejects oversized selected Skill metadata", () => {
    const selectedSkills = Array.from({ length: 600 }, (_, index) => ({
      id: `skill-${index}`,
      name: `Skill ${index}`,
      source: "local",
      installed: true,
      enabled: true,
      risk: "trusted" as const,
      desc: "x".repeat(500),
    }))

    expect(() => normalizeDeveAgentState({ selectedSkills })).toThrow("exceeds 256 KiB")
  })

  test("includes selected skills in runtime prompt", () => {
    const state = normalizeDeveAgentState({
      mode: "build",
      selectedSkills: [
        {
          id: "code-review",
          name: "Code Review",
          source: "local",
          installed: true,
          enabled: true,
          risk: "trusted",
          desc: "Review diffs before final answer",
        },
      ],
    })

    const prompt = createDeveAgentRuntimePrompt(state)

    expect(prompt).toContain("## Selected Skills")
    expect(prompt).toContain("Code Review")
    expect(prompt).toContain("Review diffs before final answer")
    expect(prompt).toContain("Implementation Guardrails")
  })

  test("prompt optimizer preserves intent and does not invent requirements", () => {
    const state = normalizeDeveAgentState({
      selectedSkills: [
        {
          id: "prompt-optimizer",
          name: "Prompt Optimizer",
          source: "builtin:deveagent/prompt-optimizer",
          installed: true,
          enabled: true,
          risk: "trusted",
        },
      ],
    })

    const prompt = createDeveAgentRuntimePrompt(state)

    expect(prompt).toContain("## Prompt Optimization")
    expect(prompt).toContain("Preserve the user's intent and source text")
    expect(prompt).toContain("Do not add requirements")
    expect(prompt).toContain("Do not expose or repeat the internal task brief")
  })

  test("gates remote skills and MCP exposure in runtime prompt", () => {
    const state = normalizeDeveAgentState({
      remoteSkills: false,
      remoteMcp: false,
      unattendedTimezone: "Asia/Shanghai",
      selectedSkills: [
        {
          id: "remote-market",
          name: "Remote Market",
          source: "github:example/remote",
          installed: true,
          enabled: true,
          risk: "trusted",
        },
        {
          id: "local-helper",
          name: "Local Helper",
          source: "local",
          installed: true,
          enabled: true,
          risk: "trusted",
        },
      ],
    })

    const prompt = createDeveAgentRuntimePrompt(state)

    expect(state.selectedSkills.map((skill) => skill.id)).toEqual(["local-helper"])
    expect(prompt).toContain("remote/orchestrator skills: disabled")
    expect(prompt).toContain("remote/app MCP: disabled")
    expect(prompt).toContain("Do not discover, install, load, or inject remote/orchestrator-owned skills")
    expect(prompt).toContain("Interpret cron, loop, and goal deadlines in Asia/Shanghai")
  })

  test("omits expert prompt after expert is cleared", () => {
    const withExpert = normalizeDeveAgentState({
      selectedExpert: { id: "planner", name: "Planner", role: "Read-only planning" },
    })
    const cleared = normalizeDeveAgentState({ selectedExpert: null as any }, withExpert)
    const prompt = createDeveAgentRuntimePrompt(cleared)

    expect(prompt).not.toContain("## Selected Expert")
    expect(prompt).not.toContain("Planner")
  })

  test("builds a real context pack from workspace files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-context-"))
    await writeFile(path.join(directory, "src.ts"), "export const answer = 42\n")

    const pack = await createDeveAgentContextPack({
      directory,
      files: [{ path: "src.ts", source: "test" }],
    })

    expect(pack.available).toBe(true)
    expect(pack.files).toHaveLength(1)
    expect(pack.files[0]?.path).toBe("src.ts")
    expect(pack.files[0]?.source).toBe("test")
    expect(pack.files[0]?.readable).toBe(true)
    expect(pack.files[0]?.estimatedTokens).toBeGreaterThan(0)
    expect(pack.totalEstimatedTokens).toBe(pack.files[0]?.estimatedTokens)
  })

  test("rejects context pack files outside the workspace", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-context-"))
    const pack = await createDeveAgentContextPack({
      directory,
      files: ["../outside.ts"],
    })

    expect(pack.files[0]?.readable).toBe(false)
    expect(pack.files[0]?.reason).toBe("outside workspace")
  })
})

describe("vision fallback taxonomy", () => {
  test("classifies missing model vs no image capability", () => {
    expect(classifyVisionFallback({ configured: false })).toBe("not_configured")
    expect(classifyVisionFallback({ configured: true, candidate: undefined })).toBe("model_not_found")
    expect(
      classifyVisionFallback({
        configured: true,
        candidate: { capabilities: { input: { image: false } } },
      }),
    ).toBe("no_image_capability")
  })

  test("messages include model ref for configured failures", () => {
    expect(visionFallbackMessage("model_not_found", "openai", "gpt-4o")).toContain("openai/gpt-4o")
    expect(visionFallbackMessage("no_image_capability", "xai", "grok")).toContain("不支持图片")
    expect(visionFallbackMessage("not_configured")).toContain("未配置")
  })
})

describe("session tool queue + toolExecution safety", () => {
  test("before/after pairs and releases sequential lock", async () => {
    const q = createSessionToolQueue()
    const order: string[] = []
    const a = (async () => {
      await q.before("s1")
      order.push("a-start")
      await new Promise((r) => setTimeout(r, 20))
      order.push("a-end")
      q.after("s1")
    })()
    const b = (async () => {
      await q.before("s1")
      order.push("b-start")
      q.after("s1")
    })()
    await Promise.all([a, b])
    expect(order).toEqual(["a-start", "a-end", "b-start"])
    expect(q.pendingCount()).toBe(0)
    expect(q.has("s1")).toBe(false)
  })

  test("different sessions do not share the same lock wait", async () => {
    const q = createSessionToolQueue()
    let s2Started = false
    const s1 = (async () => {
      await q.before("s1")
      await new Promise((r) => setTimeout(r, 30))
      q.after("s1")
    })()
    const s2 = (async () => {
      await q.before("s2")
      s2Started = true
      q.after("s2")
    })()
    await Promise.race([s2, new Promise((r) => setTimeout(r, 10))])
    expect(s2Started).toBe(true)
    await Promise.all([s1, s2])
  })

  test("parallel only allowed in ask/plan", () => {
    expect(resolveEffectiveToolExecution({ toolExecution: "parallel", mode: "ask" })).toBe("parallel")
    expect(resolveEffectiveToolExecution({ toolExecution: "parallel", mode: "plan" })).toBe("parallel")
    expect(resolveEffectiveToolExecution({ toolExecution: "parallel", mode: "craft" })).toBe("sequential")
    expect(resolveEffectiveToolExecution({ toolExecution: "parallel", mode: "build" })).toBe("sequential")
    expect(resolveEffectiveToolExecution({ toolExecution: "parallel", mode: "goal" })).toBe("sequential")
  })

  test("normalize coerces parallel outside ask/plan", () => {
    const state = normalizeDeveAgentState({ mode: "craft", toolExecution: "parallel" })
    expect(state.toolExecution).toBe("sequential")
    const ask = normalizeDeveAgentState({ mode: "ask", toolExecution: "parallel" })
    expect(ask.toolExecution).toBe("parallel")
  })

  test("goal and shell skills declare honesty lines", () => {
    const prompt = createDeveAgentRuntimePrompt(
      normalizeDeveAgentState({
        mode: "goal",
        selectedSkills: [
          { id: "computer-use", name: "Computer Use", source: "x", installed: true, enabled: true, risk: "review" },
          { id: "superpowers", name: "Superpowers", source: "x", installed: true, enabled: true, risk: "review" },
        ],
      }),
    )
    expect(prompt).toContain("no active goal")
    expect(prompt).toContain("computer-use skill: permission-gated browser/desktop host tools")
    expect(prompt).toContain("superpowers skill: structured prompt injection only")
  })
})

describe("skills reach plugin context via runtime prompt", () => {
  test("enabled skills appear in runtime prompt with name/id/source/desc", () => {
    const state = normalizeDeveAgentState({
      selectedSkills: [
        { id: "token-saver", name: "Token Saver", source: "builtin:reasonix/token-saver", installed: true, enabled: true, risk: "trusted", desc: "Context compression" },
        { id: "headroom", name: "Headroom", source: "builtin:opencode/headroom", installed: true, enabled: true, risk: "trusted", desc: "Reserve context budget" },
        { id: "disabled-skill", name: "Disabled", source: "local", installed: true, enabled: false, risk: "trusted", desc: "Should not appear" },
      ],
    })

    const prompt = createDeveAgentRuntimePrompt(state)

    expect(prompt).toContain("## Selected Skills")
    expect(prompt).toContain("Token Saver")
    expect(prompt).toContain("builtin:reasonix/token-saver")
    expect(prompt).toContain("Context compression")
    expect(prompt).toContain("Headroom")
    expect(prompt).toContain("builtin:opencode/headroom")
    expect(prompt).toContain("Reserve context budget")
    expect(prompt).not.toContain("Disabled")
    expect(prompt).not.toContain("Should not appear")
  })

  test("remote skills filtered when remoteSkills=false", () => {
    const state = normalizeDeveAgentState({
      remoteSkills: false,
      selectedSkills: [
        { id: "local-skill", name: "Local Skill", source: "local", installed: true, enabled: true, risk: "trusted", desc: "Local helper" },
        { id: "remote-skill", name: "Remote Skill", source: "github:example/skill", installed: true, enabled: true, risk: "trusted", desc: "Remote helper" },
      ],
    })

    const prompt = createDeveAgentRuntimePrompt(state)

    expect(prompt).toContain("Local Skill")
    expect(prompt).not.toContain("Remote Skill")
    expect(prompt).not.toContain("Remote helper")
    expect(prompt).toContain("Do not discover, install, load, or inject remote/orchestrator-owned skills")
  })

  test("skills with risk=review are included but noted", () => {
    const state = normalizeDeveAgentState({
      selectedSkills: [
        { id: "risky-skill", name: "Risky Skill", source: "local", installed: true, enabled: true, risk: "review", desc: "Needs review" },
      ],
    })

    const prompt = createDeveAgentRuntimePrompt(state)

    expect(prompt).toContain("Risky Skill")
    expect(prompt).toContain("Needs review")
  })

  test("keeps every selected skill in runtime state", () => {
    const skills = Array.from({ length: 15 }, (_, i) => ({
      id: `skill-${i}`,
      name: `Skill ${i}`,
      source: "local",
      installed: true,
      enabled: true,
      risk: "trusted" as const,
      desc: `Skill ${i} desc`,
    }))

    const state = normalizeDeveAgentState({ selectedSkills: skills })

    expect(state.selectedSkills).toHaveLength(15)

    const prompt = createDeveAgentRuntimePrompt(state)

    expect(prompt).toContain("## Selected Skills")
    expect(prompt).toContain("Skill 0")
    expect(prompt).toContain("Skill 14")
  })

  test("disabled skills excluded from runtime prompt", () => {
    const state = normalizeDeveAgentState({
      selectedSkills: [
        { id: "enabled", name: "Enabled Skill", source: "local", installed: true, enabled: true, risk: "trusted", desc: "Active" },
        { id: "disabled", name: "Disabled Skill", source: "local", installed: true, enabled: false, risk: "trusted", desc: "Inactive" },
      ],
    })

    const prompt = createDeveAgentRuntimePrompt(state)

    expect(prompt).toContain("Enabled Skill")
    expect(prompt).toContain("Active")
    expect(prompt).not.toContain("Disabled Skill")
    expect(prompt).not.toContain("Inactive")
  })

  test("expert and skills coexist in runtime prompt", () => {
    const state = normalizeDeveAgentState({
      selectedSkills: [
        { id: "code-review", name: "Code Review", source: "local", installed: true, enabled: true, risk: "trusted", desc: "Review code" },
      ],
      selectedExpert: { id: "planner", name: "Planner", role: "Planning expert" },
    })

    const prompt = createDeveAgentRuntimePrompt(state)

    expect(prompt).toContain("## Selected Skills")
    expect(prompt).toContain("Code Review")
    expect(prompt).toContain("## Selected Expert")
    expect(prompt).toContain("Planner")
    expect(prompt).toContain("Planning expert")
  })
})

describe("goal mode state machine", () => {
  test("setGoal rejects degenerate goals and normalizes input (review hardening)", () => {
    const sessionID = "goal-set-validation"
    clearGoal(sessionID)
    try {
      expect(() => setGoal({ sessionID, description: "   ", criteria: ["A"] })).toThrow("Goal description is required")
      expect(() => setGoal({ sessionID, description: "", criteria: ["A"] })).toThrow("Goal description is required")
      expect(() => setGoal({ sessionID, description: "Valid", criteria: [] })).toThrow("At least one acceptance criterion is required")
      expect(() => setGoal({ sessionID, description: "Valid", criteria: ["  ", ""] })).toThrow("At least one acceptance criterion is required")
      const goal = setGoal({ sessionID, description: "  Trimmed goal  ", criteria: ["  Alpha  ", "", "Beta"] })
      expect(goal.description).toBe("Trimmed goal")
      expect(goal.criteria).toEqual(["Alpha", "Beta"])
    } finally {
      clearGoal(sessionID)
    }
  })

  test("requires an explicit confirmation before a Goal draft can enter the queue", () => {
    const sessionID = "goal-confirmation"
    clearGoal(sessionID)
    clearGoalDraft(sessionID)

    expect(prepareGoal({ sessionID, description: "Ship the verified fix" })).toMatchObject({ active: true, description: "Ship the verified fix" })
    expect(getGoal(sessionID).active).toBe(false)
    expect(getGoalDraft(sessionID)).toMatchObject({ active: true, description: "Ship the verified fix" })

    const active = confirmGoal({ sessionID, criteria: ["Focused tests pass"] })
    expect(active).toMatchObject({ active: true, description: "Ship the verified fix", criteria: ["Focused tests pass"] })
    expect(getGoalDraft(sessionID).active).toBe(false)
    clearGoal(sessionID)
  })

  test("keeps the Goal workspace when confirmation omits a second directory lookup", async () => {
    const sessionID = "goal-directory-binding"
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-goal-directory-"))
    clearGoal(sessionID)
    clearGoalDraft(sessionID)
    try {
      prepareGoal({ sessionID, directory, description: "Keep this project isolated" })
      const active = confirmGoal({ sessionID, criteria: ["The goal stays in this workspace"] })
      expect(active.directory).toBe(path.resolve(directory))
    } finally {
      clearGoal(sessionID)
      clearGoalDraft(sessionID)
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("draft Goal context permits planning only until confirmation", async () => {
    const sessionID = "goal-draft-prompt"
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-goal-draft-"))
    clearGoal(sessionID)
    clearGoalDraft(sessionID)
    prepareGoal({ sessionID, description: "Add a verified project navigator" })
    setDeveAgentState({ mode: "goal", selectedSkills: [], selectedExpert: undefined, expertTeam: [] })
    try {
      const hooks = await deveagentPlugin.server({ client: {}, directory } as unknown as Parameters<typeof deveagentPlugin.server>[0])
      const parts: any[] = [{ type: "text", text: "Implement the navigation." }]
      await (hooks as any)["chat.message"]({ sessionID }, { message: {}, parts })
      const snapshot = parts.at(-1).text
      expect(snapshot).toContain("## Goal Plan Awaiting User Confirmation")
      expect(snapshot).toContain("Do not write files, call goal-set")
      expect(getGoal(sessionID).active).toBe(false)
    } finally {
      clearGoalDraft(sessionID)
      setDeveAgentState({ mode: "craft" })
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("setGoal activates goal with criteria", () => {
    const goal = setGoal({ description: "Fix auth bug", criteria: ["Tests pass", "No regressions"] })
    expect(goal.active).toBe(true)
    expect(goal.status).toBe("in_progress")
    expect(goal.description).toBe("Fix auth bug")
    expect(goal.criteria).toEqual(["Tests pass", "No regressions"])
  })

  test("getGoal returns copy of current state", () => {
    setGoal({ description: "Test", criteria: ["A"] })
    const g = getGoal()
    expect(g.active).toBe(true)
    expect(g.description).toBe("Test")
  })

  test("verifyGoal marks goal as verified", () => {
    setGoal({ description: "Test", criteria: ["A"] })
    const g = verifyGoal({ met: true })
    expect(g.status).toBe("verified")
    expect(g.verifiedAt).toBeDefined()
  })

  test("verifyGoal keeps in_progress when not met", () => {
    setGoal({ description: "Test", criteria: ["A"] })
    const g = verifyGoal({ met: false })
    expect(g.status).toBe("in_progress")
    expect(g.verifiedAt).toBeUndefined()
  })

  test("clearGoal resets state", () => {
    setGoal({ description: "Test", criteria: ["A"] })
    clearGoal()
    const g = getGoal()
    expect(g.active).toBe(false)
    expect(g.description).toBe("")
    expect(g.criteria).toEqual([])
    expect(g.status).toBe("pending")
  })

  test("goal honesty line shows active goal", () => {
    setGoal({ description: "Fix login", criteria: ["Auth works"] })
    const prompt = createDeveAgentRuntimePrompt(normalizeDeveAgentState({ mode: "goal" }))
    expect(prompt).toContain("active — Fix login")
    expect(prompt).toContain("in_progress")
    clearGoal()
  })

  test("goal honesty line shows no active goal", () => {
    clearGoal()
    const prompt = createDeveAgentRuntimePrompt(normalizeDeveAgentState({ mode: "goal" }))
    expect(prompt).toContain("no active goal")
  })
})

describe("CodeGraph ranked context", () => {
  test("registered CodeGraph tools build and activate real session context", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-codegraph-tools-"))
    const sessionID = "codegraph-tool-session"
    await mkdir(path.join(directory, "src"))
    await writeFile(path.join(directory, "src", "auth.ts"), "import { verifyHelper } from './auth-helper'\nexport function verifyLogin() { return verifyHelper() }\n")
    await writeFile(path.join(directory, "src", "auth-helper.ts"), "export function verifyHelper() { return true }\n")
    try {
      const hooks = await deveagentPlugin.server({ client: {}, directory } as unknown as Parameters<typeof deveagentPlugin.server>[0])
      const context = { sessionID } as unknown as ToolContext
      const output = await hooks.tool!["codegraph-context-pack"].execute({ task: "fix auth login" }, context)
      const pack = JSON.parse(output as string) as { runtimeInjected: boolean; files: Array<{ path: string }>; totalEstimatedTokens: number }
      expect(pack.runtimeInjected).toBe(true)
      expect(pack.totalEstimatedTokens).toBeGreaterThan(0)
      expect(pack.files.map((file) => file.path)).toContain("src/auth.ts")
      expect(projectDeveAgentSessionContextPack(sessionID)).toContain("src/auth.ts")

      const scopeOutput = await hooks.tool!["codegraph-review-scope"].execute({ changedFiles: ["src/auth.ts"] }, context)
      const scope = JSON.parse(scopeOutput as string) as { available: boolean; files: Array<{ relatedFiles: Array<{ path: string }> }> }
      expect(scope.available).toBe(true)
      expect(scope.files[0]?.relatedFiles.map((file) => file.path)).toContain("src/auth-helper.ts")
    } finally {
      setDeveAgentSessionContextPack(sessionID, undefined)
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("creates a review scope from changed files and returns ranked related files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-review-scope-"))
    await mkdir(path.join(directory, "src"))
    await writeFile(path.join(directory, "src", "auth.ts"), "import { verifyHelper } from './auth-helper'\nexport function verifyLogin() { return verifyHelper() }\n")
    await writeFile(path.join(directory, "src", "auth-helper.ts"), "export function verifyHelper() { return true }\n")
    await writeFile(path.join(directory, "src", "auth-test.ts"), "export const verifyLoginTest = true\n")
    try {
      const scope = await createReviewScope({ directory, changedFiles: ["src/auth.ts"] })
      expect(scope.available).toBe(true)
      expect(scope.files[0]?.symbols.map((symbol) => symbol.name)).toContain("verifyLogin")
      expect(scope.files[0]?.relatedFiles.map((file) => file.path)).toContain("src/auth-helper.ts")
      expect(scope.files[0]?.relatedFiles.map((file) => file.path)).toContain("src/auth-test.ts")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("review scope refuses paths outside the workspace", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-review-boundary-"))
    try {
      const scope = await createReviewScope({ directory, changedFiles: [path.join(tmpdir(), "outside.ts")] })
      expect(scope.available).toBe(false)
      expect(scope.warnings.join("\n")).toContain("outside workspace")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("goal verification records only explicit completion metadata in workspace Memory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-goal-memory-"))
    const sessionID = "goal-memory"
    try {
      const hooks = await deveagentPlugin.server({ client: {}, directory } as unknown as Parameters<typeof deveagentPlugin.server>[0])
      setGoal({ sessionID, description: "Ship the focused fix", criteria: ["tests pass"] })
      const output = await hooks.tool!["goal-verify"].execute(
        { met: true, reason: "Focused tests passed." },
        { sessionID } as unknown as ToolContext,
      )
      const result = JSON.parse(output as string) as { status: string }
      expect(result.status).toBe("verified")
      const decisions = (await getDeveAgentMemoryTree({ directory })).groups.find((group) => group.kind === "decision")?.entries ?? []
      expect(decisions[0]?.summary).toContain("Focused tests passed.")
      expect(decisions[0]?.summary).toContain("tests pass")
    } finally {
      clearGoal(sessionID)
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("ranks files by keyword relevance", () => {
    const files = [
      "src/auth/login.ts",
      "src/utils/helpers.ts",
      "src/auth/session.ts",
      "README.md",
      "src/components/Button.tsx",
    ]
    const ranked = rankFiles(files, "fix login authentication bug")
    expect(ranked[0].path).toBe("src/auth/login.ts")
    expect(ranked[0].score).toBeGreaterThan(ranked[2].score)
  })

  test("returns all files when no keywords match", () => {
    const files = ["a.ts", "b.ts", "c.ts"]
    const ranked = rankFiles(files, "!!!")
    expect(ranked).toHaveLength(3)
  })

  test("respects limit parameter", () => {
    const files = Array.from({ length: 50 }, (_, i) => `src/file${i}.ts`)
    const ranked = rankFiles(files, "test", 5)
    expect(ranked).toHaveLength(5)
  })

  test("bonuses src/lib files", () => {
    const files = ["config.json", "src/main.ts"]
    const ranked = rankFiles(files, "main")
    expect(ranked[0].path).toBe("src/main.ts")
  })
})

describe("multi-agent team dispatch", () => {
  test("dispatchTeamMember returns member with system prompt", () => {
    setDeveAgentTeam({
      members: [
        { id: "planner-1", name: "Planner", role: "planner", providerID: "deepseek", modelID: "deepseek-chat", systemPrompt: "You plan.", enabled: true },
        { id: "executor-1", name: "Executor", role: "executor", providerID: "openai", modelID: "gpt-4o", enabled: true },
      ],
    })
    const result = dispatchTeamMember({ memberID: "planner-1", task: "Plan auth" })
    expect(result.member).toBeDefined()
    expect(result.member?.name).toBe("Planner")
    expect(result.systemPrompt).toContain("You plan.")
    expect(result.systemPrompt).toContain("team member")
    expect(result.task).toBe("Plan auth")
  })

  test("dispatchTeamMember returns empty for missing member", () => {
    const result = dispatchTeamMember({ memberID: "nonexistent", task: "Test" })
    expect(result.member).toBeUndefined()
    expect(result.systemPrompt).toBe("")
  })

  test("getTeamMemberByRole finds correct member", () => {
    setDeveAgentTeam({
      members: [
        { id: "p1", name: "Planner", role: "planner", providerID: "x", modelID: "y", enabled: true },
        { id: "e1", name: "Executor", role: "executor", providerID: "x", modelID: "y", enabled: true },
      ],
    })
    expect(getTeamMemberByRole("planner")?.id).toBe("p1")
    expect(getTeamMemberByRole("executor")?.id).toBe("e1")
    expect(getTeamMemberByRole("reviewer")).toBeUndefined()
  })

  test("team members inject into runtime prompt", () => {
    setDeveAgentTeam({
      members: [
        { id: "p1", name: "Planner", role: "planner", providerID: "deepseek", modelID: "deepseek-chat", enabled: true },
      ],
      runMode: "sequential",
      maxRounds: 3,
      budgetTokens: 100000,
    })
    const prompt = createDeveAgentRuntimePrompt(normalizeDeveAgentState({}))
    expect(prompt).toContain("## Multi-Agent Team")
    expect(prompt).toContain("Planner")
    expect(prompt).toContain("sequential")
    expect(prompt).toContain("3")
  })

  test("projects a bounded session CodeGraph pack for the selected runtime skill", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-context-project-"))
    await writeFile(path.join(directory, "src.ts"), "export const answer = 42\n")
    try {
      const pack = await createDeveAgentContextPack({ directory, files: [{ path: "src.ts", source: "context" }] })
      setDeveAgentSessionContextPack("context_projection", pack)
      const projection = projectDeveAgentSessionContextPack("context_projection")
      expect(projection).toContain("Active CodeGraph Context Pack")
      expect(projection).toContain("src.ts")
      const state = normalizeDeveAgentState({
        selectedSkills: [{ id: "codegraph-context", name: "CodeGraph Context", source: "builtin", installed: true, enabled: true, risk: "trusted" }],
      })
      expect(createDeveAgentRuntimePrompt(state, "context_projection")).toContain("src.ts")
      setDeveAgentSessionContextPack("context_projection", undefined)
      expect(projectDeveAgentSessionContextPack("context_projection")).toBe("")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("team switch is isolated per session", () => {
    setDeveAgentTeam({ enabled: false, members: [] })
    setDeveAgentTeam({
      sessionID: "session-a",
      enabled: true,
      members: [{ id: "a", name: "A", role: "planner", providerID: "x", modelID: "y", enabled: true }],
    })
    expect(getDeveAgentTeam("session-a").enabled).toBe(true)
    expect(getDeveAgentTeam("session-b").enabled).toBe(false)
    expect(createDeveAgentRuntimePrompt(normalizeDeveAgentState({}), "session-a")).toContain("## Multi-Agent Team")
    expect(createDeveAgentRuntimePrompt(normalizeDeveAgentState({}), "session-b")).not.toContain("## Multi-Agent Team")
  })

  test("restores validated session team overrides after restart", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-team-store-"))
    const previous = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = directory
    try {
      setDeveAgentTeam({ enabled: false, members: [] })
      setDeveAgentTeam({
        sessionID: "session-persisted",
        enabled: true,
        members: [{ id: "reviewer", name: "Reviewer", role: "reviewer", providerID: "test", modelID: "test-model", enabled: true }],
      })
      await waitForTeamStateFlush()
      const store = path.join(directory, "opencode", "deveagent-team.json")
      const persisted = await readFile(store, "utf8")
      setDeveAgentTeam({ sessionID: "session-persisted", enabled: false, members: [] })
      await waitForTeamStateFlush()
      await writeFile(store, persisted)
      loadDeveAgentTeamState()
      expect(getDeveAgentTeam("session-persisted")).toMatchObject({ enabled: true, members: [{ id: "reviewer" }] })
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe("browser + vision + debate + superpowers runtime", () => {
  test("dispatchTeamAll returns all enabled members", () => {
    setDeveAgentTeam({
      members: [
        { id: "p1", name: "Planner", role: "planner", providerID: "x", modelID: "y", enabled: true },
        { id: "e1", name: "Executor", role: "executor", providerID: "x", modelID: "y", enabled: true },
        { id: "d1", name: "Disabled", role: "critic", providerID: "x", modelID: "y", enabled: false },
      ],
      runMode: "sequential",
      maxRounds: 3,
      budgetTokens: 100000,
    })
    const result = dispatchTeamAll({ task: "Build auth" })
    expect(result.members).toHaveLength(2)
    expect(result.runMode).toBe("sequential")
    expect(result.debatePrompt).toBeUndefined()
  })

  test("dispatchTeamAll debate mode includes debate prompt", () => {
    setDeveAgentTeam({
      members: [
        { id: "p1", name: "Planner", role: "planner", providerID: "x", modelID: "y", enabled: true },
        { id: "c1", name: "Critic", role: "critic", providerID: "x", modelID: "y", enabled: true },
      ],
      runMode: "debate",
      maxRounds: 3,
      budgetTokens: 100000,
    })
    const result = dispatchTeamAll({ task: "Should we use REST or GraphQL?" })
    expect(result.runMode).toBe("debate")
    expect(result.debatePrompt).toContain("Debate Mode")
    expect(result.debatePrompt).toContain("Planner")
    expect(result.debatePrompt).toContain("Critic")
  })

  test("superpowers prompt includes active skills", () => {
    const prompt = getSuperpowersPrompt(["debugging", "tdd"])
    expect(prompt).toContain("Superpowers Active")
    expect(prompt).toContain("Debugging")
    expect(prompt).toContain("TDD")
    expect(prompt).not.toContain("Code Review")
  })

  test("only the configured Executor receives a write-capable native task", () => {
    const executor = { id: "e1", name: "Executor", role: "executor" as const, providerID: "x", modelID: "y", enabled: true }
    const planner = { id: "p1", name: "Planner", role: "planner" as const, providerID: "x", modelID: "y", enabled: true }
    const writeTask = buildTeamTaskInput(executor, "Implement carefully.", "Fix auth", false)
    const advisorTask = buildTeamTaskInput(planner, "Plan carefully.", "Fix auth", true)
    expect(writeTask.read_only).toBe(false)
    expect(writeTask.prompt).toContain("sole write-capable Executor")
    expect(advisorTask.read_only).toBe(true)
    expect(advisorTask.prompt).toContain("advisor")
    expect("max_tokens" in writeTask).toBe(false)
    expect(buildTeamTaskInput(planner, "Plan carefully.", "Fix auth", true, 45_000, false, undefined, 8_000).max_output_tokens).toBe(8_000)
    expect(buildTeamTaskInput(planner, "Plan carefully.", "Fix auth", true, 45_000, false, undefined, 999_999).max_output_tokens).toBe(128_000)
    expect(buildTeamTaskInput(planner, "Plan carefully.", "Fix auth", true, 45_000).timeout_ms).toBe(45_000)
    expect(buildTeamTaskInput(planner, "Plan carefully.", "Fix auth", true, 999_999).timeout_ms).toBe(600_000)
    expect(buildTeamTaskInput(planner, "Plan carefully.", "Fix auth", true, 45_000, false, "ses_resume_1").task_id).toBe("ses_resume_1")
    expect(buildTeamTaskInput(planner, "Plan carefully.", "Fix auth", true, 45_000, false, "../../escape").task_id).toBeUndefined()
  })

  test("keeps goals isolated by session", () => {
    setGoal({ sessionID: "ses_one", description: "First", criteria: ["A"] })
    setGoal({ sessionID: "ses_two", description: "Second", criteria: ["B"] })
    expect(getGoal("ses_one").description).toBe("First")
    expect(getGoal("ses_two").description).toBe("Second")
    clearGoal("ses_one")
    expect(getGoal("ses_one").active).toBe(false)
    expect(getGoal("ses_two").active).toBe(true)
    clearGoal("ses_two")
  })

  test("goal queue exposes only persisted in-progress goals", () => {
    setGoal({ sessionID: "queue_active", description: "Resume me", criteria: ["A"] })
    setGoal({ sessionID: "queue_done", description: "Already done", criteria: ["B"] })
    verifyGoal({ sessionID: "queue_done", met: true })
    const queue = getGoalQueue()
    expect(queue.map((item) => item.sessionID)).toContain("queue_active")
    expect(queue.map((item) => item.sessionID)).not.toContain("queue_done")
    expect(queue.find((item) => item.sessionID === "queue_active")?.ready).toBe(true)
    clearGoal("queue_active")
    clearGoal("queue_done")
  })

  test("goal re-entry budget is shared by session and worker paths", () => {
    setGoal({ sessionID: "goal_budget", description: "Bounded", criteria: ["A"], maxReentries: 1 })
    expect(reserveGoalReentry("goal_budget")).toBe(true)
    expect(reserveGoalReentry("goal_budget")).toBe(false)
    expect(getGoal("goal_budget")).toMatchObject({ status: "failed", stopReason: "Goal re-entry budget exhausted." })
    clearGoal("goal_budget")
  })

  test("superpowers selector expands to the supported disk skill names", () => {
    const prompt = getSuperpowersPrompt(["superpowers"])
    expect(prompt).toContain("Debugging")
    expect(prompt).toContain("Planning")
    expect(prompt).toContain("TDD")
  })

  test("grill-me enforces one decision question before implementation", () => {
    const prompt = getSuperpowersPrompt(["grill-me"])
    expect(prompt).toContain("Grilling Me")
    expect(prompt).toContain("exactly one unresolved decision question")
    expect(prompt).toContain("Do not edit files or begin implementation")
  })

  test("selected grill-me reaches the async runtime prompt path", async () => {
    const state = normalizeDeveAgentState({
      selectedSkills: [{ id: "grill-me", name: "Grilling Me", source: "builtin", installed: true, enabled: true, risk: "trusted" }],
    })
    expect(createDeveAgentRuntimePrompt(state)).toContain("Grilling Me")
    const prompt = await getSuperpowersPromptAsync(state.selectedSkills.filter((skill) => skill.enabled).map((skill) => skill.id))
    expect(prompt).toContain("exactly one unresolved decision question")
  })

  test("grill-me blocks mutating permissions until the Skill is removed", () => {
    const grilling = normalizeDeveAgentState({
      selectedSkills: [{ id: "grill-me", name: "Grilling Me", source: "builtin", installed: true, enabled: true, risk: "trusted" }],
    })
    expect(isGrillingWriteBlocked(grilling, "write")).toBe(true)
    expect(isGrillingWriteBlocked(grilling, "bash")).toBe(true)
    expect(isGrillingWriteBlocked(grilling, "read")).toBe(false)
    expect(isGrillingWriteBlocked({ ...grilling, selectedSkills: [] }, "write")).toBe(false)
  })

  test("grill-me keeps explicitly confirmed decisions isolated by session", () => {
    clearGrillingDecisions("grill-a")
    clearGrillingDecisions("grill-b")
    expect(recordGrillingDecision({ sessionID: "grill-a", question: "Use a queue?", answer: "Yes", recommendation: "Use the existing worker." })).toEqual({ recorded: true, count: 1 })
    expect(getGrillingDecisions("grill-a")).toHaveLength(1)
    expect(getGrillingDecisions("grill-b")).toHaveLength(0)
    const state = normalizeDeveAgentState({
      selectedSkills: [{ id: "grill-me", name: "Grilling Me", source: "builtin", installed: true, enabled: true, risk: "trusted" }],
    })
    expect(createDeveAgentRuntimePrompt(state, "grill-a")).toContain("Confirmed Grilling Decisions")
    expect(createDeveAgentRuntimePrompt(state, "grill-a")).toContain("Use a queue?")
    expect(createDeveAgentRuntimePrompt(state, "grill-b")).not.toContain("Confirmed Grilling Decisions")
    clearGrillingDecisions("grill-a")
  })

  test("grill-me exports only confirmed session decisions inside the workspace", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-grill-export-"))
    try {
      clearGrillingDecisions("grill-export")
      recordGrillingDecision({ sessionID: "grill-export", question: "Ship now?", answer: "After tests pass." })
      const result = await exportGrillingDecisions({ directory, sessionID: "grill-export", filePath: "docs/decisions.md" })
      expect(result).toEqual({ exported: true, path: "docs/decisions.md", decisionCount: 1 })
      expect(await readFile(path.join(directory, "docs", "decisions.md"), "utf8")).toContain("After tests pass.")
      expect((await exportGrillingDecisions({ directory, sessionID: "grill-export", filePath: "../outside.md" })).exported).toBe(false)
      clearGrillingDecisions("grill-export")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("exports an explicit workspace Markdown copy for Obsidian without allowing traversal", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-obsidian-export-"))
    try {
      await mkdir(path.join(directory, "memory"), { recursive: true })
      await writeFile(path.join(directory, "memory", "note.md"), "# Real note\n", "utf8")
      const result = await exportWorkspaceMarkdownForObsidian({ directory, sourcePath: "memory/note.md" })
      expect(result).toEqual({ exported: true, path: ".deveagent/obsidian/memory--note.md", source: "memory/note.md" })
      expect(await readFile(path.join(directory, ".deveagent", "obsidian", "memory--note.md"), "utf8")).toBe("# Real note\n")
      expect((await exportWorkspaceMarkdownForObsidian({ directory, sourcePath: "../outside.md" })).exported).toBe(false)
      expect((await exportWorkspaceMarkdownForObsidian({ directory, sourcePath: "memory/note.txt" })).exported).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("superpowers prompt empty when no matching skills", () => {
    const prompt = getSuperpowersPrompt(["token-saver", "headroom"])
    expect(prompt).toBe("")
  })

  test("goal autonomous loop honesty line shows when in_progress", () => {
    setGoal({ description: "Fix bug", criteria: ["Tests pass"] })
    const prompt = createDeveAgentRuntimePrompt(normalizeDeveAgentState({ mode: "goal" }))
    expect(prompt).toContain("active — Fix bug")
    expect(prompt).toContain("in_progress")
    clearGoal()
  })

  test("computer-use honesty line shows tool registration", () => {
    const prompt = createDeveAgentRuntimePrompt(
      normalizeDeveAgentState({
        selectedSkills: [
          { id: "computer-use", name: "Computer Use", source: "x", installed: true, enabled: true, risk: "review" },
        ],
      }),
    )
    expect(prompt).toContain("permission-gated browser/desktop host tools")
  })

  test("superpowers honesty line shows structured prompt", () => {
    const prompt = createDeveAgentRuntimePrompt(
      normalizeDeveAgentState({
        selectedSkills: [
          { id: "superpowers", name: "Superpowers", source: "x", installed: true, enabled: true, risk: "review" },
        ],
      }),
    )
    expect(prompt).toContain("structured prompt injection only")
  })
})

describe("persistent remote skill install", () => {
  test("normalizes concrete GitHub Markdown blobs and rejects page links", () => {
    expect(normalizeRemoteSkillUrl("https://github.com/acme/skills/blob/main/example/SKILL.md").url?.toString()).toBe("https://raw.githubusercontent.com/acme/skills/main/example/SKILL.md")
    expect(normalizeRemoteSkillUrl("https://github.com/acme/skills").error).toContain("specific Markdown blob")
    expect(normalizeRemoteSkillUrl("https://raw.githubusercontent.com/acme/skills/main/example/readme.txt").error).toContain("Markdown")
  })

  test("accepts only SkillHub's concrete SKILL.md file endpoint", () => {
    expect(normalizeRemoteSkillUrl("https://api.skillhub.cn/api/v1/skills/browser-auto/file?path=SKILL.md").url?.toString()).toBe("https://api.skillhub.cn/api/v1/skills/browser-auto/file?path=SKILL.md")
    expect(normalizeRemoteSkillUrl("https://api.skillhub.cn/api/v1/skills/browser-auto").error).toContain("SKILL.md file endpoint")
  })

  test("accepts only ClawHub's concrete SKILL.md file endpoint", () => {
    expect(normalizeRemoteSkillUrl("https://clawhub.ai/api/v1/skills/gifgrep/file?path=SKILL.md").url?.toString()).toBe("https://clawhub.ai/api/v1/skills/gifgrep/file?path=SKILL.md")
    expect(normalizeRemoteSkillUrl("https://clawhub.ai/api/v1/skills/gifgrep").error).toContain("SKILL.md file endpoint")
  })

  test("rejects non-approved remote URLs before fetching", async () => {
    const result = await installRemoteSkill({ url: "http://127.0.0.1:8080/SKILL.md", id: "../../escape" })
    expect(result.error).toContain("approved marketplace host")
    expect(result.savedPath).toBe("")
  })

  test("rejects remote Skill credentials and non-standard ports", () => {
    expect(normalizeRemoteSkillUrl("https://user:pass@raw.githubusercontent.com/acme/skills/main/SKILL.md").error).toContain("credentials")
    expect(normalizeRemoteSkillUrl("https://raw.githubusercontent.com:8443/acme/skills/main/SKILL.md").error).toContain("non-standard port")
  })

  test("installRemoteSkill fetches and saves to disk", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response("name: Test Remote Skill\n\nUse this for test coverage.", { status: 200 })) as unknown as typeof fetch
    try {
      const result = await installRemoteSkill({
        url: "https://raw.githubusercontent.com/anthropics/anthropic-cookbook/main/README.md",
        id: "test-anthropic-readme",
      })
      expect(result.id).toBe("test-anthropic-readme")
      expect(result.error).toBeUndefined()
      expect(result.savedPath).toContain("test-anthropic-readme.md")
      expect(await readFile(result.savedPath, "utf8")).toContain("Test Remote Skill")
    } finally {
      await removeRemoteSkill("test-anthropic-readme")
      globalThis.fetch = originalFetch
    }
  })

  test("loadRemoteSkills returns installed skills", async () => {
    const skills = await loadRemoteSkills()
    expect(Array.isArray(skills)).toBe(true)
    // May be empty if no skills installed yet
  })

  test("scopes remote Skill install, load, and removal to the workspace", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "deveagent-workspace-skill-"))
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response("name: Workspace Skill\n\nUse the workspace copy.", { status: 200 })) as unknown as typeof fetch
    try {
      const installed = await installRemoteSkill({
        url: "https://raw.githubusercontent.com/anthropics/anthropic-cookbook/main/README.md",
        id: "workspace-scope-test",
        directory: workspace,
      })
      expect(installed.error).toBeUndefined()
      expect(installed.savedPath).toBe(path.join(workspace, ".deveagent", "skills", "remote", "workspace-scope-test.md"))
      expect(await readFile(installed.savedPath, "utf8")).toContain("Workspace Skill")

      const loaded = await loadRemoteSkills(workspace)
      expect(loaded.find((skill) => skill.id === "workspace-scope-test")?.prompt).toContain("workspace copy")

      expect((await removeRemoteSkill("workspace-scope-test", workspace)).removed).toBe(true)
      expect((await loadRemoteSkills(workspace)).find((skill) => skill.id === "workspace-scope-test")).toBeUndefined()
    } finally {
      await rm(workspace, { recursive: true, force: true })
      globalThis.fetch = originalFetch
    }
  })

  test("rejects workspace remote Skill storage through a symlink", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "deveagent-workspace-skill-link-"))
    const outside = await mkdtemp(path.join(tmpdir(), "deveagent-workspace-skill-outside-"))
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response("name: Escaped Skill\n", { status: 200 })) as unknown as typeof fetch
    const remoteDirectory = path.join(workspace, ".deveagent", "skills", "remote")
    const outsideDirectory = path.join(outside, "remote")
    try {
      await mkdir(path.dirname(remoteDirectory), { recursive: true })
      await mkdir(outsideDirectory, { recursive: true })
      const linked = await symlink(outsideDirectory, remoteDirectory, process.platform === "win32" ? "junction" : "dir")
        .then(() => true)
        .catch(() => false)
      if (!linked) return

      const result = await installRemoteSkill({
        url: "https://raw.githubusercontent.com/anthropics/anthropic-cookbook/main/README.md",
        id: "symlinked-storage",
        directory: workspace,
      })
      expect(result.savedPath).toBe("")
      expect(result.error).toContain("must not contain a symlink")
      expect(await readdir(outsideDirectory)).toEqual([])
    } finally {
      globalThis.fetch = originalFetch
      await rm(workspace, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("does not load symlinked remote Skill files", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "deveagent-workspace-skill-file-link-"))
    const outside = await mkdtemp(path.join(tmpdir(), "deveagent-workspace-skill-file-outside-"))
    const remoteDirectory = path.join(workspace, ".deveagent", "skills", "remote")
    try {
      await mkdir(remoteDirectory, { recursive: true })
      const outsideFile = path.join(outside, "outside.md")
      await writeFile(outsideFile, "name: Outside Skill\n\nSHOULD_NOT_LOAD")
      const linked = await symlink(outsideFile, path.join(remoteDirectory, "linked.md"), "file")
        .then(() => true)
        .catch(() => false)
      if (!linked) return
      const loaded = await loadRemoteSkills(workspace)
      expect(loaded.find((skill) => skill.id === "linked")).toBeUndefined()
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("injects a selected workspace remote Skill into the real system hook", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "deveagent-workspace-skill-runtime-"))
    const skillDirectory = path.join(workspace, ".deveagent", "skills", "remote")
    try {
      await mkdir(skillDirectory, { recursive: true })
      await writeFile(
        path.join(skillDirectory, "workspace-runtime.md"),
        "name: Workspace Runtime Skill\n\nWORKSPACE_REMOTE_SKILL_BODY",
      )
      setDeveAgentState({
        remoteSkills: true,
        selectedSkills: [
          {
            id: "workspace-runtime",
            name: "Workspace Runtime Skill",
            source: "remote:workspace-runtime",
            installed: true,
            enabled: true,
            risk: "review",
          },
        ],
      })
      const hooks = await deveagentPlugin.server({ client: {}, directory: workspace } as unknown as Parameters<typeof deveagentPlugin.server>[0])
      const parts: any[] = [{ type: "text", text: "Use the workspace runtime skill for this task." }]
      await (hooks as any)["chat.message"]({ sessionID: "workspace-runtime-session" }, { message: {}, parts })
      expect(parts.at(-1).text).toContain("WORKSPACE_REMOTE_SKILL_BODY")
    } finally {
      setDeveAgentState({ selectedSkills: [] })
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test("removeRemoteSkill removes from disk", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response("name: Remove Test\n", { status: 200 })) as unknown as typeof fetch
    try {
      const installed = await installRemoteSkill({
        url: "https://raw.githubusercontent.com/anthropics/anthropic-cookbook/main/README.md",
        id: "test-remove-skill",
      })
      expect(installed.error).toBeUndefined()
      const removed = await removeRemoteSkill("test-remove-skill")
      expect(removed.removed).toBe(true)
      const skills = await loadRemoteSkills()
      expect(skills.find(s => s.id === "test-remove-skill")).toBeUndefined()
    } finally {
      await removeRemoteSkill("test-remove-skill")
      globalThis.fetch = originalFetch
    }
  })
})

describe("symbol extraction", () => {
  test("extracts TypeScript functions and classes", () => {
    const code = `export function hello() {}
class Foo {}
export interface Bar {}
type Baz = string
const x = 42`
    const symbols = extractSymbols(code)
    expect(symbols.find(s => s.name === "hello")?.kind).toBe("function")
    expect(symbols.find(s => s.name === "Foo")?.kind).toBe("class")
    expect(symbols.find(s => s.name === "Bar")?.kind).toBe("interface")
    expect(symbols.find(s => s.name === "Baz")?.kind).toBe("type")
    expect(symbols.find(s => s.name === "x")?.kind).toBe("const")
  })

  test("extracts Python functions and classes", () => {
    const code = `def hello():
    pass
class Foo:
    pass`
    const symbols = extractSymbols(code)
    expect(symbols.find(s => s.name === "hello")?.kind).toBe("function")
    expect(symbols.find(s => s.name === "Foo")?.kind).toBe("class")
  })

  test("extracts Rust functions and structs", () => {
    const code = `pub fn hello() {}
pub struct Foo {}
pub enum Bar {}
pub trait Baz {}`
    const symbols = extractSymbols(code)
    expect(symbols.find(s => s.name === "hello")?.kind).toBe("function")
    expect(symbols.find(s => s.name === "Foo")?.kind).toBe("struct")
    expect(symbols.find(s => s.name === "Bar")?.kind).toBe("enum")
    expect(symbols.find(s => s.name === "Baz")?.kind).toBe("trait")
  })

  test("extractSymbolsFromFiles processes multiple files", () => {
    const files = [
      { path: "a.ts", content: "export function a() {}" },
      { path: "b.py", content: "def b(): pass" },
    ]
    const result = extractSymbolsFromFiles(files)
    expect(result).toHaveLength(2)
    expect(result[0].symbols.find(s => s.name === "a")?.kind).toBe("function")
    expect(result[1].symbols.find(s => s.name === "b")?.kind).toBe("function")
  })

  test("returns empty for empty content", () => {
    expect(extractSymbols("")).toEqual([])
  })
})

describe("persistent CodeGraph index", () => {
  test("writes and incrementally reuses real symbol/import/call data", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-codegraph-"))
    try {
      await mkdir(path.join(directory, "src"))
      await writeFile(path.join(directory, "src", "a.ts"), `import { b } from "./b"\nexport function a() { return b() }`)
      await writeFile(path.join(directory, "src", "b.ts"), `export function b() { return 1 }`)
      await writeFile(path.join(directory, "src", "deploy.ps1"), `function Invoke-Deploy { 'ready' }`)
      const result = await createDeveAgentCodeGraphIndex({ directory })
      expect(result.fileCount).toBe(3)
      expect(result.symbolCount).toBeGreaterThanOrEqual(3)
      expect(result.edges).toContainEqual({ type: "imports", from: "src/a.ts", to: "./b" })
      expect(result.edges).toContainEqual({ type: "imports-resolved", from: "src/a.ts", to: "src/b.ts" })
      expect(result.edges).toContainEqual({ type: "calls", from: "src/a.ts", to: "src/b.ts#b" })
      expect(result.importEdgeCount).toBe(1)
      expect(result.resolvedImportEdgeCount).toBe(1)
      expect(result.callEdgeCount).toBe(1)
      expect(result.reusedFileCount).toBe(0)
      expect(result.reindexedFileCount).toBe(3)
      const saved = JSON.parse(await readFile(result.outputPath, "utf8"))
      expect(saved.engine).toBe("deveagent-codegraph-v1")
      expect(saved.files.find((file: { path: string }) => file.path === "src/deploy.ps1")?.symbols).toContainEqual({
        name: "Invoke-Deploy",
        kind: "function",
        line: 1,
      })
      const reused = await createDeveAgentCodeGraphIndex({ directory })
      expect(reused.reusedFileCount).toBe(3)
      expect(reused.reindexedFileCount).toBe(0)
      await writeFile(path.join(directory, "src", "b.ts"), `export function b() { return 100 }`)
      const changed = await createDeveAgentCodeGraphIndex({ directory })
      expect(changed.reusedFileCount).toBe(2)
      expect(changed.reindexedFileCount).toBe(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("adds only persisted unique call neighbors to a context pack", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-codegraph-pack-"))
    try {
      await mkdir(path.join(directory, "src"))
      await writeFile(path.join(directory, "src", "caller.ts"), `export function caller() { return helper() }`)
      await writeFile(path.join(directory, "src", "helper.ts"), `export function helper() { return 1 }`)
      await writeFile(path.join(directory, "src", "unrelated.ts"), `export function unrelated() { return 2 }`)
      await createDeveAgentCodeGraphIndex({ directory })
      const pack = await createDeveAgentContextPack({ directory, files: [{ path: "src/caller.ts", source: "context" }] })
      expect(pack.files.map((file) => file.path)).toContain("src/helper.ts")
      expect(pack.files.find((file) => file.path === "src/helper.ts")?.source).toBe("codegraph call")
      expect(pack.files.map((file) => file.path)).not.toContain("src/unrelated.ts")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("returns exact direct imports and call relationships from the persisted graph", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-codegraph-neighbors-"))
    try {
      await mkdir(path.join(directory, "src"))
      await writeFile(path.join(directory, "src", "entry.ts"), `import { helper } from "./helper"\nexport function entry() { return helper() }`)
      await writeFile(path.join(directory, "src", "helper.ts"), `export function helper() { return 1 }`)
      await createDeveAgentCodeGraphIndex({ directory })
      const entry = await getDeveAgentCodeGraphNeighbors({ directory, filePath: "src/entry.ts" })
      expect(entry.available).toBe(true)
      expect(entry.neighbors).toContainEqual({ relation: "imports", path: "src/helper.ts" })
      expect(entry.neighbors).toContainEqual({ relation: "calls", path: "src/helper.ts", symbol: "helper" })
      const helper = await getDeveAgentCodeGraphNeighbors({ directory, filePath: "src/helper.ts" })
      expect(helper.neighbors).toContainEqual({ relation: "imported-by", path: "src/entry.ts" })
      expect(helper.neighbors).toContainEqual({ relation: "called-by", path: "src/entry.ts", symbol: "helper" })
      expect((await getDeveAgentCodeGraphNeighbors({ directory, filePath: "../outside.ts" })).available).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("adds only exact relative import neighbors to a context pack", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-codegraph-import-pack-"))
    try {
      await mkdir(path.join(directory, "src"))
      await writeFile(path.join(directory, "src", "entry.ts"), `import "./side-effect"\nexport const entry = true`)
      await writeFile(path.join(directory, "src", "side-effect.ts"), `export const configured = true`)
      await writeFile(path.join(directory, "src", "package.ts"), `export const unrelated = true`)
      await createDeveAgentCodeGraphIndex({ directory })
      const pack = await createDeveAgentContextPack({ directory, files: [{ path: "src/entry.ts", source: "context" }] })
      expect(pack.files.find((file) => file.path === "src/side-effect.ts")?.source).toBe("codegraph import")
      expect(pack.files.map((file) => file.path)).not.toContain("src/package.ts")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("rebuilds when a workspace cache entry is malformed", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-codegraph-cache-"))
    try {
      await mkdir(path.join(directory, "src"))
      await writeFile(path.join(directory, "src", "a.ts"), `export function a() { return 1 }`)
      await mkdir(path.join(directory, ".opencode"))
      await writeFile(
        path.join(directory, ".opencode", "deveagent-codegraph-v1.json"),
        JSON.stringify({ engine: "deveagent-codegraph-v1", directory, files: [{ path: "src/a.ts", bytes: "bad" }] }),
      )
      const result = await createDeveAgentCodeGraphIndex({ directory })
      expect(result.fileCount).toBe(1)
      expect(result.reusedFileCount).toBe(0)
      expect(result.reindexedFileCount).toBe(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("reports stale changed and deleted indexed files without reading source", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-codegraph-status-"))
    try {
      await mkdir(path.join(directory, "src"))
      await writeFile(path.join(directory, "src", "a.ts"), `export function a() { return 1 }`)
      await writeFile(path.join(directory, "src", "b.ts"), `export function b() { return 2 }`)
      await createDeveAgentCodeGraphIndex({ directory })
      expect((await getDeveAgentCodeGraphIndexStatus({ directory })).staleFileCount).toBe(0)
      await writeFile(path.join(directory, "src", "a.ts"), `export function a() { return 100 }`)
      await rm(path.join(directory, "src", "b.ts"))
      const status = await getDeveAgentCodeGraphIndexStatus({ directory })
      expect(status.available).toBe(true)
      expect(status.staleFileCount).toBe(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe("CodeGraph context pack semantics (multi-language fixture)", () => {
  test("ranks, extracts, and packs a real TS/JS/Python fixture without fabrication", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-pack-semantics-"))
    try {
      await mkdir(path.join(directory, "src", "auth"), { recursive: true })
      await mkdir(path.join(directory, "scripts"))
      const tsContent = `export function login(user: string) { return user }\nexport function logout() { return null }\n`
      const jsContent = `function renderAuth() { return true }\n`
      const pyContent = `def audit_login():\n    return True\n`
      await writeFile(path.join(directory, "src", "auth", "login.ts"), tsContent)
      await writeFile(path.join(directory, "src", "auth", "render.js"), jsContent)
      await writeFile(path.join(directory, "scripts", "audit.py"), pyContent)

      const paths = ["src/auth/login.ts", "src/auth/render.js", "scripts/audit.py"]
      // 1. Ranking relevance: the auth task must rank login.ts first and the
      //    unrelated Python script last.
      const ranked = rankFiles(paths, "fix auth login flow")
      expect(ranked[0]?.path).toBe("src/auth/login.ts")
      expect(ranked.map(r => r.path)).toContain("src/auth/render.js")
      const loginScore = ranked.find(r => r.path === "src/auth/login.ts")?.score ?? 0
      const auditScore = ranked.find(r => r.path === "scripts/audit.py")?.score ?? 0
      expect(loginScore).toBeGreaterThan(auditScore)

      // 2. Symbol extraction correctness on the real fixture contents:
      //    tree-sitter for TS/JS, regex for Python (no Python grammar loaded).
      const tsSymbols = await treeSitterExtractSymbols(tsContent, "ts")
      expect(tsSymbols?.map(s => s.name)).toEqual(["login", "logout"])
      const jsSymbols = await treeSitterExtractSymbols(jsContent, "js")
      expect(jsSymbols?.map(s => s.name)).toEqual(["renderAuth"])
      expect(extractSymbols(pyContent)).toEqual([{ name: "audit_login", kind: "function", line: 1 }])

      // 3. context_pack output structure mirrors the real files on disk:
      //    every byte/token count must come from actual reads, nothing invented.
      const pack = await createDeveAgentContextPack({
        directory,
        task: "fix auth login flow",
        files: ranked.map(r => r.path),
      })
      expect(pack.available).toBe(true)
      expect(pack.engine).toBe("deveagent-context-pack-v1")
      expect(pack.files).toHaveLength(3)
      for (const file of pack.files) {
        expect(file.readable).toBe(true)
        expect(file.compressed).toBeUndefined()
      }
      const byPath = new Map(pack.files.map(f => [f.path, f]))
      expect(byPath.get("src/auth/login.ts")?.bytes).toBe(Buffer.byteLength(tsContent, "utf8"))
      expect(byPath.get("src/auth/render.js")?.bytes).toBe(Buffer.byteLength(jsContent, "utf8"))
      expect(byPath.get("scripts/audit.py")?.bytes).toBe(Buffer.byteLength(pyContent, "utf8"))
      expect(pack.totalEstimatedTokens).toBe(pack.files.reduce((sum, f) => sum + f.estimatedTokens, 0))
      expect(pack.tokensSaved).toBe(0)
      expect(Number.isNaN(Date.parse(pack.generatedAt))).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe("vision chain", () => {
  test("normalizeAuxiliary handles visionChain array", () => {
    const state = normalizeDeveAgentState({
      auxiliary: {
        vision: { providerID: "openai", modelID: "gpt-4o" },
        visionChain: [
          { providerID: "mimo", modelID: "mimo-v2.5-pro" },
          { providerID: "gemini", modelID: "gemini-2.5-pro" },
        ],
      },
    })
    expect(state.auxiliary.vision?.providerID).toBe("openai")
    expect(state.auxiliary.visionChain).toHaveLength(2)
    expect(state.auxiliary.visionChain?.[0]?.providerID).toBe("mimo")
    expect(state.auxiliary.visionChain?.[1]?.providerID).toBe("gemini")
  })

  test("vision chain shows in runtime prompt", () => {
    const state = normalizeDeveAgentState({
      auxiliary: {
        visionChain: [
          { providerID: "mimo", modelID: "mimo-v2.5-pro" },
        ],
      },
    })
    const prompt = createDeveAgentRuntimePrompt(state)
    expect(prompt).toContain("vision chain")
    expect(prompt).toContain("mimo/mimo-v2.5-pro")
  })

  test("vision chain is deduplicated and bounded before runtime injection", () => {
    const state = normalizeDeveAgentState({
      auxiliary: {
        visionChain: [
          { providerID: "a", modelID: "one" },
          { providerID: "a", modelID: "one" },
          { providerID: "b", modelID: "two" },
          { providerID: "c", modelID: "three" },
          { providerID: "d", modelID: "four" },
          { providerID: "e", modelID: "five" },
        ],
      },
    })
    expect(state.auxiliary.visionChain?.map((item) => `${item.providerID}/${item.modelID}`)).toEqual([
      "a/one",
      "b/two",
      "c/three",
      "d/four",
    ])
  })

  test("session vision override can be reset to global auxiliary settings", () => {
    const sessionID = "vision-reset-test"
    const previous = getDeveAgentState()
    try {
      setDeveAgentState({ auxiliary: { visionChain: [{ providerID: "global", modelID: "vision" }] } })
      setSessionAuxiliary(sessionID, { visionChain: [{ providerID: "session", modelID: "vision" }] })
      expect(getSessionAuxiliary(sessionID)?.visionChain?.[0]?.providerID).toBe("session")
      expect(clearSessionAuxiliary(sessionID).visionChain?.[0]?.providerID).toBe("global")
      expect(getSessionAuxiliary(sessionID)).toBeUndefined()
    } finally {
      setDeveAgentState(previous)
    }
  })
})

describe("provider fallback configuration", () => {
  test("normalizes a bounded unique pre-output fallback chain", () => {
    const state = normalizeDeveAgentState({
      auxiliary: {
        fallbackChain: [
          { providerID: "openrouter", modelID: "deepseek/deepseek-chat" },
          { providerID: "openrouter", modelID: "deepseek/deepseek-chat" },
          { providerID: "mimo", modelID: "mimo-v2.5-pro" },
        ],
      },
    })
    expect(state.auxiliary.fallbackChain).toEqual([
      { providerID: "openrouter", modelID: "deepseek/deepseek-chat", maxTokens: undefined, reasoningEffort: undefined },
      { providerID: "mimo", modelID: "mimo-v2.5-pro", maxTokens: undefined, reasoningEffort: undefined },
    ])
  })

  test("labels provider fallback as pre-output only in the runtime prompt", () => {
    const state = normalizeDeveAgentState({
      auxiliary: { fallbackChain: [{ providerID: "mimo", modelID: "mimo-v2.5-pro" }] },
    })
    expect(createDeveAgentRuntimePrompt(state)).toContain("provider fallback chain (pre-output only): mimo/mimo-v2.5-pro")
  })
})

describe("tree-sitter symbol extraction", () => {
  test("reports tree-sitter WASM availability explicitly (live in this environment)", async () => {
    // Honesty gate: fails loudly if WASM init ever breaks, instead of silently
    // passing through the regex fallback.
    expect(await isTreeSitterAvailable()).toBe(true)
  })

  test("extracts TypeScript symbols via tree-sitter, including syntax regex cannot parse", async () => {
    const code = `export function hello() {}
class Foo {}
interface Bar {}
type Baz = string
const x = 42
export default function loadConfig() {}`
    const symbols = await treeSitterExtractSymbols(code, "ts")
    expect(symbols).toBeDefined()
    expect(symbols?.find(s => s.name === "hello")?.kind).toBe("function")
    expect(symbols?.find(s => s.name === "Foo")?.kind).toBe("class")
    expect(symbols?.find(s => s.name === "Bar")?.kind).toBe("interface")
    expect(symbols?.find(s => s.name === "Baz")?.kind).toBe("type")
    // Path proof: the regex extractor cannot see `export default function`,
    // so finding loadConfig proves the tree-sitter parser actually ran.
    expect(extractSymbols(code).find(s => s.name === "loadConfig")).toBeUndefined()
    expect(symbols?.find(s => s.name === "loadConfig")?.kind).toBe("function")
  })

  test("extracts JavaScript symbols via tree-sitter, including syntax regex cannot parse", async () => {
    const code = `function hello() {}
class Foo {}
export default class App {}`
    const symbols = await treeSitterExtractSymbols(code, "js")
    expect(symbols).toBeDefined()
    expect(symbols?.find(s => s.name === "hello")?.kind).toBe("function")
    expect(symbols?.find(s => s.name === "Foo")?.kind).toBe("class")
    // Path proof: regex misses `export default class`; tree-sitter must not.
    expect(extractSymbols(code).find(s => s.name === "App")).toBeUndefined()
    expect(symbols?.find(s => s.name === "App")?.kind).toBe("class")
  })

  test("extracts Bash and PowerShell functions through their installed grammars", async () => {
    const bash = await treeSitterExtractSymbols("deploy_app() { echo ready; }", "bash")
    expect(bash).toEqual([{ name: "deploy_app", kind: "function", line: 1 }])

    const powershell = await treeSitterExtractSymbols("function Invoke-Deploy { 'ready' }\nclass ReleaseInfo {}", "powershell")
    expect(powershell?.find(s => s.name === "Invoke-Deploy")?.kind).toBe("function")
    expect(powershell?.find(s => s.name === "ReleaseInfo")?.kind).toBe("class")
  })

  test("treeSitterExtractSymbolsFromFiles falls back to regex only for unsupported files", async () => {
    const files = [
      { path: "a.ts", content: "export function a() {}" },
      { path: "deploy.sh", content: "deploy_app() { echo ready; }" },
      { path: "b.py", content: "def b(): pass" },
    ]
    const results = await treeSitterExtractSymbolsFromFiles(files)
    expect(results).toHaveLength(3)
    // a.ts goes through the real tree-sitter path (WASM verified live above).
    expect(results[0].symbols).toEqual([{ name: "a", kind: "function", line: 1 }])
    expect(results[1].symbols).toEqual([{ name: "deploy_app", kind: "function", line: 1 }])
    // b.py is never offered to tree-sitter (no Python grammar loaded);
    // the regex fallback is the documented path for it.
    expect(results[2].symbols).toEqual([{ name: "b", kind: "function", line: 1 }])
  })

  test("returns an empty list (not undefined) when content parses but has no TS symbols", async () => {
    // Python source parsed with the TS grammar: tree-sitter error-recovers,
    // the query matches nothing, and the honest result is an empty list.
    const symbols = await treeSitterExtractSymbols("def foo(): pass", "ts")
    expect(symbols).toEqual([])
  })
})

describe("goal worker recovery and scheduling evidence", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

  async function withGoalStore(fn: (dir: string) => Promise<void>) {
    const dir = await mkdtemp(path.join(tmpdir(), "deveagent-goals-"))
    const prev = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = dir
    try {
      await fn(dir)
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = prev
      await rm(dir, { recursive: true, force: true })
    }
  }

  function drainGoalQueue() {
    for (const item of getGoalQueue()) clearGoal(item.sessionID)
  }

  test("goalBackoffMs grows linearly and caps at 60 seconds", () => {
    expect(goalBackoffMs(1)).toBe(5_000)
    expect(goalBackoffMs(3)).toBe(15_000)
    expect(goalBackoffMs(12)).toBe(60_000)
    expect(goalBackoffMs(100)).toBe(60_000)
  })

  test("goal store persistence keeps the newest goals within the 100-entry bound", async () => {
    drainGoalQueue()
    await withGoalStore(async (dir) => {
      for (let index = 0; index < 101; index++) {
        setGoal({ sessionID: `goal-slice-${index}`, description: `Goal ${index}`, criteria: ["A"], directory: dir })
      }
      await waitForGoalStoreFlush()
      const store = path.join(dir, "opencode", "deveagent-goals.json")
      const persisted = JSON.parse(await readFile(store, "utf8")) as { goals: [string, unknown][] }
      expect(persisted.goals).toHaveLength(100)
      expect(persisted.goals.some(([id]) => id === "goal-slice-100")).toBe(true)
      expect(persisted.goals.some(([id]) => id === "goal-slice-0")).toBe(false)
      for (let index = 0; index < 101; index++) clearGoal(`goal-slice-${index}`)
    })
  })

  test("worker recovery scan resumes persisted ready goals from disk", async () => {
    drainGoalQueue()
    await withGoalStore(async (dir) => {
      const store = path.join(dir, "opencode", "deveagent-goals.json")
      await mkdir(path.dirname(store), { recursive: true })
      const readyDeadline = Date.now() + 600_000
      await writeFile(store, JSON.stringify({ version: 1, goals: [
        ["recover_ready", { active: true, status: "in_progress", description: "Resume after restart", criteria: ["A"], startedAt: Date.now(), reentries: 0, maxReentries: 8, deadlineAt: readyDeadline, retryCount: 0 }],
        ["recover_running", { active: true, status: "in_progress", description: "Interrupted pass", criteria: ["A"], startedAt: Date.now(), reentries: 1, maxReentries: 8, deadlineAt: Date.now() + 600_000, retryCount: 0, nextAttemptAt: Date.now() + 600_000, attempts: [{ id: 1, status: "running", startedAt: Date.now() - 1_000 }] }],
        ["recover_bad", { active: true, status: "in_progress", description: 123, criteria: "nope" }],
      ] }), "utf8")
      const calls: string[] = []
      const client = {
        session: {
          calls,
          async prompt(input: { path: { id: string } }) {
            this.calls.push(input.path.id)
          },
          async promptAsync() {
            throw new Error("promptAsync should not be used when the synchronous endpoint exists")
          },
        },
      }
      await scanGoalQueueOnce(client, dir)
      // Saves are fire-and-forget by design; await the flush before asserting
      // the persisted file (the write chain may carry backlog from earlier
      // tests, so this must not rely on timing).
      await waitForGoalStoreFlush()
      expect(calls).toEqual(["recover_ready"])
      expect(getGoal("recover_ready")).toMatchObject({ description: "Resume after restart", directory: path.resolve(dir), deadlineAt: readyDeadline })
      expect(getGoal("recover_running").attempts[0]).toMatchObject({
        id: 1,
        status: "interrupted",
        error: "Application restarted before the Goal re-entry returned.",
      })
      expect(getGoal("recover_bad").active).toBe(false)
      const persisted = JSON.parse(await readFile(store, "utf8")) as { version: number; goals: [string, { directory?: string }][] }
      expect(persisted.version).toBe(3)
      expect(persisted.goals.find(([sessionID]) => sessionID === "recover_ready")?.[1].directory).toBe(path.resolve(dir))
      clearGoal("recover_ready")
      clearGoal("recover_running")
    })
  })

  test("does not let a replaced lease commit stale Goal recovery state", async () => {
    drainGoalQueue()
    await withGoalStore(async (dir) => {
      const sessionID = "goal-replaced-lease"
      setGoal({ sessionID, directory: dir, description: "Keep the newer worker state", criteria: ["A"] })
      await settle()
      let releasePrompt!: () => void
      const promptDone = new Promise<void>((resolve) => { releasePrompt = resolve })
      const client = { session: { promptAsync: async () => { await promptDone } } }
      const scan = scanGoalQueueOnce(client, dir)
      await settle()
      const leasePath = path.join(dir, "opencode", `deveagent-goal-${encodeURIComponent(sessionID)}.lock`)
      await writeFile(leasePath, JSON.stringify({ pid: 999, token: "replacement", renewedAt: Date.now() }), "utf8")
      releasePrompt()
      await scan

      const persisted = JSON.parse(await readFile(path.join(dir, "opencode", "deveagent-goals.json"), "utf8")) as { goals: [string, { attempts?: Array<{ status: string }> }][] }
      expect(persisted.goals.find(([id]) => id === sessionID)?.[1].attempts?.at(-1)?.status).toBe("running")
      expect(JSON.parse(await readFile(leasePath, "utf8"))).toMatchObject({ token: "replacement" })
      clearGoal(sessionID)
    })
  })

  test("goal recovery only schedules the current workspace", async () => {
    drainGoalQueue()
    await withGoalStore(async (dir) => {
      const workspaceA = path.join(dir, "workspace-a")
      const workspaceB = path.join(dir, "workspace-b")
      setGoal({ sessionID: "goal-a", directory: workspaceA, description: "Workspace A", criteria: ["A"] })
      setGoal({ sessionID: "goal-b", directory: workspaceB, description: "Workspace B", criteria: ["B"] })
      await settle()
      expect(getGoalQueue(workspaceA).map((item) => item.sessionID)).toEqual(["goal-a"])
      const calls: string[] = []
      const client = {
        session: {
          async promptAsync(input: { path: { id: string } }) {
            calls.push(input.path.id)
          },
        },
      }
      await scanGoalQueueOnce(client, workspaceA)
      expect(calls).toEqual(["goal-a"])
      expect(getGoal("goal-b").reentries).toBe(0)
      expect(getGoal("goal-a").attempts.at(-1)).toMatchObject({ id: 1, status: "completed" })
      clearGoal("goal-a")
      clearGoal("goal-b")
    })
  })

  test("worker refuses to schedule a persisted goal whose deadline already passed", async () => {
    drainGoalQueue()
    await withGoalStore(async (dir) => {
      const store = path.join(dir, "opencode", "deveagent-goals.json")
      await mkdir(path.dirname(store), { recursive: true })
      await writeFile(store, JSON.stringify({ version: 1, goals: [
        ["recover_expired", { active: true, status: "in_progress", description: "Expired budget", criteria: ["A"], startedAt: Date.now() - 900_000, reentries: 0, maxReentries: 8, deadlineAt: Date.now() - 1_000, retryCount: 0 }],
      ] }), "utf8")
      let calls = 0
      const client = { session: { promptAsync: async () => { calls += 1 } } }
      await scanGoalQueueOnce(client, dir)
      expect(calls).toBe(0)
      expect(getGoal("recover_expired")).toMatchObject({ status: "failed", stopReason: "Goal wall-clock budget exhausted." })
      clearGoal("recover_expired")
    })
  })

  test("worker records lastError and capped backoff after a failed resume, then skips until nextAttemptAt", async () => {
    drainGoalQueue()
    setGoal({ sessionID: "goal_retry", description: "Flaky resume", criteria: ["A"] })
    await withGoalStore(async (dir) => {
      let calls = 0
      const client = { session: { promptAsync: async () => { calls += 1; throw new Error("provider exploded") } } }
      const before = Date.now()
      await scanGoalQueueOnce(client, dir)
      expect(calls).toBe(1)
      const goal = getGoal("goal_retry")
      expect(goal.retryCount).toBe(1)
      expect(goal.lastError).toBe("provider exploded")
      expect(goal.attempts.at(-1)).toMatchObject({ id: 1, status: "failed", error: "provider exploded" })
      expect(goal.nextAttemptAt).toBeGreaterThanOrEqual(before + 5_000)
      expect(goal.nextAttemptAt).toBeLessThanOrEqual(Date.now() + 60_000)
      expect(goal.deadlineAt).toBeGreaterThan(Date.now())
      const item = getGoalQueue().find((entry) => entry.sessionID === "goal_retry")
      expect(item).toMatchObject({ ready: false, retryCount: 1, lastError: "provider exploded" })
      await settle()
      await scanGoalQueueOnce(client, dir)
      expect(calls).toBe(1)
      clearGoal("goal_retry")
    })
  })

  test("goal fails after its retry budget instead of retrying a dead session forever", async () => {
    drainGoalQueue()
    await withGoalStore(async (dir) => {
      const sessionID = "goal_retry_budget"
      const store = path.join(dir, "opencode", "deveagent-goals.json")
      await mkdir(path.dirname(store), { recursive: true })
      // Seed a goal that has already burned its retry budget (12) and is ready
      // again — the next failure must fail the goal instead of rescheduling.
      await writeFile(store, JSON.stringify({ version: 3, goals: [
        [sessionID, {
          active: true,
          status: "in_progress",
          description: "Resume against a dead session",
          criteria: ["A"],
          startedAt: Date.now(),
          reentries: 0,
          maxReentries: 8,
          deadlineAt: Date.now() + 600_000,
          retryCount: 12,
          nextAttemptAt: 0,
          attempts: [],
        }],
      ] }), "utf8")
      let calls = 0
      const client = { session: { promptAsync: async () => { calls += 1; throw new Error("session not found") } } }
      await scanGoalQueueOnce(client, dir)
      expect(calls).toBe(1)
      const goal = getGoal(sessionID)
      expect(goal.status).toBe("failed")
      expect(goal.stopReason).toContain("retry budget")
      expect(goal.nextAttemptAt).toBeUndefined()
      expect(goal.retryCount).toBe(13)
      clearGoal(sessionID)
    })
  })

  test("worker aborts and persists a running goal when its deadline expires", async () => {
    drainGoalQueue()
    await withGoalStore(async (dir) => {
      const sessionID = "goal_timeout_inflight"
      const store = path.join(dir, "opencode", "deveagent-goals.json")
      await mkdir(path.dirname(store), { recursive: true })
      await writeFile(store, JSON.stringify({ version: 3, goals: [
        [sessionID, {
          active: true,
          status: "in_progress",
          description: "Stop a provider that exceeds the deadline",
          criteria: ["A"],
          directory: dir,
          startedAt: Date.now(),
          reentries: 0,
          maxReentries: 8,
          deadlineAt: Date.now() + 40,
          retryCount: 0,
          attempts: [],
        }],
      ] }), "utf8")
      let releasePrompt!: () => void
      const promptDone = new Promise<void>((resolve) => { releasePrompt = resolve })
      const aborted: string[] = []
      const client = {
        session: {
          async prompt() {
            await promptDone
          },
          async abort(input: { path: { id: string } }) {
            aborted.push(input.path.id)
            releasePrompt()
          },
        },
      }

      await scanGoalQueueOnce(client, dir)
      expect(aborted).toEqual([sessionID])
      expect(getGoal(sessionID)).toMatchObject({
        status: "failed",
        stopReason: "Goal wall-clock budget exhausted.",
        lastError: "Goal wall-clock budget exhausted.",
      })
      expect(getGoal(sessionID).attempts.at(-1)).toMatchObject({ status: "failed", error: "Goal wall-clock budget exhausted." })
      expect(getGoalQueue(dir).find((item) => item.sessionID === sessionID)).toBeUndefined()
      expect(verifyGoal({ sessionID, met: true }).status).toBe("failed")
      await settle()
      const persisted = JSON.parse(await readFile(store, "utf8")) as { goals: [string, { status?: string; stopReason?: string }][] }
      expect(persisted.goals.find(([id]) => id === sessionID)?.[1]).toMatchObject({ status: "failed", stopReason: "Goal wall-clock budget exhausted." })
      clearGoal(sessionID)
    })
  })

  test("clearing an in-flight goal aborts its active provider session", async () => {
    drainGoalQueue()
    await withGoalStore(async (dir) => {
      setGoal({ sessionID: "goal_cancel_inflight", directory: dir, description: "Cancel active provider work", criteria: ["A"] })
      let releasePrompt!: () => void
      const promptDone = new Promise<void>((resolve) => { releasePrompt = resolve })
      const aborted: string[] = []
      const client = {
        session: {
          async promptAsync() {
            await promptDone
          },
          async abort(input: { path: { id: string } }) {
            aborted.push(input.path.id)
            releasePrompt()
          },
        },
      }
      const scan = scanGoalQueueOnce(client, dir)
      await settle()
      clearGoal("goal_cancel_inflight")
      await scan
      expect(aborted).toEqual(["goal_cancel_inflight"])
      expect(getGoal("goal_cancel_inflight").active).toBe(false)
    })
  })

  test("worker stops scheduling once the re-entry budget is exhausted", async () => {
    drainGoalQueue()
    setGoal({ sessionID: "goal_budget_worker", description: "Bounded worker", criteria: ["A"], maxReentries: 1 })
    await withGoalStore(async (dir) => {
      let calls = 0
      const client = { session: { promptAsync: async () => { calls += 1 } } }
      await scanGoalQueueOnce(client, dir)
      expect(calls).toBe(1)
      await settle()
      await scanGoalQueueOnce(client, dir)
      expect(calls).toBe(1)
      expect(getGoal("goal_budget_worker")).toMatchObject({ status: "failed", stopReason: "Goal re-entry budget exhausted." })
      clearGoal("goal_budget_worker")
    })
  })

  test("provider goal-verify completion is not overwritten by the worker", async () => {
    drainGoalQueue()
    await withGoalStore(async (dir) => {
      const sessionID = "goal-provider-verified"
      setGoal({ sessionID, directory: dir, description: "Stop after provider verification", criteria: ["done"] })
      let calls = 0
      const client = {
        session: {
          async prompt() {
            calls += 1
            expect(verifyGoal({ sessionID, met: true, reason: "provider confirmed done" }).status).toBe("verified")
          },
        },
      }

      await scanGoalQueueOnce(client, dir)
      await settle()
      await scanGoalQueueOnce(client, dir)

      expect(calls).toBe(1)
      expect(getGoal(sessionID)).toMatchObject({ active: true, status: "verified", verifiedAt: expect.any(Number) })
      const persisted = JSON.parse(await readFile(path.join(dir, "opencode", "deveagent-goals.json"), "utf8")) as {
        goals: [string, { status?: string }][]
      }
      expect(persisted.goals.find(([id]) => id === sessionID)?.[1].status).toBe("verified")
      clearGoal(sessionID)
    })
  })

  test("provider goal-verify rejection keeps the goal eligible for a later re-entry", async () => {
    drainGoalQueue()
    await withGoalStore(async (dir) => {
      const sessionID = "goal-provider-rejected"
      setGoal({ sessionID, directory: dir, description: "Continue after provider rejection", criteria: ["done"] })
      const client = {
        session: {
          async prompt() {
            expect(verifyGoal({ sessionID, met: false, reason: "more work remains" }).status).toBe("in_progress")
          },
        },
      }

      await scanGoalQueueOnce(client, dir)

      expect(getGoal(sessionID)).toMatchObject({ active: true, status: "in_progress", retryCount: 0 })
      expect(getGoal(sessionID).attempts.at(-1)).toMatchObject({ status: "completed" })
      expect(getGoalQueue(dir).find((item) => item.sessionID === sessionID)?.ready).toBe(true)
      clearGoal(sessionID)
    })
  })

  test("cleared goals are not rescheduled and are removed from the persisted queue", async () => {
    drainGoalQueue()
    await withGoalStore(async (dir) => {
      setGoal({ sessionID: "goal_cancelled", description: "Cancel me", criteria: ["A"] })
      await settle()
      clearGoal("goal_cancelled")
      await settle()
      let calls = 0
      const client = { session: { promptAsync: async () => { calls += 1 } } }
      await scanGoalQueueOnce(client, dir)
      expect(calls).toBe(0)
      const persisted = JSON.parse(await readFile(path.join(dir, "opencode", "deveagent-goals.json"), "utf8"))
      expect((persisted.goals as [string, unknown][]).map(([id]) => id)).not.toContain("goal_cancelled")
    })
  })

})

describe("speech transcription", () => {
  test("normalizes OpenAI-compatible API URLs", () => {
    expect(voiceTranscriptionUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1/audio/transcriptions")
    expect(voiceTranscriptionUrl("https://api.example.com/v1/chat/completions")).toBe("https://api.example.com/v1/audio/transcriptions")
  })

  test("sends audio as authenticated multipart form data", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const text = await transcribeOpenAICompatibleAudio({
      baseURL: "https://api.example.com/v1",
      apiKey: "secret",
      modelID: "whisper-1",
      mimeType: "audio/webm",
      audioBase64: Buffer.from("voice").toString("base64"),
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return Response.json({ text: " transcribed text " })
      }) as typeof fetch,
    })

    expect(text).toBe("transcribed text")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://api.example.com/v1/audio/transcriptions")
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer secret")
    expect(calls[0]?.init.body).toBeInstanceOf(FormData)
  })

  test("rejects malformed or unsupported audio before network access", async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return Response.json({ text: "unexpected" })
    }) as unknown as typeof fetch

    await expect(transcribeOpenAICompatibleAudio({
      baseURL: "https://api.example.com/v1",
      modelID: "whisper-1",
      mimeType: "audio/webm",
      audioBase64: "***",
      fetchImpl,
    })).rejects.toThrow("Invalid")
    await expect(transcribeOpenAICompatibleAudio({
      baseURL: "https://api.example.com/v1",
      modelID: "whisper-1",
      mimeType: "audio/flac",
      audioBase64: Buffer.from("voice").toString("base64"),
      fetchImpl,
    })).rejects.toThrow("Unsupported audio type")
    expect(calls).toBe(0)
  })
})

describe("loop worker persistence and scheduling evidence", () => {
  async function withLoopStore(fn: (dir: string) => Promise<void>) {
    const dir = await mkdtemp(path.join(tmpdir(), "deveagent-loops-"))
    const prev = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = dir
    try {
      await fn(dir)
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = prev
      await rm(dir, { recursive: true, force: true })
    }
  }

  function drainLoopQueue() {
    for (const item of getLoopQueue()) clearLoop(item.sessionID)
  }

  test("loop state is bounded, pausable, resumable, and cancellable", () => {
    drainLoopQueue()
    const loop = setLoop({
      sessionID: "loop-controls",
      task: "Run focused checks",
      intervalSeconds: 1,
      maxRuns: 500,
      maxRetries: 50,
    })
    expect(loop).toMatchObject({ active: true, status: "running", intervalSeconds: 5, maxRuns: 100, maxRetries: 10 })
    expect(pauseLoop("loop-controls").status).toBe("paused")
    expect(resumeLoop("loop-controls").status).toBe("running")
    expect(clearLoop("loop-controls").active).toBe(false)
  })

  test("loopBackoffMs grows linearly and caps at 60 seconds", () => {
    expect(loopBackoffMs(1)).toBe(5_000)
    expect(loopBackoffMs(12)).toBe(60_000)
  })

  test("loop store writes are atomic and waitForLoopStoreFlush observes them", async () => {
    drainLoopQueue()
    await withLoopStore(async (dir) => {
      const store = path.join(dir, "opencode", "deveagent-loops.json")
      setLoop({ sessionID: "loop-flush", task: "Persisted loop", intervalSeconds: 5 })
      await waitForLoopStoreFlush()
      const persisted = JSON.parse(await readFile(store, "utf8")) as { version: number; loops: [string, { active: boolean; status: string }][] }
      expect(persisted.version).toBe(2)
      expect(persisted.loops.find(([id]) => id === "loop-flush")?.[1]).toMatchObject({ active: true, status: "running" })
      clearLoop("loop-flush")
      await waitForLoopStoreFlush()
      const after = JSON.parse(await readFile(store, "utf8")) as { version: number; loops: [string, unknown][] }
      expect(after.loops.some(([id]) => id === "loop-flush")).toBe(false)
    })
  })

  test("worker runs a persisted ready loop once and completes at its run budget", async () => {
    drainLoopQueue()
    await withLoopStore(async (dir) => {
      const store = path.join(dir, "opencode", "deveagent-loops.json")
      await mkdir(path.dirname(store), { recursive: true })
      const deadlineAt = Date.now() + 60_000
      await writeFile(store, JSON.stringify({ version: 1, loops: [
        ["loop-ready", {
          active: true,
          status: "running",
          task: "Check the release",
          runCount: 0,
          maxRuns: 1,
          intervalSeconds: 5,
          retryCount: 0,
          maxRetries: 3,
          startedAt: Date.now(),
          deadlineAt,
          nextRunAt: Date.now() - 1,
        }],
      ] }), "utf8")
      const calls: unknown[] = []
      const client = {
        session: {
          calls,
          async promptAsync(input: unknown) {
            this.calls.push(input)
          },
        },
      }
      await scanLoopQueueOnce(client, dir)
      expect(calls).toHaveLength(1)
      expect(getLoop("loop-ready")).toMatchObject({ active: false, status: "completed", runCount: 1, directory: path.resolve(dir), deadlineAt })
      expect(JSON.parse(await readFile(store, "utf8"))).toMatchObject({ version: 2 })
      clearLoop("loop-ready")
    })
  })

  test("worker records provider failure and waits for bounded retry", async () => {
    drainLoopQueue()
    await withLoopStore(async (dir) => {
      const store = path.join(dir, "opencode", "deveagent-loops.json")
      await mkdir(path.dirname(store), { recursive: true })
      await writeFile(store, JSON.stringify({ version: 1, loops: [
        ["loop-retry", {
          active: true,
          status: "running",
          task: "Retry the check",
          runCount: 0,
          maxRuns: 2,
          intervalSeconds: 5,
          retryCount: 0,
          maxRetries: 1,
          startedAt: Date.now(),
          deadlineAt: Date.now() + 60_000,
          nextRunAt: Date.now() - 1,
        }],
      ] }), "utf8")
      let calls = 0
      const client = { session: { promptAsync: async () => { calls += 1; throw new Error("provider offline") } } }
      await scanLoopQueueOnce(client, dir)
      expect(calls).toBe(1)
      expect(getLoop("loop-retry")).toMatchObject({ active: true, status: "running", retryCount: 1, lastError: "provider offline", runCount: 0 })
      await scanLoopQueueOnce(client, dir)
      expect(calls).toBe(1)
      clearLoop("loop-retry")
    })
  })

  test("clearing an in-flight loop aborts its active provider session", async () => {
    drainLoopQueue()
    await withLoopStore(async (dir) => {
      const sessionID = "loop-cancel-inflight"
      const store = path.join(dir, "opencode", "deveagent-loops.json")
      await mkdir(path.dirname(store), { recursive: true })
      await writeFile(store, JSON.stringify({ version: 1, loops: [
        [sessionID, {
          active: true,
          status: "running",
          task: "Cancel active provider work",
          directory: path.resolve(dir),
          runCount: 0,
          maxRuns: 2,
          intervalSeconds: 5,
          retryCount: 0,
          maxRetries: 3,
          startedAt: Date.now(),
          deadlineAt: Date.now() + 600_000,
          nextRunAt: Date.now() - 1,
        }],
      ] }), "utf8")
      let releasePrompt!: () => void
      let markPromptStarted!: () => void
      const promptStarted = new Promise<void>((resolve) => { markPromptStarted = resolve })
      const promptDone = new Promise<void>((resolve) => { releasePrompt = resolve })
      const aborted: string[] = []
      const client = {
        session: {
          async promptAsync() {
            markPromptStarted()
            await promptDone
          },
          async abort(input: { path: { id: string } }) {
            aborted.push(input.path.id)
            releasePrompt()
          },
        },
      }
      const scan = scanLoopQueueOnce(client, dir)
      await promptStarted
      clearLoop(sessionID)
      await scan
      expect(aborted).toEqual([sessionID])
      expect(getLoop(sessionID).active).toBe(false)
    })
  })
})

describe("team orchestration evidence", () => {
  type TeamTaskInput = Parameters<NonNullable<ToolContext["runTask"]>>[0]
  type TeamTaskResult = { title: string; output: string; metadata: Record<string, unknown> }

  async function teamTools(directory?: string) {
    const hooks = await deveagentPlugin.server({ client: {}, directory } as unknown as Parameters<typeof deveagentPlugin.server>[0])
    return hooks.tool!
  }

  function teamContext(
    sessionID: string,
    runTask: (input: TeamTaskInput) => Promise<TeamTaskResult>,
    waitTask?: NonNullable<ToolContext["waitTask"]>,
    directory = ".",
  ): ToolContext {
    return {
      sessionID,
      messageID: "msg-test",
      agent: "build",
      directory,
      worktree: directory,
      abort: new AbortController().signal,
      metadata: () => undefined,
      ask: async () => undefined,
      runTask,
      waitTask,
    }
  }

  async function withTeamRunStore(fn: () => Promise<void>) {
    const dir = await mkdtemp(path.join(tmpdir(), "deveagent-team-runs-"))
    const prev = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = dir
    try {
      await fn()
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = prev
      // fire-and-forget persistence (saveTeamStateToDisk/saveTeamRunsToDisk) must land before the temp dir is removed
      await new Promise((resolve) => setTimeout(resolve, 50))
      await rm(dir, { recursive: true, force: true })
    }
  }

  const advisorResult = (tokens: number): TeamTaskResult => ({
    title: "advisor",
    output: "ok",
    metadata: { usage: { total: tokens, input: tokens - 100, output: 100 } },
  })

  test("sequential dispatch stops new advisors after the team token budget is exhausted", async () => {
    await withTeamRunStore(async () => {
      const sessionID = "orch_seq_budget"
      setDeveAgentTeam({
        sessionID,
        enabled: true,
        runMode: "sequential",
        budgetTokens: 10_000,
        members: [
          { id: "p1", name: "Planner", role: "planner", providerID: "deepseek", modelID: "deepseek-chat", enabled: true },
          { id: "c1", name: "Critic", role: "critic", providerID: "deepseek", modelID: "deepseek-chat", enabled: true },
          { id: "v1", name: "Verifier", role: "verifier", providerID: "deepseek", modelID: "deepseek-chat", enabled: true },
        ],
      })
      const calls: TeamTaskInput[] = []
      const tools = await teamTools()
      const output = await tools["team-dispatch-all"].execute(
        { task: "Design the cache layer" },
        teamContext(sessionID, async (input) => {
          calls.push(input)
          return advisorResult(10_000)
        }),
      )
      const parsed = JSON.parse(output as string)
      // only the first advisor consumed the budget; the rest were never dispatched
      expect(calls).toHaveLength(1)
      expect(parsed.results).toHaveLength(3)
      expect(parsed.results[0].attempts).toBe(1)
      expect(parsed.results[1].attempts).toBe(0)
      expect(parsed.results[1].error).toContain("budget exhausted")
      expect(parsed.results[2].attempts).toBe(0)
      expect(parsed.results[2].error).toContain("budget exhausted")
      // the dispatched advisor is a read-only child session with the configured model and the 120s native deadline
      expect(calls[0].model).toEqual({ providerID: "deepseek", modelID: "deepseek-chat" })
      expect(calls[0].read_only).toBe(true)
      expect(calls[0].timeout_ms).toBe(120_000)
      const runs = getDeveAgentTeamRuns(sessionID)
      expect(runs).toHaveLength(1)
      expect(runs[0].members.filter((member) => member.error)).toHaveLength(2)
    })
  })

  test("sequential dispatch reallocates the remaining team budget to the next child", async () => {
    await withTeamRunStore(async () => {
      const sessionID = "orch_seq_reallocate"
      setDeveAgentTeam({
        sessionID,
        enabled: true,
        runMode: "sequential",
        maxRetries: 0,
        budgetTokens: 10_000,
        members: [
          { id: "p1", name: "Planner", role: "planner", providerID: "x", modelID: "y", enabled: true },
          { id: "c1", name: "Critic", role: "critic", providerID: "x", modelID: "y", enabled: true },
        ],
      })
      const caps: number[] = []
      const tools = await teamTools()
      const output = await tools["team-dispatch-all"].execute(
        { task: "Allocate the remaining child budget" },
        teamContext(sessionID, async (input) => {
          caps.push((input as TeamTaskInput & { max_output_tokens?: number }).max_output_tokens ?? 0)
          return advisorResult(caps.length === 1 ? 7_000 : 3_000)
        }),
      )
      const parsed = JSON.parse(output as string)
      expect(caps).toEqual([10_000, 3_000])
      expect(parsed.run).toMatchObject({ tokens: 10_000, budgetExceeded: false, status: "completed" })
      expect(parsed.synthesisRun).toBeUndefined()
    })
  })

  test("bounded retries record advisor failures without interrupting the remaining advisors", async () => {
    await withTeamRunStore(async () => {
      const sessionID = "orch_seq_failure"
      setDeveAgentTeam({
        sessionID,
        enabled: true,
        runMode: "sequential",
        budgetTokens: 100_000,
        members: [
          { id: "p1", name: "Planner", role: "planner", providerID: "x", modelID: "y", enabled: true },
          { id: "c1", name: "Critic", role: "critic", providerID: "x", modelID: "y", enabled: true },
        ],
      })
      const calls: string[] = []
      const tools = await teamTools()
      const output = await tools["team-dispatch-all"].execute(
        { task: "Review the auth flow" },
        teamContext(sessionID, async (input) => {
          calls.push(input.description)
          // a native failure (provider error or the 120s deadline cancelling the child) surfaces as a rejection
          if (input.description.startsWith("Planner")) throw new Error("planner exploded")
          return advisorResult(500)
        }),
      )
      const parsed = JSON.parse(output as string)
      // the failing advisor is retried exactly to the bound, then recorded as failed instead of looping forever
      expect(parsed.results[0]).toMatchObject({ attempts: 2, error: "planner exploded" })
      // the remaining advisor still ran and succeeded
      expect(parsed.results[1].attempts).toBe(1)
      expect(parsed.results[1].error).toBeUndefined()
      expect(parsed.run.members[0].error).toBe("planner exploded")
      expect(parsed.run.status).toBe("failed")
      // synthesis fell back to the first advisor and its bounded failure is recorded as its own team-run
      expect(parsed.synthesisRun.members[0]).toMatchObject({ attempts: 2, error: "planner exploded" })
      expect(calls.filter((description) => description.startsWith("Planner"))).toHaveLength(4)
      expect(calls.filter((description) => description.startsWith("Critic"))).toHaveLength(1)
      const runs = getDeveAgentTeamRuns(sessionID)
      expect(runs).toHaveLength(2)
      expect(runs.every((run) => run.members.some((member) => member.error === "planner exploded"))).toBe(true)
    })
  })

  test("splits a child allocation across bounded retries", async () => {
    await withTeamRunStore(async () => {
      const sessionID = "orch_retry_budget"
      setDeveAgentTeam({
        sessionID,
        enabled: true,
        runMode: "sequential",
        maxRetries: 1,
        budgetTokens: 10_000,
        members: [{ id: "p1", name: "Planner", role: "planner", providerID: "x", modelID: "y", enabled: true }],
      })
      const caps: number[] = []
      const tools = await teamTools()
      const output = await tools["team-dispatch"].execute(
        { memberID: "p1", task: "Keep retries within the child allocation" },
        teamContext(sessionID, async (input) => {
          caps.push((input as TeamTaskInput & { max_output_tokens?: number }).max_output_tokens ?? 0)
          throw new Error("provider temporarily offline")
        }),
      )
      const parsed = JSON.parse(output as string)
      expect(caps).toEqual([5_000, 5_000])
      expect(parsed.attempts).toBe(2)
      expect(parsed.error).toBe("provider temporarily offline")
    })
  })

  test("team retry policy is configurable and does not retry permission failures", async () => {
    await withTeamRunStore(async () => {
      const sessionID = "orch_retry_policy"
      setDeveAgentTeam({
        sessionID,
        enabled: true,
        runMode: "sequential",
        maxRetries: 0,
        budgetTokens: 100_000,
        members: [{ id: "p1", name: "Planner", role: "planner", providerID: "x", modelID: "y", enabled: true }],
      })
      const calls: string[] = []
      const tools = await teamTools()
      const output = await tools["team-dispatch"].execute(
        { memberID: "p1", task: "Respect retry policy" },
        teamContext(sessionID, async (input) => {
          calls.push(input.description)
          throw new Error("permission denied by policy")
        }),
      )
      const parsed = JSON.parse(output as string)
      expect(calls).toHaveLength(1)
      expect(parsed.attempts).toBe(1)
      expect(parsed.run.status).toBe("failed")
    })
  })

  test("cancels a running team, aborts known children, and fences late completion", async () => {
    await withTeamRunStore(async () => {
      const sessionID = "orch_cancel_fence"
      setDeveAgentTeam({
        sessionID,
        enabled: true,
        runMode: "sequential",
        maxRetries: 0,
        budgetTokens: 100_000,
        members: [{ id: "p1", name: "Planner", role: "planner", providerID: "x", modelID: "y", enabled: true }],
      })
      let release!: (value: TeamTaskResult) => void
      const pending = new Promise<TeamTaskResult>((resolve) => { release = resolve })
      const aborted: string[] = []
      const tools = await teamTools()
      const dispatchPromise = tools["team-dispatch"].execute(
        { memberID: "p1", task: "Cancel the running team safely" },
        teamContext(
          sessionID,
          async (input) => {
            if ((input as TeamTaskInput & { background?: boolean }).background) {
              return { metadata: { jobId: "job-cancel-1", sessionId: "child-cancel-1" } } as unknown as TeamTaskResult
            }
            return advisorResult(1_000)
          },
          async () => pending,
        ),
      )
      let run = getDeveAgentTeamRuns(sessionID)[0]
      for (let attempt = 0; attempt < 40 && (!run || run.status !== "running" || !run.members[0]?.childSessionID); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        run = getDeveAgentTeamRuns(sessionID)[0]
      }
      expect(run?.status).toBe("running")
      expect(run?.members[0]?.childSessionID).toBe("child-cancel-1")
      const cancelled = await cancelTeamRun({
        runID: run!.id,
        sessionID,
        directory: ".",
        client: { session: { abort: async (request: { path?: { id?: string } }) => { if (request.path?.id) aborted.push(request.path.id) } } },
        reason: "User stopped the team run.",
      })
      expect(cancelled.cancelled).toBe(true)
      expect(aborted).toEqual(["child-cancel-1"])
      release(advisorResult(1_000))
      const completedOutput = JSON.parse(await dispatchPromise as string)
      expect(completedOutput.run.status).toBe("interrupted")
      expect(completedOutput.run.stopReason).toBe("User stopped the team run.")
      expect(getDeveAgentTeamRuns(sessionID)[0]?.status).toBe("interrupted")
    })
  })

  test("parallel dispatch runs every advisor and reports post-run budget overrun", async () => {
    await withTeamRunStore(async () => {
      const sessionID = "orch_par_overrun"
      setDeveAgentTeam({
        sessionID,
        enabled: true,
        runMode: "parallel",
        budgetTokens: 10_000,
        members: [
          { id: "p1", name: "Planner", role: "planner", providerID: "x", modelID: "y", enabled: true },
          { id: "c1", name: "Critic", role: "critic", providerID: "x", modelID: "y", enabled: true },
        ],
      })
      let calls = 0
      const tools = await teamTools()
      const output = await tools["team-dispatch-all"].execute(
        { task: "Assess both designs" },
        teamContext(sessionID, async () => {
          calls += 1
          return advisorResult(8_000)
        }),
      )
      const parsed = JSON.parse(output as string)
      expect(calls).toBe(2)
      expect(parsed.results.every((item: { error?: string }) => item.error === undefined)).toBe(true)
      // parallel advisors cannot be pre-empted, so the overrun is reported after the run
      expect(parsed.run.tokens).toBe(16_000)
      expect(parsed.run.budgetExceeded).toBe(true)
      expect(parsed.run.status).toBe("failed")
      // an exhausted budget skips the synthesis stage instead of overspending further
      expect(parsed.synthesisRun).toBeUndefined()
      const runs = getDeveAgentTeamRuns(sessionID)
      expect(runs).toHaveLength(1)
      expect(runs[0].budgetExceeded).toBe(true)
    })
  })

  test("keeps the parent team ledger running until synthesis and executor finish", async () => {
    await withTeamRunStore(async () => {
      const sessionID = "orch_parent_lifecycle"
      const task = "Keep the parent lifecycle honest"
      setDeveAgentTeam({
        sessionID,
        enabled: true,
        runMode: "sequential",
        budgetTokens: 100_000,
        members: [
          { id: "p1", name: "Planner", role: "planner", providerID: "x", modelID: "y", enabled: true },
          { id: "r1", name: "Reviewer", role: "reviewer", providerID: "x", modelID: "y", enabled: true },
          { id: "e1", name: "Executor", role: "executor", providerID: "x", modelID: "y", enabled: true },
        ],
      })
      let releaseSynthesis!: () => void
      let markSynthesisStarted!: () => void
      const synthesisStarted = new Promise<void>((resolve) => { markSynthesisStarted = resolve })
      const synthesisGate = new Promise<void>((resolve) => { releaseSynthesis = resolve })
      const tools = await teamTools()
      const dispatch = tools["team-dispatch-all"].execute(
        { task },
        teamContext(sessionID, async (input) => {
          if (String(input.prompt).includes("Synthesize these read-only advisor reports")) {
            markSynthesisStarted()
            await synthesisGate
          }
          return advisorResult(100)
        }),
      )
      await synthesisStarted
      const parent = getDeveAgentTeamRuns(sessionID).find((run) => run.task === task)
      expect(parent?.status).toBe("running")
      expect(parent?.phase).toBe("synthesis")
      releaseSynthesis()
      const parsed = JSON.parse(await dispatch as string)
      expect(parsed.run.status).toBe("completed")
      expect(parsed.run.tokens).toBe(400)
    })
  })

  test("checkpoints completed advisors before the next queued advisor starts", async () => {
    await withTeamRunStore(async () => {
      const sessionID = "orch_advisor_checkpoint"
      const task = "Checkpoint advisor progress"
      setDeveAgentTeam({
        sessionID,
        enabled: true,
        runMode: "sequential",
        budgetTokens: 100_000,
        members: [
          { id: "p1", name: "Planner", role: "planner", providerID: "x", modelID: "y", enabled: true },
          { id: "r1", name: "Reviewer", role: "reviewer", providerID: "x", modelID: "y", enabled: true },
          { id: "e1", name: "Executor", role: "executor", providerID: "x", modelID: "y", enabled: true },
        ],
      })
      let calls = 0
      let releaseReviewer!: () => void
      let reviewerStarted!: () => void
      const reviewerGate = new Promise<void>((resolve) => { releaseReviewer = resolve })
      const reviewerReady = new Promise<void>((resolve) => { reviewerStarted = resolve })
      const tools = await teamTools()
      const dispatch = tools["team-dispatch-all"].execute(
        { task },
        teamContext(sessionID, async () => {
          calls += 1
          if (calls === 2) {
            reviewerStarted()
            await reviewerGate
          }
          return advisorResult(100)
        }),
      )
      await reviewerReady
      const parent = getDeveAgentTeamRuns(sessionID).find((run) => run.task === task)
      expect(parent?.phase).toBe("advisors")
      expect(parent?.members.find((member) => member.id === "p1")).toMatchObject({ status: "completed", tokens: 100 })
      expect(parent?.members.find((member) => member.id === "r1")?.status).toBe("running")
      releaseReviewer()
      const parsed = JSON.parse(await dispatch as string)
      expect(parsed.run.status).toBe("completed")
    })
  })

  test("persists parent Team phase queue entries through synthesis and executor", async () => {
    await withTeamRunStore(async () => {
      const workspace = await mkdtemp(path.join(tmpdir(), "deveagent-team-artifacts-"))
      try {
      const sessionID = "orch_phase_queue"
      setDeveAgentTeam({
        sessionID,
        enabled: true,
        runMode: "sequential",
        budgetTokens: 100_000,
        members: [
          { id: "p1", name: "Planner", role: "planner", providerID: "x", modelID: "y", enabled: true },
          { id: "r1", name: "Reviewer", role: "reviewer", providerID: "x", modelID: "y", enabled: true },
          { id: "e1", name: "Executor", role: "executor", providerID: "x", modelID: "y", enabled: true },
        ],
      })
      const tools = await teamTools(workspace)
      const output = await tools["team-dispatch-all"].execute(
        { task: "Persist Team phases" },
        teamContext(sessionID, async () => advisorResult(100), undefined, workspace),
      )
      const parsed = JSON.parse(output as string)
      const phases = getDeveAgentTeamPhases(sessionID).filter((phase) => phase.runID === parsed.run.id)
      expect(phases.map((phase) => phase.kind)).toEqual(["executor", "synthesis", "advisors"])
      expect(phases.every((phase) => phase.status === "completed")).toBe(true)
      expect(phases.every((phase) => phase.lease === undefined)).toBe(true)
      expect(phases.every((phase) => typeof phase.updatedAt === "number")).toBe(true)
      const stored = JSON.parse(await readFile(path.join(process.env.XDG_CONFIG_HOME!, "opencode", "deveagent-team-runs.json"), "utf8"))
      expect(stored.phases.some((phase: { runID: string; kind: string }) => phase.runID === parsed.run.id && phase.kind === "executor")).toBe(true)
      expect(stored.version).toBe(3)
      expect(stored.phases.filter((phase: { runID: string }) => phase.runID === parsed.run.id).every((phase: { lease?: unknown; updatedAt?: unknown }) => !phase.lease && typeof phase.updatedAt === "number")).toBe(true)
      expect(parsed.run.artifacts).toHaveLength(2)
      expect(await readFile(path.join(workspace, ".deveagent", "team-runs", parsed.run.id, "synthesis-input.md"), "utf8")).toContain("Persist Team phases")
      expect(await readFile(path.join(workspace, ".deveagent", "team-runs", parsed.run.id, "synthesis-output.md"), "utf8")).toContain("advisor")
      } finally {
        await rm(workspace, { recursive: true, force: true })
      }
    })
  })

  test("reviews synthesis artifacts before exposing a manual Executor recovery state", async () => {
    await withTeamRunStore(async () => {
      const workspace = await mkdtemp(path.join(tmpdir(), "deveagent-team-review-"))
      try {
        const sessionID = "orch_synthesis_review"
        setDeveAgentTeam({
          sessionID,
          enabled: true,
          runMode: "sequential",
          budgetTokens: 100_000,
          members: [
            { id: "p1", name: "Planner", role: "planner", providerID: "x", modelID: "y", enabled: true },
            { id: "r1", name: "Reviewer", role: "reviewer", providerID: "x", modelID: "y", enabled: true },
          ],
        })
        const tools = await teamTools(workspace)
        const output = await tools["team-dispatch-all"].execute(
          { task: "Review before Executor recovery" },
          teamContext(sessionID, async () => advisorResult(100), undefined, workspace),
        )
        const parsed = JSON.parse(output as string)
        const inspect = JSON.parse(await tools["team-review-synthesis"].execute(
          { runID: parsed.run.id, action: "inspect" },
          teamContext(sessionID, async () => advisorResult(1), undefined, workspace),
        ) as string)
        expect(inspect).toMatchObject({ reviewed: true, status: "pending", automaticExecutorReplay: false })
        expect(inspect.artifacts.output.preview).toContain("advisor")

        const confirmed = JSON.parse(await tools["team-review-synthesis"].execute(
          { runID: parsed.run.id, action: "confirm" },
          teamContext(sessionID, async () => advisorResult(1), undefined, workspace),
        ) as string)
        expect(confirmed).toMatchObject({
          reviewed: true,
          status: "confirmed",
          recoveryStatus: "ready-for-manual-recovery",
          automaticExecutorReplay: false,
        })
        const confirmedAt = getDeveAgentTeamRuns(sessionID).find((run) => run.id === parsed.run.id)?.synthesisReview?.reviewedAt

        const repeated = JSON.parse(await tools["team-review-synthesis"].execute(
          { runID: parsed.run.id, action: "confirm" },
          teamContext(sessionID, async () => advisorResult(1), undefined, workspace),
        ) as string)
        expect(repeated).toMatchObject({ reviewed: true, status: "confirmed", idempotent: true, automaticExecutorReplay: false })
        expect(repeated.summary).toBe(confirmed.summary)
        expect(getDeveAgentTeamRuns(sessionID).find((run) => run.id === parsed.run.id)?.synthesisReview?.reviewedAt).toBe(confirmedAt)
        expect(getDeveAgentTeamRuns(sessionID).find((run) => run.id === parsed.run.id)?.synthesisReview?.recoveryStatus).toBe("ready-for-manual-recovery")
      } finally {
        await rm(workspace, { recursive: true, force: true })
      }
    })
  })

  test("expires old synthesis evidence and never confirms it", async () => {
    await withTeamRunStore(async () => {
      const workspace = await mkdtemp(path.join(tmpdir(), "deveagent-team-review-expired-"))
      try {
        const sessionID = "orch_synthesis_expired"
        setDeveAgentTeam({
          sessionID,
          enabled: true,
          runMode: "sequential",
          budgetTokens: 100_000,
          members: [{ id: "p1", name: "Planner", role: "planner", providerID: "x", modelID: "y", enabled: true }],
        })
        const tools = await teamTools(workspace)
        const output = await tools["team-dispatch-all"].execute(
          { task: "Expire stale synthesis" },
          teamContext(sessionID, async () => advisorResult(100), undefined, workspace),
        )
        const parsed = JSON.parse(output as string)
        const createdAt = Math.max(...parsed.run.artifacts.map((artifact: { createdAt: number }) => artifact.createdAt))
        const expired = await reviewTeamSynthesisArtifacts({
          runID: parsed.run.id,
          sessionID,
          directory: workspace,
          action: "confirm",
          now: createdAt + 24 * 60 * 60 * 1_000 + 1,
        })
        expect(expired).toMatchObject({ reviewed: false, status: "expired", automaticExecutorReplay: false })
        expect(getDeveAgentTeamRuns(sessionID).find((run) => run.id === parsed.run.id)?.synthesisReview).toMatchObject({ status: "expired", recoveryStatus: "blocked" })
      } finally {
        await rm(workspace, { recursive: true, force: true })
      }
    })
  })

  test("renews only the active Team phase lease", async () => {
    await withTeamRunStore(async () => {
      const sessionID = "orch_phase_heartbeat"
      setDeveAgentTeam({
        sessionID,
        enabled: true,
        members: [{ id: "p1", name: "Planner", role: "planner", providerID: "x", modelID: "y", enabled: true }],
      })
      const tools = await teamTools()
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      let childStarted = false
      const pending = tools["team-dispatch"].execute(
        { memberID: "p1", task: "Renew the active Team lease" },
        teamContext(sessionID, async () => {
          childStarted = true
          await gate
          return advisorResult(1)
        }),
      ) as Promise<string>
      while (!childStarted) await new Promise((resolve) => setTimeout(resolve, 5))
      const run = getDeveAgentTeamRuns(sessionID)[0]
      const phase = getDeveAgentTeamPhases(sessionID).find((item) => item.id === run?.currentPhaseID)
      expect(phase?.lease?.token).toBe(run?.currentPhaseLeaseToken)
      const before = phase?.lease?.expiresAt ?? 0
      expect(await renewTeamPhaseLease(phase?.id, phase?.lease?.token, Date.now())).toBe(true)
      const renewed = getDeveAgentTeamPhases(sessionID).find((item) => item.id === phase?.id)
      expect(renewed?.lease?.expiresAt).toBeGreaterThanOrEqual(before)
      expect(await renewTeamPhaseLease(phase?.id, "stale-worker-token", Date.now())).toBe(false)
      release()
      await pending
    })
  })

  test("fences a stale Team worker after another process replaces its phase lease", async () => {
    await withTeamRunStore(async () => {
      const sessionID = "orch_stale_phase_worker"
      setDeveAgentTeam({
        sessionID,
        enabled: true,
        members: [{ id: "p1", name: "Planner", role: "planner", providerID: "x", modelID: "y", enabled: true }],
      })
      const tools = await teamTools()
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      let childStarted = false
      const pending = tools["team-dispatch"].execute(
        { memberID: "p1", task: "Fence stale phase worker" },
        teamContext(sessionID, async () => {
          childStarted = true
          await gate
          return advisorResult(1)
        }),
      ) as Promise<string>
      while (!childStarted) await new Promise((resolve) => setTimeout(resolve, 5))
      const run = getDeveAgentTeamRuns(sessionID)[0]
      expect(run?.currentPhaseID).toBeDefined()
      expect(run?.currentPhaseLeaseToken).toBeDefined()
      const store = path.join(process.env.XDG_CONFIG_HOME!, "opencode", "deveagent-team-runs.json")
      const persisted = JSON.parse(await readFile(store, "utf8"))
      const phase = persisted.phases.find((item: { id: string }) => item.id === run?.currentPhaseID)
      expect(phase).toBeDefined()
      phase.lease = { owner: "replacement-worker", token: "replacement-token", expiresAt: Date.now() + 60_000 }
      phase.status = "running"
      phase.updatedAt = Date.now() + 1_000
      await writeFile(store, JSON.stringify(persisted), "utf8")
      release()
      const result = JSON.parse(await pending)
      expect(result.run.status).toBe("running")
      const after = JSON.parse(await readFile(store, "utf8"))
      expect(after.phases.find((item: { id: string }) => item.id === run?.currentPhaseID)?.lease?.token).toBe("replacement-token")
    })
  })

  test("recovers persisted running team ledgers as interrupted instead of completed", () => {
    const recovered = recoverInterruptedTeamRuns([{
      id: "team-stale",
      sessionID: "orch_restart",
      task: "Inspect restart handling",
      runMode: "parallel",
      startedAt: 1,
      status: "running",
      members: [{ id: "planner", name: "Planner", attempts: 1 }],
      tokens: 0,
      cost: 0,
      budgetTokens: 10_000,
      budgetExceeded: false,
    }], 2)
    expect(recovered[0]).toMatchObject({ status: "interrupted", finishedAt: 2 })
    expect(recovered[0]?.members[0]).toMatchObject({ status: "unknown", error: expect.stringContaining("child status is unknown") })
  })

  test("does not offer automatic resume after a restart during synthesis or execution", () => {
    const recovered = recoverInterruptedTeamRuns([
      {
        id: "team-synthesis-stale",
        sessionID: "orch_restart",
        task: "Inspect synthesis recovery",
        runMode: "parallel",
        startedAt: 1,
        phase: "synthesis",
        status: "running",
        resume: { task: "Inspect synthesis recovery", memberIDs: ["planner"] },
        members: [{ id: "planner", name: "Planner", attempts: 1, status: "completed" }],
        tokens: 10,
        cost: 0,
        budgetTokens: 10_000,
        budgetExceeded: false,
      },
    ], 2)
    expect(recovered[0]).toMatchObject({
      status: "interrupted",
      phase: "synthesis",
      resume: undefined,
      stopReason: expect.stringContaining("synthesis phase"),
    })
  })

  test("preserves completed team ledgers during restart recovery", () => {
    const completed = recoverInterruptedTeamRuns([{
      id: "team-done",
      sessionID: "orch_restart",
      task: "Inspect completed handling",
      runMode: "sequential",
      startedAt: 1,
      finishedAt: 2,
      status: "completed",
      members: [],
      tokens: 10,
      cost: 0,
      budgetTokens: 10_000,
      budgetExceeded: false,
    }], 3)
    expect(completed[0]).toMatchObject({ status: "completed", finishedAt: 2 })
  })

  test("reconciles persisted child sessions against the native Session API", async () => {
    const run = {
      id: "team-reconcile",
      sessionID: "orch_reconcile",
      task: "Reconcile children",
      runMode: "parallel" as const,
      startedAt: 1,
      status: "interrupted" as const,
      members: [
        { id: "p1", name: "Planner", attempts: 1, childSessionID: "ses_child_busy" },
        { id: "r1", name: "Reviewer", attempts: 1, childSessionID: "ses_missing" },
        { id: "x1", name: "Foreign", attempts: 1, childSessionID: "ses_foreign" },
      ],
      tokens: 0,
      cost: 0,
      budgetTokens: 10_000,
      budgetExceeded: false,
    }
    const result = await reconcileTeamRunChildren({
      directory: "C:/workspace",
      run,
      client: {
        session: {
          status: async () => ({ data: { ses_child_busy: { type: "busy" } } }),
          get: async ({ path: { id } }: { path: { id: string } }) => {
            if (id === "ses_missing") throw new Error("404 NotFoundError")
            return { data: { id, parentID: id === "ses_foreign" ? "other-parent" : "orch_reconcile" } }
          },
        },
      },
    })
    expect(result).toEqual([
      { memberID: "p1", childSessionID: "ses_child_busy", state: "available", status: "busy" },
      { memberID: "r1", childSessionID: "ses_missing", state: "missing" },
      { memberID: "x1", childSessionID: "ses_foreign", state: "foreign" },
    ])
  })

  test("explicitly resumes a persisted interrupted advisor plan as new read-only child work", async () => {
    await withTeamRunStore(async () => {
      const sessionID = "orch_resume_advisors"
      setDeveAgentTeam({
        sessionID,
        enabled: true,
        runMode: "parallel",
        budgetTokens: 10_000,
        members: [
          { id: "p1", name: "Planner", role: "planner", providerID: "x", modelID: "y", enabled: true },
          { id: "r1", name: "Reviewer", role: "reviewer", providerID: "x", modelID: "y", enabled: true },
          { id: "e1", name: "Executor", role: "executor", providerID: "x", modelID: "y", enabled: true },
        ],
      })
      const store = path.join(process.env.XDG_CONFIG_HOME!, "opencode", "deveagent-team-runs.json")
      await mkdir(path.dirname(store), { recursive: true })
      await writeFile(store, JSON.stringify({
        version: 1,
        runs: [{
          id: "team-resume-source",
          sessionID,
          task: "Review the migration",
          runMode: "parallel",
          startedAt: 1,
          status: "running",
          resume: { task: "Review the migration before implementation", memberIDs: ["p1", "r1", "e1"] },
          members: [{ id: "p1", name: "Planner", attempts: 1, childSessionID: "ses_persisted_planner" }],
          tokens: 0,
          cost: 0,
          budgetTokens: 10_000,
          budgetExceeded: false,
        }],
      }), "utf8")
      await loadDeveAgentTeamRuns()
      const calls: TeamTaskInput[] = []
      const tools = await teamTools()
      const output = await tools["team-resume-interrupted"].execute(
        { runID: "team-resume-source" },
        teamContext(sessionID, async (input) => {
          calls.push(input)
          return advisorResult(200)
        }),
      )
      const parsed = JSON.parse(output as string)
      expect(parsed.resumedFrom).toBe("team-resume-source")
      expect(calls).toHaveLength(2)
      expect(calls.every((input) => input.read_only)).toBe(true)
      expect(calls.every((input) => input.prompt.includes("Review the migration before implementation"))).toBe(true)
      expect(calls.find((input) => input.task_id === "ses_persisted_planner")).toBeDefined()
      expect(calls.filter((input) => input.task_id).length).toBe(1)
      const runs = getDeveAgentTeamRuns(sessionID)
      expect(runs.find((run) => run.id === "team-resume-source")).toMatchObject({ status: "interrupted" })
      expect(runs.find((run) => run.resumedFrom === "team-resume-source")).toMatchObject({
        status: "completed",
        resume: { memberIDs: ["p1", "r1"] },
      })
    })
  })

  test("resume skips advisor members already completed before restart", async () => {
    await withTeamRunStore(async () => {
      const sessionID = "orch_resume_completed"
      setDeveAgentTeam({
        sessionID,
        enabled: true,
        runMode: "parallel",
        budgetTokens: 10_000,
        members: [
          { id: "p1", name: "Planner", role: "planner", providerID: "x", modelID: "y", enabled: true },
          { id: "r1", name: "Reviewer", role: "reviewer", providerID: "x", modelID: "y", enabled: true },
          { id: "e1", name: "Executor", role: "executor", providerID: "x", modelID: "y", enabled: true },
        ],
      })
      const store = path.join(process.env.XDG_CONFIG_HOME!, "opencode", "deveagent-team-runs.json")
      await mkdir(path.dirname(store), { recursive: true })
      await writeFile(store, JSON.stringify({
        version: 1,
        runs: [{
          id: "team-resume-completed-source",
          sessionID,
          task: "Review the migration",
          runMode: "parallel",
          startedAt: 1,
          phase: "advisors",
          status: "running",
          resume: { task: "Review the migration before implementation", memberIDs: ["p1", "r1", "e1"] },
          members: [
            { id: "p1", name: "Planner", attempts: 1, status: "completed", childSessionID: "ses_persisted_planner" },
            { id: "r1", name: "Reviewer", attempts: 1, status: "running", childSessionID: "ses_persisted_reviewer" },
          ],
          tokens: 200,
          cost: 0,
          budgetTokens: 10_000,
          budgetExceeded: false,
        }],
      }), "utf8")
      await loadDeveAgentTeamRuns()
      const calls: TeamTaskInput[] = []
      const tools = await teamTools()
      const output = await tools["team-resume-interrupted"].execute(
        { runID: "team-resume-completed-source" },
        teamContext(sessionID, async (input) => {
          calls.push(input)
          return advisorResult(200)
        }),
      )
      const parsed = JSON.parse(output as string)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.description).toContain("Reviewer")
      expect(calls[0]?.task_id).toBe("ses_persisted_reviewer")
      expect(parsed.run).toMatchObject({
        status: "completed",
        resume: { memberIDs: ["r1"] },
      })
    })
  })

  test("explicitly retries only failed advisors from a persisted failed run", async () => {
    await withTeamRunStore(async () => {
      const sessionID = "orch_retry_failed"
      setDeveAgentTeam({
        sessionID,
        enabled: true,
        runMode: "sequential",
        budgetTokens: 10_000,
        members: [
          { id: "p1", name: "Planner", role: "planner", providerID: "x", modelID: "y", enabled: true },
          { id: "r1", name: "Reviewer", role: "reviewer", providerID: "x", modelID: "y", enabled: true },
          { id: "e1", name: "Executor", role: "executor", providerID: "x", modelID: "y", enabled: true },
        ],
      })
      const store = path.join(process.env.XDG_CONFIG_HOME!, "opencode", "deveagent-team-runs.json")
      await mkdir(path.dirname(store), { recursive: true })
      await writeFile(store, JSON.stringify({
        version: 1,
        runs: [{
          id: "team-retry-source",
          sessionID,
          task: "Review the migration",
          runMode: "sequential",
          startedAt: 1,
          status: "failed",
          resume: { task: "Review the migration before implementation", memberIDs: ["p1", "r1", "e1"] },
          members: [
            { id: "p1", name: "Planner", attempts: 2, status: "failed", error: "planner exploded" },
            { id: "r1", name: "Reviewer", attempts: 1, status: "completed" },
            { id: "e1", name: "Executor", attempts: 1, status: "failed", error: "executor failed" },
          ],
          tokens: 0,
          cost: 0,
          budgetTokens: 10_000,
          budgetExceeded: true,
        }],
      }), "utf8")
      await loadDeveAgentTeamRuns()
      const calls: TeamTaskInput[] = []
      const tools = await teamTools()
      const output = await tools["team-resume-interrupted"].execute(
        { runID: "team-retry-source", mode: "retry" },
        teamContext(sessionID, async (input) => {
          calls.push(input)
          return advisorResult(200)
        }),
      )
      const parsed = JSON.parse(output as string)
      expect(parsed.resumedFrom).toBe("team-retry-source")
      expect(parsed.mode).toBe("retry")
      expect(calls).toHaveLength(1)
      expect(calls[0]?.description).toContain("Planner")
      expect(calls[0]?.read_only).toBe(true)
      expect(calls[0]?.task_id).toBeUndefined()
      expect(parsed.run).toMatchObject({
        status: "completed",
        resumedFrom: "team-retry-source",
        resume: { memberIDs: ["p1"] },
      })
    })
  })

  test("parallel dispatch limits simultaneous advisor child sessions", async () => {
    await withTeamRunStore(async () => {
      const sessionID = "orch_par_concurrency"
      setDeveAgentTeam({
        sessionID,
        enabled: true,
        runMode: "parallel",
        maxRetries: 0,
        budgetTokens: 100_000,
        members: [
          { id: "p1", name: "Planner", role: "planner", providerID: "x", modelID: "y", enabled: true },
          { id: "c1", name: "Critic", role: "critic", providerID: "x", modelID: "y", enabled: true },
          { id: "v1", name: "Verifier", role: "verifier", providerID: "x", modelID: "y", enabled: true },
          { id: "t1", name: "Tester", role: "custom", providerID: "x", modelID: "y", enabled: true },
        ],
      })
      let active = 0
      let maximum = 0
      const tools = await teamTools()
      const output = await tools["team-dispatch-all"].execute(
        { task: "Check concurrency" },
        teamContext(sessionID, async () => {
          active += 1
          maximum = Math.max(maximum, active)
          await new Promise((resolve) => setTimeout(resolve, 15))
          active -= 1
          return advisorResult(100)
        }),
      )
      const parsed = JSON.parse(output as string)
      expect(parsed.results).toHaveLength(4)
      expect(maximum).toBe(3)
    })
  })

  test("parallel dispatch reclaims unused budget for queued advisors", async () => {
    await withTeamRunStore(async () => {
      const sessionID = "orch_par_reclaim"
      setDeveAgentTeam({
        sessionID,
        enabled: true,
        runMode: "parallel",
        maxRetries: 0,
        budgetTokens: 100_000,
        childMaxOutputTokens: 32_000,
        members: [
          { id: "p1", name: "Planner", role: "planner", providerID: "x", modelID: "y", enabled: true },
          { id: "c1", name: "Critic", role: "critic", providerID: "x", modelID: "y", enabled: true },
          { id: "r1", name: "Researcher", role: "researcher", providerID: "x", modelID: "y", enabled: true },
          { id: "t1", name: "Tester", role: "custom", providerID: "x", modelID: "y", enabled: true },
        ],
      })
      const caps: number[] = []
      let calls = 0
      const tools = await teamTools()
      await tools["team-dispatch-all"].execute(
        { task: "Reclaim released parallel budget" },
        teamContext(sessionID, async (input) => {
          calls += 1
          caps.push((input as TeamTaskInput & { max_output_tokens?: number }).max_output_tokens ?? 0)
          if (calls <= 3) await new Promise((resolve) => setTimeout(resolve, 15))
          return advisorResult(1_000)
        }),
      )
      // Four advisors start in three slots. The fourth sees released room and gets
      // the configured child cap instead of the original equal 25k reservation.
      expect(caps.slice(0, 4).sort((a, b) => a - b)).toEqual([25_000, 25_000, 25_000, 32_000])
    })
  })

  test("team-runs are aggregated and isolated per session", async () => {
    await withTeamRunStore(async () => {
      for (const sessionID of ["orch_iso_a", "orch_iso_b"]) {
        setDeveAgentTeam({
          sessionID,
          enabled: true,
          members: [{ id: "p1", name: "Planner", role: "planner", providerID: "x", modelID: "y", enabled: true }],
        })
      }
      const tools = await teamTools()
      for (const sessionID of ["orch_iso_a", "orch_iso_b"]) {
        await tools["team-dispatch"].execute(
          { memberID: "p1", task: `task for ${sessionID}` },
          teamContext(sessionID, async () => advisorResult(100)),
        )
      }
      const runsA = getDeveAgentTeamRuns("orch_iso_a")
      expect(runsA.length).toBeGreaterThan(0)
      expect(runsA.every((run) => run.sessionID === "orch_iso_a")).toBe(true)
      const listed = JSON.parse(
        await tools["team-runs"].execute({}, teamContext("orch_iso_b", async () => advisorResult(100))) as string,
      ) as { sessionID: string }[]
      expect(listed.length).toBeGreaterThan(0)
      expect(listed.every((run) => run.sessionID === "orch_iso_b")).toBe(true)
      expect(listed.some((run) => run.sessionID === "orch_iso_a")).toBe(false)
    })
  })

  test("team runs retain the native child session id when TaskTool returns one", async () => {
    await withTeamRunStore(async () => {
      const sessionID = "orch_child_link"
      setDeveAgentTeam({
        sessionID,
        enabled: true,
        members: [{ id: "p1", name: "Planner", role: "planner", providerID: "x", modelID: "y", enabled: true }],
      })
      const tools = await teamTools()
      await tools["team-dispatch"].execute(
        { memberID: "p1", task: "Link the native child" },
        teamContext(sessionID, async () => ({
          ...advisorResult(100),
          output: '<task id="ses_real_child" state="completed"><task_result>ok</task_result></task>',
        })),
      )
      expect(getDeveAgentTeamRuns(sessionID)[0]?.members[0]?.childSessionID).toBe("ses_real_child")
    })
  })

  test("background-capable hosts persist the native child identity before waiting", async () => {
    await withTeamRunStore(async () => {
      const sessionID = "orch_background_link"
      setDeveAgentTeam({
        sessionID,
        enabled: true,
        members: [{ id: "p1", name: "Planner", role: "planner", providerID: "x", modelID: "y", enabled: true }],
      })
      const tools = await teamTools()
      let startedBackground = false
      let childPersistedBeforeWait = false
      await tools["team-dispatch"].execute(
        { memberID: "p1", task: "Link the background child" },
        teamContext(
          sessionID,
          async (input) => {
            startedBackground = input.background === true
            return {
              ...advisorResult(0),
              output: '<task id="ses_background_child" state="running"><task_result>running</task_result></task>',
              metadata: { jobId: "job_background_child", sessionId: "ses_background_child", background: true },
            }
          },
          async ({ jobID }) => {
            const persisted = JSON.parse(await readFile(path.join(process.env.XDG_CONFIG_HOME!, "opencode", "deveagent-team-runs.json"), "utf8"))
            const currentRun = getDeveAgentTeamRuns(sessionID)[0]
            const persistedRun = persisted.runs?.find((item: { id?: unknown }) => item.id === currentRun?.id)
            childPersistedBeforeWait = jobID === "job_background_child" &&
              currentRun?.members[0]?.childSessionID === "ses_background_child" &&
              persistedRun?.members[0]?.childSessionID === "ses_background_child"
            return {
              ...advisorResult(125),
              metadata: { usage: { total: 125, input: 25, output: 100 }, sessionId: "ses_background_child" },
            }
          },
        ),
      )
      expect(startedBackground).toBe(true)
      expect(childPersistedBeforeWait).toBe(true)
      expect(getDeveAgentTeamRuns(sessionID)[0]?.members[0]).toMatchObject({
        childSessionID: "ses_background_child",
        jobID: "job_background_child",
        status: "completed",
        tokens: 125,
      })
    })
  })

  test("completed team dispatch persists compact outcome metadata to workspace Memory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-team-memory-"))
    const sessionID = "orch_memory"
    try {
      setDeveAgentTeam({
        sessionID,
        enabled: true,
        runMode: "sequential",
        budgetTokens: 10_000,
        members: [{ id: "p1", name: "Planner", role: "planner", providerID: "x", modelID: "y", enabled: true }],
      })
      const tools = await teamTools(directory)
      await tools["team-dispatch-all"].execute(
        { task: "Summarize the cache approach" },
        teamContext(sessionID, async () => advisorResult(100)),
      )
      const decisions = (await getDeveAgentMemoryTree({ directory })).groups.find((group) => group.kind === "decision")?.entries ?? []
      expect(decisions[0]?.summary).toContain("Mode: sequential")
      expect(decisions[0]?.summary).toContain("Advisor results: 1/1 succeeded")
      expect(decisions[0]?.summary).not.toContain("metadata: {")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe("computer-use tool permission gates", () => {
  type AskInput = { permission: string; patterns: string[]; always: string[]; metadata?: Record<string, unknown> }
  type HostRequest = (action: string, payload?: unknown) => Promise<unknown>

  async function cuTools(directory = ".") {
    const hooks = await deveagentPlugin.server({ client: {}, directory, worktree: directory } as unknown as Parameters<typeof deveagentPlugin.server>[0])
    return hooks.tool!
  }

  function cuContext(options: { deny?: boolean; directory?: string } = {}) {
    const asks: AskInput[] = []
    const context = {
      sessionID: "cu-gate-test",
      messageID: "msg-test",
      agent: "build",
      directory: options.directory ?? ".",
      worktree: options.directory ?? ".",
      abort: new AbortController().signal,
      metadata: () => undefined,
      ask: async (input: AskInput) => {
        asks.push(input)
        if (options.deny) throw new Error("Permission denied by user")
      },
    } as unknown as ToolContext
    return { context, asks }
  }

  async function withHostRequest(handler: HostRequest | undefined, fn: (calls: { action: string; payload?: unknown }[]) => Promise<void>) {
    const calls: { action: string; payload?: unknown }[] = []
    const previous = (globalThis as any).__deveagent_host_request
    if (handler) {
      ;(globalThis as any).__deveagent_host_request = (async (action: string, payload?: unknown) => {
        calls.push({ action, payload })
        return handler(action, payload)
      }) satisfies HostRequest
    } else {
      delete (globalThis as any).__deveagent_host_request
    }
    try {
      await fn(calls)
    } finally {
      if (previous === undefined) delete (globalThis as any).__deveagent_host_request
      else (globalThis as any).__deveagent_host_request = previous
    }
  }

  // Runs execute and captures either the returned string or a thrown error, so both
  // error surfacing styles (returned message vs propagated denial) can be asserted.
  async function run(execute: () => Promise<unknown>): Promise<string> {
    try {
      return String(await execute())
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  const gatedTools: { name: string; args: Record<string, unknown>; permission: string; hostAction: string }[] = [
    // 1.1.1.1 is a public IP literal: dns.lookup short-circuits without network access.
    { name: "browser-navigate", args: { url: "http://1.1.1.1/" }, permission: "webfetch", hostAction: "browser.navigate" },
    { name: "browser-interact", args: { action: "click", selector: "#ok" }, permission: "computer-use", hostAction: "browser.click" },
    { name: "browser-control", args: { action: "back" }, permission: "computer-use", hostAction: "browser.back" },
    { name: "browser-snapshot", args: {}, permission: "computer-use", hostAction: "browser.snapshot" },
    { name: "computer-use-click", args: { x: 10, y: 20 }, permission: "computer-use", hostAction: "desktop.click" },
    { name: "computer-use-key", args: { key: "Enter" }, permission: "computer-use", hostAction: "desktop.key" },
    { name: "computer-use-scroll", args: { deltaY: 100 }, permission: "computer-use", hostAction: "desktop.scroll" },
    { name: "computer-use-screenshot", args: { target: "desktop" }, permission: "computer-use", hostAction: "desktop.screenshot" },
  ]

  test("every computer-use tool requests permission before its host action and a denial blocks the action", async () => {
    const tools = await cuTools()
    for (const item of gatedTools) {
      await withHostRequest(async () => (item.name === "browser-navigate" ? { text: "ok" } : { ok: true }), async (calls) => {
        const granted = cuContext()
        await run(() => tools[item.name].execute(item.args, granted.context))
        expect(granted.asks).toHaveLength(1)
        expect(granted.asks[0].permission).toBe(item.permission)
        expect(granted.asks[0].metadata?.source).toBe(`deveagent.${item.name}`)
        expect(calls.map((call) => call.action)).toEqual([item.hostAction])

        calls.length = 0
        const denied = cuContext({ deny: true })
        await run(() => tools[item.name].execute(item.args, denied.context))
        expect(denied.asks).toHaveLength(1)
        expect(calls).toEqual([])
      })
    }
  })

  test("permission is still requested before reporting a missing desktop host", async () => {
    const tools = await cuTools()
    await withHostRequest(undefined, async (calls) => {
      const { context, asks } = cuContext()
      const output = await run(() => tools["computer-use-click"].execute({ x: 1, y: 1 }, context))
      expect(asks).toHaveLength(1)
      expect(output).toContain("unavailable outside the desktop host")
      expect(calls).toEqual([])
    })
  })

  test("browser navigation rejects private and disallowed URLs before permission, fetch, or host action", async () => {
    const tools = await cuTools()
    const blocked = [
      "http://127.0.0.1/",
      "http://10.0.0.8/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/",
      "http://localhost:8080/",
      "https://user:secret@example.com/",
      "ftp://example.com/file",
      "file:///C:/Windows/win.ini",
      "not a url",
    ]
    await withHostRequest(async () => ({ text: "should never happen" }), async (calls) => {
      for (const url of blocked) {
        const { context, asks } = cuContext()
        const output = await run(() => tools["browser-navigate"].execute({ url }, context))
        expect(output).toContain("Navigation failed")
        expect(asks).toEqual([])
      }
      expect(calls).toEqual([])
    })
  })

  test("browser navigation reports host and network failures as readable errors", async () => {
    const tools = await cuTools()
    await withHostRequest(async () => {
      throw new Error("sandbox window exploded")
    }, async () => {
      const { context, asks } = cuContext()
      const output = await run(() => tools["browser-navigate"].execute({ url: "http://1.1.1.1/" }, context))
      expect(asks).toHaveLength(1)
      expect(output).toBe("Navigation failed: sandbox window exploded")
    })
  })

  test("browser-interact rejects non-whitelist actions with a readable error and no permission prompt", async () => {
    const tools = await cuTools()
    await withHostRequest(async () => ({}), async (calls) => {
      for (const action of ["eval", "execute", "hover", ""]) {
        const { context, asks } = cuContext()
        const output = await run(() => tools["browser-interact"].execute({ action, selector: "#x" }, context))
        expect(output).toContain("action must be click, type, key, scroll, or wait")
        expect(asks).toEqual([])
      }
      expect(calls).toEqual([])
    })
  })

  test("browser-interact clamps scroll and wait bounds before dispatching to the host", async () => {
    const tools = await cuTools()
    await withHostRequest(async () => ({ ok: true }), async (calls) => {
      const { context, asks } = cuContext()
      await run(() => tools["browser-interact"].execute({ action: "scroll", deltaY: 5000 }, context))
      await run(() => tools["browser-interact"].execute({ action: "scroll", deltaY: -9999 }, context))
      await run(() => tools["browser-interact"].execute({ action: "wait", selector: "#x", timeoutMs: 99_999 }, context))
      await run(() => tools["browser-interact"].execute({ action: "wait", selector: "#x", timeoutMs: 1 }, context))
      expect(asks).toHaveLength(4)
      expect(asks.every((ask) => ask.permission === "computer-use")).toBe(true)
      expect(calls[0]).toMatchObject({ action: "browser.scroll", payload: { deltaY: 1000 } })
      expect(calls[1]).toMatchObject({ action: "browser.scroll", payload: { deltaY: -1000 } })
      expect(calls[2]).toMatchObject({ action: "browser.wait", payload: { timeoutMs: 10_000 } })
      expect(calls[3]).toMatchObject({ action: "browser.wait", payload: { timeoutMs: 250 } })
    })
  })

  test("computer-use-key rejects non-allowlisted keys before asking permission", async () => {
    const tools = await cuTools()
    await withHostRequest(async () => ({}), async (calls) => {
      for (const key of ["a", "Delete", "F4", "enter"]) {
        const { context, asks } = cuContext()
        const output = await run(() => tools["computer-use-key"].execute({ key }, context))
        expect(output).toBe("Desktop key failed: key is not allowlisted.")
        expect(asks).toEqual([])
      }
      expect(calls).toEqual([])
    })
  })

  test("computer-use-scroll rejects out-of-range deltas with a readable error and no permission prompt", async () => {
    const tools = await cuTools()
    await withHostRequest(async () => ({}), async (calls) => {
      for (const deltaY of [1001, -5000, 0, Number.NaN]) {
        const { context, asks } = cuContext()
        const output = await run(() => tools["computer-use-scroll"].execute({ deltaY }, context))
        expect(output).toBe("Desktop scroll failed: deltaY must be between -1000 and 1000.")
        expect(asks).toEqual([])
      }
      expect(calls).toEqual([])
    })
  })

  test("computer-use-shell rejects injection and write-capable commands before permission", async () => {
    const cases = [
      "git status & whoami",
      "node -e \"require('fs').rmSync('.')\"",
      "git -C .. status",
      "git commit -am broken",
      "git diff --ext-diff",
      "git -p status",
      "git --paginate status",
      "rg --hidden -n .",
      "rg --no-ignore -n .",
      "rg -n . ..\\outside",
      "rg --glob=../* -n .",
      "rg -n . C:relative",
      "rg -n . \\\\?\\C:\\outside",
      "powershell -EncodedCommand ZQBjAGgAbwAgAGkA",
      // Deep-review additions (Round 83): write-capable git flags, symlink
      // following, runtime eval, and quote-wrapped operator smuggling.
      "git diff --no-index a b",
      "git log --output=../../outside.txt",
      "git log --output=outside.txt",
      "git log --work-tree=.. status",
      "rg -L .",
      "python -c \"print('x')\"",
      "bun -e \"process.exit(1)\"",
      'git status ";whoami"',
    ]
    for (const command of cases) {
      const parsed = parseDeveAgentComputerUseShellCommand(command)
      expect(parsed.ok).toBe(false)
    }

    // Positive controls: allowlisted read-only shapes still parse.
    expect(parseDeveAgentComputerUseShellCommand("git status --short").ok).toBe(true)
    expect(parseDeveAgentComputerUseShellCommand("where git").ok).toBe(true)
    expect(parseDeveAgentComputerUseShellCommand("node --version").ok).toBe(true)
    expect(parseDeveAgentComputerUseShellCommand("where").ok).toBe(false)

    const tools = await cuTools()
    const { context, asks } = cuContext()
    const output = JSON.parse(await run(() => tools["computer-use-shell"].execute({ command: "git status & whoami" }, context)))
    expect(output.ok).toBe(false)
    expect(asks).toEqual([])
  })

  test("computer-use-shell runs an allowlisted read-only command after permission", async () => {
    const directory = process.cwd()
    const tools = await cuTools(directory)
    const { context, asks } = cuContext({ directory })
    const output = JSON.parse(await run(() => tools["computer-use-shell"].execute({ command: "git status --short" }, context)))
    expect(asks).toHaveLength(1)
    expect(asks[0].permission).toBe("computer-use")
    expect(asks[0].metadata?.source).toBe("deveagent.computer-use-shell")
    expect(output.ok).toBe(true)
    expect(output.cwd).toBe(".")
    expect(output.executable).toBe("git")
  })
})

describe("role-profile model validation", () => {
  const providerListClient = (providers: unknown) => ({
    provider: { list: async () => ({ data: { all: providers } }) },
  })

  test("resolvable provider/model returns no warning", async () => {
    const client = providerListClient([{ id: "openai", models: { "gpt-4o": {} } }])
    expect(await checkRoleProfileModel("openai", "gpt-4o", client)).toBeUndefined()
  })

  test("missing model warns but does not throw", async () => {
    const client = providerListClient([{ id: "openai", models: { "gpt-4o": {} } }])
    const warning = await checkRoleProfileModel("openai", "gpt-5", client)
    expect(warning).toContain("openai/gpt-5")
    expect(warning).toContain("fall back to the default model")
  })

  test("missing provider warns but does not throw", async () => {
    const client = providerListClient([{ id: "openai", models: {} }])
    const warning = await checkRoleProfileModel("anthropic", "claude-1", client)
    expect(warning).toContain("anthropic")
  })

  test("legacy array-shaped provider list is supported", async () => {
    const client = { provider: { list: async () => ({ data: [{ id: "deepseek", models: { "deepseek-chat": {} } }] }) } }
    expect(await checkRoleProfileModel("deepseek", "deepseek-chat", client)).toBeUndefined()
  })

  test("v1 SDK body shape ({ all }) is supported and warns for missing models", async () => {
    // The real v1 SDK client resolves to the response body itself, not a
    // { data } envelope — the production shape this check previously missed.
    const client = { provider: { list: async () => ({ all: [{ id: "text-test", models: { "text-model": {} } }] }) } }
    expect(await checkRoleProfileModel("text-test", "text-model", client)).toBeUndefined()
    const warning = await checkRoleProfileModel("text-test", "nonexistent-model", client)
    expect(warning).toContain("text-test/nonexistent-model")
    expect(warning).toContain("fall back to the default model")
  })

  test("provider list outage degrades to no warning", async () => {
    const client = { provider: { list: async () => { throw new Error("down") } } }
    expect(await checkRoleProfileModel("openai", "gpt-4o", client)).toBeUndefined()
  })

  test("no client available degrades to no warning", async () => {
    expect(await checkRoleProfileModel("openai", "gpt-4o", {})).toBeUndefined()
  })

  test("config snapshot validates when the SDK provider list is unavailable", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-role-snapshot-"))
    const hooks = await deveagentPlugin.server({ client: {}, directory } as unknown as Parameters<typeof deveagentPlugin.server>[0])
    await hooks.config?.({ provider: { "text-test": { models: { "text-model": {} } } } } as any)
    // A client whose list resolves to an unrecognizable shape forces the
    // snapshot fallback (mirrors the packaged runtime where the SDK list is
    // not usable).
    const client = { provider: { list: async () => ({}) } }
    expect(await checkRoleProfileModel("text-test", "text-model", client)).toBeUndefined()
    const warning = await checkRoleProfileModel("text-test", "nonexistent-model", client)
    expect(warning).toContain("text-test/nonexistent-model")
    expect(warning).toContain("fall back to the default model")
    expect(await checkRoleProfileModel("unknown-provider", "x", client)).toBeUndefined()
  })

  test("config snapshot validates when the SDK provider list throws", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-role-snapshot-throw-"))
    const hooks = await deveagentPlugin.server({ client: {}, directory } as unknown as Parameters<typeof deveagentPlugin.server>[0])
    await hooks.config?.({ provider: { "text-test": { models: { "text-model": {} } } } } as any)
    const client = { provider: { list: async () => { throw new Error("down") } } }
    expect(await checkRoleProfileModel("text-test", "text-model", client)).toBeUndefined()
    const warning = await checkRoleProfileModel("text-test", "nonexistent-model", client)
    expect(warning).toContain("text-test/nonexistent-model")
  })
})

describe("turn-tail runtime state (byte-stable system prompt)", () => {
  const emptyTurn = async (hooks: any, sessionID: string, parts: any[]) => {
    await (hooks as any)["chat.message"]({ sessionID }, { message: {}, parts })
  }

  test("state rides the user turn once and re-emits only on change", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-turn-tail-"))
    const sessionID = "turn-tail-diff"
    try {
      setDeveAgentState({ mode: "craft", selectedSkills: [], selectedExpert: undefined, expertTeam: [] })
      const hooks = await deveagentPlugin.server({ client: {}, directory } as unknown as Parameters<typeof deveagentPlugin.server>[0])

      const first: any[] = [{ type: "text", text: "" }]
      await emptyTurn(hooks, sessionID, first)
      expect(first.length).toBe(2)
      expect(first.at(-1).synthetic).toBe(true)
      expect(first.at(-1).text).toContain("## DeveAgent Runtime State")

      // Same state -> no duplicate emission.
      const second: any[] = [{ type: "text", text: "" }]
      await emptyTurn(hooks, sessionID, second)
      expect(second.length).toBe(1)

      // State changed -> re-emit once.
      setDeveAgentState({ mode: "ask" })
      const third: any[] = [{ type: "text", text: "" }]
      await emptyTurn(hooks, sessionID, third)
      expect(third.length).toBe(2)
      expect(third.at(-1).text).toContain("mode: Ask")

      // Compaction resets the marker -> next turn re-emits.
      resetTurnTailState(sessionID)
      const fourth: any[] = [{ type: "text", text: "" }]
      await emptyTurn(hooks, sessionID, fourth)
      expect(fourth.length).toBe(2)
    } finally {
      setDeveAgentState({ mode: "craft" })
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("verified goal emits Goal Verified and never the continue blocks", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-turn-tail-goal-"))
    const sessionID = "turn-tail-goal-verified"
    try {
      setDeveAgentState({ mode: "goal", selectedSkills: [], selectedExpert: undefined, expertTeam: [] })
      setGoal({ description: "Ship the milestone", criteria: ["A"], sessionID })
      verifyGoal({ met: true, sessionID })
      const hooks = await deveagentPlugin.server({ client: {}, directory } as unknown as Parameters<typeof deveagentPlugin.server>[0])
      const parts: any[] = [{ type: "text", text: "" }]
      await emptyTurn(hooks, sessionID, parts)
      const snapshot = parts.at(-1).text
      expect(snapshot).toContain("## Goal Verified")
      expect(snapshot).not.toContain("## Goal Autonomous Loop")
      expect(snapshot).not.toContain("## Active Goal")
    } finally {
      clearGoal(sessionID)
      setDeveAgentState({ mode: "craft" })
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("system prompt stays byte-stable across state changes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-turn-tail-system-"))
    try {
      setDeveAgentState({ mode: "craft", selectedSkills: [], selectedExpert: undefined, expertTeam: [] })
      const hooks = await deveagentPlugin.server({ client: {}, directory } as unknown as Parameters<typeof deveagentPlugin.server>[0])
      const before: { system?: string[] } = {}
      await (hooks as any)["experimental.chat.system.transform"]({ sessionID: "system-stable" }, before)
      setDeveAgentState({ mode: "ask" })
      const after: { system?: string[] } = {}
      await (hooks as any)["experimental.chat.system.transform"]({ sessionID: "system-stable" }, after)
      expect(after.system?.join("\n")).toBe(before.system?.join("\n"))
      expect(after.system?.join("\n")).not.toContain("## DeveAgent Runtime State")
      expect(after.system?.join("\n")).not.toContain("## Active Goal")
      expect(after.system?.join("\n")).toContain("<deveagent-runtime-state>")
    } finally {
      setDeveAgentState({ mode: "craft" })
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe("prefix-shape diagnostics", () => {
  test("shape hashes are stable for identical input and split system/tools", () => {
    const input = { system: ["s1"], tools: { x: { description: "d", inputSchema: { type: "object", properties: { a: { type: "string" } } } }, y: { description: "e" } } }
    const a = computePrefixShape(input)
    const b = computePrefixShape({ ...input, tools: { ...input.tools } })
    expect(a).toEqual(b)
    expect(a.systemHash).not.toBe(a.toolsHash)
  })

  test("inputSchema changes are visible in the tools hash", () => {
    const withSchema = (schema: unknown) =>
      computePrefixShape({ system: ["s"], tools: { t: { description: "d", inputSchema: schema } } })
    expect(withSchema(z.object({ a: z.string() })).toolsHash).not.toBe(withSchema(z.object({ a: z.number() })).toolsHash)
  })

  test("record attributes system vs tools changes and persists the last reason", () => {
    const shape = (system: string, desc: string) => computePrefixShape({ system: [system], tools: { t: { description: desc } } })
    const initial = recordPrefixShape("shape-session", shape("s", "d"))
    expect(initial.lastReason).toBe("none")
    expect(initial.changes).toBe(0)

    const same = recordPrefixShape("shape-session", shape("s", "d"))
    expect(same.lastReason).toBe("none")
    expect(same.changes).toBe(0)

    const sys = recordPrefixShape("shape-session", shape("s2", "d"))
    expect(sys.lastReason).toBe("system")
    expect(sys.changes).toBe(1)
    expect(sys.lastChangedAt).toBeTypeOf("number")

    // A quiet request must NOT reset the reason back to "none".
    const quiet = recordPrefixShape("shape-session", shape("s2", "d"))
    expect(quiet.lastReason).toBe("system")
    expect(quiet.changes).toBe(1)

    const tool = recordPrefixShape("shape-session", shape("s2", "d2"))
    expect(tool.lastReason).toBe("tools")
    expect(tool.changes).toBe(2)

    const snap = prefixShapeSnapshot("shape-session")
    expect(snap?.toolsHash).toBe(shape("s2", "d2").toolsHash)
    expect(prefixShapeSnapshot("missing")).toBeNull()
  })

  test("chat.tools hook records the per-request shape", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-shape-hook-"))
    try {
      const hooks = await deveagentPlugin.server({ client: {}, directory } as unknown as Parameters<typeof deveagentPlugin.server>[0])
      await (hooks as any)["chat.tools"]({ sessionID: "shape-hook" }, { system: ["p"], tools: { a: { description: "x" } } })
      expect(prefixShapeSnapshot("shape-hook")?.lastReason).toBe("none")
      await (hooks as any)["chat.tools"]({ sessionID: "shape-hook" }, { system: ["p2"], tools: { a: { description: "x" } } })
      const snap = prefixShapeSnapshot("shape-hook")
      expect(snap?.lastReason).toBe("system")
      expect(snap?.changes).toBe(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("utility requests (title/compaction) never pollute the shape", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveagent-shape-skip-"))
    try {
      const hooks = await deveagentPlugin.server({ client: {}, directory } as unknown as Parameters<typeof deveagentPlugin.server>[0])
      await (hooks as any)["chat.tools"]({ sessionID: "shape-skip", agent: "title" }, { system: [], tools: {} })
      await (hooks as any)["chat.tools"]({ sessionID: "shape-skip", agent: "compaction" }, { system: [], tools: {} })
      expect(prefixShapeSnapshot("shape-skip")).toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe("provider-anchored token projection", () => {
  test("starts at chars/4 fallback and anchors to measured ratio", () => {
    expect(tokenProjectionSnapshot().tokenCharRatio).toBeNull()

    // 1000 chars consumed by 400 provider prompt tokens -> ratio 0.4.
    recordRequestChars(1000)
    recordProviderPromptTokens(400)
    const anchored = tokenProjectionSnapshot().tokenCharRatio
    expect(anchored).toBeCloseTo(0.4, 5)

    // A second measurement with ratio 0.2 moves the EMA toward it.
    recordRequestChars(1000)
    recordProviderPromptTokens(200)
    const smoothed = tokenProjectionSnapshot().tokenCharRatio!
    expect(smoothed).toBeCloseTo(0.4 * 0.8 + 0.2 * 0.2, 5)
  })

  test("out-of-band ratios are rejected", () => {
    recordRequestChars(1000)
    recordProviderPromptTokens(50) // ratio 0.05 — absurd, rejected
    expect(tokenProjectionSnapshot().tokenCharRatio).toBeCloseTo(0.36, 5)
    recordProviderPromptTokens(900) // ratio 0.9 — absurd, rejected
    expect(tokenProjectionSnapshot().tokenCharRatio).toBeCloseTo(0.36, 5)
  })

  test("no measurement without request chars", () => {
    recordRequestChars(0)
    recordProviderPromptTokens(400)
    expect(tokenProjectionSnapshot().tokenCharRatio).toBeCloseTo(0.36, 5)
  })
})

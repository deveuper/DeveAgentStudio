# Agent Notes (for AI agents working on this repository)

This file is the standing instruction set for any AI agent (Codex, Claude,
OpenCode, ZCode, DeveAgent, or any future tool) that touches this repository.

## MANDATORY: Strip secrets before publishing to GitHub

- **NEVER commit or push API keys, tokens, passwords, or private endpoints.**
  This includes (but is not limited to): provider API keys (OpenAI, Anthropic,
  DeepSeek, GLM, MiMo, Kimi, Qwen, etc.), MCP credentials, OAuth tokens,
  `.env`-style secrets, and workspace `vision.json` / `stt.json` config files.
- **Before any `git push` to a public remote, run a secret scan and review the
  diff** for real-looking key material. Values like `sk-...`, `ghp_...`,
  `AKIA...`, `Bearer <long-token>` in *test fixtures* are acceptable (they are
  clearly fake), but anything that could be a live credential must be removed
  and the file committed without it.
- Local state that must NEVER be published (already gitignored):
  - `.deveagent/` (workspace-local config, may contain real API keys)
  - `.opencode/` (local index/state)
  - `tests/` (machine-specific E2E drivers and evidence artifacts)
  - `dist-*` / `out` / `node_modules` build output
- If you ever see a real secret in the working tree, do not commit it; report
  it and continue with the secret removed.

## Repo conventions

- The product base is the OpenCode fork under this tree; DeveAgent features are
  additive. Keep OpenCode intact.
- Prefer small, focused commits with conventional messages
  (`type(scope): summary`).
- Run `bun typecheck` from package directories (never `tsc` directly); run
  tests from package directories (`bun test ...`), never from the repo root.
- Do not fabricate metrics, costs, cache-hit rates, or runtime status in code,
  docs, or README claims.

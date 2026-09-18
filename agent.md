# Agent Notes (for AI agents working on this repository)

This file is the standing instruction set for any AI agent (Codex, Claude,
OpenCode, ZCode, DeveAgent, or any future tool) that touches this repository.

## MANDATORY: Strip secrets before publishing to GitHub

- **NEVER commit or push API keys, tokens, passwords, or private endpoints.**
  This includes (but is not limited to): provider API keys (OpenAI, Anthropic,
  DeepSeek, GLM, MiMo, Kimi, Qwen, etc.), MCP credentials, OAuth tokens,
  `.env`-style secrets, and workspace `vision.json` / `stt.json` config files.
- **Before any `git push` to a public remote, run
  `node script/scan-secrets.mjs .` and review the
  staged diff** for real-looking key material. Test fixtures are not trusted by
  directory name: a fixture is accepted only when its exact path, rule, and
  value hash appear in `script/secret-scan-allowlist.json`.
- Local state that must NEVER be published (already gitignored):
  - `.deveagent/` (workspace-local config, may contain real API keys)
  - untracked `.opencode/` local index/state (tracked repository configuration
    is publishable and must remain secret-free)
  - `tests/` (machine-specific E2E drivers and evidence artifacts)
  - `dist-*` / `out` / `node_modules` build output
- If you ever see a real secret in the working tree, do not commit it; report
  it and continue with the secret removed.
- The scanner must remain in the publishable `script/` directory. Do not point
  this rule at ignored local E2E files under `tests/`.

## Repo conventions

- The product base is the OpenCode fork under this tree; DeveAgent features are
  additive. Keep OpenCode intact.
- Prefer small, focused commits with conventional messages
  (`type(scope): summary`).
- Run `bun typecheck` from package directories (never `tsc` directly); run
  tests from package directories (`bun test ...`), never from the repo root.
- Do not fabricate metrics, costs, cache-hit rates, or runtime status in code,
  docs, or README claims.

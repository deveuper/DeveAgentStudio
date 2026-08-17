# DeveAgent Studio

**An autonomous agent workstation for coding, planning, and long-running tasks — built on the OpenCode architecture, with a DeveAgent-native shell.**

DeveAgent Studio is a desktop AI coding agent that keeps the battle-tested OpenCode
engine as its core while adding an independent agent layer: autonomous Goal/Loop
execution, a multi-agent (MoA) team, durable project memory, an independent
vision/STT configuration, a cache-friendly prompt architecture, and a
Codex-inspired UI.

---

## What it is

- A **desktop application** (Electron + SolidJS) wrapping the OpenCode server.
- An **agent layer** that turns a single chat session into a bounded autonomous
  worker: goals with acceptance criteria, loops with run budgets, and a
  cross-examining ("Grilling") mode.
- A **persistent memory system** over Markdown + JSON + FTS search, so decisions
  and bug history survive across sessions.
- A **cache-first prompt design**: a byte-stable system prefix, turn-tail runtime
  state, and per-session prefix-shape diagnostics.

## Key features

### Autonomous execution
- **Goal mode**: set a description + acceptance criteria; the agent keeps
  working in bounded re-entries until verified, with wall-clock and retry
  budgets, deadline enforcement, and crash recovery from disk.
- **Loop mode**: schedule a bounded repeated task with interval, run, retry, and
  duration budgets; pause/resume/cancel.
- **Grilling Me**: a cross-examination workflow that forces explicit
  question→answer decisions before proceeding.

### Multi-agent collaboration
- **MoA Team**: planner / coder / reviewer / verifier advisors + an optional
  executor; sequential, parallel, or debate runs; exactly-once execution
  recovery (interrupted phases are never silently replayed).
- **Expert system**: built-in read-only advisors (chief, planner, codegraph,
  reviewer, security, test, memory, token-saver, UI) plus user-defined custom
  experts.
- **Work Packs**: one-click presets that bind mode, skills, and role routing.
- **Role → model routing**: per-role model binding with honest warnings when a
  bound model cannot be resolved.

### Memory & context
- **Durable memory**: project MEMORY.md, session checkpoints/notes, task
  progress, decisions, bug history, and auto-detected skill candidates —
  searchable via SQLite FTS with CJK-aware bigram tokenization.
- **Token Saver**: deterministic head/tail compression with byte-stable markers
  (keeps the prefix cache stable while genuinely reducing tokens).
- **CodeGraph**: incremental symbol index (tree-sitter) with import/call edges,
  context packs, and review scopes.
- **Cache-shape diagnostics**: per-session attribution of prefix-cache misses
  (system vs tools vs parameter changes), so cache behavior is observable, not
  assumed.

### Independent capabilities
- **Independent vision API** (OpenAI-compatible providers: MiMo, GLM, Ark,
  DashScope, Moonshot, Ollama, …) with automatic fallback to OS OCR
  (Windows.Media.Ocr / macOS Vision) — separate from the main provider.
- **Independent STT** configuration with a real network probe for testing.
- **Computer Use** with a hardened read-only shell allowlist (git/rg/node/bun/
  python restricted to safe commands; no shell injection surface).

### UI (Codex-inspired, DeveAgent-branded)
- Left rail / status bar / right overview panel shell, warm-orange accent,
  Inter-first typography, skill chips (`# Skill` style), circular send button,
  sticky timeline headers, collapsible reasoning, diff summaries with
  accessible controls, and dual light/dark themes with token-level theming.

## What it references

- **OpenCode** (https://github.com/anomalyco/opencode) — the core engine: session
  management, providers, tools, and the server. DeveAgent Studio is an additive
  fork; upstream fixes are periodically ported.
- **MiMo Code workflows** — the mode vocabulary (ask / plan / build / compose /
  goal / loop / review / debug / refactor / auto) and the turn-tail runtime-state
  pattern.
- **Reasonix / ZCode / Codex** — the visual direction: compact IDE-like layout,
  orange accents, tight typography, and accessible interaction patterns.

## How it improves on plain agent CLIs

These are design-level properties of this codebase (measured claims are never
fabricated; per-session cache metrics are tracked honestly in-app):

- **Cache-first prompting**: the system prefix is byte-stable for the life of a
  session; runtime state rides the user turn as a synthetic part instead of
  re-rendering the prefix. Prefix-shape diagnostics tell you *why* a cache miss
  happened (system change, tool change, or parameter change).
- **Bounded everything**: goals/loops have run/retry/wall-clock budgets; every
  in-memory registry and every persisted store is capped and atomically written
  (temp+rename, serialized chains, Windows-lock fallback) — a crash cannot
  silently lose agent state.
- **Honest degradation**: unknown-model pricing returns absent (not guessed);
  unavailable vision/STT/OCR paths say why; interrupted multi-agent phases are
  reported, never silently replayed.
- **Security posture**: read-only computer-use shell allowlist with per-command
  flag blocking, remote-skill URL allowlists (HTTPS-only marketplace hosts),
  private-address/DNS-rebinding protection for browser/MCP URLs, and secret
  hygiene enforced before any publish (see `agent.md`).
- **Verification discipline**: every product change goes through source checks
  (typecheck + unit suites), adversarial code review, and a packaged E2E gate
  chain (loop/team/role/click, project flows) before release.

## Getting started (from source)

Requirements: Node/Bun, Git, PowerShell (Windows) or a POSIX shell.

```sh
# install + typecheck
bun install
bun typecheck            # from package dirs

# unit tests (run from package dirs, e.g. packages/opencode)
bun test                 # package-level suites

# desktop dev shell
cd packages/desktop
bunx electron-vite dev

# package a Windows installer
bun run package:win      # after: bunx electron-vite build
```

See `packages/opencode/AGENTS.md`, `packages/app/AGENTS.md`, and
`packages/desktop/AGENTS.md` for package-specific conventions.

## Project status

Actively developed. The autonomous features (goals, loops, team, memory,
vision/STT, computer-use) are exercised by unit suites and packaged E2E gates on
every release cycle. The development journal lives in the private workspace;
this repository publishes the product source only.

## Credits

- Core engine: [OpenCode](https://github.com/anomalyco/opencode) (MIT-licensed
  fork base; see its LICENSE for the core).
- DeveAgent layer, desktop shell, memory/team/autonomy systems, and UI: the
  DeveAgent Studio contributors.

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
  budgets, deadline enforcement, and persisted local recovery state.
- **Loop mode**: schedule a bounded repeated task with interval, run, retry, and
  duration budgets; pause/resume/cancel.
- **Grilling Me**: a cross-examination workflow that forces explicit
  question→answer decisions before proceeding.

### Multi-agent collaboration
- **MoA Team**: planner / coder / reviewer / verifier advisors + an optional
  executor; sequential, parallel, or debate runs using real OpenCode child
  sessions. Interrupted write-capable phases require explicit review and are
  never silently replayed.
- **Expert system**: built-in read-only advisors (chief, planner, codegraph,
  reviewer, security, test, memory, token-saver, UI) plus user-defined custom
  experts.
- **Work Packs**: one-click presets that bind mode, skills, and role routing.
- **Role → model routing**: per-role model binding with honest warnings when a
  bound model cannot be resolved.

### Memory & context
- **Durable memory**: project MEMORY.md, session checkpoints/notes, task
  progress, decisions, bug history, and auto-detected skill candidates —
  searchable via SQLite FTS with CJK-aware bigram tokenization when FTS5 is
  available, with a keyword fallback.
- **Token Saver**: scoped context selection, bounded tool-result projection,
  and byte-stable prompt markers. Displayed savings are local estimates, not
  provider billing or cache guarantees.
- **CodeGraph**: bounded syntax-level symbol index (tree-sitter with parser
  fallbacks), import/call heuristics, context packs, and review scopes.
- **Cache-shape diagnostics**: records system/tool-schema shape changes beside
  provider cache usage. It does not claim that a shape change caused a cache
  miss.

### Independent capabilities
- **Independent vision API** (OpenAI-compatible providers: MiMo, GLM, Ark,
  DashScope, Moonshot, Ollama, …) with automatic fallback to OS OCR
  (Windows.Media.Ocr / macOS Vision) — separate from the main provider.
- **Independent STT** configuration with a real network probe for testing.
- **Restricted Computer Use** for the DeveAgent window, an isolated browser
  surface, and a read-only shell allowlist. It is not arbitrary desktop control
  or an operating-system sandbox.

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
- **Hermes Agent and Pi** — bounded team orchestration, provider/profile
  routing, session lifecycle, and extension behavior are studied and then
  reimplemented against OpenCode interfaces.
- **Reasonix / ZCode / Codex** — context-efficiency ideas and the compact,
  accessible desktop-workbench direction.

Reference repositories are used for interface and behavior research. DeveAgent
code is implemented for this fork; leaked prompt text is not copied.

## How it improves on plain agent CLIs

These are design-level properties of this codebase (measured claims are never
fabricated; per-session cache metrics are tracked honestly in-app):

- **Cache-first prompting**: the system prefix is byte-stable for the life of a
  session; runtime state rides the user turn as a synthetic part instead of
  re-rendering the prefix. Prefix-shape diagnostics identify relevant system
  and tool changes without presenting correlation as cache-miss causation.
- **Bounded everything**: goals/loops have run/retry/wall-clock budgets; every
  in-memory registry and persisted stores are capped and serialized. The normal
  path uses temp+rename; Windows lock fallback and corrupt-state recovery are
  best effort rather than transactional guarantees.
- **Honest degradation**: unknown-model pricing returns absent (not guessed);
  unavailable vision/STT/OCR paths say why; interrupted multi-agent phases are
  reported, never silently replayed.
- **Security posture**: read-only computer-use shell allowlist with per-command
  flag blocking, remote-skill URL allowlists (HTTPS-only marketplace hosts),
  private-address/DNS-rebinding protection for browser/MCP URLs, and secret
  hygiene enforced before any publish (see `agent.md`).
- **Verification discipline**: source changes receive focused typechecks and
  unit suites. Product release slices additionally run packaged E2E gates
  (loop/team/role/click and project flows); documentation and accessibility-only
  commits may be published before the next packaged slice.

## Current implementation boundary

| Area | Current evidence | Boundary |
| --- | --- | --- |
| Goal / Loop | Persisted bounded state, retry/deadline budgets, event-driven re-entry | Local process scheduler; completion still requires explicit verification |
| MoA Team | Real child sessions, budgets, retries, persisted run records and synthesis | No distributed exactly-once executor; interrupted writes require review |
| Memory | Markdown/JSON stores plus optional SQLite FTS5 | Packaged FTS availability depends on the runtime |
| CodeGraph | Syntax symbols plus heuristic import/call neighbors | Not a complete cross-language semantic graph |
| Computer Use | Restricted in-app/browser actions and read-only shell commands | Not full external-app desktop automation |
| Token/cache | Real provider usage when returned; local context/savings estimates are labeled | Shape diagnostics do not prove cache-miss causation |
| Remote Skills | HTTPS host/path validation, persisted install and selected prompt injection | Third-party skill text remains untrusted input |

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

Actively developed. Focused source suites cover Goal, Loop, Team, memory,
vision fallback, restricted Computer Use, remote skills, and CodeGraph. Packaged
E2E evidence is produced per product release slice, not inferred from a visible
button or a source-only change. The development journal remains private; this
repository publishes product source only.

## Credits

- Core engine: [OpenCode](https://github.com/anomalyco/opencode) (MIT-licensed
  fork base; see its LICENSE for the core).
- DeveAgent layer, desktop shell, memory/team/autonomy systems, and UI: the
  DeveAgent Studio contributors.

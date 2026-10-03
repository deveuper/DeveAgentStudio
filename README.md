<div align="center">

<img src="./packages/desktop/icons/prod/icon.png" alt="DeveAgent Studio" width="120" />

# DeveAgent Studio

**An autonomous agent workstation for coding, planning, and long-running tasks.**

Built on OpenCode, with a DeveAgent workstation for bounded tasks, real child
sessions, configurable tools, and observable usage.

[![Release](https://img.shields.io/github/v/release/deveuper/DeveAgentStudio?style=flat-square&color=2563eb)](../../releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-111827?style=flat-square)](#install)
[![License](https://img.shields.io/badge/license-MIT-16a34a?style=flat-square)](./LICENSE)
[![Languages](https://img.shields.io/badge/UI-29%20languages-f59e0b?style=flat-square)](#languages)

**English** · [简体中文](./docs/readme/README.zh-CN.md) · [Français](./docs/readme/README.fr.md) · [All UI languages →](./docs/readme/README.md)

</div>

---

## Why this exists

**Updated, 2026-10-03:** Remote Markdown Skill updates are idempotent and
failed checks are no longer reported as "all up to date". Optional checks run
when the installed-Skills page is open. Updates are installed on your command.
The website includes refreshed screenshots, an architecture overview, and
direct English, Simplified Chinese and French guides.

[Website](https://deveuper.github.io/DeveAgentStudio/?lang=en) ·
[Architecture and screenshots](https://deveuper.github.io/DeveAgentStudio/#architecture)

![OpenCode Core, DeveAgent Shell and runtime boundaries](./docs/assets/architecture-20261003.png)

Most AI coding tools are either a terminal with a chat box, or a pretty window
that hides what the model is doing. Neither survives a long task.

DeveAgent Studio started from a simple observation while building real projects
with coding agents: **the hard part is not the first answer, it is hour six.**
A run that cannot tell you what it changed, what it spent, why it stopped, or
whether it actually finished is a run you cannot trust with real work.

So this project keeps the OpenCode engine — proven tool calling, permissions,
sessions, Git and terminal integration — and builds an agent layer on top that
is *bounded*, *observable*, and *recoverable*.

## Screenshots

<table>
<tr>
<td width="50%">

**Session workbench** — conversation, live metrics, and the agent's plan in one
frame. A sub-agent strip inside the composer shows what is running right now
and how far the active goal's criteria have progressed; the status bar keeps
context usage, cache hits, tokens, cost and rounds in one calm glyph line.

<img src="./docs/assets/screenshot-session.png" alt="Session workbench" />

</td>
<td width="50%">

**Plan mode with a snapshot badge** — planning output is visually distinct from execution output, and the badge follows the mode the turn actually ran in, not whatever the composer shows later.

<img src="./docs/assets/screenshot-plan.png" alt="Plan mode badge" />

</td>
</tr>
<tr>
<td width="50%">

**Composer controls** — mode, model, thinking level, permissions, skills and experts in one frame. Every popover is reachable by mouse and by keyboard, in light and dark, at narrow widths.

<img src="./docs/assets/screenshot-composer.png" alt="Composer controls" />

</td>
<td width="50%">

**Project sidebar** — projects, sessions, work packs and capabilities in one scrolling column. Archiving, restoring and removing a project all work without touching your files.

<img src="./docs/assets/screenshot-sidebar.png" alt="Project sidebar" />

</td>
</tr>
</table>

## What makes it different

### Bounded autonomy, not a firehose

| Capability | What it actually does |
| --- | --- |
| **Goal** | Persistent criteria, bounded continuation, deadlines, usage checks and completion evidence. The `goal-verify` tool supports a verifier model for reviewing completion records. |
| **Go mode** | One switch: submit a goal and it is confirmed automatically, running plan → execute → self-verify without a confirmation round trip. |
| **Loop** | Repeat a task on an interval or cron with run budgets, retry limits, wall-clock deadlines and a lease so two workers never run the same pass. |
| **Team / MoA** | Dispatch parallel or debating members as real child sessions, each with its own model and role. Failed members can be retried individually. |
| **Grilling** | An adversarial mode that cross-examines a plan before you commit to it. |
| **Reusable skills** | Save a reusable procedure as a skill candidate with validation and provenance (`skill-save`). Candidates are available for review and adoption; user-authored and pinned skills are protected from silent overwrites. |

### Honest by construction

- **No silent paid fallback.** A provider fallback may only switch to a model
  whose cost is known to be zero. Paid candidates are skipped by default, and
  when a switch happens you get an in-app announcement — not just a log line.
- **Provider-backed metrics.** Cache hit rate, cost, tokens and rounds use
  provider usage records. Model estimates and billed costs are labeled separately.
- **No fake progress.** A failed child turn fails the task. A swallowed error
  that let a run report success while its model was returning 500s was treated
  as a bug, traced to the wait seam, and fixed with a regression probe.

### Built for long runs

- **Checkpoints and rewind** — restore file bytes and conversation position to
  any earlier turn.
- **Durable memory** — decisions, bug history and task notes persist in the
  workspace and are retrieved on demand, not injected wholesale.
- **Cache-first prompt architecture** — a byte-stable system prefix and a
  turn-tail runtime state block, so switching modes mid-session keeps the
  cached prefix intact (measured: 100% of the prefix bytes unchanged across a
  mode switch).
- **Segmented startup timing** — script, workbench, composer and provider
  readiness are timed honestly and exposed for diagnosis.

## Install

Download the latest build from the [releases page](../../releases).

| Platform | Package |
| --- | --- |
| Windows | `DeveAgent-Studio-win-x64.exe` |
| macOS | `DeveAgent-Studio-mac-*.dmg` |
| Linux | `DeveAgent-Studio-linux-*.AppImage` |

Then open the app, connect a provider in **Settings → Providers** (any
OpenAI-compatible endpoint works, including free tiers), and start a session.

> **Bring your own key.** DeveAgent Studio does not ship credentials and does
> not proxy your requests. Your provider keys stay on your machine.

## Languages

The desktop UI ships 29 locales: English, 简体中文, 繁體中文, 日本語, 한국어,
Deutsch, Español, Français, Dansk, Norsk, Polski, Русский, Українська, العربية,
Português (Brasil), ไทย, Bosanski, Türkçe, Italiano, Nederlands, Svenska, Suomi,
Čeština, Magyar, Română, Ελληνικά, Tiếng Việt, Bahasa Indonesia, हिन्दी.

## Architecture

```
packages/
  desktop/   Electron shell, window, sidecar lifecycle, packaging
  app/       SolidJS UI — workbench, composer, timeline, dashboard
  opencode/  Agent runtime — sessions, tools, permissions, the DeveAgent plugin
  ui/        Design system (tokens, themes, components)
```

The DeveAgent layer lives in `packages/opencode/src/plugin/deveagent*.ts`
(goal/loop/team engines, memory, checkpoints, guardian, verifier) and
`packages/app/src/components/deveagent-*.tsx` (workbench surfaces). The
OpenCode engine underneath is kept intact — this project extends it, it does
not fork its behaviour.

## Development

```bash
bun install
bun run --cwd packages/app test:unit
bun run typecheck
node script/package-desktop.mjs <label>   # produces a packaged build
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow.

## Development and validation

App and locale regression suites run with
`bun run --cwd packages/app test:unit`. Runtime tests live alongside the
DeveAgent modules. Release downloads include their version and asset metadata.

The workstation provides configurable models, real sessions, visible task
records, tool permissions and file checkpoints. Windows Computer Use adapters
include window discovery, focus, UI trees and input actions.

## License

MIT — see [LICENSE](./LICENSE).

Built on [OpenCode](https://github.com/anomalyco/opencode) (MIT).

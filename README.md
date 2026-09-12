# Agent ship

A desktop app that shows your Claude Code sessions as crew wandering the rooms
of a building - one room per project - live, using Claude Code's own hook
system and its local session transcripts. No API key, no OAuth, no model
calls: it never talks to Anthropic at all.

## Stack

- **Electron** shell, **React 19 + TypeScript + Vite** renderer (`electron-vite`)
- **@xyflow/react** for the room canvas: agents are child nodes clamped inside
  their room, and the orchestrator connects to them with draggable edges

## How it works

1. Claude Code fires lifecycle events (`PreToolUse`, `PostToolUse`,
   `SessionStart`, `Stop`, ...) as JSON on stdin to any command configured in
   `~/.claude/settings.json`.
2. `hooks/bridge.js` is that command. It forwards a small summary (session id,
   project folder, tool name) to `http://127.0.0.1:8934`, a loopback server
   this app runs.
3. Everything else is read from files Claude Code already writes locally -
   `~/.claude/projects/**/*.jsonl` - plus `git` run in your project folders.

Everything stays on your machine. The server only binds to `127.0.0.1`.

## What the gauges actually measure

Nothing here is invented; each reading has a real local source.

| Signal | Source | Notes |
| --- | --- | --- |
| **Battery** (per agent) | `message.usage` in the session transcript: `input + cache_creation + cache_read + output` | Context the model is holding. The window size is assumed per model (1M for Opus/Sonnet 5), since Claude Code never records it. |
| **Branch** (on hover) | `gitBranch` recorded on transcript lines, falling back to `git rev-parse` | |
| **Envelope** (unmerged work) | `git rev-list --count <base>..HEAD` and `git status --porcelain` | Shows when a room has commits not on `main`/`master`, or uncommitted edits. |
| **Past sessions** | one `.jsonl` per session, with `custom-title` and `last-prompt` | Click any idle agent to resume that session with a new task. |
| **Fuel** (weekly) | trailing 7 days of billed tokens across all local transcripts | **An estimate.** Claude Code does not record your plan's real weekly limit anywhere on disk, so this is measured against a budget *you* set, and is labelled `est.` in the UI. Cache reads are excluded so re-sent context doesn't inflate it. |

## The orchestrator

Always present on the canvas.

- **Drag a line** from its handle onto any agent to put that agent under its
  direction. Links persist across restarts; click an edge to remove it.
- **Brief…** starts a real background orchestrator agent that can spawn and
  direct its own sub-agents.
- **Collect & merge** gathers every branch that is ahead of its base branch,
  shows you exactly which branches in which repos it is about to touch, and
  only then spawns an agent to land them and resolve conflicts. It is told
  never to force-push, rebase shared history, or delete branches.

## Developing

```bash
npm install
npm run dev          # Electron + Vite with HMR
npm run typecheck
npm run build
npm run uninstall-hooks
```

Opening `http://localhost:5173` in a plain browser during `npm run dev` loads
the renderer with sample data (`src/renderer/src/lib/devMock.ts`), which is
stripped from production builds.

## Building the installers

```bash
npm run dist:win     # -> dist/*.exe   (must run on Windows)
npm run dist:mac     # -> dist/*.dmg   (must run on macOS)
npm run dist:linux   # -> dist/*.AppImage
```

Or push a `v*` tag to trigger `.github/workflows/build.yml`.

## Limitations

- Only covers Claude Code sessions (terminal / IDE) - that's the surface with
  a documented hook system. Claude.ai and Claude Desktop chat sessions don't
  fire these hooks.
- The fuel gauge is a local estimate, not your account's real quota (above).
- Context-window sizes are assumed per model; if a session is observed
  exceeding the assumption the gauge clamps rather than reading past 100%.
- Hook-install logic exists twice: `src/main/hooks.ts` for the running app and
  `scripts/install-hooks.js` for the `postinstall`/CLI path.

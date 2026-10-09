# Agent Ship

A local-first desktop app for running coding agents on your own repositories, and for seeing which of their
work needs you. It sits on top of the `claude` CLI (Claude Code) and **uses whatever account that CLI is
signed in to**: Agent Ship holds no API key or token of its own. What it adds is structure around the agents:
each one works in its own git branch, its work is checked by real commands, and a run is held to a spending
limit you set.

> Status: it works end to end on Windows. macOS and Linux have never been run (see Limitations).
> The project's own plan and history are in [`planning/`](planning/).

## What is in it

- **The Floor** - mission control over every project, organised by what a person should do next: *Needs you*,
  *Running*, *Ready to land*, *Done*. One task is one card, whether it began as a session, a flow run or a branch.
  Each card carries a Build, Test, Merge, Land strip, whether its work was verified by a gate, and what it cost.
- **Blueprints** - a node editor for orchestration flows (agents, gates, fan-out/join, merge, land), saved as plain
  JSON in `<repo>/.agentship/flows/`. The same canvas lights up while a flow runs.
- **Autopilot** - a switch on each project. It works through a plan file (`planning/PLAN.md`, tick-boxes): one
  builder session, with the project's own toolchain, goes item after item in its own branch; the tests run; the
  result is merged and landed on the base branch; it repeats until every item is ticked, then an agent checks the
  plan really is done. The engine keeps the session going, starts a fresh context when it grows, and stops when
  sessions stop completing items or your spending limit is reached.
- **Interview** - for a project with no plan, an agent interviews you (one question at a time, with options and a
  live "plan so far" panel) and writes `planning/OVERVIEW.md`, `DESIGN.md` and `PLAN.md` after you approve a preview.
- **Land** - merge a branch into the base in a scratch copy, test the merged result (an agent repairs a failure),
  and only then move the base branch. Your checkout is never touched until that last step.
- **Usage** - a gauge of the last 7 days of billed tokens against a budget you set. It is an estimate: Claude
  Code does not record your plan's real limit anywhere on disk.

## How it works

- **Live view.** Claude Code fires lifecycle events on stdin to any command configured in
  `~/.claude/settings.json`. `hooks/bridge.js` forwards a small summary to a loopback server this app runs
  (`127.0.0.1:8934`, which refuses requests that carry an `Origin` header or a non-loopback `Host`). Session
  history is read from the transcripts Claude Code already writes under `~/.claude/projects/`.
- **Runs.** The engine (`src/main/engine/`) walks a blueprint. Every agent step is a `claude -p` call with the
  prompt on stdin, a session id the engine chose, a dollar cap, and a permission mode that cannot prompt (a
  command that is not allowed is refused, never asked about). Editing agents work in their own worktree and
  branch under the app's data folder; whatever they leave is committed for them. A gate is a shell command, a
  person's approval, an agent's judgement, or the plan's tick-boxes. Every state change is appended to a JSONL
  log, so a run can be resumed after the app closes.
- **Environment.** Each scratch copy gets the dependencies its own `package.json` declares (installed once per
  distinct manifest and lockfile, with npm, pnpm or yarn as the lockfile says). Commands and agents do not
  inherit Agent Ship's own `PATH` entries, `npm_*` variables or `NODE_ENV`.
- **Money.** A run's ceiling is the lower of the flow's own worst case and the limit you type in the run dialog.
  The CLI checks a step's cap after each model call, so a step can overshoot by at most one call.

## Safety model, plainly

- Agents run with your Claude login and can run the allow-listed commands (`npm`, `node`, `python`, `cargo`,
  ... for the Autopilot builder) in their own branch's directory **without asking you**. Containment is the git
  worktree, not the permission mode; a worktree is not a sandbox.
- Nothing lands on your base branch except through the Land step, after the merged result has passed its tests.
- `bypassPermissions` is never used, and no step is ever allowed to prompt.
- Every run is shown in a confirmation first: what will execute, which branch it will move, and the limit.

## Developing

```bash
npm install
npm run dev            # Electron + Vite with HMR
npm run typecheck
npm test               # unit and integration tests (fake CLI, real git repositories)
npm run build
```

Opening `http://localhost:5173` in a plain browser during `npm run dev` loads the renderer with sample data
(`src/renderer/src/lib/devMock.ts`) and a scripted interview, with no engine behind it.

Tests that drive the real thing (build first with `npm run build`):

```bash
npm run smoke                       # the real Electron app, a fake CLI: Floor, a run, Land, Commit & land
npm run smoke:parallel              # tournament, resume after closing, resume after a hard kill
npm run smoke:packaged -- <dir>     # an unpacked installer
npm run e2e:autopilot               # the real app and the REAL claude CLI on a scratch project (spends usage)
npm run e2e:autopilot -- --plan python|vite --node-env production
AGENT_SHIP_LIVE=1 npx vitest run   # opt-in tests against the real CLI (spends usage)
```

## Building the installers

```bash
npm run dist:win     # -> dist/*.exe   (must run on Windows)
npm run dist:mac     # -> dist/*.dmg   (must run on macOS)
npm run dist:linux   # -> dist/*.AppImage
```

Or push a `v*` tag to trigger `.github/workflows/build.yml`.

## Limitations

- Claude Code only. The engine talks to the CLI through one adapter (`src/main/engine/adapter.ts`); a second
  vendor would be a second adapter.
- Only Windows has been exercised. Process-tree killing and the hook command on macOS and Linux are written, not run.
- Dependencies are installed for Node projects (npm, pnpm, yarn). Python, Go and Rust projects run their
  tests with whatever is installed on the machine; nothing creates a virtualenv or fetches crates for them.
- Session state comes from what `claude agents --json` documents; "waiting for input" has never been seen on real
  output, only on the documented values.
- The Usage gauge is a local estimate, and context-window sizes are assumed per model.
- Hook-install logic exists twice: `src/main/hooks.ts` for the running app and `scripts/install-hooks.js` for the
  `postinstall` path, because `npm install` runs before there is a build.

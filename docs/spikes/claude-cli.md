# Spike: what the Claude Code CLI lets an engine rely on

Run 2026-09-20 against `claude` 2.1.272 on Windows 11. Everything below was
observed, not assumed, unless marked **unverified**. Probes used Haiku with
`--max-budget-usd 0.3` and a scratch repo outside the project.

## 1. Headless surface (`-p`)

`claude -p "<prompt>" --output-format json` prints **one JSON object** when it
finishes. Fields the engine can use directly:

| Field | Meaning |
|---|---|
| `result` | final text |
| `structured_output` | parsed object when `--json-schema '<schema>'` was given (also echoed, stringified, in `result`) |
| `session_id` | id to `--resume` or to correlate with hook events and transcripts |
| `total_cost_usd` | exact cost of the call |
| `usage`, `modelUsage` | input / output / cache-read / cache-creation tokens, per model |
| `is_error`, `subtype`, `terminal_reason`, `stop_reason` | success/failure classification |
| `num_turns`, `duration_ms` | effort accounting |

Consequences for the plan:

- **Exact per-step token and cost accounting is free** in headless mode. The
  "read transcripts for exact numbers" work in Phase 2 is only needed for
  `--bg` sessions, not for engine-driven steps.
- **Schema-validated output is native** (`--json-schema`). An Agent node's
  `outputSchema` maps 1:1 onto it; no extraction prompt needed.
- **A hard budget exists natively for headless runs:** `--max-budget-usd`.
  The engine still needs its own token ledger (a flow-wide ceiling spans many
  calls), but each node's cap can be enforced by the CLI itself.
- A cold call on a tiny prompt cost ~32k cache-creation tokens (system prompt
  and tools). Budgets must account for this floor; a 5k-token node cap would be
  wrong. `--bare` / `--safe-mode` / `--tools ""` are the levers to shrink it.

Other flags the engine will use: `--model`, `--effort`, `--allowedTools` /
`--disallowedTools` (per-node tool allow-list), `--permission-mode`
(`dontAsk` denies anything not allow-listed: the right default),
`--permission-prompts none`, `--append-system-prompt`, `--mcp-config` +
`--strict-mcp-config`, `--agents`, `--session-id <uuid>` (engine chooses the
id up front, so correlation needs no guessing), `--resume`, `--fork-session`,
`--no-session-persistence`.

## 2. Worktrees

`claude -w <name>` (also works with `-p`) creates
`<repo>/.claude/worktrees/<name>` on a new branch **`worktree-<name>`** and
runs the session there. Observed: the worktree is left **locked** afterwards,
and it **fails on a repo with no commits** ("Failed to resolve base branch
HEAD"). So:

- The engine should let the CLI create worktrees (`-w`), name them from the
  run + node id, and remember branch = `worktree-<name>`.
- Cleanup goes through `claude rm <id>` for `--bg` sessions ("deletes the
  worktree when that is safe"). For `-p` runs the engine must `git worktree
  unlock` + `remove` itself. **Unverified:** whether a `-p` worktree with no
  changes is auto-removed on exit.
- Phase 3 needs a "repo has at least one commit" preflight.

## 3. Stopping, and injecting input

- `claude stop <id>` stops a background session and keeps the conversation
  (`attach` / `--resume` continue it). This is better than the current
  process-tree kill for `--bg` sessions and should replace it.
- `claude rm <id>` deletes a session **and its worktree** when safe; refuses
  or reports a `--discard-unpushed` token when work would be lost. This is the
  right primitive for "cancel run, clean up".
- For headless `-p` runs the engine owns the child process: kill the tree.
- Human gates: not injected mid-run. Model them as **step boundaries**. The
  engine ends the step, waits for approval, and continues with `--resume
  <session_id>` and the reviewer's note as the next prompt. (`--input-format
  stream-json` supports realtime input, but resume is simpler and crash-safe.)

## 4. Live observation

- `claude agents --json` lists active sessions (already used for liveness);
  `--all` adds completed background sessions; `--cwd <path>` filters.
  Entries carry `status` (`busy` | `waiting` | `idle`, only while the process is alive). Background sessions also carry `state` (`working` | `blocked` | `done` | `failed` | `stopped`), and a waiting session has `waitingFor` (`permission prompt`, `input needed`, `sandbox request`, `worker request`, `dialog open`). Source: the agent-view docs. **Verified on this machine:** a live interactive session shows only `status` (busy while working); completed background sessions with `--all` show `state: "done"`. `blocked`, `waiting`, `waitingFor` and `failed` were **not** observed on real output, only read from the docs, so the app treats an unrecognised value as "no information", not as a state.
- `claude logs <id>` prints recent terminal output of a background session.
- `--include-hook-events` (with `stream-json`) can surface hook lifecycle in the
  output stream, an option to replace the local HTTP bridge for engine-driven
  runs. **Unverified.**

## 5. Windows

The app already spawns `claude` without a shell and passes the prompt as one
argv element. Long prompts worked in the probes above; the practical limit is
the ~32k-char `CreateProcess` command line. **Unverified** at that boundary:
the engine should pass prompts over stdin (`-p` reads stdin) once they may be
large (fan-out payloads, diffs).

## 6. Gotchas found while probing

- `claude --bg --help` **starts an idle background session** instead of
  printing help. Never probe subcommand help by appending `--help` to `--bg`.
- Auto-mode may refuse `--permission-mode bypassPermissions`; `dontAsk` with
  an explicit `--allowedTools` list worked and is the better default anyway.

## 7. Round 2 probes (engine dependencies)

All with Haiku, cents each. Run in a manual `git worktree add` checkout.

- **Prompt over stdin works:** `echo "..." | claude -p ...`. This removes the Windows command-line length limit (open item in section 5) and all quoting concerns. The engine passes every prompt this way.
- **`--session-id <uuid>` then `--resume <uuid>` from the same directory continues the session**, and the second call was much cheaper ($0.008 vs $0.018) because of prompt caching. So a gate-fail repair loop is "resume the builder with the failure output", not a cold restart.
- **`--permission-mode acceptEdits` lets the agent write files** with no `--allowedTools` at all. Under it a simple `echo hi > x.txt` through Bash was *also* allowed with only `Read` allow-listed. Treat "edit access" as "may modify files in its working directory", not as "cannot run commands". (No arbitrary `npm`/`git` was tested.) The real containment is the worktree, not the permission mode.
- **Budget cap is checked after each model call, not during it.** `--max-budget-usd 0.001` produced exit code 1, `subtype: "error_max_budget_usd"`, `terminal_reason: "budget_exhausted"`, `errors: ["Reached maximum budget ($0.001)"]`, and a total cost of **$0.0143**. The guarantee is "stops within one model call of the cap", so a cold first call (~$0.015 on Haiku, more on larger models) can overshoot a tiny cap. Caps below ~$0.05 are meaningless; the UI should say so.

## Decisions this spike settles (revised after building the engine)

1. Engine step = `claude -p` with the prompt on stdin, `--output-format json`, an engine-chosen `--session-id` (or `--resume` for a repair), `--permission-mode dontAsk|acceptEdits`, `--permission-prompts none`, `--max-budget-usd`. **Worktrees are created by the engine** (`git worktree add -b agentship/...`, kept out of the repo, removed after the run, branch kept), not by `claude -w`, which leaves them locked.
2. Cost/token ledger reads the result JSON; transcripts are only for replay.
3. Cancel = kill the child process tree (headless); `claude stop`/`claude rm` stay for background sessions.
4. Human gate = pause between steps; a rejection note is fed back by resuming the session.
5. The dollar cap is a per-call check: guarantee "stops within one model call of the cap".

Verified live (opt-in tests, Haiku): a one-agent flow, the cap stop, and a gate-failure repair by session resume.

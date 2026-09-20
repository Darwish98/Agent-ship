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
  Entries carry `status` (`idle`/`busy`), which the app does not read yet.
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

## Decisions this spike settles

1. Engine step = `claude -p --output-format json --session-id <uuid> -w <name>
   --permission-mode dontAsk --allowedTools ... --max-budget-usd ...`.
2. Cost/token ledger reads the result JSON; transcripts are only for replay.
3. Cancel = child kill (headless) or `claude stop` + `claude rm` (background).
4. Human gate = pause between steps, resume by session id.

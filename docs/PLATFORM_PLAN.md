# Agent Ship → an orchestration platform for coding agents

Status: **revision 3.4 (2026-09-21, after first use: landing pipeline, open-session state, Commit & land; plus the first slice of Phase 3: resume-after-restart, orphan sweep, OS notification, see §7).** Phases 0, 1, 1.5 and 2 are built. A flow can now run end to end: gated build in its own branch, capped at a dollar ceiling, visible live on both the Floor and the editor.** It has been proven against the real `claude` CLI on toy tasks, not yet on real work. The Floor was redesigned from scratch, see [FLOOR_DESIGN.md](FLOOR_DESIGN.md). Section 12 is the honest evaluation (short answer: a credible wedge, not yet a revolution), and section 11 says what to do next.
Working name stays "Agent Ship" until the product is clearer. Section 10's recommended defaults were assumed (solo developer, coding-agent flows only, Claude Code only, keep the name) since no answers were given; change them there if wrong.

---

## 0. The one-paragraph version

Agent Ship today is a live *monitor*: it shows Claude Code sessions as crew in project rooms, with one hard-coded orchestrator. The next step is to turn it into an **authoring + execution platform**: you design an orchestration (who works, in what shape, under what budget, gated by what checks) on a visual canvas, press Run, and watch the same canvas come alive. The orchestrator stops being a fixed thing and becomes one *pattern* among many that you can pick, edit, save and share. The bet: **"n8n for coding agents" — but git-native, local-first, budget-aware, and verifiable** — because that is the gap the market leaves open (section 2).

I cannot prove "nobody has ever done this." What I can say is that no tool I found combines all of the pillars in section 3, and I flag where a competitor could close the gap quickly (section 9).

---

## 1. What was fixed first (context)

**Bug: canvas goes empty after ~1 minute.** Reproduced against the real Electron app by feeding it synthetic hook events. Cause: `App.tsx` handed React Flow brand-new node objects on every render, and React Flow hides any node it has not measured, so every node became `visibility:hidden`. Fix (done, verified — 0 hidden nodes under sustained event load):

- keep React Flow's `measured` dimensions across refreshes and apply its own `onNodesChange`;
- make action callbacks stable (read `world` through a ref) so the graph is not rebuilt on every render.

Also: `AGENT_SHIP_PORT` now overrides the hook-server port (the bridge already honoured it), so a second instance can run for testing.

Side effect to own up to: while cleaning up the test instance I stopped every `electron-vite` process, which included your own running dev instance. Just relaunch it.

---

## 2. Market analysis

### 2.1 Demand is real and money is moving

| Signal | Number | Source |
|---|---|---|
| Agentic AI market | ~$19.3B (2026) → ~$205.9B (2033), ~40% CAGR | [MarketsandMarkets](https://www.marketsandmarkets.com/Market-Reports/agentic-ai-market-208190735.html) |
| Agentic workflow-orchestration platforms | ~$2.7B (2025) → ~$3.5B (2026) | [Mordor Intelligence](https://www.mordorintelligence.com/industry-reports/agentic-ai-workflow-orchestration-platform-market) |
| Multi-agent system platforms | ~$11.5B (2026) → ~$78.5B (2031) | [Mordor Intelligence](https://www.mordorintelligence.com/industry-reports/multi-agent-system-platform-market) |
| n8n valuation | $2.5B (Oct 2025 Series C, $180M) → $5.2B (SAP stake, May 2026) | [PitchBook](https://pitchbook.com/news/articles/ai-agent-startup-n8n-lands-2-5b-valuation-with-180m-series-c), [Sacra](https://sacra.com/c/n8n/) |
| n8n usage | 230k+ active users, 3,000+ enterprise customers, >80% of workflows involve AI agents | [Automation Atlas](https://automationatlas.io/answers/n8n-series-c-valuation-2025/) |

Caveat: analyst market-size figures disagree by 3–4× depending on how they draw the boundary. Treat them as *direction*, not as a forecast to plan revenue on. The n8n numbers are the more concrete evidence: a visual workflow tool that added agent nodes became a multi-billion company because **people want to design agent flows visually instead of writing glue code.**

### 2.2 The landscape, in four groups

1. **General visual builders — n8n, Dify, Flowise, Langflow.** Strong on triggers, integrations, RAG, business processes. They orchestrate *LLM API calls and SaaS tools*, are server/cloud-centric, and have no concept of a git repository, a worktree, a branch, or a merge. ([comparison](https://huggingface.co/blog/daya-shankar/n8n-vs-flowise-vs-langflow-enterprises), [another](https://agentswarms.fyi/blog/flowise-vs-langflow-vs-dify-vs-n8n-vs-agentswarms))
2. **Code frameworks — LangGraph, CrewAI, AutoGen, Microsoft Agent Framework.** Powerful, but you write Python/TS; the "diagram" is a documentation artifact.
3. **Coding-agent runners — Superset, diri, Claude Squad, ccmanager, Vibe-Kanban-style boards.** They launch and list parallel sessions across worktrees. They are *dashboards and launchers*; they do not let you **author a reusable orchestration**, and the search results say plainly that these tools "still leave task alignment, conflict resolution, and merge decisions on the developer's plate." ([Augment](https://www.augmentcode.com/tools/open-source-agent-orchestrators), [Nimbalyst](https://nimbalyst.com/blog/best-tools-for-running-parallel-ai-coding-agents/))
4. **Claude Code itself.** Now ships subagents, agent view (`claude agents`, TUI), agent teams (experimental), worktrees, cross-session messaging, and **dynamic workflows — JavaScript scripts** with `agent()`, `parallel()`, `pipeline()`, schema-validated output and budgets. ([Claude Code docs](https://code.claude.com/docs/en/agents), [workflows write-up](https://alexop.dev/posts/claude-code-workflows-deterministic-orchestration/))

### 2.3 Where the pain is (what people say breaks)

From production write-ups ([FutureAGI](https://futureagi.com/blog/trace-debug-multi-agent-systems-observability-guide/), [Augment](https://www.augmentcode.com/guides/multi-agent-ai-production-requirements), [Lanham](https://medium.com/@Micheal-Lanham/multi-agent-in-production-in-2026-what-actually-survived-f86de8bb1cd1)):

- **Cost runaway** — N agents × M calls; "an agent that silently runs 10× its expected cost."
- **No observability** — "which agent failed, which tool call returned garbage."
- **Silent cascading failure** and unbounded agent chatter with no convergence.
- **No verification / termination criteria** — nothing says when an agent is *done and correct*.
- **Merge/conflict burden** falls on the human (coding agents).
- Claim (single-source, treat cautiously): only ~11% of agent use cases reach production, blamed on the orchestration layer, not the model.

### 2.4 The whitespace

| Need | n8n & co. | Coding-agent runners | Claude Code native | **This platform** |
|---|---|---|---|---|
| Visual authoring of reusable orchestrations | yes | no | no (code) | **yes** |
| Understands git: worktree/branch per agent, merge queue | no | partial (worktrees only) | worktrees only | **yes, first-class** |
| Tests/CI as *gates* between steps | no | no | via script | **yes** |
| Budget as a design-time property with circuit breakers | partial | no | `budget` helper | **yes, per node** |
| Local-first, no cloud, works on your repo | self-host | yes | yes | **yes** |
| Live run visualisation | logs | list/TUI | TUI | **the "floor" + graph** |
| Swap the orchestrator pattern in one click | no | no | rewrite script | **yes** |

---

## 3. Product thesis — five pillars (the differentiator is the *combination*)

1. **The orchestrator is a pattern, not a fixture.** Supervisor, Pipeline, Fan-out/Reduce, Swarm, Debate, Tournament (best-of-N), Red-team/Blue-team, Relay. Each is a parameterised template you drop on the canvas and edit. There can be zero, one, or many orchestrators per flow.
2. **Git-native by construction.** Every agent node runs in its own worktree/branch. Every edge can carry a *typed artifact* (a branch, a diff, a verdict, a JSON result). Merging is a node — a conflict-aware merge queue — not a chore left to you. (The existing "envelope = unmerged work" concept becomes the edge payload.)
3. **Verification gates, not vibes.** A Gate node blocks the flow until something objective passes: test command, typecheck, lint, an LLM-judge with a rubric, or a human approval. Failure routes to a retry/repair branch with a cap.
4. **Budget is a first-class property.** Every node and every flow has a token/time ceiling; a circuit breaker stops runaway spend. Pre-run **dry-run estimate** ("this flow will use ~X–Y tokens") before you press Run. (The Fuel gauge grows into this.)
5. **Design mode and Run mode are the same canvas.** You draw the flow; when it runs, the same nodes light up, agents appear in their rooms, edges carry their artifacts, and every step is replayable from the local transcripts.

Tagline candidate: **"Draw the org chart. Watch it ship."**

---

## 4. Concepts and data model

```
Blueprint (flow)        saved as  <repo>/.agentship/flows/<name>.flow.json   (git-versioned, shareable)
 ├─ meta: name, description, version, defaultBudget, inputs[]
 ├─ nodes[]  { id, kind, config, budget?, position }
 └─ edges[]  { from, to, type: 'artifact' | 'branch' | 'verdict' | 'control', condition? }

Run                     one execution of a blueprint, stored in app data
 ├─ id, blueprintId@version, inputs, status, startedAt, endedAt
 ├─ steps[]  { nodeId, sessionId?, worktree?, branch?, status, tokens, cost, startedAt, endedAt, output? }
 └─ events[] append-only log (drives replay + the live view)
```

### Node kinds (v1 set)

| Kind | What it does |
|---|---|
| **Trigger** | manual · schedule · git event (push/PR/branch) · file change · webhook · another flow |
| **Agent** | one Claude Code session: role, model, prompt template, tool allow-list, MCP servers, worktree on/off, output schema |
| **Orchestrator** | a pattern node (supervisor, debate, tournament, …). Expands to a sub-graph; "explode" to edit it |
| **Fan-out / Join** | run N agents (from a list or a splitter) in parallel; join by *all / first / quorum / best* |
| **Gate** | tests · typecheck · lint · LLM-judge · human approval; on-fail → retry (max N) or branch |
| **Merge** | merge queue for branch artifacts, conflict-resolver agent, base-branch selection |
| **Budget** | circuit breaker scope: tokens, wall time, number of retries |
| **Transform / Tool** | shell command, MCP tool call, JSON transform |
| **Notify** | desktop notification, webhook, Slack/other via MCP |
| **Sub-flow** | call another blueprint |

### Pattern library (shipped as blueprints — also the marketing)

Supervisor · Pipeline (plan→build→review→test) · Map-reduce over files · Best-of-N tournament with judge · Debate (2 advocates + judge) · Red-team / blue-team · Bug-triage swarm · Migration fan-out (`/batch`-style) · Docs-from-diff · "PR factory" (issue → branch → tests → PR).

---

## 5. Architecture

Keep what works; add a run engine.

```
Renderer (React + React Flow)
  Floor view  │  Blueprint editor  │  Runs & replay  │  Library
        ▲ IPC (typed, versioned)
Main process
  flows/     store + validate + migrate blueprints (zod schema)
  engine/    run scheduler: DAG walker, fan-out/join, retries, cancel, resume-after-crash
  adapters/  AgentAdapter interface  → ClaudeCodeAdapter (v1)  → Codex/Gemini/… (later)
  git/       worktree manager, branch/merge queue, conflict detection  (extends existing git.ts)
  gates/     test/lint/judge/human runners
  budget/    ledger (tokens per node/run/week), estimator, circuit breakers
  hooks/     existing hook bridge = the live event stream (already built)
  transcripts/ existing reader = ground truth for replay + token accounting
  store/     runs + events in SQLite (better-sqlite3) or append-only JSONL to start
  mcp-server (later) expose "run flow / list runs / approve gate" to other agents
```

Design decisions:

- **Engine runs in the main process, not the renderer** — runs must survive a window reload (the bug we just fixed) and app restarts. Every state transition is persisted before it is acted on, so a crash resumes instead of restarting.
- **Agents are real Claude Code sessions** (`claude --bg` / headless `-p` with resume), so everything still shows up in `claude agents`, `/resume`, and Claude Desktop. We add no new execution runtime and no API-key handling.
- **Adapter interface from day one** even though only Claude Code ships in v1 — this is the hedge against Claude Code absorbing the feature (section 9).
- **Blueprints are plain JSON files in the repo** → diffable, reviewable, shareable, no lock-in. Optional **export to a Claude Code dynamic-workflow script** so the visual editor and the native feature reinforce each other instead of competing.
- **The hook bridge stays the source of "what is happening now"**; transcripts stay the source of "what happened and what it cost." The engine reconciles both.

### Spike results (2026-09-20, full detail in `docs/spikes/claude-cli.md`)

1. **Headless surface — answered.** `-p --output-format json` returns `result`, `structured_output` (with `--json-schema`), `session_id`, exact `total_cost_usd` and per-model token usage; `--max-budget-usd` is a native cap.
2. **Worktrees — answered.** `-w <name>` works with `-p`: creates `.claude/worktrees/<name>` on branch `worktree-<name>`; fails on a repo with no commits; leaves the worktree locked.
3. **Stop/inject — mostly answered.** `claude stop <id>` and `claude rm <id>` (removes the worktree when safe) beat killing the process tree for `--bg` sessions. Human gates should be step boundaries resumed with `--resume`, not mid-run injection.
4. **Token accounting — answered, and simpler than feared:** engine-driven steps get it from the result JSON; transcripts are only needed for replay.
5. **Windows long prompts — still open.**

Consequence: most engine primitives already exist in the CLI. That lowers our build cost and *raises* the competitive risk in §9 (Anthropic has the same primitives).

### Original spike list (kept for reference)

1. Exact headless CLI surface: structured/JSON output, schema-validated results, `--resume`, permission modes, how to get a final result and token usage back from a `--bg` session.
2. Whether `claude --bg` sessions are created in their own worktree automatically or we must create it (docs say agent-view dispatches move into a worktree; confirm for direct spawns).
3. Reliable way to *stop* one node (we currently kill the process tree — enough?) and to *inject* input mid-run for human gates.
4. Token accounting per step from transcripts (today we read only tail/head of each file — the engine needs exact per-step numbers).
5. Windows quoting/paths for long prompts (we already avoid a shell; keep it that way).

---

## 6. UX plan

Two views in one shell, switched from a left rail, plus a shared run drawer:

- **Floor** (redesigned in rev. 3, see [FLOOR_DESIGN.md](FLOOR_DESIGN.md)) is mission control, organised by *what needs a human*: four lanes (Needs you, Running, Ready to land, Done) over every project, with verified-vs-unverified branches, spend against ceiling on every card, a lit stepper for each run, and a launchpad per project. It replaces the old spatial "building" view.
- **Blueprints** is the n8n-style editor. Left: palette. Centre: canvas. Right: inspector, or the **run drawer** when a run exists. Bottom: Problems. While a flow runs, its nodes are lit and a run bar shows spend against the ceiling.
- **Runs** is not a separate tab. A run is shown as a card on the Floor and as a drawer in both views (the same component), because a separate list would be a third place to look. Still unbuilt: replay scrubber and fork-from-step.

Interaction rules learned from the bugs so far: hover cards must never hide behind siblings (fixed); no element may move while the user is trying to interact with it (agents no longer wander); nothing should depend on hover for essential information (status is always visible).

Approvals: a Gate awaiting a human raises a desktop notification and a badge on the Runs tab; approve/reject/edit from a side panel.

---

## 7. Phased roadmap

Each phase ends with something usable. Estimates are rough working-days for one person with AI assistance; treat as ordering, not commitments.

### Phase 0 — Foundation — ✅ DONE (2026-09-20)
- ✅ Fix blank canvas.
- ✅ CLI spike → [`docs/spikes/claude-cli.md`](spikes/claude-cli.md). Answered 4 of the 5 questions from real probes (see §5). Headless `-p` returns exact cost/tokens and schema-validated output, so the engine is cheaper to build than this plan assumed.
- ✅ Error boundary per view + main-process log file (`<userData>/logs/main.log`, crash handlers, renderer errors forwarded).
- ✅ Vitest (34 tests) and `scripts/smoke.mjs`: drives the **real** Electron app in an isolated profile, soaks it with hook events across the 1-minute mark, then exercises the editor. Verified it *fails* on the pre-fix `App.tsx` (every node stuck hidden) and passes on the fix, so it is a real regression test.
- **Exit met:** we know what the engine can rely on. Still open: Windows long-prompt limit, stdin prompts, whether an unchanged `-p` worktree is auto-removed.

### Phase 1 — Blueprint model + editor (design mode) — ✅ DONE, with known gaps (see §12)
- ✅ Zod schema (`src/shared/schema.ts`), migration seam, path-safe atomic store in `<repo>/.agentship/flows/*.flow.json` (`src/main/flows.ts`, tested against traversal and unregistered projects).
- ✅ Editor: library + pattern starters, palette (click or drag), drag-to-connect, inspector, Problems panel, undo/redo with edit coalescing, debounced autosave, error boundary.
- ✅ Validation beyond the plan: cycles (gate-fail loops allowed only with a retry cap), fan-out without join, unreachable nodes, parallel agents sharing a working tree, undeclared prompt variables, and a **worst-case token ceiling** that reports "unbounded" when any agent has no limit.
- ✅ Node kinds: Trigger(manual), Agent, Fan-out, Join, Gate(command | human), Merge.
- ✅ Dogfooding, partly: "Brief the orchestrator" and "Collect & merge" now render their prompts from the shipped **Supervisor** and **Merge train** blueprints (`agents.ts` reads them; test asserts the rendered merge brief). The Floor's orchestrator card still exists and still launches via `claude --bg`, because removing it before an engine exists would delete working features.
- ⚠ "Delete the hard-coded orchestrator" was **not** done, on purpose. It moves to Phase 2, when a blueprint can actually run.
- **Exit met:** build, save, reload, undo a flow. Nothing runs.

### Phase 1.5 — Harden the model before anything depends on it — ✅ DONE (2026-09-21)
- ✅ **External edits.** Saves are compare-and-swap on the file's hash. With no unsaved edits the editor follows the file (a pull or checkout reloads it); with unsaved edits a save is refused and a banner offers "Load the file on disk" or "Keep my version". Tested at the store (5 tests) and in Electron (an outside edit is picked up, not overwritten).
- ✅ **Schema tightened to what can execute.** `fanout.mode: 'list'` (no data source) removed. The engine refuses fan-out, join and merge nodes with a clear reason and the palette marks them "design only". Human gates are now real (the engine implements them). Still open: `join: best` has no judge.
- ✅ **Data between nodes decided:** `{{node-id.result}}`, `{{node-id.branch}}`, `{{node-id.cost}}` and `{{node-id.output.some.path}}` (a field of the node's `--json-schema` output). Validated in the editor, resolved by the engine, tested. Limit: a step's result is capped at 4,000 characters, so a very large JSON output stops resolving by path.
- ✅ `outputSchema` is checked to be valid JSON (not yet as JSON *Schema*). New in the schema: dollar budgets (`maxUsd`) and an agent `access` level (read | edit).
- ✅ Retry edges now loop underneath the nodes instead of doubling back across the forward edge.
- ⚠ Still open: flow `version` is never bumped.

### Phase 2 — Walking skeleton: ONE flow runs, end to end — ✅ DONE (scope narrowed as planned)
What shipped (`src/main/engine/`, `src/shared/runs.ts`):
- **Engine.** A single path through Agent and Gate nodes. Each step is `claude -p` with the prompt over stdin, an engine-chosen `--session-id`, `--permission-mode dontAsk` (read) or `acceptEdits` (edit), `--permission-prompts none`, and `--max-budget-usd`. Cost and tokens come from the result JSON.
- **Gate loop.** A failing command gate sends its output back to the repair node by *resuming that node's real session*, at most `maxRetries` times. Human gates pause the run until you approve or reject (a rejection's note is fed back the same way).
- **Money.** The run is held to a ceiling computed from the blueprint (fan-out and retries counted). Each step gets `min(its own cap, money left)`; no step starts with less than $0.02 left. Every card, the run bar and the confirmation dialog show spent against ceiling.
- **Git.** Each editing agent gets its own worktree and branch (`agentship/<run>-<node>`); the engine commits whatever the agent left, then removes the worktree and keeps the branch. Nothing is ever merged by a run.
- **Persistence.** Append-only JSONL per run (tolerates a torn last line); a run in flight when the app closed is marked "interrupted".
- **Before it starts,** a confirmation states from the file on disk what will execute: each agent's access and branch, the exact gate commands, the ceiling.
- **Lit canvas (pillar 5).** Editor nodes show state, attempt and cost live; the run drawer shows the step timeline with each gate's output.
- The hard-coded orchestrator card is gone. "Supervisor" is a normal runnable flow.

Deviations from the plan, and why:
- **Engine-managed worktrees, not `claude -w`** (spike finding: `-w` leaves worktrees locked and needs `git worktree` cleanup anyway). Predictable names, kept out of the repo (`<userData>/worktrees`).
- **The cap is "within one model call", not "never".** The CLI checks the dollar cap after each call. Measured against the real CLI: a $0.02 cap ended at $0.0217; a $0.001 cap at $0.0143. The UI says so. Token limits are only checked when a step ends.
- **"Land" first used the earlier background merge agent, which failed in real use.** It has been replaced by a landing *pipeline* run by the engine (see the rev. 3.1 note in §12).

Not done: resume after restart, parallel branches, triggers, OS notifications (a Needs-you badge on the rail only). (The merge node was added afterwards, see rev. 3.1.)

How it was verified: 88 tests (fake adapter against a real git repo for the walk, retries, cancel, budget, human gates; store, args, floor rules). Three opt-in **live** tests against the real CLI with Haiku, a few cents each: a one-agent flow ($0.026, real branch, gate passed, worktree gone); the dollar cap stopping a run ($0.02 cap, $0.0217 spent, gate never ran); and a repair loop where the builder writes the wrong content, the gate says so, and the engine resumes the **same real session**, which fixes it ($0.035). A full-UI run in Electron drives the whole path with a fake CLI. The literal exit demo (real planner and reviewer, real project) has **not** been run.

### Phase 3 — Git-native execution (≈1.5 weeks) — 🟡 partly built (2026-09-21)
**Built so far: resume-after-restart, the orphan sweep, an OS notification, and the Merge and Land nodes.**
- ✅ **Resume.** Closing the app now *suspends* runs: they end as `interrupted` (not `cancelled`), commit their work and remove their scratch worktrees before the process exits. A run killed outright is marked `interrupted` on the next launch. **Resume run** (Floor card and run drawer) reopens it with a `run.resumed` event and rebuilds the walker's state from the log (`src/main/engine/resume.ts`): spend, attempts, gate-failure counts, pending repair feedback, the builder's real session, the branch and each worktree. Finished steps are not repeated; the step that was in flight starts again from the top in a *new* session (a killed step may have left none), in the same branch, so whatever it wrote and had committed or left in an orphaned directory is still there. A worktree that is gone is re-attached to its branch. The recorded blueprint is used, not whatever is on disk now, so the run continues the flow the user confirmed. Refused when the run is not interrupted, is already live, or has no dollars left under its ceiling. **A run that had reached its Merge step resumes at the Merge step:** the merged result lives in a scratch copy that does not survive a restart, and nothing touches the base branch before Land, so re-merging is safe. Scratch copies with fixed names (`<run>-src`, `<run>-merge`) are cleared and recreated if a killed app left them behind.
- ✅ **Orphan sweep.** At startup, scratch directories that no run can resume in (finished runs, runs interrupted more than 7 days ago, unknown ones) have their uncommitted work committed onto their branch and are removed. Directories that are not recognisably a git worktree are left alone, never deleted.
- ✅ **OS notification** when a run needs approval or fails or runs out of budget while the window is not focused. Not sent for the app's own shutdown.
- ✅ **Merge and Land nodes exist (rev. 3.1)** for one branch at a time: merge in a scratch copy, an agent only if there are conflicts, test the merged result, advance the base only if it is still where it was (revert-on-red for free, since the base never moved). Left: a queue for landing several branches in order, and tests that need more than `node_modules` linked in.
- Tested (resume slice): 12 new tests, including a real suspend, restart with a new engine over the stored log, and resume; the same with an orphaned dirty directory; a prefix-replay of a whole run to check the planner at every kind of stopping point; the sweep against real worktrees. Smoke test still passes in Electron. **Not tested:** a real hard kill of Electron mid-run, resume against the real `claude` CLI (the fake adapter stands in), and resuming a run that was interrupted inside a Merge/Land flow.
- **Still to build in this phase:** fan-out/join and parallel scheduling (the walker is still one path; this is a rewrite of `execute`, not an addition), a real judge for `join: best`, parsed test/lint results, and parallel-safe worktree names (today `<run>-<node>`, which fan-out instances would collide on).
- Gates: test/typecheck/lint runners with parsed results; retry-with-repair loop with cap.
- **Exit:** "PR factory" flow: issue text in → tested branch out, no manual git.

### Phase 4 — Triggers, approvals, estimator (≈1 week)
- Schedule, git-event, file-watch, webhook triggers (local listener, loopback only by default).
- Human-approval gates with notifications.
- Dry-run cost/time estimator from historical runs of the same blueprint (starts vague, improves with data).

### Phase 5 — Patterns, replay, portability (≈1.5 weeks)
- Ship the pattern library (Debate, Tournament, Red/Blue, Map-reduce, Bug-triage swarm).
- Replay scrubber + fork-from-step.
- Export blueprint → Claude Code dynamic-workflow script; import simple ones back.
- Expose an **MCP server** so agents (or Claude Desktop) can start flows and approve gates.

### Phase 6 — Ecosystem (open-ended)
- Blueprint sharing (import by URL/file, signed manifest, permission summary before running — a blueprint is code that spends money and edits repos, so treat it like an installable).
- Second adapter (Codex CLI or Gemini CLI) to prove the abstraction.
- Team features: shared budgets, run history export. Only if demand appears.

---

## 8. Success measures

- **Time-to-first-run**: install → a real flow finished on the user's repo in < 10 minutes.
- **Trust**: 0 runs exceeding their budget ceiling; 0 unrecoverable repo states after a cancelled run.
- **Stickiness**: % of users who save ≥ 1 custom blueprint; runs per week per user.
- **Proof of value**: median human minutes saved on the merge step (baseline: today's manual merge).
- **Reliability**: run resumes correctly after app restart in ≥ 99% of test cases.

---

## 9. Risks and honest counter-arguments

| Risk | Why it matters | Mitigation |
|---|---|---|
| **Anthropic ships a visual workflow editor** | Claude Code already has workflows, agent view, agent teams; a first-party canvas is the obvious next move | Adapter layer (multi-vendor), git-native merge/gates/budget depth, local blueprints as open files, export to native workflows so we *complement* rather than compete |
| **"Nobody has done this" may be false** | The space moves monthly; I found no exact match but my search is not exhaustive. **The Phase 0 teardown was NOT done** (it needs installing and running other products, which was out of scope for this pass). | Do the teardown *before Phase 2*: Claude Code dynamic workflows, Superset, Claude Squad, diri. Half a day each. If one already has gated, budget-capped, git-native flows, change the pillars. |
| **The blueprint file is not a moat** (added in rev. 2) | A JSON DAG of agent/fan-out/join/gate is isomorphic to what Claude Code's `agent()/parallel()/pipeline()` scripts already express; the visual editor alone is copyable in weeks | Compete on what is *enforced at run time* (hard budget, gates, git isolation, replay), not on the file format. Add export-to-workflow-script so the editor stays useful even if Anthropic ships its own runtime |
| **Non-determinism** | Agents are flaky; flows built on them inherit that | Gates + retry caps + replay; never claim determinism |
| **Cost surprise** | The #1 complaint in the research | Budgets/breakers before any parallel feature ships |
| **Security** | Blueprints/agents run commands and edit repos; shared blueprints are a supply-chain vector | Permission summary before run, default-deny tool lists, no auto-run on import, loopback-only listeners |
| **Scope explosion** | This is a multi-month product | Phase gates above; each phase must be independently useful; cut Phase 6 first |
| **Depends on undocumented behaviour** (transcripts, `claude agents --json`) | Could break on a Claude Code update | Isolate behind adapter; contract tests run against the installed CLI on startup with a clear "unsupported version" message |

---

## 10. Decisions I need from you before Phase 1

1. **Audience:** solo developers first (recommended — simplest, your own use case), or teams/enterprise from the start?
2. **Scope of "workflow":** coding-agent flows only (recommended for v1 — it is where the moat is), or also general automations like n8n (Slack/Sheets/email triggers) — which makes us compete head-on with n8n.
3. **Distribution:** stay a personal/open-source Electron app, or aim at a product (licensing, auto-update, telemetry decisions)?
4. **Runtime:** Claude-Code-only in v1 (recommended), or multi-vendor from the start?
5. **Name/brand:** keep "Agent Ship" (and the ship/building metaphor) or rename around "orchestration"?

## 11. What I'd do next, in order (rev. 3)

1. **Use it on real work before building more.** Run the Pipeline on a real task in a real repo with real models, five times. The open questions are no longer engineering ones: does the builder produce something a gate can meaningfully verify, what does it cost per task, what breaks on a real `npm test` on Windows, and how often does the repair loop converge. Everything in §12 that says "unproven" is decided here.
2. **The competitor teardown (still not done).** Claude Code's agent view and workflows, Superset, Claude Squad, Vibe Kanban. Half a day each, before Phase 3 commits the next weeks.
3. **Phase 3, in this order:** ~~resume-after-restart and an orphan-worktree sweep~~ (done, see §7); then fan-out/join with a real judge for "best of N" (the Merge node already exists, see §7).
4. ~~Turn a session's uncommitted work into something landable~~ **Done in rev. 3.3** (see §12.3c).
5. **Floor gaps found while building it:** ~~OS notification when something enters Needs you~~ (done for runs; not for ad-hoc sessions); keyboard triage (j/k/enter); per-session cost for ad-hoc work (transcripts, not exact); search across projects; "Needs input" for ad-hoc sessions depends on what `claude agents --json` reports (only idle/busy observed).
6. §10's questions still stand; the recommended defaults are still assumed.

---

## 12. Evaluation (rev. 3, 2026-09-21)

Method: unit tests, live tests against the real CLI, an automated end-to-end run in Electron against a real git repo, and screenshot review of the running app on the real machine's data (the Floor showed the user's own repos, branches and sessions). Judgement calls are marked.

### 12.1 Code

**Verified**
- Typecheck and build clean; 85 tests run by default (3 more are opt-in live tests). The Electron test drives a whole run through the real UI: launch from the Floor, confirmation, gate fails once, builder repaired by session resume, verified branch appears, real `git` state checked (branch holds the work, `main` untouched, scratch worktree gone, ledger sums to the cent), then the editor shows the same run lit, and an outside edit to an open flow is picked up.
- Safety properties are tested, not asserted: prompts never on the command line; no `bypassPermissions`; nothing is allowed to prompt; the renderer names a project and a flow, never a path, and the engine reads the blueprint from disk itself; run ids and flow names are validated; a crash mid-write cannot lose the next event.
- Found by testing and fixed: a store bug (a torn last line swallowed the next event, so an interrupted run could never be marked finished); a false "unbounded" claim in the inspector once dollars became the enforced limit; a range-delete that removed IPC handlers (caught by the compiler and the Electron test).

**Weaknesses, ranked**
1. **Unproven on real work.** Every real-CLI run so far is a toy task. Whether the pipeline yields mergeable code at a sane cost is the central unknown and the next step.
2. ~~**No resume.**~~ *Fixed after this evaluation (see §7, Phase 3): interrupted runs resume and orphaned worktrees are swept. Not yet exercised with a real hard kill of Electron or the real CLI.*
3. **"Edit access" is weaker than it sounds.** Under `acceptEdits` a simple shell write was allowed in the spike, so containment is the worktree, not the permission mode. A step with edit access and *no* worktree edits the live checkout (the editor warns; the run confirmation says it plainly).
4. **POSIX untested.** Everything was exercised on Windows only. Process-tree killing on macOS/Linux (`detached` + negative pid) is written but has never run.
5. Smaller: `blocked` / `waiting` / `waitingFor` are implemented from the CLI's documented values but have never been seen on real output (only `busy`, `idle` and `done` have); the Floor polls git every 30 s per project; flow `version` is never bumped.
6. Test-suite hygiene: the Electron test once raced the library's async load (fixed by waiting); the dev mock is a second implementation of the API that can drift.

### 12.2 Against the five pillars (rev. 2 score in brackets)

| Pillar | Now | Honest status |
|---|---|---|
| 1. Orchestrator is a pattern | **Partly real** (was nominal) | Supervisor and Pipeline are data and *run*. But a "Supervisor" is still one agent, and delegation is Claude's own; the second half of the claim (choose a pattern per task) has not been tried. |
| 2. Git-native | **~55%** (was ~5%) | A worktree per editing agent, engine-made commits, the branch as the outcome, verification shown per branch. Missing: parallel branches and a merge queue (Land is the legacy agent). |
| 3. Verification gates | **~75%** (was design-only) | Command and human gates run, with a bounded repair loop that resumes the real session. Missing: parsed results, LLM judge. |
| 4. Budget first-class | **~80%** (was unenforced) | Designed ceiling, enforced per step, spent-vs-ceiling on every card. Honest limit: enforced within one model call; tokens only between steps; flows are not tied into the weekly fuel gauge. |
| 5. Design and Run are one canvas | **~65%** (was 0%) | Runs light up the editor and the Floor's stepper; jump between them both ways; failed run offers "Edit flow" at the failing node. Missing: replay/scrub, live transcript. |

### 12.3 How revolutionary is it?

**A credible wedge now, still not a revolution.** The difference from rev. 2 is that the whole loop is real and was proven end to end against the actual model: type a task, get a gated branch that was built in isolation, repaired by resuming its own session when its tests failed, stopped by a dollar cap, and presented as *verified* or *unverified*.

What is genuinely new, as far as I can tell (I have not run the competitors; see §11.2):
- **Verified vs. unverified as the primary organising idea of a Floor.** Other tools group by *state* (working, needs input, done). Grouping by *what a person should do* and marking finished work by whether a gate proved it addresses the "agents say done when it is not" pain directly.
- **Money as a first-class number on every card**, with a design-time ceiling that becomes the run's enforced limit. Claude Code's own agent view shows no cost at all.
- **One product for design, run and outcome**, with the same run drawn in both places.

What is *not* new: the four-lane board resembles agent view and Superset's categories, and a node editor is table stakes. If a competitor added gates and a ceiling, the visible product would look similar; the advantage is the engine's guarantees, not the pixels.

**What would make it revolutionary:** (1) evidence on real projects that pipelines produce mergeable work at acceptable cost. Without that the platform is a well-built harness around an unproven claim. (2) Parallel best-of-N with a judge, the pattern only a gated, budgeted, git-native runtime makes safe. (3) Learning from runs: estimate cost and failure risk from history (the ceiling-vs-actual data now exists), and surface which gate fails most.

### 12.3b Rev. 3.1 addendum: landing is a pipeline, and two reported bugs

**Reported and fixed**
- *Blueprints tab: project dropdown empty.* The editor listed only *registered* projects while the Floor also showed projects merely discovered from Claude sessions, so a machine with none registered saw nothing. Both tabs now share one project list; discovered git repos appear as "(not added yet)" and are registered when picked; there is a "+ Add project" button and an honest empty state. Covered by the Electron test.
- *"Land" failed.* Landing used a background `claude --bg` agent told to run `git merge` in your real checkout, which had no way to be approved and could not be observed. It is gone. I did not root-cause its exact failure; the design was the problem.

**What landing is now** (engine: `merge` and `land` steps, `gitops.ts`; UI: dialog, card pipeline, drawer)
1. Test the branch in a scratch copy of it. 2. Merge it into a scratch copy of the base (an agent is called *only* on conflicts, with edit access and `git add/status/diff/show/log` only: no commit, push or checkout). 3. Test the merged result. 4. Move the base, only if it has not moved since; if it is checked out, its files move with it, and a dirty checkout is refused. Any failure leaves the base exactly as it was.
- The pipeline appears **on every card** as Build → Test → Merge → Land, whatever the task is made of: an ad-hoc session (Build only), a flow run (agents = Build, gates = Test), or a branch (built by a session/run, tested by a gate, landed by a landing run). One task is one card even when it is several real sessions; click a stage in the drawer to see the real steps, output, or open the real session.
- A landing run is not its own card: it lights the Merge and Land stages of the branch it is landing, moves that card to Running, and to Needs you (with the reason) if it stops.

**Evidence:** 15 real-git tests (clean land; base checked out vs not; tests failing on the branch and on the *merged* result, base untouched; dirty checkout refused; base moving mid-land; conflicts with/without the resolver; a resolver that leaves markers is rejected; dependency links never deleting real `node_modules`); 8 tests for the pipeline rules; the Electron test lands a verified branch into a real repo through the UI; and one opt-in live test where the **real model resolved a real conflict** under the restricted tools ($0.17: the merge step uses your default model, so it is not the cheapest option).

**Rev. 3.2: open sessions.** Two more defects found by using it, both fixed and tested:
- *A finished session stayed "building".* The Floor equated "process alive" with "working". It now reads the CLI's documented `status` / `state` / `waitingFor` (`sessionActivity`, one row per rule in the tests) and falls back to recent hook activity, never to a blanket assumption; an unrecognised value means "no information". An idle session's Build is done, its uncommitted files or unmerged commits appear as "✎ N uncommitted files" with Test, Merge and Land waiting, and a blocked one goes to Needs you saying what it is waiting for. Rules and rationale: FLOOR_DESIGN §8.
- *Session cards overflowed.* Card-kind class names (`fc-session`, `fc-branch`) collided with inner elements' classes, so whole cards were styled like an inner row. Renamed (`fc-k-*`); measured before and after.
- The end-to-end test now flips a session busy → idle → blocked through the real `claude agents` path, with every check pinned to that session (the first version passed for the wrong reason, satisfied by an unrelated real session).

**Rev. 3.3: the missing piece, "Commit & land".** Reported: an open session with uncommitted files sat in Ready to land with no way to land it; and after committing and merging by hand, the card went to Done with the pipeline dashed, as if nothing had happened. Both were real gaps: landing only worked on *branches*, and nothing connected a session's loose files to one.
- **Commit & land** (button on such a card and in its drawer; dialog lists every step first). *On a feature branch:* the files are committed onto it (as `git add -A && git commit` would), then the ordinary landing runs. *On the base branch itself* (a session working directly on `main`): nothing untested is ever committed to it. The files are snapshotted onto a **new branch**, which is tested and merged in scratch copies; only at the end does `main` move, and the working files are **absorbed** only if they are byte-identical to the tested result, so the branch and the files become the same commit and no file changes. If you edit anything while it runs, it stops and keeps your edit.
- All of it uses git objects directly (a throwaway index, `commit-tree`, `update-ref`); it never checks anything out or rewrites your files. Untracked files count; `.gitignore` and `node_modules` do not.
- **The card reflects what happened.** A landing is tied to the *specific session* that asked for it (siblings in the same folder are not credited); that session's card then shows the landing's real pipeline ("Tested, merged and landed by Agent Ship").
- **Work you commit yourself** is shown as such: Build ✓, Test – (no test ran through Agent Ship), Merge and Land as a new **by hand** state (dashed green ✓), never as tested. This is an *observation* (we saw the work pending, then gone with the checkout moved), decided by `whoClearedIt`: a landing explains it only if it finished after that episode of pending work *began*. (A first version anchored on the last time the work was seen, which git polling made wrong: caught by the end-to-end test, fixed, and unit-tested.)
- **Evidence:** 11 real-git tests (snapshot touches neither index, files nor branches; commit like `git commit`; detached HEAD refused; landing work that sits in main's own checkout leaves every file unchanged including a deletion, an untracked file and an edit; refuses if you edited during the test; failing tests leave everything as it was); 15 unit tests for the attribution rules; and the Electron test drives it on a session working on `main`, then a hand-commit, in a real repo.
- **Limits:** the by-hand label is inferred, not proven (git cannot say who committed); a checkout on a detached HEAD is refused; a session that *discards* its files is neither; the snapshot includes every non-ignored untracked file (the dialog shows the count, not the list); "Land" still lands one branch at a time.

**Limits found:** test-command detection only knows npm, cargo, go and pytest (otherwise you type one, or land unverified, which the dialog says); only `node_modules` is linked into scratch copies, so projects with other untracked dependencies (a Python venv, a build cache) may fail their tests there; landing several branches means landing one at a time; a scratch copy is deleted a few milliseconds after the run reports finished.

### 12.4 What I did not do

- No competitor teardown; no user testing (checked by scripts and screenshots only); Windows only.
- The literal Phase 2 exit demo with a real planner and reviewer on a real project.
- Live tests used Haiku on trivial tasks; behaviour with larger models, long tasks, or a real test suite is unmeasured.
- Process notes: the earlier accidental `claude --bg --help` session was removed; live tests left a few small sessions in Claude's history for scratch folders; nothing is committed by this pass.

---

## Sources

- Market: [MarketsandMarkets — Agentic AI](https://www.marketsandmarkets.com/Market-Reports/agentic-ai-market-208190735.html) · [Mordor — workflow orchestration](https://www.mordorintelligence.com/industry-reports/agentic-ai-workflow-orchestration-platform-market) · [Mordor — multi-agent platforms](https://www.mordorintelligence.com/industry-reports/multi-agent-system-platform-market)
- n8n: [PitchBook](https://pitchbook.com/news/articles/ai-agent-startup-n8n-lands-2-5b-valuation-with-180m-series-c) · [Sacra](https://sacra.com/c/n8n/) · [Automation Atlas](https://automationatlas.io/answers/n8n-series-c-valuation-2025/)
- Builder comparisons: [Hugging Face blog](https://huggingface.co/blog/daya-shankar/n8n-vs-flowise-vs-langflow-enterprises) · [AgentSwarms](https://agentswarms.fyi/blog/flowise-vs-langflow-vs-dify-vs-n8n-vs-agentswarms)
- Coding-agent orchestrators: [Augment](https://www.augmentcode.com/tools/open-source-agent-orchestrators) · [Nimbalyst](https://nimbalyst.com/blog/best-tools-for-running-parallel-ai-coding-agents/) · [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators)
- Claude Code: [Run agents in parallel](https://code.claude.com/docs/en/agents) · [Workflows write-up](https://alexop.dev/posts/claude-code-workflows-deterministic-orchestration/) · [Agent teams vs subagents](https://www.mindstudio.ai/blog/claude-code-agent-teams-vs-sub-agents) · [Addy Osmani — swarms](https://addyosmani.com/blog/claude-code-agent-teams/)
- Production pain: [FutureAGI](https://futureagi.com/blog/trace-debug-multi-agent-systems-observability-guide/) · [Augment guide](https://www.augmentcode.com/guides/multi-agent-ai-production-requirements) · [Lanham](https://medium.com/@Micheal-Lanham/multi-agent-in-production-in-2026-what-actually-survived-f86de8bb1cd1)

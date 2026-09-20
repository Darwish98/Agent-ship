# Agent Ship → an orchestration platform for coding agents

Status: **plan only — nothing in here is built yet.** Written 2026-09-20.
Working name stays "Agent Ship" until the product is clearer.

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

### Things that must be verified in a spike before we commit (I don't know these yet)

1. Exact headless CLI surface: structured/JSON output, schema-validated results, `--resume`, permission modes, how to get a final result and token usage back from a `--bg` session.
2. Whether `claude --bg` sessions are created in their own worktree automatically or we must create it (docs say agent-view dispatches move into a worktree; confirm for direct spawns).
3. Reliable way to *stop* one node (we currently kill the process tree — enough?) and to *inject* input mid-run for human gates.
4. Token accounting per step from transcripts (today we read only tail/head of each file — the engine needs exact per-step numbers).
5. Windows quoting/paths for long prompts (we already avoid a shell; keep it that way).

---

## 6. UX plan

Three modes in one shell, switched from a left rail (not more toolbar buttons):

- **Floor** — today's building view, kept. Now every room shows the flows running in it; agents are the crew of the *active runs*. Pulse ring + status pill (already done) shows work in place.
- **Blueprint** — the n8n-style editor. Left: node palette + pattern library. Centre: canvas. Right: inspector (prompt, model, tools, budget, gate rules). Bottom: dry-run estimate and validation problems ("this fan-out has no join").
- **Runs** — list of runs with status/cost/duration; open one to see the graph coloured by state, click a node → transcript, diff, artifact, gate verdict; **Replay** scrubber; **Fork from here** (re-run from a step with a changed prompt).

Interaction rules learned from the bugs so far: hover cards must never hide behind siblings (fixed); no element may move while the user is trying to interact with it (agents no longer wander); nothing should depend on hover for essential information (status is always visible).

Approvals: a Gate awaiting a human raises a desktop notification and a badge on the Runs tab; approve/reject/edit from a side panel.

---

## 7. Phased roadmap

Each phase ends with something usable. Estimates are rough working-days for one person with AI assistance; treat as ordering, not commitments.

### Phase 0 — Foundation (≈2–3 days)
- ✅ Fix blank canvas (done).
- CLI spike answering the five open questions in §5. Write findings to `docs/spikes/claude-cli.md`.
- Add an error boundary + main-process log file so a future crash is diagnosable instead of "reload".
- Add tests scaffolding (Vitest) + a CDP smoke script (the one used to reproduce the bug) as a regression test.
- **Exit:** we know exactly what the engine can rely on.

### Phase 1 — Blueprint model + editor (design mode) (≈1–1.5 weeks)
- Zod schema for blueprints, migrations, load/save to `.agentship/flows/`.
- Blueprint canvas: palette, drag-to-connect, inspector, validation (cycles, missing join, unreachable nodes), undo/redo, autosave.
- Node kinds v1: Trigger(manual), Agent, Fan-out/Join, Gate(command + human), Merge.
- Remove the hard-coded orchestrator; convert "Brief the orchestrator" and "Collect & merge" into two shipped blueprints (Supervisor, Merge-train) — **dogfooding proof that the model is expressive enough.**
- **Exit:** you can build, save, reload and version a flow. Nothing runs yet.

### Phase 2 — Run engine + live run view (≈1.5–2 weeks)
- Persistent run store; DAG scheduler with sequential + parallel; cancel; resume after app restart.
- ClaudeCodeAdapter: spawn, observe (hooks + transcripts), collect result, stop.
- Runs tab, live graph state, per-node transcript link ("Open in Claude Code" already exists).
- Budget ledger + hard circuit breakers (tokens/time/retries) — *ship this early; it is the trust feature.*
- **Exit:** "Pipeline" and "Supervisor" flows run end-to-end on a real repo.

### Phase 3 — Git-native execution (≈1.5 weeks)
- Worktree manager (create/cleanup/orphan sweep), branch naming, per-node isolation.
- Merge node: ordered merge queue, conflict detection, resolver agent, revert-on-red.
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
| **"Nobody has done this" may be false** | The space moves monthly; I found no exact match but my search is not exhaustive | Do a proper competitor teardown (install Superset, diri, Claude Squad, Dify) in Phase 0 and adjust the pillars |
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

## 11. What I'd do next, in order

1. You answer §10 (5 short questions — defaults in bold above are my recommendation).
2. Phase 0: CLI spike + error boundary + regression script.
3. Phase 1 kickoff: blueprint schema and the editor shell, starting by re-expressing the two existing behaviours (brief orchestrator, merge-all) as blueprints.

---

## Sources

- Market: [MarketsandMarkets — Agentic AI](https://www.marketsandmarkets.com/Market-Reports/agentic-ai-market-208190735.html) · [Mordor — workflow orchestration](https://www.mordorintelligence.com/industry-reports/agentic-ai-workflow-orchestration-platform-market) · [Mordor — multi-agent platforms](https://www.mordorintelligence.com/industry-reports/multi-agent-system-platform-market)
- n8n: [PitchBook](https://pitchbook.com/news/articles/ai-agent-startup-n8n-lands-2-5b-valuation-with-180m-series-c) · [Sacra](https://sacra.com/c/n8n/) · [Automation Atlas](https://automationatlas.io/answers/n8n-series-c-valuation-2025/)
- Builder comparisons: [Hugging Face blog](https://huggingface.co/blog/daya-shankar/n8n-vs-flowise-vs-langflow-enterprises) · [AgentSwarms](https://agentswarms.fyi/blog/flowise-vs-langflow-vs-dify-vs-n8n-vs-agentswarms)
- Coding-agent orchestrators: [Augment](https://www.augmentcode.com/tools/open-source-agent-orchestrators) · [Nimbalyst](https://nimbalyst.com/blog/best-tools-for-running-parallel-ai-coding-agents/) · [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators)
- Claude Code: [Run agents in parallel](https://code.claude.com/docs/en/agents) · [Workflows write-up](https://alexop.dev/posts/claude-code-workflows-deterministic-orchestration/) · [Agent teams vs subagents](https://www.mindstudio.ai/blog/claude-code-agent-teams-vs-sub-agents) · [Addy Osmani — swarms](https://addyosmani.com/blog/claude-code-agent-teams/)
- Production pain: [FutureAGI](https://futureagi.com/blog/trace-debug-multi-agent-systems-observability-guide/) · [Augment guide](https://www.augmentcode.com/guides/multi-agent-ai-production-requirements) · [Lanham](https://medium.com/@Micheal-Lanham/multi-agent-in-production-in-2026-what-actually-survived-f86de8bb1cd1)

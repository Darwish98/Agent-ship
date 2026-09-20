# The Floor, redesigned

Written 2026-09-20. Companion to [PLATFORM_PLAN.md](PLATFORM_PLAN.md).

## 1. What was wrong with the old Floor

The old Floor was a spatial metaphor: a room per project, pixel crew members wandering inside, one fixed Orchestrator card. Reviewing it honestly:

| Problem | Evidence |
|---|---|
| **It answers "what is happening", not "what do I do next".** | Every card is an *activity* (status text, battery). Nothing is ranked, nothing says "this needs you". |
| **It only shows projects that have had agents.** Rooms are derived from sessions + hook events, so an idle project, or one where flows *could* run, is invisible. | `useAgentWorld.rooms` |
| **It hides outcomes.** The valuable thing an agent produces is a *branch with a verdict*. That appears only as a tiny envelope icon and a hover card. | `AgentNode` envelope |
| **No money.** Nothing shows what a piece of work cost or how close it is to a limit. | (absent) |
| **Blueprints are invisible on it.** There is no notion of a flow, a run, or a step. | (absent) |
| **The canvas is the wrong tool for a dashboard.** Free positioning, zoom and React Flow measurement produced the blank-canvas bug, and density is low: 8 agents fill a screen. | git history |
| **The orchestrator links** (drag a line from the orchestrator to an agent) recorded a relationship nothing used. | `links.json` |

## 2. What the research says

Sources: [Claude Code agent view docs](https://code.claude.com/docs/en/agent-view), [Superset's parallel-agents guide](https://superset.sh/parallel-coding-agents), [supervising coding agents](https://dev.to/battyterm/how-to-supervise-ai-coding-agents-without-losing-your-mind-53m4), and a survey of [Vibe Kanban, Conductor, Claude Squad, AgentsRoom](https://www.mindstudio.ai/blog/ai-command-center-managing-multiple-claude-code-agents).

1. **The scarce resource is human attention, not agents.** Consistent across sources: past 3–5 parallel agents, context-switching dominates; "which one needs me" is the real question. ([Superset](https://superset.sh/parallel-coding-agents): "the ceiling is how many independent tasks you can produce *and review*".)
2. **State-grouped triage is now table stakes.** Claude Code's own agent view groups sessions into Needs input / Ready for review / Working / Completed, with peek-and-reply. Superset groups working / needs attention / needs review / merged. Anything that is merely "a nicer list of sessions" duplicates a first-party feature.
3. **What agent view does not do** (stated in its docs): no token or cost display; no notion of a plan larger than one session; no verification (a "Completed" session is one that stopped, not one whose tests pass); no authoring.
4. **Named pains no tool addresses well:** agents declaring "done" when the code does not work; review bandwidth; worktrees and branches accumulating until the disk complains; nothing tying a diff back to *why* it exists.

## 3. The concept: mission control organised around *outcomes and attention*

The Floor stops being a picture of agents and becomes a **control room over units of work**. A unit of work is one of:

- a **Run**: an execution of a blueprint (many steps, one budget, gates), or
- a **Session**: an ad-hoc Claude Code session started outside a flow, or
- a **Branch**: finished work waiting to be landed.

Every unit of work sits in exactly one of four **lanes**, ordered by what the human should do:

| Lane | Meaning | Examples |
|---|---|---|
| **Needs you** | Blocked on a person, or failed | A human gate awaiting approval; a run that hit its budget or exhausted gate retries; a session that reports needing input |
| **Running** | Work in progress, no action needed | Live runs (with their flow lit up step by step), live sessions |
| **Ready to land** | Finished work with a branch | Branch ahead of base; badged **✓ tests passed** when a gate verified it, **unverified** otherwise |
| **Done** | Recently finished, nothing to do | Passed runs already landed, idle sessions from today |

Why this is different from a list of sessions:

1. **Verified vs. unverified is a first-class distinction.** "Ready to land" separates work a Gate proved (command exit 0) from work that merely stopped. This directly answers the "agents say done when it is not" pain, and only a tool that owns the flow can do it.
2. **Every card carries money.** Spent versus ceiling for runs; token/context for sessions; a fuel line for the week. Runaway spend is visible before it is a surprise.
3. **A Run card shows its flow, lit.** A miniature of the blueprint graph with each step coloured idle / running / passed / failed / awaiting. You see *where in the plan* the work is, not just that an agent is busy.
4. **All projects are present.** A left rail lists every registered and discovered project, with attention counts, git health and a launchpad, whether or not anything is running there.
5. **Ranked, not sorted by recency.** Needs-you items are ordered by cost of waiting (a blocked run holding a budget outranks a stale session).

Deliberately **not** built: a spatial map (no information density), free-drag layout, or a pixel-crew wandering animation. The pixel sprites remain as small avatars on session cards, because they give each agent a stable, recognisable identity at a glance.

## 4. How the Floor and Blueprints work together

Three nouns, one loop:

```
   Blueprint  ──run──▶  Run  ──produces──▶  Branch  ──land──▶  base branch
   (design)           (execution)          (outcome)
        ▲                 │                     │
        └──── edit ◀──────┴── Floor shows all three, lit and costed ──┘
```

- **Blueprint = a class, Run = an instance, Floor = operations over instances.** The editor is where you *design* a flow; the Floor is where you *operate* it.
- **Launch from either side.** Editor: the Run button. Floor: each project has a launchpad listing its flows. Both open the same confirmation that states exactly what will execute (agents and their access, gate commands, dollar ceiling) before anything starts.
- **The same picture in both places.** A running flow is lit on the editor canvas and as a mini-graph on its Floor card. Clicking a card's step opens that step in the editor ("Open in flow"); clicking a step in the editor shows its transcript/branch, the same drawer the Floor uses.
- **Gates and budgets are the seam.** Gates *produce* the Needs-you lane (approval, failure); budgets *are* the number on every card. Design-time ceiling (computed in the editor) appears next to actual spend on the Floor, which is also the data the Phase 4 estimator will learn from.
- **Failure loops back to design.** A failed run offers **Edit flow**, opening the editor at the failing node.
- **Sessions the engine starts are recognised.** The engine picks each session's UUID, so the Floor folds those sessions under their Run instead of listing them twice.
- **Ad-hoc work stays first-class.** Sessions started by hand still appear, so the Floor is useful before anyone writes a blueprint.

## 5. Honest limits of this design

- Session state comes from what `claude agents --json` documents (`status`, `state`, `waitingFor`), read by `sessionActivity` in `shared/floor.ts`. Runs have exact states because the engine owns them; sessions do not. Where the CLI gives nothing usable the Floor falls back to recent hook activity and never to a blanket assumption (see §8).
- Verification only exists for work that went through a Gate. Everything else is honestly labelled unverified.
- The "Land" action still uses the earlier merge-agent path (a background Claude session with the Merge train brief). A Merge node in the engine is later work.
- Cost for ad-hoc sessions is token-based (from transcripts); only engine runs have exact dollars.

## 6. As built (2026-09-21)

Shipped: the four lanes over every project, the project rail with a launchpad, run / session / branch cards, the detail drawer, and the Floor ↔ editor round trip. Verified in Electron against the real machine's data and a full run.

How it differs from the concept above:

- **Ready to land lists every local branch ahead of the base**, including the branch currently checked out, because that is what the earlier merge feature offered. Branches untouched for two weeks are collapsed behind "Show N stale branches".
- **Done shows the last 24 hours.** Older idle sessions are counted ("N older sessions not shown") so nothing disappears silently.
- **The project rail lists every registered project and every folder Claude Code has worked in.** Discovered folders offer "+ Add to Agent Ship", accepted only if the folder is a git repository, so a flow can never be written into an arbitrary directory.
- **Launchpad:** each project lists its flows, offers "Add starter flows" (Supervisor and the gated Pipeline) when it has none, and links to the editor.
- **The lit stepper wraps** instead of scaling the graph, because a scaled canvas has unreadable labels at card size.
- **The "orchestrator" card and drag-a-line links were removed.** Nothing consumed them.

Not built, in priority order: an OS notification when something enters **Needs you**; keyboard triage (j/k/enter); search across projects; per-session cost for ad-hoc work; a "Land all verified" action; and replay of a finished run.

Found during the build: only `busy`/`idle` (and `done` for background sessions) have been seen on real output. "Waiting for input" is implemented from the documented values (`state: blocked`, `status: waiting` + `waitingFor`) and covered by tests and a simulated end-to-end run, but has not been seen on a real session. Flow runs do not have this limit because the engine owns their state.

## 7. A pipeline inside every task (added after first use)

The first version showed *sessions*, *runs* and *branches* as three unrelated kinds of card, and "Land" was one button that started a background agent. In use, that hid the thing that matters: **one piece of work goes through several stages, often in different sessions.** So every card now carries the same four-stage pipeline:

| Stage | Where the state comes from |
|---|---|
| **Build** | the session or flow run that made the work |
| **Test** | a gate: in the run that built it, or in the landing run |
| **Merge** | the landing run's merge step (in a scratch copy of the base) |
| **Land** | the landing run's last step: the base branch actually moves |

- The strip is identical on session, flow-run and branch cards, so the board reads as one pipeline with tasks at different points, not three card types.
- **One task, one card,** even when it is really several sessions: the author session, its gate and the landing run are joined by branch. A landing run lights the Merge and Land stages of *its branch's* card instead of appearing as a separate card.
- **Click a stage** to see what is behind it: the real steps with their output, cost and attempts, or a button that opens the real Claude Code session that built it.
- A stage that is not part of a flow shows dashed ("skipped"), and a task nobody has tested says so ("unverified, landing tests it first") instead of looking finished.
- Stages reflect steps that have *run*: a Test stage with a before-merge and an after-merge gate reads passed after the first and lights red only if the second fails.

## 8. Is an open session working, waiting, or finished? (added after first use)

The first version treated "the Claude process is alive" as "the agent is working", so a session that had *finished its response* stayed in Running with Build lit forever, even with uncommitted files waiting. A later patch treated an unrecognised status as "working" too, which is the same mistake: assuming instead of reading.

`sessionActivity` now decides, in this order:

1. **Blocked on a person**: `state: blocked`, or `status: waiting` with a `waitingFor`. Goes to Needs you and says what for ("Waiting for you: permission prompt"). Decided first, because a tool hook fires just before a permission dialog.
2. **A tool ran in the last 5 s**: working, even if the last poll said idle. The CLI is polled every ~10 s, so it can lag a session that just started a new turn. A `Stop` event never counts.
3. **`state`**: `working` means working; `done` / `failed` / `stopped` do not.
4. **`status`**: `busy` means working; `idle` and `waiting` (with nothing to wait on) do not.
5. **Anything else** (missing, or a value this build does not know): only *evidence* counts. A tool hook in the last 60 s means working; otherwise it is idle. Never a blind guess.

What follows from the verdict: working stays in **Running** with Build lit; blocked goes to **Needs you**; idle with uncommitted files or unmerged commits goes to **Ready to land** with Build done and the later stages waiting ("✎ 8 uncommitted files"); idle with nothing left rests in **Done**. When several sessions share a checkout, the most recently active one owns its uncommitted files.

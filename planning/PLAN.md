# Agent Ship — Plan

This is the working plan Autopilot (the Floor switch) builds from. It is a
distilled, actionable TODO list, not the project's full record — that lives
in [`PLATFORM_PLAN.md`](PLATFORM_PLAN.md) (market analysis,
architecture, every phase's design decisions, the honest evaluation) and
[`FLOOR_DESIGN.md`](FLOOR_DESIGN.md) (the Floor UI). Read those for
*why*; this file is *what's left*, in build order.

**Already built and working, for context (do not redo):** the blueprint
editor and engine (Phases 0–2); resume-after-restart and the orphan-worktree
sweep; Merge and Land nodes; parallel fan-out/join with `all` / `first` /
`quorum` / `best` (judge) strategies; gates that parse common test/lint
runner output; the agent-checked gate loop primitive and the shipped
Autopilot pattern itself; Land all; the Usage gauge; the Floor's Autopilot
switch and this plan-setup flow. Full detail and honest caveats for every one
of these are in `PLATFORM_PLAN.md` §7 and §13.

## Items

### The planning standard and the interview (do these first)

Every project keeps its planning in one folder: `planning/PLAN.md` (this
file: the actionable list), `planning/OVERVIEW.md` (the why),
`planning/DESIGN.md` (the mechanism), `planning/spikes/`. Item A is done.

A. ~~**One planning folder.**~~ Done: `PLAN.md` moved under `planning/`
   (`PLAN_FILE`, `src/shared/patterns.ts`); a root `PLAN.md` from before is
   still found (`findPlan`, `src/main/plan.ts`) but never written.

B. ~~**A shared plan template.**~~ Done: `src/shared/planTemplate.ts` holds
   the three documents (OVERVIEW, DESIGN, PLAN), their sections with a hint and
   a required flag, and the plan-item format (title, why, **Done when**). The
   "Write a plan" prompt is built from it, "Paste a plan" has a "Start from the
   template" button, and Autopilot's builder and plan-check read each item's
   "Done when" line. Section ids are what the interview will track per turn.

C. ~~**Interview engine.**~~ Done: `src/main/interview.ts` (`InterviewManager`:
   one resumed Claude session per interview, read-only, `sonnet`, $0.30 a turn
   and $1.50 an interview, 14 questions at most) over `src/shared/interview.ts`
   (turn schema, validation, merge, readiness, `compilePackage`). Every turn
   returns `{ message, options, sections, assumptions }`; a malformed turn is
   rejected and the answer can be re-sent; "buildable" is computed from the
   sections, never taken from the agent; a section the person edits is theirs;
   "enough" runs one closing fill-in turn and leftover gaps are reported in the
   preview, not invented. IPC: `interview:start/answer/finish/edit/cancel/
   preview/write` (preload `interview*`); write refuses to overwrite existing
   files. 17 tests with the fake adapter. **Not yet run against the real CLI**
   (item E): in particular `--json-schema` together with `--resume`. The
   interview session also shows on the Floor as an ordinary session in that
   project, which may need hiding.

D. ~~**Interview UI.**~~ Done: `InterviewPane.tsx`, the first (default) tab of
   Set up a plan. Chat on the left with the interviewer's option buttons
   (recommended one marked) and Ctrl+Enter to send; on the right the "plan so
   far": each section with its status, the person's own edit (which the agent
   may not overwrite), the assumptions, a readiness meter and spend against
   the cap. "Enough, fill in the rest", then a preview of every file with any
   unsettled sections flagged, and only then "Write these files" (asks before
   replacing existing ones) and the hand-off to the Autopilot confirmation.
   The pane stays mounted when switching tabs and cancels the session if the
   dialog closes. The dev mock plays a scripted interview so it can be seen in
   a browser (`vite src/renderer`); checked there end to end. **Not covered:**
   no renderer tests (as for every Floor component), and not yet seen in
   Electron against the real CLI.

E. ~~**Check against the real CLI**~~ Done (2026-10-05, `AGENT_SHIP_LIVE=1 npx
   vitest run src/main/interview.live.test.ts`): a real interview on a scratch
   repo, Sonnet. Turn 1 asked a sharp question after reading the repo ($0.027);
   turn 2 **resumed the same session with `--json-schema`** and returned valid
   structured state ($0.07 cumulative); "enough" filled everything ($0.153 in
   total, 60s, 3 turns); the written package had no warnings and a PLAN of five
   items, each with Why and a checkable Done when. One earlier attempt failed
   on its first turn with the useless error text "success" (a CLI result with
   `is_error` set; cause not reproduced, not seen again in three more real
   calls): the adapter now reports the result text instead. **Not tested:** a
   long interview (more than 3 turns), the Electron dialog against the real
   CLI, and whether the interview session should be hidden on the Floor.

### Autopilot, rethought (2026-10-06, from a real run on a new Three.js project)

The first real Autopilot run on a fresh project showed the loop was verifying
nothing: the tests gate passed on "No test files found" (the Builder had added
`--passWithNoTests` to its own `package.json`), no dependency was ever installed
(`package.json` listed none, the project had no `node_modules`), the "tests" ran
with Agent Ship's own vitest because `npm run dev` puts its `node_modules/.bin` on
PATH, `main` received four unverified merges, and the failure only surfaced at a
later, different stage (Land) whose repair agent cannot install packages.

F. ~~**A dependency stage.**~~ Done: `src/main/engine/deps.ts`. Each scratch copy gets
   what ITS OWN `package.json` declares: nothing if `node_modules` already covers
   it, else the project's own `node_modules` if that does, else one `npm ci` /
   `npm install` per distinct manifest + lockfile into `<userData>/deps/<key>`,
   linked in. Runs before every command gate and before a builder step. A failed
   install fails the gate with npm's output. Workspaces and projects without
   dependencies are left alone.

G. ~~**A clean environment.**~~ Done: `src/main/engine/env.ts`. Commands and agents
   no longer inherit other packages' `node_modules/.bin` on PATH or the `npm_*`
   variables describing Agent Ship's own package; the project's own `.bin` comes first.

H. ~~**Gates that can't pass on nothing.**~~ Done: a command gate with
   `requireTests` fails when the runner exits 0 having run no tests (`ranNoTests`),
   with a message to write one and never to loosen the script. Set on both Autopilot
   test gates; Land's own gate stays off, since a project may deliberately have none.

I. ~~**One verification path.**~~ Done: Autopilot is now build -> test (builder gets
   fast feedback in its session) -> merge -> **test the merged result**, repaired in
   the scratch copy on failure (same as Land) -> land -> plan-check. `main` moves only
   after the merged result has passed.

J. ~~**Say what a failure is.**~~ Done: "Cannot find package X" is reported as
   *imported but not declared in package.json* (add it; the engine installs from it)
   or *declared but not installed* (the install is the problem), in the gate output
   and the repair prompt.

K. ~~**A failed Autopilot run's branch shouldn't look landable.**~~ Done: a run that
   stopped because a build/repair step failed (could not commit, ran out of money)
   now leaves a branch marked **failed** by that step, not "unverified", on its card
   and when it stands alone in Ready to land; the button reads "Land anyway…" and the
   drawer says the run never passed and that Land cannot fix a problem in the
   branch's own setup. Cancelled and interrupted runs still say nothing about the work.

L. ~~**Stop repairing what repair cannot fix.**~~ Done: a repair (the builder resumed
   after a failed check, or the agent repairing a merged result) that leaves the tree
   unchanged **twice in a row** ends the run with what the agent said, instead of
   spending the remaining attempts; once is allowed, because the brief tells it to
   change nothing for an environmental failure and the re-test then passes. A repair
   that changes something, or a gate passing, resets the count. (Land's own old
   "three tests, two idle repairs" behaviour is now two tests.)

N. ~~**A cheaper, saner loop (2026-10-07, from a 60-step run that never finished).**~~ Done.
   The first full Autopilot run worked mechanically but was slow and expensive: an agent
   call asked "is the plan done?" after every item; one resumed builder session grew with
   every item (each step cost more than the last, $0.09 -> $0.58); the tests ran twice on
   the identical tree each pass; the Test stage showed red whenever the plan wasn't done;
   and it stopped at pass 9 with the plan unfinished. Now: (1) **progress is counted from
   the plan's `- [ ]` / `- [x]` boxes** by a new `plan` gate kind (free, instant), with the
   agent asked once, at the end, as an independent audit; the builder ticks its own item;
   plans with no boxes fall back to asking the agent each pass. (2) **A fresh builder
   session per item**: only a failed test resumes (a repair); "go round again" starts clean
   and is told what is left. (3) **An identical tree is not re-tested** (same command, same
   tree, already passed this run: skipped, and the gate says so). (4) Loop-control gates no
   longer count as tests on the Floor. (5) The pass cap is 25 items (schema allows 100) and
   stopping at it says what is left. The plan template now writes items as tick-boxes.
   Older plans without boxes keep working through the fallback.

M. **Check it on the real project.** Re-run Autopilot on the Three.js example
   (its `main` already holds merges made while the gate verified nothing) and
   record what it costs and where it still goes wrong. Package managers other than
   npm (pnpm, yarn) fall back to the old behaviour for now.

### Backlog

1. **A multi-branch Merge.** Today's Merge node lands one branch at a time.
   When a `join: all` fan-out keeps several passing branches (`src/shared/blueprint.ts`'s
   `parallelSection`, `src/main/engine/runner.ts`'s `section()`), there is no
   node that merges more than one of them into a base in sequence. Add that -
   most naturally as a Merge variant (or a new node kind) that takes a list of
   branches, merges each in turn into the same scratch copy, and only advances
   the base once all of them are in and the combined result passes its tests.
   Decide and document what happens when merging branch 2 conflicts with
   branch 1's already-merged changes (a conflict resolver agent, same as the
   existing single-branch Merge, is the obvious default).

2. **Parallel branches that are not copies of one chain (a real DAG).**
   Fan-out/Join today only runs N copies of the *same* chain
   (`parallelSection` requires exactly one chain between the Fan-out and its
   Join). Add a way to run genuinely different node chains in parallel from
   one point in a flow - at minimum, a Fan-out whose branches are explicitly
   different sub-graphs rather than one chain repeated. Reuse as much of the
   existing per-walker `Ctx` machinery in `runner.ts` as possible rather than
   building a second execution model.

3. **Per-copy diversity in a Fan-out.** A tournament's copies currently only
   differ by the `{{copy}}` / `{{copies}}` template variables. Add a way to
   vary a copy's model, prompt, or tool list per index (e.g. an optional
   per-copy override list on the Fan-out's config), so a real "best-of-N
   across different models" tournament is possible without hand-editing the
   blueprint JSON after the fact.

4. **Triggers.** None exist yet - every flow starts by hand from the Floor or
   the editor. Add a local, loopback-only trigger listener: schedule (cron-like),
   a git event (push/branch created), a file-change watcher, and a webhook.
   Each should be a new node kind (or a Trigger config variant) that starts a
   run the same way the manual "Run" button does today.

5. **A dry-run cost/time estimator.** Use the run history already on disk
   (`src/main/engine/store.ts`'s `RunStore`, one JSONL file per run) to show,
   before a run starts, a rough cost/time estimate from past runs of the same
   blueprint - starts vague with little history, improves as more runs
   accumulate. Surface it in the run confirmation dialog next to the existing
   worst-case ceiling.

6. **More shipped patterns.** `src/shared/patterns.ts` has Supervisor,
   Pipeline, Best-of-N Tournament, Autopilot. Add Debate (two agents argue
   opposite positions, a judge decides), Red-team/Blue-team, Map-reduce over
   a list of files, and a Bug-triage swarm - each a real, runnable, tested
   blueprint like the existing ones, not just a description.

7. **Replay of a finished run.** A run's full event log is already durable
   (JSONL, replayed on resume). Add a scrubber in the run drawer that steps
   through a finished run's events after the fact, and "fork from step" -
   start a new run that begins from a chosen step's state rather than from
   scratch. This can likely reuse `src/main/engine/resume.ts`'s `planResume`
   with a chosen prefix of events instead of the full stored log.

8. **Export a blueprint to a Claude Code dynamic-workflow script**, and
   import a simple one back. Lets a blueprint remain useful even where Agent
   Ship itself isn't installed, and is the hedge noted in
   `PLATFORM_PLAN.md` §9 against Claude Code absorbing this feature.

9. **An MCP server** exposing "run flow / list runs / approve a gate" to
   other agents or Claude Desktop, so a flow can be started or a human gate
   approved from outside Agent Ship's own UI.

10. **OS notification for ad-hoc sessions.** Runs already raise a
    notification when they need approval or fail while the window is
    unfocused (`src/main/index.ts`'s `notifyIfNeeded`). Ad-hoc sessions
    (started outside any flow) do not. Extend the same mechanism to a session
    entering "Needs you" on the Floor.

11. **Keyboard triage on the Floor.** j/k to move between cards, enter to
    open the selected one's drawer - faster review when several cards are
    waiting across the four lanes.

12. **Search across projects.** The Floor's project rail and lanes have no
    search; find a run, branch, or session by name/branch/text without
    scrolling.

13. **Per-session cost for ad-hoc work.** Engine runs already show exact
    dollars; a session started by hand only shows token counts from its
    transcript. Approximate a dollar figure the same way, even if it can only
    ever be approximate (no per-model pricing table exists yet - decide
    whether to add one, and keep it easy to update as prices change).

14. **Commit `package-lock.json` and use `npm ci` in CI.** It is currently
    git-ignored (`.gitignore`), so installs are not reproducible between
    machines or between a contributor's machine and CI
    (`.github/workflows/test.yml`, `.github/workflows/build.yml`). Commit it,
    switch both workflows' `npm install` to `npm ci`, and confirm a clean
    install still passes the full test suite.

## Not part of this build loop

These need a person, not a build/test/land cycle, so Autopilot should leave
them alone even if it notices them:

- Running the app on real work repeatedly to see what actually breaks
  (`PLATFORM_PLAN.md` §11.1) - needs a human picking real tasks and
  judging the results, not something to automate here.
- The competitor teardown (§11.2): Claude Code's own agent view/workflows,
  Superset, Claude Squad, Vibe Kanban.
- §10's open product decisions (audience, workflow scope, distribution,
  single- vs. multi-vendor runtime, naming) - still unanswered, defaults
  assumed throughout.

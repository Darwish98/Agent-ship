# Agent Ship — Plan

This is the working plan Autopilot (the Floor switch) builds from. It is a
distilled, actionable TODO list, not the project's full record — that lives
in [`planning/PLATFORM_PLAN.md`](planning/PLATFORM_PLAN.md) (market analysis,
architecture, every phase's design decisions, the honest evaluation) and
[`planning/FLOOR_DESIGN.md`](planning/FLOOR_DESIGN.md) (the Floor UI). Read those for
*why*; this file is *what's left*, in build order.

**Already built and working, for context (do not redo):** the blueprint
editor and engine (Phases 0–2); resume-after-restart and the orphan-worktree
sweep; Merge and Land nodes; parallel fan-out/join with `all` / `first` /
`quorum` / `best` (judge) strategies; gates that parse common test/lint
runner output; the agent-checked gate loop primitive and the shipped
Autopilot pattern itself; Land all; the Usage gauge; the Floor's Autopilot
switch and this plan-setup flow. Full detail and honest caveats for every one
of these are in `planning/PLATFORM_PLAN.md` §7 and §13.

## Items

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
   `planning/PLATFORM_PLAN.md` §9 against Claude Code absorbing this feature.

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
  (`planning/PLATFORM_PLAN.md` §11.1) - needs a human picking real tasks and
  judging the results, not something to automate here.
- The competitor teardown (§11.2): Claude Code's own agent view/workflows,
  Superset, Claude Squad, Vibe Kanban.
- §10's open product decisions (audience, workflow scope, distribution,
  single- vs. multi-vendor runtime, naming) - still unanswered, defaults
  assumed throughout.

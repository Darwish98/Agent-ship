// Executes a blueprint: walks its nodes one at a time, holds the whole run to
// a dollar ceiling, loops a failing gate back to its repair node a bounded
// number of times, and leaves the result as a git branch.
//
// Scope, on purpose (see PLATFORM_PLAN.md, Phase 2): a single path through
// agent and gate nodes. No parallel branches and no merge node.
// `unrunnableReasons` rejects anything outside that up front. A run that was
// interrupted (the app closed) can be resumed from its event log.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parallelSection, renderTemplate, unrunnableReasons, usdCeiling } from '../../shared/blueprint'
import { RESOLVER_PROMPT } from '../../shared/patterns'
import { foldRun, isResumable, promptVars, type NodeRun, type RunEvent, type RunView } from '../../shared/runs'
import type { Blueprint, BlueprintNode } from '../../shared/schema'
import { killTree, type AgentAdapter, type StepResult } from './adapter'
import * as git from './gitops'
import { freshSeed, nextNode, planResume, type Seed } from './resume'

export interface EngineDeps {
  adapter: AgentAdapter
  /** Where scratch worktrees live. Outside the repo, so `git status` stays clean. */
  worktreeRoot: string
  /** Persists then broadcasts. Must be synchronous with respect to ordering. */
  emit: (event: RunEvent) => void
  now?: () => number
}

export interface StartArgs {
  projectId: string
  projectName: string
  projectPath: string
  flowSlug: string
  blueprint: Blueprint
  inputs: Record<string, string>
}

type Finish = Extract<RunEvent, { type: 'run.finished' }>['status']

/** Below this the CLI cannot even complete one call, so a further step is pointless. */
const MIN_STEP_USD = 0.02
const MAX_NODE_EXECUTIONS = 60
const DEFAULT_AGENT_MINUTES = 30
const DEFAULT_GATE_MINUTES = 10
const OUTPUT_CAP = 4_000
/** How many parallel copies run at once. More may be declared; they queue. */
const MAX_PARALLEL = 4
const JUDGE_SCHEMA = JSON.stringify({
  type: 'object',
  properties: { winner: { type: 'integer' }, reason: { type: 'string' } },
  required: ['winner', 'reason']
})

const clip = (s: string, n = OUTPUT_CAP): string => (s.length > n ? `${s.slice(0, n)}\n…(truncated)` : s)
const tail = (s: string, n = 6_000): string => (s.length > n ? `…(truncated)\n${s.slice(-n)}` : s)

/** The state one walker carries: the run itself, or one parallel copy of it. */
interface Ctx {
  cwd: string
  branch: string | undefined
  upstream: string
  feedback: string
  /** The last finished session of each agent, for repair-by-resume. */
  sessions: Map<string, { id: string; cwd: string }>
  /** Scratch directories this walker made, by the node that owns each. */
  worktrees: Map<string, git.Worktree>
  fails: Map<string, number>
  signal: AbortSignal
  executions: number
  /** Dollars this walker's own steps have spent (a judge's cheapest-copy fallback). */
  cost: number
  /** Set inside a parallel copy (1-based). */
  copy?: { index: number; total: number }
  /** What this copy's nodes returned, shadowing the run-wide results in prompts. */
  local?: Record<string, NodeRun>
}

/** Why a walker ended early. `superseded`: a sibling already decided the join. */
interface Stop {
  status: Finish
  reason: string
  superseded?: boolean
}

type Step = { stop: Stop } | { next: BlueprintNode | undefined }

interface Live {
  abort: AbortController
  /** The app is closing: end as "interrupted" (resumable), not "cancelled". */
  suspend?: boolean
  decide?: (d: { approve: boolean; note: string }) => void
  done: Promise<void>
}

export class RunEngine {
  private readonly live = new Map<string, Live>()
  private readonly now: () => number

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? Date.now
  }

  activeRunIds(): string[] {
    return [...this.live.keys()]
  }

  /** Resolves when the run has fully finished; used by tests. */
  whenDone(runId: string): Promise<void> {
    return this.live.get(runId)?.done ?? Promise.resolve()
  }

  async start(a: StartArgs): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
    const reasons = unrunnableReasons(a.blueprint)
    if (reasons.length) return { ok: false, error: reasons.join(' ') }
    if (this.live.size >= 4) return { ok: false, error: 'Four runs are already in progress. Let one finish first.' }

    for (const input of a.blueprint.inputs) {
      if (input.required && !(a.inputs[input.name] ?? '').trim()) {
        return { ok: false, error: `"${input.label || input.name}" is required.` }
      }
    }

    const needsWorktree = a.blueprint.nodes.some((n) => n.kind === 'agent' && n.config.worktree)
    const merging = a.blueprint.nodes.some((n) => n.kind === 'merge' || n.kind === 'land')
    if ((needsWorktree || merging) && !(await git.isRepoWithCommit(a.projectPath))) {
      return { ok: false, error: `${a.projectName} must be a git repository with at least one commit, because this flow works on git branches.` }
    }
    // A merge needs something to merge: a branch an earlier agent made, or the "branch" input.
    if (merging && !needsWorktree) {
      const wanted = (a.inputs.branch ?? '').trim()
      if (!wanted) return { ok: false, error: 'Merging needs a branch: set the "branch" input.' }
      if (!(await git.refExists(a.projectPath, `refs/heads/${wanted}`))) {
        return { ok: false, error: `The branch "${wanted}" does not exist in ${a.projectName}.` }
      }
    }

    const ceilingUsd = usdCeiling(a.blueprint) ?? 0
    const runId = crypto.randomUUID()
    const abort = new AbortController()
    const live: Live = { abort, done: Promise.resolve() }
    this.live.set(runId, live)

    const started: RunEvent = {
      type: 'run.started',
      at: this.now(),
      runId,
      projectId: a.projectId,
      projectName: a.projectName,
      projectPath: a.projectPath,
      flowSlug: a.flowSlug,
      blueprint: a.blueprint,
      inputs: a.inputs,
      ceilingUsd
    }
    this.deps.emit(started)

    live.done = this.execute(runId, a, live, [started], freshSeed(a.blueprint, a.projectPath)).finally(() => this.live.delete(runId))
    return { ok: true, runId }
  }

  cancel(runId: string, suspend = false): boolean {
    const live = this.live.get(runId)
    if (!live) return false
    live.suspend = suspend
    live.abort.abort()
    live.decide?.({ approve: false, note: 'Run cancelled.' })
    return true
  }

  /** For shutdown: stop every run so it can be resumed next launch. Resolves
   *  once each has cleaned up (or `timeoutMs` passes; the sweep covers the rest). */
  async suspendAll(timeoutMs = 8_000): Promise<void> {
    const ids = this.activeRunIds()
    for (const id of ids) this.cancel(id, true)
    const all = Promise.all(ids.map((id) => this.whenDone(id)))
    let timer: NodeJS.Timeout | undefined
    await Promise.race([all, new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))])
    clearTimeout(timer)
  }

  /**
   * Continues an interrupted run from its event log. Everything already spent,
   * every branch and every finished session carries over; the step that was in
   * flight when the app stopped runs again from the top.
   */
  async resume(events: readonly RunEvent[]): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
    const view = foldRun(events)
    if (!view) return { ok: false, error: 'That run has no record to resume.' }
    if (!isResumable(view.status)) return { ok: false, error: 'Only an interrupted run can be resumed.' }
    const runId = view.runId
    if (this.live.has(runId)) return { ok: false, error: 'That run is already in progress.' }
    if (this.live.size >= 4) return { ok: false, error: 'Four runs are already in progress. Let one finish first.' }
    if (!fs.existsSync(view.projectPath)) return { ok: false, error: `${view.projectName} is no longer at ${view.projectPath}.` }

    const reasons = unrunnableReasons(view.blueprint)
    if (reasons.length) return { ok: false, error: reasons.join(' ') }
    if (view.ceilingUsd - view.spentUsd < MIN_STEP_USD) {
      return { ok: false, error: 'This run has used its spending ceiling, so there is nothing left to spend on resuming it.' }
    }

    const seed = planResume(events, view.blueprint, view.projectPath)

    // An unfinished parallel section runs again from its start, so its copies'
    // leftovers (directories a kill left behind, and their branches) go first.
    for (const t of seed.abandoned) {
      if (fs.existsSync(t.path)) await git.removeWorktree(view.projectPath, { path: t.path, branch: t.branch, depsLink: path.join(t.path, 'node_modules') })
      if (t.branch.startsWith('agentship/')) await git.deleteBranch(view.projectPath, t.branch)
    }

    // Bring back any scratch directory that is gone (a graceful close removes
    // them after committing; a kill may have left them half-registered).
    for (const wt of seed.worktrees.values()) {
      if (fs.existsSync(wt.path)) continue
      try {
        await git.attachWorktree(view.projectPath, wt)
      } catch (err) {
        return { ok: false, error: `Could not restore the working copy for ${wt.branch}: ${(err as Error).message}` }
      }
    }

    const live: Live = { abort: new AbortController(), done: Promise.resolve() }
    this.live.set(runId, live)
    const resumed: RunEvent = { type: 'run.resumed', at: this.now(), runId }
    this.deps.emit(resumed)

    const a: StartArgs = {
      projectId: view.projectId,
      projectName: view.projectName,
      projectPath: view.projectPath,
      flowSlug: view.flowSlug,
      blueprint: view.blueprint,
      inputs: view.inputs
    }
    live.done = this.execute(runId, a, live, [...events, resumed], seed).finally(() => this.live.delete(runId))
    return { ok: true, runId }
  }

  /** Answers a human gate. Returns false when nothing is waiting. */
  decide(runId: string, approve: boolean, note: string): boolean {
    const live = this.live.get(runId)
    if (!live?.decide) return false
    live.decide({ approve, note })
    return true
  }

  // --- the walk ---------------------------------------------------------------

  private async execute(runId: string, a: StartArgs, live: Live, priorEvents: RunEvent[], seed: Seed): Promise<void> {
    const bp = a.blueprint
    // A local copy of the log, so prompts can reference earlier nodes' results.
    const events: RunEvent[] = [...priorEvents]
    const emit = (e: RunEvent): void => {
      events.push(e)
      this.deps.emit(e)
    }
    const view = (): NonNullable<ReturnType<typeof foldRun>> => foldRun(events)!
    const ceilingUsd = usdCeiling(bp) ?? 0

    const short = runId.slice(0, 8)
    /** Attempts are counted per node across every parallel copy, so (node, attempt) names one step. */
    const runs = new Map(seed.runs)
    const nextAttempt = (id: string): number => {
      const n = (runs.get(id) ?? 0) + 1
      runs.set(id, n)
      return n
    }

    // Money. `reserved` is what steps still in flight may yet spend, so parallel
    // copies are never each promised the same remaining dollars.
    let spent = seed.spent
    let reserved = 0
    const remainingUsd = (): number => ceilingUsd - spent - reserved

    /** The state one walker (the run itself, or one parallel copy) carries. */
    const main: Ctx = {
      cwd: seed.cwd,
      branch: seed.branch,
      upstream: seed.upstream,
      feedback: seed.feedback,
      sessions: new Map(seed.sessions),
      worktrees: new Map<string, git.Worktree>(seed.worktrees),
      fails: new Map(seed.fails),
      signal: live.abort.signal,
      executions: seed.executions,
      cost: 0
    }
    // Set by the Merge step: the scratch copy holding the merged result, and
    // what the base branch pointed at when it was made (so Land can tell if it moved).
    let integ: { wt: git.Worktree; baseTip: string; sha: string; base: string } | null = null

    const finish = (status: Finish, reason: string): void => {
      emit({ type: 'run.finished', at: this.now(), runId, status, reason, branch: main.branch })
    }

    /** Why a walker's signal fired: the user or the app closing (the whole run
     *  ends), or a sibling copy that already decided the join (only this copy ends). */
    const stopOf = (c: Ctx): Stop => {
      if (!live.abort.signal.aborted) return { status: 'cancelled', reason: 'Another copy already decided the join.', superseded: true }
      return live.suspend
        ? { status: 'interrupted', reason: 'Agent Ship closed while this run was in progress. Resume it to continue from where it stopped.' }
        : { status: 'cancelled', reason: 'Stopped by you.' }
    }
    /** The run ended because the user stopped it, or because the app is closing. */
    const stopped = (): void => {
      const s = stopOf(main)
      finish(s.status, s.reason)
    }

    const outEdge = (n: NonNullable<Seed['node']>, when: 'pass' | 'fail' | 'next') => nextNode(bp, n, when)

    /** Prompts see this copy's own results for the nodes it has run, not whichever copy finished last. */
    const viewFor = (c: Ctx): Pick<RunView, 'inputs' | 'nodes' | 'blueprint'> => {
      const v = view()
      return c.local ? { inputs: v.inputs, blueprint: v.blueprint, nodes: { ...v.nodes, ...c.local } } : v
    }
    const copyFields = (c: Ctx): { copy?: number; copies?: number } => (c.copy ? { copy: c.copy.index, copies: c.copy.total } : {})

    // --- one agent step -----------------------------------------------------------
    const agentStep = async (c: Ctx, node: Extract<BlueprintNode, { kind: 'agent' }>, attempt: number): Promise<Step> => {
      const remaining = remainingUsd()
      if (remaining < MIN_STEP_USD) {
        return { stop: { status: 'budget', reason: `The run's spending ceiling ($${ceilingUsd < 1 ? ceilingUsd.toFixed(3) : ceilingUsd.toFixed(2)}) is used up.` } }
      }

      const prior = c.sessions.get(node.id)
      let stepCwd = c.cwd
      let stepBranch = c.branch
      if (node.config.worktree) {
        let wt = c.worktrees.get(node.id)
        if (!wt) {
          // Each parallel copy needs its own branch; the attempt number is unique per node.
          const name = c.copy ? `${short}-${git.safeName(node.id)}-c${c.copy.index}-a${attempt}` : `${short}-${git.safeName(node.id)}`
          wt = await git.createWorktree(a.projectPath, this.deps.worktreeRoot, name, c.branch ?? 'HEAD')
          c.worktrees.set(node.id, wt)
        }
        stepCwd = wt.path
        stepBranch = wt.branch
      }
      if (prior) stepCwd = prior.cwd

      const sessionId = prior?.id ?? crypto.randomUUID()
      const resume = Boolean(prior)
      const extra: Record<string, string> = { branch: stepBranch ?? '' }
      if (c.copy) Object.assign(extra, { copy: String(c.copy.index), copies: String(c.copy.total) })
      const vars = promptVars(viewFor(c), c.upstream, extra)
      const base = renderTemplate(node.config.prompt, vars)
      const prompt = resume
        ? `The check after your last change failed. Fix the problems, then reply with a short summary.\n\n${c.feedback}`
        : c.feedback
          ? `${base}\n\nA previous check failed:\n${c.feedback}`
          : base
      c.feedback = ''

      const capUsd = Math.min(node.budget?.maxUsd ?? bp.defaultBudget.maxUsd ?? remaining, remaining)
      emit({ type: 'node.started', at: this.now(), runId, nodeId: node.id, attempt, cwd: stepCwd, branch: stepBranch, sessionId, ...copyFields(c) })

      reserved += capUsd
      let res: StepResult
      try {
        res = await this.deps.adapter.run({
          prompt,
          cwd: stepCwd,
          sessionId,
          resume,
          model: node.config.model,
          access: node.config.access,
          tools: node.config.tools,
          maxUsd: capUsd,
          jsonSchema: node.config.outputSchema,
          env: {
            AGENT_SHIP_NAME: node.label || node.config.role,
            AGENT_SHIP_ROLE: node.config.role,
            AGENT_SHIP_TASK: `${bp.name}: ${node.label || node.config.role}${c.copy ? ` (copy ${c.copy.index}/${c.copy.total})` : ''}`
          },
          timeoutMs: (node.budget?.maxMinutes ?? DEFAULT_AGENT_MINUTES) * 60_000,
          signal: c.signal
        })
      } finally {
        reserved -= capUsd
      }

      spent += res.costUsd
      c.cost += res.costUsd
      // A killed or failed step may have left no resumable session behind.
      if (res.ok) c.sessions.set(node.id, { id: res.sessionId, cwd: stepCwd })

      // Whatever the agent left becomes commits on its branch, so the
      // work survives the worktree being removed.
      if (node.config.worktree && stepBranch) {
        try {
          await git.commitAll(stepCwd, `agentship: ${node.label || node.config.role} (${bp.name})`)
        } catch (err) {
          res.ok = false
          res.error = `Could not commit the agent's work: ${(err as Error).message}`
        }
      }

      const overTokens = node.budget?.maxTokens ?? bp.defaultBudget.maxTokens
      const tokenBust = Boolean(overTokens && res.tokens > overTokens)
      const passed = res.ok && !tokenBust
      const summary = clip(res.structured !== undefined ? JSON.stringify(res.structured) : res.result)
      const error = passed ? undefined : tokenBust ? `Used ${res.tokens.toLocaleString()} tokens; the limit was ${overTokens!.toLocaleString()}.` : (res.error ?? 'Failed.')

      emit({
        type: 'node.finished',
        at: this.now(),
        runId,
        nodeId: node.id,
        attempt,
        status: passed ? 'passed' : 'failed',
        costUsd: res.costUsd,
        tokens: res.tokens,
        summary,
        error,
        branch: stepBranch
      })
      if (c.local) {
        const before = c.local[node.id]
        c.local[node.id] = {
          state: passed ? 'passed' : 'failed',
          attempts: attempt,
          costUsd: (before?.costUsd ?? 0) + res.costUsd,
          tokens: (before?.tokens ?? 0) + res.tokens,
          detail: error ?? summary,
          branch: stepBranch,
          sessionId
        }
      }

      if (stepBranch) {
        c.branch = stepBranch
        c.cwd = stepCwd
      }
      const label = node.label || node.config.role
      if (res.cancelled) return { stop: stopOf(c) }
      if (res.budgetExhausted) return { stop: { status: 'budget', reason: `"${label}" hit its dollar limit.` } }
      if (tokenBust) return { stop: { status: 'budget', reason: `"${label}" exceeded its token limit.` } }
      if (!res.ok) return { stop: { status: 'failed', reason: `"${label}" failed: ${res.error ?? 'unknown error'}` } }

      c.upstream = summary
      return { next: outEdge(node, 'next') }
    }

    // --- one gate ---------------------------------------------------------------
    const gateStep = async (c: Ctx, node: Extract<BlueprintNode, { kind: 'gate' }>, attempt: number): Promise<Step> => {
      emit({ type: 'node.started', at: this.now(), runId, nodeId: node.id, attempt, cwd: c.cwd, ...copyFields(c) })
      let pass = false
      let detail = ''
      let by: 'command' | 'human' = 'command'

      if (node.config.check === 'human') {
        by = 'human'
        emit({ type: 'gate.awaiting', at: this.now(), runId, nodeId: node.id, attempt, instructions: node.config.instructions || 'Approve to continue.' })
        const decision = await new Promise<{ approve: boolean; note: string }>((resolve) => {
          live.decide = resolve
          live.abort.signal.addEventListener('abort', () => resolve({ approve: false, note: 'Run cancelled.' }), { once: true })
        })
        live.decide = undefined
        pass = decision.approve
        detail = decision.note || (pass ? 'Approved.' : 'Rejected.')
      } else {
        const out = await runCommand(node.config.command, c.cwd, (node.budget?.maxMinutes ?? DEFAULT_GATE_MINUTES) * 60_000, c.signal)
        pass = out.code === 0
        detail = out.timedOut ? `Timed out.\n${out.tail}` : `exit ${out.code}\n${out.tail}`
      }

      emit({ type: 'gate.result', at: this.now(), runId, nodeId: node.id, attempt, pass, by, detail: clip(detail, 6_000) })
      if (c.signal.aborted) return { stop: stopOf(c) }

      if (pass) return { next: outEdge(node, 'pass') }

      const failCount = (c.fails.get(node.id) ?? 0) + 1
      c.fails.set(node.id, failCount)
      const repair = outEdge(node, 'fail')
      const maxRetries = node.budget?.maxRetries ?? 0
      if (!repair) return { stop: { status: 'failed', reason: `Gate "${node.label || 'gate'}" failed.` } }
      if (failCount > maxRetries) {
        return { stop: { status: 'failed', reason: `Gate "${node.label || 'gate'}" still failing after ${failCount} attempt${failCount === 1 ? '' : 's'} (retry cap ${maxRetries}).` } }
      }
      c.feedback = tail(detail)
      return { next: repair }
    }

    // --- the chain each parallel copy walks (agents and command gates only) -------
    const copyLoop = async (c: Ctx, start: BlueprintNode | undefined): Promise<Stop | null> => {
      let node = start
      while (node && node.kind !== 'join') {
        if (c.signal.aborted) return stopOf(c)
        if (++c.executions > MAX_NODE_EXECUTIONS) return { status: 'failed', reason: 'Stopped: too many steps (possible loop).' }
        const attempt = nextAttempt(node.id)
        let r: Step
        if (node.kind === 'agent') r = await agentStep(c, node, attempt)
        else if (node.kind === 'gate' && node.config.check === 'command') r = await gateStep(c, node, attempt)
        else return { status: 'failed', reason: `"${node.label || node.kind}" cannot run inside parallel copies.` }
        if ('stop' in r) return r.stop
        node = r.next
      }
      return null
    }

    /** Removes a copy's scratch directory, keeping (or, for a loser, dropping) its branch. */
    const discard = async (wt: git.Worktree, dropBranch: boolean): Promise<void> => {
      try {
        if (!wt.detached) await git.commitAll(wt.path, 'agentship: work in progress at end of parallel section').catch(() => false)
      } finally {
        await git.removeWorktree(a.projectPath, wt)
      }
      // Only ever a branch this run made itself.
      if (dropBranch && wt.branch.startsWith('agentship/')) await git.deleteBranch(a.projectPath, wt.branch)
    }

    /** An agent reads each passing copy's diff and names the best one. */
    const judgeCopies = async (
      join: Extract<BlueprintNode, { kind: 'join' }>,
      passers: Ctx[],
      base: string
    ): Promise<{ chosen: Ctx; note: string; cost: number; tokens: number } | { stop: Stop }> => {
      const cheapest = passers.reduce((m, c) => (c.cost < m.cost ? c : m))
      const fallback = (why: string, cost = 0, tokens = 0): { chosen: Ctx; note: string; cost: number; tokens: number } => ({
        chosen: cheapest,
        note: `${why}, so the cheapest passing copy was kept`,
        cost,
        tokens
      })
      const remaining = remainingUsd()
      if (remaining < MIN_STEP_USD) return fallback('There was no budget left for the judge')

      const attempts: string[] = []
      for (const c of passers) {
        const diff = c.worktrees.size && c.branch ? await git.diffText(a.projectPath, base, c.branch) : ''
        attempts.push(`### Copy ${c.copy!.index}${c.branch && c.worktrees.size ? ` (branch ${c.branch})` : ''}\nIts final message:\n${clip(c.upstream, 1_500)}\n${diff ? `\nWhat it changed:\n${diff}` : ''}`)
      }
      const task = Object.entries(a.inputs).map(([k, v]) => `${k}: ${clip(v, 2_000)}`).join('\n')
      const prompt = [
        `${passers.length} agents independently attempted the same task. Each attempt already passed its checks. Pick the single best one.`,
        task ? `\nThe task:\n${task}` : '',
        `\nWhat "best" means here: ${join.config.criteria.trim() || 'correct first, then the smallest change that fully does the job, then clarity.'}`,
        `\n${attempts.join('\n\n')}`,
        `\nAnswer with JSON: {"winner": <the copy number>, "reason": "<one or two sentences>"}. The winner must be one of: ${passers.map((c) => c.copy!.index).join(', ')}.`
      ].join('\n')

      const capUsd = Math.min(join.budget?.maxUsd ?? bp.defaultBudget.maxUsd ?? remaining, remaining)
      reserved += capUsd
      let res: StepResult
      try {
        res = await this.deps.adapter.run({
          prompt,
          cwd: a.projectPath,
          sessionId: crypto.randomUUID(),
          resume: false,
          model: 'default',
          access: 'read',
          tools: [],
          maxUsd: capUsd,
          jsonSchema: JUDGE_SCHEMA,
          env: { AGENT_SHIP_NAME: 'Judge', AGENT_SHIP_ROLE: 'Judge', AGENT_SHIP_TASK: `${bp.name}: pick the best of ${passers.length}` },
          timeoutMs: (join.budget?.maxMinutes ?? DEFAULT_GATE_MINUTES) * 60_000,
          signal: live.abort.signal
        })
      } finally {
        reserved -= capUsd
      }
      spent += res.costUsd
      if (res.cancelled) return { stop: stopOf(main) }
      if (!res.ok) return fallback(`The judge failed (${res.error ?? 'unknown error'})`, res.costUsd, res.tokens)
      const s = res.structured as { winner?: unknown; reason?: unknown } | undefined
      const chosen = passers.find((c) => c.copy!.index === s?.winner)
      if (!chosen) return fallback('The judge did not name one of the passing copies', res.costUsd, res.tokens)
      return { chosen, note: `Judge: ${clip(String(s?.reason ?? 'no reason given'), 400)}`, cost: res.costUsd, tokens: res.tokens }
    }

    // --- a parallel section: Fan-out, N copies of the chain, Join -------------------
    const section = async (fan: Extract<BlueprintNode, { kind: 'fanout' }>, attempt: number): Promise<Step> => {
      const { join } = parallelSection(bp, fan.id)
      if (!join) return { stop: { status: 'failed', reason: `Fan-out "${fan.label || 'fan-out'}" has no Join.` } }
      const first = nextNode(bp, fan, 'next')
      const total = fan.config.count
      const strategy = join.config.strategy
      const need = strategy === 'all' ? total : strategy === 'quorum' ? join.config.quorum : 1
      const base = main.branch ?? 'HEAD'

      emit({ type: 'node.started', at: this.now(), runId, nodeId: fan.id, attempt, cwd: main.cwd, copies: total })

      // Copies stop when the run stops, or earlier when the join is already decided.
      const controller = new AbortController()
      const relay = (): void => controller.abort()
      live.abort.signal.addEventListener('abort', relay, { once: true })
      if (live.abort.signal.aborted) controller.abort()

      const copies = Array.from({ length: total }, (_, i): Ctx => ({
        cwd: main.cwd,
        branch: main.branch,
        upstream: main.upstream,
        feedback: '',
        sessions: new Map(),
        worktrees: new Map(),
        fails: new Map(),
        signal: controller.signal,
        copy: { index: i + 1, total },
        local: {},
        executions: 0,
        cost: 0
      }))
      const outcome: (Stop | null | undefined)[] = new Array<Stop | null | undefined>(total).fill(undefined)
      const passOrder: number[] = []
      let keep: Ctx | undefined
      let dropLosers = false

      try {
        let cursor = 0
        const worker = async (): Promise<void> => {
          while (cursor < total) {
            const i = cursor++
            if (controller.signal.aborted) {
              outcome[i] = { status: 'cancelled', reason: 'Not started: the join was already decided.', superseded: true }
              continue
            }
            const stop = await copyLoop(copies[i], first)
            outcome[i] = stop
            if (stop === null) passOrder.push(i)
            const hardFails = outcome.filter((o) => o && !o.superseded).length
            const decidedYes = (strategy === 'first' || strategy === 'quorum') && passOrder.length >= need
            const decidedNo = total - hardFails < need
            if (decidedYes || decidedNo) controller.abort()
          }
        }
        await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, total) }, worker))
        live.abort.signal.removeEventListener('abort', relay)

        const passes = passOrder.length
        const failures = copies
          .map((c, i) => ({ c, o: outcome[i] }))
          .filter((x): x is { c: Ctx; o: Stop } => Boolean(x.o) && !x.o!.superseded)
        emit({
          type: 'node.finished',
          at: this.now(),
          runId,
          nodeId: fan.id,
          attempt,
          status: passes >= need ? 'passed' : 'failed',
          costUsd: 0,
          tokens: 0,
          summary: `${passes} of ${total} cop${total === 1 ? 'y' : 'ies'} finished${copies.some((_, i) => outcome[i]?.superseded) ? '; the rest were stopped once the join was decided' : ''}.`
        })
        if (live.abort.signal.aborted) return { stop: stopOf(main) }

        // --- the join -----------------------------------------------------------
        const jAttempt = nextAttempt(join.id)
        emit({ type: 'node.started', at: this.now(), runId, nodeId: join.id, attempt: jAttempt, cwd: main.cwd })
        const jLabel = join.label || 'join'
        const joinFailed = (reason: string, status: Finish = 'failed'): Step => {
          emit({ type: 'node.finished', at: this.now(), runId, nodeId: join.id, attempt: jAttempt, status: 'failed', costUsd: 0, tokens: 0, summary: '', error: reason })
          return { stop: { status, reason } }
        }

        if (passes < need) {
          const why = failures.map((x) => `copy ${x.c.copy!.index}: ${x.o.reason}`).join('; ')
          const allBudget = failures.length > 0 && failures.every((x) => x.o.status === 'budget')
          const needs = strategy === 'all' ? `all ${total} copies` : strategy === 'quorum' ? `${need} of ${total} copies` : 'at least one copy'
          return joinFailed(`Join "${jLabel}" needs ${needs} to finish; ${passes} did.${why ? ` ${why}` : ''}`, allBudget ? 'budget' : 'failed')
        }

        const passers = passOrder.slice().sort((x, y) => x - y).map((i) => copies[i])
        let chosen: Ctx | undefined
        let note = ''
        let cost = 0
        let tokens = 0
        if (strategy === 'first') {
          chosen = copies[passOrder[0]]
        } else if (strategy === 'best') {
          if (passers.length === 1) {
            chosen = passers[0]
          } else {
            const j = await judgeCopies(join, passers, base)
            if ('stop' in j) return joinFailed(j.stop.reason, j.stop.status)
            ;({ chosen, note, cost, tokens } = j)
          }
        }

        let summary: string
        let branch: string | undefined
        let cwd: string | undefined
        if (chosen) {
          const own = chosen.worktrees.size > 0
          main.upstream = chosen.upstream
          if (own) {
            main.branch = chosen.branch
            main.cwd = chosen.cwd
            branch = chosen.branch
            cwd = chosen.cwd
          }
          keep = chosen
          dropLosers = true
          summary = `Picked copy ${chosen.copy!.index} of ${total}${note ? `. ${note}` : ''}.\n\n${chosen.upstream}`
        } else {
          // all / quorum: every passing copy is an outcome; nothing is chosen between them.
          const lines = passers.map((c) => `Copy ${c.copy!.index}${c.worktrees.size && c.branch ? ` (branch ${c.branch})` : ''}:\n${c.upstream}`)
          main.upstream = lines.join('\n\n')
          summary = `${passers.length} of ${total} copies finished.\n\n${main.upstream}`
        }
        emit({ type: 'node.finished', at: this.now(), runId, nodeId: join.id, attempt: jAttempt, status: 'passed', costUsd: cost, tokens, summary: clip(summary), branch, cwd })
        return { next: outEdge(join, 'next') }
      } finally {
        live.abort.signal.removeEventListener('abort', relay)
        // Scratch directories all go. The winner's stays for the rest of the run.
        for (const c of copies) {
          for (const [key, wt] of c.worktrees) {
            if (c === keep) main.worktrees.set(`${fan.id}:${key}`, wt)
            else await discard(wt, dropLosers).catch(() => undefined)
          }
        }
      }
    }

    try {
      let node = seed.node

      // A flow that merges an existing branch (no agent of its own making one)
      // tests that branch in a scratch copy, so your checkout is never touched.
      const under = (a.inputs.branch ?? '').trim()
      const merging = bp.nodes.some((n) => n.kind === 'merge' || n.kind === 'land')
      const ownBranch = bp.nodes.some((n) => n.kind === 'agent' && n.config.worktree)
      if (merging && !ownBranch && under) {
        const wt = await git.createDetachedWorktree(a.projectPath, this.deps.worktreeRoot, `${short}-src`, under)
        main.worktrees.set('__source', wt)
        main.cwd = wt.path
        main.branch = under
      }

      while (node) {
        if (live.abort.signal.aborted) return stopped()
        if (++main.executions > MAX_NODE_EXECUTIONS) return finish('failed', 'Stopped: too many steps (possible loop).')

        const attempt = nextAttempt(node.id)

        if (node.kind === 'agent' || node.kind === 'gate' || node.kind === 'fanout') {
          const r = node.kind === 'agent' ? await agentStep(main, node, attempt) : node.kind === 'gate' ? await gateStep(main, node, attempt) : await section(node, attempt)
          if ('stop' in r) return finish(r.stop.status, r.stop.reason)
          node = r.next
          continue
        }

        if (node.kind === 'merge' || node.kind === 'land') {
          const label = node.label || node.kind
          const thisId = node.id
          emit({ type: 'node.started', at: this.now(), runId, nodeId: thisId, attempt, cwd: main.cwd })
          const failed = (reason: string, cost = 0, tokens = 0): void => {
            emit({ type: 'node.finished', at: this.now(), runId, nodeId: thisId, attempt, status: 'failed', costUsd: cost, tokens, summary: '', error: reason })
            finish('failed', reason)
          }
          const base = renderTemplate(node.config.baseBranch, promptVars(view(), main.upstream, { branch: main.branch ?? '' })).trim()
          if (!base || !(await git.refExists(a.projectPath, `refs/heads/${base}`))) {
            return failed(`The base branch "${base || node.config.baseBranch}" does not exist. Nothing was changed.`)
          }

          if (node.kind === 'merge') {
            const source = main.branch ?? ''
            if (!source) return failed('There is no branch to merge. Nothing was changed.')
            const baseTip = await git.tip(a.projectPath, `refs/heads/${base}`)
            const wt = await git.createDetachedWorktree(a.projectPath, this.deps.worktreeRoot, `${short}-merge`, baseTip)
            main.worktrees.set('__merge', wt)

            let cost = 0
            let tokens = 0
            let summary = ''
            const m = await git.mergeNoFf(wt.path, source).catch((err: Error) => err)
            if (m instanceof Error) return failed(`Could not merge ${source} into ${base}: ${m.message}`)
            if (m.ok) {
              summary = `Merged ${source} into a scratch copy of ${base} with no conflicts.`
            } else {
              const files = m.conflicts
              if (!node.config.resolveConflicts) {
                await git.abortMerge(wt.path)
                return failed(`${source} conflicts with ${base} in: ${files.join(', ')}. Nothing was changed.`)
              }
              const remaining = ceilingUsd - spent
              if (remaining < MIN_STEP_USD) {
                await git.abortMerge(wt.path)
                emit({ type: 'node.finished', at: this.now(), runId, nodeId: node.id, attempt, status: 'failed', costUsd: 0, tokens: 0, summary: '', error: 'No budget left to resolve the conflicts.' })
                return finish('budget', 'The run has no budget left to resolve merge conflicts.')
              }
              const prompt = renderTemplate(node.config.resolverPrompt || RESOLVER_PROMPT, {
                ...promptVars(view(), main.upstream),
                branch: source,
                baseBranch: base,
                conflicts: files.map((f) => `  - ${f}`).join('\n')
              })
              const res = await this.deps.adapter.run({
                prompt,
                cwd: wt.path,
                sessionId: crypto.randomUUID(),
                resume: false,
                model: 'default',
                access: 'edit',
                // The agent may look and stage; it may not commit, push, or switch branches.
                tools: ['Bash(git add *)', 'Bash(git status *)', 'Bash(git diff *)', 'Bash(git show *)', 'Bash(git log *)'],
                maxUsd: Math.min(node.budget?.maxUsd ?? bp.defaultBudget.maxUsd ?? remaining, remaining),
                jsonSchema: '',
                env: { AGENT_SHIP_NAME: 'Conflict resolver', AGENT_SHIP_ROLE: 'Merge', AGENT_SHIP_TASK: `Resolve ${files.length} conflict(s): ${source} into ${base}` },
                timeoutMs: (node.budget?.maxMinutes ?? DEFAULT_AGENT_MINUTES) * 60_000,
                signal: live.abort.signal
              })
              spent += res.costUsd
              cost = res.costUsd
              tokens = res.tokens
              if (res.cancelled) {
                await git.abortMerge(wt.path)
                emit({ type: 'node.finished', at: this.now(), runId, nodeId: node.id, attempt, status: 'failed', costUsd: cost, tokens, summary: '', error: 'Cancelled.' })
                return stopped()
              }
              if (!res.ok) {
                await git.abortMerge(wt.path)
                emit({ type: 'node.finished', at: this.now(), runId, nodeId: node.id, attempt, status: 'failed', costUsd: cost, tokens, summary: '', error: res.error ?? 'The conflict resolver failed.' })
                return finish(res.budgetExhausted ? 'budget' : 'failed', res.budgetExhausted ? 'The conflict resolver hit its dollar limit. Nothing was changed.' : `The conflict resolver failed: ${res.error ?? 'unknown error'}. Nothing was changed.`)
              }
              // Trust, but verify: nothing may be left unresolved or carry markers.
              const left = await git.unmergedPaths(wt.path)
              if (left.length > 0 || (await git.hasConflictMarkers(wt.path))) {
                await git.abortMerge(wt.path)
                return failed(`The agent could not fully resolve the conflicts${left.length ? ` (still conflicted: ${left.join(', ')})` : ' (conflict markers remain)'}. Nothing was changed.`, cost, tokens)
              }
              try {
                await git.concludeMerge(wt.path)
              } catch (err) {
                await git.abortMerge(wt.path)
                return failed(`Could not finish the merge: ${(err as Error).message}`, cost, tokens)
              }
              summary = `Merged ${source} into a scratch copy of ${base}; an agent resolved ${files.length} conflicted file${files.length === 1 ? '' : 's'}: ${files.join(', ')}.`
            }

            const sha = await git.head(wt.path)
            integ = { wt, baseTip, sha, base }
            main.cwd = wt.path // later gates test the merged result, not the branch
            emit({ type: 'node.finished', at: this.now(), runId, nodeId: node.id, attempt, status: 'passed', costUsd: cost, tokens, summary })
            node = outEdge(node, 'next')
            continue
          }

          // land: advance the base branch to the merge result that was tested.
          if (!integ) return failed('Nothing to land: a Merge step has to run first.')
          if (integ.base !== base) return failed(`This Land step targets ${base} but the merge was into ${integ.base}.`)
          const holder = await git.worktreeHolding(a.projectPath, base)
          const moved = `${base} moved while this was landing, so it was left alone. Run it again.`
          if (holder) {
            // The branch is checked out somewhere, so it has to move together with its files.
            //
            // Case 1, the ordinary one: nothing uncommitted is in the way, so fast-forward.
            // Case 2 (Commit & land, a session working directly on the base branch): the
            // uncommitted files in that checkout ARE the work being landed. Only if they
            // are byte-identical to the tested result may the branch move to it and the
            // index be re-pointed, which changes no file and loses nothing. This is also
            // what a fast-forward needs when the session's new files are untracked and
            // would be "overwritten" by it.
            const ff = (await git.isClean(holder)) && (await git.fastForward(holder, integ.sha))
            if (!ff) {
              if (!(await git.workingTreeMatches(holder, integ.sha))) {
                // Say what is actually true: did the branch move, or are those files not the work being landed?
                const nowTip = await git.tip(a.projectPath, `refs/heads/${base}`)
                return failed(
                  nowTip !== integ.baseTip
                    ? moved
                    : `${base} is checked out in ${holder} with uncommitted changes that are not the work being landed (you may have edited files while it ran). Commit or stash them, then land again. Nothing was changed.`
                )
              }
              if (!(await git.updateBranch(a.projectPath, base, integ.sha, integ.baseTip))) return failed(moved)
              await git.resetIndexToHead(holder)
            }
          } else if (!(await git.updateBranch(a.projectPath, base, integ.sha, integ.baseTip))) {
            return failed(moved)
          }
          emit({ type: 'node.finished', at: this.now(), runId, nodeId: node.id, attempt, status: 'passed', costUsd: 0, tokens: 0, summary: `${label}: ${base} is now at ${integ.sha.slice(0, 7)}.` })
          node = outEdge(node, 'next')
          continue
        }

        return finish('failed', `The engine cannot run "${node.kind}" nodes.`)
      }

      finish('passed', 'Finished every step.')
    } catch (err) {
      finish('failed', `Engine error: ${(err as Error).message}`)
    } finally {
      // Branches stay; only the scratch directories go.
      for (const wt of main.worktrees.values()) {
        try {
          // Only branches an agent made keep their work; scratch copies just go.
          if (!wt.detached) await git.commitAll(wt.path, 'agentship: work in progress at end of run').catch(() => false)
        } finally {
          await git.removeWorktree(a.projectPath, wt)
        }
      }
    }
  }
}

/** Runs a gate's shell command, keeping only the tail of its output. */
function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal
): Promise<{ code: number; tail: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let buf = ''
    let timedOut = false
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: process.env, detached: process.platform !== 'win32' })
    const keep = (d: Buffer): void => {
      buf = (buf + d.toString()).slice(-12_000)
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, timeoutMs)
    const onAbort = (): void => killTree(child.pid)
    signal.addEventListener('abort', onAbort, { once: true })
    const end = (code: number): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve({ code, tail: tail(buf.trim()), timedOut })
    }
    child.on('error', (e) => {
      buf += `\n${e.message}`
      end(127)
    })
    child.on('close', (code) => end(code ?? 1))
  })
}

export const worktreeRootFor = (userData: string): string => path.join(userData, 'worktrees')

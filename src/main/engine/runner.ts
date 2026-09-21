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
import { renderTemplate, unrunnableReasons, usdCeiling } from '../../shared/blueprint'
import { foldRun, isResumable, promptVars, type RunEvent } from '../../shared/runs'
import type { Blueprint } from '../../shared/schema'
import { killTree, type AgentAdapter } from './adapter'
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

const clip = (s: string, n = OUTPUT_CAP): string => (s.length > n ? `${s.slice(0, n)}\n…(truncated)` : s)
const tail = (s: string, n = 6_000): string => (s.length > n ? `…(truncated)\n${s.slice(-n)}` : s)

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
    if (needsWorktree && !(await git.isRepoWithCommit(a.projectPath))) {
      return { ok: false, error: `${a.projectName} must be a git repository with at least one commit, because this flow gives an agent its own branch.` }
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
    const worktrees = new Map<string, git.Worktree>(seed.worktrees)
    const sessions = new Map(seed.sessions)
    const fails = new Map(seed.fails)
    const runs = new Map(seed.runs)

    let cwd = seed.cwd
    let branch = seed.branch
    let upstream = seed.upstream
    let feedback = seed.feedback
    let spent = seed.spent
    let executions = seed.executions

    const finish = (status: Finish, reason: string): void => {
      emit({ type: 'run.finished', at: this.now(), runId, status, reason, branch })
    }

    /** The run ended because the user stopped it, or because the app is closing. */
    const stopped = (): void =>
      live.suspend
        ? finish('interrupted', 'Agent Ship closed while this run was in progress. Resume it to continue from where it stopped.')
        : finish('cancelled', 'Stopped by you.')

    const outEdge = (n: NonNullable<Seed['node']>, when: 'pass' | 'fail' | 'next') => nextNode(bp, n, when)

    try {
      let node = seed.node

      while (node) {
        if (live.abort.signal.aborted) return stopped()
        if (++executions > MAX_NODE_EXECUTIONS) return finish('failed', 'Stopped: too many steps (possible loop).')

        const attempt = (runs.get(node.id) ?? 0) + 1
        runs.set(node.id, attempt)

        if (node.kind === 'agent') {
          const remaining = ceilingUsd - spent
          if (remaining < MIN_STEP_USD) return finish('budget', `The run's spending ceiling ($${ceilingUsd < 1 ? ceilingUsd.toFixed(3) : ceilingUsd.toFixed(2)}) is used up.`)

          const prior = sessions.get(node.id)
          let stepCwd = cwd
          let stepBranch = branch
          if (node.config.worktree) {
            let wt = worktrees.get(node.id)
            if (!wt) {
              wt = await git.createWorktree(a.projectPath, this.deps.worktreeRoot, `${short}-${git.safeName(node.id)}`, branch ?? 'HEAD')
              worktrees.set(node.id, wt)
            }
            stepCwd = wt.path
            stepBranch = wt.branch
          }
          if (prior) stepCwd = prior.cwd

          const sessionId = prior?.id ?? crypto.randomUUID()
          const resume = Boolean(prior)
          const vars = promptVars(view(), upstream, { branch: stepBranch ?? '' })
          const base = renderTemplate(node.config.prompt, vars)
          const prompt = resume
            ? `The check after your last change failed. Fix the problems, then reply with a short summary.\n\n${feedback}`
            : feedback
              ? `${base}\n\nA previous check failed:\n${feedback}`
              : base
          feedback = ''

          const capUsd = Math.min(node.budget?.maxUsd ?? bp.defaultBudget.maxUsd ?? remaining, remaining)
          emit({ type: 'node.started', at: this.now(), runId, nodeId: node.id, attempt, cwd: stepCwd, branch: stepBranch, sessionId })

          const res = await this.deps.adapter.run({
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
              AGENT_SHIP_TASK: `${bp.name}: ${node.label || node.config.role}`
            },
            timeoutMs: (node.budget?.maxMinutes ?? DEFAULT_AGENT_MINUTES) * 60_000,
            signal: live.abort.signal
          })

          spent += res.costUsd
          // A killed or failed step may have left no resumable session behind.
          if (res.ok) sessions.set(node.id, { id: res.sessionId, cwd: stepCwd })

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

          emit({
            type: 'node.finished',
            at: this.now(),
            runId,
            nodeId: node.id,
            attempt,
            status: res.ok && !tokenBust ? 'passed' : 'failed',
            costUsd: res.costUsd,
            tokens: res.tokens,
            summary: clip(res.structured !== undefined ? JSON.stringify(res.structured) : res.result),
            error: res.ok && !tokenBust ? undefined : tokenBust ? `Used ${res.tokens.toLocaleString()} tokens; the limit was ${overTokens!.toLocaleString()}.` : (res.error ?? 'Failed.'),
            branch: stepBranch
          })

          if (stepBranch) {
            branch = stepBranch
            cwd = stepCwd
          }
          if (res.cancelled) return stopped()
          if (res.budgetExhausted) return finish('budget', `"${node.label || node.config.role}" hit its dollar limit.`)
          if (tokenBust) return finish('budget', `"${node.label || node.config.role}" exceeded its token limit.`)
          if (!res.ok) return finish('failed', `"${node.label || node.config.role}" failed: ${res.error ?? 'unknown error'}`)

          upstream = clip(res.structured !== undefined ? JSON.stringify(res.structured) : res.result)
          node = outEdge(node, 'next')
          continue
        }

        if (node.kind === 'gate') {
          emit({ type: 'node.started', at: this.now(), runId, nodeId: node.id, attempt, cwd })
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
            const out = await runCommand(node.config.command, cwd, (node.budget?.maxMinutes ?? DEFAULT_GATE_MINUTES) * 60_000, live.abort.signal)
            pass = out.code === 0
            detail = out.timedOut ? `Timed out.\n${out.tail}` : `exit ${out.code}\n${out.tail}`
          }

          emit({ type: 'gate.result', at: this.now(), runId, nodeId: node.id, attempt, pass, by, detail: clip(detail, 6_000) })
          if (live.abort.signal.aborted) return stopped()

          if (pass) {
            node = outEdge(node, 'pass')
            continue
          }

          const failCount = (fails.get(node.id) ?? 0) + 1
          fails.set(node.id, failCount)
          const repair = outEdge(node, 'fail')
          const maxRetries = node.budget?.maxRetries ?? 0
          if (!repair) return finish('failed', `Gate "${node.label || 'gate'}" failed.`)
          if (failCount > maxRetries) {
            return finish('failed', `Gate "${node.label || 'gate'}" still failing after ${failCount} attempt${failCount === 1 ? '' : 's'} (retry cap ${maxRetries}).`)
          }
          feedback = tail(detail)
          node = repair
          continue
        }

        return finish('failed', `The engine cannot run "${node.kind}" nodes.`)
      }

      finish('passed', 'Finished every step.')
    } catch (err) {
      finish('failed', `Engine error: ${(err as Error).message}`)
    } finally {
      // Branches stay; only the scratch directories go.
      for (const wt of worktrees.values()) {
        try {
          await git.commitAll(wt.path, 'agentship: work in progress at end of run').catch(() => false)
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

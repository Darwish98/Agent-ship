// Executes a blueprint: walks its nodes one at a time, holds the whole run to
// a dollar ceiling, loops a failing gate back to its repair node a bounded
// number of times, and leaves the result as a git branch.
//
// Scope, on purpose (see PLATFORM_PLAN.md, Phase 2): a single path through
// agent and gate nodes. No parallel branches, no merge node, no resume after a
// restart. `unrunnableReasons` rejects anything outside that up front.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import path from 'node:path'
import { renderTemplate, unrunnableReasons, usdCeiling } from '../../shared/blueprint'
import { RESOLVER_PROMPT } from '../../shared/patterns'
import { foldRun, promptVars, type RunEvent } from '../../shared/runs'
import type { Blueprint, BlueprintNode } from '../../shared/schema'
import { killTree, type AgentAdapter } from './adapter'
import * as git from './gitops'

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

    live.done = this.execute(runId, a, live, started).finally(() => this.live.delete(runId))
    return { ok: true, runId }
  }

  cancel(runId: string): boolean {
    const live = this.live.get(runId)
    if (!live) return false
    live.abort.abort()
    live.decide?.({ approve: false, note: 'Run cancelled.' })
    return true
  }

  /** Answers a human gate. Returns false when nothing is waiting. */
  decide(runId: string, approve: boolean, note: string): boolean {
    const live = this.live.get(runId)
    if (!live?.decide) return false
    live.decide({ approve, note })
    return true
  }

  // --- the walk ---------------------------------------------------------------

  private async execute(runId: string, a: StartArgs, live: Live, started: RunEvent): Promise<void> {
    const bp = a.blueprint
    // A local copy of the log, so prompts can reference earlier nodes' results.
    const events: RunEvent[] = [started]
    const emit = (e: RunEvent): void => {
      events.push(e)
      this.deps.emit(e)
    }
    const view = (): NonNullable<ReturnType<typeof foldRun>> => foldRun(events)!
    const ceilingUsd = usdCeiling(bp) ?? 0

    const short = runId.slice(0, 8)
    const worktrees = new Map<string, git.Worktree>()
    const sessions = new Map<string, { id: string; cwd: string }>()
    const fails = new Map<string, number>()
    const runs = new Map<string, number>()

    let cwd = a.projectPath
    let branch: string | undefined
    let upstream = ''
    let feedback = ''
    let spent = 0
    let executions = 0
    // Set by the Merge step: the scratch copy holding the merged result, and
    // what the base branch pointed at when it was made (so Land can tell if it moved).
    let integ: { wt: git.Worktree; baseTip: string; sha: string; base: string } | null = null

    const finish = (status: Finish, reason: string): void => {
      emit({ type: 'run.finished', at: this.now(), runId, status, reason, branch })
    }

    const outEdge = (n: BlueprintNode, when: 'pass' | 'fail' | 'next'): BlueprintNode | undefined => {
      const edge = bp.edges.find((e) => {
        if (e.from !== n.id) return false
        if (n.kind !== 'gate') return e.condition !== 'fail'
        return when === 'fail' ? e.condition === 'fail' : e.condition !== 'fail'
      })
      return edge ? bp.nodes.find((x) => x.id === edge.to) : undefined
    }

    try {
      const trigger = bp.nodes.find((n) => n.kind === 'trigger')!
      let node = outEdge(trigger, 'next')

      // A flow that merges an existing branch (no agent of its own making one)
      // tests that branch in a scratch copy, so your checkout is never touched.
      const under = (a.inputs.branch ?? '').trim()
      const merging = bp.nodes.some((n) => n.kind === 'merge' || n.kind === 'land')
      const ownBranch = bp.nodes.some((n) => n.kind === 'agent' && n.config.worktree)
      if (merging && !ownBranch && under) {
        const wt = await git.createDetachedWorktree(a.projectPath, this.deps.worktreeRoot, `${short}-src`, under)
        worktrees.set('__source', wt)
        cwd = wt.path
        branch = under
      }

      while (node) {
        if (live.abort.signal.aborted) return finish('cancelled', 'Stopped by you.')
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
          sessions.set(node.id, { id: res.sessionId, cwd: stepCwd })

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
          if (res.cancelled) return finish('cancelled', 'Stopped by you.')
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
          if (live.abort.signal.aborted) return finish('cancelled', 'Stopped by you.')

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

        if (node.kind === 'merge' || node.kind === 'land') {
          const label = node.label || node.kind
          const thisId = node.id
          emit({ type: 'node.started', at: this.now(), runId, nodeId: thisId, attempt, cwd })
          const failed = (reason: string, cost = 0, tokens = 0): void => {
            emit({ type: 'node.finished', at: this.now(), runId, nodeId: thisId, attempt, status: 'failed', costUsd: cost, tokens, summary: '', error: reason })
            finish('failed', reason)
          }
          const base = renderTemplate(node.config.baseBranch, promptVars(view(), upstream, { branch: branch ?? '' })).trim()
          if (!base || !(await git.refExists(a.projectPath, `refs/heads/${base}`))) {
            return failed(`The base branch "${base || node.config.baseBranch}" does not exist. Nothing was changed.`)
          }

          if (node.kind === 'merge') {
            const source = branch ?? ''
            if (!source) return failed('There is no branch to merge. Nothing was changed.')
            const baseTip = await git.tip(a.projectPath, `refs/heads/${base}`)
            const wt = await git.createDetachedWorktree(a.projectPath, this.deps.worktreeRoot, `${short}-merge`, baseTip)
            worktrees.set('__merge', wt)

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
                ...promptVars(view(), upstream),
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
                return finish('cancelled', 'Stopped by you.')
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
            cwd = wt.path // later gates test the merged result, not the branch
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
      for (const wt of worktrees.values()) {
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

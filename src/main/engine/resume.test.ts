import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { foldRun, type RunEvent } from '../../shared/runs'
import { buildLandBlueprint, fromPattern, PATTERNS } from '../../shared/patterns'
import type { Blueprint } from '../../shared/schema'
import type { AgentAdapter, StepRequest, StepResult } from './adapter'
import * as gitops from './gitops'
import { planResume, RESUME_WINDOW_MS, resumableRunIds } from './resume'
import { RunEngine } from './runner'
import { RunStore } from './store'

let root: string
let repo: string
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-test-'))
  repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'core.autocrlf', 'false')
  git(repo, 'config', 'user.name', 't')
  git(repo, 'config', 'user.email', 't@t')
  fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const ok = (over: Partial<StepResult> = {}): StepResult => ({
  ok: true, result: 'done', costUsd: 0.1, tokens: 1000, sessionId: 's', budgetExhausted: false, timedOut: false, cancelled: false, ...over
})
const cancelled = (): StepResult => ({ ...ok(), ok: false, cancelled: true, error: 'Cancelled.' })

class Fake implements AgentAdapter {
  reqs: StepRequest[] = []
  constructor(private readonly handler: (req: StepRequest, n: number) => StepResult | Promise<StepResult>) {}
  async run(req: StepRequest): Promise<StepResult> {
    this.reqs.push(req)
    return this.handler(req, this.reqs.length)
  }
}

/** Resolves as cancelled when the engine aborts, like the real adapter. */
const hangUntilAborted = (req: StepRequest): Promise<StepResult> =>
  new Promise((resolve) => req.signal.addEventListener('abort', () => resolve(cancelled()), { once: true }))

function harness(adapter: AgentAdapter, runsDir = 'runs'): { engine: RunEngine; events: RunEvent[]; store: RunStore } {
  const events: RunEvent[] = []
  const store = new RunStore(path.join(root, runsDir))
  const engine = new RunEngine({
    adapter,
    worktreeRoot: path.join(root, 'wt'),
    emit: (e) => {
      store.append(e)
      events.push(e)
    }
  })
  return { engine, events, store }
}

const fileExists = 'node -e "process.exit(require(\'fs\').existsSync(\'built.txt\')?0:1)"'
const args = (bp: Blueprint) => ({ projectId: 'p', projectName: 'repo', projectPath: repo, flowSlug: 'flow', blueprint: bp, inputs: { task: 'add a file' } })

function pipeline(gateCommand: string, retries = 2): Blueprint {
  const bp = fromPattern(PATTERNS[2])
  const gate = bp.nodes.find((n) => n.id === 'tests')!
  if (gate.kind === 'gate') gate.config.command = gateCommand
  gate.budget = { maxRetries: retries }
  return bp
}

const waitFor = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 25))
  expect(cond()).toBe(true)
}

describe('resume after the app closes', () => {
  it('suspends a run as interrupted, then resumes it: finished steps are not repeated and spend carries over', async () => {
    // First launch: plan finishes, the builder is mid-flight when the app closes.
    const first = harness(
      new Fake((req) => {
        if (req.access === 'edit') {
          fs.writeFileSync(path.join(req.cwd, 'partial.txt'), 'half\n')
          return hangUntilAborted(req)
        }
        return ok()
      })
    )
    const r = await first.engine.start(args(pipeline(fileExists)))
    if (!r.ok) throw new Error(r.error)
    await waitFor(() => first.events.some((e) => e.type === 'node.started' && e.nodeId === 'build'))
    await first.engine.suspendAll()

    const stopped = foldRun(first.events)!
    expect(stopped.status).toBe('interrupted') // not "cancelled": the user did not stop it
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1) // scratch dir removed on the way out

    // Second launch: a new engine over the same stored log.
    const secondFake = new Fake((req) => {
      if (req.access === 'edit') fs.writeFileSync(path.join(req.cwd, 'built.txt'), 'built\n')
      return ok()
    })
    const second = harness(secondFake)
    const persisted = first.store.read(r.runId)
    const resumed = await second.engine.resume(persisted)
    if (!resumed.ok) throw new Error(resumed.error)
    await second.engine.whenDone(r.runId)

    // The planner was not run again; the builder and reviewer were.
    expect(second.engine.activeRunIds()).toEqual([])
    const all = [...persisted, ...second.events]
    const v = foldRun(all)!
    expect(v.status).toBe('passed')
    expect(v.nodes.plan.attempts).toBe(1)
    expect(v.nodes.build.attempts).toBe(2)
    expect(v.spentUsd).toBeCloseTo(0.4) // plan, the cancelled build, the build again, review
    expect(v.reason).toBe('Finished every step.')

    // The work the first attempt left is on the same branch as the new work.
    const files = git(repo, 'ls-tree', '-r', '--name-only', v.branch!)
    expect(files).toContain('partial.txt')
    expect(files).toContain('built.txt')
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1)
    // The interrupted build never finished, so it starts a new session rather
    // than resuming one that may not exist.
    expect(secondFake.reqs.map((q) => q.access)).toEqual(['edit', 'read'])
    expect(secondFake.reqs[0].resume).toBe(false)
  })

  it('resumes a run whose scratch directory survived a hard kill', async () => {
    const first = harness(new Fake((req) => (req.access === 'edit' ? hangUntilAborted(req) : ok())))
    const r = await first.engine.start(args(pipeline(fileExists)))
    if (!r.ok) throw new Error(r.error)
    await waitFor(() => first.events.some((e) => e.type === 'node.started' && e.nodeId === 'build'))
    const snapshot = [...first.events] // what a killed app would have on disk: no finish event
    await first.engine.suspendAll()

    // Recreate the orphan a kill leaves behind: the directory is there, dirty.
    const started = snapshot.find((e) => e.type === 'node.started' && e.nodeId === 'build')!
    if (started.type !== 'node.started') throw new Error('unreachable')
    await gitops.attachWorktree(repo, { path: started.cwd, branch: started.branch! })
    fs.writeFileSync(path.join(started.cwd, 'orphan.txt'), 'left behind\n')

    const store = new RunStore(path.join(root, 'runs-killed'))
    for (const e of snapshot) store.append(e)
    expect(store.markInterrupted()).toEqual([r.runId])

    const second = harness(
      new Fake((req) => {
        if (req.access === 'edit') fs.writeFileSync(path.join(req.cwd, 'built.txt'), 'built\n')
        return ok()
      }),
      'runs-killed'
    )
    const res = await second.engine.resume(store.read(r.runId))
    if (!res.ok) throw new Error(res.error)
    await second.engine.whenDone(r.runId)

    const v = foldRun(store.read(r.runId))!
    expect(v.status).toBe('passed')
    // The orphan's uncommitted file was carried onto the branch by the resumed run.
    expect(git(repo, 'ls-tree', '-r', '--name-only', v.branch!)).toContain('orphan.txt')
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1)
  })

  it('a resumed run that is interrupted again can be resumed again', () => {
    const store = new RunStore(path.join(root, 'runs'))
    const id = '22222222-2222-2222-2222-222222222222'
    store.append({ type: 'run.started', at: 1, runId: id, projectId: 'p', projectName: 'n', projectPath: repo, flowSlug: 'f', blueprint: fromPattern(PATTERNS[0]), inputs: {}, ceilingUsd: 3 })
    expect(store.markInterrupted(2)).toEqual([id])
    store.append({ type: 'run.resumed', at: 3, runId: id })
    expect(foldRun(store.read(id))!.status).toBe('running')
    expect(store.markInterrupted(4)).toEqual([id])
    expect(foldRun(store.read(id))!.status).toBe('interrupted')
  })

  it('refuses to resume a run that is not interrupted, or that has no budget left', async () => {
    const done = harness(new Fake(() => ok()))
    const r = await done.engine.start(args(pipeline('node -e "process.exit(0)"')))
    if (!r.ok) throw new Error(r.error)
    await done.engine.whenDone(r.runId)
    const refused = await done.engine.resume(done.events)
    expect(refused.ok).toBe(false)

    const broke: RunEvent[] = done.events.filter((e) => e.type === 'run.started')
    broke.push({ type: 'node.finished', at: 2, runId: r.runId, nodeId: 'plan', attempt: 1, status: 'passed', costUsd: 100, tokens: 1, summary: 'x' })
    broke.push({ type: 'run.finished', at: 3, runId: r.runId, status: 'interrupted', reason: '' })
    const noMoney = await done.engine.resume(broke)
    expect(noMoney.ok).toBe(false)
    if (!noMoney.ok) expect(noMoney.error).toMatch(/spending ceiling/)
  })
})

describe('planResume', () => {
  // A whole run whose gate fails once: plan, build, gate(fail), build (repair), gate(pass), review.
  async function fullRun(): Promise<{ events: RunEvent[]; bp: Blueprint }> {
    const bp = pipeline(fileExists)
    const h = harness(
      new Fake((req) => {
        if (req.access === 'edit' && req.resume) fs.writeFileSync(path.join(req.cwd, 'built.txt'), 'x')
        return ok({ sessionId: req.sessionId })
      })
    )
    const r = await h.engine.start(args(bp))
    if (!r.ok) throw new Error(r.error)
    await h.engine.whenDone(r.runId)
    return { events: h.events, bp }
  }
  const upTo = (events: RunEvent[], pred: (e: RunEvent) => boolean, inclusive = true): RunEvent[] => {
    const i = events.findIndex(pred)
    return events.slice(0, inclusive ? i + 1 : i)
  }

  it('continues after the last finished step, and repeats a step that was in flight', async () => {
    const { events, bp } = await fullRun()
    const plan = upTo(events, (e) => e.type === 'node.finished' && e.nodeId === 'plan')
    expect(planResume(plan, bp, repo).node?.id).toBe('build')
    expect(planResume(plan, bp, repo).spent).toBeCloseTo(0.1)

    const building = upTo(events, (e) => e.type === 'node.started' && e.nodeId === 'build')
    const s = planResume(building, bp, repo)
    expect(s.node?.id).toBe('build') // in flight: run again
    expect(s.sessions.has('build')).toBe(false) // never finished, so nothing to resume
    expect(s.worktrees.get('build')?.branch).toMatch(/^agentship\//)
    expect(s.executions).toBe(2)
  })

  it('after a failed gate, goes to the repair node with the failure output and the builder session', async () => {
    const { events, bp } = await fullRun()
    const failed = upTo(events, (e) => e.type === 'gate.result' && !e.pass)
    const s = planResume(failed, bp, repo)
    expect(s.node?.id).toBe('build')
    expect(s.feedback).not.toBe('')
    expect(s.fails.get('tests')).toBe(1)
    expect(s.sessions.get('build')?.id).toBeTruthy() // repairs resume this session
  })

  it('after a passing gate goes on to the reviewer, which works in the builder branch', async () => {
    const { events, bp } = await fullRun()
    const passed = upTo(events, (e) => e.type === 'gate.result' && e.pass)
    const s = planResume(passed, bp, repo)
    expect(s.node?.id).toBe('review')
    expect(s.feedback).toBe('')
    expect(s.branch).toMatch(/^agentship\//)
    expect(s.cwd).toContain('wt')
    expect(s.worktrees.size).toBe(1) // only the builder owns a worktree
  })

  it('at the end of the flow there is nothing left to run', async () => {
    const { events, bp } = await fullRun()
    const last = upTo(events, (e) => e.type === 'node.finished' && e.nodeId === 'review')
    expect(planResume(last, bp, repo).node).toBeUndefined()
  })

  it('when the gate is out of retries, runs the gate again so the run ends the way it would have', async () => {
    const bp = pipeline(fileExists, 1) // the builder never writes the file, so the gate always fails
    const h = harness(new Fake(() => ok()))
    const r = await h.engine.start(args(bp))
    if (!r.ok) throw new Error(r.error)
    await h.engine.whenDone(r.runId)
    expect(foldRun(h.events)!.status).toBe('failed')
    const second = h.events.filter((e) => e.type === 'gate.result' && !e.pass)[1]
    const s = planResume(h.events.slice(0, h.events.indexOf(second) + 1), bp, repo)
    expect(s.node?.id).toBe('tests')
    expect(s.fails.get('tests')).toBe(1) // counted as if the failure were still pending
  })
})

describe('planResume with a Merge step', () => {
  const bp = buildLandBlueprint({ branch: 'feat', base: 'main', testCommand: 'npm test', resolveConflicts: false })
  const at = 1
  const started = (nodeId: string): RunEvent => ({ type: 'node.started', at, runId: 'r', nodeId, attempt: 1, cwd: '/x' }) as RunEvent
  const finished = (nodeId: string): RunEvent =>
    ({ type: 'node.finished', at, runId: 'r', nodeId, attempt: 1, status: 'passed', costUsd: 0, tokens: 0, summary: 's' }) as RunEvent

  it('goes back to Merge if the run got past it, because the merged scratch copy does not survive a restart', () => {
    const afterMerge = [started('test'), finished('test'), started('merge'), finished('merge'), started('verify')]
    expect(planResume(afterMerge, bp, repo).node?.id).toBe('merge')
    const inLand = [...afterMerge, finished('verify'), started('land')]
    expect(planResume(inLand, bp, repo).node?.id).toBe('merge')
  })

  it('is unchanged before the Merge step', () => {
    expect(planResume([started('test'), finished('test')], bp, repo).node?.id).toBe('merge')
    expect(planResume([started('test')], bp, repo).node?.id).toBe('test')
  })
})

describe('orphan worktree sweep', () => {
  it('commits a dead run\'s work to its branch, removes the directory, keeps resumable ones, and leaves strangers alone', async () => {
    const wt = path.join(root, 'wt')
    const dead = await gitops.createWorktree(repo, wt, 'aaaaaaaa-build', 'HEAD')
    fs.writeFileSync(path.join(dead.path, 'saved.txt'), 'do not lose me\n')
    const live = await gitops.createWorktree(repo, wt, 'bbbbbbbb-build', 'HEAD')
    const stranger = path.join(wt, 'not-a-worktree')
    fs.mkdirSync(stranger, { recursive: true })
    fs.writeFileSync(path.join(stranger, 'notes.txt'), 'mine\n')

    const res = await gitops.sweepWorktrees(wt, (name) => name.startsWith('bbbbbbbb-'))

    expect(res.removed).toEqual([dead.path])
    expect(res.kept).toEqual([live.path])
    expect(res.skipped).toEqual([stranger])
    expect(fs.existsSync(dead.path)).toBe(false)
    expect(fs.existsSync(live.path)).toBe(true)
    expect(fs.existsSync(path.join(stranger, 'notes.txt'))).toBe(true)
    // The work survives on the branch.
    expect(git(repo, 'show', `${dead.branch}:saved.txt`)).toBe('do not lose me')
  })

  it('never deletes through a linked node_modules, and drops detached scratch copies without committing', async () => {
    fs.mkdirSync(path.join(repo, 'node_modules'))
    fs.writeFileSync(path.join(repo, 'node_modules', 'dep.js'), 'precious\n')
    const wt = path.join(root, 'wt')
    const copy = await gitops.createDetachedWorktree(repo, wt, 'cccccccc-merge', 'HEAD')
    expect(fs.lstatSync(path.join(copy.path, 'node_modules')).isSymbolicLink()).toBe(true) // the link main adds
    fs.writeFileSync(path.join(copy.path, 'scratch.txt'), 'throwaway\n')
    const before = git(repo, 'rev-parse', 'HEAD')

    const res = await gitops.sweepWorktrees(wt, () => false)

    expect(res.removed).toEqual([copy.path])
    expect(fs.readFileSync(path.join(repo, 'node_modules', 'dep.js'), 'utf8')).toBe('precious\n')
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before)
    expect(git(repo, 'branch', '--list', 'agentship/*')).toBe('') // nothing was made of it
  })

  it('does nothing when there is no scratch directory yet', async () => {
    expect(await gitops.sweepWorktrees(path.join(root, 'nope'), () => false)).toEqual({ removed: [], kept: [], skipped: [] })
  })

  it('keeps only recently interrupted runs\' worktrees', () => {
    const mk = (id: string, status: 'interrupted' | 'failed', at: number): { runId: string; events: RunEvent[] } => ({
      runId: id,
      events: [
        { type: 'run.started', at, runId: id, projectId: 'p', projectName: 'n', projectPath: repo, flowSlug: 'f', blueprint: fromPattern(PATTERNS[0]), inputs: {}, ceilingUsd: 1 },
        { type: 'run.finished', at, runId: id, status, reason: '' }
      ]
    })
    const now = 10 * RESUME_WINDOW_MS
    const keep = resumableRunIds([mk('recent', 'interrupted', now - 1000), mk('old', 'interrupted', now - RESUME_WINDOW_MS - 1), mk('failed', 'failed', now)], now)
    expect([...keep]).toEqual(['recent'])
  })
})

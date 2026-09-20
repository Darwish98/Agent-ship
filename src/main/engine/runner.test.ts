import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { foldRun, type RunEvent } from '../../shared/runs'
import type { Blueprint } from '../../shared/schema'
import { fromPattern, PATTERNS } from '../../shared/patterns'
import { buildClaudeArgs, type AgentAdapter, type StepRequest, type StepResult } from './adapter'
import { RunEngine } from './runner'
import { RunStore } from './store'

let root: string
let repo: string

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-test-'))
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

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const ok = (over: Partial<StepResult> = {}): StepResult => ({
  ok: true,
  result: 'done',
  costUsd: 0.1,
  tokens: 1000,
  sessionId: 's',
  budgetExhausted: false,
  timedOut: false,
  cancelled: false,
  ...over
})

class Fake implements AgentAdapter {
  reqs: StepRequest[] = []
  constructor(private readonly handler: (req: StepRequest, n: number) => StepResult | Promise<StepResult>) {}
  async run(req: StepRequest): Promise<StepResult> {
    this.reqs.push(req)
    return this.handler(req, this.reqs.length)
  }
}

function harness(adapter: AgentAdapter): { engine: RunEngine; events: RunEvent[]; store: RunStore } {
  const events: RunEvent[] = []
  const store = new RunStore(path.join(root, 'runs'))
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

const args = (bp: Blueprint, inputs: Record<string, string> = { task: 'add a file' }) => ({
  projectId: 'p',
  projectName: 'repo',
  projectPath: repo,
  flowSlug: 'flow',
  blueprint: bp,
  inputs
})

/** plan → build(worktree) → gate → review, with a gate command we control. */
function pipeline(gateCommand: string, retries = 2): Blueprint {
  const bp = fromPattern(PATTERNS[2])
  const gate = bp.nodes.find((n) => n.id === 'tests')!
  if (gate.kind === 'gate') gate.config.command = gateCommand
  gate.budget = { maxRetries: retries }
  return bp
}

const fileExists = 'node -e "process.exit(require(\'fs\').existsSync(\'built.txt\')?0:1)"'

const finalView = (events: RunEvent[]) => foldRun(events)!

describe('run engine', () => {
  it('runs a pipeline end to end, leaves a branch with the work, and removes the worktree', async () => {
    const fake = new Fake((req) => {
      if (req.access === 'edit') fs.writeFileSync(path.join(req.cwd, 'built.txt'), 'built\n')
      return ok({ result: `did ${path.basename(req.cwd)}` })
    })
    const { engine, events } = harness(fake)
    const started = await engine.start(args(pipeline(fileExists)))
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await engine.whenDone(started.runId)

    const v = finalView(events)
    expect(v.status).toBe('passed')
    expect(v.spentUsd).toBeCloseTo(0.3) // plan + build + review, 0.1 each
    expect(v.branch).toMatch(/^agentship\//)

    // The commit is on the branch, not on main, and the scratch dir is gone.
    expect(git(repo, 'ls-tree', '-r', '--name-only', v.branch!)).toContain('built.txt')
    expect(git(repo, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('built.txt')
    expect(fs.existsSync(path.join(root, 'wt', v.branch!.split('/')[1]))).toBe(false)
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1)

    // The reviewer (no worktree of its own) ran in the builder's worktree, and
    // its prompt could reference the builder's result.
    const review = fake.reqs[fake.reqs.length - 1]
    expect(review.access).toBe('read')
    expect(review.cwd).toContain('wt')
    expect(review.prompt).toContain('The builder said:\ndid ')
    // Every session id was chosen by the engine.
    expect(new Set(fake.reqs.map((r) => r.sessionId)).size).toBe(3)
  })

  it('loops a failing gate back to the builder by resuming its session, then passes', async () => {
    const fake = new Fake((req, n) => {
      // Attempt 1 builds nothing; the repair (a resume) fixes it.
      if (req.access === 'edit' && req.resume) fs.writeFileSync(path.join(req.cwd, 'built.txt'), 'x')
      return ok({ sessionId: req.sessionId, result: `call ${n}` })
    })
    const { engine, events } = harness(fake)
    const r = await engine.start(args(pipeline(fileExists)))
    if (!r.ok) throw new Error(r.error)
    await engine.whenDone(r.runId)

    const v = finalView(events)
    expect(v.status).toBe('passed')
    const builds = fake.reqs.filter((q) => q.access === 'edit')
    expect(builds).toHaveLength(2)
    expect(builds[1].resume).toBe(true)
    expect(builds[1].sessionId).toBe(builds[0].sessionId)
    expect(builds[1].cwd).toBe(builds[0].cwd)
    expect(builds[1].prompt).toContain('exit 1')
    expect(v.nodes.tests.attempts).toBe(2)
  })

  it('stops when a gate is still failing after its retry cap', async () => {
    const fake = new Fake(() => ok())
    const { engine, events } = harness(fake)
    const r = await engine.start(args(pipeline(fileExists, 1)))
    if (!r.ok) throw new Error(r.error)
    await engine.whenDone(r.runId)
    const v = finalView(events)
    expect(v.status).toBe('failed')
    expect(v.reason).toMatch(/still failing after 2 attempts/)
    expect(fake.reqs.filter((q) => q.access === 'edit')).toHaveLength(2) // first try + 1 retry
    // No reviewer ran.
    expect(v.nodes.review.state).toBe('idle')
    // The branch survives a failed run for inspection.
    expect(git(repo, 'branch', '--list', 'agentship/*')).toContain('agentship/')
  })

  it('stops as "budget" when the CLI reports its dollar cap was hit', async () => {
    const fake = new Fake((req) => (req.access === 'edit' ? ok({ ok: false, budgetExhausted: true, costUsd: 1.02, error: 'Reached maximum budget' }) : ok()))
    const { engine, events } = harness(fake)
    const r = await engine.start(args(pipeline(fileExists)))
    if (!r.ok) throw new Error(r.error)
    await engine.whenDone(r.runId)
    const v = finalView(events)
    expect(v.status).toBe('budget')
    expect(v.nodes.review.state).toBe('idle')
  })

  it('never hands a step more than the money left in the run', async () => {
    // Ceiling here is 0.5 + 1 x (1 + 2 retries) + 0.5 = 4. The planner burns
    // 3.9 of it, so the builder may only be given what is left.
    const fake = new Fake((req) => ok({ costUsd: fake.reqs.length === 1 ? 3.9 : 0 }))
    const { engine, events } = harness(fake)
    const r = await engine.start(args(pipeline(fileExists)))
    if (!r.ok) throw new Error(r.error)
    await engine.whenDone(r.runId)
    const ceiling = finalView(events).ceilingUsd
    expect(ceiling).toBeCloseTo(4)
    expect(fake.reqs[1].maxUsd).toBeCloseTo(ceiling - 3.9)
  })

  it('refuses to start a step once the ceiling is used up', async () => {
    const fake = new Fake(() => ok({ costUsd: 6 }))
    const { engine, events } = harness(fake)
    const r = await engine.start(args(pipeline(fileExists)))
    if (!r.ok) throw new Error(r.error)
    await engine.whenDone(r.runId)
    const v = finalView(events)
    expect(v.status).toBe('budget')
    expect(fake.reqs).toHaveLength(1)
  })

  it('cancels mid-step, keeps whatever was committed, and cleans up', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const fake = new Fake(async (req) => {
      if (req.access === 'edit') {
        fs.writeFileSync(path.join(req.cwd, 'partial.txt'), 'wip')
        await gate
        return ok({ cancelled: true, ok: false, error: 'Cancelled.' })
      }
      return ok()
    })
    const { engine, events } = harness(fake)
    const r = await engine.start(args(pipeline(fileExists)))
    if (!r.ok) throw new Error(r.error)
    await new Promise((res) => setTimeout(res, 400))
    expect(engine.cancel(r.runId)).toBe(true)
    release()
    await engine.whenDone(r.runId)
    const v = finalView(events)
    expect(v.status).toBe('cancelled')
    expect(git(repo, 'ls-tree', '-r', '--name-only', v.branch!)).toContain('partial.txt')
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1)
  })

  describe('human gate', () => {
    const humanFlow = (retries: number): Blueprint => {
      const bp = pipeline(fileExists, retries)
      const gate = bp.nodes.find((n) => n.id === 'tests')!
      if (gate.kind === 'gate') gate.config = { check: 'human', command: '', instructions: 'Look at it' }
      return bp
    }
    const awaitingCount = (events: RunEvent[]): number => events.filter((e) => e.type === 'gate.awaiting').length
    const waitForAwaiting = async (events: RunEvent[], n: number): Promise<void> => {
      for (let i = 0; i < 200 && awaitingCount(events) < n; i++) await new Promise((res) => setTimeout(res, 25))
      expect(awaitingCount(events)).toBeGreaterThanOrEqual(n)
    }

    it('pauses, then continues on approval', async () => {
      const { engine, events } = harness(new Fake(() => ok()))
      const r = await engine.start(args(humanFlow(2)))
      if (!r.ok) throw new Error(r.error)
      await waitForAwaiting(events, 1)
      expect(finalView(events).status).toBe('awaiting')
      expect(engine.decide(r.runId, true, 'lgtm')).toBe(true)
      await engine.whenDone(r.runId)
      const v = finalView(events)
      expect(v.status).toBe('passed')
      expect(v.nodes.tests.detail).toBe('lgtm')
    })

    it('sends a rejection back to the builder with the reviewer note, and fails past the retry cap', async () => {
      const fake = new Fake(() => ok())
      const { engine, events } = harness(fake)
      const r = await engine.start(args(humanFlow(1)))
      if (!r.ok) throw new Error(r.error)
      await waitForAwaiting(events, 1)
      engine.decide(r.runId, false, 'use tabs')
      await waitForAwaiting(events, 2) // asked again after the repair
      expect(fake.reqs.filter((q) => q.access === 'edit').pop()!.prompt).toContain('use tabs')
      engine.decide(r.runId, false, 'still no')
      await engine.whenDone(r.runId)
      expect(finalView(events).status).toBe('failed')
    })

    it('a decision with nothing waiting is ignored', async () => {
      const { engine } = harness(new Fake(() => ok()))
      expect(engine.decide('nope', true, '')).toBe(false)
    })
  })

  it('rejects flows the engine cannot run, before spending anything', async () => {
    const fake = new Fake(() => ok())
    const { engine } = harness(fake)
    const r = await engine.start(args(fromPattern(PATTERNS[3]))) // tournament: fan-out
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/cannot execute fanout/)
    expect(fake.reqs).toHaveLength(0)
  })

  it('requires a commit before giving an agent a branch', async () => {
    const empty = path.join(root, 'empty')
    fs.mkdirSync(empty)
    git(empty, 'init', '-q')
    const { engine } = harness(new Fake(() => ok()))
    const r = await engine.start({ ...args(pipeline(fileExists)), projectPath: empty })
    expect(r.ok).toBe(false)
  })

  it('requires required inputs', async () => {
    const { engine } = harness(new Fake(() => ok()))
    const r = await engine.start(args(pipeline(fileExists), { task: '  ' }))
    expect(r.ok).toBe(false)
  })
})

describe('run store', () => {
  it('rebuilds a run from its file, tolerates a torn last line, and marks stale runs interrupted', () => {
    const store = new RunStore(path.join(root, 'runs'))
    const started: RunEvent = {
      type: 'run.started', at: 1, runId: '11111111-1111-1111-1111-111111111111', projectId: 'p', projectName: 'n',
      projectPath: repo, flowSlug: 'f', blueprint: fromPattern(PATTERNS[0]), inputs: {}, ceilingUsd: 3
    }
    store.append(started)
    fs.appendFileSync(path.join(root, 'runs', `${started.runId}.jsonl`), '{"type":"node.sta') // crash mid-write
    expect(store.read(started.runId)).toHaveLength(1)
    expect(store.markInterrupted(5)).toEqual([started.runId])
    expect(foldRun(store.read(started.runId))!.status).toBe('interrupted')
    expect(store.markInterrupted(6)).toEqual([]) // idempotent
  })

  it('rejects ids that are not run ids', () => {
    const store = new RunStore(path.join(root, 'runs'))
    expect(store.read('../../etc/passwd')).toEqual([])
  })
})

describe('claude cli arguments', () => {
  const base: StepRequest = {
    prompt: 'SECRET PROMPT', cwd: '.', sessionId: 'sid', resume: false, model: 'default', access: 'read',
    tools: [], maxUsd: 0.5, jsonSchema: '', env: {}, timeoutMs: 1, signal: new AbortController().signal
  }

  it('never puts the prompt on the command line', () => {
    expect(buildClaudeArgs(base).join(' ')).not.toContain('SECRET PROMPT')
  })

  it('maps access to a permission mode and never allows prompting', () => {
    const read = buildClaudeArgs(base)
    expect(read).toContain('dontAsk')
    expect(read[read.indexOf('--permission-prompts') + 1]).toBe('none')
    expect(buildClaudeArgs({ ...base, access: 'edit' })).toContain('acceptEdits')
    expect(buildClaudeArgs(base).join(' ')).not.toContain('bypassPermissions')
  })

  it('resumes vs starts a session, and always passes a dollar cap', () => {
    expect(buildClaudeArgs(base)).toContain('--session-id')
    expect(buildClaudeArgs({ ...base, resume: true })).toContain('--resume')
    const a = buildClaudeArgs(base)
    expect(a[a.indexOf('--max-budget-usd') + 1]).toBe('0.5')
  })

  it('keeps the variadic allow-list last so it cannot swallow other flags', () => {
    const a = buildClaudeArgs({ ...base, tools: ['Bash(npm test)'], model: 'haiku' })
    const i = a.indexOf('--allowedTools')
    expect(a.slice(i + 1)).toEqual(['Read', 'Glob', 'Grep', 'Bash(npm test)'])
    expect(a).toContain('haiku')
  })
})

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { foldRun, type RunEvent } from '../../shared/runs'
import { fromPattern, PATTERNS } from '../../shared/patterns'
import type { Blueprint } from '../../shared/schema'
import type { AgentAdapter, StepRequest, StepResult } from './adapter'
import { planResume } from './resume'
import { RunEngine } from './runner'
import { RunStore } from './store'

// Real git worktrees on Windows are slow, and several copies each make one.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

let root: string
let repo: string
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-test-'))
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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

class Fake implements AgentAdapter {
  reqs: StepRequest[] = []
  live = 0
  maxLive = 0
  constructor(private readonly handler: (req: StepRequest, n: number) => StepResult | Promise<StepResult>) {}
  async run(req: StepRequest): Promise<StepResult> {
    this.reqs.push(req)
    this.live++
    this.maxLive = Math.max(this.maxLive, this.live)
    try {
      return await this.handler(req, this.reqs.length)
    } finally {
      this.live--
    }
  }
}

const abortable = (req: StepRequest, ms: number, done: () => StepResult): Promise<StepResult> =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(done()), ms)
    req.signal.addEventListener('abort', () => { clearTimeout(t); resolve({ ...ok(), ok: false, cancelled: true, error: 'Cancelled.' }) }, { once: true })
  })

function harness(adapter: AgentAdapter, dir = 'runs'): { engine: RunEngine; events: RunEvent[]; store: RunStore } {
  const events: RunEvent[] = []
  const store = new RunStore(path.join(root, dir))
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

const args = (bp: Blueprint) => ({ projectId: 'p', projectName: 'repo', projectPath: repo, flowSlug: 'flow', blueprint: bp, inputs: { task: 'add a file' } })
const passes = 'node -e "process.exit(0)"'
const needsBuilt = 'node -e "process.exit(require(\'fs\').existsSync(\'built.txt\')?0:1)"'

/** The shipped tournament, cut down to fan-out → contender → gate → join (no merge/land), with our knobs. */
function tournament(opts: { strategy?: 'all' | 'first' | 'quorum' | 'best'; quorum?: number; count?: number; gate?: string; maxUsd?: number } = {}): Blueprint {
  const bp = fromPattern(PATTERNS[3])
  bp.nodes = bp.nodes.filter((n) => !['merge', 'verify', 'land'].includes(n.id))
  bp.edges = bp.edges.filter((e) => !['pick->merge', 'merge->verify', 'verify->land'].includes(e.id))
  const fan = bp.nodes.find((n) => n.id === 'spread')!
  if (fan.kind === 'fanout') fan.config.count = opts.count ?? 3
  const pick = bp.nodes.find((n) => n.id === 'pick')!
  if (pick.kind === 'join') pick.config = { ...pick.config, strategy: opts.strategy ?? 'best', quorum: opts.quorum ?? 2 }
  const gate = bp.nodes.find((n) => n.id === 'tests')!
  if (gate.kind === 'gate') gate.config.command = opts.gate ?? passes
  if (opts.maxUsd) bp.nodes.forEach((n) => { if (n.kind === 'agent') n.budget = { ...n.budget, maxUsd: opts.maxUsd } })
  return bp
}

const copyOf = (req: StepRequest): number => Number(/contender (\d+) of/.exec(req.prompt)?.[1] ?? 0)
const isJudge = (req: StepRequest): boolean => req.env.AGENT_SHIP_NAME === 'Judge'
const branches = (): string[] => git(repo, 'branch', '--list', 'agentship/*').split('\n').map((s) => s.replace('*', '').trim()).filter(Boolean)

describe('parallel copies', () => {
  it('runs the copies at the same time, each in its own branch, and a judge picks the winner', async () => {
    const fake = new Fake(async (req) => {
      if (isJudge(req)) return ok({ costUsd: 0.05, structured: { winner: 2, reason: 'smallest change' } })
      const n = copyOf(req)
      fs.writeFileSync(path.join(req.cwd, `attempt-${n}.txt`), `copy ${n}\n`)
      await sleep(80)
      return ok({ result: `did it my way (${n})` })
    })
    const { engine, events } = harness(fake)
    const r = await engine.start(args(tournament()))
    if (!r.ok) throw new Error(r.error)
    await engine.whenDone(r.runId)

    const v = foldRun(events)!
    expect(v.status).toBe('passed')
    expect(fake.maxLive).toBe(3) // three copies were in flight together

    // Three contenders + one judge; the judge saw every attempt's branch and diff.
    const contenders = fake.reqs.filter((q) => !isJudge(q))
    expect(contenders).toHaveLength(3)
    expect(new Set(contenders.map((q) => q.cwd)).size).toBe(3)
    const judge = fake.reqs.find(isJudge)!
    expect(judge.access).toBe('read')
    expect(judge.prompt).toContain('attempt-1.txt')
    expect(judge.prompt).toContain('attempt-3.txt')
    expect(judge.prompt).toContain('Correctness first') // the criteria from the join node

    // The winner's branch is the outcome; the losers' branches were dropped.
    expect(v.branch).toBeDefined()
    expect(git(repo, 'ls-tree', '-r', '--name-only', v.branch!)).toContain('attempt-2.txt')
    expect(branches()).toEqual([v.branch])
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1) // every scratch directory is gone

    // Money: 3 x 0.1 + the judge's 0.05, all inside the run's ledger.
    expect(v.spentUsd).toBeCloseTo(0.35)
    const pick = v.nodes.pick
    expect(pick.detail).toContain('Picked copy 2 of 3')
    expect(pick.detail).toContain('smallest change')
    expect(pick.detail).toContain('did it my way (2)')
  })

  it('shows each copy as its own step and the node as running until the last copy ends', async () => {
    const fake = new Fake(async (req) => {
      if (isJudge(req)) return ok({ structured: { winner: 1, reason: 'x' } })
      await sleep(copyOf(req) * 60)
      return ok()
    })
    const { engine, events } = harness(fake)
    const r = await engine.start(args(tournament()))
    if (!r.ok) throw new Error(r.error)
    await engine.whenDone(r.runId)

    const steps = foldRun(events)!.steps.filter((s) => s.nodeId === 'contender')
    expect(steps.map((s) => s.copy).sort()).toEqual([1, 2, 3])
    expect(new Set(steps.map((s) => s.attempt)).size).toBe(3) // attempts are unique per node

    // Replay the log up to the moment copy 1 finished: 2 and 3 are still going.
    const firstDone = events.findIndex((e) => e.type === 'node.finished' && e.nodeId === 'contender')
    const mid = foldRun(events.slice(0, firstDone + 1))!
    expect(mid.nodes.contender.state).toBe('running')
  })

  it('gives each copy its own results when a later step in the chain refers to an earlier one', async () => {
    const bp = tournament({ strategy: 'all' })
    // contender -> reviewer, inside every copy; the reviewer quotes its own copy's contender.
    bp.nodes.push({
      id: 'reviewer', kind: 'agent', label: 'Reviewer', position: { x: 0, y: 0 },
      budget: { maxUsd: 0.2 },
      config: { role: 'Reviewer', model: 'default', prompt: 'REVIEW: {{contender.result}}', worktree: false, access: 'read', tools: [], outputSchema: '' }
    })
    bp.edges = bp.edges.filter((e) => e.id !== 'tests->pick')
    bp.edges.push(
      { id: 'tests->reviewer', from: 'tests', to: 'reviewer', type: 'verdict', condition: 'pass' },
      { id: 'reviewer->pick', from: 'reviewer', to: 'pick', type: 'artifact', condition: 'always' }
    )
    const fake = new Fake(async (req) => {
      if (req.prompt.startsWith('REVIEW')) { await sleep(20); return ok({ result: 'reviewed' }) }
      const n = copyOf(req)
      await sleep((4 - n) * 50) // copy 3 finishes first, copy 1 last
      return ok({ result: `MINE-${n}` })
    })
    const { engine, events } = harness(fake)
    const r = await engine.start(args(bp))
    if (!r.ok) throw new Error(r.error)
    await engine.whenDone(r.runId)
    expect(foldRun(events)!.status).toBe('passed')

    const reviews = fake.reqs.filter((q) => q.prompt.startsWith('REVIEW')).map((q) => q.prompt)
    expect(reviews.sort()).toEqual(['REVIEW: MINE-1', 'REVIEW: MINE-2', 'REVIEW: MINE-3'])
  })

  it('a copy repairs itself when its own gate fails, without disturbing the others', async () => {
    const fake = new Fake((req) => {
      if (isJudge(req)) return ok({ structured: { winner: 1, reason: 'x' } })
      // Copy 2 builds nothing on its first try; a resumed repair fixes it. The others build at once.
      if (req.resume || copyOf(req) !== 2) fs.writeFileSync(path.join(req.cwd, 'built.txt'), 'x')
      return ok({ sessionId: req.sessionId })
    })
    const { engine, events } = harness(fake)
    const r = await engine.start(args(tournament({ gate: needsBuilt })))
    if (!r.ok) throw new Error(r.error)
    await engine.whenDone(r.runId)

    const v = foldRun(events)!
    expect(v.status).toBe('passed')
    const gates = events.filter((e) => e.type === 'gate.result')
    expect(gates.filter((g) => g.type === 'gate.result' && !g.pass)).toHaveLength(1)
    expect(fake.reqs.filter((q) => q.resume)).toHaveLength(1) // only copy 2 needed a repair
  })

  describe('join strategies', () => {
    it('first: takes the first copy to pass and stops the rest', async () => {
      const fake = new Fake((req) => {
        const n = copyOf(req)
        if (n === 2) return ok({ result: 'quick' })
        return abortable(req, 3_000, () => ok({ result: 'slow' }))
      })
      const { engine, events } = harness(fake)
      const t0 = Date.now()
      const r = await engine.start(args(tournament({ strategy: 'first' })))
      if (!r.ok) throw new Error(r.error)
      await engine.whenDone(r.runId)

      expect(Date.now() - t0).toBeLessThan(2_500) // did not wait for the slow ones
      const v = foldRun(events)!
      expect(v.status).toBe('passed')
      expect(v.nodes.pick.detail).toContain('Picked copy 2')
      expect(fake.reqs.some(isJudge)).toBe(false) // no judge for "first"
      expect(v.nodes.spread.detail).toMatch(/1 of 3 copies finished; the rest were stopped/)
      expect(branches()).toEqual([v.branch])
    })

    it('best: one passer needs no judge, and the judge is not called (no money spent on a foregone answer)', async () => {
      const fake = new Fake((req) => {
        const n = copyOf(req)
        if (n !== 1) return { ...ok(), ok: false, error: 'could not do it' }
        return ok({ result: 'only one' })
      })
      const { engine, events } = harness(fake)
      const r = await engine.start(args(tournament()))
      if (!r.ok) throw new Error(r.error)
      await engine.whenDone(r.runId)
      expect(foldRun(events)!.status).toBe('passed')
      expect(fake.reqs.some(isJudge)).toBe(false)
    })

    it('best: if the judge fails or names a copy that did not pass, the cheapest passing copy is kept and the run says so', async () => {
      const fake = new Fake((req) => {
        if (isJudge(req)) return ok({ structured: { winner: 9, reason: 'nonsense' } })
        const n = copyOf(req)
        return ok({ costUsd: n === 3 ? 0.01 : 0.2, result: `r${n}` })
      })
      const { engine, events } = harness(fake)
      const r = await engine.start(args(tournament()))
      if (!r.ok) throw new Error(r.error)
      await engine.whenDone(r.runId)
      const v = foldRun(events)!
      expect(v.status).toBe('passed')
      expect(v.nodes.pick.detail).toContain('Picked copy 3')
      expect(v.nodes.pick.detail).toContain('did not name one of the passing copies')
    })

    it('all: every copy must pass, and the run fails naming the copy that did not', async () => {
      const fake = new Fake((req) => (copyOf(req) === 2 ? { ...ok(), ok: false, error: 'boom' } : abortable(req, 200, () => ok())))
      const { engine, events } = harness(fake)
      const r = await engine.start(args(tournament({ strategy: 'all' })))
      if (!r.ok) throw new Error(r.error)
      await engine.whenDone(r.runId)
      const v = foldRun(events)!
      expect(v.status).toBe('failed')
      expect(v.reason).toMatch(/needs all 3 copies/)
      expect(v.reason).toMatch(/copy 2: .*boom/)
      expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1)
    })

    it('all: keeps every copy\'s branch as an outcome and continues with no single branch', async () => {
      const fake = new Fake((req) => {
        fs.writeFileSync(path.join(req.cwd, `c${copyOf(req)}.txt`), 'x')
        return ok({ result: `r${copyOf(req)}` })
      })
      const { engine, events } = harness(fake)
      const r = await engine.start(args(tournament({ strategy: 'all' })))
      if (!r.ok) throw new Error(r.error)
      await engine.whenDone(r.runId)
      const v = foldRun(events)!
      expect(v.status).toBe('passed')
      expect(branches()).toHaveLength(3)
      expect(v.nodes.pick.detail).toContain('Copy 1')
      expect(v.nodes.pick.detail).toContain('Copy 3')
      expect(v.branch).toBeUndefined() // no winner was chosen, so no single result branch
    })

    it('quorum: continues once enough copies pass and stops the rest', async () => {
      const fake = new Fake((req) => (copyOf(req) <= 2 ? ok({ result: `r${copyOf(req)}` }) : abortable(req, 3_000, () => ok())))
      const { engine, events } = harness(fake)
      const r = await engine.start(args(tournament({ strategy: 'quorum', quorum: 2 })))
      if (!r.ok) throw new Error(r.error)
      await engine.whenDone(r.runId)
      const v = foldRun(events)!
      expect(v.status).toBe('passed')
      expect(v.nodes.pick.detail).toContain('2 of 3 copies finished')
    })

    it('fails, without waiting, once a join cannot be satisfied any more', async () => {
      const fake = new Fake((req) => (copyOf(req) === 1 ? { ...ok(), ok: false, error: 'nope' } : abortable(req, 3_000, () => ok())))
      const { engine, events } = harness(fake)
      const t0 = Date.now()
      const r = await engine.start(args(tournament({ strategy: 'all' })))
      if (!r.ok) throw new Error(r.error)
      await engine.whenDone(r.runId)
      expect(Date.now() - t0).toBeLessThan(2_500)
      expect(foldRun(events)!.status).toBe('failed')
    })
  })

  describe('money', () => {
    it('never lets parallel copies spend past the run ceiling, even when each one alone would fit', async () => {
      // Ceiling: 3 copies x $0.5 x 2 (gate retry) + judge $0.3 = $3.3. Every step tries to spend as much as it is allowed.
      const bp = tournament()
      const caps: number[] = []
      const fake = new Fake(async (req) => {
        caps.push(req.maxUsd)
        await sleep(30)
        return ok({ costUsd: req.maxUsd, structured: isJudge(req) ? { winner: 1, reason: 'x' } : undefined })
      })
      const { engine, events } = harness(fake)
      const r = await engine.start(args(bp))
      if (!r.ok) throw new Error(r.error)
      await engine.whenDone(r.runId)
      const v = foldRun(events)!
      expect(v.spentUsd).toBeLessThanOrEqual(v.ceilingUsd + 1e-9)
      expect(v.status).toBe('passed')
    })

    it('reserves a step\'s cap while it runs, so a copy cannot be promised money another already holds', async () => {
      // A $1 ceiling shared by three copies that each want $0.5: only two can be in flight at once.
      const bp = tournament({ count: 3, maxUsd: 0.5 })
      bp.defaultBudget = { maxUsd: 0.5 }
      const gate = bp.nodes.find((n) => n.id === 'tests')!
      gate.budget = { maxRetries: 0 }
      bp.edges = bp.edges.filter((e) => e.id !== 'tests->contender:fail')
      const fake = new Fake(async (req) => {
        await sleep(50)
        return ok({ costUsd: 0.1, structured: isJudge(req) ? { winner: 1, reason: 'x' } : undefined })
      })
      const h = harness(fake)
      const r = await h.engine.start(args(bp))
      if (!r.ok) throw new Error(r.error)
      await h.engine.whenDone(r.runId)
      // The ceiling is 3 x 0.5 + judge 0.5 = 2; all four steps fit, and the ledger stays inside it.
      const v = foldRun(h.events)!
      expect(v.spentUsd).toBeLessThanOrEqual(v.ceilingUsd)
    })
  })

  it('stops every copy when the user stops the run, and reports it as stopped, not as a failed join', async () => {
    const fake = new Fake((req) => abortable(req, 5_000, () => ok()))
    const { engine, events } = harness(fake)
    const r = await engine.start(args(tournament()))
    if (!r.ok) throw new Error(r.error)
    for (let i = 0; i < 100 && fake.live < 3; i++) await sleep(20)
    expect(fake.live).toBe(3)
    engine.cancel(r.runId)
    await engine.whenDone(r.runId)
    const v = foldRun(events)!
    expect(v.status).toBe('cancelled')
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1)
  })

  it('more copies than the parallel limit queue instead of all starting at once', async () => {
    const fake = new Fake(async (req) => {
      if (isJudge(req)) return ok({ structured: { winner: 1, reason: 'x' } })
      await sleep(150)
      return ok()
    })
    const { engine, events } = harness(fake)
    const bp = tournament({ count: 6 })
    bp.defaultBudget = { maxUsd: 1 }
    const r = await engine.start(args(bp))
    if (!r.ok) throw new Error(r.error)
    await engine.whenDone(r.runId)
    expect(foldRun(events)!.status).toBe('passed')
    // Never more than the limit at once (git makes the exact peak vary with load), but really parallel.
    expect(fake.maxLive).toBeLessThanOrEqual(4)
    expect(fake.maxLive).toBeGreaterThanOrEqual(2)
    expect(fake.reqs.filter((q) => !isJudge(q))).toHaveLength(6)
  })
})

describe('the whole tournament: pick, merge, re-test, land', () => {
  it('lands the judge\'s winner on main', async () => {
    const fake = new Fake((req) => {
      if (isJudge(req)) return ok({ structured: { winner: 3, reason: 'cleanest' } })
      const n = copyOf(req)
      if (req.access === 'edit') fs.writeFileSync(path.join(req.cwd, `win-${n}.txt`), `${n}\n`)
      return ok({ result: `r${n}` })
    })
    const { engine, events } = harness(fake)
    const bp = fromPattern(PATTERNS[3])
    // Keep the gates trivial: the point here is the hand-off from the join to merge and land.
    for (const n of bp.nodes) if (n.kind === 'gate') n.config.command = passes
    const r = await engine.start(args(bp))
    if (!r.ok) throw new Error(r.error)
    await engine.whenDone(r.runId)

    const v = foldRun(events)!
    expect(v.reason).toBe('Finished every step.')
    expect(v.status).toBe('passed')
    // Only the winner's file reached main; nothing of the losers did.
    const files = git(repo, 'ls-tree', '-r', '--name-only', 'main')
    expect(files).toContain('win-3.txt')
    expect(files).not.toContain('win-1.txt')
    expect(files).not.toContain('win-2.txt')
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1)
  })
})

describe('resuming inside and after a parallel section', () => {
  /** Run a tournament and stop it while every copy is busy. Returns the stored log. */
  async function interruptedMidSection(): Promise<{ runId: string; store: RunStore; started: RunEvent[] }> {
    const first = harness(new Fake((req) => abortable(req, 5_000, () => ok())), 'runs-a')
    const bp = tournament()
    const r = await first.engine.start(args(bp))
    if (!r.ok) throw new Error(r.error)
    for (let i = 0; i < 100 && first.events.filter((e) => e.type === 'node.started' && e.nodeId === 'contender').length < 3; i++) await sleep(20)
    await first.engine.suspendAll()
    expect(foldRun(first.events)!.status).toBe('interrupted')
    return { runId: r.runId, store: first.store, started: first.events }
  }

  it('an interrupted section runs again from its Fan-out, clearing the copies it left, and money carries over', async () => {
    const { runId, store, started } = await interruptedMidSection()
    const spentBefore = foldRun(started)!.spentUsd

    const bp = foldRun(started)!.blueprint
    const seed = planResume(started, bp, repo)
    expect(seed.node?.id).toBe('spread')
    expect(seed.abandoned.length).toBeGreaterThan(0)
    expect(seed.sessions.size).toBe(0) // nothing from inside the copies is reused

    const fake = new Fake((req) => {
      if (isJudge(req)) return ok({ structured: { winner: 1, reason: 'x' } })
      fs.writeFileSync(path.join(req.cwd, `again-${copyOf(req)}.txt`), 'x')
      return ok()
    })
    const second = harness(fake, 'runs-a')
    const res = await second.engine.resume(store.read(runId))
    if (!res.ok) throw new Error(res.error)
    await second.engine.whenDone(runId)

    const v = foldRun([...started, ...second.events])!
    expect(v.status).toBe('passed')
    expect(fake.reqs.filter((q) => !isJudge(q))).toHaveLength(3) // all three copies ran again
    expect(v.spentUsd).toBeGreaterThanOrEqual(spentBefore + 0.3)
    // Attempt numbers kept counting, so the new branches did not collide with the old ones.
    expect(branches()).toEqual([v.branch])
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1)
  })

  it('after the join, resume continues past it, in the winner\'s working copy', () => {
    // Build the log a run leaves after its join, then check where resume picks up.
    const bp = tournament()
    const at = 1
    const id = 'rrrrrrrr-0000-0000-0000-000000000000'
    const ev = (e: Partial<RunEvent> & { type: RunEvent['type'] }): RunEvent => ({ at, runId: id, ...e }) as RunEvent
    const wt = path.join(root, 'wt', 'rrrrrrrr-contender-c2-a2')
    const events: RunEvent[] = [
      ev({ type: 'node.started', nodeId: 'spread', attempt: 1, cwd: repo, copies: 3 }),
      ev({ type: 'node.started', nodeId: 'contender', attempt: 1, cwd: wt, branch: 'agentship/x-c1', sessionId: 's1', copy: 1, copies: 3 }),
      ev({ type: 'node.finished', nodeId: 'contender', attempt: 1, status: 'passed', costUsd: 0.1, tokens: 1, summary: 'a', branch: 'agentship/x-c1' }),
      ev({ type: 'node.started', nodeId: 'contender', attempt: 2, cwd: wt, branch: 'agentship/x-c2', sessionId: 's2', copy: 2, copies: 3 }),
      ev({ type: 'node.finished', nodeId: 'contender', attempt: 2, status: 'passed', costUsd: 0.1, tokens: 1, summary: 'b', branch: 'agentship/x-c2' }),
      ev({ type: 'node.finished', nodeId: 'spread', attempt: 1, status: 'passed', costUsd: 0, tokens: 0, summary: '2 of 3' }),
      ev({ type: 'node.started', nodeId: 'pick', attempt: 1, cwd: repo }),
      ev({ type: 'node.finished', nodeId: 'pick', attempt: 1, status: 'passed', costUsd: 0.05, tokens: 1, summary: 'Picked copy 2', branch: 'agentship/x-c2', cwd: wt })
    ]
    const s = planResume(events, bp, repo)
    expect(s.node).toBeUndefined() // the tournament in this test ends at the join
    expect(s.branch).toBe('agentship/x-c2')
    expect(s.cwd).toBe(wt)
    expect(s.worktrees.get('pick')).toEqual({ path: wt, branch: 'agentship/x-c2' })
    expect(s.spent).toBeCloseTo(0.25) // copies and the judge all counted
    expect(s.abandoned).toEqual([])
    expect(s.sessions.size).toBe(0)
  })
})

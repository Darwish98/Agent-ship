// Autopilot's pipeline, end to end against a real git repo with a fake agent:
// build -> test -> merge -> test the MERGED result (a failure goes back to the builder) -> land
// -> ask whether the plan is done. These tests exist because the first real
// project exposed that each stage verified something different, a gate could
// pass having run no tests, and nothing installed a dependency a branch added.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fromPattern, PATTERNS } from '../../shared/patterns'
import { foldRun, type RunEvent } from '../../shared/runs'
import type { Blueprint } from '../../shared/schema'
import type { AgentAdapter, StepRequest, StepResult } from './adapter'
import type { Installer } from './deps'
import { RunEngine } from './runner'

let root: string
let repo: string
const git = (...a: string[]): string => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim()
const onMain = (file: string): boolean => git('ls-tree', '-r', '--name-only', 'main').split('\n').includes(file)

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-test-'))
  repo = path.join(root, 'repo')
  fs.mkdirSync(path.join(repo, 'planning'), { recursive: true })
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 't')
  git('config', 'user.email', 't@t')
  git('config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(repo, 'planning', 'PLAN.md'), '1. Build the thing.\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }))

const ok = (over: Partial<StepResult> = {}): StepResult => ({
  ok: true, result: 'done', costUsd: 0.05, tokens: 100, sessionId: 's', budgetExhausted: false, timedOut: false, cancelled: false, ...over
})

class Fake implements AgentAdapter {
  reqs: StepRequest[] = []
  constructor(private readonly handler: (req: StepRequest) => StepResult) {}
  async run(req: StepRequest): Promise<StepResult> {
    this.reqs.push(req)
    return this.handler(req)
  }
}
const isPlanCheck = (r: StepRequest): boolean => r.jsonSchema.includes('"done"')
const isBuilder = (r: StepRequest): boolean => r.access === 'edit' && r.cwd.includes(`${path.sep}wt${path.sep}`) && !r.cwd.endsWith('-merge')

/** A gate command that passes, printing a test summary, when `file` exists in the directory it runs in. */
const needs = (file: string): string => `node -e "require('fs').existsSync('${file}')||process.exit(1);console.log('Tests  1 passed (1)')"`

function autopilot(testsCmd: string, verifyCmd = testsCmd): Blueprint {
  const bp = fromPattern(PATTERNS[4])
  for (const n of bp.nodes) {
    if (n.kind === 'gate' && n.id === 'tests') n.config.command = testsCmd
    if (n.kind === 'gate' && n.id === 'verify') n.config.command = verifyCmd
  }
  return bp
}

async function run(
  adapter: AgentAdapter,
  bp: Blueprint,
  install?: Installer
): Promise<{ events: RunEvent[]; v: NonNullable<ReturnType<typeof foldRun>> }> {
  const events: RunEvent[] = []
  const engine = new RunEngine({ adapter, worktreeRoot: path.join(root, 'wt'), depsRoot: path.join(root, 'deps'), install, emit: (e) => events.push(e) })
  const r = await engine.start({ projectId: 'p', projectName: 'repo', projectPath: repo, flowSlug: 'autopilot', blueprint: bp, inputs: { plan: 'planning/PLAN.md', base: 'main', test: 'npm test' } })
  if (!r.ok) throw new Error(r.error)
  await engine.whenDone(r.runId)
  return { events, v: foldRun(events)! }
}

const order = (events: RunEvent[]): string[] => events.filter((e) => e.type === 'node.started').map((e) => (e as { nodeId: string }).nodeId)

describe('autopilot pipeline', () => {
  it('builds, tests, merges, tests the MERGED result, lands, then asks whether the plan is done', async () => {
    const fake = new Fake((req) => {
      if (isPlanCheck(req)) return ok({ structured: { done: true, reason: 'all done' } })
      if (isBuilder(req)) fs.writeFileSync(path.join(req.cwd, 'built.txt'), 'x')
      return ok()
    })
    const { events, v } = await run(fake, autopilot(needs('built.txt')))
    expect(v.status).toBe('passed')
    expect(order(events)).toEqual(['build', 'tests', 'merge', 'verify', 'land', 'progress', 'plancheck'])
    expect(onMain('built.txt')).toBe(true)
    // The second test ran on the merge's scratch copy, not on the builder's branch.
    const verify = events.find((e) => e.type === 'node.started' && e.nodeId === 'verify') as { cwd?: string }
    expect(verify.cwd).toMatch(/-merge$/)
  })

  it('a gate that ran no tests is not a pass: the builder is sent back to write some', async () => {
    const noTests = `node -e "require('fs').existsSync('a.test.txt')?console.log('Tests  1 passed (1)'):console.log('No test files found, exiting with code 0')"`
    const fake = new Fake((req) => {
      if (isPlanCheck(req)) return ok({ structured: { done: true, reason: '' } })
      if (isBuilder(req)) fs.writeFileSync(path.join(req.cwd, req.resume ? 'a.test.txt' : 'built.txt'), 'x')
      return ok({ sessionId: req.sessionId })
    })
    const { events, v } = await run(fake, autopilot(noTests))
    expect(v.status).toBe('passed')
    const first = events.find((e) => e.type === 'gate.result' && e.nodeId === 'tests') as { pass: boolean; detail: string }
    expect(first.pass).toBe(false)
    expect(first.detail).toMatch(/NO TESTS RAN/)
    const repair = fake.reqs.filter(isBuilder)[1]
    expect(repair.resume).toBe(true)
    expect(repair.prompt).toMatch(/NO TESTS RAN/)
    expect(onMain('a.test.txt')).toBe(true)
  })

  it('a merged result that fails goes back to the builder, and only lands once it passes', async () => {
    const fake = new Fake((req) => {
      if (isPlanCheck(req)) return ok({ structured: { done: true, reason: '' } })
      if (isBuilder(req)) fs.writeFileSync(path.join(req.cwd, req.resume ? 'fixed.txt' : 'built.txt'), 'x')
      return ok({ sessionId: req.sessionId })
    })
    // The branch is fine on its own; the merged result needs a file only the builder's second go adds.
    const { events, v } = await run(fake, autopilot(needs('built.txt'), needs('fixed.txt')))
    expect(v.status).toBe('passed')
    expect(order(events)).toEqual(['build', 'tests', 'merge', 'verify', 'build', 'tests', 'merge', 'verify', 'land', 'progress', 'plancheck'])
    expect(fake.reqs.filter(isBuilder)[1].resume).toBe(true) // the same session fixes it
    expect(onMain('fixed.txt')).toBe(true)
  })

  it('never lands a merged result that stays red: main is left exactly as it was', async () => {
    const before = git('rev-parse', 'main')
    let n = 0
    const fake = new Fake((req) => {
      if (isBuilder(req)) fs.writeFileSync(path.join(req.cwd, req.resume ? `attempt-${++n}.txt` : 'built.txt'), 'x') // changes something, never the right thing
      return ok({ sessionId: req.sessionId })
    })
    const { v } = await run(fake, autopilot(needs('built.txt'), needs('never.txt')))
    expect(v.status).toBe('failed')
    expect(v.reason).toMatch(/Test the merged result/)
    expect(git('rev-parse', 'main')).toBe(before)
  })
})

describe('a builder that changes nothing when sent back', () => {
  const flag = (): string => path.join(root, 'flag').split(path.sep).join('/')
  /** Fails the first time it runs and passes after: an environmental flake. */
  const flaky = (): string => `node -e "const fs=require('fs');if(fs.existsSync('${flag()}')){console.log('Tests  1 passed (1)');process.exit(0)}fs.writeFileSync('${flag()}','x');process.exit(1)"`

  it('once is fine: an environmental failure is re-run and passes, and it lands', async () => {
    const fake = new Fake((req) => {
      if (isPlanCheck(req)) return ok({ structured: { done: true, reason: '' } })
      if (isBuilder(req) && !req.resume) fs.writeFileSync(path.join(req.cwd, 'built.txt'), 'x')
      return ok({ sessionId: req.sessionId, result: 'Nothing is wrong; it was a timeout.' }) // sent back, it edits nothing
    })
    const { events, v } = await run(fake, autopilot(needs('built.txt'), flaky()))
    expect(v.status).toBe('passed')
    expect(order(events)).toEqual(['build', 'tests', 'merge', 'verify', 'build', 'tests', 'merge', 'verify', 'land', 'progress', 'plancheck'])
  })

  it('twice in a row ends the run with what the agent said, instead of spending the remaining attempts', async () => {
    const fake = new Fake((req) => {
      if (isBuilder(req) && !req.resume) fs.writeFileSync(path.join(req.cwd, 'built.txt'), 'x')
      return ok({ sessionId: req.sessionId, result: 'I could not find anything to change.' })
    })
    const before = git('rev-parse', 'main')
    const { events, v } = await run(fake, autopilot(needs('built.txt'), needs('never.txt')))
    expect(v.status).toBe('failed')
    expect(v.reason).toMatch(/changed nothing 2 times in a row/)
    expect(v.reason).toMatch(/could not find anything to change/)
    expect(order(events).filter((n) => n === 'verify')).toHaveLength(2) // no third attempt
    expect(order(events).filter((n) => n === 'build')).toHaveLength(3)
    expect(git('rev-parse', 'main')).toBe(before)
  })

  it('a go that does change something resets the count', async () => {
    let resumes = 0
    const fake = new Fake((req) => {
      if (isPlanCheck(req)) return ok({ structured: { done: true, reason: '' } })
      if (isBuilder(req)) {
        if (!req.resume) fs.writeFileSync(path.join(req.cwd, 'built.txt'), 'x')
        else if (++resumes === 2) fs.writeFileSync(path.join(req.cwd, 'fixed.txt'), 'x') // idle, then a real fix
      }
      return ok({ sessionId: req.sessionId })
    })
    const { v } = await run(fake, autopilot(needs('built.txt'), needs('fixed.txt')))
    expect(v.status).toBe('passed')
    expect(resumes).toBe(2)
  })
})

describe('dependencies a branch adds', () => {
  /** npm stand-in: "installs" every declared package as a module that exports 1. */
  const installer = (calls: string[]): Installer => async (dir) => {
    calls.push(dir)
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    for (const name of Object.keys(m.dependencies ?? {})) {
      fs.mkdirSync(path.join(dir, 'node_modules', name), { recursive: true })
      fs.writeFileSync(path.join(dir, 'node_modules', name, 'package.json'), '{"main":"index.js"}')
      fs.writeFileSync(path.join(dir, 'node_modules', name, 'index.js'), 'module.exports = 1\n')
    }
    return { ok: true }
  }
  const usesDep = `node -e "require('fakepkg');console.log('Tests  1 passed (1)')"`

  it('installs from the branch manifest for the tests and for the merged result, once, and commits no node_modules', async () => {
    // The reported failure: the builder imports a package nothing ever installed.
    const calls: string[] = []
    const fake = new Fake((req) => {
      if (isPlanCheck(req)) return ok({ structured: { done: true, reason: '' } })
      if (isBuilder(req)) fs.writeFileSync(path.join(req.cwd, 'package.json'), JSON.stringify({ name: 'x', dependencies: { fakepkg: '1' } }))
      return ok()
    })
    const { events, v } = await run(fake, autopilot(usesDep), installer(calls))
    expect(v.status).toBe('passed')
    expect(calls).toHaveLength(1) // same manifest in the worktree and the merged copy
    expect(order(events)).toEqual(['build', 'tests', 'merge', 'verify', 'land', 'progress', 'plancheck'])
    expect(onMain('package.json')).toBe(true)
    expect(git('ls-tree', '-r', '--name-only', 'main')).not.toContain('node_modules')
  })

  it('survives the loop going round again: the second pass recreates the merge copy without touching the installed packages', async () => {
    // Reported: EPERM on "<run>-merge" at the start of the second pass.
    const calls: string[] = []
    let checks = 0
    const fake = new Fake((req) => {
      if (isPlanCheck(req)) return ok({ structured: { done: ++checks >= 2, reason: 'not yet' } })
      if (isBuilder(req)) {
        fs.writeFileSync(path.join(req.cwd, 'package.json'), JSON.stringify({ name: 'x', dependencies: { fakepkg: '1' } }))
        fs.writeFileSync(path.join(req.cwd, `item-${req.cwd.length}-${fake.reqs.length}.txt`), 'x')
      }
      return ok({ sessionId: req.sessionId })
    })
    const { events, v } = await run(fake, autopilot(usesDep), installer(calls))
    expect(v.status).toBe('passed')
    expect(order(events).filter((n) => n === 'merge')).toHaveLength(2)
    expect(order(events).filter((n) => n === 'land')).toHaveLength(2)
    expect(calls).toHaveLength(1) // installed once, still intact for the second pass
  })

  it('an import the manifest never declared is named as the cause, and the builder is told to declare it', async () => {
    // The reported failure, exactly: code imports `three`, package.json does not list it.
    const fake = new Fake((req) => {
      if (isPlanCheck(req)) return ok({ structured: { done: true, reason: '' } })
      if (isBuilder(req)) {
        fs.writeFileSync(path.join(req.cwd, 'package.json'), JSON.stringify({ name: 'x', dependencies: {} }))
        if (req.resume) fs.writeFileSync(path.join(req.cwd, 'package.json'), JSON.stringify({ name: 'x', dependencies: { fakepkg: '1' } }))
      }
      return ok({ sessionId: req.sessionId })
    })
    const missing = `node -e "try{require('fakepkg')}catch(e){console.log(\\"Error: Cannot find package 'fakepkg' imported from x\\");process.exit(1)}console.log('Tests  1 passed (1)')"`
    const { events, v } = await run(fake, autopilot(missing), installer([]))
    expect(v.status).toBe('passed')
    const first = events.find((e) => e.type === 'gate.result' && e.nodeId === 'tests') as { pass: boolean; detail: string }
    expect(first.pass).toBe(false)
    expect(first.detail).toMatch(/"fakepkg" is imported but not declared in package\.json/)
    expect(fake.reqs.filter(isBuilder)[1].prompt).toMatch(/Add it to "dependencies"/)
  })

  it('a dependency that cannot be installed fails the gate with the install output, so the builder can fix the manifest', async () => {
    const bad: Installer = async () => ({ ok: false, output: 'npm error 404 Not Found - fakepkg' })
    const fake = new Fake((req) => {
      if (isBuilder(req)) fs.writeFileSync(path.join(req.cwd, 'package.json'), JSON.stringify({ name: 'x', dependencies: { fakepkg: '1' } }))
      return ok({ sessionId: req.sessionId })
    })
    const bp = autopilot(usesDep)
    for (const n of bp.nodes) if (n.kind === 'gate' && n.id === 'tests') n.budget = { maxRetries: 0 }
    const { events, v } = await run(fake, bp, bad)
    expect(v.status).toBe('failed')
    const g = events.find((e) => e.type === 'gate.result') as { detail: string }
    expect(g.detail).toMatch(/Installing the project's dependencies failed/)
    expect(g.detail).toMatch(/404 Not Found/)
  })
})

describe('one builder session goes item after item, and progress is counted from the plan', () => {
  const tick = (cwd: string): void => {
    const file = path.join(cwd, 'planning', 'PLAN.md')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('- [ ]', '- [x]'))
  }
  const threeItems = (): void => {
    fs.writeFileSync(path.join(repo, 'planning', 'PLAN.md'), '- [ ] 1. **One.**\n- [ ] 2. **Two.**\n- [ ] 3. **Three.**\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'plan with tick-boxes')
  }
  const counter = (): string => path.join(root, 'ran').split(path.sep).join('/')
  /** Counts how many times it actually runs, and prints a passing test summary. */
  const counting = (): string => `node -e "require('fs').appendFileSync('${counter()}','x');console.log('Tests  1 passed (1)')"`

  /** The shipped builder, with the session knobs turned. */
  const tuned = (bp: Blueprint, patch: Record<string, unknown>): Blueprint => {
    for (const n of bp.nodes) if (n.kind === 'agent' && n.id === 'build') Object.assign(n.config, patch)
    return bp
  }
  /** A builder that completes one item per call, as models do, and writes a file for it. */
  const onePerCall = (extra?: (req: StepRequest) => Partial<StepResult>): Fake => {
    const fake: Fake = new Fake((req) => {
      if (isPlanCheck(req)) return ok({ structured: { done: true, reason: 'verified' } })
      if (isBuilder(req)) {
        tick(req.cwd)
        fs.writeFileSync(path.join(req.cwd, `item-${fake.reqs.length}.txt`), 'x')
      }
      return ok({ sessionId: req.sessionId, ...(extra ? extra(req) : {}) })
    })
    return fake
  }

  it('does the whole plan in ONE builder step: the engine asks the same session for the next item, and the agent is asked once, at the end', async () => {
    threeItems()
    const fake = onePerCall()
    const { events, v } = await run(fake, autopilot(counting()))
    expect(v.status).toBe('passed')
    expect(order(events).filter((n) => n === 'build')).toHaveLength(1) // one step, three rounds
    expect(order(events).filter((n) => n === 'land')).toHaveLength(1) // one merge and landing for the lot
    expect(order(events).filter((n) => n === 'progress')).toHaveLength(1)
    expect(fake.reqs.filter(isPlanCheck)).toHaveLength(1) // not one per item
    const calls = fake.reqs.filter(isBuilder)
    expect(calls.map((c) => c.resume)).toEqual([false, true, true]) // the same session, kept warm
    expect(new Set(calls.map((c) => c.sessionId)).size).toBe(1)
    expect(calls[1].prompt).toMatch(/Continue with the next item that is not ticked yet: 2\. \*\*Two\.\*\*/)
    expect(calls[2].prompt).toMatch(/3\. \*\*Three\.\*\*/)
    expect(fs.readFileSync(path.join(repo, 'planning', 'PLAN.md'), 'utf8')).not.toContain('- [ ]')
    const built = events.find((e) => e.type === 'node.finished' && e.nodeId === 'build') as { summary: string; costUsd: number }
    expect(built.summary).toMatch(/One session, 3 rounds, 3 plan items completed/)
    expect(built.costUsd).toBeCloseTo(0.15) // every round counted
  })

  it('ends the session once its context has grown (rotation), and the next pass starts a fresh one with what is left', async () => {
    threeItems()
    const fake = onePerCall()
    // Each fake call bills 100 tokens; rotating at 150 ends the session after two rounds.
    const { events, v } = await run(fake, tuned(autopilot(counting()), { rotateTokens: 150 }))
    expect(v.status).toBe('passed')
    expect(order(events).filter((n) => n === 'build')).toHaveLength(2) // 2 items, then 1 item in a fresh session
    const calls = fake.reqs.filter(isBuilder)
    expect(calls.map((c) => c.resume)).toEqual([false, true, false])
    expect(calls[2].sessionId).not.toBe(calls[0].sessionId)
    expect(calls[2].prompt).toMatch(/2 of 3 items.*are ticked/) // told what is left
    const results = events.filter((e) => e.type === 'gate.result' && e.nodeId === 'progress') as { pass: boolean }[]
    expect(results.map((r) => r.pass)).toEqual([false, true])
  })

  it('stops going on when a round completes nothing: the step ends and the next pass starts clean', async () => {
    threeItems()
    let calls = 0
    const fake = new Fake((req) => {
      if (isPlanCheck(req)) return ok({ structured: { done: true, reason: '' } })
      if (isBuilder(req)) {
        calls++
        if (calls === 1) tick(req.cwd) // one item, then it has nothing more to give
        fs.writeFileSync(path.join(req.cwd, `item-${calls}.txt`), 'x')
      }
      return ok({ sessionId: req.sessionId })
    })
    await run(fake, autopilot(counting()))
    // call 1 ticks; call 2 (the continuation) ticks nothing, so the step ends there, not after eight rounds.
    expect(fake.reqs.filter(isBuilder).slice(0, 2).map((c) => c.resume)).toEqual([false, true])
    expect(fake.reqs.filter(isBuilder)[2]?.resume).toBe(false) // the pass after that is a fresh session
  })

  it('stops after the item limit for one session', async () => {
    threeItems()
    const fake = onePerCall()
    const { events, v } = await run(fake, tuned(autopilot(counting()), { maxRounds: 2 }))
    expect(v.status).toBe('passed')
    expect(fake.reqs.filter(isBuilder).map((c) => c.resume)).toEqual([false, true, false]) // two items, then a fresh session for the third
    expect(order(events).filter((n) => n === 'build')).toHaveLength(2)
  })

  it('stays inside the step\'s own dollar cap while it goes on', async () => {
    threeItems()
    const fake = onePerCall(() => ({ costUsd: 0.4 }))
    const bp = tuned(autopilot(counting()), {})
    for (const n of bp.nodes) if (n.id === 'build') n.budget = { ...n.budget, maxUsd: 0.5 }
    const { events } = await run(fake, bp)
    const first = events.find((e) => e.type === 'node.finished' && e.nodeId === 'build') as { costUsd: number }
    expect(first.costUsd).toBeLessThanOrEqual(0.9) // 0.4, then at most what was left of 0.5 - never three full rounds in one step
    expect(fake.reqs.filter(isBuilder)[1].maxUsd).toBeLessThanOrEqual(0.1 + 1e-9)
  })

  it('shows what the CLI refused, and tells the agent how to run commands so they are not refused again', async () => {
    threeItems()
    let n = 0
    const fake = onePerCall(() => (++n === 1 ? { denials: ['Bash: cd app && npm test'] } : {}))
    const { events } = await run(fake, autopilot(counting()))
    expect(fake.reqs.filter(isBuilder)[1].prompt).toMatch(/refused earlier: Bash: cd app && npm test/)
    expect(fake.reqs.filter(isBuilder)[1].prompt).toMatch(/no `cd`, pipes/)
    const built = events.find((e) => e.type === 'node.finished' && e.nodeId === 'build') as { summary: string }
    expect(built.summary).toMatch(/Commands the CLI refused: Bash: cd app && npm test/)
  })

  it('a session that completes nothing, twice running, ends the run instead of spending money going nowhere', async () => {
    threeItems()
    const fake = new Fake((req) => {
      if (isBuilder(req)) fs.writeFileSync(path.join(req.cwd, `item-${fake.reqs.length}.txt`), 'x') // works, ticks nothing
      return ok({ sessionId: req.sessionId })
    })
    const { events, v } = await run(fake, autopilot(counting()))
    expect(v.status).toBe('failed')
    expect(v.reason).toMatch(/No plan item was completed in the last 2 sessions/)
    expect(order(events).filter((n) => n === 'build')).toHaveLength(3) // never close to the 40-pass cap
  })

  it('a failed TEST still resumes the same session: that is a repair, not the next item', async () => {
    const fake = new Fake((req) => {
      if (isPlanCheck(req)) return ok({ structured: { done: true, reason: '' } })
      if (isBuilder(req) && req.resume) fs.writeFileSync(path.join(req.cwd, 'built.txt'), 'x')
      return ok({ sessionId: req.sessionId })
    })
    const { v } = await run(fake, autopilot(needs('built.txt')))
    expect(v.status).toBe('passed')
    expect(fake.reqs.filter(isBuilder).map((b) => b.resume)).toEqual([false, true])
  })

  it('the merged result is not tested again when it is exactly the tree that just passed', async () => {
    const fake = new Fake((req) => {
      if (isPlanCheck(req)) return ok({ structured: { done: true, reason: '' } })
      if (isBuilder(req)) fs.writeFileSync(path.join(req.cwd, 'built.txt'), 'x')
      return ok()
    })
    const { events, v } = await run(fake, autopilot(counting()))
    expect(v.status).toBe('passed')
    expect(fs.readFileSync(counter(), 'utf8')).toBe('x') // ran once, not twice
    const verify = events.find((e) => e.type === 'gate.result' && e.nodeId === 'verify') as { pass: boolean; detail: string }
    expect(verify.pass).toBe(true)
    expect(verify.detail).toMatch(/Skipped: this exact tree already passed/)
  })

  it('but a merged result that differs from what was tested IS tested, and a fix is tested after it changes the tree', async () => {
    const fake = new Fake((req) => {
      if (isPlanCheck(req)) return ok({ structured: { done: true, reason: '' } })
      if (isBuilder(req)) fs.writeFileSync(path.join(req.cwd, req.resume ? 'fixed.txt' : 'built.txt'), 'x')
      return ok({ sessionId: req.sessionId })
    })
    const { events, v } = await run(fake, autopilot(needs('built.txt'), needs('fixed.txt')))
    expect(v.status).toBe('passed')
    const verifies = events.filter((e) => e.type === 'gate.result' && e.nodeId === 'verify') as { pass: boolean; detail: string }[]
    expect(verifies.map((x) => x.pass)).toEqual([false, true])
    expect(verifies[1].detail).not.toMatch(/Skipped/)
  })

  it('a plan with no tick-boxes falls back to asking the agent each pass', async () => {
    let audits = 0
    const fake = new Fake((req) => {
      if (isPlanCheck(req)) return ok({ structured: { done: ++audits >= 2, reason: 'not yet' } })
      if (isBuilder(req)) fs.writeFileSync(path.join(req.cwd, `item-${fake.reqs.length}.txt`), 'x')
      return ok({ sessionId: req.sessionId })
    })
    const { v } = await run(fake, autopilot(needs('item-2.txt').replace('item-2.txt', 'planning/PLAN.md')))
    expect(v.status).toBe('passed')
    expect(audits).toBe(2)
  })

  it('a builder that changes nothing two passes in a row ends the run, instead of going round again forever', async () => {
    // Found by a real run: the builder left an item unticked, did nothing on four more passes, and the
    // plan-check kept saying "not done" each time (about $0.25 wasted).
    let audits = 0
    const fake = new Fake((req) => {
      if (isPlanCheck(req)) {
        audits++
        return ok({ structured: { done: false, reason: 'item 3 is not ticked' } })
      }
      if (isBuilder(req) && fake.reqs.filter(isBuilder).length === 1) fs.writeFileSync(path.join(req.cwd, 'built.txt'), 'x') // only the first pass does anything
      return ok({ sessionId: req.sessionId, result: 'I could not run the tests, so I left it.' })
    })
    const bp = autopilot(counting())
    const { events, v } = await run(fake, bp)
    expect(v.status).toBe('failed')
    expect(v.reason).toMatch(/changed nothing 2 times in a row, so this is not making progress/)
    expect(v.reason).toMatch(/could not run the tests/)
    expect(order(events).filter((n) => n === 'build')).toHaveLength(3) // one real pass, two idle ones
    expect(audits).toBe(2)
  })

  it('landing something new counts as progress and resets the idle count', async () => {
    let builds = 0
    let audits = 0
    const fake = new Fake((req) => {
      if (isPlanCheck(req)) return ok({ structured: { done: ++audits >= 4, reason: 'more' } })
      if (isBuilder(req)) {
        builds++
        // idle, real, idle, real: never two idle in a row
        if (builds % 2 === 0) fs.writeFileSync(path.join(req.cwd, `item-${builds}.txt`), 'x')
      }
      return ok({ sessionId: req.sessionId })
    })
    const { v } = await run(fake, autopilot(counting()))
    expect(v.status).toBe('passed')
    expect(builds).toBe(4)
  })

  it('stops with a clear reason when the plan is still unfinished at the pass cap', async () => {
    threeItems()
    const fake = onePerCall()
    const bp = tuned(autopilot(counting()), { maxRounds: 1 }) // one item per session, so passes are what run out
    for (const n of bp.nodes) if (n.id === 'progress') n.budget = { maxRetries: 1 }
    const { v } = await run(fake, bp)
    expect(v.status).toBe('failed')
    expect(v.reason).toMatch(/Stopped after 2 passes with the plan unfinished \(the cap is 1\)/)
    expect(v.reason).toMatch(/2 of 3 items/)
  })
})

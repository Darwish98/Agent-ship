// Autopilot's pipeline, end to end against a real git repo with a fake agent:
// build -> test -> merge -> test the MERGED result (repaired if it fails) -> land
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
const isRepair = (r: StepRequest): boolean => r.access === 'edit' && r.cwd.endsWith('-merge')

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
  const r = await engine.start({ projectId: 'p', projectName: 'repo', projectPath: repo, flowSlug: 'autopilot', blueprint: bp, inputs: { plan: 'planning/PLAN.md' } })
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
    expect(order(events)).toEqual(['build', 'tests', 'merge', 'verify', 'land', 'plancheck'])
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

  it('a merged result that fails is repaired in the scratch copy before main moves', async () => {
    const fake = new Fake((req) => {
      if (isPlanCheck(req)) return ok({ structured: { done: true, reason: '' } })
      if (isBuilder(req)) fs.writeFileSync(path.join(req.cwd, 'built.txt'), 'x')
      if (isRepair(req)) fs.writeFileSync(path.join(req.cwd, 'fixed.txt'), 'x')
      return ok()
    })
    // The branch is fine on its own; the merged result needs a file only the repair adds.
    const { events, v } = await run(fake, autopilot(needs('built.txt'), needs('fixed.txt')))
    expect(v.status).toBe('passed')
    expect(order(events)).toEqual(['build', 'tests', 'merge', 'verify', 'repair', 'verify', 'land', 'plancheck'])
    expect(onMain('fixed.txt')).toBe(true)
  })

  it('never lands a merged result that stays red: main is left exactly as it was', async () => {
    const before = git('rev-parse', 'main')
    let n = 0
    const fake = new Fake((req) => {
      if (isBuilder(req)) fs.writeFileSync(path.join(req.cwd, 'built.txt'), 'x')
      if (isRepair(req)) fs.writeFileSync(path.join(req.cwd, `attempt-${++n}.txt`), 'x') // changes something, never the right thing
      return ok()
    })
    const { v } = await run(fake, autopilot(needs('built.txt'), needs('never.txt')))
    expect(v.status).toBe('failed')
    expect(v.reason).toMatch(/Test the merged result/)
    expect(git('rev-parse', 'main')).toBe(before)
  })
})

describe('a repair that changes nothing', () => {
  const flag = (): string => path.join(root, 'flag').split(path.sep).join('/')
  /** Fails the first time it runs and passes after: an environmental flake. */
  const flaky = (): string => `node -e "const fs=require('fs');if(fs.existsSync('${flag()}')){console.log('Tests  1 passed (1)');process.exit(0)}fs.writeFileSync('${flag()}','x');process.exit(1)"`

  it('once is fine: an environmental failure is re-run and passes, and it lands', async () => {
    const fake = new Fake((req) => {
      if (isPlanCheck(req)) return ok({ structured: { done: true, reason: '' } })
      if (isBuilder(req)) fs.writeFileSync(path.join(req.cwd, 'built.txt'), 'x')
      return ok({ result: 'Nothing is wrong; it was a timeout.' }) // the repair edits nothing
    })
    const { events, v } = await run(fake, autopilot(needs('built.txt'), flaky()))
    expect(v.status).toBe('passed')
    expect(order(events)).toEqual(['build', 'tests', 'merge', 'verify', 'repair', 'verify', 'land', 'plancheck'])
  })

  it('twice in a row ends the run with what the agent said, instead of spending the remaining attempts', async () => {
    const fake = new Fake((req) => {
      if (isBuilder(req)) fs.writeFileSync(path.join(req.cwd, 'built.txt'), 'x')
      return ok({ result: 'I could not find anything to change.' })
    })
    const before = git('rev-parse', 'main')
    const { events, v } = await run(fake, autopilot(needs('built.txt'), needs('never.txt')))
    expect(v.status).toBe('failed')
    expect(v.reason).toMatch(/changed nothing 2 times in a row/)
    expect(v.reason).toMatch(/could not find anything to change/)
    // verify, repair, verify, repair - and no third verify.
    expect(order(events).filter((n) => n === 'verify')).toHaveLength(2)
    expect(order(events).filter((n) => n === 'repair')).toHaveLength(2)
    expect(git('rev-parse', 'main')).toBe(before)
  })

  it('a repair that does change something resets the count', async () => {
    let repairs = 0
    const fake = new Fake((req) => {
      if (isPlanCheck(req)) return ok({ structured: { done: true, reason: '' } })
      if (isBuilder(req)) fs.writeFileSync(path.join(req.cwd, 'built.txt'), 'x')
      if (isRepair(req) && ++repairs === 2) fs.writeFileSync(path.join(req.cwd, 'fixed.txt'), 'x') // idle, then a real fix
      return ok()
    })
    const { v } = await run(fake, autopilot(needs('built.txt'), needs('fixed.txt')))
    expect(v.status).toBe('passed')
    expect(repairs).toBe(2)
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
    expect(order(events)).toEqual(['build', 'tests', 'merge', 'verify', 'land', 'plancheck'])
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

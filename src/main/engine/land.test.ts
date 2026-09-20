import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildLandBlueprint, fromPattern, PATTERNS } from '../../shared/patterns'
import { foldRun, type RunEvent, type RunView } from '../../shared/runs'
import type { AgentAdapter, StepRequest, StepResult } from './adapter'
import { RunEngine } from './runner'

let root: string
let repo: string

const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
const write = (rel: string, text: string, dir = repo): void => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), text)
}
const commitAll = (msg: string): void => {
  git('add', '-A')
  git('commit', '-q', '-m', msg)
}
const has = (ref: string, file: string): boolean => git('ls-tree', '-r', '--name-only', ref).split('\n').includes(file)

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'land-test-'))
  repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 't')
  git('config', 'user.email', 't@t')
  git('config', 'core.autocrlf', 'false')
  write('README.md', 'line one\nline two\n')
  commitAll('init')
  // A finished feature branch that adds one file.
  git('checkout', '-q', '-b', 'feat/x')
  write('feat.txt', 'feature\n')
  commitAll('add feature')
  git('checkout', '-q', 'main')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const ok = (over: Partial<StepResult> = {}): StepResult => ({
  ok: true, result: '', costUsd: 0, tokens: 0, sessionId: 's', budgetExhausted: false, timedOut: false, cancelled: false, ...over
})

class Fake implements AgentAdapter {
  reqs: StepRequest[] = []
  constructor(private readonly h: (r: StepRequest) => StepResult = () => ok()) {}
  async run(r: StepRequest): Promise<StepResult> {
    this.reqs.push(r)
    return this.h(r)
  }
}

const exists = (f: string): string => `node -e "process.exit(require('fs').existsSync('${f}')?0:1)"`

async function land(opts: { test?: string; resolve?: boolean; adapter?: AgentAdapter; branch?: string } = {}): Promise<{ v: RunView; events: RunEvent[]; adapter: Fake }> {
  const events: RunEvent[] = []
  const adapter = (opts.adapter as Fake) ?? new Fake()
  const engine = new RunEngine({ adapter, worktreeRoot: path.join(root, 'wt'), emit: (e) => events.push(e) })
  const branch = opts.branch ?? 'feat/x'
  const bp = buildLandBlueprint({ branch, base: 'main', testCommand: opts.test ?? exists('feat.txt'), resolveConflicts: opts.resolve ?? true, maxUsd: 1 })
  const r = await engine.start({ projectId: 'p', projectName: 'repo', projectPath: repo, flowSlug: '__land__', blueprint: bp, inputs: { branch } })
  if (!r.ok) throw new Error(r.error)
  await engine.whenDone(r.runId)
  return { v: foldRun(events)!, events, adapter }
}

const worktreeCount = (): number => git('worktree', 'list').split('\n').length

describe('landing a branch', () => {
  it('tests it, merges it in a scratch copy, tests the merge, then moves main (checked out, clean)', async () => {
    const { v } = await land()
    expect(v.status).toBe('passed')
    expect(Object.fromEntries(Object.entries(v.nodes).map(([k, n]) => [k, n.state]))).toEqual({
      start: 'idle', test: 'passed', merge: 'passed', verify: 'passed', land: 'passed'
    })
    // main moved, with a real merge commit, and the files on disk moved with it.
    expect(has('main', 'feat.txt')).toBe(true)
    expect(git('rev-list', '--parents', '-n', '1', 'main').split(' ')).toHaveLength(3)
    expect(fs.existsSync(path.join(repo, 'feat.txt'))).toBe(true)
    expect(git('status', '--porcelain')).toBe('')
    // Nothing is left behind, and the source branch is kept.
    expect(worktreeCount()).toBe(1)
    expect(git('branch', '--list', 'feat/x')).toContain('feat/x')
  })

  it('moves main without touching your files when main is not the checked-out branch', async () => {
    git('checkout', '-q', '-b', 'dev')
    write('wip.txt', 'work in progress\n') // untracked, and must survive
    const { v } = await land()
    expect(v.status).toBe('passed')
    expect(has('main', 'feat.txt')).toBe(true)
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('dev')
    expect(fs.existsSync(path.join(repo, 'wip.txt'))).toBe(true)
    expect(fs.existsSync(path.join(repo, 'feat.txt'))).toBe(false)
  })

  it('leaves main exactly where it was when the branch fails its tests', async () => {
    const before = git('rev-parse', 'main')
    const { v } = await land({ test: exists('does-not-exist.txt') })
    expect(v.status).toBe('failed')
    expect(v.nodes.test.state).toBe('failed')
    expect(v.nodes.merge.state).toBe('idle') // never got as far as merging
    expect(git('rev-parse', 'main')).toBe(before)
    expect(worktreeCount()).toBe(1)
  })

  it('does not land when the branch passes alone but the MERGED result fails (revert-on-red)', async () => {
    // main gained a file the branch has never seen. Branch alone: fine. Merged: both present: fail.
    write('base-only.txt', 'x\n')
    commitAll('main moves on')
    const before = git('rev-parse', 'main')
    const test = `node -e "const f=require('fs');process.exit(f.existsSync('feat.txt')&&f.existsSync('base-only.txt')?1:0)"`
    const { v } = await land({ test })
    expect(v.nodes.test.state).toBe('passed')
    expect(v.nodes.merge.state).toBe('passed')
    expect(v.nodes.verify.state).toBe('failed')
    expect(v.status).toBe('failed')
    expect(v.nodes.land.state).toBe('idle')
    expect(git('rev-parse', 'main')).toBe(before)
  })

  it('refuses when your checkout of main has uncommitted changes, and changes nothing', async () => {
    const before = git('rev-parse', 'main')
    write('README.md', 'line one\nMY UNSAVED EDIT\n')
    const { v } = await land()
    expect(v.status).toBe('failed')
    expect(v.reason).toMatch(/uncommitted changes/)
    expect(git('rev-parse', 'main')).toBe(before)
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toContain('MY UNSAVED EDIT')
  })

  it('leaves main alone if it moved while the tests were running', async () => {
    const before = git('rev-parse', 'main')
    // The "test" of the merged result also commits to main behind the run's back.
    const dir = repo.replace(/\\/g, '/')
    const sneaky = `node -e "require('child_process').execFileSync('git',['-C','${dir}','commit','--allow-empty','-q','-m','moved'])"`
    const events: RunEvent[] = []
    const engine = new RunEngine({ adapter: new Fake(), worktreeRoot: path.join(root, 'wt'), emit: (e) => events.push(e) })
    const bp = buildLandBlueprint({ branch: 'feat/x', base: 'main', testCommand: sneaky, resolveConflicts: false })
    const r = await engine.start({ projectId: 'p', projectName: 'repo', projectPath: repo, flowSlug: '__land__', blueprint: bp, inputs: { branch: 'feat/x' } })
    if (!r.ok) throw new Error(r.error)
    await engine.whenDone(r.runId)
    const v = foldRun(events)!
    expect(v.status).toBe('failed')
    expect(v.reason).toMatch(/moved while this was landing/)
    expect(git('log', '-1', '--format=%s', 'main')).toBe('moved')
    expect(has('main', 'feat.txt')).toBe(false)
    expect(before).not.toBe(git('rev-parse', 'main'))
  })

  it('lands without tests when none are configured, and says so in the plan (no test steps)', async () => {
    const events: RunEvent[] = []
    const engine = new RunEngine({ adapter: new Fake(), worktreeRoot: path.join(root, 'wt'), emit: (e) => events.push(e) })
    const bp = buildLandBlueprint({ branch: 'feat/x', base: 'main', testCommand: '', resolveConflicts: false })
    expect(bp.nodes.map((n) => n.id)).toEqual(['start', 'merge', 'land'])
    const r = await engine.start({ projectId: 'p', projectName: 'repo', projectPath: repo, flowSlug: '__land__', blueprint: bp, inputs: { branch: 'feat/x' } })
    if (!r.ok) throw new Error(r.error)
    await engine.whenDone(r.runId)
    expect(foldRun(events)!.status).toBe('passed')
    expect(has('main', 'feat.txt')).toBe(true)
  })
})

describe('conflicts', () => {
  beforeEach(() => {
    // Both sides edit the same line.
    git('checkout', '-q', 'feat/x')
    write('README.md', 'line one\nFEATURE line two\n')
    commitAll('feature edits readme')
    git('checkout', '-q', 'main')
    write('README.md', 'line one\nMAIN line two\n')
    commitAll('main edits readme')
  })

  it('without the resolver: fails, names the file, changes nothing, cleans up', async () => {
    const before = git('rev-parse', 'main')
    const { v } = await land({ resolve: false })
    expect(v.status).toBe('failed')
    expect(v.reason).toMatch(/conflicts with main in: README\.md/)
    expect(git('rev-parse', 'main')).toBe(before)
    expect(worktreeCount()).toBe(1)
  })

  it('with the resolver: an agent fixes only the files, the engine finishes the merge, tests run on the result', async () => {
    const fake = new Fake((req) => {
      // A well-behaved resolver: writes the merged text and stages it. Never commits.
      fs.writeFileSync(path.join(req.cwd, 'README.md'), 'line one\nMAIN and FEATURE line two\n')
      execFileSync('git', ['add', 'README.md'], { cwd: req.cwd })
      return ok({ costUsd: 0.04, tokens: 500 })
    })
    const { v, adapter } = await land({ adapter: fake, test: exists('feat.txt') })
    expect(v.status).toBe('passed')
    expect(git('show', 'main:README.md')).toContain('MAIN and FEATURE')
    expect(v.nodes.merge.detail).toMatch(/an agent resolved 1 conflicted file: README\.md/)
    expect(v.spentUsd).toBeCloseTo(0.04)
    // The agent was scoped: edit access in the scratch copy, no commit/push/checkout allowed.
    const req = adapter.reqs[0]
    expect(req.access).toBe('edit')
    expect(req.cwd).toContain('wt')
    expect(req.tools.join(' ')).not.toMatch(/commit|push|checkout|reset/)
    expect(req.prompt).toContain('README.md')
    expect(worktreeCount()).toBe(1)
  })

  it('rejects a resolver that leaves conflict markers behind, and changes nothing', async () => {
    const before = git('rev-parse', 'main')
    const fake = new Fake((req) => {
      // Stages a file that still has markers.
      execFileSync('git', ['add', 'README.md'], { cwd: req.cwd })
      return ok({ costUsd: 0.01 })
    })
    const { v } = await land({ adapter: fake })
    expect(v.status).toBe('failed')
    expect(v.reason).toMatch(/could not fully resolve/)
    expect(git('rev-parse', 'main')).toBe(before)
  })

  it('a failed resolver call aborts the merge and leaves main alone', async () => {
    const before = git('rev-parse', 'main')
    const { v } = await land({ adapter: new Fake(() => ok({ ok: false, error: 'boom' })) })
    expect(v.status).toBe('failed')
    expect(git('rev-parse', 'main')).toBe(before)
    expect(worktreeCount()).toBe(1)
  })
})

describe('preflight', () => {
  it('refuses a branch that does not exist, before anything is created', async () => {
    const engine = new RunEngine({ adapter: new Fake(), worktreeRoot: path.join(root, 'wt'), emit: () => undefined })
    const bp = buildLandBlueprint({ branch: 'nope', base: 'main', testCommand: '', resolveConflicts: false })
    const r = await engine.start({ projectId: 'p', projectName: 'repo', projectPath: repo, flowSlug: '__land__', blueprint: bp, inputs: { branch: 'nope' } })
    expect(r.ok).toBe(false)
    expect(worktreeCount()).toBe(1)
  })

  it('refuses a merge flow with no branch input', async () => {
    const engine = new RunEngine({ adapter: new Fake(), worktreeRoot: path.join(root, 'wt'), emit: () => undefined })
    const bp = fromPattern(PATTERNS[1])
    const r = await engine.start({ projectId: 'p', projectName: 'repo', projectPath: repo, flowSlug: 'x', blueprint: bp, inputs: {} })
    expect(r.ok).toBe(false)
  })
})

describe('project dependencies in scratch copies', () => {
  it('links node_modules so tests can run, and removing the copy never deletes the real ones', async () => {
    write('node_modules/dep/index.js', 'module.exports = 1\n')
    // node_modules is untracked in this repo, exactly as in a normal project.
    const { v } = await land({ test: exists('node_modules/dep/index.js') })
    expect(v.status).toBe('passed') // the test could see the dependency
    expect(fs.existsSync(path.join(repo, 'node_modules', 'dep', 'index.js'))).toBe(true) // and it is still there
    expect(has('main', 'node_modules')).toBe(false)
    expect(worktreeCount()).toBe(1)
  })

  it('never commits the linked dependencies into an agent branch', async () => {
    write('node_modules/dep/index.js', 'module.exports = 1\n')
    const events: RunEvent[] = []
    const fake = new Fake((req) => {
      if (req.access === 'edit') fs.writeFileSync(path.join(req.cwd, 'made.txt'), 'x')
      return ok()
    })
    const engine = new RunEngine({ adapter: fake, worktreeRoot: path.join(root, 'wt'), emit: (e) => events.push(e) })
    const bp = fromPattern(PATTERNS[2])
    const gate = bp.nodes.find((n) => n.id === 'tests')!
    if (gate.kind === 'gate') gate.config.command = exists('made.txt')
    const r = await engine.start({ projectId: 'p', projectName: 'repo', projectPath: repo, flowSlug: 'f', blueprint: bp, inputs: { task: 't' } })
    if (!r.ok) throw new Error(r.error)
    await engine.whenDone(r.runId)
    const v = foldRun(events)!
    expect(v.status).toBe('passed')
    expect(has(v.branch!, 'made.txt')).toBe(true)
    expect(has(v.branch!, 'node_modules')).toBe(false)
    expect(fs.existsSync(path.join(repo, 'node_modules', 'dep', 'index.js'))).toBe(true)
  })
})

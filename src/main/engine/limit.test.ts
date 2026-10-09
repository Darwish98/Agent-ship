import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fromPattern, PATTERNS } from '../../shared/patterns'
import { foldRun, type RunEvent } from '../../shared/runs'
import { usdCeiling } from '../../shared/blueprint'
import type { AgentAdapter, StepRequest, StepResult } from './adapter'
import { RunEngine } from './runner'
import { commandExists, programOf } from './tools'

let root: string
let repo: string
const git = (...a: string[]): string => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim()

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-test-'))
  repo = path.join(root, 'repo')
  fs.mkdirSync(path.join(repo, 'planning'), { recursive: true })
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 't')
  git('config', 'user.email', 't@t')
  fs.writeFileSync(path.join(repo, 'planning', 'PLAN.md'), '- [ ] 1. **One.**\n- [ ] 2. **Two.**\n- [ ] 3. **Three.**\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }))

const ok = (over: Partial<StepResult> = {}): StepResult => ({
  ok: true, result: 'done', costUsd: 0.3, tokens: 100, sessionId: 's', budgetExhausted: false, timedOut: false, cancelled: false, ...over
})

class Fake implements AgentAdapter {
  reqs: StepRequest[] = []
  async run(req: StepRequest): Promise<StepResult> {
    this.reqs.push(req)
    if (req.jsonSchema.includes('"done"')) return ok({ structured: { done: true, reason: '' } })
    if (req.access === 'edit') {
      fs.writeFileSync(path.join(req.cwd, `f-${this.reqs.length}.txt`), 'x')
      const plan = path.join(req.cwd, 'planning', 'PLAN.md') // the builder ticks one item per pass
      if (fs.existsSync(plan)) fs.writeFileSync(plan, fs.readFileSync(plan, 'utf8').replace('- [ ]', '- [x]'))
    }
    return ok({ sessionId: req.sessionId })
  }
}

const shipped = () => {
  const bp = fromPattern(PATTERNS[4])
  for (const n of bp.nodes) if (n.kind === 'gate' && (n.id === 'tests' || n.id === 'verify')) n.config.command = `node -e "console.log('Tests  1 passed (1)')"`
  return bp
}
const start = async (limitUsd?: number) => {
  const events: RunEvent[] = []
  const engine = new RunEngine({ adapter: new Fake(), worktreeRoot: path.join(root, 'wt'), depsRoot: path.join(root, 'deps'), emit: (e) => events.push(e) })
  const r = await engine.start({
    projectId: 'p', projectName: 'repo', projectPath: repo, flowSlug: 'autopilot', blueprint: shipped(),
    inputs: { plan: 'planning/PLAN.md', base: 'main', test: 'npm test' }, limitUsd
  })
  if (r.ok) await engine.whenDone(r.runId)
  return { r, events, v: events.length ? foldRun(events) : null }
}

describe("a spending limit the person sets", () => {
  it('is the run\'s ceiling, and the run stops when it is reached, with main left where the last landed item put it', async () => {
    const { r, v } = await start(0.5)
    expect(r.ok).toBe(true)
    expect(v!.ceilingUsd).toBe(0.5)
    expect(v!.status).toBe('budget')
    expect(v!.reason).toMatch(/spending ceiling/)
    expect(v!.spentUsd).toBeLessThan(0.5 + 0.3) // at most one call over, as documented
  })

  it('cannot raise the ceiling above what the flow could spend at worst', async () => {
    const worst = usdCeiling(shipped())!
    const { v } = await start(worst * 10)
    expect(v!.ceilingUsd).toBe(worst)
    expect(v!.status).toBe('passed')
  })

  it('without a limit, the flow\'s own worst case is the ceiling, as before', async () => {
    const { v } = await start()
    expect(v!.ceilingUsd).toBe(usdCeiling(shipped()))
  })

  it('refuses a limit that is not a sensible amount', async () => {
    for (const bad of [0, -1, 0.01, Number.NaN]) {
      const { r } = await start(bad)
      expect(r.ok, String(bad)).toBe(false)
    }
  })
})

describe('does the program a command starts exist', () => {
  it('finds the program of a command, ignoring variable prefixes and quotes', () => {
    expect(programOf('pytest -q')).toBe('pytest')
    expect(programOf('  CI=1 NODE_ENV=test npm test')).toBe('npm')
    expect(programOf('"python" -m unittest')).toBe('python')
    expect(programOf('')).toBe('')
  })

  it('says yes for node, no for a program that does not exist, and does not look up builtins or paths', () => {
    expect(commandExists('node --version')).toEqual({ tool: 'node', found: true })
    expect(commandExists('definitely-not-a-real-program-xyz --flag')).toEqual({ tool: 'definitely-not-a-real-program-xyz', found: false })
    expect(commandExists('echo hi').found).toBe(true)
    expect(commandExists('./run-tests.sh').found).toBe(true)
    expect(commandExists('').found).toBe(true)
  })
})

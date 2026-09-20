// Opt-in: talks to the REAL `claude` CLI and spends a few cents.
//   AGENT_SHIP_LIVE=1 npx vitest run src/main/engine/live.test.ts
// It exists because the fake CLI used everywhere else can only prove the
// engine handles the output we *think* the CLI produces.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { emptyBlueprint } from '../../shared/patterns'
import { foldRun, type RunEvent } from '../../shared/runs'
import type { Blueprint } from '../../shared/schema'
import { ClaudeCodeAdapter } from './adapter'
import { RunEngine } from './runner'

const live = Boolean(process.env.AGENT_SHIP_LIVE)
let root = ''
let repo = ''
const git = (...a: string[]): string => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim()

beforeAll(() => {
  if (!live) return
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-live-'))
  repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 't')
  git('config', 'user.email', 't@t')
  git('config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(repo, 'README.md'), 'live\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
})

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

function flow(): Blueprint {
  const bp = emptyBlueprint('Live check')
  bp.inputs = []
  bp.defaultBudget = { maxUsd: 0.4 }
  bp.nodes.push(
    {
      id: 'build', kind: 'agent', label: 'Builder', position: { x: 290, y: 0 },
      config: {
        role: 'Builder', model: 'haiku', worktree: true, access: 'edit', tools: [], outputSchema: '',
        prompt: 'Create a file named hello.txt whose entire content is the single word hi, using the Write tool. Then reply with the single word done.'
      }
    },
    {
      id: 'check', kind: 'gate', label: 'File exists', position: { x: 580, y: 0 },
      config: { check: 'command', command: 'node -e "process.exit(require(\'fs\').existsSync(\'hello.txt\')?0:1)"', instructions: '' }
    }
  )
  bp.edges.push(
    { id: 'a', from: 'start', to: 'build', type: 'control', condition: 'always' },
    { id: 'b', from: 'build', to: 'check', type: 'branch', condition: 'always' }
  )
  return bp
}

describe.skipIf(!live)('real claude CLI', () => {
  it('runs a one-agent flow, parses cost/tokens from real output, and lands a verified branch', async () => {
    const events: RunEvent[] = []
    const engine = new RunEngine({ adapter: new ClaudeCodeAdapter(), worktreeRoot: path.join(root, 'wt'), emit: (e) => events.push(e) })
    const started = await engine.start({ projectId: 'p', projectName: 'live', projectPath: repo, flowSlug: 'live', blueprint: flow(), inputs: {} })
    if (!started.ok) throw new Error(started.error)
    await engine.whenDone(started.runId)

    const v = foldRun(events)!
    console.log(JSON.stringify({ status: v.status, reason: v.reason, spentUsd: v.spentUsd, tokens: v.tokens, branch: v.branch, steps: v.steps.map((s) => [s.nodeId, s.state, s.costUsd]) }))

    expect(v.status).toBe('passed')
    expect(v.spentUsd).toBeGreaterThan(0)
    expect(v.spentUsd).toBeLessThan(0.4)
    expect(v.tokens).toBeGreaterThan(0)
    expect(v.nodes.check.state).toBe('passed')
    expect(git('ls-tree', '-r', '--name-only', v.branch!)).toContain('hello.txt')
    expect(git('worktree', 'list').split('\n')).toHaveLength(1)
  }, 240_000)

  it('stops a run as "budget" when the real CLI reports its dollar cap was hit', async () => {
    const bp = flow()
    // Above the engine's minimum step (/usr/bin/bash.02) but below one real build (~$0.026).
    bp.defaultBudget = { maxUsd: 0.02 }
    const events: RunEvent[] = []
    const engine = new RunEngine({ adapter: new ClaudeCodeAdapter(), worktreeRoot: path.join(root, 'wt2'), emit: (e) => events.push(e) })
    const started = await engine.start({ projectId: 'p', projectName: 'live', projectPath: repo, flowSlug: 'live', blueprint: bp, inputs: {} })
    if (!started.ok) throw new Error(started.error)
    await engine.whenDone(started.runId)
    const v = foldRun(events)!
    console.log(JSON.stringify({ status: v.status, reason: v.reason, spentUsd: v.spentUsd, ceiling: v.ceilingUsd }))
    expect(v.status).toBe('budget')
    // The CLI checks the cap after a call, so it overshoots by at most one call.
    expect(v.spentUsd).toBeGreaterThan(0.02)
    expect(v.spentUsd).toBeLessThan(0.1)
    expect(v.nodes.check.state).toBe('idle') // the gate never ran
  }, 120_000)

  it('repairs a failing gate by RESUMING the real builder session with the gate output', async () => {
    const bp = flow()
    const build = bp.nodes.find((n) => n.id === 'build')!
    const gate = bp.nodes.find((n) => n.id === 'check')!
    // The prompt deliberately asks for the wrong content; only the gate knows the truth.
    if (build.kind === 'agent') build.config.prompt = 'Create a file named hello.txt whose entire content is the single word hello, using the Write tool. Then reply done.'
    if (gate.kind === 'gate') {
      gate.budget = { maxRetries: 2 }
      // Tells the agent what is wrong, the way a real test failure would.
      gate.config.command =
        'node -e "const fs=require(\'fs\');const t=fs.existsSync(\'hello.txt\')?fs.readFileSync(\'hello.txt\',\'utf8\').trim():\'\';if(t!==\'hi\'){console.error(\'FAIL: hello.txt must contain exactly the word hi but contains: \'+t);process.exit(1)}"'
    }
    bp.edges.push({ id: 'c', from: 'check', to: 'build', type: 'verdict', condition: 'fail' })
    bp.defaultBudget = { maxUsd: 0.3 }
    const events: RunEvent[] = []
    const engine = new RunEngine({ adapter: new ClaudeCodeAdapter(), worktreeRoot: path.join(root, 'wt3'), emit: (e) => events.push(e) })
    const started = await engine.start({ projectId: 'p', projectName: 'live', projectPath: repo, flowSlug: 'live', blueprint: bp, inputs: {} })
    if (!started.ok) throw new Error(started.error)
    await engine.whenDone(started.runId)
    const v = foldRun(events)!
    console.log(JSON.stringify({ status: v.status, reason: v.reason, spentUsd: v.spentUsd, gate: events.filter((e) => e.type === 'gate.result').map((e) => e.type === 'gate.result' && [e.pass, e.detail.slice(0, 80)]), sessions: [...new Set(events.filter((e) => e.type === 'node.started' && e.sessionId).map((e) => e.type === 'node.started' && e.sessionId))].length }))
    expect(v.status).toBe('passed')
    expect(v.nodes.build.attempts).toBe(2)
    const gates = events.filter((e) => e.type === 'gate.result')
    expect(gates.map((g) => g.type === 'gate.result' && g.pass)).toEqual([false, true])
    expect(git('show', v.branch + ':hello.txt').trim()).toBe('hi')
    // Both attempts used the SAME session: it was resumed, not restarted.
    const ids = new Set(events.filter((e) => e.type === 'node.started' && e.nodeId === 'build').map((e) => e.type === 'node.started' && e.sessionId))
    expect(ids.size).toBe(1)
  }, 240_000)
})

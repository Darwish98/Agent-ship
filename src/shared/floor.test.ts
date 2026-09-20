import { describe, expect, it } from 'vitest'
import { deriveFloor, needsInputStatus, verificationOf, type BranchLite, type SessionLite } from './floor'
import { fromPattern, PATTERNS } from './patterns'
import { foldRun, type RunEvent, type RunView } from './runs'

const NOW = new Date('2026-09-21T12:00:00Z').getTime()
const HOUR = 3_600_000
const DAY = 24 * HOUR

let n = 0
function makeRun(opts: {
  end?: 'passed' | 'failed' | 'budget' | 'cancelled' | 'interrupted' | null
  awaiting?: boolean
  gatePass?: boolean
  branch?: string
  project?: string
  startedAt?: number
  sessionId?: string
  cost?: number
}): RunView {
  const id = `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`
  const bp = fromPattern(PATTERNS[2])
  const t = opts.startedAt ?? NOW - HOUR
  const ev: RunEvent[] = [
    { type: 'run.started', at: t, runId: id, projectId: opts.project ?? 'p1', projectName: 'repo', projectPath: '/r', flowSlug: 'f', blueprint: bp, inputs: {}, ceilingUsd: 5 },
    { type: 'node.started', at: t + 1, runId: id, nodeId: 'build', attempt: 1, cwd: '/w', branch: opts.branch, sessionId: opts.sessionId ?? `sess-${id}` },
    { type: 'node.finished', at: t + 2, runId: id, nodeId: 'build', attempt: 1, status: 'passed', costUsd: opts.cost ?? 0.4, tokens: 10, summary: 'built', branch: opts.branch }
  ]
  if (opts.awaiting) ev.push({ type: 'gate.awaiting', at: t + 3, runId: id, nodeId: 'tests', attempt: 1, instructions: 'check it' })
  else if (opts.gatePass !== undefined) ev.push({ type: 'gate.result', at: t + 3, runId: id, nodeId: 'tests', attempt: 1, pass: opts.gatePass, by: 'command', detail: 'out' })
  if (opts.end) ev.push({ type: 'run.finished', at: t + 9, runId: id, status: opts.end, reason: `because ${opts.end}`, branch: opts.branch })
  return foldRun(ev)!
}

const session = (over: Partial<SessionLite> = {}): SessionLite => ({
  sessionId: `s${++n}`, name: 'nova', role: 'Dev', task: 'do a thing', status: 'busy', projectId: 'p1', live: true,
  needsInput: false, lastActive: NOW - 60_000, branch: '', contextTokens: 1, contextLimit: 10, ...over
})

const branch = (over: Partial<BranchLite> = {}): BranchLite => ({
  projectId: 'p1', branch: 'feat/x', ahead: 2, lastCommitAt: NOW - HOUR, subject: 'add x', ...over
})

const derive = (over: Partial<Parameters<typeof deriveFloor>[0]> = {}) =>
  deriveFloor({ now: NOW, runs: [], sessions: [], branches: [], acknowledged: new Set(), ...over })

describe('lanes', () => {
  it('puts a run waiting on a person at the top of Needs you, above failures', () => {
    const waiting = makeRun({ awaiting: true })
    const failed = makeRun({ end: 'failed', gatePass: false })
    const budget = makeRun({ end: 'budget' })
    const f = derive({ runs: [failed, budget, waiting] })
    expect(f.byLane.needs.map((i) => i.run!.runId)).toEqual([waiting.runId, budget.runId, failed.runId])
    expect(f.byLane.needs[0].reasons[0]).toMatch(/Approval needed: check it/)
    expect(f.byLane.needs[1].reasons[0]).toMatch(/Hit its budget/)
  })

  it('shows an active run under Running, with its current step', () => {
    const r = makeRun({ end: null })
    const f = derive({ runs: [r] })
    expect(f.byLane.running).toHaveLength(1)
    expect(f.byLane.running[0].subtitle).toBe('Step: Builder')
  })

  it('stops flagging a failed run once it is acknowledged', () => {
    const r = makeRun({ end: 'failed', gatePass: false })
    expect(derive({ runs: [r] }).byLane.needs).toHaveLength(1)
    const f = derive({ runs: [r], acknowledged: new Set([r.runId]) })
    expect(f.byLane.needs).toHaveLength(0)
    expect(f.byLane.done).toHaveLength(1)
  })

  it('does not raise the alarm for a run the user cancelled themselves', () => {
    const f = derive({ runs: [makeRun({ end: 'cancelled' })] })
    expect(f.byLane.needs).toHaveLength(0)
    expect(f.byLane.done[0].subtitle).toBe('Stopped')
  })

  it('treats a live session that reports needing input as Needs you, and others as Running', () => {
    const f = derive({ sessions: [session({ needsInput: true, name: 'blocked' }), session({ name: 'busy' })] })
    expect(f.byLane.needs.map((i) => i.title)).toEqual(['blocked'])
    expect(f.byLane.running.map((i) => i.title)).toEqual(['busy'])
  })
})

describe('outcomes', () => {
  it('marks a branch verified only when a gate in its run passed', () => {
    const proven = makeRun({ end: 'passed', gatePass: true, branch: 'agentship/aaa-build' })
    const f = derive({ runs: [proven], branches: [branch({ branch: 'agentship/aaa-build' })] })
    const item = f.byLane.ready[0]
    expect(item.verification).toEqual({ state: 'verified', by: 'Tests pass' })
    expect(item.authors).toContain('Plan → build → test → review run')
  })

  it('labels work that no gate ever checked as unverified, not good', () => {
    const f = derive({ branches: [branch()] })
    expect(f.byLane.ready[0].verification).toEqual({ state: 'unverified' })
  })

  it('flags a branch from a run whose gate failed', () => {
    const r = makeRun({ end: 'failed', gatePass: false, branch: 'agentship/bbb-build' })
    expect(verificationOf(r)).toEqual({ state: 'failed', by: 'Tests pass' })
    const f = derive({ runs: [r], branches: [branch({ branch: 'agentship/bbb-build' })] })
    expect(f.byLane.ready[0].verification?.state).toBe('failed')
  })

  it('ranks verified branches above unverified ones', () => {
    const proven = makeRun({ end: 'passed', gatePass: true, branch: 'agentship/ccc-build' })
    const f = derive({
      runs: [proven],
      branches: [branch({ branch: 'old-thing', lastCommitAt: NOW }), branch({ branch: 'agentship/ccc-build', lastCommitAt: NOW - 2 * HOUR })]
    })
    expect(f.byLane.ready.map((i) => i.title)).toEqual(['agentship/ccc-build', 'old-thing'])
  })

  it('does not show a passed run twice: its unmerged branch stands in for it', () => {
    const r = makeRun({ end: 'passed', gatePass: true, branch: 'agentship/ddd-build' })
    const f = derive({ runs: [r], branches: [branch({ branch: 'agentship/ddd-build' })] })
    expect(f.byLane.done).toHaveLength(0)
    expect(f.byLane.ready).toHaveLength(1)
  })

  it('once the branch is merged, the passed run moves to Done', () => {
    const r = makeRun({ end: 'passed', gatePass: true, branch: 'agentship/eee-build' })
    const f = derive({ runs: [r], branches: [] })
    expect(f.byLane.done).toHaveLength(1)
  })

  it('marks old branches stale', () => {
    const f = derive({ branches: [branch({ lastCommitAt: NOW - 30 * DAY })] })
    expect(f.byLane.ready[0].stale).toBe(true)
  })
})

describe('sessions', () => {
  it('folds a session under the run that started it instead of listing it again', () => {
    const r = makeRun({ end: null, sessionId: 'engine-session' })
    const f = derive({ runs: [r], sessions: [session({ sessionId: 'engine-session' })] })
    expect(f.items.filter((i) => i.kind === 'session')).toHaveLength(0)
  })

  it('an idle session whose work is on an unmerged branch is represented by the branch', () => {
    const s = session({ live: false, branch: 'feat/x', name: 'atlas' })
    const f = derive({ sessions: [s], branches: [branch()] })
    expect(f.byLane.done).toHaveLength(0)
    expect(f.byLane.ready[0].authors).toEqual(['atlas'])
  })

  it('shows recent idle sessions in Done and counts, rather than drops, old ones', () => {
    const f = derive({ sessions: [session({ live: false, lastActive: NOW - HOUR }), session({ live: false, lastActive: NOW - 5 * DAY })] })
    expect(f.byLane.done).toHaveLength(1)
    expect(f.hiddenOlder).toBe(1)
  })

  it('reads only real "waiting" wording as needing input', () => {
    expect(needsInputStatus('idle')).toBe(false)
    expect(needsInputStatus('busy')).toBe(false)
    expect(needsInputStatus(undefined)).toBe(false)
    expect(needsInputStatus('needs_input')).toBe(true)
    expect(needsInputStatus('waiting for permission')).toBe(true)
  })
})

describe('summary numbers', () => {
  it('counts attention per project and sums today\'s spend, including a run that started yesterday but is still going', () => {
    const a = makeRun({ end: 'failed', gatePass: false, project: 'p1', cost: 1 })
    const b = makeRun({ awaiting: true, project: 'p2', cost: 2 })
    const old = makeRun({ end: 'passed', startedAt: NOW - 3 * DAY, cost: 50 })
    const f = derive({ runs: [a, b, old] })
    expect(f.attentionByProject.get('p1')).toBe(1)
    expect(f.attentionByProject.get('p2')).toBe(1)
    expect(f.spendTodayUsd).toBeCloseTo(3)
  })
})

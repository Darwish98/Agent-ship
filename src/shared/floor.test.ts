import { describe, expect, it } from 'vitest'
import { deriveFloor, whoClearedIt, HOOK_FRESH_MS, HOOK_RECENT_MS, sessionActivity, verificationOf, type BranchLite, type SessionLite } from './floor'
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
  working: true, needsInput: false, waitingFor: '', lastActive: NOW - 60_000, cwd: '/r', dirtyFiles: 0, aheadCommits: 0, branch: '', contextTokens: 1, contextLimit: 10, ...over
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

  it('says what a blocked session is waiting for', () => {
    const f = derive({ sessions: [session({ live: true, working: false, needsInput: true, waitingFor: 'permission prompt' })] })
    expect(f.byLane.needs[0].reasons[0]).toBe('Waiting for you: permission prompt')
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

// --- pipeline inside every task -------------------------------------------------

import { buildLandBlueprint, LAND_FLOW } from './patterns'
import { pipelineForRun, pipelineForSession } from './floor'

const states = (item: { pipeline: { id: string; state: string }[] }): string =>
  item.pipeline.map((s) => `${s.id}:${s.state}`).join(' ')

function landRun(opts: { branch?: string; startedAt?: number; project?: string; upTo?: 'test' | 'merge' | 'verify' | 'land'; fail?: 'test' | 'merge' | 'verify' | 'land'; end?: 'passed' | 'failed' | null }): RunView {
  const id = `00000000-0000-0000-0001-${String(++n).padStart(12, '0')}`
  const bp = buildLandBlueprint({ branch: opts.branch ?? 'feat/x', base: 'main', testCommand: 'npm test', resolveConflicts: true })
  const t = opts.startedAt ?? NOW - 60_000
  const ev: RunEvent[] = [
    { type: 'run.started', at: t, runId: id, projectId: opts.project ?? 'p1', projectName: 'repo', projectPath: '/r', flowSlug: LAND_FLOW, blueprint: bp, inputs: { branch: opts.branch ?? 'feat/x' }, ceilingUsd: 1 }
  ]
  const order = ['test', 'merge', 'verify', 'land'] as const
  const upTo = opts.upTo ?? 'land'
  let k = 1
  for (const step of order) {
    if (order.indexOf(step) > order.indexOf(upTo)) break
    ev.push({ type: 'node.started', at: t + k++, runId: id, nodeId: step, attempt: 1, cwd: '/w' })
    const isGate = step === 'test' || step === 'verify'
    const bad = opts.fail === step
    if (isGate) ev.push({ type: 'gate.result', at: t + k++, runId: id, nodeId: step, attempt: 1, pass: !bad, by: 'command', detail: bad ? 'exit 1' : 'exit 0' })
    else if (opts.end !== null || step !== upTo) ev.push({ type: 'node.finished', at: t + k++, runId: id, nodeId: step, attempt: 1, status: bad ? 'failed' : 'passed', costUsd: 0, tokens: 0, summary: 'ok', error: bad ? 'conflicts in README.md' : undefined })
    if (bad) break
  }
  if (opts.end === 'passed') ev.push({ type: 'run.finished', at: t + 50, runId: id, status: 'passed', reason: 'Finished every step.', branch: opts.branch ?? 'feat/x' })
  if (opts.end === 'failed') ev.push({ type: 'run.finished', at: t + 50, runId: id, status: 'failed', reason: opts.fail === 'merge' ? 'feat/x conflicts with main in: README.md. Nothing was changed.' : `${opts.fail} failed`, branch: opts.branch ?? 'feat/x' })
  return foldRun(ev)!
}

describe('the pipeline inside every task', () => {
  it('a session that is still working has only built so far', () => {
    expect(pipelineForSession(session({ live: true })).map((s) => `${s.id}:${s.state}`).join(' ')).toBe('build:running test:idle merge:idle land:idle')
    // Finished with nothing left behind: built, and there is nothing to test, merge or land.
    expect(pipelineForSession(session({ live: false })).map((s) => s.state)).toEqual(['passed', 'skipped', 'skipped', 'skipped'])
  })

  it('a flow run maps agents to Build, gates to Test, and marks Merge and Land as not part of it', () => {
    const r = makeRun({ end: 'passed', gatePass: true, branch: 'agentship/a-build' })
    expect(states({ pipeline: pipelineForRun(r) })).toBe('build:passed test:passed merge:skipped land:skipped')
  })

  it('an unlanded branch shows built, then tested or not, then two idle steps', () => {
    const f = derive({ branches: [branch()] })
    expect(states(f.byLane.ready[0])).toBe('build:passed test:idle merge:idle land:idle')
    expect(f.byLane.ready[0].pipeline[1].note).toMatch(/Landing tests it first/)
    const proven = makeRun({ end: 'passed', gatePass: true, branch: 'agentship/p-build' })
    const g = derive({ runs: [proven], branches: [branch({ branch: 'agentship/p-build' })] })
    expect(states(g.byLane.ready[0])).toBe('build:passed test:passed merge:idle land:idle')
  })

  it('a landing run becomes the branch card\'s own pipeline instead of a second card', () => {
    const lr = landRun({ upTo: 'merge', end: null })
    const f = derive({ runs: [lr], branches: [branch()] })
    expect(f.items.filter((i) => i.kind === 'run')).toHaveLength(0)
    expect(f.byLane.running).toHaveLength(1)
    const item = f.byLane.running[0]
    expect(item.kind).toBe('branch')
    expect(states(item)).toBe('build:passed test:passed merge:running land:idle')
    expect(item.subtitle).toBe('Landing: Merge into main')
    expect(item.landRun?.runId).toBe(lr.runId)
  })

  it('a landing that failed on a conflict goes to Needs you, on the same card, until dismissed', () => {
    const lr = landRun({ upTo: 'merge', fail: 'merge', end: 'failed' })
    const f = derive({ runs: [lr], branches: [branch()] })
    expect(f.byLane.needs).toHaveLength(1)
    expect(f.byLane.needs[0].kind).toBe('branch')
    expect(f.byLane.needs[0].reasons[0]).toMatch(/Landing stopped: feat\/x conflicts with main/)
    expect(states(f.byLane.needs[0])).toBe('build:passed test:passed merge:failed land:idle')
    const g = derive({ runs: [lr], branches: [branch()], acknowledged: new Set([lr.runId]) })
    expect(g.byLane.needs).toHaveLength(0)
    expect(g.byLane.ready).toHaveLength(1)
  })

  it('tests that fail during landing mark the branch itself as failed', () => {
    const lr = landRun({ upTo: 'test', fail: 'test', end: 'failed' })
    const f = derive({ runs: [lr], branches: [branch()] })
    expect(f.byLane.needs[0].verification).toEqual({ state: 'failed', by: 'Test the branch' })
    expect(states(f.byLane.needs[0])).toBe('build:passed test:failed merge:idle land:idle')
  })

  it('ignores a landing attempt from before the branch got new commits', () => {
    const lr = landRun({ upTo: 'merge', fail: 'merge', end: 'failed', startedAt: NOW - 5 * HOUR })
    const f = derive({ runs: [lr], branches: [branch({ lastCommitAt: NOW - HOUR })] })
    expect(f.byLane.needs).toHaveLength(0)
    expect(states(f.byLane.ready[0])).toBe('build:passed test:idle merge:idle land:idle')
  })

  it('once the branch is landed and gone, the run stands alone in Done as "Landed"', () => {
    const lr = landRun({ end: 'passed' })
    const f = derive({ runs: [lr], branches: [] })
    expect(f.byLane.done).toHaveLength(1)
    expect(f.byLane.done[0].subtitle).toBe('Landed')
    expect(states(f.byLane.done[0])).toBe('build:passed test:passed merge:passed land:passed')
  })
});

describe('an open session that has finished its turn', () => {
  it('is not "building" any more: Build is done, and what it left behind is what the next stages wait for', () => {
    const s = session({ live: true, working: false, dirtyFiles: 29, name: 'Platform plan implementation' })
    const f = derive({ sessions: [s] })
    expect(f.byLane.running).toHaveLength(0)
    expect(f.byLane.ready).toHaveLength(1)
    const item = f.byLane.ready[0]
    expect(item.subtitle).toBe('29 uncommitted files')
    expect(states(item)).toBe('build:passed test:idle merge:idle land:idle')
    expect(item.pipeline[1].note).toMatch(/29 uncommitted files\. Commit them/)
    expect(item.pipeline[0].note).toMatch(/waiting for your next prompt/)
  })

  it('counts unmerged commits too, and pluralises properly', () => {
    const f = derive({ sessions: [session({ live: true, working: false, dirtyFiles: 1, aheadCommits: 3 })] })
    expect(f.byLane.ready[0].subtitle).toBe('1 uncommitted file, 3 unmerged commits')
  })

  it('with nothing left behind it simply rests in Done', () => {
    const f = derive({ sessions: [session({ live: true, working: false })] })
    expect(f.byLane.running).toHaveLength(0)
    expect(f.byLane.done).toHaveLength(1)
    expect(states(f.byLane.done[0])).toBe('build:passed test:skipped merge:skipped land:skipped')
  })

  it('a session that is mid-turn is still Running, with Build lit', () => {
    const f = derive({ sessions: [session({ live: true, working: true, dirtyFiles: 5 })] })
    expect(f.byLane.running).toHaveLength(1)
    expect(f.byLane.ready).toHaveLength(0)
    expect(states(f.byLane.running[0])).toBe('build:running test:idle merge:idle land:idle')
  })

  it('a session that is not open any more shows the same story', () => {
    const f = derive({ sessions: [session({ live: false, dirtyFiles: 2 })] })
    expect(f.byLane.ready[0].subtitle).toBe('2 uncommitted files')
  })

  it('does not blame every session in a shared checkout: the most recently active one owns the pending work', () => {
    const older = session({ live: false, working: false, dirtyFiles: 29, cwd: '/shared', lastActive: NOW - 3 * HOUR, name: 'older' })
    const newer = session({ live: true, working: false, dirtyFiles: 29, cwd: '/shared', lastActive: NOW - 60_000, name: 'newer' })
    const f = derive({ sessions: [older, newer] })
    expect(f.byLane.ready.map((i) => i.title)).toEqual(['newer'])
    expect(f.byLane.done.map((i) => i.title)).toEqual(['older'])
  })

  it('work that is already on a branch is shown by the branch card, not twice', () => {
    const s = session({ live: true, working: false, dirtyFiles: 3, branch: 'feat/x' })
    const f = derive({ sessions: [s], branches: [branch()] })
    expect(f.items.filter((i) => i.kind === 'session')).toHaveLength(0)
    expect(f.byLane.ready).toHaveLength(1)
  })

  it('a session waiting for input is still Needs you, not "finished"', () => {
    const f = derive({ sessions: [session({ live: true, working: false, needsInput: true })] })
    expect(f.byLane.needs).toHaveLength(1)
    expect(states(f.byLane.needs[0])).toBe('build:awaiting test:idle merge:idle land:idle')
  })
})

describe('is a live session working, blocked, or finished? (sessionActivity)', () => {
  const t = 1_000_000_000_000
  const tool = (msAgo: number, name = 'PreToolUse') => ({ lastHookAt: t - msAgo, lastHookEvent: name })
  const verdict = (i: Parameters<typeof sessionActivity>[0]): string => {
    const a = sessionActivity(i)
    return `${a.needsInput ? 'blocked' : a.working ? 'working' : 'idle'}/${a.basis}`
  }

  it.each([
    // What the CLI says, for the two kinds of session it lists.
    ['status busy', { status: 'busy' }, 'working/cli-status'],
    ['status idle', { status: 'idle' }, 'idle/cli-status'],
    ['status waiting with nothing to wait on is just between steps', { status: 'waiting' }, 'idle/cli-status'],
    ['status waiting on a permission prompt needs you', { status: 'waiting', waitingFor: 'permission prompt' }, 'blocked/cli-blocked'],
    ['state blocked needs you', { state: 'blocked' }, 'blocked/cli-blocked'],
    ['state working', { state: 'working' }, 'working/cli-state'],
    ['state done means it finished its turn, even with a busy-looking status', { state: 'done', status: 'busy' }, 'idle/cli-state'],
    ['state failed', { state: 'failed' }, 'idle/cli-state'],
    ['state stopped', { state: 'stopped' }, 'idle/cli-state'],
    // The CLI is polled every ~10s; a tool that just ran beats a stale answer.
    ['a tool ran a moment ago beats a stale idle', { status: 'idle', ...tool(HOOK_FRESH_MS - 1) }, 'working/hook-activity'],
    ['...but not once that is old', { status: 'idle', ...tool(HOOK_FRESH_MS + 1) }, 'idle/cli-status'],
    ['a Stop event is not activity', { status: 'idle', ...tool(100, 'Stop') }, 'idle/cli-status'],
    ['a prompt is decided before "a tool just ran" (the hook fires before the dialog)', { status: 'waiting', waitingFor: 'permission prompt', ...tool(200) }, 'blocked/cli-blocked'],
    // The limit that used to be a blind guess: nothing usable from the CLI.
    ['no signal at all is NOT assumed to be working', {}, 'idle/no-signal'],
    ['an unrecognised status is NOT assumed to be working', { status: 'zombie' }, 'idle/no-signal'],
    ['an unrecognised state is NOT assumed to be working', { state: 'sleeping', status: 'hibernating' }, 'idle/no-signal'],
    ['with no usable CLI word, recent hook activity still counts', { status: 'zombie', ...tool(HOOK_RECENT_MS - 1) }, 'working/hook-activity'],
    ['...and stale hook activity does not', { status: 'zombie', ...tool(HOOK_RECENT_MS + 1) }, 'idle/no-signal'],
    ['matching is case- and whitespace-tolerant', { status: ' BUSY ' }, 'working/cli-status']
  ])('%s', (_name, input, expected) => {
    expect(verdict({ now: t, ...input })).toBe(expected)
  })

  it('carries what a blocked session is waiting on', () => {
    expect(sessionActivity({ now: t, status: 'waiting', waitingFor: 'sandbox request' }).waitingFor).toBe('sandbox request')
  })
})

describe('landing a session\'s uncommitted work, and work you committed yourself', () => {
  const checkout = '/repo'

  /** A landing started from a session's checkout (what Commit & land creates). */
  function commitLandRun(opts: { end?: 'passed' | 'failed' | null; upTo?: 'test' | 'merge' | 'verify' | 'land'; project?: string; startedAt?: number; cwd?: string }): RunView {
    const r = landRun({ branch: 'agentship/work-1', project: opts.project ?? 'p1', upTo: opts.upTo, end: opts.end ?? null, startedAt: opts.startedAt })
    r.inputs = { ...r.inputs, checkout: opts.cwd ?? checkout }
    return r
  }

  it('shows a session\'s pending work as Ready, and the landing as ONE card (the branch), not two', () => {
    const s = session({ live: true, working: false, dirtyFiles: 11, cwd: checkout })
    const before = derive({ sessions: [s] })
    expect(before.byLane.ready.map((i) => i.kind)).toEqual(['session'])

    const lr = commitLandRun({ upTo: 'merge', end: null })
    const during = derive({ sessions: [s], runs: [lr], branches: [branch({ branch: 'agentship/work-1' })] })
    expect(during.byLane.ready).toHaveLength(0) // the session card steps aside
    expect(during.byLane.running).toHaveLength(1)
    expect(during.byLane.running[0].kind).toBe('branch')
    expect(states(during.byLane.running[0])).toBe('build:passed test:passed merge:running land:idle')
  })

  it('once landed, the session\'s own card shows the real pipeline, lit by what Agent Ship did', () => {
    const s = session({ live: true, working: false, dirtyFiles: 0, cwd: checkout })
    const lr = commitLandRun({ end: 'passed', startedAt: NOW - 60_000 })
    const f = derive({ sessions: [s], runs: [lr] })
    const card = f.byLane.done.find((i) => i.kind === 'session')!
    expect(states(card)).toBe('build:passed test:passed merge:passed land:passed')
    expect(card.subtitle).toBe('Tested, merged and landed by Agent Ship')
  })

  it('does not attribute a landing to a session in a different checkout or project', () => {
    const other = session({ live: true, working: false, cwd: '/somewhere-else' })
    const lr = commitLandRun({ end: 'passed' })
    expect(states(derive({ sessions: [other], runs: [lr] }).byLane.done.find((i) => i.kind === 'session')!)).toBe('build:passed test:skipped merge:skipped land:skipped')
    const otherProject = session({ live: true, working: false, cwd: checkout, projectId: 'p2' })
    expect(states(derive({ sessions: [otherProject], runs: [lr] }).byLane.done.find((i) => i.kind === 'session')!)).toBe('build:passed test:skipped merge:skipped land:skipped')
  })

  it('a session in a subfolder of the landed checkout still matches it', () => {
    const s = session({ live: true, working: false, cwd: '/repo/packages/app' })
    const lr = commitLandRun({ end: 'passed' })
    expect(states(derive({ sessions: [s], runs: [lr] }).byLane.done.find((i) => i.kind === 'session')!)).toBe('build:passed test:passed merge:passed land:passed')
  })

  it('work you committed and merged yourself is shown as done BY HAND, not as tested or as nothing', () => {
    const s = session({ live: true, working: false, handledAt: NOW - 1000 })
    const f = derive({ sessions: [s] })
    const card = f.byLane.done[0]
    expect(states(card)).toBe('build:passed test:skipped merge:manual land:manual')
    expect(card.pipeline[1].note).toMatch(/No test was run through Agent Ship/)
    expect(card.pipeline[2].note).toMatch(/yourself/)
  })

  it('but new uncommitted work after that is pending again, not "by hand"', () => {
    const s = session({ live: true, working: false, handledAt: NOW - 1000, dirtyFiles: 3 })
    expect(states(derive({ sessions: [s] }).byLane.ready[0])).toBe('build:passed test:idle merge:idle land:idle')
  })

  it('a by-hand commit noticed AFTER an earlier landing is shown as by hand, not as that landing', () => {
    const lr = commitLandRun({ end: 'passed', startedAt: NOW - 3 * HOUR })
    const s = session({ live: true, working: false, cwd: checkout, handledAt: NOW - 1000 })
    expect(states(derive({ sessions: [s], runs: [lr] }).byLane.done.find((i) => i.kind === 'session')!)).toBe('build:passed test:skipped merge:manual land:manual')
  })

  it('a landing newer than any by-hand observation is what the card shows', () => {
    const lr = commitLandRun({ end: 'passed', startedAt: NOW - 60_000 })
    const s = session({ live: true, working: false, cwd: checkout, handledAt: NOW - 3 * HOUR })
    expect(states(derive({ sessions: [s], runs: [lr] }).byLane.done.find((i) => i.kind === 'session')!)).toBe('build:passed test:passed merge:passed land:passed')
  })

  it('a landing is credited to the session that asked for it, not to others in the same folder', () => {
    const mine = session({ live: true, working: false, cwd: checkout })
    const sibling = session({ live: true, working: false, cwd: checkout })
    const lr = commitLandRun({ end: 'passed' })
    lr.inputs = { ...lr.inputs, session: mine.sessionId }
    const f = derive({ sessions: [mine, sibling], runs: [lr] })
    const byId = (id: string) => f.byLane.done.find((i) => i.session?.sessionId === id)!
    expect(states(byId(mine.sessionId))).toBe('build:passed test:passed merge:passed land:passed')
    expect(states(byId(sibling.sessionId))).toBe('build:passed test:skipped merge:skipped land:skipped')
  })
})

describe('who removed a session\'s uncommitted work? (whoClearedIt)', () => {
  const ep = (over: Partial<{ head: string; dirty: number; ahead: number; since: number }> = {}) => ({ head: 'aaa', dirty: 5, ahead: 0, since: NOW - 10 * 60_000, ...over })
  const landing = (session: string, endedMsAgo: number): RunView => {
    const r = landRun({ end: 'passed', startedAt: NOW - endedMsAgo - 5000 })
    r.inputs = { ...r.inputs, session }
    return r
  }

  it('a landing for this session that finished after the episode began explains it', () => {
    expect(whoClearedIt(ep(), 'bbb', [landing('s1', 60_000)], 's1')).toBe('landing')
  })

  it('a stale poll that "saw" the work again after the landing ended does not change that (the bug this replaced)', () => {
    // The episode began 10 minutes ago; the landing ended 1 minute ago. What time the last poll
    // still showed the files is irrelevant: only when the episode began matters.
    expect(whoClearedIt(ep({ since: NOW - 10 * 60_000 }), 'bbb', [landing('s1', 1_000)], 's1')).toBe('landing')
  })

  it('an OLD landing does not explain NEW work you then committed yourself', () => {
    // A landing finished 2 hours ago; a fresh episode of pending work began 5 minutes ago.
    expect(whoClearedIt(ep({ since: NOW - 5 * 60_000 }), 'bbb', [landing('s1', 2 * 3_600_000)], 's1')).toBe('hand')
  })

  it('a landing made for a different session does not count', () => {
    expect(whoClearedIt(ep(), 'bbb', [landing('someone-else', 60_000)], 's1')).toBe('hand')
  })

  it('unmerged commits that vanished count as merged by hand when no landing did it', () => {
    expect(whoClearedIt(ep({ dirty: 0, ahead: 3 }), 'aaa', [], 's1')).toBe('hand')
  })

  it('files that disappeared with HEAD unchanged were discarded, not committed', () => {
    expect(whoClearedIt(ep(), 'aaa', [], 's1')).toBe('none')
  })
})

// Rebuilds the walker's state from a run's event log, so an interrupted run can
// continue where it stopped instead of starting over. Pure: no git, no disk.
import { foldRun, isResumable, type RunEvent } from '../../shared/runs'
import type { Blueprint, BlueprintNode } from '../../shared/schema'

/** How long an interrupted run keeps its scratch worktree before the sweep reclaims it. */
export const RESUME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const TAIL = 6_000
const tail = (s: string, n = TAIL): string => (s.length > n ? `…(truncated)\n${s.slice(-n)}` : s)

/** The node a run continues to. A gate has separate pass and fail edges. */
export function nextNode(bp: Blueprint, n: BlueprintNode, when: 'pass' | 'fail' | 'next'): BlueprintNode | undefined {
  const edge = bp.edges.find((e) => {
    if (e.from !== n.id) return false
    if (n.kind !== 'gate') return e.condition !== 'fail'
    return when === 'fail' ? e.condition === 'fail' : e.condition !== 'fail'
  })
  return edge ? bp.nodes.find((x) => x.id === edge.to) : undefined
}

export interface Seed {
  /** Where to continue. `undefined` = the flow was already at its end. */
  node: BlueprintNode | undefined
  spent: number
  executions: number
  /** Executions of each node so far; the next one is `+ 1`. */
  runs: Map<string, number>
  /** Failed gate results per gate. */
  fails: Map<string, number>
  /** The last finished session of each agent, for repair-by-resume. */
  sessions: Map<string, { id: string; cwd: string }>
  /** Every worktree the run created, by the node that owns it. */
  worktrees: Map<string, { path: string; branch: string }>
  branch: string | undefined
  cwd: string
  upstream: string
  feedback: string
}

export const freshSeed = (bp: Blueprint, projectPath: string): Seed => ({
  node: nextNode(bp, bp.nodes.find((n) => n.kind === 'trigger')!, 'next'),
  spent: 0,
  executions: 0,
  runs: new Map(),
  fails: new Map(),
  sessions: new Map(),
  worktrees: new Map(),
  branch: undefined,
  cwd: projectPath,
  upstream: '',
  feedback: ''
})

type Last =
  | { kind: 'none' }
  | { kind: 'started'; node: BlueprintNode }
  | { kind: 'agent'; node: BlueprintNode; passed: boolean }
  | { kind: 'gate'; node: BlueprintNode; pass: boolean }

/**
 * Replays `events` to the state the walker had when the app stopped, and picks
 * the node to continue at. Mirrors `RunEngine.execute`; the tests keep them in
 * step.
 *
 * A step that was in flight is run again from the top (its result was never
 * recorded, so nothing it did is trusted), while everything already recorded,
 * its cost, its branch and its session, is carried over.
 */
export function planResume(events: readonly RunEvent[], bp: Blueprint, projectPath: string): Seed {
  const seed = freshSeed(bp, projectPath)
  const byId = new Map(bp.nodes.map((n) => [n.id, n]))
  const started = new Map<string, Extract<RunEvent, { type: 'node.started' }>>()
  let last: Last = { kind: 'none' }
  // The merged result lives in a scratch copy that does not survive a restart,
  // and nothing reaches the base branch before Land, so a run that got past the
  // Merge step goes back to it rather than continuing from a copy that is gone.
  let merged: BlueprintNode | undefined

  for (const e of events) {
    const node = 'nodeId' in e ? byId.get(e.nodeId) : undefined
    if (!node) continue

    if (e.type === 'node.started') {
      started.set(`${e.nodeId}#${e.attempt}`, e)
      seed.executions++
      if (node.kind === 'merge') merged = node
      seed.runs.set(e.nodeId, Math.max(seed.runs.get(e.nodeId) ?? 0, e.attempt))
      // Only a node that owns a worktree may claim its directory; a reviewer
      // that merely works inside the builder's has the same cwd and branch.
      if (node.kind === 'agent' && node.config.worktree && e.branch) seed.worktrees.set(e.nodeId, { path: e.cwd, branch: e.branch })
      last = { kind: 'started', node }
    } else if (e.type === 'gate.awaiting') {
      last = { kind: 'started', node }
    } else if (e.type === 'node.finished') {
      const s = started.get(`${e.nodeId}#${e.attempt}`)
      seed.spent += e.costUsd
      if (s?.sessionId && e.status === 'passed') seed.sessions.set(e.nodeId, { id: s.sessionId, cwd: s.cwd })
      if (e.branch && s) {
        seed.branch = e.branch
        seed.cwd = s.cwd
      }
      if (e.status === 'passed') {
        seed.upstream = e.summary
        seed.feedback = ''
      }
      last = { kind: 'agent', node, passed: e.status === 'passed' }
    } else if (e.type === 'gate.result') {
      if (!e.pass) seed.fails.set(e.nodeId, (seed.fails.get(e.nodeId) ?? 0) + 1)
      seed.feedback = e.pass ? '' : tail(e.detail)
      last = { kind: 'gate', node, pass: e.pass }
    }
  }

  switch (last.kind) {
    case 'none':
      break
    case 'started':
      seed.node = last.node
      break
    case 'agent':
      seed.node = last.passed ? nextNode(bp, last.node, 'next') : last.node
      break
    case 'gate': {
      if (last.pass) {
        seed.node = nextNode(bp, last.node, 'pass')
        break
      }
      const repair = nextNode(bp, last.node, 'fail')
      const fails = seed.fails.get(last.node.id) ?? 0
      if (repair && fails <= (last.node.budget?.maxRetries ?? 0)) {
        seed.node = repair
      } else {
        // Out of retries. Run the gate again so the run ends the way it would
        // have, with the same counting.
        seed.fails.set(last.node.id, fails - 1)
        seed.node = last.node
      }
      break
    }
  }
  if (merged && seed.node && seed.node.id !== merged.id) seed.node = merged
  return seed
}

/**
 * Runs whose scratch worktrees the sweep must leave alone: interrupted runs
 * recent enough to still be resumed. Older ones give their directories back
 * (the branch, with the work committed, stays).
 */
export function resumableRunIds(
  runs: readonly { runId: string; events: readonly RunEvent[] }[],
  now: number
): Set<string> {
  const ids = new Set<string>()
  for (const { runId, events } of runs) {
    const v = foldRun(events)
    if (v && isResumable(v.status) && now - (v.endedAt ?? v.startedAt) < RESUME_WINDOW_MS) ids.add(runId)
  }
  return ids
}

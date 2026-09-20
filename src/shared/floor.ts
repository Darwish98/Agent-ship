// The Floor's brain. Pure: plain data in, ranked work items out, so the rules
// for "what needs a human" can be tested without a window. See
// docs/FLOOR_DESIGN.md for why work is organised into these four lanes.
import { isActive, type RunView } from './runs'

export type Lane = 'needs' | 'running' | 'ready' | 'done'
export const LANES: readonly Lane[] = ['needs', 'running', 'ready', 'done']

/** A branch older than this is probably somebody's abandoned experiment. */
export const STALE_BRANCH_MS = 14 * 24 * 60 * 60 * 1000
/** How long a finished thing stays visible in "Done". */
export const DONE_WINDOW_MS = 24 * 60 * 60 * 1000

export interface SessionLite {
  sessionId: string
  name: string
  role: string
  task: string
  status: string
  projectId: string
  live: boolean
  needsInput: boolean
  lastActive: number
  branch: string
  contextTokens: number
  contextLimit: number
  pid?: number
}

export interface BranchLite {
  projectId: string
  branch: string
  ahead: number
  lastCommitAt: number
  subject: string
}

export interface FloorInput {
  now: number
  runs: RunView[]
  sessions: SessionLite[]
  branches: BranchLite[]
  /** Failed runs the user has already looked at and dismissed. */
  acknowledged: ReadonlySet<string>
}

export type Verification =
  | { state: 'verified'; by: string }
  | { state: 'failed'; by: string }
  | { state: 'unverified' }

export interface WorkItem {
  /** Stable across refreshes, so selection survives a poll. */
  id: string
  kind: 'run' | 'session' | 'branch'
  lane: Lane
  projectId: string
  title: string
  subtitle: string
  updatedAt: number
  /** Why this is in "Needs you". Empty for other lanes. */
  reasons: string[]
  /** Higher sorts first within a lane. */
  priority: number
  run?: RunView
  session?: SessionLite
  branch?: BranchLite
  verification?: Verification
  /** Sessions or runs that produced this branch. */
  authors: string[]
  stale?: boolean
}

export interface FloorModel {
  items: WorkItem[]
  byLane: Record<Lane, WorkItem[]>
  /** Sessions too old to show; surfaced as a count so nothing silently vanishes. */
  hiddenOlder: number
  spendTodayUsd: number
  attentionByProject: Map<string, number>
}

const startOfDay = (t: number): number => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Did a gate in this run prove the work? Only a passed gate counts; a run
 *  with no gate at all is honestly "unverified". */
export function verificationOf(run: RunView): Verification {
  const gates = run.blueprint.nodes.filter((n) => n.kind === 'gate')
  if (!gates.length) return { state: 'unverified' }
  const failed = gates.find((g) => run.nodes[g.id]?.state === 'failed')
  if (run.status !== 'passed' && failed) return { state: 'failed', by: failed.label || 'gate' }
  const allPassed = gates.every((g) => run.nodes[g.id]?.state === 'passed')
  if (run.status === 'passed' && allPassed) {
    return { state: 'verified', by: gates.map((g) => g.label || 'gate').join(', ') }
  }
  return { state: 'unverified' }
}

function runItem(run: RunView, acknowledged: ReadonlySet<string>): WorkItem {
  const nameOf = (id?: string): string => {
    const n = run.blueprint.nodes.find((x) => x.id === id)
    return n?.label || n?.kind || ''
  }
  const base = {
    id: `run:${run.runId}`,
    kind: 'run' as const,
    projectId: run.projectId,
    title: run.blueprint.name,
    updatedAt: run.endedAt ?? run.startedAt,
    run,
    authors: [] as string[]
  }

  if (run.status === 'awaiting') {
    const gate = run.blueprint.nodes.find((n) => n.id === run.currentNodeId)
    return { ...base, lane: 'needs', subtitle: `Waiting at ${gate?.label || 'a gate'}`, reasons: [`Approval needed: ${run.nodes[run.currentNodeId ?? '']?.detail || 'review and approve to continue'}`], priority: 100 }
  }
  if (run.status === 'running') {
    return { ...base, lane: 'running', subtitle: run.currentNodeId ? `Step: ${nameOf(run.currentNodeId)}` : 'Starting', reasons: [], priority: 50 }
  }
  const trouble = run.status === 'failed' || run.status === 'budget' || run.status === 'interrupted'
  if (trouble && !acknowledged.has(run.runId)) {
    const priority = run.status === 'budget' ? 90 : run.status === 'failed' ? 80 : 40
    const label = run.status === 'budget' ? 'Hit its budget' : run.status === 'interrupted' ? 'Interrupted' : 'Failed'
    return { ...base, lane: 'needs', subtitle: label, reasons: [`${label}: ${run.reason}`], priority }
  }
  return { ...base, lane: 'done', subtitle: run.status === 'passed' ? 'Finished' : run.status === 'cancelled' ? 'Stopped' : run.reason, reasons: [], priority: 0 }
}

export function deriveFloor(input: FloorInput): FloorModel {
  const { now, runs, sessions, branches, acknowledged } = input
  const items: WorkItem[] = []

  const runSessionIds = new Set<string>()
  for (const r of runs) for (const n of Object.values(r.nodes)) if (n.sessionId) runSessionIds.add(n.sessionId)

  // Which run produced which branch, so a branch can say how it was verified.
  const runByBranch = new Map<string, RunView>()
  for (const r of [...runs].sort((a, b) => a.startedAt - b.startedAt)) {
    for (const n of Object.values(r.nodes)) if (n.branch) runByBranch.set(`${r.projectId}:${n.branch}`, r)
  }
  const branchKeys = new Set(branches.map((b) => `${b.projectId}:${b.branch}`))

  for (const run of runs) {
    const item = runItem(run, acknowledged)
    // A finished run whose branch is still unmerged is represented by that
    // branch in "Ready to land", not twice.
    if (item.lane === 'done' && run.status === 'passed' && run.branch && branchKeys.has(`${run.projectId}:${run.branch}`)) continue
    if (item.lane === 'done' && now - item.updatedAt > DONE_WINDOW_MS) continue
    items.push(item)
  }

  const authorsOf = new Map<string, string[]>()
  for (const s of sessions) {
    if (!s.branch) continue
    const key = `${s.projectId}:${s.branch}`
    authorsOf.set(key, [...(authorsOf.get(key) ?? []), s.name])
  }

  for (const b of branches) {
    const key = `${b.projectId}:${b.branch}`
    const run = runByBranch.get(key)
    const authors = [...(run ? [`${run.blueprint.name} run`] : []), ...(authorsOf.get(key) ?? [])]
    const verification: Verification = run ? verificationOf(run) : { state: 'unverified' }
    items.push({
      id: `branch:${key}`,
      kind: 'branch',
      lane: 'ready',
      projectId: b.projectId,
      title: b.branch,
      subtitle: b.subject,
      updatedAt: b.lastCommitAt,
      reasons: [],
      // Proven work first, then recency.
      priority: (verification.state === 'verified' ? 10 : 0) + (verification.state === 'failed' ? -5 : 0),
      branch: b,
      verification,
      authors,
      stale: now - b.lastCommitAt > STALE_BRANCH_MS
    })
  }

  let hiddenOlder = 0
  for (const s of sessions) {
    if (runSessionIds.has(s.sessionId)) continue // shown inside its run
    const base = { id: `session:${s.sessionId}`, kind: 'session' as const, projectId: s.projectId, title: s.name, subtitle: s.task, updatedAt: s.lastActive, session: s, authors: [] as string[] }
    if (s.live && s.needsInput) {
      items.push({ ...base, lane: 'needs', reasons: ['Waiting for your input'], priority: 70 })
    } else if (s.live) {
      items.push({ ...base, lane: 'running', reasons: [], priority: 30 })
    } else if (s.branch && branchKeys.has(`${s.projectId}:${s.branch}`)) {
      // Its work is the branch card.
    } else if (now - s.lastActive <= DONE_WINDOW_MS) {
      items.push({ ...base, lane: 'done', reasons: [], priority: 0 })
    } else {
      hiddenOlder++
    }
  }

  const byLane: Record<Lane, WorkItem[]> = { needs: [], running: [], ready: [], done: [] }
  for (const it of items) byLane[it.lane].push(it)
  for (const lane of LANES) byLane[lane].sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt)

  const attentionByProject = new Map<string, number>()
  for (const it of byLane.needs) attentionByProject.set(it.projectId, (attentionByProject.get(it.projectId) ?? 0) + 1)

  const today = startOfDay(now)
  const spendTodayUsd = runs.filter((r) => r.startedAt >= today || isActive(r.status)).reduce((sum, r) => sum + r.spentUsd, 0)

  return { items, byLane, hiddenOlder, spendTodayUsd, attentionByProject }
}

/** Only real "waiting on a person" wording counts. Anything else `claude
 *  agents --json` reports (observed: idle, busy) is treated as ordinary. */
export function needsInputStatus(status: string | undefined): boolean {
  return Boolean(status && /input|waiting|blocked|permission|approval/i.test(status))
}

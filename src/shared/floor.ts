// The Floor's brain. Pure: plain data in, ranked work items out, so the rules
// for "what needs a human" can be tested without a window. See
// docs/FLOOR_DESIGN.md for why work is organised into these four lanes.
import { LAND_FLOW } from './patterns'
import { isActive, type NodeState, type RunView } from './runs'

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

export type StageId = 'build' | 'test' | 'merge' | 'land'
export type StageState = NodeState | 'skipped'

/** One step of a task's life. A task is often several real sessions and runs
 *  (the author, its gate, the landing run); the four stages tell them as one
 *  story, and clicking a stage leads to the real thing behind it. */
export interface PipelineStage {
  id: StageId
  label: string
  state: StageState
  /** One line saying what this stage is or did. */
  note: string
}

export const STAGE_LABEL: Record<StageId, string> = { build: 'Build', test: 'Test', merge: 'Merge', land: 'Land' }

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
  /** Build → Test → Merge → Land, for every kind of task. */
  pipeline: PipelineStage[]
  /** The run that is landing (or tried to land) this branch. */
  landRun?: RunView
  /** Sessions or runs that produced this branch. */
  authors: string[]
  /** The real sessions behind `authors`, so a stage can open them. */
  authorSessions: SessionLite[]
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

const stage = (id: StageId, state: StageState, note: string): PipelineStage => ({ id, label: STAGE_LABEL[id], state, note })

/**
 * Collapses several node states into the one a stage shows. Only steps that
 * have actually run count: a stage with two gates reads "passed" once the first
 * has passed, and lights up again if the second then fails, instead of flickering
 * back to "running" the moment the first passes.
 */
function aggregate(states: NodeState[]): NodeState {
  if (states.includes('failed')) return 'failed'
  if (states.includes('awaiting')) return 'awaiting'
  if (states.includes('running')) return 'running'
  if (states.includes('passed')) return 'passed'
  return 'idle'
}

/** The pipeline of a flow run: each node feeds the stage its kind belongs to. */
export function pipelineForRun(run: RunView): PipelineStage[] {
  const groups: Record<StageId, { states: NodeState[]; names: string[] }> = {
    build: { states: [], names: [] },
    test: { states: [], names: [] },
    merge: { states: [], names: [] },
    land: { states: [], names: [] }
  }
  for (const n of run.blueprint.nodes) {
    const id: StageId | null = n.kind === 'agent' ? 'build' : n.kind === 'gate' ? 'test' : n.kind === 'merge' ? 'merge' : n.kind === 'land' ? 'land' : null
    if (!id) continue
    groups[id].states.push(run.nodes[n.id]?.state ?? 'idle')
    groups[id].names.push(n.label || n.kind)
  }
  return (['build', 'test', 'merge', 'land'] as StageId[]).map((id) => {
    const g = groups[id]
    // A landing run starts from finished work: building happened before it.
    if (id === 'build' && run.flowSlug === LAND_FLOW) return stage('build', 'passed', 'Built before landing.')
    if (g.names.length === 0) return stage(id, 'skipped', 'Not part of this flow.')
    return stage(id, aggregate(g.states), g.names.join(', '))
  })
}

/** The pipeline of a session working outside any flow: it can only be building. */
export function pipelineForSession(s: SessionLite): PipelineStage[] {
  return [
    stage('build', s.live ? (s.needsInput ? 'awaiting' : 'running') : 'passed', s.live ? 'Working now.' : 'Finished.'),
    stage('test', 'idle', 'Nothing has checked this work yet.'),
    stage('merge', 'idle', 'Not merged.'),
    stage('land', 'idle', 'Not landed.')
  ]
}

/**
 * The pipeline of finished work on a branch. Build is done by definition; Test
 * is what a gate said (in the run that built it, or in the landing run); Merge
 * and Land light up as the landing run reaches them.
 */
export function pipelineForBranch(verification: Verification, authors: string[], landRun?: RunView): PipelineStage[] {
  const build = stage('build', 'passed', authors.length ? `By ${authors.join(', ')}.` : 'Work is on the branch.')
  if (!landRun) {
    const test =
      verification.state === 'verified'
        ? stage('test', 'passed', `A gate passed: ${verification.by}.`)
        : verification.state === 'failed'
          ? stage('test', 'failed', `The gate "${verification.by}" failed on this branch.`)
          : stage('test', 'idle', 'No gate has checked this. Landing tests it first.')
    return [build, test, stage('merge', 'idle', 'Merges into the base in a scratch copy.'), stage('land', 'idle', 'Moves the base only after the merged result passes.')]
  }
  const land = pipelineForRun(landRun)
  const at = (id: StageId): PipelineStage => land.find((s) => s.id === id)!
  const test = at('test')
  return [
    build,
    test.state === 'skipped' ? stage('test', 'skipped', 'No test command was set. Landing without tests.') : test,
    at('merge'),
    at('land')
  ]
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
    pipeline: pipelineForRun(run),
    authors: [] as string[],
    authorSessions: [] as SessionLite[]
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
  return { ...base, lane: 'done', subtitle: run.status === 'passed' ? (run.flowSlug === LAND_FLOW ? 'Landed' : 'Finished') : run.status === 'cancelled' ? 'Stopped' : run.reason, reasons: [], priority: 0 }
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
  const branchByKey = new Map(branches.map((b) => [`${b.projectId}:${b.branch}`, b]))
  const branchKeys = new Set(branchByKey.keys())

  // The latest attempt to land each branch. It is not a task of its own: it is
  // the Merge and Land stages of the branch's task.
  const landByBranch = new Map<string, RunView>()
  for (const r of [...runs].sort((a, b) => a.startedAt - b.startedAt)) {
    if (r.flowSlug === LAND_FLOW) landByBranch.set(`${r.projectId}:${r.inputs.branch ?? ''}`, r)
  }
  /** The landing run to show on a branch card, if it is about this state of the branch. */
  const landFor = (key: string): RunView | undefined => {
    const r = landByBranch.get(key)
    const b = branchByKey.get(key)
    if (!r || !b) return undefined
    // A run older than the branch's newest commit says nothing about it.
    return isActive(r.status) || r.startedAt >= b.lastCommitAt ? r : undefined
  }

  for (const run of runs) {
    const isLand = run.flowSlug === LAND_FLOW
    if (isLand) {
      const key = `${run.projectId}:${run.inputs.branch ?? ''}`
      if (landFor(key) === run) continue // shown on the branch card
      // An old attempt at a branch that has moved on is history, not a to-do.
      if (branchKeys.has(key)) continue
    }
    const item = runItem(run, acknowledged)
    // A finished run whose branch is still unmerged is represented by that
    // branch in "Ready to land", not twice.
    if (!isLand && item.lane === 'done' && run.status === 'passed' && run.branch && branchKeys.has(`${run.projectId}:${run.branch}`)) continue
    if (item.lane === 'done' && now - item.updatedAt > DONE_WINDOW_MS) continue
    items.push(item)
  }

  const sessionsOf = new Map<string, SessionLite[]>()
  for (const s of sessions) {
    if (!s.branch) continue
    const key = `${s.projectId}:${s.branch}`
    sessionsOf.set(key, [...(sessionsOf.get(key) ?? []), s])
  }

  for (const b of branches) {
    const key = `${b.projectId}:${b.branch}`
    const run = runByBranch.get(key)
    const authorSessions = sessionsOf.get(key) ?? []
    const authors = [...(run ? [`${run.blueprint.name} run`] : []), ...authorSessions.map((s) => s.name)]
    const landRun = landFor(key)
    let verification: Verification = run ? verificationOf(run) : { state: 'unverified' }
    // The landing run's own test steps are the freshest word on this branch.
    if (landRun) {
      const failedGate = landRun.blueprint.nodes.find((n) => n.kind === 'gate' && landRun.nodes[n.id]?.state === 'failed')
      if (failedGate) verification = { state: 'failed', by: failedGate.label || 'gate' }
    }

    let lane: Lane = 'ready'
    let reasons: string[] = []
    let subtitle = b.subject
    // Proven work first, then recency.
    let priority = (verification.state === 'verified' ? 10 : 0) + (verification.state === 'failed' ? -5 : 0)
    if (landRun) {
      if (landRun.status === 'awaiting') {
        lane = 'needs'
        priority = 100
        reasons = [`Approval needed while landing: ${landRun.nodes[landRun.currentNodeId ?? '']?.detail || 'review and approve'}`]
      } else if (isActive(landRun.status)) {
        lane = 'running'
        priority = 60
        const step = landRun.blueprint.nodes.find((n) => n.id === landRun.currentNodeId)
        subtitle = step ? `Landing: ${step.label || step.kind}` : 'Landing'
      } else if (landRun.status !== 'passed' && landRun.status !== 'cancelled' && !acknowledged.has(landRun.runId)) {
        lane = 'needs'
        priority = landRun.status === 'budget' ? 90 : 85
        reasons = [`Landing stopped: ${landRun.reason}`]
      }
    }
    items.push({
      id: `branch:${key}`,
      kind: 'branch',
      lane,
      projectId: b.projectId,
      title: b.branch,
      subtitle,
      updatedAt: landRun && isActive(landRun.status) ? landRun.startedAt : b.lastCommitAt,
      reasons,
      priority,
      branch: b,
      verification,
      pipeline: pipelineForBranch(verification, authors, landRun),
      landRun,
      authors,
      authorSessions,
      stale: lane === 'ready' && now - b.lastCommitAt > STALE_BRANCH_MS
    })
  }

  let hiddenOlder = 0
  for (const s of sessions) {
    if (runSessionIds.has(s.sessionId)) continue // shown inside its run
    const base = { id: `session:${s.sessionId}`, kind: 'session' as const, projectId: s.projectId, title: s.name, subtitle: s.task, updatedAt: s.lastActive, session: s, pipeline: pipelineForSession(s), authors: [] as string[], authorSessions: [] as SessionLite[] }
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

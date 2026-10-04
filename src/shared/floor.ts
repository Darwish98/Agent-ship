// The Floor's brain. Pure: plain data in, ranked work items out, so the rules
// for "what needs a human" can be tested without a window. See
// planning/FLOOR_DESIGN.md for why work is organised into these four lanes.
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
  /** Actually mid-turn. A live session that is idle is open, but its work is finished for now. */
  working: boolean
  needsInput: boolean
  /** What a blocked session is waiting on ("permission prompt", "input needed"...). */
  waitingFor: string
  lastActive: number
  cwd: string
  /** Uncommitted files and unmerged commits in this session's checkout. */
  dirtyFiles: number
  aheadCommits: number
  /** When we noticed that work it held was committed by you, not by a landing (see useHandledByHand). */
  handledAt?: number
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
/** `manual`: it happened, but by your hand and outside Agent Ship. Not the same as passed. */
export type StageState = NodeState | 'skipped' | 'manual'

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

/** Uncommitted files and unmerged commits: work that exists but has not left the session. */
export function pendingWork(s: Pick<SessionLite, 'dirtyFiles' | 'aheadCommits'>): string {
  const parts: string[] = []
  if (s.dirtyFiles > 0) parts.push(`${s.dirtyFiles} uncommitted file${s.dirtyFiles === 1 ? '' : 's'}`)
  if (s.aheadCommits > 0) parts.push(`${s.aheadCommits} unmerged commit${s.aheadCommits === 1 ? '' : 's'}`)
  return parts.join(', ')
}

/**
 * The pipeline of a session working outside any flow. Build is only "running"
 * while it is actually mid-turn: an open session that has finished its
 * response has finished building, and whatever it left behind (uncommitted
 * files, unmerged commits) is what the later stages are waiting for.
 */
export function pipelineForSession(s: SessionLite): PipelineStage[] {
  if (s.live && s.needsInput) return [stage('build', 'awaiting', 'Waiting for your input.'), stage('test', 'idle', ''), stage('merge', 'idle', ''), stage('land', 'idle', '')]
  if (s.live && s.working) {
    return [stage('build', 'running', 'Working now.'), stage('test', 'idle', 'Nothing to test until it finishes.'), stage('merge', 'idle', ''), stage('land', 'idle', '')]
  }
  const done = s.live ? 'Finished its turn and is waiting for your next prompt.' : 'Finished.'
  const pending = pendingWork(s)
  if (!pending && s.handledAt !== undefined) {
    return [
      stage('build', 'passed', done),
      stage('test', 'skipped', 'No test was run through Agent Ship.'),
      stage('merge', 'manual', 'You committed and merged this yourself, outside Agent Ship.'),
      stage('land', 'manual', 'It is in your code now, put there by hand.')
    ]
  }
  if (!pending) {
    return [
      stage('build', 'passed', done),
      stage('test', 'skipped', 'No changes to test.'),
      stage('merge', 'skipped', 'Nothing to merge.'),
      stage('land', 'skipped', 'Nothing to land.')
    ]
  }
  return [
    stage('build', 'passed', done),
    stage('test', 'idle', `${pending}. Commit them to a branch and they can be tested and landed.`),
    stage('merge', 'idle', 'Waiting for a commit.'),
    stage('land', 'idle', 'Waiting for a commit.')
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

  // Several sessions can share one checkout, and its uncommitted files are
  // not all theirs. Attribute pending work to the session that was active in
  // it most recently (the best guess available), not to all of them.
  const owner = new Map<string, SessionLite>()
  for (const s of sessions) {
    if (s.dirtyFiles === 0 && s.aheadCommits === 0) continue
    const cur = owner.get(s.cwd)
    if (!cur || s.lastActive > cur.lastActive) owner.set(s.cwd, s)
  }

  // A landing started from a session's uncommitted work remembers which checkout
  // it came from, so the session's own card can show that landing's pipeline.
  const normPath = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
  const checkoutLands = runs
    .filter((r) => r.flowSlug === LAND_FLOW && r.inputs.checkout)
    .sort((a, b) => a.startedAt - b.startedAt)
  const landOf = (s: SessionLite): RunView | undefined => {
    const w = normPath(s.cwd)
    let found: RunView | undefined
    for (const r of checkoutLands) {
      if (r.projectId !== s.projectId) continue
      // Tied to the session that asked for it. Sessions sharing a folder are not
      // all credited with one landing.
      if (r.inputs.session) {
        if (r.inputs.session === s.sessionId) found = r
        continue
      }
      const c = normPath(r.inputs.checkout)
      if (w === c || w.startsWith(`${c}/`) || c.startsWith(`${w}/`)) found = r
    }
    return found
  }

  let hiddenOlder = 0
  for (const raw of sessions) {
    const owns = owner.get(raw.cwd)?.sessionId === raw.sessionId
    const s: SessionLite = owns ? raw : { ...raw, dirtyFiles: 0, aheadCommits: 0 }
    if (runSessionIds.has(s.sessionId)) continue // shown inside its run
    const landing = landOf(s)
    const landingActive = Boolean(landing && isActive(landing.status))
    // Landed through Agent Ship recently: its real pipeline, not a guess.
    // ...unless you have committed something by hand since (a newer observation wins).
    const landedHere =
      landing &&
      landing.status === 'passed' &&
      !pendingWork(s) &&
      now - (landing.endedAt ?? landing.startedAt) <= DONE_WINDOW_MS &&
      !(s.handledAt !== undefined && s.handledAt > (landing.endedAt ?? landing.startedAt))
    const base = {
      id: `session:${s.sessionId}`,
      kind: 'session' as const,
      projectId: s.projectId,
      title: s.name,
      subtitle: landedHere ? 'Tested, merged and landed by Agent Ship' : s.task,
      updatedAt: s.lastActive,
      session: s,
      pipeline: landedHere ? pipelineForBranch({ state: 'unverified' }, [s.name], landing) : pipelineForSession(s),
      landRun: landedHere ? landing : undefined,
      authors: [] as string[],
      authorSessions: [] as SessionLite[]
    }
    if (s.live && s.needsInput) {
      items.push({ ...base, lane: 'needs', reasons: [s.waitingFor ? `Waiting for you: ${s.waitingFor}` : 'Waiting for your input'], priority: 70 })
    } else if (s.live && s.working) {
      items.push({ ...base, lane: 'running', reasons: [], priority: 30 })
    } else if (s.branch && branchKeys.has(`${s.projectId}:${s.branch}`)) {
      // Its work is the branch card.
    } else if (pendingWork(s) && landingActive) {
      // Being landed right now: the branch card shows that, so do not show it twice.
    } else if (pendingWork(s)) {
      // Finished its turn, but what it made has not been committed or landed.
      // That is the next thing to do, so it belongs with finished work. It goes
      // last: it cannot be landed until it is committed.
      items.push({ ...base, lane: 'ready', subtitle: pendingWork(s), reasons: [], priority: -2 })
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

/** What we remember about a session's checkout while it held uncommitted work. */
export interface PendingEpisode {
  head: string
  dirty: number
  ahead: number
  /** When this episode of pending work FIRST appeared. It does not move while the work is still there. */
  since: number
}

/**
 * The work a session held is gone from its checkout. Who took it?
 *
 *  - `landing`: a landing Agent Ship ran for this very session finished after
 *    the episode began, so that landing is what removed it.
 *  - `hand`: it was committed or merged by you (HEAD moved, or unmerged commits
 *    are gone) and no such landing explains it.
 *  - `none`: nothing we can say happened (e.g. the files were just discarded).
 *
 * The anchor is when the episode began, NOT the last time we happened to see
 * the work: git state is polled, so a stale poll right after a landing can
 * "see" the work again after it has ended.
 */
export function whoClearedIt(
  episode: PendingEpisode,
  nowHead: string,
  runs: readonly RunView[],
  sessionId: string
): 'landing' | 'hand' | 'none' {
  const gone = (episode.dirty > 0 && episode.head !== nowHead) || episode.ahead > 0
  if (!gone) return 'none'
  const landed = runs.some((r) => r.flowSlug === LAND_FLOW && r.inputs.session === sessionId && (r.endedAt ?? r.startedAt) >= episode.since)
  return landed ? 'landing' : 'hand'
}

/** Where a session's working/blocked verdict came from, so it can be audited. */
export type ActivityBasis = 'cli-blocked' | 'cli-state' | 'cli-status' | 'hook-activity' | 'no-signal'

export interface ActivityInput {
  /** `status` from `claude agents --json`: busy | waiting | idle (only while the process is alive). */
  status?: string
  /** `state`: working | blocked | done | failed | stopped (present for background sessions). */
  state?: string
  /** Present with status "waiting": permission prompt, input needed, sandbox request... */
  waitingFor?: string
  /** The newest hook event for this session, and its name. */
  lastHookAt?: number
  lastHookEvent?: string
  now: number
}

export interface Activity {
  working: boolean
  needsInput: boolean
  waitingFor: string
  basis: ActivityBasis
}

/** The CLI is polled every ~10s, so a tool that ran this recently outranks a stale "idle". */
export const HOOK_FRESH_MS = 5_000
/** With no usable word from the CLI, hook activity this recent still means it is doing something. */
export const HOOK_RECENT_MS = 60_000

/**
 * Is a live session actually mid-turn, or blocked on a person? Reads what
 * Claude Code says (documented values only) and, where it says nothing usable,
 * falls back to evidence (recent hook events), never to a blanket guess:
 * assuming "working" is what once left finished sessions stuck in Build.
 */
export function sessionActivity(i: ActivityInput): Activity {
  const state = (i.state ?? '').trim().toLowerCase()
  const status = (i.status ?? '').trim().toLowerCase()
  const waitingFor = (i.waitingFor ?? '').trim()

  // 1. Waiting on a person. A tool hook fires just before a permission prompt,
  //    so this has to be decided before "a tool ran a moment ago".
  if (state === 'blocked') return { working: false, needsInput: true, waitingFor, basis: 'cli-blocked' }
  if (status === 'waiting' && waitingFor) return { working: false, needsInput: true, waitingFor, basis: 'cli-blocked' }

  // 2. A tool ran moments ago: the process poll may simply not have caught up.
  const hookIsTool = i.lastHookAt !== undefined && i.lastHookEvent !== 'Stop'
  if (hookIsTool && i.now - (i.lastHookAt as number) < HOOK_FRESH_MS) {
    return { working: true, needsInput: false, waitingFor: '', basis: 'hook-activity' }
  }

  // 3. The session state, then 4. the process status.
  if (state === 'working') return { working: true, needsInput: false, waitingFor: '', basis: 'cli-state' }
  if (state === 'done' || state === 'failed' || state === 'stopped') return { working: false, needsInput: false, waitingFor: '', basis: 'cli-state' }
  if (status === 'busy') return { working: true, needsInput: false, waitingFor: '', basis: 'cli-status' }
  if (status === 'idle' || status === 'waiting') return { working: false, needsInput: false, waitingFor: '', basis: 'cli-status' }

  // 5. Nothing usable (missing, or a value this build does not know): only evidence counts.
  const recent = hookIsTool && i.now - (i.lastHookAt as number) < HOOK_RECENT_MS
  return { working: recent, needsInput: false, waitingFor: '', basis: recent ? 'hook-activity' : 'no-signal' }
}

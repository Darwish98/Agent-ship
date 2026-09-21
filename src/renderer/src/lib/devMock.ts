// Dev-only stand-in for the preload bridge, so the renderer can be opened in
// a plain browser (no Electron, no Claude Code) while working on the UI.
// Guarded by import.meta.env.DEV at the call site, so it never ships.
import type {
  AgentEvent,
  AgentShipApi,
  GitState,
  Project,
  SessionSummary,
  Settings
} from '../../../preload'
import { slugify, usdCeiling } from '../../../shared/blueprint'
import { buildLandBlueprint, fromPattern, LAND_FLOW, PATTERNS } from '../../../shared/patterns'
import type { RunEvent } from '../../../shared/runs'
import { parseBlueprint, type Blueprint } from '../../../shared/schema'

const projects: Project[] = [
  { id: 'p1', name: 'frontend-app', path: 'C:/dev/frontend-app' },
  { id: 'p2', name: 'api-server', path: 'C:/dev/api-server' },
  { id: 'p3', name: 'infra-tools', path: 'C:/dev/infra-tools' }
]

const now = Date.now()

const sessions: SessionSummary[] = [
  {
    sessionId: 's-nova',
    cwd: 'C:/dev/frontend-app',
    gitBranch: 'feat/dashboard-redesign',
    title: 'Dashboard redesign',
    lastPrompt: 'Restyle the dashboard cards',
    model: 'claude-opus-5',
    entrypoint: 'claude-desktop',
    updatedAt: now - 40_000,
    contextTokens: 180_000,
    contextLimit: 1_000_000,
    billedTokens: 0,
    isSidechain: false
  },
  {
    sessionId: 's-vega',
    cwd: 'C:/dev/frontend-app',
    gitBranch: 'main',
    title: 'Bug triage',
    lastPrompt: 'Look at the failing snapshot tests',
    model: 'claude-sonnet-5',
    entrypoint: 'cli',
    updatedAt: now - 3 * 60 * 60 * 1000,
    contextTokens: 910_000,
    contextLimit: 1_000_000,
    billedTokens: 0,
    isSidechain: false
  },
  {
    sessionId: 's-atlas',
    cwd: 'C:/dev/api-server',
    gitBranch: 'feat/auth-middleware',
    title: 'Auth middleware',
    lastPrompt: 'Add refresh-token rotation',
    model: 'claude-opus-5',
    entrypoint: 'claude-desktop',
    updatedAt: now - 90_000,
    contextTokens: 420_000,
    contextLimit: 1_000_000,
    billedTokens: 0,
    isSidechain: false
  },
  {
    sessionId: 's-echo',
    cwd: 'C:/dev/api-server',
    gitBranch: 'test/regression-suite',
    title: 'QA regression suite',
    lastPrompt: 'Write regression tests for the login flow',
    model: 'claude-sonnet-5',
    entrypoint: 'cli',
    updatedAt: now - 26 * 60 * 60 * 1000,
    contextTokens: 640_000,
    contextLimit: 1_000_000,
    billedTokens: 0,
    isSidechain: false
  },
  {
    sessionId: 's-juno',
    cwd: 'C:/dev/infra-tools',
    gitBranch: 'ops/ci-pipeline',
    title: 'DevOps: CI pipeline',
    lastPrompt: 'Fix the flaky deploy step',
    model: 'claude-opus-5',
    entrypoint: 'claude-desktop',
    updatedAt: now - 20 * 60 * 1000,
    contextTokens: 95_000,
    contextLimit: 1_000_000,
    billedTokens: 0,
    isSidechain: false
  }
]

const gitStates: Record<string, GitState> = {
  'C:/dev/frontend-app': {
    isRepo: true,
    head: 'a1b2c3d',
    branch: 'feat/dashboard-redesign',
    baseBranch: 'main',
    ahead: 3,
    dirtyFiles: 2,
    hasUnmergedWork: true
  },
  'C:/dev/api-server': {
    isRepo: true,
    head: 'a1b2c3d',
    branch: 'feat/auth-middleware',
    baseBranch: 'main',
    ahead: 5,
    dirtyFiles: 0,
    hasUnmergedWork: true
  },
  'C:/dev/infra-tools': {
    isRepo: true,
    head: 'a1b2c3d',
    branch: 'ops/ci-pipeline',
    baseBranch: 'main',
    ahead: 0,
    dirtyFiles: 0,
    hasUnmergedWork: false
  }
}

let settings: Settings = { weeklyTokenBudget: 50_000_000 }
let hiddenIds: string[] = []
export function installDevMock(): void {
  const listeners: ((e: AgentEvent) => void)[] = []

  const emit = (partial: Partial<AgentEvent>): void => {
    const event: AgentEvent = {
      sessionId: 's-nova',
      agentId: '',
      agentName: 'nova',
      role: 'Frontend engineer',
      task: 'Restyle the dashboard',
      project: 'frontend-app',
      projectPath: 'C:/dev/frontend-app',
      hookEvent: 'PreToolUse',
      toolName: 'Edit',
      status: '',
      subagentDoneId: '',
      timestamp: Date.now(),
      ...partial
    }
    for (const l of listeners) l(event)
  }

  // In-memory stand-in for <repo>/.agentship/flows, validated by the same
  // schema the real store uses.
  const flowStore = new Map<string, { blueprint: Blueprint; hash: string }>()
  const flowKey = (projectId: string, slug: string): string => `${projectId}/${slug}`
  let hashCounter = 0

  // Runs: seeded history plus a live one that progresses on a timer.
  const runLog = new Map<string, RunEvent[]>()
  const runListeners: ((e: RunEvent) => void)[] = []
  const gateResolvers = new Map<string, (approve: boolean) => void>()
  const pushRun = (e: RunEvent): void => {
    runLog.set(e.runId, [...(runLog.get(e.runId) ?? []), e])
    for (const l of runListeners) l(e)
  }
  let runSeq = 0
  const newRunId = (): string => `00000000-0000-4000-8000-${String(++runSeq).padStart(12, '0')}`

  // A landing that walks its steps and then stops in a conflict, so the failure state can be seen.
  const simulateLand = (project: Project, bp: Blueprint, branch: string): string => {
    const runId = newRunId()
    pushRun({ type: 'run.started', at: Date.now(), runId, projectId: project.id, projectName: project.name, projectPath: project.path, flowSlug: LAND_FLOW, blueprint: bp, inputs: { branch }, ceilingUsd: usdCeiling(bp) ?? 0 })
    const ids = bp.nodes.filter((n) => n.kind !== 'trigger').map((n) => n.id)
    let i = 0
    const step = (): void => {
      const id = ids[i]
      if (!id) {
        pushRun({ type: 'run.finished', at: Date.now(), runId, status: 'passed', reason: 'Finished every step.', branch })
        return
      }
      const n = bp.nodes.find((x) => x.id === id)!
      pushRun({ type: 'node.started', at: Date.now(), runId, nodeId: id, attempt: 1, cwd: '/w' })
      setTimeout(() => {
        if (n.kind === 'gate') pushRun({ type: 'gate.result', at: Date.now(), runId, nodeId: id, attempt: 1, pass: true, by: 'command', detail: 'exit 0\n24 passed' })
        else pushRun({ type: 'node.finished', at: Date.now(), runId, nodeId: id, attempt: 1, status: 'passed', costUsd: 0, tokens: 0, summary: n.kind === 'merge' ? `Merged ${branch} into a scratch copy of main with no conflicts.` : 'main is now at 4f2a9c1.' })
        i++
        step()
      }, 1800)
    }
    step()
    return runId
  }

  const simulateRun = (project: Project, slug: string, bp: Blueprint, inputs: Record<string, string>, hold = false): string => {
    const runId = newRunId()
    const t0 = Date.now()
    pushRun({ type: 'run.started', at: t0, runId, projectId: project.id, projectName: project.name, projectPath: project.path, flowSlug: slug, blueprint: bp, inputs, ceilingUsd: usdCeiling(bp) ?? 0 })
    const steps = bp.nodes.filter((n) => n.kind === 'agent' || n.kind === 'gate')
    let i = 0
    const tick = (): void => {
      const n = steps[i]
      if (!n) {
        pushRun({ type: 'run.finished', at: Date.now(), runId, status: 'passed', reason: 'Finished every step.', branch: 'agentship/sim-build' })
        return
      }
      pushRun({ type: 'node.started', at: Date.now(), runId, nodeId: n.id, attempt: 1, cwd: '/w', branch: n.kind === 'agent' && n.config.worktree ? 'agentship/sim-build' : undefined, sessionId: `sim-${runId}-${n.id}` })
      setTimeout(() => {
        if (n.kind === 'gate') {
          if (hold && n.config.check !== 'command') return
          pushRun({ type: 'gate.result', at: Date.now(), runId, nodeId: n.id, attempt: 1, pass: true, by: 'command', detail: 'exit 0\n12 tests passed' })
        } else {
          pushRun({ type: 'node.finished', at: Date.now(), runId, nodeId: n.id, attempt: 1, status: 'passed', costUsd: 0.21, tokens: 41_000, summary: `${n.label} finished.`, branch: n.config.worktree ? 'agentship/sim-build' : undefined })
        }
        i++
        tick()
      }, 2500)
    }
    tick()
    return runId
  }

  const api: AgentShipApi = {
    onAgentEvent: (cb) => {
      listeners.push(cb)
      return () => listeners.splice(listeners.indexOf(cb), 1)
    },
    listProjects: async () => projects,
    addProject: async () => projects,
    removeProject: async (id) => projects.filter((p) => p.id !== id),
    getSettings: async () => settings,
    setSettings: async (patch) => (settings = { ...settings, ...patch }),
    listSessions: async () => sessions,
    listRunning: async () => [
      {
        pid: 1234,
        cwd: 'C:/dev/frontend-app',
        kind: 'interactive',
        sessionId: 's-nova',
        name: 'nova',
        startedAt: now - 600_000
      }
    ],
    getHidden: async () => hiddenIds,
    setHidden: async (ids) => (hiddenIds = ids),
    openSession: async () => ({ ok: true }),
    stopAgent: async () => ({ ok: true }),
    weeklyUsage: async () => ({ weeklyTokens: 31_400_000, since: now - 7 * 864e5 }),
    gitState: async (cwd) =>
      gitStates[cwd] ?? {
        isRepo: false,
        branch: '',
        head: '',
        baseBranch: '',
        ahead: 0,
        dirtyFiles: 0,
        hasUnmergedWork: false
      },
    unmergedBranches: async (cwd) => {
      const ago = (h: number): number => now - h * 3_600_000
      if (cwd === 'C:/dev/frontend-app') {
        return [
          { branch: 'agentship/a1b2c3d4-build', ahead: 3, lastCommitAt: ago(2), subject: 'agentship: Builder (Plan → build → test → review)' },
          { branch: 'feat/dashboard-redesign', ahead: 3, lastCommitAt: ago(30), subject: 'Restyle dashboard cards' }
        ]
      }
      if (cwd === 'C:/dev/api-server') {
        return [
          { branch: 'feat/auth-middleware', ahead: 5, lastCommitAt: ago(5), subject: 'Add refresh-token rotation' },
          { branch: 'test/regression-suite', ahead: 1, lastCommitAt: ago(24 * 20), subject: 'Login regression tests' }
        ]
      }
      return []
    },
    branchSummary: async () => ({ files: 7, added: 212, removed: 34 }),
    workPlan: async (_projectId, cwd) => ({
      ok: true,
      checkout: cwd,
      currentBranch: 'main',
      baseBranch: 'main',
      files: 11,
      mode: 'on-base',
      testCommand: 'npm test',
      testSource: 'package.json "test" script'
    }),
    landWork: async (projectId, _cwd, _sessionId, base, testCommand, resolveConflicts) => {
      const project = projects.find((x) => x.id === projectId)!
      return { ok: true, runId: simulateLand(project, buildLandBlueprint({ branch: 'agentship/work-demo', base, testCommand, resolveConflicts }), 'agentship/work-demo') }
    },
    landPlan: async () => ({
      ok: true,
      baseBranch: 'main',
      testCommand: 'npm test',
      testSource: 'package.json "test" script',
      baseCheckedOutAt: 'C:/dev/frontend-app',
      baseHasUncommittedChanges: false
    }),
    landBranch: async (projectId, branch, base, testCommand, resolveConflicts) => {
      const project = projects.find((x) => x.id === projectId)!
      return { ok: true, runId: simulateLand(project, buildLandBlueprint({ branch, base, testCommand, resolveConflicts }), branch) }
    },
    addProjectPath: async () => projects,
    listFlows: async (projectId) =>
      [...flowStore]
        .filter(([k]) => k.startsWith(`${projectId}/`))
        .map(([k, f]) => ({
          slug: k.slice(projectId.length + 1),
          name: f.blueprint.name,
          description: f.blueprint.description,
          nodeCount: f.blueprint.nodes.length
        })),
    loadFlow: async (projectId, slug) => {
      const f = flowStore.get(flowKey(projectId, slug))
      return f ? { ok: true, blueprint: f.blueprint, hash: f.hash } : { ok: false, error: 'No such flow.' }
    },
    saveFlow: async (projectId, slug, blueprint, expected) => {
      const parsed = parseBlueprint(blueprint)
      if (!parsed.ok) return { ok: false, error: parsed.error }
      const cur = flowStore.get(flowKey(projectId, slug))
      if (expected !== undefined && (cur?.hash ?? null) !== expected) {
        return { ok: false, conflict: true, error: 'This flow changed on disk since you opened it.' }
      }
      const hash = `h${++hashCounter}`
      flowStore.set(flowKey(projectId, slug), { blueprint: parsed.blueprint, hash })
      return { ok: true, blueprint: parsed.blueprint, hash }
    },
    peekFlow: async (projectId, slug) => flowStore.get(flowKey(projectId, slug))?.hash ?? null,
    deleteFlow: async (projectId, slug) => {
      flowStore.delete(flowKey(projectId, slug))
      return { ok: true }
    },
    listRuns: async () => [...runLog].map(([runId, events]) => ({ runId, events })),
    startRun: async (projectId, slug, inputs) => {
      const f = flowStore.get(flowKey(projectId, slug))
      if (!f) return { ok: false, error: 'No such flow.' }
      const project = projects.find((x) => x.id === projectId)!
      return { ok: true, runId: simulateRun(project, slug, f.blueprint, inputs) }
    },
    cancelRun: async (runId) => {
      pushRun({ type: 'run.finished', at: Date.now(), runId, status: 'cancelled', reason: 'Stopped by you.' })
      return true
    },
    resumeRun: async () => ({ ok: false, error: 'Resuming needs the real app; the browser preview has no engine.' }),
    decideGate: async (runId, approve) => {
      gateResolvers.get(runId)?.(approve)
      return true
    },
    onRunEvent: (cb) => {
      runListeners.push(cb)
      return () => runListeners.splice(runListeners.indexOf(cb), 1)
    },
    logError: async (message) => {
      console.error('[renderer error]', message)
      return '(dev mock: no log file)'
    },
    spawnAgent: async () => ({ ok: true }),
    resumeSession: async () => ({ ok: true })
  }

  window.agentShip = api

  // Seed flows and history so the Floor has something to show.
  for (const p of projects.slice(0, 2)) {
    for (const pattern of [PATTERNS[0], PATTERNS[2]]) {
      flowStore.set(flowKey(p.id, slugify(pattern.name)), { blueprint: fromPattern(pattern), hash: `h${++hashCounter}` })
    }
  }
  const pipeline = fromPattern(PATTERNS[2])
  const frontend = projects[0]
  const seed = (runId: string, ev: RunEvent[]): void => void runLog.set(runId, ev)
  {
    // 1. A passed run whose gate proved its branch: "verified".
    const id = newRunId()
    const t = Date.now() - 2 * 3_600_000
    seed(id, [
      { type: 'run.started', at: t, runId: id, projectId: frontend.id, projectName: frontend.name, projectPath: frontend.path, flowSlug: 'plan-build-test-review', blueprint: pipeline, inputs: { task: 'Add a dark-mode toggle' }, ceilingUsd: 5 },
      { type: 'node.started', at: t + 1, runId: id, nodeId: 'plan', attempt: 1, cwd: '/w', sessionId: 'seed-plan' },
      { type: 'node.finished', at: t + 2, runId: id, nodeId: 'plan', attempt: 1, status: 'passed', costUsd: 0.18, tokens: 38000, summary: '1. Add ThemeContext\n2. Toggle in header' },
      { type: 'node.started', at: t + 3, runId: id, nodeId: 'build', attempt: 1, cwd: '/w', branch: 'agentship/a1b2c3d4-build', sessionId: 'seed-build' },
      { type: 'node.finished', at: t + 4, runId: id, nodeId: 'build', attempt: 1, status: 'passed', costUsd: 0.62, tokens: 91000, summary: 'Added the toggle.', branch: 'agentship/a1b2c3d4-build' },
      { type: 'gate.result', at: t + 5, runId: id, nodeId: 'tests', attempt: 1, pass: true, by: 'command', detail: 'exit 0\n24 passed' },
      { type: 'node.started', at: t + 6, runId: id, nodeId: 'review', attempt: 1, cwd: '/w', sessionId: 'seed-review' },
      { type: 'node.finished', at: t + 7, runId: id, nodeId: 'review', attempt: 1, status: 'passed', costUsd: 0.12, tokens: 20000, summary: 'Looks good.' },
      { type: 'run.finished', at: t + 8, runId: id, status: 'passed', reason: 'Finished every step.', branch: 'agentship/a1b2c3d4-build' }
    ])
  }
  {
    // 2. A run that could not get its tests green: needs a person.
    const id = newRunId()
    const t = Date.now() - 50 * 60_000
    const api2 = projects[1]
    seed(id, [
      { type: 'run.started', at: t, runId: id, projectId: api2.id, projectName: api2.name, projectPath: api2.path, flowSlug: 'plan-build-test-review', blueprint: pipeline, inputs: { task: 'Rate-limit the login route' }, ceilingUsd: 5 },
      { type: 'node.finished', at: t + 2, runId: id, nodeId: 'plan', attempt: 1, status: 'passed', costUsd: 0.2, tokens: 30000, summary: 'plan' },
      { type: 'node.started', at: t + 3, runId: id, nodeId: 'build', attempt: 1, cwd: '/w', branch: 'agentship/9f8e7d6c-build', sessionId: 'seed-b2' },
      { type: 'node.finished', at: t + 4, runId: id, nodeId: 'build', attempt: 1, status: 'passed', costUsd: 0.9, tokens: 120000, summary: 'built', branch: 'agentship/9f8e7d6c-build' },
      { type: 'gate.result', at: t + 5, runId: id, nodeId: 'tests', attempt: 1, pass: false, by: 'command', detail: 'exit 1\nFAIL rate-limit.test.ts: expected 429, got 200' },
      { type: 'node.started', at: t + 6, runId: id, nodeId: 'build', attempt: 2, cwd: '/w', sessionId: 'seed-b2' },
      { type: 'node.finished', at: t + 7, runId: id, nodeId: 'build', attempt: 2, status: 'passed', costUsd: 0.4, tokens: 50000, summary: 'attempted a fix' },
      { type: 'gate.result', at: t + 8, runId: id, nodeId: 'tests', attempt: 2, pass: false, by: 'command', detail: 'exit 1\nFAIL rate-limit.test.ts: expected 429, got 200' },
      { type: 'run.finished', at: t + 9, runId: id, status: 'failed', reason: 'Gate "Tests pass" still failing after 2 attempts (retry cap 1).', branch: 'agentship/9f8e7d6c-build' }
    ])
  }
  // 3. One that is running right now, and keeps going while you watch.
  setTimeout(() => simulateRun(frontend, 'plan-build-test-review', fromPattern(PATTERNS[2]), { task: 'Add keyboard shortcuts' }), 800)

  // A trickle of live activity so the world doesn't look frozen.
  const script: Partial<AgentEvent>[] = [
    { sessionId: 's-nova', agentName: 'nova', toolName: 'Edit' },
    {
      sessionId: 's-atlas',
      agentName: 'atlas',
      role: 'Backend dev',
      projectPath: 'C:/dev/api-server',
      toolName: 'Bash'
    },
    {
      sessionId: 's-juno',
      agentName: 'juno',
      role: 'DevOps',
      projectPath: 'C:/dev/infra-tools',
      toolName: 'Read'
    },
    { sessionId: 's-nova', agentName: 'nova', hookEvent: 'UserPromptSubmit', toolName: '' }
  ]
  let i = 0
  setTimeout(() => script.forEach((s) => emit(s)), 400)
  setInterval(() => emit(script[i++ % script.length]), 5000)
}

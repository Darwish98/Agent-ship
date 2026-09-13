// Dev-only stand-in for the preload bridge, so the renderer can be opened in
// a plain browser (no Electron, no Claude Code) while working on the UI.
// Guarded by import.meta.env.DEV at the call site, so it never ships.
import type {
  AgentEvent,
  AgentShipApi,
  GitState,
  OrchestratorLink,
  Project,
  SessionSummary,
  Settings
} from '../../../preload'

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
    branch: 'feat/dashboard-redesign',
    baseBranch: 'main',
    ahead: 3,
    dirtyFiles: 2,
    hasUnmergedWork: true
  },
  'C:/dev/api-server': {
    isRepo: true,
    branch: 'feat/auth-middleware',
    baseBranch: 'main',
    ahead: 5,
    dirtyFiles: 0,
    hasUnmergedWork: true
  },
  'C:/dev/infra-tools': {
    isRepo: true,
    branch: 'ops/ci-pipeline',
    baseBranch: 'main',
    ahead: 0,
    dirtyFiles: 0,
    hasUnmergedWork: false
  }
}

let settings: Settings = { weeklyTokenBudget: 50_000_000 }
// One example link so the orchestrator wiring is visible while developing.
let links: OrchestratorLink[] = [{ from: 'orchestrator', to: 's-nova' }]

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
    getLinks: async () => links,
    setLinks: async (next) => (links = next),
    listSessions: async () => sessions,
    weeklyUsage: async () => ({ weeklyTokens: 31_400_000, since: now - 7 * 864e5 }),
    gitState: async (cwd) =>
      gitStates[cwd] ?? {
        isRepo: false,
        branch: '',
        baseBranch: '',
        ahead: 0,
        dirtyFiles: 0,
        hasUnmergedWork: false
      },
    unmergedBranches: async (cwd) =>
      cwd === 'C:/dev/frontend-app'
        ? [{ branch: 'feat/dashboard-redesign', ahead: 3 }]
        : cwd === 'C:/dev/api-server'
          ? [
              { branch: 'feat/auth-middleware', ahead: 5 },
              { branch: 'test/regression-suite', ahead: 1 }
            ]
          : [],
    spawnAgent: async () => ({ ok: true }),
    resumeSession: async () => ({ ok: true }),
    spawnOrchestrator: async () => ({ ok: true }),
    mergeAll: async () => ({ ok: true })
  }

  window.agentShip = api

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

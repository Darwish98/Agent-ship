import { contextBridge, ipcRenderer } from 'electron'
import type { RunEvent } from '../shared/runs'
import type { Blueprint } from '../shared/schema'

export interface Project {
  id: string
  name: string
  path: string
}

export interface Settings {
  weeklyTokenBudget: number
}

export interface SessionSummary {
  sessionId: string
  cwd: string
  gitBranch: string
  title: string
  lastPrompt: string
  model: string
  entrypoint: string
  updatedAt: number
  contextTokens: number
  contextLimit: number
  billedTokens: number
  isSidechain: boolean
}

export interface UsageWindow {
  weeklyTokens: number
  since: number
}

export interface RunningAgent {
  pid: number
  cwd: string
  kind: string
  sessionId: string
  name: string
  startedAt: number
  status?: string
  state?: string
  waitingFor?: string
}

export interface GitState {
  isRepo: boolean
  branch: string
  baseBranch: string
  ahead: number
  dirtyFiles: number
  hasUnmergedWork: boolean
}

export interface AgentEvent {
  sessionId: string
  agentId: string
  agentName: string
  role: string
  task: string
  project: string
  projectPath: string
  hookEvent: string
  toolName: string
  status: string
  subagentDoneId: string
  timestamp: number
}

export interface FlowSummary {
  slug: string
  name: string
  description: string
  nodeCount: number
  error?: string
}

export type FlowResult<T> = ({ ok: true } & T) | { ok: false; error: string; conflict?: boolean }

export interface BranchInfo {
  branch: string
  ahead: number
  lastCommitAt: number
  subject: string
}

export type LandPlan =
  | {
      ok: true
      baseBranch: string
      testCommand: string
      testSource: string
      baseCheckedOutAt: string | null
      baseHasUncommittedChanges: boolean
    }
  | { ok: false; error: string }

export type StartRunResult = { ok: true; runId: string } | { ok: false; error: string }

export interface SpawnResult {
  ok: boolean
  error?: string
}

const api = {
  onAgentEvent: (cb: (event: AgentEvent) => void): (() => void) => {
    const listener = (_e: unknown, event: AgentEvent): void => cb(event)
    ipcRenderer.on('agent-event', listener)
    return () => ipcRenderer.removeListener('agent-event', listener)
  },

  listProjects: (): Promise<Project[]> => ipcRenderer.invoke('shipyard:list'),
  addProject: (): Promise<Project[]> => ipcRenderer.invoke('shipyard:addProject'),
  /** Register a folder that is already a git repo (no dialog). */
  addProjectPath: (path: string): Promise<Project[]> => ipcRenderer.invoke('shipyard:addPath', path),
  removeProject: (id: string): Promise<Project[]> =>
    ipcRenderer.invoke('shipyard:removeProject', id),

  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke('settings:set', patch),

  listSessions: (): Promise<SessionSummary[]> => ipcRenderer.invoke('sessions:list'),
  listRunning: (): Promise<RunningAgent[]> => ipcRenderer.invoke('sessions:running'),
  weeklyUsage: (): Promise<UsageWindow> => ipcRenderer.invoke('usage:weekly'),

  getHidden: (): Promise<string[]> => ipcRenderer.invoke('sessions:hidden'),
  setHidden: (ids: string[]): Promise<string[]> => ipcRenderer.invoke('sessions:setHidden', ids),

  openSession: (sessionId: string): Promise<SpawnResult> =>
    ipcRenderer.invoke('agent:open', sessionId),
  stopAgent: (pid: number): Promise<SpawnResult> => ipcRenderer.invoke('agent:stop', pid),

  gitState: (cwd: string): Promise<GitState> => ipcRenderer.invoke('git:state', cwd),
  unmergedBranches: (cwd: string): Promise<BranchInfo[]> =>
    ipcRenderer.invoke('git:unmergedBranches', cwd),

  listFlows: (projectId: string): Promise<FlowSummary[]> =>
    ipcRenderer.invoke('flows:list', projectId),
  loadFlow: (
    projectId: string,
    slug: string
  ): Promise<FlowResult<{ blueprint: Blueprint; hash: string }>> =>
    ipcRenderer.invoke('flows:load', { projectId, slug }),
  /** `expected`: hash last seen (string), null = must not exist, undefined = overwrite. */
  saveFlow: (
    projectId: string,
    slug: string,
    blueprint: Blueprint,
    expected?: string | null
  ): Promise<FlowResult<{ blueprint: Blueprint; hash: string }>> =>
    ipcRenderer.invoke('flows:save', { projectId, slug, blueprint, expected }),
  peekFlow: (projectId: string, slug: string): Promise<string | null> =>
    ipcRenderer.invoke('flows:peek', { projectId, slug }),

  listRuns: (): Promise<{ runId: string; events: RunEvent[] }[]> => ipcRenderer.invoke('runs:list'),
  startRun: (projectId: string, slug: string, inputs: Record<string, string>): Promise<StartRunResult> =>
    ipcRenderer.invoke('runs:start', { projectId, slug, inputs }),
  landPlan: (projectId: string, branch: string): Promise<LandPlan> => ipcRenderer.invoke('land:plan', { projectId, branch }),
  landBranch: (
    projectId: string,
    branch: string,
    baseBranch: string,
    testCommand: string,
    resolveConflicts: boolean
  ): Promise<StartRunResult> =>
    ipcRenderer.invoke('runs:land', { projectId, branch, baseBranch, testCommand, resolveConflicts }),
  cancelRun: (runId: string): Promise<boolean> => ipcRenderer.invoke('runs:cancel', runId),
  decideGate: (runId: string, approve: boolean, note: string): Promise<boolean> =>
    ipcRenderer.invoke('runs:decide', { runId, approve, note }),
  onRunEvent: (cb: (event: RunEvent) => void): (() => void) => {
    const listener = (_e: unknown, event: RunEvent): void => cb(event)
    ipcRenderer.on('run-event', listener)
    return () => ipcRenderer.removeListener('run-event', listener)
  },
  branchSummary: (
    cwd: string,
    base: string,
    branch: string
  ): Promise<{ files: number; added: number; removed: number }> =>
    ipcRenderer.invoke('git:branchSummary', { cwd, base, branch }),
  deleteFlow: (projectId: string, slug: string): Promise<FlowResult<object>> =>
    ipcRenderer.invoke('flows:delete', { projectId, slug }),
  logError: (message: string): Promise<string> => ipcRenderer.invoke('log:error', message),

  spawnAgent: (projectPath: string, role: string, task: string): Promise<SpawnResult> =>
    ipcRenderer.invoke('agent:spawn', { projectPath, role, task }),
  resumeSession: (sessionId: string, cwd: string, task: string): Promise<SpawnResult> =>
    ipcRenderer.invoke('agent:resume', { sessionId, cwd, task })
}

export type AgentShipApi = typeof api

contextBridge.exposeInMainWorld('agentShip', api)

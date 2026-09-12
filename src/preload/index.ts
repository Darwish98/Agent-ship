import { contextBridge, ipcRenderer } from 'electron'

export interface Project {
  id: string
  name: string
  path: string
}

export interface Settings {
  weeklyTokenBudget: number
}

export interface OrchestratorLink {
  from: string
  to: string
}

export interface SessionSummary {
  sessionId: string
  cwd: string
  gitBranch: string
  title: string
  lastPrompt: string
  model: string
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
  removeProject: (id: string): Promise<Project[]> =>
    ipcRenderer.invoke('shipyard:removeProject', id),

  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke('settings:set', patch),

  getLinks: (): Promise<OrchestratorLink[]> => ipcRenderer.invoke('links:get'),
  setLinks: (links: OrchestratorLink[]): Promise<OrchestratorLink[]> =>
    ipcRenderer.invoke('links:set', links),

  listSessions: (): Promise<SessionSummary[]> => ipcRenderer.invoke('sessions:list'),
  weeklyUsage: (): Promise<UsageWindow> => ipcRenderer.invoke('usage:weekly'),

  gitState: (cwd: string): Promise<GitState> => ipcRenderer.invoke('git:state', cwd),
  unmergedBranches: (cwd: string): Promise<{ branch: string; ahead: number }[]> =>
    ipcRenderer.invoke('git:unmergedBranches', cwd),

  spawnAgent: (projectPath: string, role: string, task: string): Promise<SpawnResult> =>
    ipcRenderer.invoke('agent:spawn', { projectPath, role, task }),
  resumeSession: (sessionId: string, cwd: string, task: string): Promise<SpawnResult> =>
    ipcRenderer.invoke('agent:resume', { sessionId, cwd, task }),
  spawnOrchestrator: (projectPath: string, brief: string): Promise<SpawnResult> =>
    ipcRenderer.invoke('agent:orchestrate', { projectPath, brief }),
  mergeAll: (projectPath: string, baseBranch: string, branches: string[]): Promise<SpawnResult> =>
    ipcRenderer.invoke('agent:mergeAll', { projectPath, baseBranch, branches })
}

export type AgentShipApi = typeof api

contextBridge.exposeInMainWorld('agentShip', api)

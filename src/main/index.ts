import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import path from 'node:path'
import {
  listRunningAgents,
  openSession,
  resumeSession,
  spawnAgent,
  stopAgent
} from './agents'
import { ClaudeCodeAdapter } from './engine/adapter'
import { detectTestCommand, diffSummary, isClean, refExists, worktreeHolding } from './engine/gitops'
import { buildLandBlueprint, LAND_FLOW } from '../shared/patterns'
import { RunEngine, worktreeRootFor } from './engine/runner'
import { RunStore } from './engine/store'
import { deleteFlow, listFlows, loadFlow, peekFlow, saveFlow } from './flows'
import { gitState, unmergedBranches } from './git'
import { installHooks } from './hooks'
import { installCrashLogging, log, logPath } from './log'
import { startServer, type AgentEvent } from './server'
import * as shipyard from './shipyard'
import { listSessions, weeklyUsage } from './transcripts'

let mainWindow: BrowserWindow | null = null

/** Conservative on purpose: these end up in git commands and run labels. */
const BRANCH_NAME = /^[A-Za-z0-9._/@#+-]{1,200}$/
let engine: RunEngine | null = null
let runStore: RunStore | null = null

app.setName('Agent Ship')
installCrashLogging()

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
  process.exit(0)
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

function userDataDir(): string {
  return app.getPath('userData')
}

// In the packaged app there is no guarantee the user has Node.js installed
// separately, so hooks point at the app's own bundled runtime, run in plain
// Node mode via ELECTRON_RUN_AS_NODE.
function resolveHookCommand(): string {
  const bridgePath = app.isPackaged
    ? path.join(process.resourcesPath, 'hooks', 'bridge.js')
    : path.join(app.getAppPath(), 'hooks', 'bridge.js')

  if (!app.isPackaged) return `node "${bridgePath}"`

  const execPath = process.execPath
  // No outer `cmd /c "..."` wrapper: whatever invokes this command string
  // already runs it through a shell. Adding a manual wrapper double-nests
  // cmd.exe and the escaped inner quotes don't survive the second parse.
  return process.platform === 'win32'
    ? `set ELECTRON_RUN_AS_NODE=1&& "${execPath}" "${bridgePath}"`
    : `ELECTRON_RUN_AS_NODE=1 "${execPath}" "${bridgePath}"`
}

function ensureHooksInstalled(): void {
  // Test runs (scripts/smoke.mjs) must not touch the user's global settings.
  if (process.env.AGENT_SHIP_SKIP_HOOKS) return
  try {
    const result = installHooks(resolveHookCommand())
    if (!result.ok && result.reason === 'claude-not-found') {
      console.log('Claude Code not found - hooks not installed. Install it and relaunch.')
    }
  } catch (err) {
    console.error('Could not install Claude Code hooks:', err)
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#F5F4EE',
    title: 'Agent Ship',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Anything trying to open a new window goes to the real browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('shipyard:list', () => shipyard.loadProjects(userDataDir()))

  ipcMain.handle('shipyard:addProject', async () => {
    if (!mainWindow) return shipyard.loadProjects(userDataDir())
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add a project room',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return shipyard.loadProjects(userDataDir())
    return shipyard.addProject(userDataDir(), result.filePaths[0])
  })

  ipcMain.handle('shipyard:addPath', (_evt, projectPath: string) =>
    shipyard.addProjectIfRepo(userDataDir(), String(projectPath))
  )

  ipcMain.handle('shipyard:removeProject', (_evt, id: string) =>
    shipyard.removeProject(userDataDir(), id)
  )

  ipcMain.handle('settings:get', () => shipyard.loadSettings(userDataDir()))
  ipcMain.handle('settings:set', (_evt, patch: Partial<shipyard.Settings>) =>
    shipyard.saveSettings(userDataDir(), patch)
  )

  ipcMain.handle('flows:list', (_evt, projectId: string) => listFlows(userDataDir(), projectId))
  ipcMain.handle('flows:load', (_evt, a: { projectId: string; slug: string }) =>
    loadFlow(userDataDir(), a.projectId, a.slug)
  )
  ipcMain.handle(
    'flows:save',
    (_evt, a: { projectId: string; slug: string; blueprint: unknown; expected?: string | null }) =>
      saveFlow(userDataDir(), a.projectId, a.slug, a.blueprint, a.expected)
  )
  ipcMain.handle('flows:peek', (_evt, a: { projectId: string; slug: string }) =>
    peekFlow(userDataDir(), a.projectId, a.slug)
  )
  ipcMain.handle('flows:delete', (_evt, a: { projectId: string; slug: string }) =>
    deleteFlow(userDataDir(), a.projectId, a.slug)
  )

  // Runs. The renderer names a project and a flow; the engine reads the
  // blueprint from disk itself, so it only ever executes what is in the repo.
  ipcMain.handle('runs:list', () => runStore?.list() ?? [])
  ipcMain.handle(
    'runs:start',
    async (_evt, a: { projectId: string; slug: string; inputs: Record<string, string> }) => {
      if (!engine) return { ok: false, error: 'The run engine is not ready.' }
      const project = shipyard.loadProjects(userDataDir()).find((p) => p.id === a.projectId)
      if (!project) return { ok: false, error: 'Unknown project.' }
      const flow = loadFlow(userDataDir(), a.projectId, a.slug)
      if (!flow.ok) return { ok: false, error: flow.error }
      const inputs = Object.fromEntries(
        Object.entries(a.inputs ?? {}).map(([k, v]) => [k, String(v).slice(0, 20_000)])
      )
      return engine.start({
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        flowSlug: a.slug,
        blueprint: flow.blueprint,
        inputs
      })
    }
  )
  // Landing: what it would do, then do it. The plan is computed from the repo
  // itself; the run is a normal engine run of a pipeline built here in the main
  // process, so nothing the renderer sends can change what steps exist.
  ipcMain.handle('land:plan', async (_evt, a: { projectId: string; branch: string }) => {
    const project = shipyard.loadProjects(userDataDir()).find((p) => p.id === a.projectId)
    if (!project) return { ok: false as const, error: 'Unknown project.' }
    if (!BRANCH_NAME.test(a.branch) || !(await refExists(project.path, `refs/heads/${a.branch}`))) {
      return { ok: false as const, error: `The branch "${a.branch}" no longer exists.` }
    }
    const git = await gitState(project.path)
    const baseBranch = git.baseBranch || 'main'
    const test = detectTestCommand(project.path)
    const holder = await worktreeHolding(project.path, baseBranch)
    return {
      ok: true as const,
      baseBranch,
      testCommand: test.command,
      testSource: test.source,
      baseCheckedOutAt: holder,
      baseHasUncommittedChanges: holder ? !(await isClean(holder)) : false
    }
  })
  ipcMain.handle(
    'runs:land',
    async (_evt, a: { projectId: string; branch: string; baseBranch: string; testCommand: string; resolveConflicts: boolean }) => {
      if (!engine) return { ok: false, error: 'The run engine is not ready.' }
      const project = shipyard.loadProjects(userDataDir()).find((p) => p.id === a.projectId)
      if (!project) return { ok: false, error: 'Unknown project.' }
      if (!BRANCH_NAME.test(a.branch) || !BRANCH_NAME.test(a.baseBranch)) return { ok: false, error: 'Invalid branch name.' }
      if (a.branch === a.baseBranch) return { ok: false, error: 'A branch cannot be landed on itself.' }
      const test = String(a.testCommand ?? '').trim()
      if (test.length > 1000 || /[\r\n]/.test(test)) return { ok: false, error: 'The test command must be a single line.' }
      const blueprint = buildLandBlueprint({
        branch: a.branch,
        base: a.baseBranch,
        testCommand: test,
        resolveConflicts: Boolean(a.resolveConflicts)
      })
      return engine.start({
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        flowSlug: LAND_FLOW,
        blueprint,
        inputs: { branch: a.branch }
      })
    }
  )
  ipcMain.handle('runs:cancel', (_evt, runId: string) => engine?.cancel(runId) ?? false)
  ipcMain.handle('runs:decide', (_evt, a: { runId: string; approve: boolean; note: string }) =>
    engine?.decide(a.runId, a.approve, String(a.note ?? '').slice(0, 2_000)) ?? false
  )
  ipcMain.handle('git:branchSummary', (_evt, a: { cwd: string; base: string; branch: string }) =>
    diffSummary(a.cwd, a.base, a.branch)
  )

  // The renderer's error boundary reports here so a crash leaves a trace.
  ipcMain.handle('log:error', (_evt, message: string) => {
    log.error('renderer', String(message).slice(0, 8_000))
    return logPath()
  })

  ipcMain.handle('sessions:list', () => listSessions())
  ipcMain.handle('sessions:running', () => listRunningAgents())
  ipcMain.handle('usage:weekly', () => weeklyUsage())

  ipcMain.handle('sessions:hidden', () => shipyard.loadHidden(userDataDir()))
  ipcMain.handle('sessions:setHidden', (_evt, ids: string[]) =>
    shipyard.setHidden(userDataDir(), ids)
  )

  ipcMain.handle('agent:open', (_evt, sessionId: string) => openSession(sessionId))
  ipcMain.handle('agent:stop', (_evt, pid: number) => stopAgent(pid))

  ipcMain.handle('git:state', (_evt, cwd: string) => gitState(cwd))
  ipcMain.handle('git:unmergedBranches', (_evt, cwd: string) => unmergedBranches(cwd))

  ipcMain.handle('agent:spawn', (_evt, a: { projectPath: string; role: string; task: string }) =>
    spawnAgent(a.projectPath, a.role, a.task)
  )
  ipcMain.handle('agent:resume', (_evt, a: { sessionId: string; cwd: string; task: string }) =>
    resumeSession(a.sessionId, a.cwd, a.task)
  )
}

app.whenReady().then(() => {
  ensureHooksInstalled()

  runStore = new RunStore(path.join(userDataDir(), 'runs'))
  // A run that was mid-flight when the app last closed can never finish.
  runStore.markInterrupted()
  engine = new RunEngine({
    adapter: new ClaudeCodeAdapter(),
    worktreeRoot: worktreeRootFor(userDataDir()),
    emit: (event) => {
      runStore?.append(event)
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('run-event', event)
    }
  })

  createWindow()
  registerIpcHandlers()

  // Local-only HTTP server. The hook bridge POSTs agent events here. Nothing
  // outbound, nothing authenticated - this only relays JSON that Claude Code
  // already writes locally.
  startServer((event: AgentEvent) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent-event', event)
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Stop in-flight runs so their scratch worktrees are cleaned up rather than orphaned.
app.on('before-quit', () => {
  for (const id of engine?.activeRunIds() ?? []) engine?.cancel(id)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

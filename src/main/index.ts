import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import path from 'node:path'
import { foldRun, type RunEvent } from '../shared/runs'
import {
  listRunningAgents,
  openSession,
  resumeSession,
  spawnAgent,
  spawnMergeOrchestrator,
  stopAgent
} from './agents'
import { ClaudeCodeAdapter } from './engine/adapter'
import { diffSummary, sweepWorktrees } from './engine/gitops'
import { resumableRunIds } from './engine/resume'
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

/**
 * An OS notification when a run enters "Needs you" (awaiting approval, failed,
 * out of budget) while the window is not in front. A run that ends because the
 * app is closing does not notify: the user just did that.
 */
function notifyIfNeeded(event: RunEvent): void {
  if (process.env.AGENT_SHIP_SKIP_HOOKS || !Notification.isSupported()) return
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) return
  const troubled = event.type === 'run.finished' && (event.status === 'failed' || event.status === 'budget')
  if (event.type !== 'gate.awaiting' && !troubled) return

  const view = foldRun(runStore?.read(event.runId) ?? [])
  const name = view ? `${view.blueprint.name} · ${view.projectName}` : 'A run'
  const n = new Notification({
    title: event.type === 'gate.awaiting' ? 'Approval needed' : 'A run needs you',
    body: event.type === 'gate.awaiting' ? `${name}: ${event.instructions}`.slice(0, 200) : `${name}: ${event.reason}`.slice(0, 200)
  })
  n.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  n.show()
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
  ipcMain.handle('runs:cancel', (_evt, runId: string) => engine?.cancel(runId) ?? false)
  // Only the run id crosses IPC; what resumes is the engine's own recorded log.
  ipcMain.handle('runs:resume', async (_evt, runId: string) => {
    if (!engine || !runStore) return { ok: false, error: 'The run engine is not ready.' }
    return engine.resume(runStore.read(String(runId)))
  })
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
  ipcMain.handle(
    'agent:mergeAll',
    (_evt, a: { projectPath: string; baseBranch: string; branches: string[] }) =>
      spawnMergeOrchestrator(a.projectPath, a.baseBranch, a.branches)
  )
}

app.whenReady().then(() => {
  ensureHooksInstalled()

  runStore = new RunStore(path.join(userDataDir(), 'runs'))
  // A run that was mid-flight when the app last closed can no longer proceed
  // by itself; mark it so the user can resume it.
  runStore.markInterrupted()
  engine = new RunEngine({
    adapter: new ClaudeCodeAdapter(),
    worktreeRoot: worktreeRootFor(userDataDir()),
    emit: (event) => {
      runStore?.append(event)
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('run-event', event)
      notifyIfNeeded(event)
    }
  })

  // A killed app cannot remove its scratch worktrees. Reclaim the ones no run
  // can resume in (their work is committed to the branch first).
  const resumable = resumableRunIds(runStore.list(200), Date.now())
  void sweepWorktrees(worktreeRootFor(userDataDir()), (dir) => [...resumable].some((id) => dir.startsWith(`${id.slice(0, 8)}-`)))
    .then((r) => {
      if (r.removed.length || r.skipped.length) log.info('sweep', `removed ${r.removed.length} orphaned worktree(s), left ${r.skipped.length}`)
    })
    .catch((err: Error) => log.error('sweep', err.message))

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

// Suspend in-flight runs (they become "interrupted", resumable) and let them
// commit their work and remove their scratch worktrees before the process exits.
let suspended = false
app.on('before-quit', (e) => {
  if (suspended || !engine?.activeRunIds().length) return
  e.preventDefault()
  suspended = true
  void engine.suspendAll().finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

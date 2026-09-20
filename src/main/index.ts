import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import path from 'node:path'
import {
  listRunningAgents,
  openSession,
  resumeSession,
  spawnAgent,
  spawnMergeOrchestrator,
  spawnOrchestrator,
  stopAgent
} from './agents'
import { deleteFlow, listFlows, loadFlow, saveFlow } from './flows'
import { gitState, unmergedBranches } from './git'
import { installHooks } from './hooks'
import { installCrashLogging, log, logPath } from './log'
import { startServer, type AgentEvent } from './server'
import * as shipyard from './shipyard'
import { listSessions, weeklyUsage } from './transcripts'

let mainWindow: BrowserWindow | null = null

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

  ipcMain.handle('shipyard:removeProject', (_evt, id: string) =>
    shipyard.removeProject(userDataDir(), id)
  )

  ipcMain.handle('settings:get', () => shipyard.loadSettings(userDataDir()))
  ipcMain.handle('settings:set', (_evt, patch: Partial<shipyard.Settings>) =>
    shipyard.saveSettings(userDataDir(), patch)
  )

  ipcMain.handle('links:get', () => shipyard.loadLinks(userDataDir()))
  ipcMain.handle('links:set', (_evt, links: shipyard.OrchestratorLink[]) =>
    shipyard.saveLinks(userDataDir(), links)
  )

  ipcMain.handle('flows:list', (_evt, projectId: string) => listFlows(userDataDir(), projectId))
  ipcMain.handle('flows:load', (_evt, a: { projectId: string; slug: string }) =>
    loadFlow(userDataDir(), a.projectId, a.slug)
  )
  ipcMain.handle('flows:save', (_evt, a: { projectId: string; slug: string; blueprint: unknown }) =>
    saveFlow(userDataDir(), a.projectId, a.slug, a.blueprint)
  )
  ipcMain.handle('flows:delete', (_evt, a: { projectId: string; slug: string }) =>
    deleteFlow(userDataDir(), a.projectId, a.slug)
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
  ipcMain.handle('agent:orchestrate', (_evt, a: { projectPath: string; brief: string }) =>
    spawnOrchestrator(a.projectPath, a.brief)
  )
  ipcMain.handle(
    'agent:mergeAll',
    (_evt, a: { projectPath: string; baseBranch: string; branches: string[] }) =>
      spawnMergeOrchestrator(a.projectPath, a.baseBranch, a.branches)
  )
}

app.whenReady().then(() => {
  ensureHooksInstalled()
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

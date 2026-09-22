import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { foldRun, type RunEvent } from '../shared/runs'
import {
  listRunningAgents,
  openSession,
  resumeSession,
  spawnAgent,
  stopAgent
} from './agents'
import { ClaudeCodeAdapter } from './engine/adapter'
import * as gitops from './engine/gitops'
import { detectTestCommand, diffSummary, isClean, refExists, sweepWorktrees, worktreeHolding } from './engine/gitops'
import { resumableRunIds } from './engine/resume'
import { buildLandBlueprint, LAND_FLOW } from '../shared/patterns'
import { RunEngine, worktreeRootFor } from './engine/runner'
import { RunStore } from './engine/store'
import { deleteFlow, listFlows, loadFlow, peekFlow, saveFlow } from './flows'
import { gitState, unmergedBranches } from './git'
import { hookCommand } from './hookcommand'
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
const SAFE_EXTERNAL = /^(https?|mailto):/i
const BUILD = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'
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

// The command Claude Code runs for each hook. See hookcommand.ts for why it is
// not a one-liner on Windows (Claude Code runs hooks in Git Bash there).
function resolveHookCommand(): string {
  const hc = hookCommand({
    platform: process.platform,
    packaged: app.isPackaged,
    execPath: process.execPath,
    bridgePath: app.isPackaged ? path.join(process.resourcesPath, 'hooks', 'bridge.js') : path.join(app.getAppPath(), 'hooks', 'bridge.js'),
    dataDir: userDataDir()
  })
  if (hc.launcher) {
    // Rewritten each launch, so an app that moved or updated points at itself.
    const current = fs.existsSync(hc.launcher.path) ? fs.readFileSync(hc.launcher.path, 'utf8') : ''
    if (current !== hc.launcher.content) {
      fs.mkdirSync(path.dirname(hc.launcher.path), { recursive: true })
      fs.writeFileSync(hc.launcher.path, hc.launcher.content)
    }
  }
  return hc.command
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
    title: `Agent Ship (${BUILD})`,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  // Keep the build id in the title; the page's own <title> would replace it.
  mainWindow.on('page-title-updated', (e) => e.preventDefault())

  // Anything trying to open a new window goes to the real browser instead, and
  // only as a web or mail link: other schemes (file:, ms-*, custom handlers)
  // can launch programs, and nothing in this app needs them.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (SAFE_EXTERNAL.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // The window has a preload bridge to the main process, so it must never
  // navigate away from the app itself (a stray link would load remote content into it).
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const home = process.env.ELECTRON_RENDERER_URL
    const inApp = home ? url.startsWith(home) : url.startsWith('file://')
    if (inApp) return
    e.preventDefault()
    if (SAFE_EXTERNAL.test(url)) void shell.openExternal(url)
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
  // A session's uncommitted work. What "landing" it means depends on where it is:
  //  - on a feature branch: commit it there (as `git add -A && git commit`), then land the branch;
  //  - on the base branch itself: never commit untested work to it. Snapshot the files
  //    onto a NEW branch, test and merge that, and only at the end advance the base,
  //    absorbing the files only if they are exactly what was tested.
  const belongsToProject = async (projectPath: string, cwd: string): Promise<boolean> => {
    try {
      return (await gitops.commonDir(cwd)) === (await gitops.commonDir(projectPath))
    } catch {
      return false
    }
  }

  ipcMain.handle('land:workPlan', async (_evt, a: { projectId: string; cwd: string }) => {
    const project = shipyard.loadProjects(userDataDir()).find((p) => p.id === a.projectId)
    if (!project) return { ok: false as const, error: 'Unknown project.' }
    if (!(await belongsToProject(project.path, a.cwd))) return { ok: false as const, error: 'That folder is not part of this project.' }
    const top = await gitops.topLevel(a.cwd)
    const state = await gitState(top)
    const current = await gitops.currentBranch(top)
    const baseBranch = state.baseBranch || 'main'
    const test = detectTestCommand(project.path)
    if (!current) return { ok: false as const, error: 'That checkout is on a detached HEAD, so there is no branch to work from. Check out a branch first.' }
    if (state.dirtyFiles === 0) return { ok: false as const, error: 'There is nothing uncommitted to land.' }
    return {
      ok: true as const,
      checkout: top,
      currentBranch: current,
      baseBranch,
      files: state.dirtyFiles,
      mode: (current === baseBranch ? 'on-base' : 'on-branch') as 'on-base' | 'on-branch',
      testCommand: test.command,
      testSource: test.source
    }
  })

  ipcMain.handle(
    'runs:landWork',
    async (
      _evt,
      a: {
        projectId: string
        cwd: string
        sessionId: string
        baseBranch: string
        testCommand: string
        resolveConflicts: boolean
        message: string
      }
    ) => {
      if (!engine) return { ok: false, error: 'The run engine is not ready.' }
      const project = shipyard.loadProjects(userDataDir()).find((p) => p.id === a.projectId)
      if (!project) return { ok: false, error: 'Unknown project.' }
      if (!BRANCH_NAME.test(a.baseBranch)) return { ok: false, error: 'Invalid branch name.' }
      if (!(await belongsToProject(project.path, a.cwd))) return { ok: false, error: 'That folder is not part of this project.' }
      const test = String(a.testCommand ?? '').trim()
      if (test.length > 1000 || /[\r\n]/.test(test)) return { ok: false, error: 'The test command must be a single line.' }
      const message = String(a.message ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200) || 'Work from a Claude Code session'

      const top = await gitops.topLevel(a.cwd)
      const current = await gitops.currentBranch(top)
      if (!current) return { ok: false, error: 'That checkout is on a detached HEAD, so there is no branch to work from.' }

      let branch = current
      let createdBranch = ''
      try {
        if (current === a.baseBranch) {
          const snap = await gitops.snapshotCommit(top, message)
          if (!snap.changed) return { ok: false, error: 'There is nothing uncommitted to land.' }
          branch = await gitops.createBranchAt(project.path, `agentship/work-${Date.now().toString(36)}`, snap.sha)
          createdBranch = branch
        } else {
          branch = (await gitops.commitToCurrentBranch(top, message)).branch
        }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }

      const result = await engine.start({
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        flowSlug: LAND_FLOW,
        blueprint: buildLandBlueprint({ branch, base: a.baseBranch, testCommand: test, resolveConflicts: Boolean(a.resolveConflicts) }),
        // `checkout` ties this landing to the session that made the work, so the Floor can show its pipeline on that card.
        inputs: { branch, checkout: top, session: /^[A-Za-z0-9_-]{1,64}$/.test(String(a.sessionId)) ? String(a.sessionId) : '' }
      })
      if (!result.ok) {
        // Do not leave a stray branch we made for a run that never started.
        if (createdBranch) await gitops.deleteBranch(project.path, createdBranch)
        else return { ok: false, error: `${result.error} (Your work was committed to ${branch}.)` }
      }
      return result
    }
  )

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
}

app.whenReady().then(() => {
  log.info('start', `Agent Ship ${BUILD}`)
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

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { startServer } = require('./server');
const { installHooks } = require('../../scripts/install-hooks');
const shipyard = require('./shipyard');

let mainWindow;

function userDataDir() {
  return app.getPath('userData');
}

// Launches a real Claude Code background agent (`claude --bg`) in a
// registered project's directory - the same first-class session mechanism
// Claude Desktop's own Code tab uses (confirmed live: `claude agents --json`
// lists Desktop's own interactive sessions and CLI-launched background ones
// side by side, keyed the same way), so a spawned agent shows up there too,
// not just in this app's ship. No shell: claude.exe is a real binary, and
// passing argv directly (rather than building a shell command string)
// sidesteps the whole class of Windows cmd.exe quoting problems a free-text
// task string could otherwise trigger.
function spawnAgent({ projectPath, role, task }) {
  const label = (role || 'Agent').trim() || 'Agent';
  const child = spawn('claude', ['--bg', '--name', label, task], {
    cwd: projectPath,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      AGENT_SHIP_NAME: label,
      AGENT_SHIP_ROLE: label,
      AGENT_SHIP_TASK: task || ''
    }
  });
  child.on('error', (err) => console.error('Failed to spawn agent:', err));
  child.unref();
}

// Figures out the command Claude Code should run for each hook event.
// In the packaged app there is no guarantee the user has Node.js
// installed separately, so we point hooks at the app's own bundled
// runtime instead, run in plain-Node mode via ELECTRON_RUN_AS_NODE.
function resolveHookCommand() {
  const bridgePath = app.isPackaged
    ? path.join(process.resourcesPath, 'hooks', 'bridge.js')
    : path.join(__dirname, '..', '..', 'hooks', 'bridge.js');

  if (!app.isPackaged) {
    return `node "${bridgePath}"`;
  }

  const execPath = process.execPath;
  if (process.platform === 'win32') {
    // No outer `cmd /c "..."` wrapper: whatever invokes this command string
    // already runs it through a shell (confirmed live - the plain dev-mode
    // `node "path"` command already works without one). Adding a manual
    // wrapper double-nests cmd.exe, and the backslash-escaped inner quotes
    // (`\"..\"`) that requires don't survive that second parsing pass -
    // confirmed live via child_process.exec, which failed with the wrapper
    // ("not recognized as an internal or external command") and succeeded
    // without it.
    return `set ELECTRON_RUN_AS_NODE=1&& "${execPath}" "${bridgePath}"`;
  }
  return `ELECTRON_RUN_AS_NODE=1 "${execPath}" "${bridgePath}"`;
}

function ensureHooksInstalled() {
  try {
    const result = installHooks(resolveHookCommand());
    if (!result.ok && result.reason === 'claude-not-found') {
      console.log('Claude Code not found - hooks not installed. Install Claude Code and relaunch.');
    }
  } catch (err) {
    console.error('Could not install Claude Code hooks:', err);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    backgroundColor: '#12161d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function registerIpcHandlers() {
  ipcMain.handle('shipyard:list', () => shipyard.loadProjects(userDataDir()));

  ipcMain.handle('shipyard:addProject', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add a project to the ship',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return shipyard.loadProjects(userDataDir());
    return shipyard.addProject(userDataDir(), result.filePaths[0]);
  });

  ipcMain.handle('shipyard:removeProject', (_evt, id) => shipyard.removeProject(userDataDir(), id));

  ipcMain.handle('agent:spawn', (_evt, { projectPath, role, task }) => {
    if (!projectPath || !task) return { ok: false, error: 'A project and task are required.' };
    try {
      spawnAgent({ projectPath, role, task });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });
}

app.whenReady().then(() => {
  ensureHooksInstalled();
  createWindow();
  registerIpcHandlers();

  // Local-only HTTP server. The hook bridge script POSTs agent events here.
  // Nothing outbound, nothing authenticated to Anthropic - this only relays
  // JSON that Claude Code's own hooks already write locally.
  startServer((event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent-event', event);
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

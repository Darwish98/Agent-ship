const { app, BrowserWindow } = require('electron');
const path = require('path');
const { startServer } = require('./server');
const { installHooks } = require('../../scripts/install-hooks');

let mainWindow;

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
    return `cmd /c "set ELECTRON_RUN_AS_NODE=1&& \\"${execPath}\\" \\"${bridgePath}\\""`;
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

app.whenReady().then(() => {
  ensureHooksInstalled();
  createWindow();

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

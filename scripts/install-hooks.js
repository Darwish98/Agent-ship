const fs = require('fs');
const os = require('os');
const path = require('path');

const claudeDir = path.join(os.homedir(), '.claude');
const settingsPath = path.join(claudeDir, 'settings.json');

const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop'];
const MARKER = 'agent-ship';

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function buildHookEntry(command) {
  return {
    matcher: '',
    hooks: [{ type: 'command', command, description: MARKER }]
  };
}

function alreadyInstalled(settings, eventName) {
  const list = settings.hooks && settings.hooks[eventName];
  if (!Array.isArray(list)) return false;
  return list.some((entry) => (entry.hooks || []).some((h) => h.description === MARKER));
}

// command: the full shell command Claude Code should run for each hook
// event. Callers decide what that command is (dev: `node bridge.js`,
// packaged app: the app's own bundled runtime) - this module only writes
// it into settings.json.
function installHooks(command) {
  if (!fs.existsSync(claudeDir)) {
    return { ok: false, reason: 'claude-not-found' };
  }

  const settings = readJsonSafe(settingsPath);
  if (settings === null) return { ok: false, reason: 'parse-error' };

  settings.hooks = settings.hooks || {};
  let changed = false;
  for (const eventName of HOOK_EVENTS) {
    if (alreadyInstalled(settings, eventName)) continue;
    settings.hooks[eventName] = settings.hooks[eventName] || [];
    settings.hooks[eventName].push(buildHookEntry(command));
    changed = true;
  }

  if (!changed) return { ok: true, changed: false };

  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { ok: true, changed: true, settingsPath };
}

module.exports = { installHooks, claudeDir, settingsPath };

if (require.main === module) {
  // Dev/manual CLI usage: `node scripts/install-hooks.js`
  const bridgePath = path.join(__dirname, '..', 'hooks', 'bridge.js');
  const command = `node "${bridgePath}"`;
  const result = installHooks(command);

  if (!result.ok) {
    if (result.reason === 'claude-not-found') {
      console.log('Claude Code was not found (~/.claude does not exist) - skipping hook install.');
      process.exit(process.argv.includes('--auto') ? 0 : 1);
    }
    console.error('Could not update settings.json:', result.reason);
    process.exit(1);
  }

  if (!result.changed) {
    console.log('agent-ship hooks are already installed.');
  } else {
    console.log(`Installed agent-ship hooks into ${result.settingsPath}`);
    console.log('Restart any running Claude Code sessions to pick them up.');
  }
}

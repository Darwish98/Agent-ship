// Installs the Agent Ship hooks into ~/.claude/settings.json (used by
// `npm install` and by hand). This is the same logic as src/main/hooks.ts,
// which the app runs on launch; src/main/hooks.test.ts runs the same scenarios
// against both so they cannot drift. Read the rules at the top of that file.
const fs = require('fs');
const os = require('os');
const path = require('path');

const claudeDir = path.join(os.homedir(), '.claude');
const settingsPath = path.join(claudeDir, 'settings.json');
const backupPath = `${settingsPath}.agentship-backup`;

const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop'];
const MARKER = 'agent-ship';

// Ours: tagged by us, or an untagged copy of our bridge from an older build.
function isOurs(h) {
  if (h.description === MARKER) return true;
  const cmd = typeof h.command === 'string' ? h.command : '';
  return /bridge\.js/.test(cmd) && /agent-ship/i.test(cmd);
}

// Exactly one Agent Ship hook per event, running `command`. Mutates settings;
// returns whether anything changed.
function mergeHooks(settings, command) {
  let changed = false;
  settings.hooks = settings.hooks || {};
  const ours = (h) => ({ ...h, type: 'command', command, description: MARKER });

  for (const eventName of HOOK_EVENTS) {
    const list = Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : [];
    const next = [];
    let placed = false;

    for (const entry of list) {
      const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
      if (!hooks.some(isOurs)) {
        next.push(entry);
        continue;
      }
      const rebuilt = [];
      for (const h of hooks) {
        if (!isOurs(h)) rebuilt.push(h);
        else if (!placed) {
          placed = true;
          const want = ours(h);
          if (want.command !== h.command || want.description !== h.description || want.type !== h.type) changed = true;
          rebuilt.push(want);
        } else changed = true; // a duplicate
      }
      if (rebuilt.length === 0) changed = true;
      else next.push({ ...entry, hooks: rebuilt });
    }

    if (!placed) {
      next.push({ matcher: '', hooks: [{ type: 'command', command, description: MARKER }] });
      changed = true;
    }
    settings.hooks[eventName] = next;
  }
  return changed;
}

// Removes every Agent Ship hook and nothing else.
function stripHooks(settings) {
  if (!settings.hooks) return false;
  let changed = false;
  for (const eventName of Object.keys(settings.hooks)) {
    const list = settings.hooks[eventName];
    if (!Array.isArray(list)) continue;
    const next = [];
    for (const entry of list) {
      const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
      const rest = hooks.filter((h) => !isOurs(h));
      if (rest.length === hooks.length) next.push(entry);
      else {
        changed = true;
        if (rest.length > 0) next.push({ ...entry, hooks: rest });
      }
    }
    if (next.length === 0) delete settings.hooks[eventName];
    else settings.hooks[eventName] = next;
  }
  return changed;
}

// Temp file in the same directory, then rename: a crash leaves the old file or
// the new one, never half of it.
function writeSettings(settings) {
  fs.mkdirSync(claudeDir, { recursive: true });
  if (fs.existsSync(settingsPath) && !fs.existsSync(backupPath)) fs.copyFileSync(settingsPath, backupPath);
  const tmp = `${settingsPath}.agentship-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, settingsPath);
}

function readSettings() {
  try {
    const s = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
    if (s === null || typeof s !== 'object' || Array.isArray(s)) return null;
    return s;
  } catch (e) {
    return null;
  }
}

// command: the full shell command Claude Code should run for each hook event.
// Callers decide what it is (dev: `node bridge.js`, packaged app: the app's
// own bundled runtime); this module only writes it into settings.json.
function installHooks(command) {
  if (!fs.existsSync(claudeDir)) return { ok: false, reason: 'claude-not-found' };
  const settings = readSettings();
  if (settings === null) return { ok: false, reason: 'parse-error' };
  if (!mergeHooks(settings, command)) return { ok: true, changed: false };
  writeSettings(settings);
  return { ok: true, changed: true, settingsPath };
}

function uninstallHooks() {
  if (!fs.existsSync(settingsPath)) return { ok: true, changed: false, reason: 'no-settings' };
  const settings = readSettings();
  if (settings === null) return { ok: false, reason: 'parse-error' };
  if (!stripHooks(settings)) return { ok: true, changed: false };
  writeSettings(settings);
  return { ok: true, changed: true };
}

module.exports = { installHooks, uninstallHooks, mergeHooks, stripHooks, isOurs, claudeDir, settingsPath, backupPath };

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
    console.error('Could not update settings.json (it is not valid JSON, so it was left alone):', result.reason);
    process.exit(process.argv.includes('--auto') ? 0 : 1);
  }

  if (!result.changed) {
    console.log('agent-ship hooks are already installed.');
  } else {
    console.log(`Installed agent-ship hooks into ${result.settingsPath}`);
    console.log(`(Your original file is kept once at ${backupPath}.)`);
    console.log('Restart any running Claude Code sessions to pick them up.');
  }
}

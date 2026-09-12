#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');

const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
const MARKER = 'agent-ship';

if (!fs.existsSync(settingsPath)) {
  console.log('No ~/.claude/settings.json found - nothing to remove.');
  process.exit(0);
}

const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
if (!settings.hooks) {
  console.log('No hooks configured - nothing to remove.');
  process.exit(0);
}

let changed = false;
for (const eventName of Object.keys(settings.hooks)) {
  const before = settings.hooks[eventName].length;
  settings.hooks[eventName] = settings.hooks[eventName].filter(
    (entry) => !(entry.hooks || []).some((h) => h.description === MARKER || (h.command || '').includes(MARKER))
  );
  if (settings.hooks[eventName].length !== before) changed = true;
  if (settings.hooks[eventName].length === 0) delete settings.hooks[eventName];
}

if (!changed) {
  console.log('No agent-ship hooks found.');
  process.exit(0);
}

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
console.log('Removed agent-ship hooks.');

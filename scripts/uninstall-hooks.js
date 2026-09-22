#!/usr/bin/env node
// Removes the Agent Ship hooks from ~/.claude/settings.json and leaves
// everything else in the file alone. Shares its logic with install-hooks.js.
const { uninstallHooks } = require('./install-hooks.js');

const result = uninstallHooks();
if (!result.ok) {
  console.error('Could not update settings.json (it is not valid JSON, so it was left alone).');
  process.exit(1);
}
console.log(result.reason === 'no-settings' ? 'No ~/.claude/settings.json found - nothing to remove.' : result.changed ? 'Removed agent-ship hooks.' : 'No agent-ship hooks found.');

#!/usr/bin/env node
// Invoked locally by Claude Code's own hook system (see ~/.claude/settings.json).
// Reads the hook's JSON payload from stdin and forwards a small summary to
// the agent-ship desktop app over localhost. No network calls, no credentials,
// no model calls - this only relays events Claude Code already emits locally.

const http = require('http');

const PORT = process.env.AGENT_SHIP_PORT || 8934;
const HOST = '127.0.0.1';

let raw = '';
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  let input = {};
  try {
    input = JSON.parse(raw || '{}');
  } catch (_e) {
    // If Claude Code changes its payload shape, fail quietly - never block
    // the user's actual tool call over a visualization side-channel.
  }

  const project = (input.cwd || process.cwd()).split(/[\\/]/).filter(Boolean).pop() || 'project';

  const payload = JSON.stringify({
    sessionId: input.session_id || 'local-session',
    agentName: process.env.AGENT_SHIP_NAME || project,
    role: input.agent_type || 'Claude Code agent',
    project,
    hookEvent: input.hook_event_name || '',
    toolName: input.tool_name || '',
    status: ''
  });

  const req = http.request(
    {
      host: HOST,
      port: PORT,
      path: '/event',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 500
    },
    (res) => res.resume()
  );

  // The visualizer app may not be running - that's fine, this must never
  // break or slow down the user's actual Claude Code session.
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.write(payload);
  req.end();

  // Always let the underlying hook proceed normally.
  process.exit(0);
});

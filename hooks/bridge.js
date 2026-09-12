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

  const projectPath = input.cwd || process.cwd();
  const project = projectPath.split(/[\\/]/).filter(Boolean).pop() || 'project';

  // Confirmed against a live payload capture: agent_id/agent_type are only
  // present on a subagent's own tool-call hooks (e.g. a Task/Explore run),
  // never on the top-level session's. A subagent's hooks share its parent's
  // session_id, so agent_id is what lets us render it as a separate crew
  // member instead of collapsing into the main session's character.
  const isSubagent = Boolean(input.agent_id);

  // When the parent session's own "Agent" tool call finishes, its
  // tool_response carries the agentId of the subagent that just completed -
  // used downstream to despawn that subagent's crew member.
  const subagentDoneId =
    input.hook_event_name === 'PostToolUse' && input.tool_name === 'Agent'
      ? (input.tool_response && input.tool_response.agentId) || ''
      : '';

  // AGENT_SHIP_ROLE/NAME/TASK are set by the app itself when it spawns an
  // agent (see src/main/main.js spawnAgent) - they flow down to every hook
  // subprocess of that claude session since child processes inherit env.
  const payload = JSON.stringify({
    sessionId: input.session_id || 'local-session',
    agentId: input.agent_id || '',
    agentName: isSubagent ? input.agent_type || 'subagent' : process.env.AGENT_SHIP_NAME || project,
    role: process.env.AGENT_SHIP_ROLE || input.agent_type || 'Claude Code agent',
    task: process.env.AGENT_SHIP_TASK || '',
    project,
    projectPath,
    hookEvent: input.hook_event_name || '',
    toolName: input.tool_name || '',
    status: '',
    subagentDoneId
  });

  // Exiting must wait for the request to actually land - calling
  // process.exit() right after req.end() (as this used to) can tear down
  // the process before the loopback connection even finishes handshaking,
  // silently dropping the event. Confirmed by comparing a manual curl POST
  // (which always rendered) against real hook-triggered ones (which didn't)
  // during live testing.
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
    (res) => {
      res.resume();
      res.on('end', () => process.exit(0));
    }
  );

  // The visualizer app may not be running - that's fine, this must never
  // break or slow down the user's actual Claude Code session.
  req.on('error', () => process.exit(0));
  req.on('timeout', () => {
    req.destroy();
    process.exit(0);
  });
  req.write(payload);
  req.end();
});

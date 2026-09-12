const express = require('express');

// Bound to loopback only - never reachable from the network.
const HOST = '127.0.0.1';
const PORT = 8934;

function startServer(onEvent) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.post('/event', (req, res) => {
    const body = req.body || {};

    // Minimal shape check - the hook bridge controls what it sends,
    // this just guards against malformed payloads reaching the renderer.
    const event = {
      sessionId: String(body.sessionId || 'unknown'),
      agentId: String(body.agentId || ''),
      agentName: String(body.agentName || 'Agent'),
      role: String(body.role || 'Agent'),
      task: String(body.task || ''),
      project: String(body.project || ''),
      projectPath: String(body.projectPath || ''),
      hookEvent: String(body.hookEvent || ''),
      toolName: String(body.toolName || ''),
      status: String(body.status || ''),
      subagentDoneId: String(body.subagentDoneId || ''),
      timestamp: Date.now()
    };

    onEvent(event);
    res.status(204).end();
  });

  app.listen(PORT, HOST, () => {
    console.log(`agent-ship event bridge listening on http://${HOST}:${PORT}`);
  });
}

module.exports = { startServer, PORT, HOST };

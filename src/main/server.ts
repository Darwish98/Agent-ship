// Loopback-only HTTP endpoint the hook bridge POSTs Claude Code events to.
// Never reachable from the network, and nothing leaves this machine.
import http from 'node:http'

export const HOST = '127.0.0.1'
export const PORT = Number(process.env.AGENT_SHIP_PORT) || 8934

export interface AgentEvent {
  sessionId: string
  agentId: string
  agentName: string
  role: string
  task: string
  project: string
  projectPath: string
  hookEvent: string
  toolName: string
  status: string
  subagentDoneId: string
  timestamp: number
}

function normalize(body: Record<string, unknown>): AgentEvent {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  return {
    sessionId: str(body.sessionId) || 'unknown',
    agentId: str(body.agentId),
    agentName: str(body.agentName) || 'Agent',
    role: str(body.role) || 'Agent',
    task: str(body.task),
    project: str(body.project),
    projectPath: str(body.projectPath),
    hookEvent: str(body.hookEvent),
    toolName: str(body.toolName),
    status: str(body.status),
    subagentDoneId: str(body.subagentDoneId),
    timestamp: Date.now()
  }
}

/**
 * Only the hook bridge (a Node process on this machine) may talk to this
 * server. A web page can also reach 127.0.0.1, so a browser tab could otherwise
 * post fake agent events. Browsers always attach `Origin` to cross-site
 * requests and the bridge never does; and `Host` must be the loopback name, so
 * DNS rebinding (a hostile name resolving to 127.0.0.1) is refused too.
 */
export function isTrustedRequest(headers: http.IncomingHttpHeaders, port = PORT): boolean {
  if (headers.origin !== undefined) return false
  const host = (headers.host ?? '').toLowerCase()
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === '127.0.0.1' || host === 'localhost'
}

export function startServer(onEvent: (event: AgentEvent) => void): http.Server {
  const server = http.createServer((req, res) => {
    if (!isTrustedRequest(req.headers)) {
      res.writeHead(403).end()
      return
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (req.method !== 'POST' || req.url !== '/event') {
      res.writeHead(404).end()
      return
    }

    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      // The hook bridge only ever sends a small summary; anything larger is
      // malformed, so drop it rather than buffering unboundedly.
      if (raw.length > 256 * 1024) {
        res.writeHead(413).end()
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        onEvent(normalize(JSON.parse(raw || '{}')))
      } catch {
        // A malformed payload must never take the visualizer down.
      }
      res.writeHead(204).end()
    })
  })

  server.listen(PORT, HOST, () => {
    console.log(`agent-ship event bridge listening on http://${HOST}:${PORT}`)
  })

  return server
}

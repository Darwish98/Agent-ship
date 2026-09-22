import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from './server'

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo
      s.close(() => resolve(port))
    })
  })

let server: http.Server | undefined
afterEach(() => {
  server?.close()
  vi.unstubAllEnvs()
})

async function boot(): Promise<{ port: number; events: AgentEvent[] }> {
  const port = await freePort()
  vi.stubEnv('AGENT_SHIP_PORT', String(port))
  vi.resetModules()
  const mod = await import('./server')
  const events: AgentEvent[] = []
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  server = mod.startServer((e) => events.push(e))
  await new Promise((r) => (server!.listening ? r(null) : server!.once('listening', () => r(null))))
  return { port, events }
}

function send(port: number, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: opts.path ?? '/event', method: opts.method ?? 'POST', headers: opts.headers }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end(opts.body ?? '')
  })
}

const good = JSON.stringify({ sessionId: 's1', agentName: 'crew', hookEvent: 'PreToolUse', toolName: 'Edit', projectPath: '/p' })

describe('hook event server', () => {
  it('accepts what the bridge sends: no Origin, loopback Host', async () => {
    const { port, events } = await boot()
    expect(await send(port, { body: good })).toBe(204)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ sessionId: 's1', agentName: 'crew', toolName: 'Edit' })
  })

  it('refuses a web page: any request carrying an Origin, even a "simple" text/plain POST', async () => {
    const { port, events } = await boot()
    expect(await send(port, { body: good, headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' } })).toBe(403)
    expect(await send(port, { body: good, headers: { Origin: 'null' } })).toBe(403)
    expect(events).toHaveLength(0)
  })

  it('refuses DNS rebinding: a Host that is not loopback', async () => {
    const { port, events } = await boot()
    expect(await send(port, { body: good, headers: { Host: 'attacker.example' } })).toBe(403)
    expect(await send(port, { body: good, headers: { Host: `attacker.example:${port}` } })).toBe(403)
    expect(events).toHaveLength(0)
  })

  it('answers health checks, 404s anything else, drops garbage, and caps the body', async () => {
    const { port, events } = await boot()
    expect(await send(port, { method: 'GET', path: '/health' })).toBe(200)
    expect(await send(port, { method: 'GET', path: '/event' })).toBe(404)
    expect(await send(port, { path: '/elsewhere', body: good })).toBe(404)
    expect(await send(port, { body: '{ not json' })).toBe(204) // ignored, never crashes
    expect(events).toHaveLength(0)
    // Oversized: the server cuts the connection; either a 413 or a reset is a refusal.
    const big = JSON.stringify({ sessionId: 'x'.repeat(300_000) })
    const outcome = await send(port, { body: big }).catch(() => 'reset')
    expect([413, 'reset']).toContain(outcome)
    expect(events).toHaveLength(0)
  })

  it('still receives events from the REAL hook bridge (it must not be caught by the browser defences)', async () => {
    const { port, events } = await boot()
    const bridge = path.resolve(import.meta.dirname, '../../hooks/bridge.js')
    const payload = JSON.stringify({ session_id: 'real-1', hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: process.cwd() })
    // Async: this process hosts the server, so a synchronous spawn would block it from answering.
    const child = spawn(process.execPath, [bridge], { env: { ...process.env, AGENT_SHIP_PORT: String(port) } })
    child.stdin.end(payload)
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve))
    expect(code).toBe(0)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ sessionId: 'real-1', hookEvent: 'PreToolUse', toolName: 'Write' })
  })

  it('the bridge exits 0 and does not hang when the app is not running', () => {
    const t0 = Date.now()
    const r = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../../hooks/bridge.js')], {
      input: '{}', env: { ...process.env, AGENT_SHIP_PORT: '1' }, encoding: 'utf8'
    })
    expect(r.status).toBe(0)
    expect(Date.now() - t0).toBeLessThan(3_000)
  })

  it('treats non-string fields as empty rather than trusting their type', async () => {
    const { port, events } = await boot()
    await send(port, { body: JSON.stringify({ sessionId: { a: 1 }, agentName: 7, toolName: ['x'] }) })
    expect(events[0]).toMatchObject({ sessionId: 'unknown', agentName: 'Agent', toolName: '' })
  })
})

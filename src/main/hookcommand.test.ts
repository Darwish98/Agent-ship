import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { hookCommand } from './hookcommand'

const bridge = path.resolve(import.meta.dirname, '../../hooks/bridge.js')

describe('hook command', () => {
  it('development: plain node, the same in every shell', () => {
    expect(hookCommand({ platform: 'win32', packaged: false, execPath: 'x', bridgePath: 'C:\\a\\bridge.js', dataDir: 'd' })).toEqual({ command: 'node "C:\\a\\bridge.js"' })
  })

  it('packaged macOS/Linux: an env prefix that sh, bash and zsh all understand', () => {
    const c = hookCommand({ platform: 'linux', packaged: true, execPath: '/opt/Agent Ship/agent-ship', bridgePath: '/opt/Agent Ship/resources/hooks/bridge.js', dataDir: '/home/u/.config/Agent Ship' })
    expect(c.command).toBe('ELECTRON_RUN_AS_NODE=1 "/opt/Agent Ship/agent-ship" "/opt/Agent Ship/resources/hooks/bridge.js"')
    expect(c.launcher).toBeUndefined()
  })

  it('packaged Windows: a launcher file, NOT `set X=1&&`, which bash turns into a full GUI launch', () => {
    const c = hookCommand({ platform: 'win32', packaged: true, execPath: 'C:\\Apps\\Agent Ship\\Agent Ship.exe', bridgePath: 'C:\\Apps\\Agent Ship\\resources\\hooks\\bridge.js', dataDir: 'C:\\Users\\u\\AppData\\Roaming\\Agent Ship' })
    expect(c.command).not.toMatch(/set |&&/)
    expect(c.launcher?.path.replace(/\\/g, '/')).toMatch(/Agent Ship\/hooks\/agentship-hook\.cmd$/)
    expect(c.launcher?.content).toContain('set ELECTRON_RUN_AS_NODE=1')
    expect(c.launcher?.content.startsWith('@echo off')).toBe(true) // otherwise cmd echoes its lines into the hook output
    expect(c.launcher?.content).toContain('"C:\\Apps\\Agent Ship\\Agent Ship.exe" "C:\\Apps\\Agent Ship\\resources\\hooks\\bridge.js"')
  })
})

/** The real thing: run the exact command Claude Code would, in each shell, and see the bridge deliver. */
describe.skipIf(process.platform !== 'win32')('the Windows launcher works from both cmd.exe and Git Bash', () => {
  const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find((p) => fs.existsSync(p))
  const payload = JSON.stringify({ session_id: 'shell-test', hook_event_name: 'Stop', cwd: 'C:\\x' })

  /** Starts a listener, writes the launcher into a folder with a space in its name, runs `run(command)`, returns what arrived. */
  async function deliver(run: (command: string) => Promise<number | null>): Promise<string[]> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Agent Ship '))
    const got: string[] = []
    const server = http.createServer((req, res) => {
      let b = ''
      req.on('data', (c) => (b += c))
      req.on('end', () => {
        got.push(b)
        res.writeHead(204).end()
      })
    })
    const port: number = await new Promise((r) => server.listen(0, '127.0.0.1', () => r((server.address() as net.AddressInfo).port)))
    try {
      // node stands in for the packaged executable: it honours the same launcher contract.
      const hc = hookCommand({ platform: 'win32', packaged: true, execPath: process.execPath, bridgePath: bridge, dataDir: dir })
      fs.mkdirSync(path.dirname(hc.launcher!.path), { recursive: true })
      fs.writeFileSync(hc.launcher!.path, hc.launcher!.content)
      process.env.AGENT_SHIP_PORT = String(port)
      expect(await run(hc.command)).toBe(0)
      return got
    } finally {
      server.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it('cmd.exe', async () => {
    const got = await deliver(
      (command) =>
        new Promise((resolve) => {
          const c = spawn('cmd.exe', ['/d', '/s', '/c', `"${command}"`], { env: process.env, windowsVerbatimArguments: true })
          c.stdin.end(payload)
          c.on('exit', resolve)
        })
    )
    expect(got.map((g) => JSON.parse(g).sessionId)).toEqual(['shell-test'])
  })

  it.skipIf(!gitBash)('Git Bash (what Claude Code actually uses on Windows)', async () => {
    const got = await deliver(
      (command) =>
        new Promise((resolve) => {
          const c = spawn(gitBash!, ['-c', command], { env: process.env })
          c.stdin.end(payload)
          c.on('exit', resolve)
        })
    )
    expect(got.map((g) => JSON.parse(g).sessionId)).toEqual(['shell-test'])
  })

  it.skipIf(!gitBash)('and the OLD command really was broken under bash (regression proof)', () => {
    const r = spawnSync(gitBash!, ['-c', 'set ELECTRON_RUN_AS_NODE=1&& printenv ELECTRON_RUN_AS_NODE'], { encoding: 'utf8' })
    expect(r.stdout.trim()).toBe('') // the variable never reached the child
  })
})

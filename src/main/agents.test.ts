import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// agents.ts imports Electron's `shell`; the parts under test do not use it.
vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))

let dir = ''
afterEach(() => {
  vi.unstubAllEnvs()
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
})

/** A stand-in for `claude` whose `agents --json` lists exactly these pids. */
function fakeClaude(pids: number[]): void {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'))
  const script = path.join(dir, 'fake.cjs')
  fs.writeFileSync(script, `process.stdout.write(${JSON.stringify(JSON.stringify(pids.map((pid) => ({ pid, cwd: '/x', kind: 'interactive', sessionId: 's', name: 'n', startedAt: 1 }))))})`)
  vi.stubEnv('AGENT_SHIP_CLAUDE_CMD', JSON.stringify([process.execPath, script]))
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('stopAgent', () => {
  it('refuses a process id Claude Code does not report as a session, and does not touch it', async () => {
    const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
    try {
      fakeClaude([999_999]) // the victim is not in the list
      const { stopAgent } = await import('./agents')
      const r = await stopAgent(victim.pid!)
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/not a running Claude Code session/)
      expect(alive(victim.pid!)).toBe(true)
    } finally {
      victim.kill()
    }
  })

  it('rejects non-integer, zero and negative ids before doing anything', async () => {
    fakeClaude([])
    const { stopAgent } = await import('./agents')
    for (const bad of [0, -1, 1.5, Number.NaN]) expect((await stopAgent(bad)).ok, String(bad)).toBe(false)
  })

  it('stops a session that Claude Code does list', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
    const exited = new Promise((r) => child.on('exit', r))
    fakeClaude([child.pid!])
    const { stopAgent } = await import('./agents')
    expect((await stopAgent(child.pid!)).ok).toBe(true)
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
    expect(alive(child.pid!)).toBe(false)
  })
})

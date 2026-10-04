import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'transcripts-home-'))
  vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('HOME', home)
  vi.resetModules()
})
afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
})

async function load(): Promise<typeof import('./transcripts')> {
  return import('./transcripts')
}

const projectDir = (name = 'proj'): string => {
  const dir = path.join(home, '.claude', 'projects', name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** One real API call, split across `blocks` transcript lines the way Claude
 *  Code actually writes them: one line per content block, every line
 *  carrying the SAME usage object (it belongs to the whole call, not to one
 *  block of it) and the same `message.id`. */
function callLines(
  msgId: string,
  usage: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number },
  blocks: number,
  at: string
): string {
  const out: string[] = []
  for (let i = 0; i < blocks; i++) {
    out.push(
      JSON.stringify({
        type: 'assistant',
        timestamp: at,
        uuid: `${msgId}-${i}`,
        message: { id: msgId, usage }
      })
    )
  }
  return out.join('\n')
}

const now = () => new Date().toISOString()
const daysAgo = (d: number): string => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()

describe('weeklyUsage', () => {
  it('counts a call ONCE no matter how many content-block lines it was split into (the over-count bug, reproduced and fixed)', async () => {
    const dir = projectDir()
    const usage = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 5 } // billed = 35
    // A real response with a thinking block, two tool calls: 3 lines, same message.id.
    fs.writeFileSync(path.join(dir, 's1.jsonl'), callLines('msg_A', usage, 3, now()))
    const t = await load()
    expect(t.weeklyUsage().weeklyTokens).toBe(35) // not 105
  })

  it('still counts two DIFFERENT calls separately', async () => {
    const dir = projectDir()
    const a = callLines('msg_A', { input_tokens: 10, output_tokens: 5 }, 2, now()) // 15, x1
    const b = callLines('msg_B', { input_tokens: 1, output_tokens: 1 }, 3, now()) // 2, x1
    fs.writeFileSync(path.join(dir, 's1.jsonl'), `${a}\n${b}`)
    const t = await load()
    expect(t.weeklyUsage().weeklyTokens).toBe(17)
  })

  it('sums across multiple sessions and multiple projects', async () => {
    const p1 = projectDir('p1')
    const p2 = projectDir('p2')
    fs.writeFileSync(path.join(p1, 's1.jsonl'), callLines('msg_A', { input_tokens: 100 }, 1, now()))
    fs.writeFileSync(path.join(p1, 's2.jsonl'), callLines('msg_B', { input_tokens: 50 }, 2, now()))
    fs.writeFileSync(path.join(p2, 's3.jsonl'), callLines('msg_C', { input_tokens: 25 }, 1, now()))
    const t = await load()
    expect(t.weeklyUsage().weeklyTokens).toBe(175)
  })

  it('excludes cache-read tokens from the billed total (re-sent context, not new volume)', async () => {
    const dir = projectDir()
    fs.writeFileSync(path.join(dir, 's1.jsonl'), callLines('msg_A', { input_tokens: 5, cache_read_input_tokens: 90_000 }, 1, now()))
    const t = await load()
    expect(t.weeklyUsage().weeklyTokens).toBe(5)
  })

  it('drops turns older than 7 days even inside a file touched this week', async () => {
    const dir = projectDir()
    const oldCall = callLines('msg_old', { input_tokens: 1_000 }, 1, daysAgo(10))
    const newCall = callLines('msg_new', { input_tokens: 7 }, 1, now())
    fs.writeFileSync(path.join(dir, 's1.jsonl'), `${oldCall}\n${newCall}`)
    const t = await load()
    expect(t.weeklyUsage().weeklyTokens).toBe(7)
  })

  it('skips a whole file whose mtime is older than 7 days (the fast path)', async () => {
    const dir = projectDir()
    const file = path.join(dir, 's1.jsonl')
    fs.writeFileSync(file, callLines('msg_A', { input_tokens: 999 }, 1, now()))
    const old = Date.now() - 10 * 24 * 60 * 60 * 1000
    fs.utimesSync(file, old / 1000, old / 1000)
    const t = await load()
    expect(t.weeklyUsage().weeklyTokens).toBe(0)
  })

  it('ignores malformed JSON, non-assistant lines, and lines with no usage, without crashing', async () => {
    const dir = projectDir()
    const lines = [
      '{ not json',
      JSON.stringify({ type: 'user', timestamp: now(), message: { usage: { input_tokens: 999 } } }),
      JSON.stringify({ type: 'assistant', timestamp: now(), message: { id: 'x' } }), // no usage
      callLines('msg_ok', { input_tokens: 3 }, 1, now())
    ]
    fs.writeFileSync(path.join(dir, 's1.jsonl'), lines.join('\n'))
    const t = await load()
    expect(t.weeklyUsage().weeklyTokens).toBe(3)
  })

  it('never drops a call just because it has no message.id (falls back to its own line, not silently discarded)', async () => {
    const dir = projectDir()
    const noId = JSON.stringify({ type: 'assistant', timestamp: now(), uuid: 'u1', message: { usage: { input_tokens: 12 } } })
    fs.writeFileSync(path.join(dir, 's1.jsonl'), noId)
    const t = await load()
    expect(t.weeklyUsage().weeklyTokens).toBe(12)
  })

  it('is 0 when nothing has run, and when ~/.claude/projects does not exist at all', async () => {
    const t = await load()
    expect(t.weeklyUsage().weeklyTokens).toBe(0)
  })
})

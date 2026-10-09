import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitState } from './git'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitstate-test-'))
  const g = (...a: string[]): string => execFileSync('git', a, { cwd: dir, encoding: 'utf8' })
  g('init', '-q', '-b', 'main')
  g('config', 'user.name', 't')
  g('config', 'user.email', 't@t')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x')
  g('add', '-A')
  g('commit', '-q', '-m', 'init')
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))

describe('a project\'s changed-file count', () => {
  it("does not count Agent Ship's own flow folder as work in progress", async () => {
    fs.mkdirSync(path.join(dir, '.agentship', 'flows'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.agentship', 'flows', 'autopilot.flow.json'), '{}')
    expect((await gitState(dir)).dirtyFiles).toBe(0)
  })

  it('still counts real changes next to it', async () => {
    fs.mkdirSync(path.join(dir, '.agentship'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.agentship', 'x.json'), '{}')
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed')
    fs.writeFileSync(path.join(dir, 'new.txt'), 'new')
    expect((await gitState(dir)).dirtyFiles).toBe(2)
  })
})

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as git from './gitops'

let root: string
let repo: string
let cache: string
const g = (...a: string[]): string => execFileSync('git', a, { cwd: repo, encoding: 'utf8' })

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitops-test-'))
  repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  g('init', '-q', '-b', 'main')
  g('config', 'user.name', 't')
  g('config', 'user.email', 't@t')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x')
  g('add', '-A')
  g('commit', '-q', '-m', 'init')
  // Stands in for a dependency cache entry's node_modules, shared by many scratch copies.
  cache = path.join(root, 'cache', 'node_modules')
  fs.mkdirSync(path.join(cache, 'pkg'), { recursive: true })
  fs.writeFileSync(path.join(cache, 'pkg', 'index.js'), 'module.exports = 1\n')
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }))

const link = (dir: string): void => fs.symlinkSync(cache, path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
const cacheIntact = (): boolean => fs.existsSync(path.join(cache, 'pkg', 'index.js'))

describe('scratch copies that link a shared node_modules', () => {
  it('recreating one (the second pass of a loop reuses the merge copy name) does not delete the linked files', async () => {
    // Reported: "Engine error: EPERM, Permission denied: ...\worktrees\<run>-merge" on the loop's second pass,
    // because removing the old copy followed the link into the cache and deleted (or choked on) its files.
    const first = await git.createDetachedWorktree(repo, path.join(root, 'wt'), 'abc-merge', 'main')
    link(first.path)
    const second = await git.createDetachedWorktree(repo, path.join(root, 'wt'), 'abc-merge', 'main')
    expect(fs.existsSync(second.path)).toBe(true)
    expect(fs.existsSync(path.join(second.path, 'a.txt'))).toBe(true)
    expect(cacheIntact()).toBe(true)
  })

  it('removing one, whether or not creation recorded the link, leaves the linked files alone', async () => {
    const wt = await git.createDetachedWorktree(repo, path.join(root, 'wt'), 'abc-src', 'main')
    link(wt.path) // linked later, so wt.depsLink does not know about it
    await git.removeWorktree(repo, wt)
    expect(fs.existsSync(wt.path)).toBe(false)
    expect(cacheIntact()).toBe(true)
  })

  it('sweeping a leftover one after a crash leaves the linked files alone', async () => {
    const wt = await git.createDetachedWorktree(repo, path.join(root, 'wt'), 'abc-merge', 'main')
    link(wt.path)
    const r = await git.sweepWorktrees(path.join(root, 'wt'), () => false)
    expect(r.removed).toHaveLength(1)
    expect(cacheIntact()).toBe(true)
  })
})

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildLandBlueprint } from '../../shared/patterns'
import { foldRun, type RunEvent } from '../../shared/runs'
import type { AgentAdapter, StepResult } from './adapter'
import * as g from './gitops'
import { RunEngine } from './runner'

let root: string
let repo: string
const git = (...a: string[]): string => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim()
const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
  fs.writeFileSync(path.join(repo, rel), text)
}
const read = (rel: string): string => fs.readFileSync(path.join(repo, rel), 'utf8')

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-test-'))
  repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 't')
  git('config', 'user.email', 't@t')
  git('config', 'core.autocrlf', 'false')
  write('README.md', 'one\ntwo\n')
  write('.gitignore', 'ignored.log\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const noAgent: AgentAdapter = {
  run: async (): Promise<StepResult> => ({ ok: true, result: '', costUsd: 0, tokens: 0, sessionId: 's', budgetExhausted: false, timedOut: false, cancelled: false })
}
const exists = (f: string): string => `node -e "process.exit(require('fs').existsSync('${f}')?0:1)"`

async function land(branch: string, test = exists('new-file.txt')): Promise<ReturnType<typeof foldRun>> {
  const events: RunEvent[] = []
  const engine = new RunEngine({ adapter: noAgent, worktreeRoot: path.join(root, 'wt'), emit: (e) => events.push(e) })
  const bp = buildLandBlueprint({ branch, base: 'main', testCommand: test, resolveConflicts: false })
  const r = await engine.start({ projectId: 'p', projectName: 'repo', projectPath: repo, flowSlug: '__land__', blueprint: bp, inputs: { branch } })
  if (!r.ok) throw new Error(r.error)
  await engine.whenDone(r.runId)
  return foldRun(events)
}

describe('snapshotting uncommitted work', () => {
  it('sees edits, deletions and new files, and honours .gitignore and node_modules', async () => {
    const clean = await g.workingTreeId(repo)
    expect(clean).toBe(git('rev-parse', 'HEAD^{tree}'))
    write('README.md', 'one\nCHANGED\n')
    write('new-file.txt', 'hi\n')
    write('ignored.log', 'noise\n')
    write('node_modules/dep/index.js', 'x\n')
    const dirty = await g.workingTreeId(repo)
    expect(dirty).not.toBe(clean)
    // Only the real changes are in the snapshot.
    const snap = await g.snapshotCommit(repo, 'snap')
    const files = git('ls-tree', '-r', '--name-only', snap.sha).split('\n')
    expect(files).toContain('new-file.txt')
    expect(files).not.toContain('ignored.log')
    expect(files.some((f) => f.startsWith('node_modules'))).toBe(false)
    expect(git('show', `${snap.sha}:README.md`)).toContain('CHANGED')
  })

  it('does not touch your index, your files, or any branch', async () => {
    write('README.md', 'one\nCHANGED\n')
    write('new-file.txt', 'hi\n')
    const before = { status: git('status', '--porcelain'), head: git('rev-parse', 'HEAD'), branches: git('branch') }
    const snap = await g.snapshotCommit(repo, 'snap')
    expect(snap.changed).toBe(true)
    expect(snap.parent).toBe(before.head)
    expect({ status: git('status', '--porcelain'), head: git('rev-parse', 'HEAD'), branches: git('branch') }).toEqual(before)
    expect(git('diff', '--cached', '--name-only')).toBe('') // nothing was staged
    expect(read('new-file.txt')).toBe('hi\n')
  })

  it('says there is nothing to commit when the checkout is clean', async () => {
    expect((await g.snapshotCommit(repo, 'x')).changed).toBe(false)
  })

  it('a linked worktree is recognised as belonging to the same repository', async () => {
    const wt = path.join(root, 'linked')
    git('worktree', 'add', '-q', '-b', 'side', wt)
    expect(await g.commonDir(wt)).toBe(await g.commonDir(repo))
    // ...and a folder that is not a repository is not.
    await expect(g.commonDir(root)).rejects.toThrow()
  })
})

describe('committing onto the current branch', () => {
  it('commits like `git add -A && git commit`, leaving a clean tree and the same files', async () => {
    git('checkout', '-q', '-b', 'feat/x')
    write('README.md', 'one\nCHANGED\n')
    write('new-file.txt', 'hi\n')
    const r = await g.commitToCurrentBranch(repo, 'Work from a session')
    expect(r.branch).toBe('feat/x')
    expect(git('rev-parse', 'feat/x')).toBe(r.sha)
    expect(git('log', '-1', '--format=%s')).toBe('Work from a session')
    expect(git('status', '--porcelain')).toBe('')
    expect(read('README.md')).toContain('CHANGED')
    expect(read('new-file.txt')).toBe('hi\n')
    expect(git('rev-parse', 'main')).not.toBe(r.sha) // main never moved
  })

  it('refuses when there is nothing to commit, and on a detached HEAD', async () => {
    await expect(g.commitToCurrentBranch(repo, 'x')).rejects.toThrow(/nothing to commit/)
    write('new-file.txt', 'hi\n')
    git('checkout', '-q', '--detach')
    await expect(g.commitToCurrentBranch(repo, 'x')).rejects.toThrow(/detached/)
  })

  it('names a new branch uniquely', async () => {
    const sha = git('rev-parse', 'HEAD')
    expect(await g.createBranchAt(repo, 'agentship/work', sha)).toBe('agentship/work')
    expect(await g.createBranchAt(repo, 'agentship/work', sha)).toBe('agentship/work-2')
  })
})

describe('landing work that is sitting in main\'s own checkout', () => {
  it('tests it, merges it, and advances main WITHOUT changing a single file', async () => {
    // A session working directly on main: an edit to a tracked file, a new file, and a deletion.
    write('README.md', 'one\ntwo\nthree, added by the session\n')
    write('new-file.txt', 'brand new\n')
    fs.rmSync(path.join(repo, '.gitignore')) // a deletion
    const before = { readme: read('README.md'), created: read('new-file.txt'), mainTip: git('rev-parse', 'main') }

    const snap = await g.snapshotCommit(repo, 'Work from a session')
    const branch = await g.createBranchAt(repo, 'agentship/session-work', snap.sha)
    const v = await land(branch)

    expect(v?.status).toBe('passed')
    expect(v?.reason).toBe('Finished every step.')
    // main moved, and it now contains everything the session did.
    expect(git('rev-parse', 'main')).not.toBe(before.mainTip)
    expect(git('show', 'main:new-file.txt')).toBe('brand new')
    expect(git('show', 'main:README.md')).toContain('three, added by the session')
    expect(git('ls-tree', '-r', '--name-only', 'main')).not.toContain('.gitignore')
    // Your files are exactly as they were, and git now agrees the tree is clean.
    expect(read('README.md')).toBe(before.readme)
    expect(read('new-file.txt')).toBe(before.created)
    expect(git('status', '--porcelain')).toBe('')
    expect(git('worktree', 'list').split('\n')).toHaveLength(1)
  })

  it('refuses, and changes nothing, if you edited a file after the snapshot was taken', async () => {
    write('new-file.txt', 'brand new\n')
    const snap = await g.snapshotCommit(repo, 'Work from a session')
    const branch = await g.createBranchAt(repo, 'agentship/session-work', snap.sha)
    write('new-file.txt', 'brand new, then I kept typing\n') // an edit during the test
    const mainTip = git('rev-parse', 'main')

    const v = await land(branch)
    expect(v?.status).toBe('failed')
    expect(v?.reason).toMatch(/not the work being landed/)
    expect(git('rev-parse', 'main')).toBe(mainTip)
    expect(read('new-file.txt')).toBe('brand new, then I kept typing\n') // your typing survives
  })

  it('does not land work whose tests fail, and leaves main and your files alone', async () => {
    write('new-file.txt', 'brand new\n')
    const snap = await g.snapshotCommit(repo, 'Work from a session')
    const branch = await g.createBranchAt(repo, 'agentship/session-work', snap.sha)
    const mainTip = git('rev-parse', 'main')
    const v = await land(branch, exists('does-not-exist.txt'))
    expect(v?.status).toBe('failed')
    expect(git('rev-parse', 'main')).toBe(mainTip)
    expect(read('new-file.txt')).toBe('brand new\n')
    expect(git('status', '--porcelain')).toContain('new-file.txt') // still uncommitted: nothing was decided for you
  })
})

describe('landing a session that worked on a feature branch', () => {
  it('commit onto its branch, then the ordinary landing brings it into main', async () => {
    git('checkout', '-q', '-b', 'feat/x')
    write('new-file.txt', 'from the session\n')
    const r = await g.commitToCurrentBranch(repo, 'Work from a session')
    git('checkout', '-q', 'main')
    const v = await land(r.branch)
    expect(v?.status).toBe('passed')
    expect(git('show', 'main:new-file.txt')).toBe('from the session')
    expect(git('status', '--porcelain')).toBe('')
  })
})

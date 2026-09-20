// The few git operations the engine needs. Branches are the durable outcome of
// a run; worktrees are scratch space that is removed afterwards, so nothing
// accumulates on disk (the "worktrees pile up" complaint from the research).
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

async function git(cwd: string, args: string[], timeout = 30_000): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 })
  return stdout.trim()
}

export async function isRepoWithCommit(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--verify', 'HEAD'])
    return true
  } catch {
    return false
  }
}

/** Branch and worktree names must be safe as both git refs and directory names. */
export function safeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x'
}

export interface Worktree {
  path: string
  branch: string
}

/** New branch `branch` from `base`, checked out in a fresh directory. */
export async function createWorktree(
  repo: string,
  root: string,
  name: string,
  base: string
): Promise<Worktree> {
  const dir = path.join(root, name)
  const branch = `agentship/${name}`
  fs.mkdirSync(root, { recursive: true })
  await git(repo, ['worktree', 'add', '-b', branch, dir, base], 60_000)
  return { path: dir, branch }
}

async function identityArgs(cwd: string): Promise<string[]> {
  const have = async (key: string): Promise<boolean> => {
    try {
      return Boolean(await git(cwd, ['config', key]))
    } catch {
      return false
    }
  }
  // Only fill in what the user has not configured; never override their identity.
  return [
    ...((await have('user.name')) ? [] : ['-c', 'user.name=Agent Ship']),
    ...((await have('user.email')) ? [] : ['-c', 'user.email=agentship@localhost'])
  ]
}

/** Commits whatever the agent left in the tree. Returns true if a commit was made. */
export async function commitAll(cwd: string, message: string): Promise<boolean> {
  await git(cwd, ['add', '-A'])
  const dirty = await git(cwd, ['status', '--porcelain'])
  if (!dirty) return false
  await git(cwd, [...(await identityArgs(cwd)), 'commit', '-q', '-m', message])
  return true
}

/** Removes the working directory but keeps the branch and its commits. */
export async function removeWorktree(repo: string, wt: Worktree): Promise<void> {
  try {
    await git(repo, ['worktree', 'remove', '--force', wt.path], 60_000)
  } catch {
    // Already gone, or held open by a lingering process; prune what we can.
    await git(repo, ['worktree', 'prune']).catch(() => undefined)
  }
}

/** Files changed and lines added/removed on `branch` relative to `base`. */
export async function diffSummary(
  repo: string,
  base: string,
  branch: string
): Promise<{ files: number; added: number; removed: number }> {
  const out = await git(repo, ['diff', '--numstat', `${base}...${branch}`]).catch(() => '')
  let files = 0
  let added = 0
  let removed = 0
  for (const line of out.split('\n').filter(Boolean)) {
    const [a, r] = line.split('\t')
    files++
    added += Number.parseInt(a, 10) || 0
    removed += Number.parseInt(r, 10) || 0
  }
  return { files, added, removed }
}

// The git operations the engine needs. Branches are the durable outcome of a
// run; worktrees are scratch space that is removed afterwards, so nothing
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

/** Like `git`, but a non-zero exit is a result, not an exception. */
async function gitRaw(cwd: string, args: string[], timeout = 60_000): Promise<{ code: number; out: string; err: string }> {
  try {
    const { stdout, stderr } = await exec('git', args, { cwd, windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 })
    return { code: 0, out: stdout.trim(), err: stderr.trim() }
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string; message: string }
    return { code: typeof x.code === 'number' ? x.code : 1, out: (x.stdout ?? '').trim(), err: (x.stderr ?? x.message ?? '').trim() }
  }
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
  /** Empty for a detached scratch copy: those hold no work worth keeping. */
  branch: string
  detached?: boolean
  /** A link to the repo's dependencies that must be unlinked, never deleted through. */
  depsLink?: string
}

// A fresh worktree has none of the untracked files a project needs to run its
// tests. Node projects are the common case, so link the repo's node_modules in.
function linkDependencies(repo: string, wt: string): string | undefined {
  const source = path.join(repo, 'node_modules')
  const link = path.join(wt, 'node_modules')
  try {
    if (!fs.existsSync(source) || fs.existsSync(link)) return undefined
    fs.symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir')
    return link
  } catch {
    return undefined
  }
}

/** Never let `git worktree remove` recurse through the link into the real dependencies. */
function unlinkDependencies(link: string | undefined): void {
  if (!link) return
  try {
    if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link)
  } catch {
    /* already gone */
  }
}

/** The pathspec that keeps a linked or generated node_modules out of commits. */
const NO_DEPS = [':(exclude)node_modules']

/** New branch `branch` from `base`, checked out in a fresh directory. */
export async function createWorktree(repo: string, root: string, name: string, base: string): Promise<Worktree> {
  const dir = path.join(root, name)
  const branch = `agentship/${name}`
  fs.mkdirSync(root, { recursive: true })
  await git(repo, ['worktree', 'add', '-b', branch, dir, base], 60_000)
  return { path: dir, branch, depsLink: linkDependencies(repo, dir) }
}

/** A throwaway checkout of `rev` (a branch or a commit). No branch is created. */
export async function createDetachedWorktree(repo: string, root: string, name: string, rev: string): Promise<Worktree> {
  const dir = path.join(root, name)
  fs.mkdirSync(root, { recursive: true })
  await git(repo, ['worktree', 'add', '--detach', dir, rev], 60_000)
  return { path: dir, branch: '', detached: true, depsLink: linkDependencies(repo, dir) }
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
  await git(cwd, ['add', '-A', '--', '.', ...NO_DEPS])
  const dirty = await git(cwd, ['status', '--porcelain', '--', '.', ...NO_DEPS])
  if (!dirty) return false
  await git(cwd, [...(await identityArgs(cwd)), 'commit', '-q', '-m', message])
  return true
}

/** Removes the working directory but keeps the branch and its commits. */
export async function removeWorktree(repo: string, wt: Worktree): Promise<void> {
  unlinkDependencies(wt.depsLink)
  try {
    await git(repo, ['worktree', 'remove', '--force', wt.path], 60_000)
  } catch {
    // Already gone, or held open by a lingering process; prune what we can.
    await git(repo, ['worktree', 'prune']).catch(() => undefined)
  }
}

export async function refExists(repo: string, ref: string): Promise<boolean> {
  return (await gitRaw(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).code === 0
}

export async function tip(repo: string, ref: string): Promise<string> {
  return git(repo, ['rev-parse', `${ref}^{commit}`])
}

export async function head(cwd: string): Promise<string> {
  return git(cwd, ['rev-parse', 'HEAD'])
}

export async function unmergedPaths(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')
  return out.split('\n').map((l) => l.trim()).filter(Boolean)
}

/** A real merge commit (never a fast-forward), so landing is one revertable step. */
export async function mergeNoFf(cwd: string, source: string): Promise<{ ok: true } | { ok: false; conflicts: string[]; message: string }> {
  const r = await gitRaw(cwd, [...(await identityArgs(cwd)), 'merge', '--no-ff', '--no-edit', source])
  if (r.code === 0) return { ok: true }
  const conflicts = await unmergedPaths(cwd)
  // A failure with no conflicted files is not a conflict (unrelated histories, bad ref...).
  if (conflicts.length === 0) throw new Error(r.err || r.out || 'git merge failed')
  return { ok: false, conflicts, message: r.out }
}

export async function abortMerge(cwd: string): Promise<void> {
  await gitRaw(cwd, ['merge', '--abort'])
}

/** True when the staged result still contains conflict markers or whitespace-damaging leftovers. */
export async function hasConflictMarkers(cwd: string): Promise<boolean> {
  return (await gitRaw(cwd, ['diff', '--cached', '--check'])).code !== 0
}

/** Finishes a merge whose conflicts have been resolved and staged. */
export async function concludeMerge(cwd: string): Promise<void> {
  await git(cwd, [...(await identityArgs(cwd)), 'commit', '--no-edit', '-q'])
}

export async function isClean(cwd: string): Promise<boolean> {
  return (await git(cwd, ['status', '--porcelain', '--untracked-files=no'])) === ''
}

/** Where `branch` is checked out right now (the main checkout or any worktree), if anywhere. */
export async function worktreeHolding(repo: string, branch: string): Promise<string | null> {
  const out = await git(repo, ['worktree', 'list', '--porcelain']).catch(() => '')
  let current = ''
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length).trim()
    else if (line.trim() === `branch refs/heads/${branch}`) return current
  }
  return null
}

/** Moves a checked-out branch forward. Fails, harmlessly, if it is not a fast-forward. */
export async function fastForward(cwd: string, sha: string): Promise<boolean> {
  return (await gitRaw(cwd, ['merge', '--ff-only', sha])).code === 0
}

/** Moves a branch that is checked out nowhere. Fails if it moved since `oldSha`. */
export async function updateBranch(repo: string, branch: string, sha: string, oldSha: string): Promise<boolean> {
  return (await gitRaw(repo, ['update-ref', `refs/heads/${branch}`, sha, oldSha])).code === 0
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

/** A sensible default test command for a project, or '' when there is none to guess. */
export function detectTestCommand(repo: string): { command: string; source: string } {
  const has = (f: string): boolean => fs.existsSync(path.join(repo, f))
  try {
    if (has('package.json')) {
      const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
      const t = pkg.scripts?.test
      // `npm init` writes a placeholder that always fails.
      if (t && !/no test specified/i.test(t)) return { command: 'npm test', source: 'package.json "test" script' }
    }
  } catch {
    /* unreadable package.json: fall through */
  }
  if (has('Cargo.toml')) return { command: 'cargo test', source: 'Cargo.toml' }
  if (has('go.mod')) return { command: 'go test ./...', source: 'go.mod' }
  if (has('pytest.ini') || has('pyproject.toml')) return { command: 'pytest', source: 'pytest / pyproject.toml' }
  return { command: '', source: '' }
}

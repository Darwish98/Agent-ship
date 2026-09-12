// Git state for a room/agent: which branch it sits on, and whether it is
// carrying work that hasn't reached the main branch yet (the "envelope").
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface GitState {
  /** Whether the path is inside a git work tree at all. */
  isRepo: boolean
  branch: string
  /** Base branch this repo merges into ("main" / "master"). */
  baseBranch: string
  /** Commits on this branch that the base branch doesn't have. */
  ahead: number
  /** Uncommitted/untracked files in the work tree. */
  dirtyFiles: number
  /** True when there is unmerged work worth collecting - drives the envelope. */
  hasUnmergedWork: boolean
}

const EMPTY: GitState = {
  isRepo: false,
  branch: '',
  baseBranch: '',
  ahead: 0,
  dirtyFiles: 0,
  hasUnmergedWork: false
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, windowsHide: true, timeout: 5000 })
  return stdout.trim()
}

async function resolveBaseBranch(cwd: string): Promise<string> {
  for (const candidate of ['main', 'master']) {
    try {
      await git(cwd, ['rev-parse', '--verify', '--quiet', candidate])
      return candidate
    } catch {
      // Not present - try the next one.
    }
  }
  return ''
}

export async function gitState(cwd: string): Promise<GitState> {
  if (!cwd) return EMPTY
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    return EMPTY
  }

  const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')
  const baseBranch = await resolveBaseBranch(cwd)

  let ahead = 0
  if (baseBranch && branch && branch !== baseBranch) {
    const count = await git(cwd, ['rev-list', '--count', `${baseBranch}..HEAD`]).catch(() => '0')
    ahead = Number.parseInt(count, 10) || 0
  }

  const status = await git(cwd, ['status', '--porcelain']).catch(() => '')
  const dirtyFiles = status ? status.split('\n').filter(Boolean).length : 0

  return {
    isRepo: true,
    branch,
    baseBranch,
    ahead,
    dirtyFiles,
    hasUnmergedWork: ahead > 0 || dirtyFiles > 0
  }
}

/** Branches other than the base branch that hold commits the base lacks -
 *  what the orchestrator offers to merge. */
export async function unmergedBranches(cwd: string): Promise<{ branch: string; ahead: number }[]> {
  const base = await resolveBaseBranch(cwd)
  if (!base) return []

  const raw = await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).catch(() => '')
  const branches = raw.split('\n').map((b) => b.trim()).filter(Boolean)

  const out: { branch: string; ahead: number }[] = []
  for (const branch of branches) {
    if (branch === base) continue
    const count = await git(cwd, ['rev-list', '--count', `${base}..${branch}`]).catch(() => '0')
    const ahead = Number.parseInt(count, 10) || 0
    if (ahead > 0) out.push({ branch, ahead })
  }
  return out
}

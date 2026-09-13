// Launches real Claude Code background agents (`claude --bg`) - the same
// first-class session mechanism the Claude Code CLI uses, so anything spawned
// here also shows up in `claude agents` / /resume, not just in this app.
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface SpawnResult {
  ok: boolean
  error?: string
}

export interface RunningAgent {
  pid: number
  cwd: string
  /** "interactive" for a session you're driving, background for `--bg` ones. */
  kind: string
  sessionId: string
  name: string
  startedAt: number
}

/**
 * Sessions Claude Code reports as actually alive right now. Hook events only
 * fire on tool use, so a session sitting idle mid-conversation looks dead to
 * them - this is the authoritative liveness signal.
 */
export async function listRunningAgents(): Promise<RunningAgent[]> {
  try {
    const { stdout } = await run('claude', ['agents', '--json'], {
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024
    })
    const parsed: unknown = JSON.parse(stdout)
    return Array.isArray(parsed) ? (parsed as RunningAgent[]) : []
  } catch {
    // Claude Code missing, slow, or a version without --json: just report
    // nothing running rather than breaking the whole view.
    return []
  }
}

/** Opens Claude Code on exactly this session, in its own working directory. */
export function openSession(sessionId: string, cwd: string): SpawnResult {
  if (!sessionId) return { ok: false, error: 'No session id.' }
  try {
    if (process.platform === 'win32') {
      // `start` is a cmd builtin, and the extra "" is start's title argument -
      // without it the first quoted token is swallowed as the window title.
      spawn('cmd.exe', ['/c', 'start', '', 'cmd', '/k', 'claude', '--resume', sessionId], {
        cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      }).unref()
    } else if (process.platform === 'darwin') {
      const script = `tell application "Terminal" to do script "cd ${JSON.stringify(cwd)} && claude --resume ${sessionId}"`
      spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('x-terminal-emulator', ['-e', `claude --resume ${sessionId}`], {
        cwd,
        detached: true,
        stdio: 'ignore'
      }).unref()
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) }
  }
}

/** Stops a running session by killing its process tree. */
export async function stopAgent(pid: number): Promise<SpawnResult> {
  if (!pid) return { ok: false, error: 'No process id.' }
  try {
    if (process.platform === 'win32') {
      await run('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    } else {
      process.kill(pid, 'SIGTERM')
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) }
  }
}

// No shell: claude is a real binary, and passing argv directly (rather than
// building a shell command string) sidesteps the whole class of Windows
// cmd.exe quoting problems a free-text task string could otherwise trigger.
function launch(args: string[], cwd: string, env: Record<string, string>): SpawnResult {
  try {
    const child = spawn('claude', args, {
      cwd,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, ...env }
    })
    child.on('error', (err) => console.error('Failed to launch claude:', err))
    child.unref()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) }
  }
}

export function spawnAgent(projectPath: string, role: string, task: string): SpawnResult {
  if (!projectPath || !task) return { ok: false, error: 'A project and task are required.' }
  const label = (role || 'Agent').trim() || 'Agent'
  return launch(['--bg', '--name', label, task], projectPath, {
    AGENT_SHIP_NAME: label,
    AGENT_SHIP_ROLE: label,
    AGENT_SHIP_TASK: task
  })
}

/** Hands a new task to an existing session, continuing its history. */
export function resumeSession(sessionId: string, cwd: string, task: string): SpawnResult {
  if (!sessionId || !task) return { ok: false, error: 'A session and task are required.' }
  return launch(['--bg', '--resume', sessionId, task], cwd, { AGENT_SHIP_TASK: task })
}

/**
 * Spawns an agent whose job is to land the listed branches on the base
 * branch, resolving conflicts as it goes. The merging itself is done by a
 * real Claude Code agent in the repo - this only writes the brief.
 */
export function spawnMergeOrchestrator(
  projectPath: string,
  baseBranch: string,
  branches: string[]
): SpawnResult {
  if (!projectPath) return { ok: false, error: 'No project path.' }
  if (!branches.length) return { ok: false, error: 'Nothing to merge.' }

  const task = [
    `You are the merge orchestrator for this repository.`,
    ``,
    `Land these branches on "${baseBranch}", one at a time, oldest first:`,
    ...branches.map((b) => `  - ${b}`),
    ``,
    `For each branch:`,
    `1. git checkout ${baseBranch} && git merge <branch>`,
    `2. If there are conflicts, read both sides and resolve them so the`,
    `   intent of BOTH changes survives. Never resolve by blindly taking one`,
    `   side, and never delete another agent's work to make a conflict go away.`,
    `3. If the repo has tests or a typecheck/build script, run it after each`,
    `   merge and fix anything the merge broke before moving on.`,
    `4. Commit the merge with a message naming the branch you landed.`,
    ``,
    `Do not force-push, do not rebase shared history, and do not delete`,
    `branches. If a branch is too conflicted to land safely, stop, leave it`,
    `unmerged, and report why.`
  ].join('\n')

  return launch(['--bg', '--name', 'Orchestrator', task], projectPath, {
    AGENT_SHIP_NAME: 'Orchestrator',
    AGENT_SHIP_ROLE: 'Orchestrator',
    AGENT_SHIP_TASK: `Merge ${branches.length} branch(es) into ${baseBranch}`
  })
}

/** Spawns an orchestrator that delegates the given briefs to sub-agents. */
export function spawnOrchestrator(projectPath: string, brief: string): SpawnResult {
  if (!projectPath || !brief) return { ok: false, error: 'A project and brief are required.' }
  return launch(['--bg', '--name', 'Orchestrator', brief], projectPath, {
    AGENT_SHIP_NAME: 'Orchestrator',
    AGENT_SHIP_ROLE: 'Orchestrator',
    AGENT_SHIP_TASK: brief
  })
}

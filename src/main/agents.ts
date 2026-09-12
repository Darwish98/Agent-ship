// Launches real Claude Code background agents (`claude --bg`) - the same
// first-class session mechanism the Claude Code CLI uses, so anything spawned
// here also shows up in `claude agents` / /resume, not just in this app.
import { spawn } from 'node:child_process'

export interface SpawnResult {
  ok: boolean
  error?: string
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

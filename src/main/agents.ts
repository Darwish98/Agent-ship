// Launches real Claude Code background agents (`claude --bg`) - the same
// first-class session mechanism the Claude Code CLI uses, so anything spawned
// here also shows up in `claude agents` / /resume, not just in this app.
import { shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { renderTemplate } from '../shared/blueprint'
import { MERGE_TRAIN_PATTERN } from '../shared/patterns'

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
  /** As reported by `claude agents --json` (observed: idle, busy). */
  status?: string
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

const SESSION_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * Opens this session in Claude Desktop's Code section via its own deep link.
 *
 * Claude Desktop registers the `claude://` scheme and routes `resume` by
 * importing the CLI session with that id; the id must be a bare UUID, which
 * is exactly what Claude Code names its transcripts. (Its sibling route,
 * `code/continue`, only accepts desktop-native `local_*` ids or "last".)
 */
export async function openSession(sessionId: string): Promise<SpawnResult> {
  if (!SESSION_UUID.test(sessionId)) return { ok: false, error: 'Not a Claude Code session id.' }
  try {
    await shell.openExternal(`claude://resume?session=${sessionId}`)
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
 * real Claude Code agent in the repo; the brief comes from the shipped
 * "Merge train" blueprint, not from text hard-coded here.
 */
export function spawnMergeOrchestrator(
  projectPath: string,
  baseBranch: string,
  branches: string[]
): SpawnResult {
  if (!projectPath) return { ok: false, error: 'No project path.' }
  if (!branches.length) return { ok: false, error: 'Nothing to merge.' }

  const node = MERGE_TRAIN_PATTERN.nodes.find((n) => n.kind === 'merge')
  if (node?.kind !== 'merge') return { ok: false, error: 'The Merge train blueprint is missing its merge node.' }

  const task = renderTemplate(node.config.resolverPrompt, {
    baseBranch,
    branches: branches.map((b) => `  - ${b}`).join('\n')
  })

  return launch(['--bg', '--name', 'Orchestrator', task], projectPath, {
    AGENT_SHIP_NAME: 'Orchestrator',
    AGENT_SHIP_ROLE: 'Orchestrator',
    AGENT_SHIP_TASK: `Merge ${branches.length} branch(es) into ${baseBranch}`
  })
}

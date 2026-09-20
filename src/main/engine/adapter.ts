// The one place that knows how to talk to Claude Code. Everything above it
// (the runner) deals in StepRequest / StepResult, so a second vendor later is
// a second adapter, not a rewrite.
import { spawn, spawnSync } from 'node:child_process'

export interface StepRequest {
  prompt: string
  cwd: string
  /** Chosen by the engine up front so the Floor can recognise the session. */
  sessionId: string
  /** Continue an earlier session (a gate-fail repair loop) instead of starting one. */
  resume: boolean
  model: string
  access: 'read' | 'edit'
  tools: string[]
  maxUsd: number
  /** JSON Schema as text; empty for free text. */
  jsonSchema: string
  env: Record<string, string>
  timeoutMs: number
  signal: AbortSignal
}

export interface StepResult {
  ok: boolean
  result: string
  structured?: unknown
  costUsd: number
  /** Billed tokens: input + output + cache writes. Cache reads are excluded,
   *  matching how the weekly fuel gauge counts. */
  tokens: number
  sessionId: string
  error?: string
  budgetExhausted: boolean
  timedOut: boolean
  cancelled: boolean
}

export interface AgentAdapter {
  run(req: StepRequest): Promise<StepResult>
}

const READ_TOOLS = ['Read', 'Glob', 'Grep']

/** Exported for tests: the exact CLI surface the engine relies on (see
 *  docs/spikes/claude-cli.md). The prompt itself goes over stdin, never argv. */
export function buildClaudeArgs(req: StepRequest): string[] {
  const args = ['-p', '--output-format', 'json']
  args.push(req.resume ? '--resume' : '--session-id', req.sessionId)
  if (req.model && req.model !== 'default') args.push('--model', req.model)
  // Nothing is ever allowed to prompt: a step that would ask is denied, and
  // the denial shows up in its result rather than hanging a headless run.
  args.push('--permission-mode', req.access === 'edit' ? 'acceptEdits' : 'dontAsk')
  args.push('--permission-prompts', 'none')
  args.push('--max-budget-usd', String(Number(req.maxUsd.toFixed(4))))
  if (req.jsonSchema.trim()) args.push('--json-schema', req.jsonSchema)
  // Variadic, so it goes last; the prompt is on stdin, not argv.
  args.push('--allowedTools', ...new Set([...READ_TOOLS, ...req.tools]))
  return args
}

/** Test seam: run something else in place of the real CLI (a JSON array). */
export function commandPrefix(): string[] {
  const raw = process.env.AGENT_SHIP_CLAUDE_CMD
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') && parsed.length) return parsed as string[]
    } catch {
      /* fall through to the real CLI */
    }
  }
  return ['claude']
}

export function killTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  else {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
}

interface CliJson {
  result?: string
  structured_output?: unknown
  session_id?: string
  total_cost_usd?: number
  is_error?: boolean
  subtype?: string
  terminal_reason?: string
  errors?: string[]
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number }
}

export class ClaudeCodeAdapter implements AgentAdapter {
  run(req: StepRequest): Promise<StepResult> {
    const [bin, ...prefix] = commandPrefix()
    const base: StepResult = {
      ok: false,
      result: '',
      costUsd: 0,
      tokens: 0,
      sessionId: req.sessionId,
      budgetExhausted: false,
      timedOut: false,
      cancelled: false
    }

    return new Promise((resolve) => {
      if (req.signal.aborted) return resolve({ ...base, cancelled: true, error: 'Cancelled before it started.' })

      const child = spawn(bin, [...prefix, ...buildClaudeArgs(req)], {
        cwd: req.cwd,
        windowsHide: true,
        env: { ...process.env, ...req.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32'
      })

      let out = ''
      let err = ''
      let timedOut = false
      let cancelled = false
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (err += d))

      const timer = setTimeout(() => {
        timedOut = true
        killTree(child.pid)
      }, req.timeoutMs)
      const onAbort = (): void => {
        cancelled = true
        killTree(child.pid)
      }
      req.signal.addEventListener('abort', onAbort, { once: true })

      child.on('error', (e) => {
        clearTimeout(timer)
        req.signal.removeEventListener('abort', onAbort)
        resolve({ ...base, error: `Could not start claude: ${e.message}` })
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        req.signal.removeEventListener('abort', onAbort)
        if (cancelled) return resolve({ ...base, cancelled: true, error: 'Cancelled.' })
        if (timedOut) return resolve({ ...base, timedOut: true, error: 'Timed out.' })

        let json: CliJson | null = null
        try {
          json = JSON.parse(out) as CliJson
        } catch {
          /* handled below */
        }
        if (!json) {
          return resolve({ ...base, error: `No result from claude (exit ${code}). ${err.trim().slice(0, 400)}` })
        }

        const u = json.usage ?? {}
        const budgetExhausted = json.subtype === 'error_max_budget_usd' || json.terminal_reason === 'budget_exhausted'
        resolve({
          ...base,
          ok: code === 0 && !json.is_error,
          result: json.result ?? '',
          structured: json.structured_output,
          costUsd: json.total_cost_usd ?? 0,
          tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          sessionId: json.session_id ?? req.sessionId,
          budgetExhausted,
          error: code === 0 && !json.is_error ? undefined : (json.errors?.join('; ') || json.subtype || `exit ${code}`)
        })
      })

      child.stdin.on('error', () => undefined)
      child.stdin.end(req.prompt)
    })
  }
}

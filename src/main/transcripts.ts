// Reads Claude Code's own local session transcripts (~/.claude/projects/**/*.jsonl).
// Everything here is derived from files Claude Code already writes on this
// machine - no network calls, no API keys, nothing sent anywhere.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface SessionSummary {
  sessionId: string
  cwd: string
  gitBranch: string
  title: string
  lastPrompt: string
  model: string
  /** How the session was started: claude-desktop, cli, sdk-cli... */
  entrypoint: string
  updatedAt: number
  /** Context tokens occupied by the last assistant turn (battery). */
  contextTokens: number
  /** Assumed context window for that model - see CONTEXT_LIMITS. */
  contextLimit: number
  /** Tokens actually billed across the whole session (in + out, excludes cache reads). */
  billedTokens: number
  isSidechain: boolean
}

export interface UsageWindow {
  /** Billed tokens across all local sessions in the trailing 7 days. */
  weeklyTokens: number
  since: number
}

// Claude Code never records the model's context window in the transcript, so
// these are assumptions, not readings. The UI treats them as a soft ceiling
// and raises it if a session is observed exceeding it, so the gauge can't
// silently read past 100%.
const CONTEXT_LIMITS: Record<string, number> = {
  'claude-opus-5': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-haiku-4-5': 200_000
}
const DEFAULT_CONTEXT_LIMIT = 200_000

export function contextLimitFor(model: string): number {
  if (!model) return DEFAULT_CONTEXT_LIMIT
  for (const [prefix, limit] of Object.entries(CONTEXT_LIMITS)) {
    if (model.startsWith(prefix)) return limit
  }
  return DEFAULT_CONTEXT_LIMIT
}

export function projectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects')
}

function safeParse(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Transcripts get very large (tens of MB for a long session), and we only
 * need a handful of fields - so read the tail for the freshest usage/branch
 * and the head for the title, instead of parsing the whole file.
 */
function readEdges(file: string, edgeBytes = 512 * 1024): { head: string[]; tail: string[] } {
  const size = fs.statSync(file).size
  const fd = fs.openSync(file, 'r')
  try {
    const headLen = Math.min(edgeBytes, size)
    const headBuf = Buffer.alloc(headLen)
    fs.readSync(fd, headBuf, 0, headLen, 0)

    const tailLen = Math.min(edgeBytes, size)
    const tailBuf = Buffer.alloc(tailLen)
    fs.readSync(fd, tailBuf, 0, tailLen, Math.max(0, size - tailLen))

    return {
      head: headBuf.toString('utf8').split('\n').filter(Boolean),
      tail: tailBuf.toString('utf8').split('\n').filter(Boolean)
    }
  } finally {
    fs.closeSync(fd)
  }
}

interface Usage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

/** What the model is currently holding in context - the battery reading. */
function contextOccupancy(u: Usage): number {
  return (
    (u.input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.output_tokens ?? 0)
  )
}

/** What the turn actually cost. Cache *reads* are excluded on purpose - they
 *  are re-sent context, not new billable volume, so counting them would
 *  inflate weekly usage by an order of magnitude. */
function billedTokens(u: Usage): number {
  return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0)
}

function summarizeFile(file: string): SessionSummary | null {
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    return null
  }
  if (!stat.size) return null

  let head: string[], tail: string[]
  try {
    ;({ head, tail } = readEdges(file))
  } catch {
    return null
  }

  let title = ''
  let lastPrompt = ''
  let cwd = ''
  let gitBranch = ''
  let model = ''
  let entrypoint = ''
  let contextTokens = 0
  let isSidechain = false
  let sessionId = path.basename(file, '.jsonl')

  // Claude Code names a session either explicitly (custom-title) or by
  // summarising it (ai-title); both count as "this session is real work".
  const readTitle = (o: Record<string, unknown>): void => {
    if (o.type === 'custom-title' && typeof o.customTitle === 'string') title = o.customTitle
    else if (o.type === 'ai-title' && typeof o.title === 'string' && !title) title = o.title
  }

  for (const line of head) {
    const o = safeParse(line)
    if (!o) continue
    readTitle(o)
    if (typeof o.cwd === 'string' && !cwd) cwd = o.cwd
    if (typeof o.sessionId === 'string') sessionId = o.sessionId
    if (typeof o.entrypoint === 'string') entrypoint = o.entrypoint
  }

  // The tail holds the freshest state: latest branch, latest model, latest usage.
  for (const line of tail) {
    const o = safeParse(line)
    if (!o) continue
    readTitle(o)
    if (o.type === 'last-prompt' && typeof o.lastPrompt === 'string') lastPrompt = o.lastPrompt
    if (typeof o.cwd === 'string') cwd = o.cwd
    if (typeof o.gitBranch === 'string') gitBranch = o.gitBranch
    if (typeof o.entrypoint === 'string') entrypoint = o.entrypoint
    if (o.isSidechain === true) isSidechain = true
    const message = o.message as { model?: string; usage?: Usage } | undefined
    if (o.type === 'assistant' && message?.usage) {
      if (message.model) model = message.model
      contextTokens = contextOccupancy(message.usage)
    }
  }

  // An untitled session is a scratch/aborted run - Claude Code doesn't list
  // those either, and they were the ones reading as demo filler here.
  if (!cwd || !title) return null

  return {
    sessionId,
    cwd,
    gitBranch,
    title,
    lastPrompt,
    model,
    entrypoint,
    updatedAt: stat.mtimeMs,
    contextTokens,
    contextLimit: contextLimitFor(model),
    billedTokens: 0,
    isSidechain
  }
}

/** Every local session, newest first. Sidechains (subagent transcripts) are
 *  excluded - they show up as crew via hook events instead. */
export function listSessions(limit = 60): SessionSummary[] {
  const root = projectsDir()
  if (!fs.existsSync(root)) return []

  const files: string[] = []
  for (const dir of fs.readdirSync(root)) {
    const dirPath = path.join(root, dir)
    let entries: string[]
    try {
      if (!fs.statSync(dirPath).isDirectory()) continue
      entries = fs.readdirSync(dirPath)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.endsWith('.jsonl')) files.push(path.join(dirPath, entry))
    }
  }

  const sessions: SessionSummary[] = []
  for (const file of files) {
    const summary = summarizeFile(file)
    if (summary && !summary.isSidechain) sessions.push(summary)
  }

  return sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
}

/** What one transcript has already been read for. Transcripts are append-only,
 *  so a poll only has to read the bytes added since the last one. */
interface FileUsage {
  /** Bytes consumed so far; always ends on a line boundary. */
  offset: number
  lines: number
  calls: { id: string; ts: number; tokens: number }[]
}
const usageCache = new Map<string, FileUsage>()

/** The complete lines between `from` and the end of the file, and how many bytes they took. */
function readNewLines(file: string, from: number, size: number): { text: string; consumed: number } {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(size - from)
    const n = fs.readSync(fd, buf, 0, buf.length, from)
    const chunk = buf.subarray(0, n)
    const lastNl = chunk.lastIndexOf(0x0a)
    const tail = chunk.subarray(lastNl + 1).toString('utf8')
    // A last line with no newline is either still being written (a prefix of a
    // JSON object never parses: leave it for the next poll) or a finished line
    // whose newline simply is not there. Only the first is skipped.
    let whole = true
    if (tail) {
      try {
        JSON.parse(tail)
      } catch {
        whole = false
      }
    }
    if (whole) return { text: chunk.toString('utf8'), consumed: n }
    if (lastNl < 0) return { text: '', consumed: 0 }
    return { text: chunk.subarray(0, lastNl).toString('utf8'), consumed: lastNl + 1 }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Trailing-7-day billed token total across every local transcript - the
 * Usage gauge's reading. This is local volume only: Claude Code does not record the
 * account's actual plan limit anywhere on disk, so the percentage shown in
 * the UI is against a budget the user sets, not a real quota.
 *
 * One real API call can appear as SEVERAL "assistant" lines in a transcript -
 * Claude Code writes one line per content block of the response (a thinking
 * block, a text block, each tool call), and every one of those lines carries
 * the SAME usage object for that whole call, since usage belongs to the
 * response, not to one block of it. Summing every line therefore counts a
 * single call once per content block it happened to have - measured on a
 * real local history, close to 3x over. `message.id` is the same across every
 * line of one call (confirmed against real transcripts) and changes for the
 * next, so it is what a call is deduplicated by; a line missing it (should
 * not happen, but never trusted blindly) falls back to counting itself once
 * by its own line id rather than being silently dropped.
 *
 * This runs every minute, and a week of transcripts is tens of megabytes, so
 * each file is parsed once and afterwards only its newly appended lines are
 * (see `usageCache`); the sum itself is over small cached records.
 */
export function weeklyUsage(): UsageWindow {
  const root = projectsDir()
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000
  if (!fs.existsSync(root)) {
    usageCache.clear()
    return { weeklyTokens: 0, since }
  }

  const live = new Set<string>()
  const inWindow: FileUsage[] = []
  for (const dir of fs.readdirSync(root)) {
    const dirPath = path.join(root, dir)
    let entries: string[]
    try {
      if (!fs.statSync(dirPath).isDirectory()) continue
      entries = fs.readdirSync(dirPath)
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue
      const file = path.join(dirPath, entry)
      try {
        const st = fs.statSync(file)
        if (st.mtimeMs < since) continue
        live.add(file)
        let cached = usageCache.get(file)
        // Shorter than what was read before: it was rewritten, so start over.
        if (!cached || st.size < cached.offset) {
          cached = { offset: 0, lines: 0, calls: [] }
          usageCache.set(file, cached)
        }
        if (st.size > cached.offset) {
          const { text, consumed } = readNewLines(file, cached.offset, st.size)
          for (const line of text.split('\n')) {
            const i = cached.lines++
            if (!line || !line.includes('"usage"')) continue
            const o = safeParse(line)
            const message = o?.message as { id?: string; usage?: Usage } | undefined
            if (o?.type !== 'assistant' || !message?.usage) continue
            const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
            const id = message.id || (typeof o.uuid === 'string' ? o.uuid : `${file}:${i}`)
            cached.calls.push({ id, ts, tokens: billedTokens(message.usage) })
          }
          cached.offset += consumed
        }
        inWindow.push(cached)
      } catch {
        // Unreadable or actively-written transcript - skip it rather than
        // failing the whole reading.
      }
    }
  }
  // Files that left the window (or were deleted) no longer need remembering.
  for (const file of usageCache.keys()) if (!live.has(file)) usageCache.delete(file)

  // Timestamps are per-line, so a file touched this week can still hold older
  // turns - filter call by call rather than trusting the file's mtime.
  let total = 0
  const countedCalls = new Set<string>()
  for (const { calls } of inWindow) {
    for (const call of calls) {
      if (Number.isFinite(call.ts) && call.ts < since) continue
      if (countedCalls.has(call.id)) continue
      countedCalls.add(call.id)
      total += call.tokens
    }
  }
  return { weeklyTokens: total, since }
}

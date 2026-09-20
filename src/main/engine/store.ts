// Runs are append-only JSONL, one file per run. Every state change is written
// before anything reacts to it, so the file is always the truth and a run can
// be rebuilt from it after a crash.
import fs from 'node:fs'
import path from 'node:path'
import type { RunEvent } from '../../shared/runs'

const RUN_ID = /^[0-9a-f-]{36}$/

function endsWithNewline(file: string): boolean {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    if (size === 0) return true
    const b = Buffer.alloc(1)
    fs.readSync(fd, b, 0, 1, size - 1)
    return b[0] === 0x0a
  } finally {
    fs.closeSync(fd)
  }
}

export class RunStore {
  constructor(private readonly dir: string) {}

  private file(runId: string): string | null {
    return RUN_ID.test(runId) ? path.join(this.dir, `${runId}.jsonl`) : null
  }

  append(event: RunEvent): void {
    const f = this.file(event.runId)
    if (!f) return
    fs.mkdirSync(this.dir, { recursive: true })
    // A crash mid-write leaves a line with no newline; without this the next
    // event would be glued onto it and lost with it.
    const lead = fs.existsSync(f) && !endsWithNewline(f) ? '\n' : ''
    fs.appendFileSync(f, `${lead}${JSON.stringify(event)}\n`)
  }

  read(runId: string): RunEvent[] {
    const f = this.file(runId)
    if (!f || !fs.existsSync(f)) return []
    const events: RunEvent[] = []
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line) as RunEvent)
      } catch {
        // A torn final line from a crash must not hide the rest of the run.
      }
    }
    return events
  }

  /** Most recently written runs first. */
  list(limit = 40): { runId: string; events: RunEvent[] }[] {
    if (!fs.existsSync(this.dir)) return []
    return fs
      .readdirSync(this.dir)
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => ({ n, t: fs.statSync(path.join(this.dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, limit)
      .map(({ n }) => ({ runId: n.slice(0, -'.jsonl'.length), events: this.read(n.slice(0, -'.jsonl'.length)) }))
      .filter((r) => r.events.length > 0)
  }

  /** Runs that were mid-flight when the app died can never finish. Say so. */
  markInterrupted(now = Date.now()): string[] {
    const fixed: string[] = []
    for (const { runId, events } of this.list(200)) {
      if (events.some((e) => e.type === 'run.finished')) continue
      this.append({ type: 'run.finished', at: now, runId, status: 'interrupted', reason: 'Agent Ship closed while this run was in progress.' })
      fixed.push(runId)
    }
    return fixed
  }
}

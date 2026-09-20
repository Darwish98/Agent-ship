// A plain log file, so "the window went blank" becomes something diagnosable
// instead of "reload and hope". Lives in <userData>/logs; one previous file is
// kept when the current one passes 1 MB.
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

const MAX_BYTES = 1_000_000
let file = ''

function logFile(): string {
  if (!file) {
    const dir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    file = path.join(dir, 'main.log')
  }
  return file
}

function write(level: string, parts: unknown[]): void {
  try {
    const f = logFile()
    if (fs.existsSync(f) && fs.statSync(f).size > MAX_BYTES) fs.renameSync(f, `${f}.1`)
    const text = parts
      .map((p) => (p instanceof Error ? (p.stack ?? p.message) : typeof p === 'string' ? p : JSON.stringify(p)))
      .join(' ')
    fs.appendFileSync(f, `${new Date().toISOString()} ${level} ${text}\n`)
  } catch {
    // Logging must never be the thing that crashes the app.
  }
}

export const log = {
  info: (...p: unknown[]): void => write('INFO ', p),
  warn: (...p: unknown[]): void => write('WARN ', p),
  error: (...p: unknown[]): void => write('ERROR', p)
}

export function logPath(): string {
  return logFile()
}

/** Call once, before the app is ready. */
export function installCrashLogging(): void {
  process.on('uncaughtException', (err) => log.error('uncaughtException', err))
  process.on('unhandledRejection', (reason) => log.error('unhandledRejection', reason))
  app.on('render-process-gone', (_e, _wc, details) => log.error('render-process-gone', details))
  app.on('child-process-gone', (_e, details) => log.error('child-process-gone', details))
}

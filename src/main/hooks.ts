// Writes this app's hook entries into ~/.claude/settings.json so Claude Code
// forwards its lifecycle events to us.
//
// That file is the user's, and every Claude Code session on the machine reads
// it, so the rules are strict:
//  - exactly ONE Agent Ship hook per event (older builds left untagged copies,
//    which made every tool call spawn the bridge several times);
//  - the hook is kept pointing at the current command (the app may have moved);
//  - anything else in the file, including other hooks in the same entry, is
//    left exactly as it was;
//  - the write is atomic and the original is kept once as a backup;
//  - a file we cannot parse is never touched.
//
// scripts/install-hooks.js is the same logic for `npm install`, which runs
// before there is a build; hooks.test.ts runs one set of scenarios against both.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const claudeDir = path.join(os.homedir(), '.claude')
export const settingsPath = path.join(claudeDir, 'settings.json')
export const backupPath = `${settingsPath}.agentship-backup`

const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop'] as const

const MARKER = 'agent-ship'

interface HookCommand {
  type: string
  command: string
  description?: string
  [key: string]: unknown
}
interface HookEntry {
  matcher: string
  hooks: HookCommand[]
  [key: string]: unknown
}
export interface Settings {
  hooks?: Record<string, HookEntry[]>
  [key: string]: unknown
}

export type InstallResult =
  | { ok: true; changed: boolean; settingsPath?: string }
  | { ok: false; reason: 'claude-not-found' | 'parse-error' }

/** Ours: tagged by us, or an untagged copy of our bridge from an older build. */
export function isOurs(h: HookCommand): boolean {
  if (h.description === MARKER) return true
  const cmd = typeof h.command === 'string' ? h.command : ''
  return /bridge\.js/.test(cmd) && /agent-ship/i.test(cmd)
}

/**
 * Makes `settings` hold exactly one Agent Ship hook per event, running
 * `command`. Returns whether anything changed. Pure apart from mutating `settings`.
 */
export function mergeHooks(settings: Settings, command: string): boolean {
  let changed = false
  settings.hooks ??= {}
  const ours = (h: HookCommand): HookCommand => ({ ...h, type: 'command', command, description: MARKER })

  for (const eventName of HOOK_EVENTS) {
    const list = Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : []
    const next: HookEntry[] = []
    let placed = false

    for (const entry of list) {
      const hooks = Array.isArray(entry.hooks) ? entry.hooks : []
      if (!hooks.some(isOurs)) {
        next.push(entry)
        continue
      }
      const rebuilt: HookCommand[] = []
      for (const h of hooks) {
        if (!isOurs(h)) rebuilt.push(h)
        else if (!placed) {
          placed = true
          const want = ours(h)
          if (want.command !== h.command || want.description !== h.description || want.type !== h.type) changed = true
          rebuilt.push(want)
        } else changed = true // a duplicate
      }
      if (rebuilt.length === 0) changed = true
      else next.push({ ...entry, hooks: rebuilt })
    }

    if (!placed) {
      next.push({ matcher: '', hooks: [{ type: 'command', command, description: MARKER }] })
      changed = true
    }
    settings.hooks[eventName] = next
  }
  return changed
}

/** Removes every Agent Ship hook and nothing else. Returns whether anything changed. */
export function stripHooks(settings: Settings): boolean {
  if (!settings.hooks) return false
  let changed = false
  for (const eventName of Object.keys(settings.hooks)) {
    const list = settings.hooks[eventName]
    if (!Array.isArray(list)) continue
    const next: HookEntry[] = []
    for (const entry of list) {
      const hooks = Array.isArray(entry.hooks) ? entry.hooks : []
      const rest = hooks.filter((h) => !isOurs(h))
      if (rest.length === hooks.length) next.push(entry)
      else {
        changed = true
        if (rest.length > 0) next.push({ ...entry, hooks: rest })
      }
    }
    if (next.length === 0) delete settings.hooks[eventName]
    else settings.hooks[eventName] = next
  }
  return changed
}

/** Temp file in the same directory, then rename: a crash leaves the old file or the new one, never half. */
export function writeSettings(settings: Settings): void {
  fs.mkdirSync(claudeDir, { recursive: true })
  if (fs.existsSync(settingsPath) && !fs.existsSync(backupPath)) fs.copyFileSync(settingsPath, backupPath)
  const tmp = `${settingsPath}.agentship-tmp`
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2))
  fs.renameSync(tmp, settingsPath)
}

export function installHooks(command: string): InstallResult {
  if (!fs.existsSync(claudeDir)) return { ok: false, reason: 'claude-not-found' }

  let settings: Settings
  try {
    settings = fs.existsSync(settingsPath) ? (JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Settings) : {}
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('not an object')
  } catch {
    // Never clobber a settings file we failed to parse - the user's own hooks
    // and permissions live in there.
    return { ok: false, reason: 'parse-error' }
  }

  if (!mergeHooks(settings, command)) return { ok: true, changed: false }
  writeSettings(settings)
  return { ok: true, changed: true, settingsPath }
}

// Writes this app's hook entries into ~/.claude/settings.json so Claude Code
// forwards its lifecycle events to us. Idempotent: entries are tagged with a
// marker and only added when missing.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const claudeDir = path.join(os.homedir(), '.claude')
export const settingsPath = path.join(claudeDir, 'settings.json')

const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop'
] as const

const MARKER = 'agent-ship'

interface HookCommand {
  type: string
  command: string
  description?: string
}
interface HookEntry {
  matcher: string
  hooks: HookCommand[]
}
interface Settings {
  hooks?: Record<string, HookEntry[]>
  [key: string]: unknown
}

export type InstallResult =
  | { ok: true; changed: boolean; settingsPath?: string }
  | { ok: false; reason: 'claude-not-found' | 'parse-error' }

function alreadyInstalled(settings: Settings, eventName: string): boolean {
  const list = settings.hooks?.[eventName]
  if (!Array.isArray(list)) return false
  return list.some((entry) => (entry.hooks ?? []).some((h) => h.description === MARKER))
}

export function installHooks(command: string): InstallResult {
  if (!fs.existsSync(claudeDir)) return { ok: false, reason: 'claude-not-found' }

  let settings: Settings
  try {
    settings = fs.existsSync(settingsPath)
      ? (JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Settings)
      : {}
  } catch {
    // Never clobber a settings file we failed to parse - the user's own hooks
    // and permissions live in there.
    return { ok: false, reason: 'parse-error' }
  }

  settings.hooks ??= {}
  let changed = false
  for (const eventName of HOOK_EVENTS) {
    if (alreadyInstalled(settings, eventName)) continue
    settings.hooks[eventName] ??= []
    settings.hooks[eventName].push({
      matcher: '',
      hooks: [{ type: 'command', command, description: MARKER }]
    })
    changed = true
  }

  if (!changed) return { ok: true, changed: false }

  fs.mkdirSync(claudeDir, { recursive: true })
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  return { ok: true, changed: true, settingsPath }
}

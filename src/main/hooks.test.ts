import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Impl {
  installHooks: (command: string) => { ok: boolean; changed?: boolean; reason?: string }
  settingsPath: string
  backupPath?: string
}

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-home-'))
  vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('HOME', home)
  vi.resetModules()
})
afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
})

const require_ = createRequire(import.meta.url)

/** The two implementations that must behave identically. */
const impls: [string, () => Promise<Impl>][] = [
  ['src/main/hooks.ts (the app)', async () => (await import('./hooks')) as unknown as Impl],
  [
    'scripts/install-hooks.js (npm install)',
    async () => {
      const file = path.resolve(import.meta.dirname, '../../scripts/install-hooks.js')
      delete require_.cache[file]
      return require_(file) as Impl
    }
  ]
]

const CMD = 'node "C:\\apps\\agent-ship\\hooks\\bridge.js"'
const EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop']

const claude = (): string => path.join(home, '.claude')
const settingsFile = (): string => path.join(claude(), 'settings.json')
const write = (obj: unknown): void => {
  fs.mkdirSync(claude(), { recursive: true })
  fs.writeFileSync(settingsFile(), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2))
}
type Parsed = { hooks: Record<string, { matcher: string; hooks: { command: string; description?: string }[] }[]> } & Record<string, unknown>
const read = (): Parsed => JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Parsed
/** Every Agent Ship hook object in the file, anywhere. */
const oursIn = (s: Parsed): { event: string; command: string }[] =>
  Object.entries(s.hooks ?? {}).flatMap(([event, list]) =>
    list.flatMap((e) => e.hooks.filter((h) => h.description === 'agent-ship' || /bridge\.js/.test(h.command)).map((h) => ({ event, command: h.command })))
  )

describe.each(impls)('hook installer: %s', (_name, load) => {
  it('does nothing when Claude Code is not installed', async () => {
    const m = await load()
    expect(m.installHooks(CMD)).toEqual({ ok: false, reason: 'claude-not-found' })
    expect(fs.existsSync(claude())).toBe(false)
  })

  it('installs exactly one tagged hook per event into an empty settings file', async () => {
    fs.mkdirSync(claude())
    const m = await load()
    expect(m.installHooks(CMD)).toMatchObject({ ok: true, changed: true })
    const s = read()
    expect(oursIn(s).map((h) => h.event).sort()).toEqual([...EVENTS].sort())
    expect(oursIn(s).every((h) => h.command === CMD)).toBe(true)
  })

  it('is idempotent: a second run changes nothing, byte for byte', async () => {
    fs.mkdirSync(claude())
    const m = await load()
    m.installHooks(CMD)
    const before = fs.readFileSync(settingsFile(), 'utf8')
    expect(m.installHooks(CMD)).toMatchObject({ ok: true, changed: false })
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe(before)
  })

  it('keeps everything else: other settings, other hooks, and other hooks sharing an entry with ours', async () => {
    write({
      permissions: { allow: ['Bash(npm test)'] },
      model: 'opus',
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] },
          { matcher: '', hooks: [{ type: 'command', command: 'echo also-mine' }, { type: 'command', command: CMD, description: 'agent-ship' }] }
        ],
        Notification: [{ matcher: '', hooks: [{ type: 'command', command: 'echo notify' }] }]
      }
    })
    const m = await load()
    m.installHooks(CMD)
    const s = read()
    expect(s.permissions).toEqual({ allow: ['Bash(npm test)'] })
    expect(s.model).toBe('opus')
    expect(s.hooks.Notification).toHaveLength(1)
    const pre = s.hooks.PreToolUse
    expect(pre[0].hooks[0].command).toBe('echo mine')
    expect(pre[1].hooks.map((h) => h.command)).toEqual(['echo also-mine', CMD])
    expect(oursIn(s).filter((h) => h.event === 'PreToolUse')).toHaveLength(1)
  })

  it('collapses the duplicates older builds left (untagged copies) into one, and keeps the user\'s own hooks', async () => {
    const legacy = 'node "C:\\old\\agent-ship\\hooks\\bridge.js"'
    const dup = (): { matcher: string; hooks: object[] } => ({ matcher: '', hooks: [{ type: 'command', command: legacy }] })
    write({
      hooks: Object.fromEntries(
        EVENTS.map((e) => [e, [dup(), dup(), { matcher: '', hooks: [{ type: 'command', command: legacy, description: 'agent-ship' }] }, { matcher: 'Edit', hooks: [{ type: 'command', command: 'echo keep-me' }] }]])
      )
    })
    const m = await load()
    expect(m.installHooks(CMD)).toMatchObject({ ok: true, changed: true })
    const s = read()
    for (const e of EVENTS) {
      expect(oursIn(s).filter((h) => h.event === e)).toEqual([{ event: e, command: CMD }]) // one, up to date
      expect(s.hooks[e].some((x) => x.hooks.some((h) => h.command === 'echo keep-me'))).toBe(true)
    }
    // Entries that held only a duplicate are gone, not left empty.
    expect(EVENTS.every((e) => s.hooks[e].every((x) => x.hooks.length > 0))).toBe(true)
    expect(EVENTS.every((e) => s.hooks[e].length === 2)).toBe(true)
  })

  it('points a stale hook at the current command (the app moved)', async () => {
    write({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node "D:\\gone\\agent-ship\\hooks\\bridge.js"', description: 'agent-ship' }] }] } })
    const m = await load()
    m.installHooks(CMD)
    expect(oursIn(read()).filter((h) => h.event === 'Stop')).toEqual([{ event: 'Stop', command: CMD }])
  })

  it('does not treat an unrelated command that merely mentions agent-ship as ours', async () => {
    write({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'cd C:\\work\\agent-ship && npm run lint' }] }] } })
    const m = await load()
    m.installHooks(CMD)
    const stop = read().hooks.Stop
    expect(stop.some((e) => e.hooks.some((h) => h.command.includes('npm run lint')))).toBe(true)
    expect(oursIn(read()).filter((h) => h.event === 'Stop')).toHaveLength(1)
  })

  it('never touches a settings file it cannot parse', async () => {
    write('{ "permissions": { "allow": [ oops')
    const before = fs.readFileSync(settingsFile(), 'utf8')
    const m = await load()
    expect(m.installHooks(CMD)).toEqual({ ok: false, reason: 'parse-error' })
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe(before)
    expect(fs.readdirSync(claude())).toEqual(['settings.json']) // no temp or backup litter
  })

  it('refuses a settings file that is valid JSON but not an object', async () => {
    write('[1, 2]')
    const m = await load()
    expect(m.installHooks(CMD).ok).toBe(false)
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe('[1, 2]')
  })

  it('writes atomically (no temp file left) and keeps the original once as a backup', async () => {
    const original = JSON.stringify({ model: 'opus' }, null, 2)
    write(original)
    const m = await load()
    m.installHooks(CMD)
    const files = fs.readdirSync(claude()).sort()
    expect(files).toEqual(['settings.json', 'settings.json.agentship-backup'])
    expect(fs.readFileSync(path.join(claude(), 'settings.json.agentship-backup'), 'utf8')).toBe(original)
    // A later change does not overwrite the first backup.
    m.installHooks('node "C:\\elsewhere\\agent-ship\\hooks\\bridge.js"')
    expect(fs.readFileSync(path.join(claude(), 'settings.json.agentship-backup'), 'utf8')).toBe(original)
  })
})

describe('hook uninstaller (scripts/uninstall-hooks.js logic)', () => {
  const load = async (): Promise<{ installHooks: Impl['installHooks']; uninstallHooks: () => { ok: boolean; changed?: boolean } }> => {
    const file = path.resolve(import.meta.dirname, '../../scripts/install-hooks.js')
    delete require_.cache[file]
    return require_(file)
  }

  it('removes only Agent Ship hooks, including untagged legacy copies, and leaves the rest', async () => {
    write({
      model: 'opus',
      hooks: {
        Stop: [
          { matcher: '', hooks: [{ type: 'command', command: 'node "C:\\x\\agent-ship\\hooks\\bridge.js"' }] },
          { matcher: '', hooks: [{ type: 'command', command: 'echo keep' }, { type: 'command', command: CMD, description: 'agent-ship' }] }
        ],
        PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: CMD, description: 'agent-ship' }] }]
      }
    })
    const m = await load()
    expect(m.uninstallHooks()).toMatchObject({ ok: true, changed: true })
    const s = read()
    expect(s.model).toBe('opus')
    expect(s.hooks.PreToolUse).toBeUndefined() // nothing left in it
    expect(s.hooks.Stop).toEqual([{ matcher: '', hooks: [{ type: 'command', command: 'echo keep' }] }])
    expect(m.uninstallHooks()).toMatchObject({ ok: true, changed: false })
  })

  it('leaves an unparseable file alone', async () => {
    write('not json')
    const m = await load()
    expect(m.uninstallHooks()).toEqual({ ok: false, reason: 'parse-error' })
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe('not json')
  })
})

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { projectEnv } from './env'

const sep = process.platform === 'win32' ? ';' : ':'
const ship = path.join('C:', 'Users', 'me', 'agent-ship', 'node_modules', '.bin')
const other = path.join('C:', 'work', 'other', 'node_modules', '.bin')

describe('projectEnv', () => {
  it("drops other packages' node_modules/.bin from PATH and puts the project's own first", () => {
    const env = projectEnv({ PATH: [ship, 'C:\\tools', other, 'C:\\Windows'].join(sep) }, path.join('C:', 'proj'))
    const parts = env.PATH!.split(sep)
    expect(parts[0]).toBe(path.join('C:', 'proj', 'node_modules', '.bin'))
    expect(parts).toContain('C:\\tools')
    expect(parts).toContain('C:\\Windows')
    expect(parts).not.toContain(ship)
    expect(parts).not.toContain(other)
  })

  it("removes the npm variables that describe Agent Ship's own package", () => {
    const env = projectEnv(
      {
        PATH: 'x',
        npm_lifecycle_event: 'dev',
        npm_package_name: 'agent-ship',
        npm_package_json: 'C:\\agent-ship\\package.json',
        npm_command: 'run-script',
        npm_config_local_prefix: 'C:\\agent-ship',
        INIT_CWD: 'C:\\agent-ship',
        npm_config_registry: 'https://registry.example',
        HOME: '/home/me'
      },
      '/p'
    )
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH', 'npm_config_registry'])
  })

  it('keeps the spelling of PATH (Windows calls it Path) instead of adding a second variable', () => {
    const env = projectEnv({ Path: ['C:\\a', ship].join(sep) }, '/p')
    expect(Object.keys(env).filter((k) => k.toLowerCase() === 'path')).toEqual(['Path'])
    expect(env.Path).not.toContain(ship)
  })

  it('does not change the environment it was given', () => {
    const base = { PATH: [ship, 'x'].join(sep), npm_package_name: 'agent-ship' }
    projectEnv(base, '/p')
    expect(base.PATH).toContain(ship)
    expect(base.npm_package_name).toBe('agent-ship')
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { syncDependencies, type Installer } from './deps'

let root: string
let project: string
let cache: string
let copy: string
const signal = new AbortController().signal

const manifest = (dir: string, deps: Record<string, string>, dev: Record<string, string> = {}): void => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: deps, devDependencies: dev }))
}
/** A stand-in for npm: "installs" every declared package as an empty folder. */
const fakeInstall = (calls: string[]): Installer => async (dir) => {
  calls.push(dir)
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { dependencies?: object; devDependencies?: object }
  for (const name of [...Object.keys(m.dependencies ?? {}), ...Object.keys(m.devDependencies ?? {})]) {
    fs.mkdirSync(path.join(dir, 'node_modules', name), { recursive: true })
    fs.writeFileSync(path.join(dir, 'node_modules', name, 'package.json'), '{}')
  }
  return { ok: true }
}
const sync = (install: Installer) => syncDependencies({ cwd: copy, project, cacheRoot: cache, signal, install })
const linked = (): boolean => fs.lstatSync(path.join(copy, 'node_modules')).isSymbolicLink()
const has = (name: string): boolean => fs.existsSync(path.join(copy, 'node_modules', name, 'package.json'))

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-test-'))
  project = path.join(root, 'project')
  copy = path.join(root, 'copy')
  cache = path.join(root, 'cache')
  fs.mkdirSync(project)
  fs.mkdirSync(copy)
})
afterEach(() => {
  // Unlink first so removing the folder never recurses through a link into the cache.
  try {
    fs.unlinkSync(path.join(copy, 'node_modules'))
  } catch {
    /* not a link */
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

describe('syncDependencies', () => {
  it('does nothing without a package.json, without dependencies, or for a workspace', async () => {
    const calls: string[] = []
    expect(await sync(fakeInstall(calls))).toEqual({ ok: true, action: 'none' })
    manifest(copy, {})
    expect(await sync(fakeInstall(calls))).toEqual({ ok: true, action: 'none' })
    fs.writeFileSync(path.join(copy, 'package.json'), JSON.stringify({ workspaces: ['a'], dependencies: { a: '1' } }))
    expect(await sync(fakeInstall(calls))).toEqual({ ok: true, action: 'none' })
    expect(calls).toEqual([])
  })

  it('never touches the project itself', async () => {
    manifest(project, { three: '1' })
    const r = await syncDependencies({ cwd: project, project, cacheRoot: cache, signal, install: fakeInstall([]) })
    expect(r).toEqual({ ok: true, action: 'none' })
    expect(fs.existsSync(path.join(project, 'node_modules'))).toBe(false)
  })

  it("installs what the copy's own manifest declares, once, and links it", async () => {
    // The reported case: nothing installed anywhere, and the branch adds `three`.
    manifest(copy, { three: '^0.160.0' }, { vitest: '^3' })
    const calls: string[] = []
    const r = await sync(fakeInstall(calls))
    expect(r).toEqual({ ok: true, action: 'installed' })
    expect(calls).toHaveLength(1)
    expect(linked()).toBe(true)
    expect(has('three')).toBe(true)
    expect(has('vitest')).toBe(true)
  })

  it('reuses the cache for the same manifest, and installs again when the manifest changes', async () => {
    const calls: string[] = []
    manifest(copy, { three: '1' })
    await sync(fakeInstall(calls))
    fs.unlinkSync(path.join(copy, 'node_modules'))
    expect(await sync(fakeInstall(calls))).toEqual({ ok: true, action: 'cached' })
    expect(calls).toHaveLength(1)

    fs.unlinkSync(path.join(copy, 'node_modules'))
    manifest(copy, { three: '1', 'cannon-es': '1' })
    expect(await sync(fakeInstall(calls))).toEqual({ ok: true, action: 'installed' })
    expect(calls).toHaveLength(2)
    expect(has('cannon-es')).toBe(true)
  })

  it('a changed lockfile is a different manifest', async () => {
    const calls: string[] = []
    manifest(copy, { three: '1' })
    fs.writeFileSync(path.join(copy, 'package-lock.json'), '{"a":1}')
    await sync(fakeInstall(calls))
    fs.unlinkSync(path.join(copy, 'node_modules'))
    fs.writeFileSync(path.join(copy, 'package-lock.json'), '{"a":2}')
    await sync(fakeInstall(calls))
    expect(calls).toHaveLength(2)
  })

  it("links the project's own node_modules when it already covers the manifest (no install)", async () => {
    manifest(copy, { three: '1' })
    fs.mkdirSync(path.join(project, 'node_modules', 'three'), { recursive: true })
    fs.writeFileSync(path.join(project, 'node_modules', 'three', 'package.json'), '{}')
    const calls: string[] = []
    expect(await sync(fakeInstall(calls))).toEqual({ ok: true, action: 'linked-project' })
    expect(calls).toEqual([])
    expect(has('three')).toBe(true)
  })

  it("but not when the project's node_modules lacks a package the branch added", async () => {
    manifest(copy, { three: '1', 'cannon-es': '1' })
    fs.mkdirSync(path.join(project, 'node_modules', 'three'), { recursive: true })
    fs.writeFileSync(path.join(project, 'node_modules', 'three', 'package.json'), '{}')
    const calls: string[] = []
    expect(await sync(fakeInstall(calls))).toEqual({ ok: true, action: 'installed' })
    expect(has('cannon-es')).toBe(true)
  })

  it('leaves a copy that already has everything alone', async () => {
    manifest(copy, { three: '1' })
    fs.mkdirSync(path.join(copy, 'node_modules', 'three'), { recursive: true })
    fs.writeFileSync(path.join(copy, 'node_modules', 'three', 'package.json'), '{}')
    const calls: string[] = []
    expect(await sync(fakeInstall(calls))).toEqual({ ok: true, action: 'none' })
    expect(linked()).toBe(false)
    expect(calls).toEqual([])
  })

  it('reports an install failure with its output, and does not cache the failure', async () => {
    manifest(copy, { 'no-such-package-xyz': '1' })
    const bad: Installer = async () => ({ ok: false, output: 'npm error 404 Not Found - no-such-package-xyz' })
    const r = await sync(bad)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('404 Not Found')
    expect(fs.existsSync(path.join(copy, 'node_modules'))).toBe(false)
    // Fixing the manifest later installs normally; the failure left nothing behind.
    manifest(copy, { three: '1' })
    expect((await sync(fakeInstall([]))).ok).toBe(true)
  })

  it('an install that does not provide every package is a failure, not a pass', async () => {
    manifest(copy, { three: '1' })
    const r = await sync(async () => ({ ok: true }))
    expect(r.ok).toBe(false)
  })

  it('two copies wanting the same manifest at once install it once', async () => {
    const other = path.join(root, 'other')
    manifest(copy, { three: '1' })
    manifest(other, { three: '1' })
    const calls: string[] = []
    const slow: Installer = async (dir, s) => {
      await new Promise((r) => setTimeout(r, 50))
      return fakeInstall(calls)(dir, s)
    }
    const [a, b] = await Promise.all([
      syncDependencies({ cwd: copy, project, cacheRoot: cache, signal, install: slow }),
      syncDependencies({ cwd: other, project, cacheRoot: cache, signal, install: slow })
    ])
    expect(a.ok && b.ok).toBe(true)
    expect(calls).toHaveLength(1)
    fs.unlinkSync(path.join(other, 'node_modules'))
  })
})

describe('the real npm installer', () => {
  it('installs a manifest offline (a local file: dependency) and the copy can require it', async () => {
    const { npmInstall } = await import('./deps')
    const local = path.join(root, 'local-pkg')
    fs.mkdirSync(local)
    fs.writeFileSync(path.join(local, 'package.json'), '{"name":"local-pkg","version":"1.0.0","main":"index.js"}')
    fs.writeFileSync(path.join(local, 'index.js'), 'module.exports = 42\n')
    fs.writeFileSync(path.join(copy, 'package.json'), JSON.stringify({ name: 'x', dependencies: { 'local-pkg': `file:${local.split(path.sep).join('/')}` } }))
    const r = await syncDependencies({ cwd: copy, project, cacheRoot: cache, signal, install: npmInstall })
    expect(r).toEqual({ ok: true, action: 'installed' })
    const { execFileSync } = await import('node:child_process')
    expect(execFileSync('node', ['-e', "console.log(require('local-pkg'))"], { cwd: copy, encoding: 'utf8' }).trim()).toBe('42')
  }, 120_000)
})

describe('missingPackageHint', () => {
  it('says a package is imported but undeclared, for the error the reported run hit', async () => {
    const { missingPackageHint } = await import('./deps')
    manifest(copy, { 'cannon-es': '1' })
    const out = "Error: Cannot find package 'three' imported from '/x/src/scene/ball.ts'"
    const hint = missingPackageHint(out, copy)
    expect(hint).toMatch(/"three" is imported but not declared in package\.json/)
  })

  it('says the install is the problem when the package is declared', async () => {
    const { missingPackageHint } = await import('./deps')
    manifest(copy, { three: '1' })
    expect(missingPackageHint("Cannot find package 'three' imported from 'x'", copy)).toMatch(/declared in package\.json but not installed/)
  })

  it('reduces subpaths and scopes to the package, and ignores relative and node: imports', async () => {
    const { missingPackageHint } = await import('./deps')
    manifest(copy, {})
    const out = ["Cannot find module 'three/examples/jsm/controls/OrbitControls.js'", "Failed to resolve import '@types/three/index' from x", "Cannot find module './local'", "Cannot find module 'node:fs'"].join('\n')
    const hint = missingPackageHint(out, copy)
    expect(hint).toContain('"three"')
    expect(hint).toContain('"@types/three"')
    expect(hint).not.toContain('local')
    expect(hint).not.toContain('node:fs')
  })

  it('says nothing about a failure that is not a missing package', async () => {
    const { missingPackageHint } = await import('./deps')
    expect(missingPackageHint('AssertionError: expected 1 to be 2', copy)).toBe('')
  })
})

describe('installCommand', () => {
  it('uses the package manager whose lockfile the project has', async () => {
    const { installCommand } = await import('./deps')
    const d = path.join(root, 'pm')
    fs.mkdirSync(d)
    expect(installCommand(d)).toMatch(/^npm install --include=dev/)
    fs.writeFileSync(path.join(d, 'package-lock.json'), '{}')
    expect(installCommand(d)).toMatch(/^npm ci --include=dev/)
    fs.writeFileSync(path.join(d, 'yarn.lock'), '')
    expect(installCommand(d)).toBe('yarn install --frozen-lockfile --production=false')
    fs.writeFileSync(path.join(d, 'pnpm-lock.yaml'), '')
    expect(installCommand(d)).toBe('pnpm install --frozen-lockfile --prod=false')
  })

  it('a different lockfile is a different manifest, so switching package manager reinstalls', async () => {
    const { syncDependencies: sd } = await import('./deps')
    manifest(copy, { three: '1' })
    const calls: string[] = []
    await sd({ cwd: copy, project, cacheRoot: cache, signal, install: fakeInstall(calls) })
    fs.unlinkSync(path.join(copy, 'node_modules'))
    fs.writeFileSync(path.join(copy, 'pnpm-lock.yaml'), 'lockfileVersion: 9')
    await sd({ cwd: copy, project, cacheRoot: cache, signal, install: fakeInstall(calls) })
    expect(calls).toHaveLength(2)
  })
})

describe('the real installer when Agent Ship runs as a built app (NODE_ENV=production)', () => {
  it('still installs devDependencies, which is what typescript, vite and vitest are', async () => {
    // Reported: "The install finished without providing every package". npm exits 0 and skips devDependencies under NODE_ENV=production.
    const { npmInstall } = await import('./deps')
    const local = path.join(root, 'dev-pkg')
    fs.mkdirSync(local)
    fs.writeFileSync(path.join(local, 'package.json'), '{"name":"dev-pkg","version":"1.0.0","main":"index.js"}')
    fs.writeFileSync(path.join(local, 'index.js'), 'module.exports = 7')
    fs.writeFileSync(path.join(copy, 'package.json'), JSON.stringify({ name: 'x', devDependencies: { 'dev-pkg': `file:${local.split(path.sep).join('/')}` } }))
    const before = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const r = await syncDependencies({ cwd: copy, project, cacheRoot: cache, signal, install: npmInstall })
      expect(r).toEqual({ ok: true, action: 'installed' })
      expect(fs.existsSync(path.join(copy, 'node_modules', 'dev-pkg', 'package.json'))).toBe(true)
    } finally {
      if (before === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = before
    }
  }, 120_000)

  it('and names the packages that are missing when an install really falls short', async () => {
    manifest(copy, { three: '1', 'cannon-es': '1' })
    const partial: Installer = async (dir) => {
      fs.mkdirSync(path.join(dir, 'node_modules', 'three'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'node_modules', 'three', 'package.json'), '{}')
      return { ok: true }
    }
    const r = await syncDependencies({ cwd: copy, project, cacheRoot: cache, signal, install: partial })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('cannon-es')
      expect(r.reason).not.toContain('three,')
      expect(r.reason).toMatch(/npm view/)
    }
  })
})

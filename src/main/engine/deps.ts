// Gives every scratch copy the dependencies its OWN package.json declares.
//
// Each stage of a run (the builder's worktree, the merge's scratch copy) is a
// fresh checkout, and a checkout has no node_modules. The engine used to link
// the project's own node_modules in, which only works if the person already ran
// `npm install` there, and which cannot follow a branch that adds a dependency:
// a package the builder added was never installed anywhere a later stage could
// see, so "Cannot find package 'three'" appeared at Land, far from its cause.
//
// Now the manifest decides. If the copy's node_modules already covers what
// package.json declares, nothing happens. Otherwise the dependencies are
// installed once per distinct manifest (+ lockfile) into a cache, and the copy
// links to that. Every stage sees what its own manifest asks for.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { killTree } from './adapter'
import { projectEnv } from './env'

export type InstallResult = { ok: true } | { ok: false; output: string }
/** Installs the manifest in `dir` (which holds a copy of package.json and the lockfile). A test seam. */
export type Installer = (dir: string, signal: AbortSignal) => Promise<InstallResult>

export type SyncResult =
  | { ok: true; action: 'none' | 'linked-project' | 'cached' | 'installed' }
  | { ok: false; reason: string }

interface Manifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  overrides?: unknown
  workspaces?: unknown
}

const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json']
const INSTALL_TIMEOUT_MS = 10 * 60_000

function readManifest(cwd: string): Manifest | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as Manifest
    return m && typeof m === 'object' ? m : null
  } catch {
    return null
  }
}

/** What the manifest says must be importable: dependencies and devDependencies. */
export function declaredPackages(m: Manifest | null): string[] {
  if (!m) return []
  return [...Object.keys(m.dependencies ?? {}), ...Object.keys(m.devDependencies ?? {})]
}

/** Every declared package is present in `nm`. Versions are not compared. */
function covers(nm: string, packages: string[]): boolean {
  try {
    return packages.every((p) => fs.existsSync(path.join(nm, p, 'package.json')))
  } catch {
    return false
  }
}

/** One key per distinct set of dependencies: the same manifest installs once, however many copies need it. */
export function manifestKey(cwd: string, m: Manifest): string {
  const h = crypto.createHash('sha1')
  h.update(JSON.stringify([m.dependencies ?? {}, m.devDependencies ?? {}, m.optionalDependencies ?? {}, m.overrides ?? null]))
  for (const f of LOCKFILES) {
    try {
      h.update(fs.readFileSync(path.join(cwd, f)))
    } catch {
      /* no lockfile of this name */
    }
  }
  return h.digest('hex').slice(0, 16)
}

/** Replaces whatever is at `link` with a link to `target`. Only ever called on a scratch copy. */
function relink(link: string, target: string): void {
  try {
    if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link)
    else fs.rmSync(link, { recursive: true, force: true })
  } catch {
    /* nothing there */
  }
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

/** The real installer: `npm ci` when there is a lockfile, otherwise `npm install`. */
export const npmInstall: Installer = (dir, signal) =>
  new Promise((resolve) => {
    const lock = LOCKFILES.some((f) => fs.existsSync(path.join(dir, f)))
    let buf = ''
    const child = spawn(`npm ${lock ? 'ci' : 'install'} --no-audit --no-fund --loglevel=error`, {
      cwd: dir,
      shell: true,
      windowsHide: true,
      env: projectEnv(process.env, dir),
      detached: process.platform !== 'win32'
    })
    const keep = (d: Buffer): void => {
      buf = (buf + d.toString()).slice(-4_000)
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    const timer = setTimeout(() => killTree(child.pid), INSTALL_TIMEOUT_MS)
    const onAbort = (): void => killTree(child.pid)
    signal.addEventListener('abort', onAbort, { once: true })
    const end = (ok: boolean): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(ok ? { ok: true } : { ok: false, output: buf.trim() })
    }
    child.on('error', (e) => {
      buf += `\n${e.message}`
      end(false)
    })
    child.on('close', (code) => end(code === 0))
  })

const installing = new Map<string, Promise<SyncResult>>()

/**
 * Makes `cwd/node_modules` cover what `cwd/package.json` declares. `cwd` must be
 * a scratch copy, never the project itself. Projects this does not understand (no
 * package.json, no dependencies, a workspace) are left exactly as they were.
 */
export async function syncDependencies(o: {
  cwd: string
  /** The project's own checkout: its node_modules is used if it already covers the manifest. */
  project: string
  cacheRoot: string
  signal: AbortSignal
  install?: Installer
}): Promise<SyncResult> {
  if (path.resolve(o.cwd) === path.resolve(o.project)) return { ok: true, action: 'none' }
  const manifest = readManifest(o.cwd)
  const needed = declaredPackages(manifest)
  if (!manifest || needed.length === 0 || manifest.workspaces) return { ok: true, action: 'none' }

  const nm = path.join(o.cwd, 'node_modules')
  if (covers(nm, needed)) return { ok: true, action: 'none' }

  const projectNm = path.join(o.project, 'node_modules')
  if (covers(projectNm, needed)) {
    relink(nm, projectNm)
    return { ok: true, action: 'linked-project' }
  }

  const key = manifestKey(o.cwd, manifest)
  const entry = path.join(o.cacheRoot, key)
  const entryNm = path.join(entry, 'node_modules')
  const done = path.join(entry, '.installed')

  if (!fs.existsSync(done) || !covers(entryNm, needed)) {
    // Two copies wanting the same manifest at once install it once.
    let pending = installing.get(key)
    if (!pending) {
      pending = (async (): Promise<SyncResult> => {
        fs.rmSync(entry, { recursive: true, force: true })
        fs.mkdirSync(entry, { recursive: true })
        for (const f of ['package.json', ...LOCKFILES, '.npmrc']) {
          try {
            fs.copyFileSync(path.join(o.cwd, f), path.join(entry, f))
          } catch {
            /* optional */
          }
        }
        const r = await (o.install ?? npmInstall)(entry, o.signal)
        if (!r.ok) {
          fs.rmSync(entry, { recursive: true, force: true })
          return { ok: false, reason: `Installing the project's dependencies failed:\n${r.output}` }
        }
        if (!covers(entryNm, needed)) {
          fs.rmSync(entry, { recursive: true, force: true })
          return { ok: false, reason: 'The install finished but did not provide every declared package.' }
        }
        fs.writeFileSync(done, new Date().toISOString())
        return { ok: true, action: 'installed' }
      })().finally(() => installing.delete(key))
      installing.set(key, pending)
    }
    const r = await pending
    if (!r.ok) return r
    relink(nm, entryNm)
    return r
  }

  relink(nm, entryNm)
  return { ok: true, action: 'cached' }
}

/** `three/examples/jsm/x.js` -> `three`; `@scope/pkg/sub` -> `@scope/pkg`. Relative and node: imports are not packages. */
function packageOf(spec: string): string | null {
  if (/^(\.|\/|node:)/.test(spec)) return null
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/**
 * A failure that says a package could not be found is not a code failure, and
 * should not be left to guess. Says what is actually wrong: the package is
 * imported but undeclared (add it to package.json; the engine installs from
 * that), or declared but not installed (the install is the problem).
 */
export function missingPackageHint(output: string, cwd: string): string {
  const names = new Set<string>()
  for (const m of output.matchAll(/Cannot find (?:package|module) ['"]([^'"]+)['"]/g)) {
    const p = packageOf(m[1])
    if (p) names.add(p)
  }
  for (const m of output.matchAll(/Failed to resolve import ['"]([^'"]+)['"]/g)) {
    const p = packageOf(m[1])
    if (p) names.add(p)
  }
  if (names.size === 0) return ''
  const declared = new Set(declaredPackages(readManifest(cwd)))
  const undeclared = [...names].filter((n) => !declared.has(n))
  if (undeclared.length) {
    return `Hint: ${undeclared.map((n) => `"${n}"`).join(', ')} ${undeclared.length === 1 ? 'is' : 'are'} imported but not declared in package.json. Add ${undeclared.length === 1 ? 'it' : 'them'} to "dependencies" (or "devDependencies" for tooling); dependencies are installed from package.json, so nothing else is needed. Do not work around it.`
  }
  return `Hint: ${[...names].map((n) => `"${n}"`).join(', ')} ${names.size === 1 ? 'is' : 'are'} declared in package.json but not installed, so the install itself is the problem, not the code.`
}

// What a command run for a project (a gate, or a Bash call an agent makes) is
// allowed to inherit from Agent Ship itself.
//
// Agent Ship is usually started with `npm run dev`, which puts ITS OWN
// node_modules/.bin on PATH and sets npm_* variables pointing at its own
// package. A project with no dependencies installed then "ran" its tests with
// Agent Ship's vitest, and passed or failed for reasons that have nothing to do
// with the project. A gate has to answer for the project alone.
import path from 'node:path'

const sep = process.platform === 'win32' ? ';' : ':'

/** Variables npm sets for a script it runs, describing Agent Ship's own package. */
const NPM_SCRIPT_VARS = /^(npm_lifecycle_|npm_package_|npm_command$|npm_execpath$|npm_node_execpath$|npm_config_local_prefix$|init_cwd$)/i

/**
 * NODE_ENV describes how Agent Ship itself was started (a built app is `production`). Passed
 * on, `npm install` exits 0 having silently skipped every devDependency (typescript, vite,
 * vitest...), and the project's own tests would run in the wrong mode. A project sets its own.
 */
const MODE_VARS = /^node_env$/i

const isBinDir = (entry: string): boolean => /(^|[\\/])node_modules[\\/]\.bin[\\/]?$/i.test(entry)

/**
 * `base` without Agent Ship's own tooling: no other package's `node_modules/.bin`
 * on PATH, none of the npm_* variables describing Agent Ship's package. The
 * project's own `node_modules/.bin` goes first, so its tools win.
 */
export function projectEnv(base: NodeJS.ProcessEnv, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) if (!NPM_SCRIPT_VARS.test(k) && !MODE_VARS.test(k)) env[k] = v

  // Windows keeps the variable's own spelling (Path); keep it rather than adding a second one.
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
  const kept = (env[pathKey] ?? '').split(sep).filter((e) => e && !isBinDir(e))
  env[pathKey] = [path.join(cwd, 'node_modules', '.bin'), ...kept].join(sep)
  return env
}

// Persists the user's registered projects ("rooms" in the building) and app
// settings across restarts - JSON files in the per-user app data directory.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface Project {
  id: string
  name: string
  path: string
}

export interface Settings {
  /** Weekly token budget the Usage gauge is measured against. This is a
   *  user-chosen number, not a reading of the account's real plan limit -
   *  Claude Code doesn't record that anywhere locally. */
  weeklyTokenBudget: number
}

const DEFAULT_SETTINGS: Settings = { weeklyTokenBudget: 50_000_000 }

function filePath(dir: string, name: string): string {
  return path.join(dir, name)
}

function readJson<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(dir: string, name: string, value: unknown): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath(dir, name), JSON.stringify(value, null, 2))
}

export function loadProjects(dir: string): Project[] {
  const list = readJson<Project[]>(filePath(dir, 'shipyard.json'), [])
  return Array.isArray(list) ? list : []
}

const samePath = (a: string, b: string): boolean => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

/** Folders the person removed from the Floor. Claude Code's own sessions keep
 *  naming a removed folder, so without this it would reappear as "not added
 *  yet" on the next refresh. Adding the folder again lifts it. */
export function loadHiddenProjects(dir: string): string[] {
  const list = readJson<string[]>(filePath(dir, 'hidden-projects.json'), [])
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
}

export function hideProjectPath(dir: string, projectPath: string): string[] {
  const list = loadHiddenProjects(dir)
  if (!list.some((x) => samePath(x, projectPath))) list.push(path.resolve(projectPath))
  writeJson(dir, 'hidden-projects.json', list)
  return list
}

function unhideProjectPath(dir: string, projectPath: string): void {
  const list = loadHiddenProjects(dir)
  const next = list.filter((x) => !samePath(x, projectPath))
  if (next.length !== list.length) writeJson(dir, 'hidden-projects.json', next)
}

export function addProject(dir: string, projectPath: string): Project[] {
  const list = loadProjects(dir)
  const normalized = path.resolve(projectPath)
  unhideProjectPath(dir, normalized)
  if (list.some((p) => p.path.toLowerCase() === normalized.toLowerCase())) return list

  list.push({
    id: crypto.createHash('sha1').update(normalized.toLowerCase()).digest('hex').slice(0, 12),
    name: path.basename(normalized) || normalized,
    path: normalized
  })
  writeJson(dir, 'shipyard.json', list)
  return list
}

/** Registers a folder the user already works in (found from Claude Code's own
 *  sessions). Only real git repositories are accepted, so this cannot be used
 *  to point the flow store at an arbitrary directory. */
export function addProjectIfRepo(dir: string, projectPath: string): Project[] {
  const resolved = path.resolve(projectPath)
  try {
    if (!fs.statSync(resolved).isDirectory() || !fs.existsSync(path.join(resolved, '.git'))) return loadProjects(dir)
  } catch {
    return loadProjects(dir)
  }
  return addProject(dir, resolved)
}

/** Takes a project off the Floor. Only Agent Ship's own record changes: the
 *  folder, its flows, its branches and its runs are left exactly as they are. */
export function removeProject(dir: string, id: string): Project[] {
  const all = loadProjects(dir)
  const gone = all.find((p) => p.id === id)
  const list = all.filter((p) => p.id !== id)
  writeJson(dir, 'shipyard.json', list)
  if (gone) hideProjectPath(dir, gone.path)
  return list
}

export function loadSettings(dir: string): Settings {
  return { ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>(filePath(dir, 'settings.json'), {}) }
}

export function saveSettings(dir: string, patch: Partial<Settings>): Settings {
  const next = { ...loadSettings(dir), ...patch }
  writeJson(dir, 'settings.json', next)
  return next
}

export function loadHidden(dir: string): string[] {
  const list = readJson<string[]>(filePath(dir, 'hidden.json'), [])
  return Array.isArray(list) ? list : []
}

/** Hiding a finished session removes it from the building only - its
 *  transcript on disk is never touched. */
export function setHidden(dir: string, ids: string[]): string[] {
  writeJson(dir, 'hidden.json', ids)
  return ids
}

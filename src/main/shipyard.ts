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
  /** Weekly token budget the fuel gauge is measured against. This is a
   *  user-chosen number, not a reading of the account's real plan limit -
   *  Claude Code doesn't record that anywhere locally. */
  weeklyTokenBudget: number
}

export interface OrchestratorLink {
  /** sessionId of the orchestrator */
  from: string
  /** sessionId of the sub-agent it directs */
  to: string
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

export function addProject(dir: string, projectPath: string): Project[] {
  const list = loadProjects(dir)
  const normalized = path.resolve(projectPath)
  if (list.some((p) => p.path.toLowerCase() === normalized.toLowerCase())) return list

  list.push({
    id: crypto.createHash('sha1').update(normalized.toLowerCase()).digest('hex').slice(0, 12),
    name: path.basename(normalized) || normalized,
    path: normalized
  })
  writeJson(dir, 'shipyard.json', list)
  return list
}

export function removeProject(dir: string, id: string): Project[] {
  const list = loadProjects(dir).filter((p) => p.id !== id)
  writeJson(dir, 'shipyard.json', list)
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

export function loadLinks(dir: string): OrchestratorLink[] {
  const list = readJson<OrchestratorLink[]>(filePath(dir, 'links.json'), [])
  return Array.isArray(list) ? list : []
}

export function saveLinks(dir: string, links: OrchestratorLink[]): OrchestratorLink[] {
  writeJson(dir, 'links.json', links)
  return links
}

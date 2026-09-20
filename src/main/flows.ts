// Reads and writes blueprints as plain JSON in the repo:
//   <project>/.agentship/flows/<slug>.flow.json
// The renderer only ever names a registered project and a slug. It never
// supplies a path, so it cannot be used to write anywhere else on disk.
import fs from 'node:fs'
import path from 'node:path'
import { parseBlueprint, type Blueprint } from '../shared/schema'
import { loadProjects } from './shipyard'

export interface FlowSummary {
  slug: string
  name: string
  description: string
  nodeCount: number
  /** Set when the file exists but cannot be read as a blueprint. */
  error?: string
}

export type FlowResult<T> = ({ ok: true } & T) | { ok: false; error: string }

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/
const SUFFIX = '.flow.json'

function flowsDir(userData: string, projectId: string): string | null {
  const project = loadProjects(userData).find((p) => p.id === projectId)
  return project ? path.join(project.path, '.agentship', 'flows') : null
}

function fileFor(dir: string, slug: string): string | null {
  if (!SLUG.test(slug)) return null
  const full = path.join(dir, `${slug}${SUFFIX}`)
  // Belt and braces on top of the slug check.
  return path.dirname(full) === dir ? full : null
}

export function listFlows(userData: string, projectId: string): FlowSummary[] {
  const dir = flowsDir(userData, projectId)
  if (!dir || !fs.existsSync(dir)) return []
  const out: FlowSummary[] = []
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(SUFFIX)) continue
    const slug = name.slice(0, -SUFFIX.length)
    try {
      const parsed = parseBlueprint(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')))
      out.push(
        parsed.ok
          ? {
              slug,
              name: parsed.blueprint.name,
              description: parsed.blueprint.description,
              nodeCount: parsed.blueprint.nodes.length
            }
          : { slug, name: slug, description: '', nodeCount: 0, error: parsed.error }
      )
    } catch (err) {
      out.push({ slug, name: slug, description: '', nodeCount: 0, error: (err as Error).message })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function loadFlow(
  userData: string,
  projectId: string,
  slug: string
): FlowResult<{ blueprint: Blueprint }> {
  const dir = flowsDir(userData, projectId)
  const file = dir && fileFor(dir, slug)
  if (!file) return { ok: false, error: 'Unknown project or invalid flow name.' }
  try {
    const parsed = parseBlueprint(JSON.parse(fs.readFileSync(file, 'utf8')))
    return parsed.ok ? { ok: true, blueprint: parsed.blueprint } : { ok: false, error: parsed.error }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** Validates before writing, and writes via a temp file + rename so a crash
 *  mid-save can never leave a half-written blueprint behind. */
export function saveFlow(
  userData: string,
  projectId: string,
  slug: string,
  raw: unknown
): FlowResult<{ blueprint: Blueprint }> {
  const dir = flowsDir(userData, projectId)
  const file = dir && fileFor(dir, slug)
  if (!dir || !file) return { ok: false, error: 'Unknown project or invalid flow name.' }

  const parsed = parseBlueprint(raw)
  if (!parsed.ok) return { ok: false, error: parsed.error }

  try {
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(parsed.blueprint, null, 2)}\n`)
    fs.renameSync(tmp, file)
    return { ok: true, blueprint: parsed.blueprint }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export function deleteFlow(userData: string, projectId: string, slug: string): FlowResult<object> {
  const dir = flowsDir(userData, projectId)
  const file = dir && fileFor(dir, slug)
  if (!file) return { ok: false, error: 'Unknown project or invalid flow name.' }
  try {
    fs.rmSync(file, { force: true })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// The Floor's Autopilot switch needs a plan file to point Autopilot at.
// These two operations are the only file access it does directly (rather
// than through an agent) - reading whether the file is there, and saving
// text a person pasted themselves. Generating a plan FROM an idea goes
// through the engine instead (buildPlanBlueprint), so it is a normal,
// budgeted, visible run like everything else.
import fs from 'node:fs'
import path from 'node:path'
import { LEGACY_PLAN_FILE, PLAN_FILE } from '../shared/patterns'

const MAX_PLAN_CHARS = 200_000

/** The repo-relative path of the project's plan: planning/PLAN.md, or a root
 *  PLAN.md from before that standard. Null when there is neither. */
export function findPlan(projectPath: string): string | null {
  try {
    for (const rel of [PLAN_FILE, LEGACY_PLAN_FILE]) if (fs.existsSync(path.join(projectPath, rel))) return rel
  } catch {
    // unreadable project directory: treated as no plan
  }
  return null
}

export function planExists(projectPath: string): boolean {
  return findPlan(projectPath) !== null
}

export function savePlan(projectPath: string, content: string): { ok: true } | { ok: false; error: string } {
  const text = String(content ?? '').trim()
  if (!text) return { ok: false, error: 'The plan is empty.' }
  if (text.length > MAX_PLAN_CHARS) return { ok: false, error: `That plan is too long (over ${MAX_PLAN_CHARS.toLocaleString()} characters).` }
  try {
    const file = path.join(projectPath, PLAN_FILE)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${text}\n`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// The Floor's Autopilot switch needs a plan file to point Autopilot at.
// These two operations are the only file access it does directly (rather
// than through an agent) - reading whether the file is there, and saving
// text a person pasted themselves. Generating a plan FROM an idea goes
// through the engine instead (buildPlanBlueprint), so it is a normal,
// budgeted, visible run like everything else.
import fs from 'node:fs'
import path from 'node:path'
import { PLAN_FILE } from '../shared/patterns'

const MAX_PLAN_CHARS = 200_000

export function planExists(projectPath: string): boolean {
  try {
    return fs.existsSync(path.join(projectPath, PLAN_FILE))
  } catch {
    return false
  }
}

export function savePlan(projectPath: string, content: string): { ok: true } | { ok: false; error: string } {
  const text = String(content ?? '').trim()
  if (!text) return { ok: false, error: 'The plan is empty.' }
  if (text.length > MAX_PLAN_CHARS) return { ok: false, error: `That plan is too long (over ${MAX_PLAN_CHARS.toLocaleString()} characters).` }
  try {
    fs.writeFileSync(path.join(projectPath, PLAN_FILE), `${text}\n`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

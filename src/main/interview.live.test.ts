// Opt-in: talks to the REAL `claude` CLI and spends real money (about $0.5 at most:
// the interview's own cap is $0.75 here).
//   AGENT_SHIP_LIVE=1 npx vitest run src/main/interview.live.test.ts
// What the fake adapter cannot prove: that the real CLI accepts --json-schema
// together with --resume, returns structured turns, and that a short interview
// reaches a written package.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ClaudeCodeAdapter } from './engine/adapter'
import { InterviewManager } from './interview'

const live = Boolean(process.env.AGENT_SHIP_LIVE)
let root = ''

beforeAll(() => {
  if (!live) return
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-live-'))
  const git = (...a: string[]): string => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 't')
  git('config', 'user.email', 't@t')
  fs.writeFileSync(path.join(root, 'README.md'), '# scratch\n\nA tiny command-line tool, no code yet.\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
})
afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

describe.skipIf(!live)('interview against the real CLI', () => {
  it('asks, resumes the same session with a schema, and ends in a written package', async () => {
    const m = new InterviewManager(new ClaudeCodeAdapter(), { capUsd: 0.75, turnCapUsd: 0.3, maxTurns: 6 })
    const log: string[] = []
    const show = (label: string, s: Awaited<ReturnType<typeof m.start>>): void => {
      log.push(`${label}: status=${s.status} turns=${s.turns} spent=$${s.spentUsd.toFixed(3)} ready=${Math.round(s.readiness * 100)}% error=${s.error ?? '-'}`)
      log.push(`  agent: ${s.messages.at(-1)?.text.slice(0, 300)}`)
    }

    const s1 = await m.start({ projectId: 'p', projectPath: root, projectName: 'Branchy', idea: 'A CLI that lists my git branches that are safe to delete.' })
    show('turn 1', s1)
    expect(s1.error).toBeUndefined()
    expect(s1.messages.at(-1)?.role).toBe('agent')

    const s2 = await m.answer(s1.id, 'Just me, on Windows. Safe means merged into main and untouched for 30 days. Non-goal: it never deletes anything, it only lists.')
    show('turn 2 (resumed + schema)', s2)
    expect(s2.error).toBeUndefined()
    expect(s2.turns).toBe(2)

    const s3 = await m.finish(s1.id)
    show('finish', s3)
    expect(s3.error).toBeUndefined()

    const p = m.preview(s1.id)!
    log.push(`files: ${p.files.map((f) => f.path).join(', ')}; warnings: ${p.warnings.length}`)
    const w = m.write(s1.id)
    expect(w.ok).toBe(true)
    console.log(`\n${log.join('\n')}\n\n--- PLAN.md ---\n${fs.readFileSync(path.join(root, 'planning', 'PLAN.md'), 'utf8')}`)
    expect(s3.spentUsd).toBeLessThan(0.75)
  }, 900_000)
})

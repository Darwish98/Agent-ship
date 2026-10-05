import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentAdapter, StepRequest, StepResult } from './engine/adapter'
import { InterviewManager } from './interview'
import { PLAN_TEMPLATE } from '../shared/planTemplate'
import { applyTurn, compilePackage, emptySections, parseTurn, readinessOf } from '../shared/interview'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-test-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))

const res = (over: Partial<StepResult> = {}): StepResult => ({
  ok: true,
  result: '',
  costUsd: 0.05,
  tokens: 100,
  sessionId: 's',
  budgetExhausted: false,
  timedOut: false,
  cancelled: false,
  ...over
})

class Fake implements AgentAdapter {
  reqs: StepRequest[] = []
  constructor(private readonly handler: (req: StepRequest, n: number) => StepResult) {}
  async run(req: StepRequest): Promise<StepResult> {
    this.reqs.push(req)
    return this.handler(req, this.reqs.length)
  }
}

const turn = (message: string, sections: { key: string; status?: string; content: string }[] = [], extra: Record<string, unknown> = {}): StepResult =>
  res({ structured: { message, sections: sections.map((s) => ({ status: 'ready', ...s })), ...extra } })

const ALL_REQUIRED = PLAN_TEMPLATE.flatMap((d) => d.sections.filter((s) => s.required).map((s) => ({ key: `${d.id}/${s.id}`, content: `Settled ${s.id}.` })))

const start = (m: InterviewManager, idea = 'a habit tracker') => m.start({ projectId: 'p', projectPath: dir, projectName: 'Habits', idea })

describe('interview turns', () => {
  it('starts one real session, then resumes it for every answer', async () => {
    const fake = new Fake((_r, n) => turn(`question ${n}`, [{ key: 'overview/goal', status: 'partial', content: 'Track habits.' }]))
    const m = new InterviewManager(fake)
    const s1 = await start(m)
    const s2 = await m.answer(s1.id, 'daily streaks')
    expect(fake.reqs.map((r) => r.resume)).toEqual([false, true])
    expect(fake.reqs[1].sessionId).toBe(fake.reqs[0].sessionId)
    expect(fake.reqs[0].prompt).toContain('a habit tracker')
    expect(fake.reqs[0].prompt).toMatch(/Never ask what you can find out yourself/)
    expect(fake.reqs[1].prompt).toContain('daily streaks')
    expect(fake.reqs[0].access).toBe('read')
    expect(fake.reqs[0].jsonSchema).toContain('"sections"')
    expect(s2.messages.map((x) => x.role)).toEqual(['user', 'agent', 'user', 'agent'])
    expect(s2.status).toBe('asking')
    expect(s2.sections.find((x) => x.key === 'overview/goal')?.content).toBe('Track habits.')
    expect(s2.spentUsd).toBeCloseTo(0.1)
  })

  it('carries the options the agent proposes', async () => {
    const m = new InterviewManager(new Fake(() => turn('Which store?', [], { options: [{ label: 'SQLite', detail: 'one file', recommended: true }, { label: 'JSON' }] })))
    const s = await start(m)
    expect(s.messages.at(-1)?.options).toEqual([
      { label: 'SQLite', detail: 'one file', recommended: true },
      { label: 'JSON', detail: '', recommended: false }
    ])
  })

  it('is buildable only when the CODE sees every required section ready, whatever the agent says', async () => {
    const claimsDone = new Fake(() => turn('All done!', [{ key: 'overview/goal', content: 'Track habits.' }], { ready: true }))
    const m = new InterviewManager(claimsDone)
    const s = await start(m)
    expect(s.buildable).toBe(false)
    expect(s.status).toBe('asking')

    const m2 = new InterviewManager(new Fake(() => turn('Looks complete.', ALL_REQUIRED)))
    const s2 = await start(m2)
    expect(s2.buildable).toBe(true)
    expect(s2.readiness).toBe(1)
    expect(s2.status).toBe('ready')
  })

  it('a malformed turn is never trusted: the interview stays put and the answer can be re-sent', async () => {
    let n = 0
    const fake = new Fake(() => {
      n++
      if (n === 1) return turn('First question', [{ key: 'overview/goal', content: 'Track habits.' }])
      if (n === 2) return res({ structured: { sections: 'nope' } })
      return turn('Second question')
    })
    const m = new InterviewManager(fake)
    const s1 = await start(m)
    const bad = await m.answer(s1.id, 'my answer')
    expect(bad.error).toMatch(/empty message|no structured/)
    expect(bad.turns).toBe(1)
    expect(bad.messages).toHaveLength(2) // the unanswered user message was not kept
    expect(bad.sections.find((x) => x.key === 'overview/goal')?.content).toBe('Track habits.')
    const good = await m.answer(s1.id, 'my answer')
    expect(good.error).toBeUndefined()
    expect(good.turns).toBe(2)
  })

  it('ignores unknown section keys and a "ready" status with no content', () => {
    const known = new Set(['overview/goal', 'overview/users'])
    const p = parseTurn(
      { message: 'q', sections: [{ key: 'overview/goal', status: 'ready', content: '' }, { key: 'bogus/x', status: 'ready', content: 'x' }, { key: 'overview/users', status: 'empty', content: 'Solo devs' }] },
      known
    )
    expect(p.ok).toBe(true)
    if (p.ok) expect(p.turn.sections).toEqual([{ key: 'overview/goal', status: 'empty', content: '' }, { key: 'overview/users', status: 'partial', content: 'Solo devs' }])
  })

  it('a failed first turn can be retried as a fresh session, not a resume', async () => {
    let n = 0
    const fake = new Fake(() => (++n === 1 ? res({ ok: false, error: 'boom', costUsd: 0 }) : turn('hi')))
    const m = new InterviewManager(fake)
    const s = await start(m)
    expect(s.error).toBe('boom')
    expect(s.status).toBe('asking')
    await m.answer(s.id, 'try again')
    expect(fake.reqs.map((r) => r.resume)).toEqual([false, false])
  })
})

describe('interview money and limits', () => {
  it('holds each turn to its cap and to the money left', async () => {
    const fake = new Fake(() => turn('q', [], {}))
    const m = new InterviewManager(fake, { capUsd: 0.2, turnCapUsd: 0.15 })
    const s = await start(m)
    await m.answer(s.id, 'a')
    expect(fake.reqs[0].maxUsd).toBeCloseTo(0.15)
    expect(fake.reqs[1].maxUsd).toBeCloseTo(0.15) // 0.2 - 0.05 spent = 0.15
  })

  it('stops, without calling the model, when the limit is spent', async () => {
    const m = new InterviewManager(new Fake(() => ({ ...turn('q'), costUsd: 0.2 })), { capUsd: 0.21, turnCapUsd: 0.3 })
    const s = await start(m)
    const s2 = await m.answer(s.id, 'more')
    expect(s2.status).toBe('stopped')
    expect(s2.error).toMatch(/spending limit/)
  })

  it('a budget-exhausted turn stops the interview but keeps what it has', async () => {
    let n = 0
    const m = new InterviewManager(new Fake(() => (++n === 1 ? turn('q', [{ key: 'overview/goal', status: 'partial', content: 'Track habits.' }]) : res({ ok: false, budgetExhausted: true, costUsd: 0.3 }))))
    const s = await start(m)
    const s2 = await m.answer(s.id, 'more')
    expect(s2.status).toBe('stopped')
    expect(s2.sections.find((x) => x.key === 'overview/goal')?.content).toBe('Track habits.')
    expect(m.preview(s.id)?.files.length).toBeGreaterThan(0)
  })

  it('refuses more questions past the turn limit, but can still finish', async () => {
    const m = new InterviewManager(new Fake(() => turn('q', [{ key: 'overview/goal', status: 'partial', content: 'g' }])), { maxTurns: 1 })
    const s = await start(m)
    const r = await m.answer(s.id, 'again')
    expect(r.error).toMatch(/most questions/)
  })

  it('cancelling stops it', async () => {
    const m = new InterviewManager(new Fake(() => turn('q')))
    const s = await start(m)
    expect(m.cancel(s.id)?.status).toBe('stopped')
    expect((await m.answer(s.id, 'x')).error).toMatch(/ended/)
  })
})

describe('"enough" and the person editing', () => {
  it('finish asks for a closing fill-in turn with no more questions, and then the plan is buildable', async () => {
    let n = 0
    const fake = new Fake(() => (++n === 1 ? turn('q', [{ key: 'overview/goal', status: 'partial', content: 'g' }]) : turn('Here is the plan.', ALL_REQUIRED, { assumptions: ['Single user'] })))
    const m = new InterviewManager(fake)
    const s = await start(m)
    const f = await m.finish(s.id)
    expect(fake.reqs[1].prompt).toMatch(/Do not ask another question/)
    expect(fake.reqs[1].resume).toBe(true)
    expect(f.buildable).toBe(true)
    expect(f.assumptions).toEqual(['Single user'])
  })

  it('if the closing turn still leaves gaps the interview ends and the gaps are reported, not invented', async () => {
    let n = 0
    const m = new InterviewManager(new Fake(() => (++n === 1 ? turn('q', [{ key: 'overview/goal', status: 'partial', content: 'g' }]) : turn('Best effort.'))))
    const s = await start(m)
    const f = await m.finish(s.id)
    expect(f.status).toBe('stopped')
    const p = m.preview(s.id)!
    expect(p.warnings.length).toBeGreaterThan(0)
    expect(p.files.find((x) => x.path === 'planning/OVERVIEW.md')?.content).toMatch(/Not decided yet/)
  })

  it('a section the person edited is theirs: the agent cannot overwrite it, and it is sent to the agent as settled', async () => {
    const fake = new Fake(() => turn('q', [{ key: 'overview/goal', status: 'partial', content: 'Agent version.' }]))
    const m = new InterviewManager(fake)
    const s = await start(m)
    const e = m.edit(s.id, 'overview/goal', 'My own wording.')!
    expect(e.sections.find((x) => x.key === 'overview/goal')).toMatchObject({ content: 'My own wording.', status: 'ready', edited: true })
    const s2 = await m.answer(s.id, 'next')
    expect(s2.sections.find((x) => x.key === 'overview/goal')?.content).toBe('My own wording.')
    expect(fake.reqs[1].prompt).toContain('overview/goal')
  })
})

describe('the package', () => {
  it('compiles the answers into the template files and appends assumptions to the overview', () => {
    let sections = emptySections()
    const applied = applyTurn(sections, [], {
      message: 'm',
      options: [],
      sections: ALL_REQUIRED.map((s) => ({ ...s, status: 'ready' as const })),
      assumptions: ['Runs on Windows only']
    })
    sections = applied.sections
    const { files, warnings } = compilePackage(sections, applied.assumptions, 'Habits')
    expect(warnings).toEqual([])
    expect(files.map((f) => f.path)).toEqual(['planning/OVERVIEW.md', 'planning/DESIGN.md', 'planning/PLAN.md'])
    const overview = files[0].content
    expect(overview).toMatch(/^# Habits - Overview/)
    expect(overview).toContain('Settled goal.')
    expect(overview).toContain('- Runs on Windows only')
    expect(readinessOf(sections).buildable).toBe(true)
  })

  it('leaves the design file out when nothing was said about the mechanism', () => {
    const { files } = compilePackage(emptySections(), [], 'X')
    expect(files.map((f) => f.path)).toEqual(['planning/OVERVIEW.md', 'planning/PLAN.md'])
  })

  it('writes the files, refuses to overwrite existing ones unless told to', async () => {
    const m = new InterviewManager(new Fake(() => turn('done', ALL_REQUIRED)))
    const s = await start(m)
    const w = m.write(s.id)
    expect(w.ok).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'planning', 'PLAN.md'), 'utf8')).toContain('Settled items.')
    expect(m.get(s.id)?.status).toBe('finished')

    fs.writeFileSync(path.join(dir, 'planning', 'PLAN.md'), 'mine')
    const again = m.write(s.id)
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.existing).toContain('planning/PLAN.md')
    expect(fs.readFileSync(path.join(dir, 'planning', 'PLAN.md'), 'utf8')).toBe('mine')
    expect(m.write(s.id, true).ok).toBe(true)
  })
})

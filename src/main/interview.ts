// The planning interview's engine. One real Claude session per interview,
// resumed for every answer, so the interviewer keeps the whole conversation
// and the repo it has already read. Each turn returns structured JSON that
// shared/interview.ts validates and folds into the plan state; this file
// owns the session, the money, and the one write at the end.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AgentAdapter } from './engine/adapter'
import {
  applyTurn,
  compilePackage,
  editSection,
  emptySections,
  parseTurn,
  readinessOf,
  TURN_SCHEMA,
  type InterviewState,
  type PackageFile
} from '../shared/interview'
import { PLAN_TEMPLATE, templateForPrompt } from '../shared/planTemplate'

export const INTERVIEW_CAP_USD = 1.5
export const INTERVIEW_TURN_CAP_USD = 0.3
export const INTERVIEW_MAX_TURNS = 14
/** A turn is never started with less than this left, as the run engine does. */
const MIN_TURN_USD = 0.02
const TURN_TIMEOUT_MS = 240_000
const MAX_ANSWER_CHARS = 8_000

const KNOWN_KEYS: ReadonlySet<string> = new Set(PLAN_TEMPLATE.flatMap((d) => d.sections.map((s) => `${d.id}/${s.id}`)))
const sectionKeys = (): string => [...KNOWN_KEYS].join(', ')

function interviewerPrompt(idea: string, projectName: string): string {
  return [
    `You are interviewing a person who has an idea${projectName ? ` for a project called "${projectName}"` : ''} and wants to leave with a complete, detailed,`,
    'buildable plan. You are the best product consultant they have ever worked with. Your job is to pin the idea down, not to collect answers.',
    '',
    'How you work:',
    '- First, look at the repository you are in (Read, Glob, Grep: the code, README, git history, any existing documents). Never ask what you can find out yourself.',
    '- Ask ONE question per turn, the one that closes the biggest remaining gap in the plan. Keep your message short.',
    '- Make ideas concrete. For every vague claim ("fast", "simple", "secure"), ask what it means as a number or an observable behaviour. Prefer scenario questions ("what happens when...") and ask for a real example.',
    '- When a decision exists, put 2-3 options in `options` with the trade-off of each, and mark the one you would pick as recommended. The person may choose, reject or answer in their own words.',
    '- Challenge them: point out answers that conflict, scope that will not fit one build, and ask what they would cut. Give non-goals as much attention as goals.',
    '- When you have to assume something, say so in `assumptions` (a full sentence each) so it can be corrected, and ask them to confirm the important ones.',
    '- After EVERY turn, return in `sections` each plan section that changed, with its full updated markdown and a status: "partial" while it is incomplete, "ready" only when it is specific enough to build from. Keep earlier answers: a section you rewrite must still contain what was already settled.',
    '- The plan items must each be small enough for one agent to build, test and land in one pass, in build order, and each must end with a concrete, checkable "Done when" line.',
    '- Stop asking once every required section is ready. Then say so plainly in your message.',
    '',
    'The plan has these documents and sections (use exactly these keys in `sections`):',
    templateForPrompt(),
    `Valid keys: ${sectionKeys()}.`,
    '',
    'Reply ONLY as the JSON described by the output schema: { message, options?, sections, assumptions? }.',
    '',
    'Their idea, in their words:',
    idea.trim() || '(They have not described it yet. Start by asking what they want to build and why.)'
  ].join('\n')
}

function answerPrompt(answer: string, edited: string[]): string {
  const lines = ['The person answered:', answer.trim()]
  if (edited.length) {
    lines.push('', `They also edited these sections themselves, so treat their wording as settled and do not rewrite them: ${edited.join(', ')}.`)
  }
  return lines.join('\n')
}

const FINISH_PROMPT = [
  'The person wants to stop here ("enough"). Do not ask another question.',
  'Complete EVERY section that is not yet ready now, using sensible choices. For each thing you decided without being told, add it to `assumptions`.',
  'Set the status of every section you write to "ready". Use `message` for one short closing summary of what the plan now says and what you assumed.'
].join('\n')

interface Live {
  state: InterviewState
  projectPath: string
  projectName: string
  sessionId: string
  /** A turn has succeeded, so the session exists and can be resumed. */
  started: boolean
  abort: AbortController | null
}

export interface StartInterview {
  projectId: string
  projectPath: string
  projectName: string
  idea: string
}

export type WriteResult = { ok: true; files: string[] } | { ok: false; error: string; existing?: string[] }

export class InterviewManager {
  private readonly live = new Map<string, Live>()
  constructor(
    private readonly adapter: AgentAdapter,
    private readonly opts: { capUsd?: number; turnCapUsd?: number; maxTurns?: number } = {}
  ) {}

  get(id: string): InterviewState | null {
    return this.live.get(id)?.state ?? null
  }

  async start(a: StartInterview): Promise<InterviewState> {
    const id = crypto.randomUUID()
    const cap = this.opts.capUsd ?? INTERVIEW_CAP_USD
    const sections = emptySections()
    const state: InterviewState = {
      id,
      projectId: a.projectId,
      status: 'working',
      messages: [],
      sections,
      assumptions: [],
      spentUsd: 0,
      capUsd: cap,
      turns: 0,
      maxTurns: this.opts.maxTurns ?? INTERVIEW_MAX_TURNS,
      ...readinessOf(sections)
    }
    const live: Live = { state, projectPath: a.projectPath, projectName: a.projectName, sessionId: crypto.randomUUID(), started: false, abort: null }
    this.live.set(id, live)
    return this.turn(live, interviewerPrompt(a.idea, a.projectName), a.idea.trim() ? { role: 'user', text: a.idea.trim() } : null)
  }

  async answer(id: string, text: string): Promise<InterviewState> {
    const live = this.live.get(id)
    if (!live) return this.missing()
    const answer = String(text ?? '').trim().slice(0, MAX_ANSWER_CHARS)
    if (!answer) return this.fail(live, 'Type an answer first.')
    if (live.state.status === 'working') return this.fail(live, 'The interviewer is still thinking.')
    if (live.state.status === 'stopped' || live.state.status === 'finished') return this.fail(live, 'This interview has ended.')
    if (live.state.turns >= live.state.maxTurns) return this.fail(live, 'That is the most questions this interview asks. Finish it to fill in the rest.')
    const edited = live.state.sections.filter((s) => s.edited).map((s) => s.key)
    return this.turn(live, answerPrompt(answer, edited), { role: 'user', text: answer })
  }

  /** "Enough": one last turn that fills every gap and marks what it assumed. */
  async finish(id: string): Promise<InterviewState> {
    const live = this.live.get(id)
    if (!live) return this.missing()
    if (live.state.status === 'working') return this.fail(live, 'The interviewer is still thinking.')
    if (live.state.status === 'finished') return live.state
    if (live.state.buildable) return live.state
    if (!live.started) return this.stop(live, 'Nothing has been discussed yet.')
    return this.turn(live, FINISH_PROMPT, null, true)
  }

  edit(id: string, key: string, text: string): InterviewState | null {
    const live = this.live.get(id)
    if (!live || live.state.status === 'finished') return live?.state ?? null
    const sections = editSection(live.state.sections, key, text)
    if (!sections) return live.state
    live.state = this.settle({ ...live.state, sections })
    return live.state
  }

  cancel(id: string): InterviewState | null {
    const live = this.live.get(id)
    if (!live) return null
    live.abort?.abort()
    if (live.state.status === 'working' || live.state.status === 'asking') live.state = { ...live.state, status: 'stopped', error: 'Cancelled.' }
    return live.state
  }

  /** What would be written, without writing it: the preview the person approves. */
  preview(id: string): { files: PackageFile[]; warnings: string[] } | null {
    const live = this.live.get(id)
    if (!live) return null
    return compilePackage(live.state.sections, live.state.assumptions, live.projectName)
  }

  /** Writes the package into the project. Refuses to overwrite a file already there unless told to. */
  write(id: string, overwrite = false): WriteResult {
    const live = this.live.get(id)
    if (!live) return { ok: false, error: 'That interview is gone.' }
    if (live.state.status === 'working') return { ok: false, error: 'The interviewer is still thinking.' }
    const { files } = compilePackage(live.state.sections, live.state.assumptions, live.projectName)
    const existing = files.filter((f) => fs.existsSync(path.join(live.projectPath, f.path))).map((f) => f.path)
    if (existing.length && !overwrite) return { ok: false, error: `${existing.join(', ')} already exist${existing.length === 1 ? 's' : ''}.`, existing }
    try {
      for (const f of files) {
        const full = path.join(live.projectPath, f.path)
        fs.mkdirSync(path.dirname(full), { recursive: true })
        fs.writeFileSync(full, f.content)
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
    live.state = { ...live.state, status: 'finished', error: undefined }
    return { ok: true, files: files.map((f) => f.path) }
  }

  // --- internals -----------------------------------------------------------------

  private async turn(live: Live, prompt: string, userMessage: { role: 'user'; text: string } | null, closing = false): Promise<InterviewState> {
    const s = live.state
    const cap = s.capUsd - s.spentUsd
    if (cap < MIN_TURN_USD) return this.stop(live, 'The interview has used its spending limit.')
    const before = s
    live.state = { ...s, status: 'working', error: undefined, messages: userMessage ? [...s.messages, userMessage] : s.messages }
    live.abort = new AbortController()
    const res = await this.adapter.run({
      prompt,
      cwd: live.projectPath,
      sessionId: live.sessionId,
      resume: live.started,
      model: 'sonnet',
      access: 'read',
      tools: [],
      maxUsd: Math.min(this.opts.turnCapUsd ?? INTERVIEW_TURN_CAP_USD, cap),
      jsonSchema: TURN_SCHEMA,
      env: {},
      timeoutMs: TURN_TIMEOUT_MS,
      signal: live.abort.signal
    })
    live.abort = null
    const spent = before.spentUsd + (res.costUsd || 0)

    if (res.cancelled) return (live.state = { ...before, spentUsd: spent, status: 'stopped', error: 'Cancelled.' })
    // A turn that did not produce a usable answer leaves the interview where it was,
    // so the person can send the same answer again.
    const retry = (error: string): InterviewState => (live.state = this.settle({ ...before, spentUsd: spent, error }, 'asking'))
    if (res.budgetExhausted) return this.stop(live, 'The interview ran out of its spending limit.', { ...before, spentUsd: spent })
    if (!res.ok) return retry(res.timedOut ? 'The interviewer took too long. Try again.' : res.error || 'The interviewer failed. Try again.')
    live.started = true

    const parsed = parseTurn(res.structured, KNOWN_KEYS)
    if (!parsed.ok) return retry(parsed.error)

    const merged = applyTurn(before.sections, before.assumptions, parsed.turn)
    const turns = before.turns + 1
    const next: InterviewState = this.settle(
      {
        ...before,
        error: undefined,
        spentUsd: spent,
        turns,
        sections: merged.sections,
        assumptions: merged.assumptions,
        messages: [
          ...live.state.messages,
          { role: 'agent', text: parsed.turn.message, ...(parsed.turn.options.length ? { options: parsed.turn.options } : {}) }
        ]
      },
      'asking'
    )
    // The closing turn ends the interview whatever the agent managed to fill:
    // gaps are reported when the package is previewed, never silently invented.
    live.state = closing ? { ...next, status: next.buildable ? 'ready' : 'stopped' } : next
    return live.state
  }

  /** Recomputes readiness and the status that follows from it. */
  private settle(s: InterviewState, fallback: 'asking' = 'asking'): InterviewState {
    const r = readinessOf(s.sections)
    const status = s.status === 'stopped' || s.status === 'finished' ? s.status : r.buildable ? 'ready' : fallback
    return { ...s, ...r, status }
  }

  private stop(live: Live, error: string, base: InterviewState = live.state): InterviewState {
    return (live.state = { ...base, ...readinessOf(base.sections), status: 'stopped', error })
  }

  private fail(live: Live, error: string): InterviewState {
    return { ...live.state, error }
  }

  private missing(): InterviewState {
    return {
      id: '',
      projectId: '',
      status: 'stopped',
      messages: [],
      sections: [],
      assumptions: [],
      spentUsd: 0,
      capUsd: 0,
      turns: 0,
      maxTurns: 0,
      readiness: 0,
      buildable: false,
      error: 'That interview is gone.'
    }
  }
}

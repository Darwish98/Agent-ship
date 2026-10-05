// The pure half of the planning interview: what state it keeps, how an agent's
// structured turn is validated and merged into that state (never trusted as
// given), when the plan counts as buildable, and how the answers compile into
// the planning/ package. No I/O here, so it is all directly testable.
import { PLAN_TEMPLATE, planDoc, type PlanDocId } from './planTemplate'

export type SectionStatus = 'empty' | 'partial' | 'ready'

export interface SectionState {
  /** `${doc}/${section}`, e.g. `overview/goal`. */
  key: string
  doc: PlanDocId
  id: string
  title: string
  required: boolean
  status: SectionStatus
  /** Markdown, as it will appear in the document. */
  content: string
  /** The person wrote or changed this; the agent may not overwrite it. */
  edited: boolean
}

export interface InterviewOption {
  label: string
  detail: string
  recommended: boolean
}

export interface InterviewMessage {
  role: 'agent' | 'user'
  text: string
  /** Only on an agent message: choices it proposes for the decision it is asking about. */
  options?: InterviewOption[]
}

export type InterviewStatus =
  /** Waiting for the person's answer. */
  | 'asking'
  /** A turn is running. */
  | 'working'
  /** Every required section is filled: buildable. The person can still keep going. */
  | 'ready'
  /** Ended early (budget, turn limit, cancelled, a failed turn): what exists can still be previewed and written. */
  | 'stopped'
  /** The package was written. */
  | 'finished'

export interface InterviewState {
  id: string
  projectId: string
  status: InterviewStatus
  messages: InterviewMessage[]
  sections: SectionState[]
  assumptions: string[]
  spentUsd: number
  capUsd: number
  turns: number
  maxTurns: number
  /** 0..1: share of required sections that are ready. Computed here, never reported by the agent. */
  readiness: number
  /** Every required section is ready. Computed here: the agent saying "done" is not enough. */
  buildable: boolean
  /** Why the last turn failed or the interview stopped, if it did. */
  error?: string
}

export const sectionKey = (doc: PlanDocId, id: string): string => `${doc}/${id}`

export function emptySections(): SectionState[] {
  return PLAN_TEMPLATE.flatMap((d) =>
    d.sections.map((s) => ({ key: sectionKey(d.id, s.id), doc: d.id, id: s.id, title: s.title, required: s.required, status: 'empty' as SectionStatus, content: '', edited: false }))
  )
}

export function readinessOf(sections: readonly SectionState[]): { readiness: number; buildable: boolean } {
  const req = sections.filter((s) => s.required)
  const ready = req.filter((s) => s.status === 'ready').length
  return { readiness: req.length ? ready / req.length : 1, buildable: ready === req.length }
}

// --- the agent's turn ----------------------------------------------------------

export interface AgentTurn {
  message: string
  options: InterviewOption[]
  sections: { key: string; status: SectionStatus; content: string }[]
  assumptions: string[]
}

const MAX_SECTION_CHARS = 12_000
const MAX_MESSAGE_CHARS = 4_000

/** The contract handed to `--json-schema`. Deliberately loose on optional parts. */
export const TURN_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    message: { type: 'string', description: 'What you say to the person: usually one question.' },
    options: {
      type: 'array',
      description: 'Optional: 2-3 choices for the decision you are asking about.',
      items: {
        type: 'object',
        properties: { label: { type: 'string' }, detail: { type: 'string' }, recommended: { type: 'boolean' } },
        required: ['label']
      }
    },
    sections: {
      type: 'array',
      description: 'Only the plan sections that changed this turn, each with its full updated markdown.',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'e.g. overview/goal' },
          status: { type: 'string', enum: ['empty', 'partial', 'ready'] },
          content: { type: 'string' }
        },
        required: ['key', 'status', 'content']
      }
    },
    assumptions: { type: 'array', items: { type: 'string' }, description: 'Assumptions you are making, in full, so they can be corrected.' }
  },
  required: ['message', 'sections']
})

const STATUSES: readonly string[] = ['empty', 'partial', 'ready']

/** Validates what the agent sent. Anything malformed is rejected or dropped,
 *  never guessed at: a plan built on a misread turn is worse than a retry. */
export function parseTurn(raw: unknown, known: ReadonlySet<string>): { ok: true; turn: AgentTurn } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'The interviewer sent no structured answer.' }
  const o = raw as Record<string, unknown>
  const message = typeof o.message === 'string' ? o.message.trim().slice(0, MAX_MESSAGE_CHARS) : ''
  if (!message) return { ok: false, error: 'The interviewer sent an empty message.' }

  const options: InterviewOption[] = []
  if (Array.isArray(o.options)) {
    for (const x of o.options.slice(0, 4)) {
      if (!x || typeof x !== 'object') continue
      const r = x as Record<string, unknown>
      const label = typeof r.label === 'string' ? r.label.trim().slice(0, 200) : ''
      if (!label) continue
      options.push({ label, detail: typeof r.detail === 'string' ? r.detail.trim().slice(0, 600) : '', recommended: r.recommended === true })
    }
  }

  const sections: AgentTurn['sections'] = []
  if (Array.isArray(o.sections)) {
    for (const x of o.sections) {
      if (!x || typeof x !== 'object') continue
      const r = x as Record<string, unknown>
      if (typeof r.key !== 'string' || !known.has(r.key)) continue
      const content = typeof r.content === 'string' ? r.content.trim().slice(0, MAX_SECTION_CHARS) : ''
      let status = typeof r.status === 'string' && STATUSES.includes(r.status) ? (r.status as SectionStatus) : 'partial'
      // "ready" with nothing written is not ready.
      if (!content) status = 'empty'
      else if (status === 'empty') status = 'partial'
      sections.push({ key: r.key, status, content })
    }
  }

  const assumptions = Array.isArray(o.assumptions)
    ? o.assumptions.filter((a): a is string => typeof a === 'string' && !!a.trim()).map((a) => a.trim().slice(0, 500)).slice(0, 30)
    : []
  return { ok: true, turn: { message, options, sections, assumptions } }
}

/** Folds a validated turn into the state. A section the person edited keeps
 *  their text; the agent's version of it is dropped. */
export function applyTurn(sections: readonly SectionState[], assumptions: readonly string[], turn: AgentTurn): { sections: SectionState[]; assumptions: string[] } {
  const next = sections.map((s) => ({ ...s }))
  for (const u of turn.sections) {
    const s = next.find((x) => x.key === u.key)
    if (!s || s.edited) continue
    s.status = u.status
    s.content = u.content
  }
  const merged = [...assumptions]
  for (const a of turn.assumptions) if (!merged.includes(a)) merged.push(a)
  return { sections: next, assumptions: merged }
}

/** The person's own edit of a section: it counts as ready and the agent may not overwrite it. */
export function editSection(sections: readonly SectionState[], key: string, text: string): SectionState[] | null {
  if (!sections.some((s) => s.key === key)) return null
  const content = text.trim().slice(0, MAX_SECTION_CHARS)
  return sections.map((s) => (s.key === key ? { ...s, content, status: content ? 'ready' : 'empty', edited: content !== '' } : s))
}

// --- the package ---------------------------------------------------------------

export interface PackageFile {
  path: string
  content: string
}

const NOT_DECIDED = '_Not decided yet - the interview ended before this was settled._'

/** Compiles the interview into the planning/ files. Deterministic, so the
 *  preview the person approves is exactly what is written. */
export function compilePackage(
  sections: readonly SectionState[],
  assumptions: readonly string[],
  projectName: string
): { files: PackageFile[]; warnings: string[] } {
  const files: PackageFile[] = []
  const warnings: string[] = []
  for (const doc of PLAN_TEMPLATE) {
    const mine = sections.filter((s) => s.doc === doc.id)
    // The design doc is skipped when nothing was said about the mechanism: a
    // small idea has no design to write down.
    if (doc.id === 'design' && mine.every((s) => !s.content)) continue
    const parts: string[] = [`# ${projectName ? `${projectName} - ` : ''}${doc.title}`, '', doc.purpose, '']
    for (const s of mine) {
      let body = s.content
      if (doc.id === 'overview' && s.id === 'assumptions') {
        const list = assumptions.map((a) => `- ${a}`).join('\n')
        body = [s.content, list].filter(Boolean).join('\n\n')
      }
      if (!body) {
        if (!s.required) continue
        warnings.push(`${planDoc(doc.id).title}: "${s.title}" was never settled.`)
        body = NOT_DECIDED
      }
      parts.push(`## ${s.title}`, '', body, '')
    }
    files.push({ path: doc.file, content: `${parts.join('\n').trimEnd()}\n` })
  }
  return { files, warnings }
}

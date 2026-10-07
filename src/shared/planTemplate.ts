// The one shape every project's planning takes. Three documents, each a fixed
// list of sections with a one-line hint of what belongs there. "Write a plan",
// "Paste a plan" and the interview all read this, so a project planned any of
// those ways looks the same and the Autopilot plan-check can rely on it.

/** The one folder every project keeps its planning in. */
export const PLANNING_DIR = 'planning'
export const OVERVIEW_FILE = `${PLANNING_DIR}/OVERVIEW.md`
export const DESIGN_FILE = `${PLANNING_DIR}/DESIGN.md`
/** What the Floor's Autopilot switch reads and writes by default. */
export const PLAN_FILE = `${PLANNING_DIR}/PLAN.md`
/** Where projects set up before the planning/ standard kept their plan. Still
 *  read, never written. */
export const LEGACY_PLAN_FILE = 'PLAN.md'
export const SPIKES_DIR = `${PLANNING_DIR}/spikes`

export type PlanDocId = 'overview' | 'design' | 'plan'

export interface PlanSection {
  /** Stable id: the interview tracks its progress per section by this. */
  id: string
  title: string
  /** One line: what belongs here. Shown to the person and to the agent. */
  hint: string
  /** A plan without this is not buildable; the interview must fill it (or mark an assumption). */
  required: boolean
}

export interface PlanDoc {
  id: PlanDocId
  file: string
  title: string
  /** What the document is for. */
  purpose: string
  sections: readonly PlanSection[]
}

export const PLAN_TEMPLATE: readonly PlanDoc[] = [
  {
    id: 'overview',
    file: OVERVIEW_FILE,
    title: 'Overview',
    purpose: 'The why, for a person to read: what this is, for whom, and where it is going.',
    sections: [
      { id: 'goal', title: 'Goal', hint: 'What this is and the problem it solves, in a few sentences.', required: true },
      { id: 'users', title: 'Users', hint: 'Who uses it and what they are trying to do.', required: true },
      { id: 'must-haves', title: 'Must-haves', hint: 'What has to work for this to be worth shipping.', required: true },
      { id: 'non-goals', title: 'Non-goals', hint: 'What this deliberately will not do. The boundary of the first version.', required: true },
      { id: 'done-when', title: 'Done when', hint: 'Observable, checkable criteria for the whole project being finished.', required: true },
      { id: 'roadmap', title: 'Roadmap', hint: 'Phases in order, each independently useful.', required: true },
      { id: 'assumptions', title: 'Assumptions', hint: 'Anything decided without being told, so it can be corrected.', required: false }
    ]
  },
  {
    id: 'design',
    file: DESIGN_FILE,
    title: 'Design',
    purpose: 'The mechanism: how the pieces fit, what was chosen and why. Proportional to the idea.',
    sections: [
      { id: 'stack', title: 'Stack', hint: 'Languages, frameworks, services and tools, and why these.', required: true },
      { id: 'mechanism', title: 'How it works', hint: 'The main pieces and how they fit together.', required: true },
      { id: 'constraints', title: 'Constraints', hint: 'Budget, platform, performance, compatibility, deadlines.', required: false },
      { id: 'risks', title: 'Risks and open questions', hint: 'What could go wrong or is still undecided, honestly.', required: false }
    ]
  },
  {
    id: 'plan',
    file: PLAN_FILE,
    title: 'Plan',
    purpose: 'What is left, in build order. The file Autopilot works from, one item at a time.',
    sections: [
      { id: 'items', title: 'Items', hint: 'Numbered, independently buildable and landable, earlier items unblocking later ones.', required: true },
      { id: 'out-of-loop', title: 'Not part of this build loop', hint: 'Things that need a person, not a build/test/land cycle.', required: false }
    ]
  }
]

export function planDoc(id: PlanDocId): PlanDoc {
  return PLAN_TEMPLATE.find((d) => d.id === id)!
}

/** The format every PLAN item follows. The `- [ ]` box is how Autopilot tracks
 *  progress (it ticks `- [x]` when an item lands, and stops when none is left); the
 *  "Done when" line is what the final plan-check reads to confirm an item is real. */
export const PLAN_ITEM_FORMAT = [
  '- [ ] 1. **Short title.** What to build, naming real files, commands and behaviour.',
  '      Why: one line, or a link to the section of OVERVIEW/DESIGN it comes from.',
  '      Done when: one concrete, checkable condition (a command that passes, a',
  '      behaviour that can be observed). Not "works well".'
].join('\n')

/** The empty document, headings and hints only: what "Paste a plan" and a
 *  person starting by hand begin from. */
export function templateMarkdown(id: PlanDocId, projectName = ''): string {
  const doc = planDoc(id)
  const head = `# ${projectName ? `${projectName} - ` : ''}${doc.title}\n\n${doc.purpose}\n`
  if (id === 'plan') {
    return `${head}\n## Items\n\n${PLAN_ITEM_FORMAT}\n\n## Not part of this build loop\n\n_${planDoc('plan').sections[1].hint}_\n`
  }
  const body = doc.sections.map((s) => `## ${s.title}\n\n_${s.hint}_\n`).join('\n')
  return `${head}\n${body}`
}

/** The template described in words, for an agent's prompt. */
export function templateForPrompt(): string {
  const lines: string[] = []
  for (const doc of PLAN_TEMPLATE) {
    lines.push(`${doc.file} - ${doc.purpose}`)
    for (const s of doc.sections) lines.push(`  - ${s.title}${s.required ? '' : ' (optional)'}: ${s.hint}`)
    if (doc.id === 'plan') {
      lines.push('  Each item follows this format:')
      for (const l of PLAN_ITEM_FORMAT.split('\n')) lines.push(`    ${l}`)
    }
  }
  return lines.join('\n')
}

// Shipped blueprints. The first two are the behaviours the app used to have
// hard-coded ("Brief the orchestrator", "Collect & merge") re-expressed as
// data: agents.ts now reads its prompts from here, so the model has to be
// expressive enough to carry what the product already did.
import { SCHEMA_VERSION } from './blueprint'
import type { Blueprint, BlueprintEdge, BlueprintNode } from './schema'

const at = (col: number, row = 0): { x: number; y: number } => ({ x: col * 290, y: row * 170 })

const edge = (
  from: string,
  to: string,
  type: BlueprintEdge['type'] = 'artifact',
  condition: BlueprintEdge['condition'] = 'always'
): BlueprintEdge => ({ id: `${from}->${to}${condition === 'fail' ? ':fail' : ''}`, from, to, type, condition })

const trigger = (id = 'start', col = 0, row = 0): BlueprintNode => ({
  id,
  kind: 'trigger',
  label: 'Start',
  position: at(col, row),
  config: { type: 'manual' }
})

const agent = (
  id: string,
  label: string,
  prompt: string,
  col: number,
  opts: { row?: number; worktree?: boolean; maxTokens?: number; tools?: string[] } = {}
): BlueprintNode => ({
  id,
  kind: 'agent',
  label,
  position: at(col, opts.row ?? 0),
  budget: opts.maxTokens ? { maxTokens: opts.maxTokens } : undefined,
  config: {
    role: label,
    model: 'default',
    prompt,
    worktree: opts.worktree ?? false,
    tools: opts.tools ?? [],
    outputSchema: ''
  }
})

// --- the two behaviours the app already had --------------------------------

const SUPERVISOR: Blueprint = {
  schemaVersion: SCHEMA_VERSION,
  name: 'Supervisor',
  description:
    'One orchestrator agent that takes your brief and delegates it to sub-agents of its own.',
  version: 1,
  defaultBudget: {},
  inputs: [{ name: 'brief', label: 'What should the orchestrator get done?', required: true }],
  nodes: [trigger(), agent('orchestrator', 'Orchestrator', '{{brief}}', 1)],
  edges: [edge('start', 'orchestrator', 'control')]
}

const MERGE_PROMPT = [
  'You are the merge orchestrator for this repository.',
  '',
  'Land these branches on "{{baseBranch}}", one at a time, oldest first:',
  '{{branches}}',
  '',
  'For each branch:',
  '1. git checkout {{baseBranch}} && git merge <branch>',
  '2. If there are conflicts, read both sides and resolve them so the',
  '   intent of BOTH changes survives. Never resolve by blindly taking one',
  "   side, and never delete another agent's work to make a conflict go away.",
  '3. If the repo has tests or a typecheck/build script, run it after each',
  '   merge and fix anything the merge broke before moving on.',
  '4. Commit the merge with a message naming the branch you landed.',
  '',
  'Do not force-push, do not rebase shared history, and do not delete',
  'branches. If a branch is too conflicted to land safely, stop, leave it',
  'unmerged, and report why.'
].join('\n')

const MERGE_TRAIN: Blueprint = {
  schemaVersion: SCHEMA_VERSION,
  name: 'Merge train',
  description: 'Lands every unmerged agent branch on the base branch, resolving conflicts as it goes.',
  version: 1,
  defaultBudget: {},
  inputs: [
    { name: 'baseBranch', label: 'Base branch', required: true },
    { name: 'branches', label: 'Branches to land', required: true }
  ],
  nodes: [
    trigger(),
    {
      id: 'merge',
      kind: 'merge',
      label: 'Orchestrator',
      position: at(1),
      config: { baseBranch: '{{baseBranch}}', resolveConflicts: true, resolverPrompt: MERGE_PROMPT }
    }
  ],
  edges: [edge('start', 'merge', 'branch')]
}

// --- patterns that exercise the rest of the model --------------------------

const PIPELINE: Blueprint = {
  schemaVersion: SCHEMA_VERSION,
  name: 'Plan → build → test → review',
  description: 'A builder works in its own branch until the tests pass, then a reviewer signs off.',
  version: 1,
  defaultBudget: { maxTokens: 400_000 },
  inputs: [{ name: 'task', label: 'What should be built?', required: true }],
  nodes: [
    trigger(),
    agent('plan', 'Planner', 'Write a short, concrete implementation plan for: {{task}}', 1, {
      maxTokens: 150_000
    }),
    agent('build', 'Builder', 'Implement this plan in the repository:\n\n{{upstream}}', 2, {
      worktree: true,
      maxTokens: 600_000
    }),
    {
      id: 'tests',
      kind: 'gate',
      label: 'Tests pass',
      position: at(3),
      budget: { maxRetries: 3 },
      config: { check: 'command', command: 'npm test', instructions: '' }
    },
    agent('review', 'Reviewer', 'Review the change on this branch for correctness and risk:\n\n{{upstream}}', 4, {
      maxTokens: 200_000
    })
  ],
  edges: [
    edge('start', 'plan', 'control'),
    edge('plan', 'build'),
    edge('build', 'tests', 'branch'),
    edge('tests', 'review', 'verdict', 'pass'),
    edge('tests', 'build', 'verdict', 'fail')
  ]
}

const TOURNAMENT: Blueprint = {
  schemaVersion: SCHEMA_VERSION,
  name: 'Best-of-N tournament',
  description: 'N agents solve the same task in separate branches; the best passing one is merged.',
  version: 1,
  defaultBudget: { maxTokens: 300_000 },
  inputs: [{ name: 'task', label: 'Task every contender attempts', required: true }],
  nodes: [
    trigger(),
    {
      id: 'spread',
      kind: 'fanout',
      label: 'Spread',
      position: at(1),
      config: { mode: 'count', count: 3 }
    },
    agent('contender', 'Contender', '{{task}}', 2, { worktree: true, maxTokens: 300_000 }),
    {
      id: 'pick',
      kind: 'join',
      label: 'Pick the best',
      position: at(3),
      config: { strategy: 'best', quorum: 2 }
    },
    {
      id: 'tests',
      kind: 'gate',
      label: 'Tests pass',
      position: at(4),
      config: { check: 'command', command: 'npm test', instructions: '' }
    },
    {
      id: 'land',
      kind: 'merge',
      label: 'Land it',
      position: at(5),
      config: { baseBranch: 'main', resolveConflicts: true, resolverPrompt: '' }
    }
  ],
  edges: [
    edge('start', 'spread', 'control'),
    edge('spread', 'contender'),
    edge('contender', 'pick', 'branch'),
    edge('pick', 'tests', 'branch'),
    edge('tests', 'land', 'branch', 'pass')
  ]
}

export const PATTERNS: readonly Blueprint[] = [SUPERVISOR, MERGE_TRAIN, PIPELINE, TOURNAMENT]

export const SUPERVISOR_PATTERN = SUPERVISOR
export const MERGE_TRAIN_PATTERN = MERGE_TRAIN

/** A fresh copy the user can edit without touching the shipped one. */
export function fromPattern(pattern: Blueprint): Blueprint {
  return JSON.parse(JSON.stringify(pattern)) as Blueprint
}

export function emptyBlueprint(name = 'New flow'): Blueprint {
  return {
    schemaVersion: SCHEMA_VERSION,
    name,
    description: '',
    version: 1,
    defaultBudget: {},
    inputs: [],
    nodes: [trigger()],
    edges: []
  }
}

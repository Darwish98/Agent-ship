// Shipped blueprints. "Supervisor" and "Land a branch" are the two behaviours
// the app once hard-coded (a fixed orchestrator card and a merge agent),
// re-expressed as data the engine runs.
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
  opts: {
    row?: number
    worktree?: boolean
    edit?: boolean
    maxTokens?: number
    maxUsd?: number
    tools?: string[]
  } = {}
): BlueprintNode => ({
  id,
  kind: 'agent',
  label,
  position: at(col, opts.row ?? 0),
  budget:
    opts.maxTokens || opts.maxUsd ? { maxTokens: opts.maxTokens, maxUsd: opts.maxUsd } : undefined,
  config: {
    role: label,
    model: 'default',
    prompt,
    worktree: opts.worktree ?? false,
    access: opts.edit ? 'edit' : 'read',
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
  defaultBudget: { maxUsd: 3 },
  inputs: [{ name: 'brief', label: 'What should the orchestrator get done?', required: true }],
  nodes: [trigger(), agent('orchestrator', 'Orchestrator', '{{brief}}', 1, { edit: true })],
  edges: [edge('start', 'orchestrator', 'control')]
}

/** Brief for the agent that resolves conflicts. It only runs when a merge
 *  actually conflicts; a clean merge never calls an agent. */
export const RESOLVER_PROMPT = [
  'A git merge of "{{branch}}" into "{{baseBranch}}" stopped with conflicts.',
  'You are in a scratch copy of the repository with the merge in progress.',
  '',
  'Conflicted files:',
  '{{conflicts}}',
  '',
  'Resolve every conflict so the intent of BOTH sides survives. Never resolve by',
  "blindly taking one side, and never delete another change's work to make a",
  'conflict go away. Remove all conflict markers, then `git add` the resolved files.',
  'Do NOT commit, push, rebase, or switch branches; the caller finishes the merge.',
  'If a file cannot be resolved safely, leave it conflicted and say why.'
].join('\n')

export const LAND_FLOW = '__land__'

export interface LandOptions {
  branch: string
  base: string
  /** Empty means "no tests": the Test steps are left out and the result is unverified. */
  testCommand: string
  resolveConflicts: boolean
  /** Dollars the conflict resolver may spend (only used if it is needed). */
  maxUsd?: number
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * The pipeline that lands a finished branch: test it, merge it into the base
 * in a scratch copy, test the merged result, and only then advance the base.
 * Nothing touches your checkout until the last step, and a failure at any
 * step leaves the base branch exactly as it was.
 */
export function buildLandBlueprint(o: LandOptions): Blueprint {
  const nodes: BlueprintNode[] = [trigger()]
  const edges: BlueprintEdge[] = []
  let prev = 'start'
  let col = 1
  const add = (node: BlueprintNode, type: BlueprintEdge['type'] = 'branch'): void => {
    nodes.push(node)
    edges.push(edge(prev, node.id, type))
    prev = node.id
  }
  const tests = o.testCommand.trim()
  const gate = (id: string, label: string): BlueprintNode => ({
    id,
    kind: 'gate',
    label,
    position: at(col++),
    budget: { maxMinutes: 15 },
    config: { check: 'command', command: tests, instructions: '' }
  })

  if (tests) add(gate('test', 'Test the branch'))
  add({
    id: 'merge',
    kind: 'merge',
    label: `Merge into ${clip(o.base, 24)}`,
    position: at(col++),
    budget: o.resolveConflicts ? { maxUsd: o.maxUsd ?? 1 } : undefined,
    config: { baseBranch: o.base, resolveConflicts: o.resolveConflicts, resolverPrompt: RESOLVER_PROMPT }
  })
  if (tests) add(gate('verify', 'Test the merged result'))
  add({ id: 'land', kind: 'land', label: `Land on ${clip(o.base, 24)}`, position: at(col++), config: { baseBranch: o.base } })

  return {
    schemaVersion: SCHEMA_VERSION,
    name: `Land ${clip(o.branch, 48)}`,
    description: 'Tests a branch, merges it in a scratch copy, tests the result, then advances the base branch.',
    version: 1,
    defaultBudget: { maxUsd: o.maxUsd ?? 1 },
    inputs: [{ name: 'branch', label: 'Branch to land', required: true }],
    nodes,
    edges
  }
}

const LAND_PATTERN: Blueprint = {
  ...buildLandBlueprint({ branch: '<branch>', base: 'main', testCommand: 'npm test', resolveConflicts: true }),
  name: 'Land a branch',
  description: 'Test a branch, merge it into main in a scratch copy, test the result, then advance main. Set the branch as the run input.'
}

// --- patterns that exercise the rest of the model --------------------------

const PIPELINE: Blueprint = {
  schemaVersion: SCHEMA_VERSION,
  name: 'Plan → build → test → review',
  description: 'A builder works in its own branch until the tests pass, then a reviewer signs off.',
  version: 1,
  defaultBudget: { maxTokens: 400_000, maxUsd: 1 },
  inputs: [{ name: 'task', label: 'What should be built?', required: true }],
  nodes: [
    trigger(),
    agent('plan', 'Planner', 'Write a short, concrete implementation plan for: {{task}}', 1, {
      maxTokens: 150_000,
      maxUsd: 0.5
    }),
    agent('build', 'Builder', 'Implement this plan in the repository:\n\n{{plan.result}}', 2, {
      worktree: true,
      edit: true,
      maxTokens: 600_000,
      maxUsd: 1
    }),
    {
      id: 'tests',
      kind: 'gate',
      label: 'Tests pass',
      position: at(3),
      budget: { maxRetries: 3 },
      config: { check: 'command', command: 'npm test', instructions: '' }
    },
    agent(
      'review',
      'Reviewer',
      'Review the change on this branch for correctness and risk. Summarise your verdict.\n\nThe builder said:\n{{build.result}}',
      4,
      { maxTokens: 200_000, maxUsd: 0.5 }
    )
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
  defaultBudget: { maxTokens: 300_000, maxUsd: 1 },
  inputs: [{ name: 'task', label: 'Task every contender attempts', required: true }],
  nodes: [
    trigger(),
    {
      id: 'spread',
      kind: 'fanout',
      label: 'Spread',
      position: at(1),
      config: { count: 3 }
    },
    agent('contender', 'Contender', '{{task}}', 2, { worktree: true, edit: true, maxTokens: 300_000, maxUsd: 1 }),
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

export const PATTERNS: readonly Blueprint[] = [SUPERVISOR, LAND_PATTERN, PIPELINE, TOURNAMENT]


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

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
    config: { check: 'command', command: tests, instructions: '', agentPrompt: '', agentModel: 'default', agentTools: [] }
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
      config: { check: 'command', command: 'npm test', instructions: '', agentPrompt: '', agentModel: 'default', agentTools: [] }
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
  description:
    'N agents solve the same task in separate branches, each held to your tests. A judge picks the best passing one; it is merged, re-tested, and landed.',
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
    agent(
      'contender',
      'Contender',
      '{{task}}\n\nYou are contender {{copy}} of {{copies}}, working alone in your own branch. Take the approach you think is best.',
      2,
      { worktree: true, edit: true, maxTokens: 300_000, maxUsd: 0.5 }
    ),
    {
      id: 'tests',
      kind: 'gate',
      label: 'Tests pass',
      position: at(3),
      budget: { maxRetries: 1 },
      config: { check: 'command', command: 'npm test', instructions: '', agentPrompt: '', agentModel: 'default', agentTools: [] }
    },
    {
      id: 'pick',
      kind: 'join',
      label: 'Judge picks the best',
      position: at(4),
      budget: { maxUsd: 0.3 },
      config: {
        strategy: 'best',
        quorum: 2,
        criteria: 'Correctness first, then the smallest change that fully does the job, then clarity.'
      }
    },
    {
      id: 'merge',
      kind: 'merge',
      label: 'Merge the winner',
      position: at(5),
      config: { baseBranch: 'main', resolveConflicts: true, resolverPrompt: '' }
    },
    {
      id: 'verify',
      kind: 'gate',
      label: 'Tests on the merge',
      position: at(6),
      config: { check: 'command', command: 'npm test', instructions: '', agentPrompt: '', agentModel: 'default', agentTools: [] }
    },
    {
      id: 'land',
      kind: 'land',
      label: 'Land it',
      position: at(7),
      config: { baseBranch: 'main' }
    }
  ],
  edges: [
    edge('start', 'spread', 'control'),
    edge('spread', 'contender'),
    edge('contender', 'tests', 'branch'),
    edge('tests', 'pick', 'verdict', 'pass'),
    edge('tests', 'contender', 'verdict', 'fail'),
    edge('pick', 'merge', 'branch'),
    edge('merge', 'verify', 'branch'),
    edge('verify', 'land', 'branch', 'pass')
  ]
}

/** Where the Floor's Autopilot switch reads and writes a project's plan. A
 *  flow's own `plan` input can point anywhere - this is only the default a
 *  fresh switch offers to create. */
export const PLAN_FILE = 'PLAN.md'

/** Brief for the builder: work the plan one item at a time, in whatever order
 *  makes sense, never all at once - each item becomes its own gated, landed
 *  branch before the next is even chosen. */
const AUTOPILOT_BUILD_PROMPT = [
  'Read the plan at {{plan}}. Look at the current state of the repository',
  '(recent commits, existing files) to see what has already been done.',
  '',
  'Implement the SINGLE next unfinished item from the plan - the smallest',
  'coherent piece of work you can land on its own. Do not try to do',
  'everything at once; a later pass will come back for the rest.',
  '',
  'When you are done, reply with a short summary of what you implemented and',
  'which item of the plan it corresponds to.'
].join('\n')

/** Brief for the loop's own stopping condition: an honest, structured yes/no
 *  the retry loop already built for gates is driven by. */
const AUTOPILOT_CHECK_PROMPT = [
  'Read the plan at {{plan}} and compare it against the current state of the',
  'repository (recent commits, existing files, what the builder just said:',
  '{{build.result}}).',
  '',
  'Has EVERY item in the plan now been fully implemented and landed? Do not',
  'guess - look. Reply with JSON: {"done": boolean, "reason": "one or two',
  'sentences saying what, if anything, is still missing"}.'
].join('\n')

const AUTOPILOT: Blueprint = {
  schemaVersion: SCHEMA_VERSION,
  name: 'Autopilot',
  description:
    'Works a plan one item at a time - build, test, merge, land - then asks an agent if the plan is fully done yet, and loops back if not. The loop cap (a retry cap on the last gate) is the safety net.',
  version: 1,
  defaultBudget: { maxUsd: 1 },
  inputs: [{ name: 'plan', label: `Plan file (a path in the repo, e.g. ${PLAN_FILE})`, required: true }],
  nodes: [
    trigger(),
    agent('build', 'Builder', AUTOPILOT_BUILD_PROMPT, 1, { worktree: true, edit: true, maxTokens: 600_000, maxUsd: 1 }),
    {
      id: 'tests', kind: 'gate', label: 'Tests pass', position: at(2), budget: { maxRetries: 3 },
      config: { check: 'command', command: 'npm test', instructions: '', agentPrompt: '', agentModel: 'default', agentTools: [] }
    },
    { id: 'merge', kind: 'merge', label: 'Merge into main', position: at(3), budget: { maxUsd: 1 }, config: { baseBranch: 'main', resolveConflicts: true, resolverPrompt: RESOLVER_PROMPT } },
    { id: 'land', kind: 'land', label: 'Land on main', position: at(4), config: { baseBranch: 'main' } },
    {
      // The loop primitive: this gate's `fail` edge is "not done yet, go
      // around again"; its retry cap is the run's hard stop regardless of
      // what the agent decides, so a confused judge can never run forever.
      id: 'plancheck', kind: 'gate', label: 'Plan fully done?', position: at(5), budget: { maxRetries: 8, maxUsd: 0.3 },
      config: { check: 'agent', command: '', instructions: '', agentPrompt: AUTOPILOT_CHECK_PROMPT, agentModel: 'default', agentTools: [] }
    }
  ],
  edges: [
    edge('start', 'build', 'control'),
    edge('build', 'tests', 'branch'),
    edge('tests', 'merge', 'verdict', 'pass'),
    edge('tests', 'build', 'verdict', 'fail'),
    edge('merge', 'land', 'branch'),
    edge('land', 'plancheck', 'branch'),
    edge('plancheck', 'build', 'verdict', 'fail')
  ]
}

export const PATTERNS: readonly Blueprint[] = [SUPERVISOR, LAND_PATTERN, PIPELINE, TOURNAMENT, AUTOPILOT]

export const PLAN_FLOW = '__plan__'

/**
 * A one-agent flow that turns a rough idea into a detailed plan and saves it
 * into the repository, so the Floor's Autopilot switch has something to
 * point at. Writes directly to the live checkout (no worktree) - the same
 * choice Supervisor already makes for an agent that is meant to touch the
 * project broadly, and here the "broad" touch is exactly one new file.
 */
/** Where a generated project's fuller planning docs live - the same two-tier
 *  shape this project's own docs use (a narrative overview and a focused
 *  design doc), under a generically-named folder since "PLATFORM_PLAN" and
 *  "FLOOR_DESIGN" are this project's own names, not a convention every
 *  project should share. */
export const PLANNING_DIR = 'planning'
export const OVERVIEW_FILE = `${PLANNING_DIR}/OVERVIEW.md`
export const DESIGN_FILE = `${PLANNING_DIR}/DESIGN.md`

export function buildPlanBlueprint(): Blueprint {
  const prompt = [
    `First, check whether ${PLANNING_DIR}/ already holds real planning documents`,
    `(Glob for ${PLANNING_DIR}/*.md and read what is there). If it does, read them`,
    `and write ${PLAN_FILE} as a distilled, actionable summary of what they already`,
    "say - do not overwrite or contradict them, and do not invent a new idea when",
    'one is already recorded.',
    '',
    `Otherwise, this is a new project with nothing written down yet. From the idea`,
    'below, create THREE files:',
    '',
    `1. ${OVERVIEW_FILE} - the fuller plan: what the idea is, its goals, and a`,
    '   phased roadmap. This is the record of *why*, for a person to read.',
    `2. ${DESIGN_FILE} - a more detailed design for the core mechanism: how the`,
    '   main pieces fit together, the key decisions and trade-offs, and honest',
    '   open questions. Keep it proportional to the idea - a small idea gets a',
    '   short design doc, not padding. Skip this file only if the idea is truly',
    '   too small to have a "design" (e.g. a single script).',
    `3. ${PLAN_FILE} in the repository root (using the Write tool; this is the`,
    '   file that gets worked from, one item at a time) - a numbered list of',
    '   concrete, independently implementable and testable items, each small',
    '   enough that a single agent could build, test and land it in one pass.',
    '   Order them so earlier items unblock later ones. Be specific: name real',
    '   files, commands and behaviour where you can, not vague goals. Link back',
    `   to ${OVERVIEW_FILE} (and ${DESIGN_FILE} if you wrote one) for the`,
    '   reasoning, the way this rule you are following right now does.',
    '',
    "If the idea is ambiguous, write down the assumption you made in the",
    'overview rather than leaving it open.',
    '',
    'The idea:',
    '{{idea}}',
    '',
    'When you are done, reply with a one-line confirmation of which files you wrote.'
  ].join('\n')
  return {
    schemaVersion: SCHEMA_VERSION,
    name: 'Write a plan',
    description: `Expands an idea into a plan (or summarises one that already exists) and saves it to ${PLAN_FILE}.`,
    version: 1,
    defaultBudget: { maxUsd: 2 },
    inputs: [{ name: 'idea', label: 'The idea', required: true }],
    nodes: [trigger(), agent('write', 'Planner', prompt, 1, { edit: true, maxTokens: 600_000, maxUsd: 2 })],
    edges: [edge('start', 'write', 'control')]
  }
}


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

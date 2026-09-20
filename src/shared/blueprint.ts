// Pure blueprint logic: validation, templating, the design-time budget
// ceiling. No Node, Electron or zod imports, so the editor (renderer), the
// file store (main) and the tests all share the exact same rules.
import type { Blueprint, BlueprintNode, NodeKind } from './schema'

/** Bump when the file format changes incompatibly, and add a migration. */
export const SCHEMA_VERSION = 1

export interface Problem {
  severity: 'error' | 'warning'
  message: string
  nodeId?: string
}

/** Placeholders the engine fills in itself, in addition to declared inputs. */
export const BUILTIN_VARS = ['upstream', 'item', 'branch', 'branches', 'baseBranch'] as const

/** `{{name}}` or a reference into another node, `{{node-id.result}}`. */
const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g

/** What a node exposes to later prompts. `output.<path>` reads a field of its
 *  schema-validated output. */
export const NODE_REF_FIELDS = ['result', 'branch', 'cost'] as const

export function templateVars(template: string): string[] {
  return [...new Set([...template.matchAll(VAR_RE)].map((m) => m[1]))]
}

/** Replaces `{{name}}`. Unknown names are left in place so a mistake is
 *  visible in the prompt instead of silently becoming an empty string. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(VAR_RE, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : whole
  )
}

/** A gate's "fail" edge is the one legitimate way to loop (retry / repair). */
function isRetryEdge(bp: Blueprint, edge: Blueprint['edges'][number]): boolean {
  const from = bp.nodes.find((n) => n.id === edge.from)
  return from?.kind === 'gate' && edge.condition === 'fail'
}

function forwardAdjacency(bp: Blueprint): Map<string, string[]> {
  const adj = new Map<string, string[]>(bp.nodes.map((n) => [n.id, []]))
  for (const e of bp.edges) {
    if (isRetryEdge(bp, e)) continue
    adj.get(e.from)?.push(e.to)
  }
  return adj
}

function reachableFrom(starts: string[], adj: Map<string, string[]>): Set<string> {
  const seen = new Set<string>()
  const stack = [...starts]
  while (stack.length) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    for (const next of adj.get(id) ?? []) stack.push(next)
  }
  return seen
}

function hasCycle(bp: Blueprint): string | null {
  const adj = forwardAdjacency(bp)
  const state = new Map<string, 1 | 2>()
  let culprit: string | null = null
  const visit = (id: string): boolean => {
    state.set(id, 1)
    for (const next of adj.get(id) ?? []) {
      const s = state.get(next)
      if (s === 1) {
        culprit = next
        return true
      }
      if (!s && visit(next)) return true
    }
    state.set(id, 2)
    return false
  }
  for (const n of bp.nodes) if (!state.has(n.id) && visit(n.id)) return culprit
  return null
}

const nameOf = (n: BlueprintNode): string => n.label || n.kind

/** Everything wrong (or suspicious) about a blueprint. Errors block a run;
 *  warnings don't. This is what the editor's Problems panel lists. */
export function validateBlueprint(bp: Blueprint): Problem[] {
  const problems: Problem[] = []
  const add = (severity: Problem['severity'], message: string, nodeId?: string): void => {
    problems.push({ severity, message, nodeId })
  }

  const ids = new Set<string>()
  for (const n of bp.nodes) {
    if (ids.has(n.id)) add('error', `Two nodes share the id "${n.id}".`, n.id)
    ids.add(n.id)
  }

  const edgeIds = new Set<string>()
  for (const e of bp.edges) {
    if (edgeIds.has(e.id)) add('error', `Two edges share the id "${e.id}".`)
    edgeIds.add(e.id)
    if (!ids.has(e.from) || !ids.has(e.to)) add('error', `An edge points at a node that does not exist.`)
    if (e.from === e.to) add('error', 'A node cannot connect to itself.', e.from)
  }

  const nodesOfKind = (k: NodeKind): BlueprintNode[] => bp.nodes.filter((n) => n.kind === k)
  const incoming = (id: string): Blueprint['edges'] => bp.edges.filter((e) => e.to === id)
  const outgoing = (id: string): Blueprint['edges'] => bp.edges.filter((e) => e.from === id)

  const triggers = nodesOfKind('trigger')
  if (triggers.length === 0) add('error', 'A flow needs a Trigger to start from.')
  for (const t of triggers) {
    if (incoming(t.id).length) add('error', 'A Trigger cannot have incoming edges.', t.id)
    if (!outgoing(t.id).length) add('warning', 'This Trigger is not connected to anything.', t.id)
  }

  const cycleAt = hasCycle(bp)
  if (cycleAt) {
    const node = bp.nodes.find((n) => n.id === cycleAt)
    add(
      'error',
      `There is a loop through "${node ? nameOf(node) : cycleAt}". Loops are only allowed as a Gate's fail → retry edge.`,
      cycleAt
    )
  }

  const adj = forwardAdjacency(bp)
  // Follow retry edges too: a repair node is reachable via a gate's fail edge.
  const fullAdj = new Map<string, string[]>(bp.nodes.map((n) => [n.id, []]))
  for (const e of bp.edges) fullAdj.get(e.from)?.push(e.to)
  const reachFull = reachableFrom(
    triggers.map((t) => t.id),
    fullAdj
  )
  if (triggers.length) {
    for (const n of bp.nodes) {
      if (n.kind !== 'trigger' && !reachFull.has(n.id)) {
        add('error', `"${nameOf(n)}" can never run - nothing leads to it from a Trigger.`, n.id)
      }
    }
  }

  const declared = new Set<string>([...bp.inputs.map((i) => i.name), ...BUILTIN_VARS])
  const isNodeRef = (v: string): boolean => {
    const dot = v.indexOf('.')
    if (dot < 0) return false
    const field = v.slice(dot + 1)
    return (
      ids.has(v.slice(0, dot)) &&
      ((NODE_REF_FIELDS as readonly string[]).includes(field) || field.startsWith('output.'))
    )
  }
  const flowHasBudget = Boolean(bp.defaultBudget.maxTokens)

  for (const n of bp.nodes) {
    switch (n.kind) {
      case 'agent': {
        if (!n.config.prompt.trim()) add('error', `"${nameOf(n)}" has no prompt.`, n.id)
        for (const v of templateVars(n.config.prompt)) {
          if (!declared.has(v) && !isNodeRef(v)) {
            add(
              'warning',
              `"${nameOf(n)}" uses {{${v}}}, which is not a flow input or a node's result/branch/cost.`,
              n.id
            )
          }
        }
        if (n.config.outputSchema.trim()) {
          try {
            JSON.parse(n.config.outputSchema)
          } catch {
            add('error', `"${nameOf(n)}" has an output schema that is not valid JSON.`, n.id)
          }
        }
        if (n.config.access === 'edit' && !n.config.worktree) {
          add('warning', `"${nameOf(n)}" can edit files but has no worktree, so it changes your live checkout.`, n.id)
        }
        if (!incoming(n.id).length && n.kind === 'agent' && triggers.length) {
          add('error', `"${nameOf(n)}" has no incoming edge.`, n.id)
        }
        if (!n.budget?.maxUsd && !bp.defaultBudget.maxUsd && !n.budget?.maxTokens && !flowHasBudget) {
          add('warning', `"${nameOf(n)}" has no budget, and the flow has no default.`, n.id)
        }
        break
      }
      case 'fanout': {
        if (!nodesOfKind('join').some((j) => reachableFrom([n.id], adj).has(j.id))) {
          add('error', `Fan-out "${nameOf(n)}" never reaches a Join.`, n.id)
        }
        if (outgoing(n.id).length === 0) add('error', `Fan-out "${nameOf(n)}" has nothing to fan out to.`, n.id)
        break
      }
      case 'join': {
        if (incoming(n.id).length < 1) add('error', `Join "${nameOf(n)}" has no incoming edge.`, n.id)
        if (n.config.strategy === 'quorum' && n.config.quorum < 1) {
          add('error', `Join "${nameOf(n)}" needs a quorum of at least 1.`, n.id)
        }
        break
      }
      case 'gate': {
        if (n.config.check === 'command' && !n.config.command.trim()) {
          add('error', `Gate "${nameOf(n)}" has no command to run.`, n.id)
        }
        const outs = outgoing(n.id)
        if (!outs.some((e) => e.condition !== 'fail')) {
          add('warning', `Gate "${nameOf(n)}" has no edge to follow when it passes.`, n.id)
        }
        if (outs.some((e) => e.condition === 'fail') && !n.budget?.maxRetries) {
          add('error', `Gate "${nameOf(n)}" loops back on failure but has no retry cap.`, n.id)
        }
        break
      }
      case 'merge': {
        if (!n.config.baseBranch.trim()) add('error', `Merge "${nameOf(n)}" has no base branch.`, n.id)
        if (!incoming(n.id).length && triggers.length) {
          add('error', `Merge "${nameOf(n)}" has no incoming edge.`, n.id)
        }
        break
      }
      case 'trigger':
        break
    }
  }

  // Parallel writers sharing one working tree overwrite each other.
  for (const f of nodesOfKind('fanout')) {
    const inside = reachableFrom(
      adj.get(f.id) ?? [],
      new Map([...adj].map(([k, v]) => [k, nodesOfKind('join').some((j) => j.id === k) ? [] : v]))
    )
    for (const id of inside) {
      const n = bp.nodes.find((x) => x.id === id)
      if (n?.kind === 'agent' && !n.config.worktree) {
        add(
          'warning',
          `"${nameOf(n)}" runs in parallel but not in its own worktree - copies will overwrite each other.`,
          n.id
        )
      }
    }
  }

  return problems
}

export const hasErrors = (problems: Problem[]): boolean => problems.some((p) => p.severity === 'error')

/** How many times each node may execute in the worst case: fan-out
 *  interiors multiply by their copy count, a gate's retry loop multiplies the
 *  nodes it loops back over by (1 + retries). */
function executionMultipliers(bp: Blueprint): Map<string, number> {
  const adj = forwardAdjacency(bp)
  const joins = new Set(bp.nodes.filter((n) => n.kind === 'join').map((n) => n.id))
  const multiplier = new Map<string, number>(bp.nodes.map((n) => [n.id, 1]))

  for (const f of bp.nodes) {
    if (f.kind !== 'fanout') continue
    const stop = new Map([...adj].map(([k, v]) => [k, joins.has(k) ? [] : v]))
    for (const id of reachableFrom(adj.get(f.id) ?? [], stop)) {
      if (!joins.has(id)) multiplier.set(id, (multiplier.get(id) ?? 1) * f.config.count)
    }
  }

  for (const e of bp.edges) {
    const gate = bp.nodes.find((n) => n.id === e.from)
    if (gate?.kind !== 'gate' || e.condition !== 'fail') continue
    const retries = gate.budget?.maxRetries ?? 0
    // The loop body: everything from the repair target that can still reach
    // the gate (the gate included). Only those re-run on a retry.
    for (const id of reachableFrom([e.to], adj)) {
      if (reachableFrom([id], adj).has(gate.id)) {
        multiplier.set(id, (multiplier.get(id) ?? 1) * (1 + retries))
      }
    }
  }
  return multiplier
}

function ceiling(bp: Blueprint, capOf: (n: BlueprintNode) => number | undefined): number | null {
  const multiplier = executionMultipliers(bp)
  let total = 0
  for (const n of bp.nodes) {
    if (n.kind !== 'agent') continue
    const cap = capOf(n)
    if (!cap) return null
    total += cap * (multiplier.get(n.id) ?? 1)
  }
  return total
}

/**
 * Worst-case token ceiling from the budgets on the page, or `null` when some
 * agent has no bound at all (which is itself the finding: an unbounded flow
 * has no ceiling).
 *
 * This is a ceiling built from limits the user set, not a prediction of what
 * the flow will actually use. Real estimates need run history (Phase 4).
 */
export function budgetCeiling(bp: Blueprint): number | null {
  return ceiling(bp, (n) => n.budget?.maxTokens ?? bp.defaultBudget.maxTokens)
}

/** The dollar equivalent, and the number a run is actually held to. */
export function usdCeiling(bp: Blueprint): number | null {
  return ceiling(bp, (n) => n.budget?.maxUsd ?? bp.defaultBudget.maxUsd)
}

/**
 * Why this blueprint cannot be executed by the engine today. Design and run
 * are deliberately separate: a flow may be valid to draw before it is
 * runnable. Empty means runnable.
 */
export function unrunnableReasons(bp: Blueprint): string[] {
  const reasons: string[] = []
  if (hasErrors(validateBlueprint(bp))) reasons.push('Fix the errors in the Problems panel first.')

  const unsupported = new Set(
    bp.nodes.filter((n) => n.kind === 'fanout' || n.kind === 'join' || n.kind === 'merge').map((n) => n.kind)
  )
  for (const kind of unsupported) {
    reasons.push(`The run engine cannot execute ${kind} nodes yet (parallel and merge steps are the next phase).`)
  }

  // A run is a walk along a chain: each node continues to at most one next
  // node, apart from a gate's separate pass and fail edges.
  for (const n of bp.nodes) {
    const forward = bp.edges.filter((e) => e.from === n.id && !(n.kind === 'gate' && e.condition === 'fail'))
    if (forward.length > 1) {
      reasons.push(`"${nameOf(n)}" continues to ${forward.length} nodes; only single-path flows can run for now.`)
    }
  }

  const trigger = bp.nodes.find((n) => n.kind === 'trigger')
  if (trigger && !bp.edges.some((e) => e.from === trigger.id)) {
    reasons.push('The Trigger is not connected to anything, so there is nothing to run.')
  }

  if (usdCeiling(bp) === null) {
    reasons.push('Every agent needs a dollar limit (or set a flow default) so the run has a hard spending ceiling.')
  }
  return reasons
}

let counter = 0
/** Short, collision-resistant within a flow, stable enough to read in a diff. */
export function newId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  let id: string
  do id = `${prefix}-${(++counter).toString(36)}${Math.random().toString(36).slice(2, 5)}`
  while (used.has(id))
  return id
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'flow'
  )
}

export const NODE_KINDS: readonly { kind: NodeKind; title: string; blurb: string }[] = [
  { kind: 'trigger', title: 'Trigger', blurb: 'Where a run starts' },
  { kind: 'agent', title: 'Agent', blurb: 'One Claude Code session' },
  { kind: 'fanout', title: 'Fan-out', blurb: 'Run N copies in parallel' },
  { kind: 'join', title: 'Join', blurb: 'Collect the parallel results' },
  { kind: 'gate', title: 'Gate', blurb: 'Block until a check passes' },
  { kind: 'merge', title: 'Merge', blurb: 'Land branches on the base' }
]

/** A new node with sensible defaults, ready to drop on the canvas. */
export function makeNode(kind: NodeKind, id: string, position: { x: number; y: number }): BlueprintNode {
  const base = { id, position }
  switch (kind) {
    case 'trigger':
      return { ...base, kind, label: 'Start', config: { type: 'manual' } }
    case 'agent':
      return {
        ...base,
        kind,
        label: 'Agent',
        config: {
          role: 'Agent',
          model: 'default',
          prompt: '',
          worktree: false,
          access: 'read',
          tools: [],
          outputSchema: ''
        }
      }
    case 'fanout':
      return { ...base, kind, label: 'Fan-out', config: { count: 3 } }
    case 'join':
      return { ...base, kind, label: 'Join', config: { strategy: 'all', quorum: 2 } }
    case 'gate':
      return {
        ...base,
        kind,
        label: 'Gate',
        budget: { maxRetries: 3 },
        config: { check: 'command', command: '', instructions: '' }
      }
    case 'merge':
      return {
        ...base,
        kind,
        label: 'Merge',
        config: { baseBranch: 'main', resolveConflicts: true, resolverPrompt: '' }
      }
  }
}

/**
 * Nodes grouped into columns by how far they are from the Trigger along
 * forward edges (a gate's retry edge does not count). Used to draw a compact
 * left-to-right stepper of a flow; anything unreachable goes in a last column.
 */
export function flowLevels(bp: Blueprint): BlueprintNode[][] {
  const adj = forwardAdjacency(bp)
  const level = new Map<string, number>()
  const queue = bp.nodes.filter((n) => n.kind === 'trigger').map((n) => n.id)
  for (const id of queue) level.set(id, 0)
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]
    for (const next of adj.get(id) ?? []) {
      if (!level.has(next)) {
        level.set(next, level.get(id)! + 1)
        queue.push(next)
      }
    }
  }
  const columns: BlueprintNode[][] = []
  const stray: BlueprintNode[] = []
  for (const n of bp.nodes) {
    const l = level.get(n.id)
    if (l === undefined) stray.push(n)
    else (columns[l] ??= []).push(n)
  }
  const out = columns.filter(Boolean).map((c) => c.sort((a, b) => a.position.y - b.position.y))
  if (stray.length) out.push(stray)
  return out
}

export interface RunSummary {
  agents: { label: string; model: string; edits: boolean; ownBranch: boolean; tools: string[] }[]
  commands: { label: string; command: string }[]
  humanGates: string[]
  ceilingUsd: number | null
}

/** What pressing Run would actually do, in plain terms. A blueprint is code
 *  that spends money and changes repos, so this is shown before it starts. */
export function summarizeRun(bp: Blueprint): RunSummary {
  const summary: RunSummary = { agents: [], commands: [], humanGates: [], ceilingUsd: usdCeiling(bp) }
  for (const n of bp.nodes) {
    if (n.kind === 'agent') {
      summary.agents.push({
        label: n.label || n.config.role,
        model: n.config.model,
        edits: n.config.access === 'edit',
        ownBranch: n.config.worktree,
        tools: n.config.tools
      })
    } else if (n.kind === 'gate') {
      if (n.config.check === 'command') summary.commands.push({ label: n.label || 'Gate', command: n.config.command })
      else summary.humanGates.push(n.label || 'Gate')
    }
  }
  return summary
}

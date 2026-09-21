// The run model. A run is an append-only list of events; everything the UI
// shows is a pure fold of that list. Keeping it pure means the main process
// (which persists and emits events), the Floor and the editor all agree on
// what a run "is", and a run can be rebuilt from its file after a restart.
import type { Blueprint } from './schema'

export type RunStatus = 'running' | 'awaiting' | 'passed' | 'failed' | 'budget' | 'cancelled' | 'interrupted'
export type NodeState = 'idle' | 'running' | 'awaiting' | 'passed' | 'failed'

interface Base {
  at: number
  runId: string
}

export type RunEvent =
  | (Base & {
      type: 'run.started'
      projectId: string
      projectName: string
      projectPath: string
      flowSlug: string
      blueprint: Blueprint
      inputs: Record<string, string>
      ceilingUsd: number
    })
  | (Base & {
      type: 'node.started'
      nodeId: string
      attempt: number
      cwd: string
      branch?: string
      sessionId?: string
    })
  | (Base & {
      type: 'node.finished'
      nodeId: string
      attempt: number
      status: 'passed' | 'failed'
      costUsd: number
      tokens: number
      summary: string
      error?: string
      branch?: string
    })
  | (Base & { type: 'gate.awaiting'; nodeId: string; attempt: number; instructions: string })
  | (Base & {
      type: 'gate.result'
      nodeId: string
      attempt: number
      pass: boolean
      by: 'command' | 'human'
      detail: string
    })
  | (Base & { type: 'run.finished'; status: Exclude<RunStatus, 'running' | 'awaiting'>; reason: string; branch?: string })
  /** An interrupted run picked up again. Reopens the run; spend carries over. */
  | (Base & { type: 'run.resumed' })

export interface StepRecord {
  nodeId: string
  attempt: number
  state: NodeState
  startedAt: number
  endedAt?: number
  costUsd: number
  tokens: number
  /** Agent's final text, or a gate's output tail / a reviewer's note. */
  detail: string
  branch?: string
}

export interface NodeRun {
  state: NodeState
  attempts: number
  costUsd: number
  tokens: number
  detail: string
  branch?: string
  sessionId?: string
}

export interface RunView {
  runId: string
  projectId: string
  projectName: string
  projectPath: string
  flowSlug: string
  blueprint: Blueprint
  inputs: Record<string, string>
  status: RunStatus
  reason: string
  startedAt: number
  endedAt?: number
  spentUsd: number
  ceilingUsd: number
  tokens: number
  /** The branch this run produced, if any (last worktree agent's). */
  branch?: string
  currentNodeId?: string
  nodes: Record<string, NodeRun>
  steps: StepRecord[]
}

export const isActive = (s: RunStatus): boolean => s === 'running' || s === 'awaiting'

export function foldRun(events: readonly RunEvent[]): RunView | null {
  const first = events.find((e) => e.type === 'run.started')
  if (!first || first.type !== 'run.started') return null

  const view: RunView = {
    runId: first.runId,
    projectId: first.projectId,
    projectName: first.projectName,
    projectPath: first.projectPath,
    flowSlug: first.flowSlug,
    blueprint: first.blueprint,
    inputs: first.inputs,
    status: 'running',
    reason: '',
    startedAt: first.at,
    spentUsd: 0,
    ceilingUsd: first.ceilingUsd,
    tokens: 0,
    nodes: Object.fromEntries(
      first.blueprint.nodes.map((n) => [n.id, { state: 'idle', attempts: 0, costUsd: 0, tokens: 0, detail: '' } as NodeRun])
    ),
    steps: []
  }

  const stepFor = (nodeId: string, attempt: number): StepRecord | undefined =>
    view.steps.find((s) => s.nodeId === nodeId && s.attempt === attempt)

  for (const e of events) {
    switch (e.type) {
      case 'node.started': {
        const n = view.nodes[e.nodeId]
        if (!n) break
        n.state = 'running'
        n.attempts = Math.max(n.attempts, e.attempt)
        if (e.sessionId) n.sessionId = e.sessionId
        if (e.branch) n.branch = e.branch
        view.currentNodeId = e.nodeId
        view.status = 'running'
        view.steps.push({ nodeId: e.nodeId, attempt: e.attempt, state: 'running', startedAt: e.at, costUsd: 0, tokens: 0, detail: '', branch: e.branch })
        break
      }
      case 'node.finished': {
        const n = view.nodes[e.nodeId]
        if (!n) break
        n.state = e.status
        n.costUsd += e.costUsd
        n.tokens += e.tokens
        n.detail = e.error ?? e.summary
        if (e.branch) {
          n.branch = e.branch
          view.branch = e.branch
        }
        view.spentUsd += e.costUsd
        view.tokens += e.tokens
        const step = stepFor(e.nodeId, e.attempt)
        if (step) Object.assign(step, { state: e.status, endedAt: e.at, costUsd: e.costUsd, tokens: e.tokens, detail: e.error ?? e.summary, branch: e.branch ?? step.branch })
        break
      }
      case 'gate.awaiting': {
        const n = view.nodes[e.nodeId]
        if (!n) break
        n.state = 'awaiting'
        n.attempts = Math.max(n.attempts, e.attempt)
        n.detail = e.instructions
        view.currentNodeId = e.nodeId
        view.status = 'awaiting'
        const open = stepFor(e.nodeId, e.attempt)
        if (open) Object.assign(open, { state: 'awaiting', detail: e.instructions })
        else view.steps.push({ nodeId: e.nodeId, attempt: e.attempt, state: 'awaiting', startedAt: e.at, costUsd: 0, tokens: 0, detail: e.instructions })
        break
      }
      case 'gate.result': {
        const n = view.nodes[e.nodeId]
        if (!n) break
        n.state = e.pass ? 'passed' : 'failed'
        n.attempts = Math.max(n.attempts, e.attempt)
        n.detail = e.detail
        view.currentNodeId = e.nodeId
        if (view.status === 'awaiting') view.status = 'running'
        const step = stepFor(e.nodeId, e.attempt)
        if (step) Object.assign(step, { state: n.state, endedAt: e.at, detail: e.detail })
        else view.steps.push({ nodeId: e.nodeId, attempt: e.attempt, state: n.state, startedAt: e.at, endedAt: e.at, costUsd: 0, tokens: 0, detail: e.detail })
        break
      }
      case 'run.finished':
        view.status = e.status
        view.reason = e.reason
        view.endedAt = e.at
        if (e.branch) view.branch = e.branch
        view.currentNodeId = undefined
        // Anything still marked running never finished.
        for (const n of Object.values(view.nodes)) if (n.state === 'running' || n.state === 'awaiting') n.state = 'failed'
        for (const s of view.steps) if (s.state === 'running' || s.state === 'awaiting') { s.state = 'failed'; s.endedAt = e.at }
        break
      case 'run.resumed':
        view.status = 'running'
        view.reason = ''
        view.endedAt = undefined
        break
      case 'run.started':
        break
    }
  }
  return view
}

/** Only an interrupted run can be resumed: a failed or budget-stopped one
 *  would fail again the same way, and a cancelled one was the user's choice. */
export const isResumable = (s: RunStatus): boolean => s === 'interrupted'

/** Values later prompts can reference, built from what has run so far. */
export function promptVars(
  view: Pick<RunView, 'inputs' | 'nodes' | 'blueprint'>,
  upstream: string,
  extra: Record<string, string> = {}
): Record<string, string> {
  const vars: Record<string, string> = { ...view.inputs, upstream, ...extra }
  for (const n of view.blueprint.nodes) {
    const run = view.nodes[n.id]
    if (!run) continue
    vars[`${n.id}.result`] = run.detail
    vars[`${n.id}.branch`] = run.branch ?? ''
    vars[`${n.id}.cost`] = run.costUsd.toFixed(4)
    // A node with an output schema leaves JSON behind; expose its fields as
    // {{node.output.path.to.field}} so a later prompt can use one directly.
    if (n.kind === 'agent' && n.config.outputSchema.trim()) {
      try {
        flatten(JSON.parse(run.detail), `${n.id}.output`, vars)
      } catch {
        /* not JSON (the step failed or had no structured output): leave unresolved */
      }
    }
  }
  return vars
}

function flatten(value: unknown, prefix: string, into: Record<string, string>, depth = 0): void {
  if (value === null || value === undefined) return
  if (typeof value !== 'object') {
    into[prefix] = String(value)
    return
  }
  // Arrays and objects are available whole as JSON, and by path below.
  into[prefix] = JSON.stringify(value)
  if (depth >= 4) return
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) flatten(v, `${prefix}.${k}`, into, depth + 1)
}

/** Money in the UI: cents matter at these magnitudes. */
export function formatUsd(n: number): string {
  if (n === 0) return '$0'
  if (n < 0.01) return '<$0.01'
  return n < 10 ? `$${n.toFixed(2)}` : `$${n.toFixed(0)}`
}

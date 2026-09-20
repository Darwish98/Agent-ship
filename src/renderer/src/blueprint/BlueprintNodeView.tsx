import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { JSX } from 'react'
import type { NodeRun } from '../../../shared/runs'
import type { BlueprintNode } from '../../../shared/schema'

export interface BpNodeData extends Record<string, unknown> {
  node: BlueprintNode
  errors: number
  warnings: number
  /** Present while or after a run: lights the node. */
  run?: NodeRun
}

const ICON: Record<BlueprintNode['kind'], string> = {
  trigger: '▶',
  agent: '◉',
  fanout: '⑂',
  join: '⑃',
  gate: '◇',
  merge: '⤳',
  land: '⚑'
}

const TITLE: Record<BlueprintNode['kind'], string> = {
  trigger: 'Trigger',
  agent: 'Agent',
  fanout: 'Fan-out',
  join: 'Join',
  gate: 'Gate',
  merge: 'Merge',
  land: 'Land'
}

function summary(n: BlueprintNode): string {
  switch (n.kind) {
    case 'trigger':
      return 'manual'
    case 'agent':
      return `${n.config.access === 'edit' ? 'edits' : 'read-only'}${n.config.worktree ? ' · own branch' : ''}${n.config.model !== 'default' ? ` · ${n.config.model}` : ''}`
    case 'fanout':
      return `× ${n.config.count} in parallel`
    case 'join':
      return `wait for ${n.config.strategy}`
    case 'gate':
      return n.config.check === 'human' ? 'human approval' : n.config.command || 'no command yet'
    case 'merge':
      return `into ${n.config.baseBranch}${n.config.resolveConflicts ? ' · agent on conflict' : ''}`
    case 'land':
      return `advances ${n.config.baseBranch}`
  }
}

export function BlueprintNodeView({ data, selected }: NodeProps): JSX.Element {
  const { node, errors, warnings, run } = data as BpNodeData
  const tokens = node.budget?.maxTokens

  return (
    <div className={`bp-node bp-${node.kind}${selected ? ' bp-selected' : ''}${run && run.state !== 'idle' ? ` bp-run-${run.state}` : ''}`}>
      {node.kind !== 'trigger' && <Handle type="target" position={Position.Left} className="bp-handle" />}
      {/* A gate's fail edge returns to an earlier node along the bottom, instead
          of doubling back across the forward edges. */}
      {node.kind !== 'trigger' && <Handle type="target" position={Position.Bottom} id="retry" className="bp-handle bp-handle-retry" />}

      <div className="bp-head">
        <span className="bp-icon" aria-hidden>
          {ICON[node.kind]}
        </span>
        <span className="bp-kind">{TITLE[node.kind]}</span>
        {errors > 0 && (
          <span className="bp-dot bp-dot-err" title={`${errors} error(s)`}>
            {errors}
          </span>
        )}
        {errors === 0 && warnings > 0 && (
          <span className="bp-dot bp-dot-warn" title={`${warnings} warning(s)`}>
            {warnings}
          </span>
        )}
      </div>
      <div className="bp-title">{node.label || TITLE[node.kind]}</div>
      <div className="bp-sub">{summary(node)}</div>
      {run && run.state !== 'idle' && (
        <div className="bp-runline">
          {run.state}
          {run.attempts > 1 ? ` · attempt ${run.attempts}` : ''}
          {run.costUsd > 0 ? ` · $${run.costUsd.toFixed(2)}` : ''}
        </div>
      )}
      {(tokens || node.budget?.maxUsd || node.budget?.maxRetries) && (
        <div className="bp-chips">
          {node.budget?.maxUsd ? <span className="bp-chip">≤ ${node.budget.maxUsd}</span> : null}
          {tokens ? <span className="bp-chip">≤ {Math.round(tokens / 1000)}k tokens</span> : null}
          {node.budget?.maxRetries ? <span className="bp-chip">{node.budget.maxRetries} retries</span> : null}
        </div>
      )}

      <Handle type="source" position={Position.Right} className="bp-handle" />
      {node.kind === 'gate' && <Handle type="source" position={Position.Bottom} id="fail" className="bp-handle bp-handle-retry" />}
    </div>
  )
}

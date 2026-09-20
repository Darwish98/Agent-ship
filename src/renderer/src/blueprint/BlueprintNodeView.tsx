import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { JSX } from 'react'
import type { BlueprintNode } from '../../../shared/schema'

export interface BpNodeData extends Record<string, unknown> {
  node: BlueprintNode
  errors: number
  warnings: number
}

const ICON: Record<BlueprintNode['kind'], string> = {
  trigger: '▶',
  agent: '◉',
  fanout: '⑂',
  join: '⑃',
  gate: '◇',
  merge: '⤳'
}

const TITLE: Record<BlueprintNode['kind'], string> = {
  trigger: 'Trigger',
  agent: 'Agent',
  fanout: 'Fan-out',
  join: 'Join',
  gate: 'Gate',
  merge: 'Merge'
}

function summary(n: BlueprintNode): string {
  switch (n.kind) {
    case 'trigger':
      return 'manual'
    case 'agent':
      return `${n.config.model}${n.config.worktree ? ' · own branch' : ''}`
    case 'fanout':
      return `× ${n.config.count} in parallel`
    case 'join':
      return `wait for ${n.config.strategy}`
    case 'gate':
      return n.config.check === 'human' ? 'human approval' : n.config.command || 'no command yet'
    case 'merge':
      return `into ${n.config.baseBranch}`
  }
}

export function BlueprintNodeView({ data, selected }: NodeProps): JSX.Element {
  const { node, errors, warnings } = data as BpNodeData
  const tokens = node.budget?.maxTokens

  return (
    <div className={`bp-node bp-${node.kind}${selected ? ' bp-selected' : ''}`}>
      {node.kind !== 'trigger' && <Handle type="target" position={Position.Left} className="bp-handle" />}

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
      {(tokens || node.budget?.maxRetries) && (
        <div className="bp-chips">
          {tokens ? <span className="bp-chip">≤ {Math.round(tokens / 1000)}k tokens</span> : null}
          {node.budget?.maxRetries ? <span className="bp-chip">{node.budget.maxRetries} retries</span> : null}
        </div>
      )}

      <Handle type="source" position={Position.Right} className="bp-handle" />
    </div>
  )
}

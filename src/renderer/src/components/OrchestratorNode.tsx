import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { JSX } from 'react'
import { AgentSprite } from './AgentSprite'

export interface OrchestratorNodeData extends Record<string, unknown> {
  linkedCount: number
  envelopeCount: number
  onMergeAll: () => void
  onBrief: () => void
}

/** Always present in the interface: the orchestrator that collects envelopes
 *  and directs sub-agents. Drag from its handle onto an agent to put that
 *  agent under its direction. */
export function OrchestratorNode({ data }: NodeProps): JSX.Element {
  const d = data as OrchestratorNodeData

  return (
    <div className="orchestrator-node">
      <div className="orch-figure">
        <AgentSprite agentKey="orchestrator" role="Orchestrator" isOrchestrator size={54} />
      </div>
      <div className="orch-title">Orchestrator</div>
      <div className="orch-sub">
        {d.linkedCount > 0 ? `directing ${d.linkedCount}` : 'drag a line to an agent'}
      </div>

      <div className="orch-actions">
        <button type="button" className="orch-btn" onClick={d.onBrief}>
          Brief…
        </button>
        <button
          type="button"
          className="orch-btn orch-btn-primary"
          onClick={d.onMergeAll}
          disabled={d.envelopeCount === 0}
          title={
            d.envelopeCount === 0
              ? 'No unmerged work to collect'
              : `Collect ${d.envelopeCount} envelope(s) and merge`
          }
        >
          ✉ Collect &amp; merge{d.envelopeCount > 0 ? ` (${d.envelopeCount})` : ''}
        </button>
      </div>

      <Handle type="source" position={Position.Bottom} className="orch-handle" />
    </div>
  )
}

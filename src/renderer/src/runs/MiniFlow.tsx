import type { JSX } from 'react'
import { flowLevels } from '../../../shared/blueprint'
import type { NodeRun, NodeState } from '../../../shared/runs'
import type { Blueprint } from '../../../shared/schema'
import { truncate } from '../lib/crew'

interface Props {
  blueprint: Blueprint
  /** Absent for a flow that has not run: every step shows idle. */
  nodes?: Record<string, NodeRun>
  currentNodeId?: string
  selectedId?: string | null
  compact?: boolean
  onSelect?: (nodeId: string) => void
}

const GLYPH: Record<NodeState, string> = { idle: '', running: '', passed: '✓', failed: '✕', awaiting: '⏸' }

/** A flow drawn as a stepper, lit by run state. Deliberately not a scaled
 *  copy of the canvas: at card size a scaled graph has unreadable labels,
 *  whereas a row of labelled steps stays legible with a dozen nodes. */
export function MiniFlow({ blueprint, nodes, currentNodeId, selectedId, compact, onSelect }: Props): JSX.Element {
  const columns = flowLevels(blueprint)

  return (
    <div className={`mf${compact ? ' mf-compact' : ''}`} role="list">
      {columns.map((col, i) => (
        <div className="mf-col" key={i} role="listitem">
          {i > 0 && <span className="mf-link" aria-hidden />}
          <div className="mf-stack">
            {col.map((n) => {
              const run = nodes?.[n.id]
              const state: NodeState = run?.state ?? 'idle'
              const label = n.label || n.kind
              const retries = (run?.attempts ?? 0) > 1 ? run!.attempts - 1 : 0
              const Tag = onSelect ? 'button' : 'div'
              return (
                <Tag
                  key={n.id}
                  type={onSelect ? 'button' : undefined}
                  className={`mf-pill mf-${state}${n.id === currentNodeId ? ' mf-current' : ''}${n.id === selectedId ? ' mf-selected' : ''}`}
                  title={`${label} · ${state}${run?.costUsd ? ` · $${run.costUsd.toFixed(2)}` : ''}`}
                  onClick={onSelect ? () => onSelect(n.id) : undefined}
                >
                  <span className="mf-dot" aria-hidden>
                    {GLYPH[state]}
                  </span>
                  <span className="mf-label">{truncate(label, compact ? 11 : 18)}</span>
                  {retries > 0 && (
                    <span className="mf-retry" title={`${retries} retr${retries === 1 ? 'y' : 'ies'}`}>
                      ↺{retries}
                    </span>
                  )}
                </Tag>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

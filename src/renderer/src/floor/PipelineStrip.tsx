import type { JSX } from 'react'
import type { PipelineStage, StageId, StageState } from '../../../shared/floor'

const GLYPH: Record<StageState, string> = { idle: '', running: '', passed: '✓', failed: '✕', awaiting: '⏸', skipped: '–' }

interface Props {
  stages: PipelineStage[]
  compact?: boolean
  selected?: StageId | null
  /** When set, stages are buttons (the drawer); otherwise they are just a picture (cards). */
  onSelect?: (id: StageId) => void
}

/** Build → Test → Merge → Land, lit by what has actually happened. The same
 *  strip is on every card, whatever the task is made of underneath. */
export function PipelineStrip({ stages, compact, selected, onSelect }: Props): JSX.Element {
  return (
    <ol className={`pl${compact ? ' pl-compact' : ''}`} aria-label="Pipeline">
      {stages.map((s, i) => {
        const Tag = onSelect ? 'button' : 'span'
        return (
          <li key={s.id} className="pl-item">
            {i > 0 && <span className={`pl-link${s.state !== 'idle' && s.state !== 'skipped' ? ' pl-link-on' : ''}`} aria-hidden />}
            <Tag
              {...(onSelect ? { type: 'button' as const, onClick: () => onSelect(s.id) } : {})}
              className={`pl-stage pl-${s.state}${selected === s.id ? ' pl-selected' : ''}`}
              title={`${s.label}: ${s.state === 'skipped' ? 'not part of this' : s.state}. ${s.note}`}
            >
              <span className="pl-dot" aria-hidden>
                {GLYPH[s.state]}
              </span>
              <span className="pl-label">{s.label}</span>
            </Tag>
          </li>
        )
      })}
    </ol>
  )
}

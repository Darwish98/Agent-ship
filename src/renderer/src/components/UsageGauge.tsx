import { useState, type JSX } from 'react'
import { formatTokens } from '../lib/crew'

interface Props {
  weeklyTokens: number
  budget: number
  onBudgetChange: (budget: number) => void
}

/** Trailing-7-day local token volume against a budget the user sets. Claude
 *  Code doesn't record the account's real plan limit anywhere on disk, so
 *  this is an estimate against a number you choose, never a reading of your
 *  actual quota - the tooltip and the "est." label say so plainly, since a
 *  bar that merely *looks* like a real gauge invites reading it as one. */
export function UsageGauge({ weeklyTokens, budget, onBudgetChange }: Props): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(budget))

  const used = budget > 0 ? Math.min(1, weeklyTokens / budget) : 0
  const left = Math.max(0, 1 - used)
  const tone = left > 0.4 ? 'ok' : left > 0.15 ? 'warn' : 'low'

  function commit(): void {
    const parsed = Number.parseFloat(draft.replace(/[^\d.]/g, ''))
    if (Number.isFinite(parsed) && parsed > 0) {
      onBudgetChange(Math.round(parsed * (draft.trim().toLowerCase().endsWith('m') ? 1_000_000 : 1)))
    }
    setEditing(false)
  }

  return (
    <div
      className="usage"
      title="Local token volume over the last 7 days, measured against a budget you set — not a reading of your plan's real limit"
    >
      <span className="usage-label">Usage</span>
      <div className={`usage-track usage-${tone}`}>
        <div className="usage-fill" style={{ width: `${left * 100}%` }} />
      </div>
      <span className="usage-value">
        {formatTokens(weeklyTokens)} /{' '}
        {editing ? (
          <input
            className="usage-input"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') setEditing(false)
            }}
          />
        ) : (
          <button
            type="button"
            className="usage-budget"
            onClick={() => {
              setDraft(String(budget))
              setEditing(true)
            }}
          >
            {formatTokens(budget)}
          </button>
        )}
        <span className="usage-est">est.</span>
      </span>
    </div>
  )
}

import { useState, type JSX } from 'react'
import { formatTokens } from '../lib/crew'

interface Props {
  weeklyTokens: number
  budget: number
  onBudgetChange: (budget: number) => void
}

/** Ship fuel = trailing-7-day local token volume against a budget the user
 *  sets. Claude Code doesn't record the account's real plan limit anywhere on
 *  disk, so this is deliberately labelled an estimate rather than a quota. */
export function FuelGauge({ weeklyTokens, budget, onBudgetChange }: Props): JSX.Element {
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
    <div className="fuel" title="Local token volume over the last 7 days, measured against your own budget — not a reading of your plan's real limit">
      <span className="fuel-label">Fuel</span>
      <div className={`fuel-track fuel-${tone}`}>
        <div className="fuel-fill" style={{ width: `${left * 100}%` }} />
      </div>
      <span className="fuel-value">
        {formatTokens(weeklyTokens)} /{' '}
        {editing ? (
          <input
            className="fuel-input"
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
            className="fuel-budget"
            onClick={() => {
              setDraft(String(budget))
              setEditing(true)
            }}
          >
            {formatTokens(budget)}
          </button>
        )}
        <span className="fuel-est">est.</span>
      </span>
    </div>
  )
}

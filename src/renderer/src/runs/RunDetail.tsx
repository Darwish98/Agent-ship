import { useState, type JSX } from 'react'
import { formatUsd, isActive, isResumable, type NodeState, type RunStatus, type RunView } from '../../../shared/runs'
import { formatAgo, formatTokens } from '../lib/crew'
import { useNav } from '../nav'
import { MiniFlow } from './MiniFlow'
import { useRuns } from './RunsProvider'

export const STATUS_LABEL: Record<RunStatus, string> = {
  running: 'Running',
  awaiting: 'Needs your approval',
  passed: 'Passed',
  failed: 'Failed',
  budget: 'Stopped at its budget',
  cancelled: 'Stopped by you',
  interrupted: 'Interrupted'
}

const STEP_GLYPH: Record<NodeState, string> = { idle: '·', running: '●', passed: '✓', failed: '✕', awaiting: '⏸' }

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

export function SpendMeter({ spent, ceiling }: { spent: number; ceiling: number }): JSX.Element {
  const pct = ceiling > 0 ? Math.min(100, (spent / ceiling) * 100) : 0
  const tone = pct > 85 ? 'low' : pct > 60 ? 'warn' : 'ok'
  return (
    <div className="spend" title={`${formatUsd(spent)} spent of a ${formatUsd(ceiling)} ceiling`}>
      <div className="spend-track">
        <div className={`spend-fill spend-${tone}`} style={{ width: `${Math.max(pct, spent > 0 ? 3 : 0)}%` }} />
      </div>
      <span className="spend-text">
        {formatUsd(spent)} <span className="spend-of">/ {formatUsd(ceiling)}</span>
      </span>
    </div>
  )
}

/** Continues an interrupted run from where it stopped. Shows why it could not, if so. */
export function ResumeButton({ runId, className = 'btn btn-primary' }: { runId: string; className?: string }): JSX.Element {
  const { resume } = useRuns()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={busy}
        title="Everything already spent and built is kept; the step that was in flight starts again."
        onClick={() => {
          setBusy(true)
          setError('')
          void resume(runId)
            .then((r) => {
              if (!r.ok) setError(r.error)
            })
            .finally(() => setBusy(false))
        }}
      >
        {busy ? 'Resuming…' : 'Resume run'}
      </button>
      {error && <span className="rd-error" role="alert">{error}</span>}
    </>
  )
}

interface Props {
  run: RunView
  /** When set, clicking a step in the stepper reports it (editor uses this). */
  onSelectNode?: (nodeId: string) => void
  /** Hide the "open in flow" affordances when already inside the editor. */
  inEditor?: boolean
}

/** One run, in full: where it is, what each step did and cost, and the
 *  actions that make sense right now. Used by the Floor's drawer and by the
 *  editor, so both show the same truth. */
export function RunDetail({ run, onSelectNode, inEditor }: Props): JSX.Element {
  const { cancel, decide, acknowledge, acknowledged } = useRuns()
  const nav = useNav()
  const [note, setNote] = useState('')
  const [open, setOpen] = useState<Set<number>>(new Set())
  const [focus, setFocus] = useState<string | null>(null)

  const nameOf = (id: string): string => {
    const n = run.blueprint.nodes.find((x) => x.id === id)
    return n?.label || n?.kind || id
  }
  const active = isActive(run.status)
  const trouble = run.status === 'failed' || run.status === 'budget' || run.status === 'interrupted'
  const steps = run.steps.filter((s) => !focus || s.nodeId === focus)

  return (
    <div className="rd">
      <div className={`rd-status rd-status-${run.status}`}>
        <strong>{STATUS_LABEL[run.status]}</strong>
        <span>
          {run.projectName} · started {formatAgo(run.startedAt)}
          {run.endedAt ? ` · took ${formatDuration(run.endedAt - run.startedAt)}` : ''}
        </span>
      </div>
      {run.reason && run.status !== 'passed' && <p className="rd-reason">{run.reason}</p>}

      <SpendMeter spent={run.spentUsd} ceiling={run.ceilingUsd} />
      <p className="rd-note">
        Held to a hard ceiling. The CLI checks it after each model call, so a step can overshoot by at most one call.
      </p>

      <MiniFlow
        blueprint={run.blueprint}
        nodes={run.nodes}
        currentNodeId={run.currentNodeId}
        selectedId={focus}
        onSelect={(id) => {
          setFocus((cur) => (cur === id ? null : id))
          onSelectNode?.(id)
        }}
      />

      {run.status === 'awaiting' && (
        <div className="rd-approve">
          <strong>Approval needed</strong>
          <p>{run.nodes[run.currentNodeId ?? '']?.detail}</p>
          <textarea
            rows={2}
            placeholder="Optional note. On rejection it is sent back to the agent as feedback."
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="rd-actions">
            <button type="button" className="btn btn-primary" onClick={() => void decide(run.runId, true, note)}>
              Approve
            </button>
            <button type="button" className="btn" onClick={() => void decide(run.runId, false, note || 'Rejected.')}>
              Reject
            </button>
          </div>
        </div>
      )}

      {run.branch && (
        <p className="rd-branch">
          Result on branch <code>{run.branch}</code>. Nothing was merged.
        </p>
      )}

      <h4 className="rd-h">Steps{focus ? ` · ${nameOf(focus)}` : ''}</h4>
      {steps.length === 0 && <p className="rd-note">Nothing has run yet.</p>}
      <ol className="rd-steps">
        {steps.map((s, i) => {
          const idx = run.steps.indexOf(s)
          const expanded = open.has(idx)
          return (
            <li key={idx} className={`rd-step rd-step-${s.state}`}>
              <button
                type="button"
                className="rd-step-head"
                onClick={() =>
                  setOpen((prev) => {
                    const next = new Set(prev)
                    if (next.has(idx)) next.delete(idx)
                    else next.add(idx)
                    return next
                  })
                }
              >
                <span className="rd-glyph">{STEP_GLYPH[s.state]}</span>
                <span className="rd-step-name">
                  {nameOf(s.nodeId)}
                  {s.attempt > 1 ? ` · attempt ${s.attempt}` : ''}
                </span>
                <span className="rd-step-meta">
                  {s.costUsd > 0 ? `${formatUsd(s.costUsd)} · ${formatTokens(s.tokens)} tok` : ''}
                  {s.endedAt ? ` ${formatDuration(s.endedAt - s.startedAt)}` : ''}
                </span>
              </button>
              {expanded && <pre className="rd-out">{s.detail || '(no output)'}</pre>}
            </li>
          )
        })}
      </ol>

      <div className="rd-actions">
        {isResumable(run.status) && <ResumeButton runId={run.runId} />}
        {active && (
          <button type="button" className="btn rd-danger" onClick={() => void cancel(run.runId)}>
            Stop run
          </button>
        )}
        {!inEditor && (
          <button type="button" className="btn" onClick={() => nav.openFlow(run.projectId, run.flowSlug, focus ?? run.currentNodeId)}>
            {trouble ? 'Edit flow' : 'Open in flow'}
          </button>
        )}
        {trouble && !acknowledged.has(run.runId) && (
          <button type="button" className="btn" onClick={() => acknowledge(run.runId)}>
            Dismiss
          </button>
        )}
      </div>
    </div>
  )
}

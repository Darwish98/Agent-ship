import { useEffect, useRef, useState, type JSX } from 'react'
import type { RunEvent } from '../../../shared/runs'

/** One thing "Land all" can land: an already-tested branch, or a session's
 *  still-uncommitted work (which is committed first, the same as its own
 *  "Commit & land" button does). Built from whatever the Floor already has
 *  in its "Ready to land" lane - see Floor.tsx. */
export interface LandAllItem {
  key: string
  projectId: string
  projectName: string
  title: string
  kind: 'branch' | 'session'
  branch?: string
  cwd?: string
  sessionId?: string
  sessionName?: string
}

type RowState =
  | 'pending'
  | 'planning'
  | 'plan-failed'
  | 'starting'
  | 'start-failed'
  | 'running'
  | 'passed'
  | 'failed'
  | 'budget'
  | 'cancelled'
  | 'interrupted'
  | 'skipped'

const ROW_LABEL: Record<RowState, string> = {
  pending: 'Queued',
  planning: 'Checking…',
  'plan-failed': 'Cannot land',
  starting: 'Starting…',
  'start-failed': 'Could not start',
  running: 'Landing…',
  passed: 'Landed',
  failed: 'Failed',
  budget: 'Stopped at its budget',
  cancelled: 'Stopped',
  interrupted: 'Interrupted',
  skipped: 'Skipped'
}

const ROW_GLYPH: Record<RowState, string> = {
  pending: '·',
  planning: '·',
  'plan-failed': '✕',
  starting: '●',
  'start-failed': '✕',
  running: '●',
  passed: '✓',
  failed: '✕',
  budget: '✕',
  cancelled: '✕',
  interrupted: '✕',
  skipped: '·'
}

const DONE_STATES = new Set<RowState>(['passed', 'failed', 'budget', 'cancelled', 'interrupted', 'plan-failed', 'start-failed', 'skipped'])

/** Resolves once `runId` has a `run.finished` event, from live events or (if
 *  it already finished before we could subscribe) from the stored log. */
function waitForFinish(runId: string): Promise<Extract<RunEvent, { type: 'run.finished' }>> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (e: Extract<RunEvent, { type: 'run.finished' }>): void => {
      if (settled) return
      settled = true
      off()
      resolve(e)
    }
    const off = window.agentShip.onRunEvent((e) => {
      if (e.runId === runId && e.type === 'run.finished') finish(e)
    })
    void window.agentShip.listRuns().then((list) => {
      const fin = list.find((r) => r.runId === runId)?.events.find((e): e is Extract<RunEvent, { type: 'run.finished' }> => e.type === 'run.finished')
      if (fin) finish(fin)
    })
  })
}

/**
 * Lands every branch and pending-work session currently in "Ready to land",
 * one at a time (each one moves the base branch, so the next has to see the
 * result of the last before it tests against it). Started lands are real
 * engine runs and keep going even if this dialog is closed early; "Stop
 * queuing" only holds back the ones that have not started yet.
 */
export function LandAllDialog({ items, onClose }: { items: LandAllItem[]; onClose: () => void }): JSX.Element {
  const [rows, setRows] = useState<Record<string, { state: RowState; detail?: string }>>(
    () => Object.fromEntries(items.map((i) => [i.key, { state: 'pending' as RowState }]))
  )
  const [started, setStarted] = useState(false)
  const [stopping, setStopping] = useState(false)
  const stopRef = useRef(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const set = (key: string, state: RowState, detail?: string): void =>
    setRows((prev) => ({ ...prev, [key]: { state, detail } }))

  async function go(): Promise<void> {
    setStarted(true)
    for (const item of items) {
      if (stopRef.current) {
        set(item.key, 'skipped')
        continue
      }

      set(item.key, 'planning')
      const plan =
        item.kind === 'branch' ? await window.agentShip.landPlan(item.projectId, item.branch!) : await window.agentShip.workPlan(item.projectId, item.cwd!)
      if (!plan.ok) {
        set(item.key, 'plan-failed', plan.error)
        continue
      }

      set(item.key, 'starting')
      const r =
        item.kind === 'branch'
          ? await window.agentShip.landBranch(item.projectId, item.branch!, plan.baseBranch, plan.testCommand, true)
          : await window.agentShip.landWork(item.projectId, item.cwd!, item.sessionId!, plan.baseBranch, plan.testCommand, true, `Work from ${item.sessionName}`)
      if (!r.ok) {
        set(item.key, 'start-failed', r.error)
        continue
      }

      set(item.key, 'running')
      const fin = await waitForFinish(r.runId)
      set(item.key, fin.status, fin.status === 'passed' ? undefined : fin.reason)
      // A run you stopped by hand reads as "stop the whole batch", not "skip
      // this one and keep going" - anything else (a gate that failed, a
      // budget hit) is this branch's own problem and does not block the rest.
      if (fin.status === 'cancelled') stopRef.current = true
    }
  }

  const finishedCount = Object.values(rows).filter((r) => DONE_STATES.has(r.state)).length
  const allDone = started && finishedCount === items.length
  const failedCount = Object.values(rows).filter((r) => r.state !== 'passed' && r.state !== 'skipped' && DONE_STATES.has(r.state)).length

  return (
    <div className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-box rdlg">
        <h3>Land all</h3>
        <div className="modal-subtitle">
          {items.length} branch{items.length === 1 ? '' : 'es'}, one at a time. Each is tested, merged into a scratch copy of its base, re-tested, then landed -
          the same as landing it by hand.
        </div>

        <ol className="la-rows">
          {items.map((item) => {
            const row = rows[item.key] ?? { state: 'pending' as RowState }
            return (
              <li key={item.key} className={`la-row la-row-${row.state}`}>
                <span className="rd-glyph">{ROW_GLYPH[row.state]}</span>
                <span className="la-row-title">
                  {item.title}
                  <span className="la-row-project"> · {item.projectName}</span>
                </span>
                <span className="la-row-state">{ROW_LABEL[row.state]}</span>
                {row.detail && <span className="la-row-detail">{row.detail}</span>}
              </li>
            )
          })}
        </ol>

        {started && !allDone && (
          <p className="rd-note">Landing continues even if you close this. Already-started lands are not undone by "Stop queuing".</p>
        )}
        {allDone && (
          <p className={failedCount ? 'modal-warning' : 'rd-note'}>
            {failedCount
              ? `${items.length - failedCount} of ${items.length} landed. ${failedCount} did not - see above.`
              : `All ${items.length} landed.`}
          </p>
        )}

        <div className="modal-actions">
          {started && !allDone ? (
            <button
              type="button"
              className="btn"
              disabled={stopping}
              onClick={() => {
                stopRef.current = true
                setStopping(true)
              }}
            >
              {stopping ? 'Stopping…' : 'Stop queuing'}
            </button>
          ) : (
            <button type="button" className="btn" onClick={onClose}>
              {allDone ? 'Close' : 'Cancel'}
            </button>
          )}
          {!started && (
            <button type="button" className="btn btn-primary" onClick={() => void go()}>
              Land all {items.length}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

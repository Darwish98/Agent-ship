import { useEffect, useState, type JSX } from 'react'
import { PLAN_FILE, PLANNING_DIR } from '../../../shared/patterns'
import type { RunEvent } from '../../../shared/runs'

export interface PlanSetupTarget {
  projectId: string
  projectName: string
}

/** Resolves once `runId` has a `run.finished` event (live, or already in the
 *  stored log if it finished before this could subscribe). Same shape as
 *  LandAllDialog's - both wait on a run without depending on RunsProvider's
 *  own React state, so it works even if this dialog is closed mid-wait. */
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
 * Shown when the Floor's Autopilot switch is flipped on for a project that
 * has no plan yet. Gets one of two ways: paste one you already wrote, or
 * describe the idea and have an agent expand it into one. Either way, once
 * PLAN.md exists `onReady` hands off to the normal run confirmation - this
 * dialog's only job is getting a plan to exist, never starting Autopilot
 * itself.
 */
export function PlanSetupDialog({ target, onClose, onReady }: { target: PlanSetupTarget; onClose: () => void; onReady: () => void }): JSX.Element {
  const [tab, setTab] = useState<'idea' | 'paste'>('idea')
  const [idea, setIdea] = useState('')
  const [pasted, setPasted] = useState('')
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  async function savePasted(): Promise<void> {
    if (!pasted.trim()) return
    setBusy(true)
    setError('')
    const r = await window.agentShip.savePlan(target.projectId, pasted)
    setBusy(false)
    if (r.ok) onReady()
    else setError(r.error ?? 'Could not save the plan.')
  }

  async function generate(): Promise<void> {
    if (!idea.trim()) return
    setBusy(true)
    setError('')
    setStage('Writing the plan…')
    const started = await window.agentShip.generatePlan(target.projectId, idea)
    if (!started.ok) {
      setBusy(false)
      setStage('')
      setError(started.error)
      return
    }
    const fin = await waitForFinish(started.runId)
    setBusy(false)
    setStage('')
    if (fin.status === 'passed') onReady()
    else setError(`Could not write the plan: ${fin.reason || fin.status}. You can watch it on the Floor, or try again.`)
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal-box rdlg">
        <h3>Set up a plan</h3>
        <div className="modal-subtitle">
          {target.projectName} has no <code>{PLAN_FILE}</code> yet - Autopilot needs one to work from.
        </div>

        <div className="ps-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'idea'} className={`ps-tab${tab === 'idea' ? ' ps-tab-on' : ''}`} disabled={busy} onClick={() => setTab('idea')}>
            Describe the idea
          </button>
          <button type="button" role="tab" aria-selected={tab === 'paste'} className={`ps-tab${tab === 'paste' ? ' ps-tab-on' : ''}`} disabled={busy} onClick={() => setTab('paste')}>
            Paste a plan
          </button>
        </div>

        {tab === 'idea' ? (
          <>
            <p className="rd-note">
              An agent expands this into <code>{PLAN_FILE}</code> - independently gated, landable items, in order. For a new project it also writes the
              fuller record behind it, in <code>{PLANNING_DIR}/</code> (an overview and a design doc). It is a normal run: capped at $2, visible on the
              Floor while it works.
            </p>
            <label className="modal-field">
              The idea
              <textarea rows={5} placeholder="e.g. Add dark mode support across the app, driven by a single setting." value={idea} disabled={busy} onChange={(e) => setIdea(e.target.value)} />
            </label>
          </>
        ) : (
          <>
            <p className="rd-note">
              Saved to <code>{PLAN_FILE}</code> exactly as written. Nothing is generated or changed.
            </p>
            <label className="modal-field">
              Plan text
              <textarea rows={10} placeholder="Paste your plan here." value={pasted} disabled={busy} onChange={(e) => setPasted(e.target.value)} />
            </label>
          </>
        )}

        {stage && <p className="rd-note">{stage}</p>}
        {error && <div className="modal-error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          {tab === 'idea' ? (
            <button type="button" className="btn btn-primary" disabled={busy || !idea.trim()} onClick={() => void generate()}>
              {busy ? 'Writing…' : 'Generate the plan'}
            </button>
          ) : (
            <button type="button" className="btn btn-primary" disabled={busy || !pasted.trim()} onClick={() => void savePasted()}>
              {busy ? 'Saving…' : 'Save the plan'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

import { useEffect, useState, type JSX } from 'react'
import type { LandPlan } from '../../../preload'

export interface LandTarget {
  projectId: string
  projectName: string
  branch: string
}

/** Shows exactly what landing will do, in the order it does it, before it
 *  does anything. Nothing here touches your files until the last step. */
export function LandDialog({ target, onClose }: { target: LandTarget; onClose: () => void }): JSX.Element {
  const [plan, setPlan] = useState<LandPlan | null>(null)
  const [testCommand, setTestCommand] = useState('')
  const [resolve, setResolve] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void window.agentShip.landPlan(target.projectId, target.branch).then((p) => {
      setPlan(p)
      if (p.ok) setTestCommand(p.testCommand)
    })
  }, [target])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const base = plan?.ok ? plan.baseBranch : '…'
  const tests = testCommand.trim()

  async function go(): Promise<void> {
    if (!plan?.ok) return
    setBusy(true)
    setError('')
    const r = await window.agentShip.landBranch(target.projectId, target.branch, plan.baseBranch, tests, resolve)
    setBusy(false)
    if (r.ok) onClose()
    else setError(r.error)
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-box rdlg">
        <h3>Land {target.branch}</h3>
        <div className="modal-subtitle">
          {target.projectName} → {base}
        </div>

        {plan && !plan.ok && <div className="modal-error">{plan.error}</div>}

        {plan?.ok && (
          <>
            <div className="rdlg-plan">
              <h4>What happens, in order</h4>
              <ol className="ld-steps">
                <li>
                  <strong>Test the branch</strong>
                  {tests ? (
                    <>
                      {' '}
                      by running <code>{tests}</code> in a scratch copy of it.
                    </>
                  ) : (
                    ' is skipped: no test command is set.'
                  )}
                </li>
                <li>
                  <strong>Merge</strong> it into a scratch copy of <code>{plan.baseBranch}</code>.{' '}
                  {resolve ? 'If it conflicts, an agent resolves the conflicts (up to $1).' : 'If it conflicts, landing stops and nothing changes.'}
                </li>
                <li>
                  <strong>Test the merged result</strong>
                  {tests ? '. This is what catches two good changes that break each other.' : ' is skipped.'}
                </li>
                <li>
                  <strong>Land</strong>: only now does <code>{plan.baseBranch}</code> move.{' '}
                  {plan.baseCheckedOutAt ? 'It is checked out in your project, so your files update with it.' : 'It is not checked out anywhere, so none of your files change.'}
                </li>
              </ol>
              <p className="rd-note">If any step fails, {plan.baseBranch} is left exactly as it is now.</p>
            </div>

            {plan.baseHasUncommittedChanges && (
              <div className="modal-warning">
                {plan.baseBranch} is checked out with uncommitted changes, so the final step will refuse. Commit or stash them first.
              </div>
            )}

            <label className="modal-field">
              Test command
              <input value={testCommand} onChange={(e) => setTestCommand(e.target.value)} placeholder="e.g. npm test (leave empty to land without tests)" />
            </label>
            <p className="rd-note ld-hint">
              {plan.testSource ? `Detected from ${plan.testSource}. ` : 'Nothing detected for this project. '}
              It runs on your machine.
            </p>
            {!tests && <div className="modal-warning">No tests: this lands unverified. The Test stages will show as skipped.</div>}

            <label className="insp-check ld-check">
              <input type="checkbox" checked={resolve} onChange={(e) => setResolve(e.target.checked)} />
              Let an agent resolve merge conflicts
            </label>
          </>
        )}

        {error && <div className="modal-error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !plan?.ok} onClick={() => void go()}>
            {busy ? 'Starting…' : 'Land it'}
          </button>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useState, type JSX } from 'react'
import type { WorkPlan } from '../../../preload'

export interface CommitLandTarget {
  projectId: string
  projectName: string
  /** The session's checkout. */
  cwd: string
  sessionId: string
  sessionName: string
}

/** Lands the files a session left uncommitted. It says plainly what will be
 *  committed, where, and what stays untouched, because "commit and merge my
 *  work" is exactly the kind of button that must never surprise you. */
export function CommitLandDialog({ target, onClose }: { target: CommitLandTarget; onClose: () => void }): JSX.Element {
  const [plan, setPlan] = useState<WorkPlan | null>(null)
  const [testCommand, setTestCommand] = useState('')
  const [message, setMessage] = useState(`Work from ${target.sessionName}`)
  const [resolve, setResolve] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void window.agentShip.workPlan(target.projectId, target.cwd).then((p) => {
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

  const tests = testCommand.trim()

  async function go(): Promise<void> {
    if (!plan?.ok) return
    setBusy(true)
    setError('')
    const r = await window.agentShip.landWork(target.projectId, target.cwd, target.sessionId, plan.baseBranch, tests, resolve, message)
    setBusy(false)
    if (r.ok) onClose()
    else setError(r.error)
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-box rdlg">
        <h3>Commit &amp; land</h3>
        <div className="modal-subtitle">
          {target.sessionName} · {target.projectName}
        </div>

        {plan && !plan.ok && <div className="modal-error">{plan.error}</div>}

        {plan?.ok && (
          <>
            <div className="rdlg-plan">
              <h4>
                {plan.files} uncommitted file{plan.files === 1 ? '' : 's'} on <code>{plan.currentBranch}</code>. What happens, in order
              </h4>
              <ol className="ld-steps">
                {plan.mode === 'on-branch' ? (
                  <li>
                    <strong>Commit</strong> them onto <code>{plan.currentBranch}</code> (like <code>git add -A &amp;&amp; git commit</code>). Your files do not change.
                  </li>
                ) : (
                  <li>
                    <strong>Snapshot</strong> them onto a <em>new branch</em>. You are working directly on <code>{plan.baseBranch}</code>, so nothing untested is
                    committed to it. Your files do not change.
                  </li>
                )}
                <li>
                  <strong>Test</strong>
                  {tests ? (
                    <>
                      {' '}
                      by running <code>{tests}</code> in a scratch copy.
                    </>
                  ) : (
                    ' is skipped: no test command is set.'
                  )}
                </li>
                <li>
                  <strong>Merge</strong> into a scratch copy of <code>{plan.baseBranch}</code>
                  {resolve ? '; an agent resolves conflicts if there are any (up to $1).' : '; if it conflicts, landing stops.'}
                </li>
                <li>
                  <strong>Test the merged result</strong>
                  {tests ? '.' : ' is skipped.'}
                </li>
                <li>
                  <strong>Land</strong>: only now does <code>{plan.baseBranch}</code> move.{' '}
                  {plan.mode === 'on-base'
                    ? 'Your files are already the tested result, so the branch and your working files simply become the same commit.'
                    : 'Your working files are not affected.'}
                </li>
              </ol>
              <p className="rd-note">
                If any step fails, {plan.baseBranch} is left exactly as it is.{' '}
                {plan.mode === 'on-base' && 'If you edit a file while this runs, landing stops rather than guess (your edit is kept).'}
              </p>
            </div>

            <label className="modal-field">
              Commit message
              <input value={message} onChange={(e) => setMessage(e.target.value)} />
            </label>

            <label className="modal-field">
              Test command
              <input value={testCommand} onChange={(e) => setTestCommand(e.target.value)} placeholder="e.g. npm test (leave empty to land without tests)" />
            </label>
            <p className="rd-note ld-hint">
              {plan.testSource ? `Detected from ${plan.testSource}. ` : 'Nothing detected for this project. '}
              It runs on your machine.
            </p>
            {!tests && <div className="modal-warning">No tests: this lands unverified.</div>}

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
            {busy ? 'Starting…' : 'Commit & land'}
          </button>
        </div>
      </div>
    </div>
  )
}

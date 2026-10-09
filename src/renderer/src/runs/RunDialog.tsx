import { useEffect, useState, type JSX } from 'react'
import { resolveForDisplay, summarizeRun, unrunnableReasons, usdCeiling } from '../../../shared/blueprint'
import { formatUsd } from '../../../shared/runs'
import type { Blueprint } from '../../../shared/schema'
import { useRuns } from './RunsProvider'

/** What a run may spend unless the person says otherwise. */
const DEFAULT_LIMIT_USD = 10
const MIN_LIMIT_USD = 0.05

export interface RunTarget {
  projectId: string
  slug: string
  /** Pre-fills matching input fields; still editable, still requires Start. */
  initialInputs?: Record<string, string>
}

/** The last thing between a click and real spending. It states, from the file
 *  on disk, exactly what will execute; nothing here is a marketing summary. */
export function RunDialog({ target, onClose }: { target: RunTarget; onClose: () => void }): JSX.Element {
  const { start } = useRuns()
  const [bp, setBp] = useState<Blueprint | null>(null)
  const [project, setProject] = useState('')
  const [loadError, setLoadError] = useState('')
  const [inputs, setInputs] = useState<Record<string, string>>(target.initialInputs ?? {})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [limit, setLimit] = useState('')
  const [toolCheck, setToolCheck] = useState<{ tool: string; found: boolean } | null>(null)

  useEffect(() => {
    void (async () => {
      const [flow, projects] = await Promise.all([
        window.agentShip.loadFlow(target.projectId, target.slug),
        window.agentShip.listProjects()
      ])
      setProject(projects.find((p) => p.id === target.projectId)?.name ?? '')
      if (flow.ok) setBp(flow.blueprint)
      else setLoadError(flow.error)
    })()
  }, [target])

  // The flow's own worst case is rarely what a person means to risk; start from a modest limit they can change.
  useEffect(() => {
    if (!bp || limit !== '') return
    const worst = usdCeiling(bp)
    if (worst) setLimit(String(Math.min(worst, DEFAULT_LIMIT_USD)))
  }, [bp, limit])

  // A flow that takes a `test` command: say so now if the program it starts is not installed.
  const testCommand = inputs.test ?? ''
  const hasTestInput = Boolean(bp?.inputs.some((i) => i.name === 'test'))
  useEffect(() => {
    if (!hasTestInput || !testCommand.trim()) return setToolCheck(null)
    const t = setTimeout(() => void window.agentShip.commandExists(testCommand).then(setToolCheck), 300)
    return () => clearTimeout(t)
  }, [hasTestInput, testCommand])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const reasons = bp ? unrunnableReasons(bp) : []
  const summary = bp ? summarizeRun(resolveForDisplay(bp, inputs)) : null
  const missing = bp?.inputs.find((i) => i.required && !(inputs[i.name] ?? '').trim())
  const worstCase = bp ? usdCeiling(bp) : null
  const limitUsd = Number(limit)
  const limitOk = Number.isFinite(limitUsd) && limitUsd >= MIN_LIMIT_USD
  const effectiveLimit = worstCase === null ? null : Math.min(worstCase, limitOk ? limitUsd : worstCase)

  async function go(): Promise<void> {
    setBusy(true)
    setError('')
    const r = await start(target.projectId, target.slug, inputs, limitOk ? limitUsd : undefined)
    setBusy(false)
    if (r.ok) onClose()
    else setError(r.error)
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-box rdlg">
        <h3>Run {bp?.name ?? 'flow'}</h3>
        <div className="modal-subtitle">in {project || '…'}</div>

        {loadError && <div className="modal-error">{loadError}</div>}

        {bp && summary && (
          <>
            <div className="rdlg-plan">
              <h4>This run will</h4>
              <ul>
                {summary.parallel.map((p, i) => (
                  <li key={`p${i}`}>
                    <strong>{p.label}</strong>: runs <strong>{p.copies} copies</strong> of {p.steps.join(' → ') || 'its chain'} (at most 4 at a
                    time, each in its own branch), then{' '}
                    {p.strategy === 'best'
                      ? 'a judge agent reads every passing branch and keeps the best; the other branches are deleted'
                      : p.strategy === 'first'
                        ? 'keeps the first to pass and stops the rest'
                        : p.strategy === 'quorum'
                          ? `continues once ${p.quorum} pass and stops the rest`
                          : 'waits for all of them'}
                  </li>
                ))}
                {summary.agents.map((a, i) => (
                  <li key={i}>
                    <strong>{a.label}</strong>: {a.edits ? 'can modify files' : 'read-only'}
                    {a.ownBranch
                      ? ', in its own git branch (your checkout is untouched)'
                      : a.inScratch
                        ? ", in the merge step's scratch copy (your checkout is untouched)"
                        : a.edits
                          ? ', directly in the working directory it is given'
                          : ''}
                    {a.model !== 'default' ? ` · ${a.model}` : ''}
                  </li>
                ))}
                {summary.commands.map((c, i) => (
                  <li key={`c${i}`}>
                    <strong>{c.label}</strong>: runs <code>{c.command || '(empty command)'}</code> on your machine
                  </li>
                ))}
                {summary.merges.map((m, i) => (
                  <li key={`m${i}`}>
                    <strong>{m.label}</strong>: merges the branch into <code>{m.base || '(no branch set)'}</code> in a scratch copy
                    {m.agentOnConflict ? '; an agent resolves conflicts if there are any' : ''}. Nothing in your checkout changes yet.
                  </li>
                ))}
                {summary.lands.map((l, i) => (
                  <li key={`l${i}`}>
                    <strong>{l.label}</strong>: <strong>moves your <code>{l.base || '(no branch set)'}</code> branch</strong> to the result that was just
                    tested. This changes your repository.
                  </li>
                ))}
                {summary.humanGates.map((g, i) => (
                  <li key={`h${i}`}>
                    <strong>{g}</strong>: pauses for your approval
                  </li>
                ))}
                {summary.agentGates.map((g, i) => (
                  <li key={`ag${i}`}>
                    <strong>{g.label}</strong>: an agent judges whether to continue, up to <strong>{g.maxRetries}</strong> time
                    {g.maxRetries === 1 ? '' : 's'} (its loop cap){g.maxUsd !== null ? `, at most ${formatUsd(g.maxUsd)} each time` : ''}
                  </li>
                ))}
                <li>
                  Spends at most <strong>{effectiveLimit !== null ? formatUsd(effectiveLimit) : 'unbounded'}</strong>: the run stops when it reaches
                  your limit below. The CLI checks it after each model call, so a step may exceed it by one call.
                </li>
                {summary.merges.length === 0 && summary.lands.length === 0 && <li>Merges nothing. The result is a branch you review and land yourself.</li>}
              </ul>
            </div>

            {reasons.length > 0 ? (
              <div className="modal-error">
                <strong>Cannot run yet:</strong>
                <ul className="rdlg-reasons">
                  {reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <>
                {bp.inputs.map((input) => (
                  <label className="modal-field" key={input.name}>
                    {input.label || input.name}
                    <textarea
                      rows={input.name === 'test' || input.name === 'base' ? 1 : 3}
                      value={inputs[input.name] ?? ''}
                      onChange={(e) => setInputs((prev) => ({ ...prev, [input.name]: e.target.value }))}
                    />
                    {input.name === 'test' && toolCheck && !toolCheck.found && (
                      <span className="modal-error">
                        &quot;{toolCheck.tool}&quot; was not found on this machine, so the tests cannot run. Install it, or change this command.
                      </span>
                    )}
                  </label>
                ))}
                {worstCase !== null && (
                  <label className="modal-field">
                    Stop the run after spending (USD)
                    <input type="number" min={MIN_LIMIT_USD} step="0.5" value={limit} onChange={(e) => setLimit(e.target.value)} />
                    <span className="rd-note">A hard stop for the whole run: it ends, with whatever it has landed so far, once it has spent this much.</span>
                  </label>
                )}
              </>
            )}
          </>
        )}

        {error && <div className="modal-error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !bp || reasons.length > 0 || Boolean(missing) || (worstCase !== null && !limitOk)}
            onClick={() => void go()}
          >
            {busy ? 'Starting…' : 'Start run'}
          </button>
        </div>
      </div>
    </div>
  )
}

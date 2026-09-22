import { useEffect, useState, type JSX } from 'react'
import { summarizeRun, unrunnableReasons } from '../../../shared/blueprint'
import { formatUsd } from '../../../shared/runs'
import type { Blueprint } from '../../../shared/schema'
import { useRuns } from './RunsProvider'

export interface RunTarget {
  projectId: string
  slug: string
}

/** The last thing between a click and real spending. It states, from the file
 *  on disk, exactly what will execute; nothing here is a marketing summary. */
export function RunDialog({ target, onClose }: { target: RunTarget; onClose: () => void }): JSX.Element {
  const { start } = useRuns()
  const [bp, setBp] = useState<Blueprint | null>(null)
  const [project, setProject] = useState('')
  const [loadError, setLoadError] = useState('')
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const reasons = bp ? unrunnableReasons(bp) : []
  const summary = bp ? summarizeRun(bp) : null
  const missing = bp?.inputs.find((i) => i.required && !(inputs[i.name] ?? '').trim())

  async function go(): Promise<void> {
    setBusy(true)
    setError('')
    const r = await start(target.projectId, target.slug, inputs)
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
                    {a.ownBranch ? ', in its own git branch (your checkout is untouched)' : a.edits ? ', directly in the working directory it is given' : ''}
                    {a.model !== 'default' ? ` · ${a.model}` : ''}
                  </li>
                ))}
                {summary.commands.map((c, i) => (
                  <li key={`c${i}`}>
                    <strong>{c.label}</strong>: runs <code>{c.command || '(empty command)'}</code> on your machine
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
                  Spends at most <strong>{summary.ceilingUsd !== null ? formatUsd(summary.ceilingUsd) : 'unbounded'}</strong>. The
                  CLI checks the limit after each model call, so a step may exceed it by one call.
                </li>
                <li>Merges nothing. The result is a branch you review and land yourself.</li>
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
              bp.inputs.map((input) => (
                <label className="modal-field" key={input.name}>
                  {input.label || input.name}
                  <textarea
                    rows={3}
                    value={inputs[input.name] ?? ''}
                    onChange={(e) => setInputs((prev) => ({ ...prev, [input.name]: e.target.value }))}
                  />
                </label>
              ))
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
            disabled={busy || !bp || reasons.length > 0 || Boolean(missing)}
            onClick={() => void go()}
          >
            {busy ? 'Starting…' : 'Start run'}
          </button>
        </div>
      </div>
    </div>
  )
}

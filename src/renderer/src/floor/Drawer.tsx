import { useEffect, useState, type JSX } from 'react'
import { STAGE_LABEL, type StageId, type WorkItem } from '../../../shared/floor'
import { formatUsd } from '../../../shared/runs'
import { formatAgo, formatTokens } from '../lib/crew'
import { formatDuration, RunDetail } from '../runs/RunDetail'
import { canCommitAndLand, VerifyBadge, type FloorActions } from './Cards'
import { PipelineStrip } from './PipelineStrip'

interface Props {
  item: WorkItem
  projectName: string
  projectPath: string
  baseBranch: string
  actions: FloorActions
  onRunOf: (branch: string) => void
  onClose: () => void
}

const KIND_OF_STAGE: Record<StageId, string> = { build: 'agent', test: 'gate', merge: 'merge', land: 'land' }
const STEP_GLYPH: Record<string, string> = { idle: '·', running: '●', passed: '✓', failed: '✕', awaiting: '⏸' }

/** The detail view for whatever is selected on the board. */
export function Drawer({ item, projectName, projectPath, baseBranch, actions, onRunOf, onClose }: Props): JSX.Element {
  return (
    <aside className="fl-drawer" aria-label="Details">
      <header className="fl-drawer-head">
        <div>
          <span className="fc-kind">{item.kind === 'run' ? 'FLOW RUN' : item.kind.toUpperCase()}</span>
          <h3 title={item.title}>{item.title}</h3>
          <span className="fl-drawer-proj">{projectName}</span>
        </div>
        <button type="button" className="btn" onClick={onClose} aria-label="Close details">
          ✕
        </button>
      </header>

      <PipelinePanel item={item} actions={actions} />

      {item.kind === 'run' && item.run && <RunDetail run={item.run} />}

      {item.kind === 'session' && item.session && (
        <div className="rd">
          <dl className="fl-dl">
            <dt>State</dt>
            <dd>{item.session.live ? item.session.status : `idle, ${formatAgo(item.session.lastActive)}`}</dd>
            <dt>Branch</dt>
            <dd>{item.session.branch || 'none'}</dd>
            <dt>Context</dt>
            <dd>{formatTokens(item.session.contextTokens)} used</dd>
            {item.session.task && (
              <>
                <dt>Last task</dt>
                <dd>{item.session.task}</dd>
              </>
            )}
          </dl>
          <p className="rd-note">Started outside a flow, so it has no budget ceiling or gate. Only flows can promise those.</p>
          <div className="rd-actions">
            {canCommitAndLand(item) && (
              <button type="button" className="btn btn-primary" onClick={() => actions.landWork(item)}>
                Commit &amp; land…
              </button>
            )}
            <button type="button" className="btn" onClick={() => actions.openSession(item.session!.sessionId)}>
              Open in Claude Code
            </button>
            <button type="button" className="btn" onClick={() => actions.stopOrRemove(item)}>
              {item.session.live && item.session.pid ? 'Stop' : 'Remove from floor'}
            </button>
          </div>
        </div>
      )}

      {item.kind === 'branch' && item.branch && (
        <>
          <BranchPanel item={item} projectPath={projectPath} baseBranch={baseBranch} actions={actions} onRunOf={onRunOf} />
          {item.landRun && (
            <>
              <h4 className="rd-h fl-h-pad">Landing run</h4>
              <RunDetail run={item.landRun} />
            </>
          )}
        </>
      )}
    </aside>
  )
}

/**
 * The task's pipeline, and what is behind each stage. The strip is the same on
 * every card; here you can open a stage to see the real steps, sessions and
 * output that made it, even when they belong to different runs.
 */
function PipelinePanel({ item, actions }: { item: WorkItem; actions: FloorActions }): JSX.Element {
  const [stage, setStage] = useState<StageId | null>(null)
  const active = stage ? item.pipeline.find((s) => s.id === stage) : null

  // The run whose steps back the Test, Merge and Land stages.
  const source = item.landRun ?? item.run
  const nodes = source && stage ? source.blueprint.nodes.filter((n) => n.kind === KIND_OF_STAGE[stage]) : []
  const steps = source ? source.steps.filter((s) => nodes.some((n) => n.id === s.nodeId)) : []
  const nameOf = (id: string): string => {
    const n = source?.blueprint.nodes.find((x) => x.id === id)
    return n?.label || n?.kind || id
  }

  return (
    <section className="pp" aria-label="Pipeline">
      <PipelineStrip stages={item.pipeline} selected={stage} onSelect={(id) => setStage((cur) => (cur === id ? null : id))} />
      {!active && <p className="rd-note pp-hint">Click a stage to see what is behind it.</p>}
      {active && (
        <div className="pp-detail">
          <strong>{STAGE_LABEL[active.id]}</strong>
          <p>{active.note}</p>

          {active.id === 'build' && item.session && (
            <button type="button" className="btn" onClick={() => actions.openSession(item.session!.sessionId)}>
              Open the session in Claude Code
            </button>
          )}
          {active.id === 'build' &&
            item.authorSessions.map((s) => (
              <button type="button" key={s.sessionId} className="btn pp-btn" onClick={() => actions.openSession(s.sessionId)}>
                Open “{s.name}” in Claude Code
              </button>
            ))}

          {active.id !== 'build' && steps.length === 0 && active.state !== 'skipped' && (
            <p className="rd-note">Nothing has run for this stage yet.</p>
          )}
          {active.id !== 'build' && (
            <ol className="rd-steps">
              {steps.map((s, i) => (
                <li key={i} className={`rd-step rd-step-${s.state}`}>
                  <div className="rd-step-head pp-step-head">
                    <span className="rd-glyph">{STEP_GLYPH[s.state] ?? '·'}</span>
                    <span className="rd-step-name">
                      {nameOf(s.nodeId)}
                      {s.attempt > 1 ? ` · attempt ${s.attempt}` : ''}
                    </span>
                    <span className="rd-step-meta">
                      {s.costUsd > 0 ? `${formatUsd(s.costUsd)} ` : ''}
                      {s.endedAt ? formatDuration(s.endedAt - s.startedAt) : ''}
                    </span>
                  </div>
                  {s.detail && <pre className="rd-out">{s.detail}</pre>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  )
}

function BranchPanel({
  item,
  projectPath,
  baseBranch,
  actions,
  onRunOf
}: Pick<Props, 'item' | 'projectPath' | 'baseBranch' | 'actions' | 'onRunOf'>): JSX.Element {
  const b = item.branch!
  const [summary, setSummary] = useState<{ files: number; added: number; removed: number } | null>(null)

  useEffect(() => {
    setSummary(null)
    if (!baseBranch) return
    let live = true
    void window.agentShip.branchSummary(projectPath, baseBranch, b.branch).then((s) => live && setSummary(s))
    return () => {
      live = false
    }
  }, [projectPath, baseBranch, b.branch])

  const v = item.verification ?? { state: 'unverified' as const }
  const landing = item.landRun && item.landRun.status === 'running'
  return (
    <div className="rd">
      <div className="fc-row">
        <VerifyBadge v={v} />
        <span className="fc-meta">last commit {formatAgo(b.lastCommitAt)}</span>
      </div>
      <dl className="fl-dl">
        <dt>Branch</dt>
        <dd>
          <code>{b.branch}</code>
        </dd>
        <dt>Into</dt>
        <dd>
          <code>{baseBranch || 'unknown'}</code>
        </dd>
        <dt>Commits</dt>
        <dd>{b.ahead}</dd>
        <dt>Changes</dt>
        <dd>{summary ? `${summary.files} file${summary.files === 1 ? '' : 's'}, +${summary.added} −${summary.removed}` : '…'}</dd>
        {item.authors.length > 0 && (
          <>
            <dt>By</dt>
            <dd>{item.authors.join(', ')}</dd>
          </>
        )}
        <dt>Latest</dt>
        <dd>{b.subject}</dd>
      </dl>
      <div className="rd-actions">
        {!landing && (
          <button type="button" className="btn btn-primary" onClick={() => actions.land(item)}>
            {item.lane === 'needs' ? 'Try landing again…' : 'Land…'}
          </button>
        )}
        {item.authors.some((a) => a.endsWith(' run')) && (
          <button type="button" className="btn" onClick={() => onRunOf(b.branch)}>
            View the run that built it
          </button>
        )}
      </div>
    </div>
  )
}

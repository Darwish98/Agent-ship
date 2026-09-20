import { useEffect, useState, type JSX } from 'react'
import type { WorkItem } from '../../../shared/floor'
import { formatAgo, formatTokens } from '../lib/crew'
import { RunDetail } from '../runs/RunDetail'
import { VerifyBadge, type FloorActions } from './Cards'

interface Props {
  item: WorkItem
  projectName: string
  projectPath: string
  baseBranch: string
  actions: FloorActions
  onRunOf: (runId: string) => void
  onClose: () => void
}

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
          <p className="rd-note">
            Started outside a flow, so it has no budget ceiling or gate. Only flows can promise those.
          </p>
          <div className="rd-actions">
            <button type="button" className="btn btn-primary" onClick={() => actions.openSession(item.session!.sessionId)}>
              Open in Claude Code
            </button>
            <button type="button" className="btn" onClick={() => actions.stopOrRemove(item)}>
              {item.session.live && item.session.pid ? 'Stop' : 'Remove from floor'}
            </button>
          </div>
        </div>
      )}

      {item.kind === 'branch' && item.branch && (
        <BranchPanel item={item} projectPath={projectPath} baseBranch={baseBranch} actions={actions} onRunOf={onRunOf} />
      )}
    </aside>
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
  return (
    <div className="rd">
      <div className="fc-row">
        <VerifyBadge v={v} />
        <span className="fc-meta">last commit {formatAgo(b.lastCommitAt)}</span>
      </div>
      <p className="rd-note">
        {v.state === 'verified'
          ? `A gate passed on this work (${v.by}).`
          : v.state === 'failed'
            ? `The gate "${v.by}" failed on this branch. Read the run before landing it.`
            : 'No gate ever checked this branch. Review it yourself before landing.'}
      </p>
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
        <button type="button" className="btn btn-primary" onClick={() => actions.land(item)}>
          Land…
        </button>
        {item.authors.some((a) => a.endsWith(' run')) && (
          <button type="button" className="btn" onClick={() => onRunOf(b.branch)}>
            View the run
          </button>
        )}
      </div>
    </div>
  )
}

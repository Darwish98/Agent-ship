import type { JSX } from 'react'
import type { Verification, WorkItem } from '../../../shared/floor'
import { formatUsd } from '../../../shared/runs'
import { AgentSprite } from '../components/AgentSprite'
import { badgeFor, formatAgo, formatTokens, truncate } from '../lib/crew'
import { MiniFlow } from '../runs/MiniFlow'
import { ResumeButton, SpendMeter, STATUS_LABEL } from '../runs/RunDetail'

/** Everything a card can ask the Floor to do. Cards stay dumb; the Floor owns
 *  dialogs and IPC. */
export interface FloorActions {
  select: (id: string) => void
  approve: (runId: string) => void
  dismiss: (runId: string) => void
  editFlow: (item: WorkItem) => void
  openSession: (sessionId: string) => void
  stopOrRemove: (item: WorkItem) => void
  land: (item: WorkItem) => void
}

interface CardProps {
  item: WorkItem
  selected: boolean
  projectName: string | null
  actions: FloorActions
}

export function VerifyBadge({ v }: { v: Verification }): JSX.Element {
  if (v.state === 'verified') {
    return (
      <span className="vb vb-ok" title={`A gate proved this: ${v.by}`}>
        ✓ tests passed
      </span>
    )
  }
  if (v.state === 'failed') {
    return (
      <span className="vb vb-bad" title={`The gate "${v.by}" failed on this branch`}>
        ⚠ gate failed
      </span>
    )
  }
  return (
    <span className="vb vb-none" title="No gate has checked this work. It may be fine; nothing has shown that it is.">
      unverified
    </span>
  )
}

function Shell({
  item,
  selected,
  projectName,
  actions,
  kind,
  children
}: CardProps & { kind: string; children: React.ReactNode }): JSX.Element {
  return (
    <div
      className={`fc fc-${item.kind} fc-lane-${item.lane}${selected ? ' fc-selected' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => actions.select(item.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          actions.select(item.id)
        }
      }}
    >
      <div className="fc-head">
        <span className="fc-kind">{kind}</span>
        <strong className="fc-title" title={item.title}>
          {item.title}
        </strong>
        {projectName && <span className="fc-proj">{projectName}</span>}
      </div>
      {children}
    </div>
  )
}

const stop = (e: React.SyntheticEvent): void => e.stopPropagation()

export function RunCard(props: CardProps): JSX.Element {
  const { item, actions } = props
  const run = item.run!
  return (
    <Shell {...props} kind="FLOW">
      <MiniFlow blueprint={run.blueprint} nodes={run.nodes} currentNodeId={run.currentNodeId} compact />
      <SpendMeter spent={run.spentUsd} ceiling={run.ceilingUsd} />
      {item.reasons.length > 0 ? (
        <p className="fc-reason">{truncate(item.reasons[0], 140)}</p>
      ) : (
        <p className="fc-sub">
          {item.subtitle} · {formatAgo(item.updatedAt)}
        </p>
      )}
      <div className="fc-actions" onClick={stop}>
        {run.status === 'awaiting' && (
          <button type="button" className="btn btn-primary fc-btn" onClick={() => actions.select(item.id)}>
            Review & approve
          </button>
        )}
        {(run.status === 'failed' || run.status === 'budget' || run.status === 'interrupted') && item.lane === 'needs' && (
          <>
            {run.status === 'interrupted' && <ResumeButton runId={run.runId} className="btn btn-primary fc-btn" />}
            <button type="button" className="btn fc-btn" onClick={() => actions.editFlow(item)}>
              Edit flow
            </button>
            <button type="button" className="btn fc-btn" onClick={() => actions.dismiss(run.runId)}>
              Dismiss
            </button>
          </>
        )}
      </div>
    </Shell>
  )
}

export function SessionCard(props: CardProps): JSX.Element {
  const { item, actions } = props
  const s = item.session!
  const badge = badgeFor(s.role, /orchestrat/i.test(s.name))
  const left = s.contextLimit ? Math.max(0, Math.min(1, 1 - s.contextTokens / s.contextLimit)) : 1
  const tone = left > 0.4 ? 'ok' : left > 0.15 ? 'warn' : 'low'
  return (
    <Shell {...props} kind="SESSION">
      <div className="fc-session">
        <div className={`fc-sprite${s.live ? ' is-live' : ''}`}>
          <AgentSprite agentKey={s.sessionId} role={s.role} isOrchestrator={/orchestrat/i.test(s.name)} size={36} dimmed={!s.live} />
        </div>
        <div className="fc-session-body">
          <span className="role-chip" style={{ background: badge.color }}>
            {badge.code}
          </span>{' '}
          <span className="fc-status">{s.live ? truncate(s.status, 30) : formatAgo(s.lastActive)}</span>
          <div className={`fc-ctx fc-ctx-${tone}`} title={`${Math.round(left * 100)}% of context left (${formatTokens(s.contextTokens)} used)`}>
            <div style={{ width: `${Math.max(3, left * 100)}%` }} />
          </div>
        </div>
      </div>
      {item.reasons.length > 0 ? <p className="fc-reason">{item.reasons[0]}</p> : s.task && <p className="fc-sub">{truncate(s.task, 90)}</p>}
      {s.branch && <p className="fc-branch">{s.branch}</p>}
      <div className="fc-actions" onClick={stop}>
        <button type="button" className="btn fc-btn" onClick={() => actions.openSession(s.sessionId)}>
          Open
        </button>
        <button type="button" className="btn fc-btn" onClick={() => actions.stopOrRemove(item)}>
          {s.live && s.pid ? 'Stop' : 'Remove'}
        </button>
      </div>
    </Shell>
  )
}

export function BranchCard(props: CardProps): JSX.Element {
  const { item, actions } = props
  const b = item.branch!
  return (
    <Shell {...props} kind="BRANCH">
      <p className="fc-sub fc-subject" title={b.subject}>
        {truncate(b.subject, 80)}
      </p>
      <div className="fc-row">
        <VerifyBadge v={item.verification ?? { state: 'unverified' }} />
        <span className="fc-meta">
          {b.ahead} commit{b.ahead === 1 ? '' : 's'} · {formatAgo(b.lastCommitAt)}
        </span>
      </div>
      {item.authors.length > 0 && <p className="fc-branch">by {truncate(item.authors.join(', '), 50)}</p>}
      <div className="fc-actions" onClick={stop}>
        <button type="button" className="btn btn-primary fc-btn" onClick={() => actions.land(item)}>
          Land…
        </button>
      </div>
    </Shell>
  )
}

export function WorkCard(props: CardProps): JSX.Element {
  switch (props.item.kind) {
    case 'run':
      return <RunCard {...props} />
    case 'session':
      return <SessionCard {...props} />
    case 'branch':
      return <BranchCard {...props} />
  }
}

export { formatUsd, STATUS_LABEL }

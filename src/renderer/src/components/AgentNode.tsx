import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { JSX } from 'react'
import { badgeFor, formatAgo, formatTokens, truncate } from '../lib/crew'
import type { Agent } from '../types'
import { AgentSprite } from './AgentSprite'

/** Context headroom left, as a 0-1 fraction. */
function batteryLevel(agent: Agent): number {
  if (!agent.contextLimit) return 1
  return Math.max(0, Math.min(1, 1 - agent.contextTokens / agent.contextLimit))
}

function Battery({ level }: { level: number }): JSX.Element {
  const pct = Math.round(level * 100)
  const tone = level > 0.4 ? 'ok' : level > 0.15 ? 'warn' : 'low'
  return (
    <div className={`battery battery-${tone}`} aria-label={`${pct}% context left`}>
      <div className="battery-shell">
        <div className="battery-fill" style={{ width: `${Math.max(pct, 2)}%` }} />
      </div>
      <span className="battery-cap" />
    </div>
  )
}

function EnvelopeBadge({ count }: { count: number }): JSX.Element {
  return (
    <div className="envelope" title={`${count} unmerged commit${count === 1 ? '' : 's'}`}>
      <svg viewBox="0 0 16 12" width="15" height="11" aria-hidden="true">
        <rect x="0.6" y="0.6" width="14.8" height="10.8" rx="1.6" fill="#F3E1D7" stroke="#C15F3C" />
        <path d="M1 1.5 L8 7 L15 1.5" fill="none" stroke="#C15F3C" strokeWidth="1.2" />
      </svg>
      {count > 0 && <span className="envelope-count">{count}</span>}
    </div>
  )
}

export function AgentNode({ data }: NodeProps): JSX.Element {
  const agent = data.agent as Agent
  const badge = badgeFor(agent.role, agent.isOrchestrator)
  const level = batteryLevel(agent)

  return (
    <div className={`agent-node${agent.live ? ' is-live' : ' is-idle'}`}>
      <Handle type="target" position={Position.Top} className="agent-handle" />

      <div className="agent-figure">
        {agent.hasEnvelope && <EnvelopeBadge count={agent.aheadCommits} />}
        <AgentSprite
          agentKey={agent.key}
          role={agent.role}
          isOrchestrator={agent.isOrchestrator}
          dimmed={!agent.live}
        />
      </div>

      <Battery level={level} />

      <div className="agent-tag">
        <span className="role-chip" style={{ background: badge.color }}>
          {badge.code}
        </span>
        <span className="agent-name">{truncate(agent.name, 14)}</span>
      </div>

      <div className="agent-hovercard">
        <div className="hovercard-row hovercard-title">{agent.name}</div>
        <div className="hovercard-row">
          <span className="hovercard-label">Branch</span>
          <span className="hovercard-branch">{agent.branch || 'no branch'}</span>
        </div>
        {agent.hasEnvelope && (
          <div className="hovercard-row">
            <span className="hovercard-label">Unmerged</span>
            <span>
              {agent.aheadCommits} commit{agent.aheadCommits === 1 ? '' : 's'}
              {agent.dirtyFiles > 0 ? `, ${agent.dirtyFiles} uncommitted` : ''}
            </span>
          </div>
        )}
        <div className="hovercard-row">
          <span className="hovercard-label">Context</span>
          <span>
            {formatTokens(agent.contextTokens)} used · {Math.round(level * 100)}% left
          </span>
        </div>
        <div className="hovercard-row">
          <span className="hovercard-label">{agent.live ? 'Doing' : 'Last'}</span>
          <span>{agent.live ? agent.status : formatAgo(agent.lastActive)}</span>
        </div>
        {agent.task && <div className="hovercard-task">{truncate(agent.task, 90)}</div>}
        <div className="hovercard-hint">Click to give a new task</div>
      </div>
    </div>
  )
}

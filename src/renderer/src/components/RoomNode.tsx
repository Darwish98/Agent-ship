import type { NodeProps } from '@xyflow/react'
import { useEffect, useRef, useState, type JSX } from 'react'
import { colorFor, truncate } from '../lib/crew'
import type { HiddenAgent, Room } from '../types'

export interface RoomNodeData extends Record<string, unknown> {
  room: Room
  agentCount: number
  liveCount: number
  envelopeCount: number
  branch: string
  hiddenAgents: HiddenAgent[]
  onSpawn: (room: Room) => void
  onRemove: (room: Room) => void
  onRestore: (agent: HiddenAgent) => void
}

export function RoomNode({ data }: NodeProps): JSX.Element {
  const d = data as RoomNodeData
  const accent = colorFor(d.room.id).body
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onClickAway = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onClickAway)
    return () => document.removeEventListener('mousedown', onClickAway)
  }, [menuOpen])

  return (
    <div className="room-node" style={{ borderTopColor: accent }}>
      <div className="room-header">
        <div className="room-heading">
          <div className="room-name">{truncate(d.room.name, 30)}</div>
          <div className="room-meta">
            {d.branch && <span className="room-branch">{truncate(d.branch, 22)}</span>}
            <span className="room-path">{truncate(d.room.path, 44)}</span>
          </div>
        </div>

        <div className="room-actions">
          {d.envelopeCount > 0 && (
            <span className="room-envelopes" title={`${d.envelopeCount} agents with unmerged work`}>
              ✉ {d.envelopeCount}
            </span>
          )}
          <span className="room-count">
            {d.liveCount}/{d.agentCount}
          </span>
          {d.hiddenAgents.length > 0 && (
            <div className="room-restore" ref={menuRef}>
              <button
                type="button"
                className="room-btn"
                title="Removed agents - bring one back"
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpen((v) => !v)
                }}
              >
                ↺ {d.hiddenAgents.length}
              </button>
              {menuOpen && (
                <div className="room-restore-menu" onClick={(e) => e.stopPropagation()}>
                  <div className="room-restore-title">Bring back an agent</div>
                  {d.hiddenAgents.map((agent) => (
                    <button
                      key={agent.sessionId}
                      type="button"
                      className="room-restore-item"
                      onClick={() => {
                        setMenuOpen(false)
                        d.onRestore(agent)
                      }}
                    >
                      {truncate(agent.name, 34)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            className="room-btn"
            title="Spawn an agent in this room"
            onClick={(e) => {
              e.stopPropagation()
              d.onSpawn(d.room)
            }}
          >
            +
          </button>
          {!d.room.ephemeral && (
            <button
              type="button"
              className="room-btn room-btn-danger"
              title="Remove this room"
              onClick={(e) => {
                e.stopPropagation()
                d.onRemove(d.room)
              }}
            >
              ×
            </button>
          )}
        </div>
      </div>
      <div className="room-floor" />
    </div>
  )
}

import type { NodeProps } from '@xyflow/react'
import type { JSX } from 'react'
import { colorFor, truncate } from '../lib/crew'
import type { Room } from '../types'

export interface RoomNodeData extends Record<string, unknown> {
  room: Room
  agentCount: number
  liveCount: number
  envelopeCount: number
  branch: string
  onSpawn: (room: Room) => void
  onRemove: (room: Room) => void
}

export function RoomNode({ data }: NodeProps): JSX.Element {
  const d = data as RoomNodeData
  const accent = colorFor(d.room.id).body

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

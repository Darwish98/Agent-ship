import type { JSX } from 'react'
import { colorFor, hatFor, type CrewColor, type HatKind } from '../lib/crew'

// Blocky, pixel-grid accessories - rectangles only, to match the body style.
function Accessory({ kind, color }: { kind: HatKind; color: CrewColor }): JSX.Element | null {
  const d = color.dark
  switch (kind) {
    case 'headset':
      return (
        <>
          <rect x={-12} y={-6} width={24} height={3} fill={d} />
          <rect x={-12} y={-3} width={3} height={7} fill={d} />
          <rect x={9} y={-3} width={3} height={7} fill={d} />
        </>
      )
    case 'cap':
      return (
        <>
          <rect x={-9} y={-12} width={18} height={5} fill={d} />
          <rect x={-13} y={-8} width={26} height={5} fill={d} />
        </>
      )
    case 'beret':
      return (
        <>
          <rect x={-10} y={-9} width={20} height={6} fill={d} />
          <rect x={6} y={-13} width={4} height={4} fill={d} />
        </>
      )
    case 'visor':
      return <rect x={-10} y={-1} width={20} height={4} fill={d} opacity={0.85} />
    case 'crown':
      return (
        <>
          <rect x={-11} y={-11} width={22} height={5} fill="#E0A93B" />
          <rect x={-11} y={-17} width={4} height={6} fill="#E0A93B" />
          <rect x={-2} y={-19} width={4} height={8} fill="#E0A93B" />
          <rect x={7} y={-17} width={4} height={6} fill="#E0A93B" />
        </>
      )
    default:
      return (
        <>
          <rect x={-1} y={-12} width={2} height={8} fill={d} />
          <rect x={-3} y={-17} width={6} height={5} fill="#ffffff" />
        </>
      )
  }
}

interface Props {
  /** Stable key the colour is derived from. */
  agentKey: string
  role: string
  isOrchestrator?: boolean
  size?: number
  /** Dims the sprite for sessions that aren't currently running. */
  dimmed?: boolean
}

/** Body block modelled on Claude's own pixel mark: solid rect, two cutout
 *  eyes, a side arm tab, and two foot tabs. */
export function AgentSprite({
  agentKey,
  role,
  isOrchestrator = false,
  size = 46,
  dimmed = false
}: Props): JSX.Element {
  const color = colorFor(agentKey)
  const hat = hatFor(role, isOrchestrator)

  return (
    <svg
      className="agent-sprite"
      viewBox="-20 -22 40 50"
      width={size}
      height={size * 1.15}
      style={{ opacity: dimmed ? 0.45 : 1 }}
      aria-hidden="true"
    >
      {/* Legs live in their own groups, pinned at the hip, so the walk cycle
          can scissor them without touching the rest of the sprite. */}
      <g className="leg leg-l">
        <rect x={-8} y={16} width={4} height={8} fill={color.body} />
      </g>
      <g className="leg leg-r">
        <rect x={4} y={16} width={4} height={8} fill={color.body} />
      </g>
      <rect x={-12} y={-4} width={24} height={20} fill={color.body} />
      <rect x={-16} y={6} width={32} height={6} fill={color.body} />
      <rect x={-9} y={0} width={4} height={8} fill="#ffffff" />
      <rect x={5} y={0} width={4} height={8} fill="#ffffff" />
      <Accessory kind={hat} color={color} />
    </svg>
  )
}

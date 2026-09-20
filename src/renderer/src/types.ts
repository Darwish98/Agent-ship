import type { AgentShipApi } from '../../preload'

declare global {
  interface Window {
    agentShip: AgentShipApi
  }
}

export interface Room {
  id: string
  name: string
  path: string
  ephemeral?: boolean
}

/** A crew member: either a live session emitting hook events, or a past
 *  session recovered from Claude Code's local transcripts. */
export interface Agent {
  key: string
  sessionId: string
  name: string
  role: string
  task: string
  status: string
  roomId: string
  cwd: string
  branch: string
  /** Context tokens the model is currently holding - the battery. */
  contextTokens: number
  contextLimit: number
  lastActive: number
  /** Emitted a hook event recently, i.e. actually working right now. */
  live: boolean
  /** Carrying commits or edits that haven't reached the base branch. */
  hasEnvelope: boolean
  aheadCommits: number
  dirtyFiles: number
  isOrchestrator: boolean
  /** Process id when Claude Code reports this session as running. */
  pid?: number
  /** "interactive" or a background kind, from claude agents --json. */
  kind?: string
}

/** A removed session, kept around only so a room's "bring back" menu can
 *  offer to restore it. */
export interface HiddenAgent {
  sessionId: string
  name: string
  roomId: string
  lastActive: number
}

export {}

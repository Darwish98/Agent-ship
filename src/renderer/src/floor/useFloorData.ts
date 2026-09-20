import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BranchInfo, FlowSummary, GitState } from '../../../preload'
import { deriveFloor, sessionActivity, type BranchLite, type FloorModel, type SessionLite } from '../../../shared/floor'
import type { World } from '../hooks/useAgentWorld'
import { useWorld } from '../hooks/world'
import { useRuns } from '../runs/RunsProvider'
import { useHandledByHand } from './usePendingMemory'
import type { Room } from '../types'

const POLL_MS = 30_000

export interface FloorData {
  world: World
  model: FloorModel
  rooms: Room[]
  gitByRoom: Map<string, GitState>
  branchesByRoom: Map<string, BranchInfo[]>
  flowsByRoom: Map<string, FlowSummary[]>
  refreshRoom: (roomId: string) => Promise<void>
}

/**
 * Everything the Floor needs, joined together: the ad-hoc sessions Claude Code
 * knows about, the runs the engine owns, and per-project git and flow state.
 * The join itself lives in shared/floor.ts (pure, tested); this hook only
 * gathers the inputs.
 */
export function useFloorData(active: boolean): FloorData {
  const world = useWorld()
  const { runs, acknowledged } = useRuns()
  const { rooms, agents } = world
  const handledAt = useHandledByHand(agents, runs)

  const [gitByRoom, setGit] = useState<Map<string, GitState>>(new Map())
  const [branchesByRoom, setBranches] = useState<Map<string, BranchInfo[]>>(new Map())
  const [flowsByRoom, setFlows] = useState<Map<string, FlowSummary[]>>(new Map())

  const roomsRef = useRef(rooms)
  roomsRef.current = rooms

  const refreshRoom = useCallback(async (roomId: string) => {
    const room = roomsRef.current.find((r) => r.id === roomId)
    if (!room) return
    const [git, branches, flows] = await Promise.all([
      window.agentShip.gitState(room.path).catch(() => null),
      window.agentShip.unmergedBranches(room.path).catch(() => [] as BranchInfo[]),
      room.ephemeral ? Promise.resolve([] as FlowSummary[]) : window.agentShip.listFlows(room.id).catch(() => [] as FlowSummary[])
    ])
    if (git) setGit((prev) => new Map(prev).set(roomId, git))
    setBranches((prev) => new Map(prev).set(roomId, branches))
    setFlows((prev) => new Map(prev).set(roomId, flows))
  }, [])

  // Poll every project on the floor, not only ones with agents: an idle repo
  // with a finished branch is exactly the thing worth surfacing.
  const roomKey = useMemo(() => rooms.map((r) => r.id).sort().join('|'), [rooms])
  useEffect(() => {
    if (!active) return
    let cancelled = false
    const all = async (): Promise<void> => {
      for (const id of roomKey.split('|').filter(Boolean)) {
        if (cancelled) return
        await refreshRoom(id)
      }
    }
    void all()
    const timer = setInterval(() => void all(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [active, roomKey, refreshRoom])

  // A run finishing changes branches and verification; look again right away.
  const finishedKey = runs.filter((r) => !['running', 'awaiting'].includes(r.status)).length
  useEffect(() => {
    if (!active) return
    for (const r of rooms) void refreshRoom(r.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishedKey])

  const model = useMemo(() => {
    const now = Date.now()
    const sessions: SessionLite[] = agents.map((a) => {
      const act = sessionActivity({
        status: a.procStatus,
        state: a.procState,
        waitingFor: a.waitingFor,
        lastHookAt: a.lastHookAt,
        lastHookEvent: a.lastHookEvent,
        now
      })
      return {
      sessionId: a.sessionId,
      name: a.name,
      role: a.role,
      task: a.task,
      status: a.status,
      projectId: a.roomId,
      live: a.live,
      working: a.live && act.working,
      needsInput: a.live && act.needsInput,
      waitingFor: act.waitingFor,
      lastActive: a.lastActive,
      cwd: a.cwd,
      dirtyFiles: a.dirtyFiles,
      aheadCommits: a.aheadCommits,
      handledAt: handledAt[a.sessionId],
      branch: a.branch,
      contextTokens: a.contextTokens,
      contextLimit: a.contextLimit,
      pid: a.pid
      }
    })
    const branches: BranchLite[] = []
    for (const [projectId, list] of branchesByRoom) {
      for (const b of list) branches.push({ projectId, branch: b.branch, ahead: b.ahead, lastCommitAt: b.lastCommitAt, subject: b.subject })
    }
    return deriveFloor({ now, runs, sessions, branches, acknowledged })
    // `world` ticks every 15s, which keeps relative ages honest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, runs, branchesByRoom, acknowledged, world, handledAt])

  return { world, model, rooms, gitByRoom, branchesByRoom, flowsByRoom, refreshRoom }
}

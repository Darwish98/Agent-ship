import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type Connection,
  type Edge,
  type Node
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { OrchestratorLink } from '../../preload'
import { AgentNode } from './components/AgentNode'
import { FuelGauge } from './components/FuelGauge'
import { OrchestratorNode } from './components/OrchestratorNode'
import { RoomNode } from './components/RoomNode'
import { TaskDialog, type TaskDialogSpec } from './components/TaskDialog'
import { useAgentWorld } from './hooks/useAgentWorld'
import type { Agent, Room } from './types'

const ROOM_W = 480
const ROOM_H = 360
const ROOM_GAP = 52
const ROOMS_PER_ROW = 3
const CANVAS_TOP = 210

// Keeps a wandering agent fully inside its room - the node is ~96x104, and
// the room's header strip occupies the top 64px.
const PAD_X = 20
const PAD_TOP = 74
const AGENT_W = 96
const AGENT_H = 104
/** Enough clearance that two crew members don't sit on top of each other. */
const MIN_SEPARATION = 118

type Spot = { x: number; y: number }

const nodeTypes = { room: RoomNode, agent: AgentNode, orchestrator: OrchestratorNode }

function randomSpot(): Spot {
  return {
    x: PAD_X + Math.random() * Math.max(1, ROOM_W - AGENT_W - PAD_X * 2),
    y: PAD_TOP + Math.random() * Math.max(1, ROOM_H - AGENT_H - PAD_TOP - 12)
  }
}

/** Uniform placement happily stacks two agents on the same spot. A few
 *  rejection-sampled tries, keeping whichever candidate lands furthest from
 *  everyone else, keeps a room readable without pinning anyone to a grid. */
function spotAwayFrom(taken: Spot[]): Spot {
  let best = randomSpot()
  let bestDist = -1
  for (let i = 0; i < 8; i++) {
    const cand = i === 0 ? best : randomSpot()
    let nearest = Infinity
    for (const t of taken) nearest = Math.min(nearest, Math.hypot(cand.x - t.x, cand.y - t.y))
    if (nearest >= MIN_SEPARATION) return cand
    if (nearest > bestDist) {
      bestDist = nearest
      best = cand
    }
  }
  return best
}

export default function App(): JSX.Element {
  const world = useAgentWorld()
  const { rooms, agents, settings, weeklyTokens } = world

  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map())
  const [motion, setMotion] = useState<
    Map<string, { walking: boolean; facingLeft: boolean; duration: number }>
  >(new Map())
  const [links, setLinks] = useState<OrchestratorLink[]>([])
  const [dialog, setDialog] = useState<TaskDialogSpec | null>(null)
  const agentsRef = useRef(agents)
  agentsRef.current = agents

  useEffect(() => {
    void window.agentShip.getLinks().then(setLinks)
  }, [])

  // Spots occupied by everyone else sharing a room, so a move can avoid them.
  const neighbours = useCallback(
    (roomId: string, selfKey: string, from: Map<string, Spot>): Spot[] =>
      agentsRef.current
        .filter((a) => a.roomId === roomId && a.key !== selfKey)
        .map((a) => from.get(a.key))
        .filter((s): s is Spot => Boolean(s)),
    []
  )

  // Give every new agent a spot, and drop spots for agents that have gone.
  useEffect(() => {
    setPositions((prev) => {
      const next = new Map(prev)
      const alive = new Set(agents.map((a) => a.key))
      for (const key of next.keys()) if (!alive.has(key)) next.delete(key)
      for (const agent of agents) {
        if (next.has(agent.key)) continue
        next.set(agent.key, spotAwayFrom(neighbours(agent.roomId, agent.key, next)))
      }
      return next
    })
  }, [agents, neighbours])

  // The world stays alive between events - but only agents that are actually
  // working move. A finished session from yesterday pacing its room like a
  // live one is what made the building read as a demo.
  useEffect(() => {
    const timer = setInterval(() => {
      const steps: { key: string; from: Spot; to: Spot }[] = []

      setPositions((prev) => {
        const next = new Map(prev)
        for (const agent of agentsRef.current) {
          if (!agent.live) continue
          if (Math.random() > 0.45) continue
          const from = next.get(agent.key)
          const to = spotAwayFrom(neighbours(agent.roomId, agent.key, next))
          next.set(agent.key, to)
          if (from) steps.push({ key: agent.key, from, to })
        }
        return next
      })

      if (!steps.length) return

      // Walk at a roughly constant speed rather than easing every move into
      // the same slot - a short shuffle and a long stroll should not take the
      // same time, which is what made the movement look like gliding.
      setMotion((prev) => {
        const next = new Map(prev)
        for (const { key, from, to } of steps) {
          const dist = Math.hypot(to.x - from.x, to.y - from.y)
          const duration = Math.min(2600, Math.max(500, Math.round(dist * 11)))
          next.set(key, { walking: true, facingLeft: to.x < from.x, duration })
          window.setTimeout(() => {
            setMotion((m) => {
              const after = new Map(m)
              const cur = after.get(key)
              if (cur) after.set(key, { ...cur, walking: false })
              return after
            })
          }, duration)
        }
        return next
      })
    }, 2600)
    return () => clearInterval(timer)
  }, [neighbours])

  const persistLinks = useCallback(async (next: OrchestratorLink[]) => {
    setLinks(next)
    await window.agentShip.setLinks(next)
  }, [])

  // --- actions -----------------------------------------------------------

  const openSpawn = useCallback((room: Room) => {
    setDialog({
      title: 'Spawn an agent',
      subtitle: `in ${room.name} · ${room.path}`,
      roleField: true,
      submitLabel: 'Spawn',
      onSubmit: async ({ role, task }) => {
        const result = await window.agentShip.spawnAgent(room.path, role, task)
        return result.ok ? null : (result.error ?? 'Could not spawn agent.')
      }
    })
  }, [])

  const openRetask = useCallback((agent: Agent) => {
    setDialog({
      title: `Give ${agent.name} a new task`,
      subtitle: agent.live
        ? `${agent.status} · on ${agent.branch || 'no branch'}`
        : `Resumes this session on ${agent.branch || 'no branch'}`,
      submitLabel: 'Send',
      onSubmit: async ({ task }) => {
        const result = await window.agentShip.resumeSession(agent.sessionId, agent.cwd, task)
        return result.ok ? null : (result.error ?? 'Could not resume session.')
      }
    })
  }, [])

  const openOrchestratorBrief = useCallback(() => {
    const room = rooms[0]
    if (!room) return
    setDialog({
      title: 'Brief the orchestrator',
      subtitle: `Runs in ${room.name}. It can spawn and direct its own sub-agents.`,
      submitLabel: 'Start orchestrator',
      onSubmit: async ({ task }) => {
        const result = await window.agentShip.spawnOrchestrator(room.path, task)
        return result.ok ? null : (result.error ?? 'Could not start orchestrator.')
      }
    })
  }, [rooms])

  const openInClaudeCode = useCallback((agent: Agent) => {
    void window.agentShip.openSession(agent.sessionId)
  }, [])

  // "Delete" means two different things depending on whether the session is
  // alive: stop the process, or drop a finished session from the building.
  // Neither ever deletes the transcript on disk.
  const deleteAgent = useCallback(
    (agent: Agent) => {
      if (agent.live && agent.pid) {
        setDialog({
          title: `Stop ${agent.name}?`,
          subtitle: `${agent.kind ?? 'session'} · pid ${agent.pid} · ${agent.cwd}`,
          warning: [
            'This kills the running Claude Code process.',
            'Its transcript is kept, so you can resume the session afterwards.'
          ],
          taskField: false,
          submitLabel: 'Stop agent',
          onSubmit: async () => {
            const result = await window.agentShip.stopAgent(agent.pid!)
            if (!result.ok) return result.error ?? 'Could not stop the agent.'
            await world.refreshSessions()
            return null
          }
        })
        return
      }

      setDialog({
        title: `Remove ${agent.name}?`,
        subtitle: 'Takes this finished session out of the building.',
        warning: ['Its transcript is left untouched on disk - nothing is deleted.'],
        taskField: false,
        submitLabel: 'Remove',
        onSubmit: async () => {
          await world.hideAgent(agent.sessionId)
          return null
        }
      })
    },
    [world]
  )

  const envelopeAgents = useMemo(() => agents.filter((a) => a.hasEnvelope), [agents])

  // Merging rewrites real branches, so this always shows exactly what it is
  // about to touch and waits for a deliberate confirmation.
  const openMergeAll = useCallback(async () => {
    const roomsWithWork = [...new Set(envelopeAgents.map((a) => a.roomId))]
      .map((id) => rooms.find((r) => r.id === id))
      .filter((r): r is Room => Boolean(r))

    const plan: { room: Room; branches: string[]; baseBranch: string }[] = []
    for (const room of roomsWithWork) {
      const branches = await window.agentShip.unmergedBranches(room.path)
      const git = world.gitStateFor(room.path)
      if (branches.length) {
        plan.push({
          room,
          branches: branches.map((b) => b.branch),
          baseBranch: git?.baseBranch || 'main'
        })
      }
    }

    if (!plan.length) {
      setDialog({
        title: 'Nothing to merge',
        subtitle: 'No branch is ahead of its base branch right now.',
        taskField: false,
        submitLabel: 'Close',
        onSubmit: async () => null
      })
      return
    }

    const warning = plan.flatMap(({ room, branches, baseBranch }) => [
      `${room.name} → ${baseBranch}: ${branches.join(', ')}`
    ])

    setDialog({
      title: 'Collect envelopes and merge',
      subtitle: 'An orchestrator agent will land these branches and resolve conflicts.',
      warning: [...warning, 'It merges and commits in your real repositories.'],
      taskField: false,
      submitLabel: `Merge ${plan.reduce((n, p) => n + p.branches.length, 0)} branch(es)`,
      onSubmit: async () => {
        for (const { room, branches, baseBranch } of plan) {
          const result = await window.agentShip.mergeAll(room.path, baseBranch, branches)
          if (!result.ok) return result.error ?? 'Could not start the merge orchestrator.'
        }
        return null
      }
    })
  }, [envelopeAgents, rooms, world])

  const removeRoom = useCallback(
    async (room: Room) => {
      if (room.ephemeral) return
      const ok = window.confirm(
        `Remove "${room.name}" from the building? Agents already running there keep running.`
      )
      if (!ok) return
      await window.agentShip.removeProject(room.id)
      await world.refreshProjects()
    },
    [world]
  )

  // --- graph -------------------------------------------------------------

  const nodes = useMemo<Node[]>(() => {
    const out: Node[] = [
      {
        id: 'orchestrator',
        type: 'orchestrator',
        position: { x: 8, y: 20 },
        draggable: false,
        data: {
          linkedCount: links.length,
          envelopeCount: envelopeAgents.length,
          onMergeAll: () => void openMergeAll(),
          onBrief: openOrchestratorBrief
        }
      }
    ]

    rooms.forEach((room, i) => {
      const col = i % ROOMS_PER_ROW
      const row = Math.floor(i / ROOMS_PER_ROW)
      const roomAgents = agents.filter((a) => a.roomId === room.id)

      out.push({
        id: room.id,
        type: 'room',
        position: { x: col * (ROOM_W + ROOM_GAP), y: CANVAS_TOP + row * (ROOM_H + ROOM_GAP) },
        style: { width: ROOM_W, height: ROOM_H },
        draggable: false,
        selectable: false,
        data: {
          room,
          agentCount: roomAgents.length,
          liveCount: roomAgents.filter((a) => a.live).length,
          envelopeCount: roomAgents.filter((a) => a.hasEnvelope).length,
          branch: roomAgents.find((a) => a.branch)?.branch ?? '',
          onSpawn: openSpawn,
          onRemove: (r: Room) => void removeRoom(r)
        }
      })

      for (const agent of roomAgents) {
        const m = motion.get(agent.key)
        // extent:'parent' is what guarantees a wandering agent can never be
        // clipped by its room's edge.
        out.push({
          id: agent.key,
          type: 'agent',
          parentId: room.id,
          extent: 'parent',
          position: positions.get(agent.key) ?? randomSpot(),
          draggable: false,
          // Linear, distance-scaled: a walk, not an ease-in-out glide.
          style: { transition: `transform ${m?.duration ?? 900}ms linear` },
          data: {
            agent,
            walking: m?.walking ?? false,
            facingLeft: m?.facingLeft ?? false,
            onOpen: openInClaudeCode,
            onDelete: deleteAgent
          }
        })
      }
    })

    return out
  }, [
    rooms,
    agents,
    positions,
    motion,
    links.length,
    envelopeAgents.length,
    openSpawn,
    removeRoom,
    openMergeAll,
    openOrchestratorBrief,
    openInClaudeCode,
    deleteAgent
  ])

  const edges = useMemo<Edge[]>(() => {
    const keys = new Set(agents.map((a) => a.key))
    return links
      .filter((l) => keys.has(l.to))
      .map((l) => ({
        id: `${l.from}->${l.to}`,
        source: l.from,
        target: l.to,
        animated: true,
        className: 'orch-edge'
      }))
  }, [links, agents])

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return
      if (links.some((l) => l.from === connection.source && l.to === connection.target)) return
      void persistLinks([...links, { from: connection.source, to: connection.target }])
    },
    [links, persistLinks]
  )

  const onEdgeClick = useCallback(
    (_e: React.MouseEvent, edge: Edge) => {
      void persistLinks(links.filter((l) => `${l.from}->${l.to}` !== edge.id))
    },
    [links, persistLinks]
  )

  const onNodeClick = useCallback(
    (_e: React.MouseEvent, node: Node) => {
      if (node.type !== 'agent') return
      const agent = agentsRef.current.find((a) => a.key === node.id)
      if (agent) openRetask(agent)
    },
    [openRetask]
  )

  const liveCount = agents.filter((a) => a.live).length

  return (
    <div className="app">
      <header className="toolbar">
        <div className="toolbar-title">
          <span className="brand-mark" />
          Agent Ship
        </div>

        <div className="toolbar-stats">
          <span className="stat">
            <strong>{liveCount}</strong> working
          </span>
          <span className="stat">
            <strong>{agents.length - liveCount}</strong> idle
          </span>
          <span className="stat">
            <strong>{envelopeAgents.length}</strong> ✉ unmerged
          </span>
          <FuelGauge
            weeklyTokens={weeklyTokens}
            budget={settings.weeklyTokenBudget}
            onBudgetChange={(b) => void world.setBudget(b)}
          />
        </div>

        <button
          type="button"
          className="btn btn-primary"
          onClick={async () => {
            await window.agentShip.addProject()
            await world.refreshProjects()
          }}
        >
          + Add project
        </button>
      </header>

      <div className="canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onConnect={onConnect}
          onEdgeClick={onEdgeClick}
          onNodeClick={onNodeClick}
          nodesDraggable={false}
          nodesConnectable
          // Agents are small and constantly moving, so snap the connection to
          // any handle near where the line is dropped rather than demanding a
          // pixel-perfect landing.
          connectionRadius={70}
          minZoom={0.3}
          maxZoom={1.6}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={26} size={1.4} color="#DCD9CE" />
          <Controls showInteractive={false} />
        </ReactFlow>

        {rooms.length === 0 && (
          <div className="empty-state">
            No rooms in the building yet.
            <span>
              Click <strong>+ Add project</strong> to register one, or run <code>claude</code> inside
              a folder.
            </span>
          </div>
        )}
      </div>

      {dialog && <TaskDialog spec={dialog} onClose={() => setDialog(null)} />}
    </div>
  )
}

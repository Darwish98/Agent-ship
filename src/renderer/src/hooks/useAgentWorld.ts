import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentEvent,
  GitState,
  Project,
  RunningAgent,
  SessionSummary,
  Settings
} from '../../../preload'
import type { Agent, HiddenAgent, Room } from '../types'

/** A session counts as "live" if it emitted a hook event this recently. */
const LIVE_WINDOW_MS = 3 * 60 * 1000
/** Past sessions older than this are not worth putting on the canvas.
 *  Sessions are already filtered upstream to ones Claude Code named, so this
 *  only trims genuinely stale history. */
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const MAX_AGENTS_PER_ROOM = 8

function pathsMatch(cwd: string, projectPath: string): boolean {
  const a = cwd.toLowerCase()
  const b = projectPath.toLowerCase()
  return a === b || a.startsWith(`${b}\\`) || a.startsWith(`${b}/`)
}

function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

function statusFor(event: AgentEvent): string {
  if (event.status) return event.status
  if (event.hookEvent === 'UserPromptSubmit') return 'reading the prompt'
  if (event.hookEvent === 'Stop') return 'idle'
  if (event.toolName) return `using ${event.toolName}`
  return event.hookEvent || 'working'
}

function crewKey(event: AgentEvent): string {
  return event.agentId ? `${event.sessionId}::${event.agentId}` : event.sessionId
}

interface LiveRecord {
  event: AgentEvent
  at: number
}

export interface World {
  rooms: Room[]
  agents: Agent[]
  projects: Project[]
  settings: Settings
  weeklyTokens: number
  refreshProjects: () => Promise<void>
  refreshSessions: () => Promise<void>
  setBudget: (budget: number) => Promise<void>
  gitStateFor: (cwd: string) => GitState | undefined
  hideAgent: (sessionId: string) => Promise<void>
  restoreAgent: (sessionId: string) => Promise<void>
  unhideAll: () => Promise<void>
  hiddenCount: number
  hiddenByRoom: Map<string, HiddenAgent[]>
}

export function useAgentWorld(): World {
  const [projects, setProjects] = useState<Project[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [running, setRunning] = useState<RunningAgent[]>([])
  const [hidden, setHiddenState] = useState<string[]>([])
  const [live, setLive] = useState<Map<string, LiveRecord>>(new Map())
  const [gitStates, setGitStates] = useState<Map<string, GitState>>(new Map())
  const [settings, setSettings] = useState<Settings>({ weeklyTokenBudget: 50_000_000 })
  const [weeklyTokens, setWeeklyTokens] = useState(0)
  // Re-render on a timer so "live" decays and "last active" stays truthful
  // even when nothing new arrives.
  const [, setTick] = useState(0)

  const refreshProjects = useCallback(async () => {
    setProjects(await window.agentShip.listProjects())
  }, [])

  const refreshSessions = useCallback(async () => {
    const [list, alive] = await Promise.all([
      window.agentShip.listSessions(),
      window.agentShip.listRunning()
    ])
    setSessions(list)
    setRunning(alive)
  }, [])

  const refreshUsage = useCallback(async () => {
    const usage = await window.agentShip.weeklyUsage()
    setWeeklyTokens(usage.weeklyTokens)
  }, [])

  useEffect(() => {
    void refreshProjects()
    void refreshSessions()
    void refreshUsage()
    void window.agentShip.getSettings().then(setSettings)
    void window.agentShip.getHidden().then(setHiddenState)
  }, [refreshProjects, refreshSessions, refreshUsage])

  // Hook events from Claude Code, relayed by the local bridge.
  useEffect(() => {
    return window.agentShip.onAgentEvent((event) => {
      const key = crewKey(event)
      setLive((prev) => {
        const next = new Map(prev)
        if (event.hookEvent === 'SessionEnd') next.delete(key)
        else next.set(key, { event, at: Date.now() })
        if (event.subagentDoneId) next.delete(`${event.sessionId}::${event.subagentDoneId}`)
        return next
      })
    })
  }, [])

  useEffect(() => {
    const sessionTimer = setInterval(() => void refreshSessions(), 10_000)
    const usageTimer = setInterval(() => void refreshUsage(), 60_000)
    const tickTimer = setInterval(() => setTick((t) => t + 1), 15_000)
    return () => {
      clearInterval(sessionTimer)
      clearInterval(usageTimer)
      clearInterval(tickTimer)
    }
  }, [refreshSessions, refreshUsage])

  // --- rooms -------------------------------------------------------------

  const liveList = useMemo(() => [...live.values()], [live])

  // Rooms are auto-detected from Claude Code's own projects: every folder it
  // has named sessions for gets a room, the same way its sidebar lists them.
  // Explicitly registered projects are merged in so a folder you added before
  // ever running Claude Code there still gets a room.
  const rooms = useMemo<Room[]>(() => {
    const registered: Room[] = projects.map((p) => ({ id: p.id, name: p.name, path: p.path }))
    const extra = new Map<string, Room>()

    const cwds = [
      ...sessions.filter((s) => Date.now() - s.updatedAt < SESSION_MAX_AGE_MS).map((s) => s.cwd),
      ...liveList.map((l) => l.event.projectPath)
    ]
    for (const cwd of cwds) {
      if (!cwd) continue
      if (registered.some((r) => pathsMatch(cwd, r.path))) continue
      const id = `extra:${cwd}`
      if (!extra.has(id)) extra.set(id, { id, name: baseName(cwd), path: cwd, ephemeral: true })
    }

    return [...registered, ...extra.values()]
  }, [projects, sessions, liveList])

  const roomIdFor = useCallback(
    (cwd: string): string | null => {
      if (!cwd) return null
      let best: Room | null = null
      for (const room of rooms) {
        if (pathsMatch(cwd, room.path) && (!best || room.path.length > best.path.length)) best = room
      }
      return best?.id ?? null
    },
    [rooms]
  )

  // --- agents ------------------------------------------------------------

  const runningBySession = useMemo(() => {
    const map = new Map<string, RunningAgent>()
    for (const r of running) map.set(r.sessionId, r)
    return map
  }, [running])

  const agents = useMemo<Agent[]>(() => {
    const byKey = new Map<string, Agent>()
    const now = Date.now()
    const hiddenSet = new Set(hidden)

    // Past sessions first, so a live event can enrich the same record.
    for (const s of sessions) {
      if (now - s.updatedAt > SESSION_MAX_AGE_MS) continue
      if (hiddenSet.has(s.sessionId)) continue
      const roomId = roomIdFor(s.cwd)
      if (!roomId) continue
      byKey.set(s.sessionId, {
        key: s.sessionId,
        sessionId: s.sessionId,
        name: s.title || baseName(s.cwd),
        role: s.title || 'Agent',
        task: s.lastPrompt,
        status: 'idle',
        roomId,
        cwd: s.cwd,
        branch: s.gitBranch,
        contextTokens: s.contextTokens,
        contextLimit: s.contextLimit,
        lastActive: s.updatedAt,
        live: false,
        hasEnvelope: false,
        aheadCommits: 0,
        dirtyFiles: 0,
        isOrchestrator: /orchestrat/i.test(s.title)
      })
    }

    for (const { event, at } of liveList) {
      const key = crewKey(event)
      const roomId = roomIdFor(event.projectPath)
      if (!roomId) continue
      const existing = byKey.get(key)
      byKey.set(key, {
        key,
        sessionId: event.sessionId,
        name: event.agentName || existing?.name || 'Agent',
        role: event.role || existing?.role || 'Agent',
        task: event.task || existing?.task || '',
        status: statusFor(event),
        roomId,
        cwd: event.projectPath || existing?.cwd || '',
        branch: existing?.branch ?? '',
        contextTokens: existing?.contextTokens ?? 0,
        contextLimit: existing?.contextLimit ?? 200_000,
        lastActive: at,
        lastHookAt: at,
        lastHookEvent: event.hookEvent,
        live: now - at < LIVE_WINDOW_MS,
        hasEnvelope: false,
        aheadCommits: 0,
        dirtyFiles: 0,
        isOrchestrator: /orchestrat/i.test(event.role) || /orchestrat/i.test(event.agentName)
      })
    }

    // Liveness comes from Claude Code itself: hook events only fire on tool
    // use, so a session mid-conversation looks dead to them. A process that
    // Claude Code reports as running is running.
    for (const agent of byKey.values()) {
      const proc = runningBySession.get(agent.sessionId)
      if (proc) {
        agent.live = true
        agent.pid = proc.pid
        agent.kind = proc.kind
        agent.procStatus = proc.status
        agent.procState = proc.state
        agent.waitingFor = proc.waitingFor
        if (!agent.status || agent.status === 'idle') agent.status = 'in session'
      }
    }

    // Layer git state on: branch, and whether there's work not on the base
    // branch yet (the envelope).
    for (const agent of byKey.values()) {
      const git = gitStates.get(agent.cwd)
      if (!git?.isRepo) continue
      if (!agent.branch) agent.branch = git.branch
      agent.aheadCommits = git.ahead
      agent.dirtyFiles = git.dirtyFiles
      agent.gitHead = git.head
      agent.hasEnvelope = git.hasUnmergedWork
    }

    // Keep each room to its most recent crew so the canvas stays readable.
    const perRoom = new Map<string, Agent[]>()
    for (const agent of byKey.values()) {
      const list = perRoom.get(agent.roomId) ?? []
      list.push(agent)
      perRoom.set(agent.roomId, list)
    }

    const out: Agent[] = []
    for (const list of perRoom.values()) {
      list.sort((a, b) => Number(b.live) - Number(a.live) || b.lastActive - a.lastActive)
      out.push(...list.slice(0, MAX_AGENTS_PER_ROOM))
    }
    return out
  }, [sessions, liveList, roomIdFor, gitStates, runningBySession, hidden])

  // Sessions the user removed from a room, kept only so the room's "bring
  // back" menu can list them and reopen one on request.
  const hiddenByRoom = useMemo(() => {
    const map = new Map<string, HiddenAgent[]>()
    if (!hidden.length) return map
    const hiddenSet = new Set(hidden)
    for (const s of sessions) {
      if (!hiddenSet.has(s.sessionId)) continue
      const roomId = roomIdFor(s.cwd)
      if (!roomId) continue
      const list = map.get(roomId) ?? []
      list.push({ sessionId: s.sessionId, name: s.title || baseName(s.cwd), roomId, lastActive: s.updatedAt })
      map.set(roomId, list)
    }
    for (const list of map.values()) list.sort((a, b) => b.lastActive - a.lastActive)
    return map
  }, [sessions, hidden, roomIdFor])

  // --- git polling -------------------------------------------------------

  const cwdKey = useMemo(
    () => [...new Set(agents.map((a) => a.cwd).filter(Boolean))].sort().join('|'),
    [agents]
  )
  const cwdKeyRef = useRef(cwdKey)
  cwdKeyRef.current = cwdKey

  useEffect(() => {
    let cancelled = false

    async function poll(): Promise<void> {
      const cwds = cwdKeyRef.current.split('|').filter(Boolean)
      const next = new Map<string, GitState>()
      for (const cwd of cwds) {
        try {
          next.set(cwd, await window.agentShip.gitState(cwd))
        } catch {
          // A path that vanished or isn't a repo - just leave it out.
        }
      }
      if (!cancelled) setGitStates(next)
    }

    void poll()
    const timer = setInterval(() => void poll(), 20_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [cwdKey])

  const hideAgent = useCallback(
    async (sessionId: string) => {
      const next = [...new Set([...hidden, sessionId])]
      setHiddenState(next)
      await window.agentShip.setHidden(next)
    },
    [hidden]
  )

  // Un-hides the session and reopens it in Claude Code - the running session
  // is what puts the agent back on the canvas, via the same hook events and
  // `listRunning` poll that drive every other live agent.
  const restoreAgent = useCallback(
    async (sessionId: string) => {
      const next = hidden.filter((id) => id !== sessionId)
      setHiddenState(next)
      await window.agentShip.setHidden(next)
      await window.agentShip.openSession(sessionId)
    },
    [hidden]
  )

  const unhideAll = useCallback(async () => {
    setHiddenState([])
    await window.agentShip.setHidden([])
  }, [])

  const setBudget = useCallback(async (weeklyTokenBudget: number) => {
    setSettings(await window.agentShip.setSettings({ weeklyTokenBudget }))
  }, [])

  const gitStateFor = useCallback((cwd: string) => gitStates.get(cwd), [gitStates])

  return {
    rooms,
    agents,
    projects,
    settings,
    weeklyTokens,
    refreshProjects,
    refreshSessions,
    setBudget,
    gitStateFor,
    hideAgent,
    restoreAgent,
    unhideAll,
    hiddenCount: hidden.length,
    hiddenByRoom
  }
}

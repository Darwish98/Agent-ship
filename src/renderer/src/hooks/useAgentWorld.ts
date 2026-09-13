import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentEvent, GitState, Project, SessionSummary, Settings } from '../../../preload'
import type { Agent, Room } from '../types'

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
}

export function useAgentWorld(): World {
  const [projects, setProjects] = useState<Project[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
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
    setSessions(await window.agentShip.listSessions())
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

  const agents = useMemo<Agent[]>(() => {
    const byKey = new Map<string, Agent>()
    const now = Date.now()

    // Past sessions first, so a live event can enrich the same record.
    for (const s of sessions) {
      if (now - s.updatedAt > SESSION_MAX_AGE_MS) continue
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
        live: now - at < LIVE_WINDOW_MS,
        hasEnvelope: false,
        aheadCommits: 0,
        dirtyFiles: 0,
        isOrchestrator: /orchestrat/i.test(event.role) || /orchestrat/i.test(event.agentName)
      })
    }

    // Layer git state on: branch, and whether there's work not on the base
    // branch yet (the envelope).
    for (const agent of byKey.values()) {
      const git = gitStates.get(agent.cwd)
      if (!git?.isRepo) continue
      if (!agent.branch) agent.branch = git.branch
      agent.aheadCommits = git.ahead
      agent.dirtyFiles = git.dirtyFiles
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
  }, [sessions, liveList, roomIdFor, gitStates])

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
    gitStateFor
  }
}

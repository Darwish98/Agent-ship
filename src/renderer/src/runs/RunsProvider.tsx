import { createContext, useCallback, useContext, useEffect, useMemo, useState, type JSX, type ReactNode } from 'react'
import type { StartRunResult } from '../../../preload'
import { foldRun, isActive, type RunEvent, type RunView } from '../../../shared/runs'

interface RunsApi {
  /** Newest first. */
  runs: RunView[]
  /** The run to show for a flow: an active one, else the most recent. */
  runFor: (projectId: string, slug: string) => RunView | undefined
  start: (projectId: string, slug: string, inputs: Record<string, string>) => Promise<StartRunResult>
  cancel: (runId: string) => Promise<void>
  resume: (runId: string) => Promise<StartRunResult>
  decide: (runId: string, approve: boolean, note: string) => Promise<void>
  acknowledged: ReadonlySet<string>
  acknowledge: (runId: string) => void
}

const Ctx = createContext<RunsApi | null>(null)

const ACK_KEY = 'agentship.ackRuns'

function loadAcks(): Set<string> {
  try {
    const raw = window.localStorage.getItem(ACK_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

/** Holds every run the app knows about. Events arrive from the main process;
 *  the view of a run is always a fold of its events, never separate state. */
export function RunsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [events, setEvents] = useState<Map<string, RunEvent[]>>(new Map())
  const [acked, setAcked] = useState<Set<string>>(loadAcks)

  useEffect(() => {
    void window.agentShip.listRuns().then((list) => {
      setEvents((prev) => {
        const next = new Map(prev)
        // Live events that raced ahead of this load win; do not clobber them.
        for (const { runId, events: e } of list) if (!next.has(runId)) next.set(runId, e)
        return next
      })
    })
    return window.agentShip.onRunEvent((e) => {
      setEvents((prev) => {
        const next = new Map(prev)
        next.set(e.runId, [...(next.get(e.runId) ?? []), e])
        return next
      })
    })
  }, [])

  const runs = useMemo(
    () =>
      [...events.values()]
        .map((e) => foldRun(e))
        .filter((r): r is RunView => r !== null)
        .sort((a, b) => b.startedAt - a.startedAt),
    [events]
  )

  const runFor = useCallback(
    (projectId: string, slug: string): RunView | undefined => {
      const mine = runs.filter((r) => r.projectId === projectId && r.flowSlug === slug)
      return mine.find((r) => isActive(r.status)) ?? mine[0]
    },
    [runs]
  )

  const acknowledge = useCallback((runId: string) => {
    setAcked((prev) => {
      const next = new Set(prev).add(runId)
      try {
        window.localStorage.setItem(ACK_KEY, JSON.stringify([...next].slice(-200)))
      } catch {
        /* a per-viewer convenience; fine to lose */
      }
      return next
    })
  }, [])

  const api = useMemo<RunsApi>(
    () => ({
      runs,
      runFor,
      start: (p, s, i) => window.agentShip.startRun(p, s, i),
      cancel: async (id) => void (await window.agentShip.cancelRun(id)),
      resume: (id) => window.agentShip.resumeRun(id),
      decide: async (id, approve, note) => void (await window.agentShip.decideGate(id, approve, note)),
      acknowledged: acked,
      acknowledge
    }),
    [runs, runFor, acked, acknowledge]
  )

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>
}

export function useRuns(): RunsApi {
  const v = useContext(Ctx)
  if (!v) throw new Error('useRuns outside RunsProvider')
  return v
}

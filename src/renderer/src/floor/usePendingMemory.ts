import { useEffect, useRef, useState } from 'react'
import { whoClearedIt, type PendingEpisode } from '../../../shared/floor'
import type { RunView } from '../../../shared/runs'
import type { Agent } from '../types'

const MEMORY_KEY = 'agentship.pendingEpisodes'
const HANDLED_KEY = 'agentship.handledAt'

function load<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function save(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* a per-viewer convenience: fine to lose */
  }
}

/**
 * Notices work that was committed by hand. While a session holds uncommitted
 * files (or unmerged commits) we keep an "episode": where its checkout was and
 * when the work first appeared. When the work is later gone, whoClearedIt
 * decides whether an Agent Ship landing took it (the card then shows that
 * landing's real pipeline) or you did (the card says "by hand").
 *
 * Git cannot say which session made a commit, so this is an observation of
 * what we saw happen, not a proof. It is only ever used to label a stage
 * "by hand", never to claim Agent Ship tested or landed anything.
 */
export function useHandledByHand(agents: Agent[], runs: RunView[]): Readonly<Record<string, number>> {
  const episodes = useRef<Record<string, PendingEpisode>>(load(MEMORY_KEY, {}))
  const [handled, setHandled] = useState<Record<string, number>>(() => load(HANDLED_KEY, {}))

  useEffect(() => {
    const now = Date.now()
    let changed = false
    const next = { ...handled }
    for (const a of agents) {
      if (!a.gitHead) continue // no git information yet: do not conclude anything
      const pending = a.dirtyFiles > 0 || a.aheadCommits > 0
      const before = episodes.current[a.sessionId]
      if (pending) {
        const shape = !before || before.head !== a.gitHead || before.dirty !== a.dirtyFiles || before.ahead !== a.aheadCommits
        if (shape) {
          // Same episode while the work is still there: `since` only moves when a new one begins.
          episodes.current[a.sessionId] = { head: a.gitHead, dirty: a.dirtyFiles, ahead: a.aheadCommits, since: before?.since ?? now }
          changed = true
        }
        // New work after an earlier hand-commit is pending again, not "by hand".
        if (a.sessionId in next) {
          delete next[a.sessionId]
          changed = true
        }
      } else if (before) {
        if (whoClearedIt(before, a.gitHead, runs, a.sessionId) === 'hand') next[a.sessionId] = now
        delete episodes.current[a.sessionId]
        changed = true
      }
    }
    if (changed) {
      save(MEMORY_KEY, episodes.current)
      const keep = Object.entries(next).sort((x, y) => y[1] - x[1]).slice(0, 300)
      save(HANDLED_KEY, Object.fromEntries(keep))
      setHandled(next)
    }
    // `handled` is deliberately not a dependency: this effect is what updates it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, runs])

  return handled
}

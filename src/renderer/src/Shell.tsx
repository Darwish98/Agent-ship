import { useCallback, useMemo, useState, type JSX } from 'react'
import { BlueprintEditor } from './blueprint/BlueprintEditor'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Floor } from './floor/Floor'
import { WorldProvider } from './hooks/world'
import { NavContext, type FlowFocus, type Mode, type Nav } from './nav'
import { RunDialog, type RunTarget } from './runs/RunDialog'
import { RunsProvider, useRuns } from './runs/RunsProvider'

const MODES: { id: Mode; label: string; icon: string }[] = [
  { id: 'floor', label: 'Floor', icon: '▦' },
  { id: 'blueprint', label: 'Blueprints', icon: '⛓' }
]

/** Mode switcher. Both views stay mounted and only one is shown: the Floor
 *  keeps receiving agent events while you edit, and the editor keeps its
 *  undo history when you look away. */
export function Shell(): JSX.Element {
  return (
    <RunsProvider>
      <WorldProvider>
        <ShellInner />
      </WorldProvider>
    </RunsProvider>
  )
}

function ShellInner(): JSX.Element {
  const [mode, setMode] = useState<Mode>('floor')
  const [focus, setFocus] = useState<FlowFocus | null>(null)
  const [runTarget, setRunTarget] = useState<RunTarget | null>(null)
  const { runs } = useRuns()

  const nav = useMemo<Nav>(
    () => ({
      mode,
      setMode,
      openFlow: (projectId, slug, nodeId) => {
        setFocus({ projectId, slug, nodeId, nonce: Date.now() })
        setMode('blueprint')
      },
      requestRun: (projectId, slug, initialInputs) => setRunTarget({ projectId, slug, initialInputs }),
      focus,
      clearFocus: () => setFocus(null)
    }),
    [mode, focus]
  )
  const closeRun = useCallback(() => setRunTarget(null), [])

  // The rail wears the same signal the Floor's first lane does: a badge when a
  // run is waiting on you, visible from the editor too.
  const waiting = runs.filter((r) => r.status === 'awaiting').length

  return (
    <NavContext.Provider value={nav}>
      <div className="shell">
        <nav className="rail" aria-label="Views">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`rail-btn${mode === m.id ? ' rail-btn-on' : ''}`}
              onClick={() => setMode(m.id)}
              title={m.label}
              aria-current={mode === m.id ? 'page' : undefined}
            >
              <span className="rail-icon">{m.icon}</span>
              <span className="rail-label">{m.label}</span>
              {m.id === 'floor' && waiting > 0 && <span className="rail-badge">{waiting}</span>}
            </button>
          ))}
        </nav>

        <div className="shell-view" hidden={mode !== 'floor'}>
          <ErrorBoundary label="The floor">
            <Floor active={mode === 'floor'} />
          </ErrorBoundary>
        </div>
        <div className="shell-view" hidden={mode !== 'blueprint'}>
          <ErrorBoundary label="The blueprint editor">
            <BlueprintEditor active={mode === 'blueprint'} />
          </ErrorBoundary>
        </div>

        {runTarget && <RunDialog target={runTarget} onClose={closeRun} />}
      </div>
    </NavContext.Provider>
  )
}

import { useState, type JSX } from 'react'
import App from './App'
import { BlueprintEditor } from './blueprint/BlueprintEditor'
import { ErrorBoundary } from './components/ErrorBoundary'

type Mode = 'floor' | 'blueprint'

const MODES: { id: Mode; label: string; icon: string }[] = [
  { id: 'floor', label: 'Floor', icon: '▦' },
  { id: 'blueprint', label: 'Blueprints', icon: '⛓' }
]

/** Mode switcher. Both views stay mounted and only one is shown: the Floor
 *  keeps receiving agent events while you edit, and the editor keeps its
 *  undo history when you look away. */
export function Shell(): JSX.Element {
  const [mode, setMode] = useState<Mode>('floor')

  return (
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
          </button>
        ))}
      </nav>

      <div className="shell-view" hidden={mode !== 'floor'}>
        <ErrorBoundary label="The floor">
          <App />
        </ErrorBoundary>
      </div>
      <div className="shell-view" hidden={mode !== 'blueprint'}>
        <ErrorBoundary label="The blueprint editor">
          <BlueprintEditor active={mode === 'blueprint'} />
        </ErrorBoundary>
      </div>
    </div>
  )
}

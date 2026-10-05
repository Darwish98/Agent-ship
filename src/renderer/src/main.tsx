import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from './components/ErrorBoundary'
import { initTheme } from './lib/theme'
import { Shell } from './Shell'
import './styles.css'
import './platform.css'
import './floor.css'

initTheme()

// Opened in a plain browser during development there is no preload bridge,
// so stand one up with sample data. Stripped from production builds.
if (import.meta.env.DEV && !window.agentShip) {
  const { installDevMock } = await import('./lib/devMock')
  installDevMock()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <Shell />
    </ErrorBoundary>
  </StrictMode>
)

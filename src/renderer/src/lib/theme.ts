import { useCallback, useState } from 'react'

export type Theme = 'light' | 'dark'

const KEY = 'agent-ship:theme'

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    // storage unavailable: fall through to the OS preference
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme
}

/** Set the saved (or OS-preferred) theme before first paint. */
export function initTheme(): void {
  apply(initialTheme())
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'))
  const toggle = useCallback(() => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    apply(next)
    try {
      localStorage.setItem(KEY, next)
    } catch {
      // not persisted; still applies for this session
    }
    setTheme(next)
  }, [theme])
  return { theme, toggle }
}

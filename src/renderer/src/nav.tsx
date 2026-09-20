import { createContext, useContext } from 'react'

export type Mode = 'floor' | 'blueprint'

export interface FlowFocus {
  projectId: string
  slug: string
  nodeId?: string
  /** Changes on every request so asking for the same flow twice still fires. */
  nonce: number
}

/** How the Floor and the Blueprint editor reach each other. */
export interface Nav {
  mode: Mode
  setMode: (m: Mode) => void
  /** Open a flow in the editor, optionally selecting one of its nodes. */
  openFlow: (projectId: string, slug: string, nodeId?: string) => void
  /** Ask to run a flow: shows the confirmation of exactly what will execute. */
  requestRun: (projectId: string, slug: string) => void
  focus: FlowFocus | null
  clearFocus: () => void
}

export const NavContext = createContext<Nav | null>(null)

export function useNav(): Nav {
  const v = useContext(NavContext)
  if (!v) throw new Error('useNav outside NavContext')
  return v
}

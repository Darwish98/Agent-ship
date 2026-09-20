import { createContext, useContext, type JSX, type ReactNode } from 'react'
import { useAgentWorld, type World } from './useAgentWorld'

const Ctx = createContext<World | null>(null)

/** One shared view of "the projects and sessions on this machine", so the
 *  Floor and the Blueprints tab can never disagree about which projects
 *  exist (they once did: the editor only knew registered ones). */
export function WorldProvider({ children }: { children: ReactNode }): JSX.Element {
  const world = useAgentWorld()
  return <Ctx.Provider value={world}>{children}</Ctx.Provider>
}

export function useWorld(): World {
  const v = useContext(Ctx)
  if (!v) throw new Error('useWorld outside WorldProvider')
  return v
}

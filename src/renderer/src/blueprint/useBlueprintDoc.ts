import { useCallback, useRef, useState } from 'react'
import type { Blueprint } from '../../../shared/schema'

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

const HISTORY_LIMIT = 100
const COALESCE_MS = 900
const AUTOSAVE_MS = 700

export interface BlueprintDoc {
  slug: string | null
  bp: Blueprint | null
  saveState: SaveState
  saveError: string
  canUndo: boolean
  canRedo: boolean
  open: (slug: string, bp: Blueprint) => void
  /** Leaves the flow, saving any pending edit first. Callers switching
   *  project must await this BEFORE changing `projectId`. */
  close: () => Promise<void>
  /** `key` merges rapid edits of the same field into one undo step. */
  commit: (next: Blueprint, key?: string) => void
  undo: () => void
  redo: () => void
  flush: () => Promise<void>
}

/**
 * Owns the open blueprint: undo/redo history and debounced autosave to the
 * repo. Every edit is a whole new blueprint value, which keeps history a plain
 * stack of snapshots and makes "what did the user change" a diff of two JSON
 * files.
 */
export function useBlueprintDoc(projectId: string): BlueprintDoc {
  const [state, setState] = useState<{ slug: string | null; bp: Blueprint | null }>({
    slug: null,
    bp: null
  })
  const current = useRef(state)
  const past = useRef<Blueprint[]>([])
  const future = useRef<Blueprint[]>([])
  const lastEdit = useRef<{ key: string; at: number } | null>(null)
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const project = useRef(projectId)
  project.current = projectId

  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState('')
  const [, rerender] = useState(0)

  const apply = useCallback((next: { slug: string | null; bp: Blueprint | null }) => {
    current.current = next
    setState(next)
  }, [])

  const flush = useCallback(async (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const { slug, bp } = current.current
    if (!dirty.current || !slug || !bp) return
    dirty.current = false
    setSaveState('saving')
    const result = await window.agentShip.saveFlow(project.current, slug, bp)
    if (result.ok) {
      // A newer edit may have landed while saving; only claim "saved" if not.
      setSaveState(dirty.current ? 'dirty' : 'saved')
    } else {
      dirty.current = true
      setSaveError(result.error)
      setSaveState('error')
    }
  }, [])

  const markDirty = useCallback(() => {
    dirty.current = true
    setSaveState('dirty')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), AUTOSAVE_MS)
  }, [flush])

  const open = useCallback(
    (slug: string, bp: Blueprint) => {
      past.current = []
      future.current = []
      lastEdit.current = null
      dirty.current = false
      setSaveState('idle')
      setSaveError('')
      apply({ slug, bp })
      rerender((n) => n + 1)
    },
    [apply]
  )

  const close = useCallback(async () => {
    await flush()
    apply({ slug: null, bp: null })
    setSaveState('idle')
  }, [apply, flush])

  const commit = useCallback(
    (next: Blueprint, key?: string) => {
      const prev = current.current.bp
      if (!prev) return
      const now = Date.now()
      const merge = key && lastEdit.current?.key === key && now - lastEdit.current.at < COALESCE_MS
      if (!merge) {
        past.current.push(prev)
        if (past.current.length > HISTORY_LIMIT) past.current.shift()
      }
      lastEdit.current = key ? { key, at: now } : null
      future.current = []
      apply({ slug: current.current.slug, bp: next })
      markDirty()
    },
    [apply, markDirty]
  )

  const undo = useCallback(() => {
    const prev = past.current.pop()
    const now = current.current.bp
    if (!prev || !now) return
    future.current.push(now)
    lastEdit.current = null
    apply({ slug: current.current.slug, bp: prev })
    markDirty()
  }, [apply, markDirty])

  const redo = useCallback(() => {
    const next = future.current.pop()
    const now = current.current.bp
    if (!next || !now) return
    past.current.push(now)
    lastEdit.current = null
    apply({ slug: current.current.slug, bp: next })
    markDirty()
  }, [apply, markDirty])

  return {
    slug: state.slug,
    bp: state.bp,
    saveState,
    saveError,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    open,
    close,
    commit,
    undo,
    redo,
    flush
  }
}

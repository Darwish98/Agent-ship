import { useCallback, useEffect, useRef, useState } from 'react'
import type { Blueprint } from '../../../shared/schema'

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict'

const HISTORY_LIMIT = 100
const COALESCE_MS = 900
const AUTOSAVE_MS = 700
const EXTERNAL_POLL_MS = 3000

export interface BlueprintDoc {
  slug: string | null
  bp: Blueprint | null
  saveState: SaveState
  saveError: string
  /** Set briefly after the file was replaced on disk and reloaded silently. */
  reloadedFromDisk: boolean
  canUndo: boolean
  canRedo: boolean
  open: (slug: string, bp: Blueprint, hash: string) => void
  /** Leaves the flow, saving any pending edit first. Callers switching
   *  project must await this BEFORE changing `projectId`. */
  close: () => Promise<void>
  /** `key` merges rapid edits of the same field into one undo step. */
  commit: (next: Blueprint, key?: string) => void
  undo: () => void
  redo: () => void
  flush: () => Promise<void>
  /** After a conflict: take the file on disk, or overwrite it with this copy. */
  resolveConflict: (keep: 'theirs' | 'mine') => Promise<void>
}

/**
 * Owns the open blueprint: undo/redo history, debounced autosave, and the
 * guard against clobbering edits that arrive through git. Every edit is a
 * whole new blueprint value, which keeps history a plain stack of snapshots.
 */
export function useBlueprintDoc(projectId: string, active: boolean): BlueprintDoc {
  const [state, setState] = useState<{ slug: string | null; bp: Blueprint | null }>({ slug: null, bp: null })
  const current = useRef(state)
  const past = useRef<Blueprint[]>([])
  const future = useRef<Blueprint[]>([])
  const lastEdit = useRef<{ key: string; at: number } | null>(null)
  const dirty = useRef(false)
  const hash = useRef<string>('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const project = useRef(projectId)
  project.current = projectId

  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState('')
  const [reloadedFromDisk, setReloaded] = useState(false)
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
    const result = await window.agentShip.saveFlow(project.current, slug, bp, hash.current)
    if (result.ok) {
      hash.current = result.hash
      // A newer edit may have landed while saving; only claim "saved" if not.
      setSaveState(dirty.current ? 'dirty' : 'saved')
    } else {
      dirty.current = true
      setSaveError(result.error)
      setSaveState(result.conflict ? 'conflict' : 'error')
    }
  }, [])

  const markDirty = useCallback(() => {
    dirty.current = true
    setSaveState('dirty')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), AUTOSAVE_MS)
  }, [flush])

  const open = useCallback(
    (slug: string, bp: Blueprint, fileHash: string) => {
      past.current = []
      future.current = []
      lastEdit.current = null
      dirty.current = false
      hash.current = fileHash
      setSaveState('idle')
      setSaveError('')
      apply({ slug, bp })
      rerender((n) => n + 1)
    },
    [apply]
  )

  const close = useCallback(async () => {
    // A conflicted copy is not written on the way out; the file on disk wins.
    if (saveState !== 'conflict') await flush()
    dirty.current = false
    apply({ slug: null, bp: null })
    setSaveState('idle')
  }, [apply, flush, saveState])

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

  const resolveConflict = useCallback(
    async (keep: 'theirs' | 'mine') => {
      const { slug, bp } = current.current
      if (!slug || !bp) return
      if (keep === 'mine') {
        const r = await window.agentShip.saveFlow(project.current, slug, bp) // deliberate overwrite
        if (r.ok) {
          hash.current = r.hash
          dirty.current = false
          setSaveState('saved')
        } else setSaveError(r.error)
        return
      }
      const r = await window.agentShip.loadFlow(project.current, slug)
      if (r.ok) open(slug, r.blueprint, r.hash)
      else setSaveError(r.error)
    },
    [open]
  )

  // The file lives in git, so pulls and checkouts can change it under us. With
  // no unsaved edits, follow the disk; with unsaved edits, the next save will
  // hit the compare-and-swap and raise a conflict instead of overwriting.
  useEffect(() => {
    if (!active) return
    const id = setInterval(async () => {
      const { slug } = current.current
      if (!slug || dirty.current) return
      const onDisk = await window.agentShip.peekFlow(project.current, slug)
      if (onDisk === null || onDisk === hash.current) return
      const r = await window.agentShip.loadFlow(project.current, slug)
      if (r.ok && !dirty.current) {
        open(slug, r.blueprint, r.hash)
        setReloaded(true)
        setTimeout(() => setReloaded(false), 4000)
      }
    }, EXTERNAL_POLL_MS)
    return () => clearInterval(id)
  }, [active, open])

  return {
    slug: state.slug,
    bp: state.bp,
    saveState,
    saveError,
    reloadedFromDisk,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    open,
    close,
    commit,
    undo,
    redo,
    flush,
    resolveConflict
  }
}

import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type ReactFlowInstance
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type JSX } from 'react'
import type { FlowSummary, Project } from '../../../preload'
import { hasErrors, makeNode, newId, NODE_KINDS, slugify, unrunnableReasons, validateBlueprint } from '../../../shared/blueprint'
import { formatUsd, isActive } from '../../../shared/runs'
import { emptyBlueprint, fromPattern, PATTERNS } from '../../../shared/patterns'
import type { Blueprint, BlueprintEdge, BlueprintNode, NodeKind } from '../../../shared/schema'
import { useNav } from '../nav'
import { RunDetail, SpendMeter, STATUS_LABEL } from '../runs/RunDetail'
import { useRuns } from '../runs/RunsProvider'
import { BlueprintNodeView, type BpNodeData } from './BlueprintNodeView'
import { Inspector } from './Inspector'
import { useBlueprintDoc } from './useBlueprintDoc'

const nodeTypes = { bp: BlueprintNodeView }
const DRAG_TYPE = 'application/x-agentship-node'

const SAVE_LABEL = {
  idle: '',
  dirty: 'Unsaved…',
  saving: 'Saving…',
  saved: 'Saved to .agentship/flows',
  error: 'Save failed',
  conflict: 'Changed on disk'
} as const

/** Parallel and merge steps can be drawn but the engine cannot run them yet. */
const DESIGN_ONLY = new Set<NodeKind>(['fanout', 'join', 'merge'])

function edgeType(from: BlueprintNode, taken: BlueprintEdge[]): Pick<BlueprintEdge, 'type' | 'condition'> {
  if (from.kind === 'trigger') return { type: 'control', condition: 'always' }
  if (from.kind === 'gate') {
    const hasPass = taken.some((e) => e.from === from.id && e.condition === 'pass')
    return { type: 'verdict', condition: hasPass ? 'fail' : 'pass' }
  }
  if (from.kind === 'agent' && from.config.worktree) return { type: 'branch', condition: 'always' }
  return { type: 'artifact', condition: 'always' }
}

export function BlueprintEditor({ active }: { active: boolean }): JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState('')
  const [flows, setFlows] = useState<FlowSummary[]>([])
  const [loadError, setLoadError] = useState('')

  const doc = useBlueprintDoc(projectId, active)
  const nav = useNav()
  const runs = useRuns()
  const [showRun, setShowRun] = useState(false)
  const { bp } = doc
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const rf = useRef<ReactFlowInstance | null>(null)

  const refreshFlows = useCallback(async (id: string) => {
    setFlows(id ? await window.agentShip.listFlows(id) : [])
  }, [])

  // Projects come from the same registry as the Floor's rooms.
  useEffect(() => {
    if (!active) return
    void window.agentShip.listProjects().then((list) => {
      setProjects(list)
      setProjectId((cur) => (list.some((p) => p.id === cur) ? cur : (list[0]?.id ?? '')))
    })
  }, [active])

  useEffect(() => {
    void refreshFlows(projectId)
  }, [projectId, refreshFlows])

  const switchProject = useCallback(
    async (id: string) => {
      // Save against the project the flow belongs to BEFORE the id changes.
      await doc.close()
      setSelectedId(null)
      setSelectedEdgeId(null)
      setProjectId(id)
    },
    [doc]
  )

  const openFlow = useCallback(
    async (slug: string) => {
      setLoadError('')
      const result = await window.agentShip.loadFlow(projectId, slug)
      if (!result.ok) {
        setLoadError(`Could not open "${slug}": ${result.error}`)
        return
      }
      setSelectedId(null)
      setSelectedEdgeId(null)
      doc.open(slug, result.blueprint, result.hash)
    },
    [projectId, doc]
  )

  const createFlow = useCallback(
    async (blueprint: Blueprint) => {
      if (!projectId) return
      const taken = new Set(flows.map((f) => f.slug))
      const base = slugify(blueprint.name)
      let slug = base
      for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`
      const result = await window.agentShip.saveFlow(projectId, slug, blueprint, null)
      if (!result.ok) {
        setLoadError(`Could not create the flow: ${result.error}`)
        return
      }
      await refreshFlows(projectId)
      setSelectedId(null)
      setSelectedEdgeId(null)
      doc.open(slug, result.blueprint, result.hash)
    },
    [projectId, flows, doc, refreshFlows]
  )

  const closeFlow = useCallback(async () => {
    await doc.close()
    setSelectedId(null)
    setSelectedEdgeId(null)
    await refreshFlows(projectId)
  }, [doc, projectId, refreshFlows])

  const removeFlow = useCallback(
    async (f: FlowSummary) => {
      if (!window.confirm(`Delete the flow "${f.name}"? The file ${f.slug}.flow.json is removed from the repo.`)) return
      await window.agentShip.deleteFlow(projectId, f.slug)
      await refreshFlows(projectId)
    },
    [projectId, refreshFlows]
  )

  // Asked to open a particular flow (and node) from the Floor.
  const { focus, clearFocus } = nav
  useEffect(() => {
    if (!focus) return
    void (async () => {
      clearFocus()
      if (focus.projectId !== projectId) await switchProject(focus.projectId)
      const result = await window.agentShip.loadFlow(focus.projectId, focus.slug)
      if (!result.ok) {
        setLoadError(`Could not open "${focus.slug}": ${result.error}`)
        return
      }
      setProjectId(focus.projectId)
      doc.open(focus.slug, result.blueprint, result.hash)
      setSelectedId(focus.nodeId ?? null)
      setSelectedEdgeId(null)
      setShowRun(true)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus])

  const run = doc.slug ? runs.runFor(projectId, doc.slug) : undefined
  const runActive = Boolean(run && isActive(run.status))

  // --- editing ---------------------------------------------------------------

  const problems = useMemo(() => (bp ? validateBlueprint(bp) : []), [bp])
  const runBlockers = useMemo(() => (bp ? unrunnableReasons(bp) : []), [bp])
  const perNode = useMemo(() => {
    const m = new Map<string, { errors: number; warnings: number }>()
    for (const p of problems) {
      if (!p.nodeId) continue
      const cur = m.get(p.nodeId) ?? { errors: 0, warnings: 0 }
      if (p.severity === 'error') cur.errors++
      else cur.warnings++
      m.set(p.nodeId, cur)
    }
    return m
  }, [problems])

  const patchNode = useCallback(
    (next: BlueprintNode, key: string) => {
      if (!bp) return
      doc.commit({ ...bp, nodes: bp.nodes.map((n) => (n.id === next.id ? next : n)) }, key)
    },
    [bp, doc]
  )

  const addNode = useCallback(
    (kind: NodeKind, at?: { x: number; y: number }) => {
      if (!bp) return
      const id = newId(kind, bp.nodes.map((n) => n.id))
      const right = bp.nodes.reduce((m, n) => Math.max(m, n.position.x), -290)
      const position = at ?? { x: right + 290, y: 0 }
      doc.commit({ ...bp, nodes: [...bp.nodes, makeNode(kind, id, position)] })
      setSelectedId(id)
      setSelectedEdgeId(null)
    },
    [bp, doc]
  )

  const deleteSelection = useCallback(() => {
    if (!bp) return
    if (selectedId) {
      doc.commit({
        ...bp,
        nodes: bp.nodes.filter((n) => n.id !== selectedId),
        edges: bp.edges.filter((e) => e.from !== selectedId && e.to !== selectedId)
      })
      setSelectedId(null)
    } else if (selectedEdgeId) {
      doc.commit({ ...bp, edges: bp.edges.filter((e) => e.id !== selectedEdgeId) })
      setSelectedEdgeId(null)
    }
  }, [bp, doc, selectedId, selectedEdgeId])

  const onConnect = useCallback(
    (c: Connection) => {
      if (!bp || !c.source || !c.target || c.source === c.target) return
      const from = bp.nodes.find((n) => n.id === c.source)
      const to = bp.nodes.find((n) => n.id === c.target)
      if (!from || !to || to.kind === 'trigger') return
      const meta = edgeType(from, bp.edges)
      const duplicate = bp.edges.some((e) => e.from === c.source && e.to === c.target && e.condition === meta.condition)
      if (duplicate) return
      const suffix = meta.condition === 'fail' ? ':fail' : ''
      doc.commit({
        ...bp,
        edges: [...bp.edges, { id: `${c.source}->${c.target}${suffix}`, from: c.source, to: c.target, ...meta }]
      })
    },
    [bp, doc]
  )

  // Undo/redo/delete shortcuts, but never while typing in a field.
  useEffect(() => {
    if (!active || !bp) return
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) doc.redo()
        else doc.undo()
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        doc.redo()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        deleteSelection()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, bp, doc, deleteSelection])

  // --- graph -----------------------------------------------------------------
  // Same rule the Floor learned the hard way: React Flow hides any node it has
  // not measured, and only remembers a measurement if the app keeps it. So the
  // graph is derived from the blueprint, but `measured` is carried across.

  const graphNodes = useMemo<Node[]>(
    () =>
      (bp?.nodes ?? []).map((n) => ({
        id: n.id,
        type: 'bp',
        position: n.position,
        selected: n.id === selectedId,
        data: {
          node: n,
          errors: perNode.get(n.id)?.errors ?? 0,
          warnings: perNode.get(n.id)?.warnings ?? 0,
          run: run?.nodes[n.id]
        } satisfies BpNodeData
      })),
    [bp, selectedId, perNode, run]
  )

  const [nodes, setNodes] = useState<Node[]>([])
  useEffect(() => {
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]))
      return graphNodes.map((n) => {
        const before = old.get(n.id)
        return before?.measured ? { ...n, measured: before.measured } : n
      })
    })
  }, [graphNodes])

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setNodes((ns) => applyNodeChanges(changes, ns)),
    []
  )

  const onNodeDragStop = useCallback(
    (_e: unknown, node: Node) => {
      if (!bp) return
      const moved = bp.nodes.find((n) => n.id === node.id)
      if (!moved || (moved.position.x === node.position.x && moved.position.y === node.position.y)) return
      doc.commit({
        ...bp,
        nodes: bp.nodes.map((n) => (n.id === node.id ? { ...n, position: { x: node.position.x, y: node.position.y } } : n))
      })
    },
    [bp, doc]
  )

  const edges = useMemo<Edge[]>(
    () =>
      (bp?.edges ?? []).map((e) => {
        const fail = e.condition === 'fail'
        return {
          id: e.id,
          source: e.from,
          target: e.to,
          ...(fail ? { sourceHandle: 'fail', targetHandle: 'retry', type: 'smoothstep' } : {}),
          selected: e.id === selectedEdgeId,
          animated: fail,
          label: e.condition === 'always' ? (e.type === 'branch' ? 'branch' : undefined) : e.condition,
          className: `bp-edge bp-edge-${e.condition}`,
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 }
        }
      }),
    [bp, selectedEdgeId]
  )

  const onDrop = useCallback(
    (ev: DragEvent) => {
      ev.preventDefault()
      const kind = ev.dataTransfer.getData(DRAG_TYPE) as NodeKind
      if (!kind || !rf.current) return
      addNode(kind, rf.current.screenToFlowPosition({ x: ev.clientX, y: ev.clientY }))
    },
    [addNode]
  )

  // --- render ----------------------------------------------------------------

  if (!bp) {
    return (
      <Library
        projects={projects}
        projectId={projectId}
        flows={flows}
        error={loadError}
        onProject={(id) => void switchProject(id)}
        onOpen={(slug) => void openFlow(slug)}
        onDelete={(f) => void removeFlow(f)}
        onCreate={(b) => void createFlow(b)}
      />
    )
  }

  const errorCount = problems.filter((p) => p.severity === 'error').length
  const warnCount = problems.length - errorCount
  const selectedNode = bp.nodes.find((n) => n.id === selectedId) ?? null
  const selectedEdge = bp.edges.find((e) => e.id === selectedEdgeId) ?? null

  return (
    <div className="bp-editor">
      <header className="bp-toolbar">
        <button type="button" className="btn" onClick={() => void closeFlow()}>
          ← Flows
        </button>
        <span className="bp-flow-name">{bp.name}</span>
        <span className={`bp-save bp-save-${doc.saveState}`} title={doc.saveError}>
          {doc.saveState === 'error' ? `Save failed: ${doc.saveError}` : SAVE_LABEL[doc.saveState]}
        </span>
        <div className="bp-toolbar-right">
          <button type="button" className="btn" disabled={!doc.canUndo} onClick={doc.undo} title="Undo (Ctrl+Z)">
            ↶
          </button>
          <button type="button" className="btn" disabled={!doc.canRedo} onClick={doc.redo} title="Redo (Ctrl+Shift+Z)">
            ↷
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={runBlockers.length > 0 || runActive || doc.saveState === 'conflict'}
            title={
              runActive
                ? 'This flow is already running.'
                : runBlockers.length
                  ? `Cannot run yet:\n- ${runBlockers.join('\n- ')}`
                  : 'Review what will execute, then start'
            }
            onClick={() => {
              // The engine reads the file from disk, so make sure it is current.
              void doc.flush().then(() => nav.requestRun(projectId, doc.slug!))
            }}
          >
            ▶ Run
          </button>
        </div>
      </header>

      {doc.saveState === 'conflict' && (
        <div className="bp-banner bp-banner-warn">
          <span>
            <strong>This flow changed on disk</strong> (a pull or checkout?) while you had unsaved edits. Nothing was overwritten.
          </span>
          <button type="button" className="btn" onClick={() => void doc.resolveConflict('theirs')}>
            Load the file on disk
          </button>
          <button type="button" className="btn" onClick={() => void doc.resolveConflict('mine')}>
            Keep my version
          </button>
        </div>
      )}
      {doc.reloadedFromDisk && <div className="bp-banner">Reloaded: the file changed on disk.</div>}

      {run && (
        <div className={`bp-runbar bp-runbar-${run.status}`}>
          <strong>{STATUS_LABEL[run.status]}</strong>
          <span className="bp-runbar-meter">
            <SpendMeter spent={run.spentUsd} ceiling={run.ceilingUsd} />
          </span>
          <span className="bp-runbar-sub">
            {formatUsd(run.spentUsd)} spent{run.branch ? ` · branch ${run.branch}` : ''}
          </span>
          <button type="button" className="btn" onClick={() => setShowRun((v) => !v)}>
            {showRun ? 'Hide run' : 'Show run'}
          </button>
        </div>
      )}

      <div className="bp-body">
        <aside className="bp-palette">
          <h3>Add</h3>
          {NODE_KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              className="bp-palette-item"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, k.kind)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onClick={() => addNode(k.kind)}
              title="Click to add, or drag onto the canvas"
            >
              <strong>
                {k.title}
                {DESIGN_ONLY.has(k.kind) && <em className="bp-tag" title="You can draw this, but the run engine cannot execute it yet.">design only</em>}
              </strong>
              <span>{k.blurb}</span>
            </button>
          ))}
        </aside>

        <div className="bp-canvas" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStop={onNodeDragStop}
            onConnect={onConnect}
            onInit={(inst) => {
              rf.current = inst
            }}
            onNodeClick={(_e, n) => {
              setSelectedId(n.id)
              setSelectedEdgeId(null)
            }}
            onEdgeClick={(_e, ed) => {
              setSelectedEdgeId(ed.id)
              setSelectedId(null)
            }}
            onPaneClick={() => {
              setSelectedId(null)
              setSelectedEdgeId(null)
            }}
            deleteKeyCode={null}
            connectionRadius={40}
            minZoom={0.3}
            maxZoom={1.6}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1.3} color="#DCD9CE" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        {showRun && run ? (
          <aside className="inspector bp-rundrawer">
            <RunDetail run={run} inEditor onSelectNode={(id) => setSelectedId(id)} />
          </aside>
        ) : (
        <Inspector
          bp={bp}
          node={selectedNode}
          edge={selectedEdge}
          onNode={patchNode}
          onFlow={(next, key) => doc.commit(next, key)}
          onEdge={(next) => doc.commit({ ...bp, edges: bp.edges.map((e) => (e.id === next.id ? next : e)) })}
          onDelete={deleteSelection}
        />
        )}
      </div>

      <footer className="bp-problems">
        <div className="bp-problems-head">
          {problems.length === 0 ? (
            <span className="bp-ok">No problems. This flow is valid.</span>
          ) : (
            <>
              <span className={hasErrors(problems) ? 'bp-bad' : ''}>
                {errorCount} error{errorCount === 1 ? '' : 's'}
              </span>
              <span>{warnCount} warning{warnCount === 1 ? '' : 's'}</span>
            </>
          )}
        </div>
        {problems.length > 0 && (
          <ul>
            {problems.map((p, i) => (
              <li key={i}>
                <button
                  type="button"
                  className={`bp-problem bp-problem-${p.severity}`}
                  onClick={() => {
                    setSelectedId(p.nodeId ?? null)
                    setSelectedEdgeId(null)
                  }}
                >
                  <span aria-hidden>{p.severity === 'error' ? '●' : '▲'}</span> {p.message}
                </button>
              </li>
            ))}
          </ul>
        )}
      </footer>
    </div>
  )
}

interface LibraryProps {
  projects: Project[]
  projectId: string
  flows: FlowSummary[]
  error: string
  onProject: (id: string) => void
  onOpen: (slug: string) => void
  onDelete: (f: FlowSummary) => void
  onCreate: (b: Blueprint) => void
}

function Library({ projects, projectId, flows, error, onProject, onOpen, onDelete, onCreate }: LibraryProps): JSX.Element {
  return (
    <div className="bp-library">
      <header className="bp-lib-head">
        <div>
          <h1>Blueprints</h1>
          <p>
            An orchestration is a file in your repo: <code>.agentship/flows/*.flow.json</code>. Design one here. Running
            them comes with the run engine.
          </p>
        </div>
        <label className="bp-project">
          Project
          <select value={projectId} onChange={(e) => onProject(e.target.value)} disabled={!projects.length}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </header>

      {error && <div className="bp-error">{error}</div>}

      {!projects.length ? (
        <div className="bp-empty">
          Add a project on the Floor first (<strong>+ Add project</strong>). Blueprints live inside a project&apos;s repo.
        </div>
      ) : (
        <>
          <section>
            <h2>Your flows</h2>
            {flows.length === 0 ? (
              <p className="bp-muted">Nothing here yet. Start from a pattern below.</p>
            ) : (
              <ul className="bp-cards">
                {flows.map((f) => (
                  <li key={f.slug} className="bp-card">
                    <button type="button" className="bp-card-main" onClick={() => onOpen(f.slug)} disabled={Boolean(f.error)}>
                      <strong>{f.name}</strong>
                      <span>{f.error ? `Can't read this file: ${f.error}` : f.description || `${f.nodeCount} nodes`}</span>
                    </button>
                    <button type="button" className="btn" onClick={() => onDelete(f)} aria-label={`Delete ${f.name}`}>
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2>Start from a pattern</h2>
            <ul className="bp-cards">
              <li className="bp-card">
                <button type="button" className="bp-card-main" onClick={() => onCreate(emptyBlueprint())}>
                  <strong>Blank flow</strong>
                  <span>A single Trigger. Build the rest yourself.</span>
                </button>
              </li>
              {PATTERNS.map((p) => (
                <li key={p.name} className="bp-card">
                  <button type="button" className="bp-card-main" onClick={() => onCreate(fromPattern(p))}>
                    <strong>{p.name}</strong>
                    <span>{p.description}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  )
}

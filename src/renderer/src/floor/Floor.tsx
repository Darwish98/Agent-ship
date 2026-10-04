import { useCallback, useMemo, useState, type JSX } from 'react'
import { LANES, type Lane, type WorkItem } from '../../../shared/floor'
import { slugify } from '../../../shared/blueprint'
import { fromPattern, PATTERNS, PLAN_FILE } from '../../../shared/patterns'
import { formatUsd, isActive } from '../../../shared/runs'
import { UsageGauge } from '../components/UsageGauge'
import { TaskDialog, type TaskDialogSpec } from '../components/TaskDialog'
import { useNav } from '../nav'
import { useRuns } from '../runs/RunsProvider'
import type { Room } from '../types'
import { WorkCard, type FloorActions } from './Cards'
import { CommitLandDialog, type CommitLandTarget } from './CommitLandDialog'
import { Drawer } from './Drawer'
import { LandAllDialog, type LandAllItem } from './LandAllDialog'
import { LandDialog, type LandTarget } from './LandDialog'
import { PlanSetupDialog, type PlanSetupTarget } from './PlanSetupDialog'
import { useFloorData } from './useFloorData'

const LANE_META: Record<Lane, { title: string; blurb: string; empty: string }> = {
  needs: { title: 'Needs you', blurb: 'Blocked on a person, or failed', empty: 'Nothing is waiting on you.' },
  running: { title: 'Running', blurb: 'In progress, no action needed', empty: 'Nothing is running.' },
  ready: { title: 'Ready to land', blurb: 'Finished work on a branch', empty: 'No finished branches.' },
  done: { title: 'Done', blurb: 'Recently finished', empty: 'Nothing finished in the last day.' }
}

/** The starter flows offered to a project that has none: a general supervisor
 *  and the gated build pipeline. */
const STARTERS = [PATTERNS[0], PATTERNS[2]]

const AUTOPILOT_PATTERN = PATTERNS[4]
const AUTOPILOT_SLUG = slugify(AUTOPILOT_PATTERN.name)

export function Floor({ active }: { active: boolean }): JSX.Element {
  const data = useFloorData(active)
  const { world, model, rooms, gitByRoom, flowsByRoom, refreshRoom } = data
  const nav = useNav()
  const { runs, acknowledge, cancel } = useRuns()

  const [project, setProject] = useState<'all' | string>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<TaskDialogSpec | null>(null)
  const [showStale, setShowStale] = useState(false)
  const [launchOpen, setLaunchOpen] = useState<string | null>(null)
  const [landing, setLanding] = useState<LandTarget | null>(null)
  const [committing, setCommitting] = useState<CommitLandTarget | null>(null)
  const [landingAll, setLandingAll] = useState<LandAllItem[] | null>(null)
  const [planSetup, setPlanSetup] = useState<PlanSetupTarget | null>(null)

  const roomById = useMemo(() => new Map(rooms.map((r) => [r.id, r])), [rooms])
  const visible = useCallback((it: WorkItem): boolean => project === 'all' || it.projectId === project, [project])

  const lanes = useMemo(() => {
    const out = {} as Record<Lane, WorkItem[]>
    for (const l of LANES) out[l] = model.byLane[l].filter(visible)
    return out
  }, [model, visible])

  const selected = useMemo(() => model.items.find((i) => i.id === selectedId) ?? null, [model, selectedId])

  /** What "Land all" would land: every landable item currently shown, in the
   *  same order as the lane. A discovered-but-unregistered project needs a
   *  one-off "+ Add to Agent Ship" first, so it is left out of the batch. */
  const landAllTargets = useCallback(
    (visibleReady: WorkItem[]): LandAllItem[] =>
      visibleReady.flatMap((item): LandAllItem[] => {
        const room = roomById.get(item.projectId)
        if (!room || room.ephemeral) return []
        if (item.kind === 'branch' && item.branch) {
          return [{ key: item.id, projectId: item.projectId, projectName: room.name, kind: 'branch', title: item.branch.branch, branch: item.branch.branch }]
        }
        if (item.kind === 'session' && item.session) {
          return [
            {
              key: item.id,
              projectId: item.projectId,
              projectName: room.name,
              kind: 'session',
              title: item.session.name,
              cwd: item.session.cwd,
              sessionId: item.session.sessionId,
              sessionName: item.session.name
            }
          ]
        }
        return []
      }),
    [roomById]
  )

  // --- actions -----------------------------------------------------------------

  const actions = useMemo<FloorActions>(
    () => ({
      select: (id) => setSelectedId((cur) => (cur === id ? null : id)),
      dismiss: (runId) => acknowledge(runId),
      editFlow: (item) => {
        const run = item.run
        if (!run) return
        const failed = Object.entries(run.nodes).find(([, n]) => n.state === 'failed')?.[0]
        nav.openFlow(run.projectId, run.flowSlug, failed)
      },
      openSession: (sessionId) => void window.agentShip.openSession(sessionId),
      stopOrRemove: (item) => {
        const s = item.session
        if (!s) return
        if (s.live && s.pid) {
          setDialog({
            title: `Stop ${s.name}?`,
            subtitle: `pid ${s.pid}`,
            warning: ['This kills the running Claude Code process.', 'Its transcript is kept, so you can resume it afterwards.'],
            taskField: false,
            submitLabel: 'Stop agent',
            onSubmit: async () => {
              const r = await window.agentShip.stopAgent(s.pid!)
              if (!r.ok) return r.error ?? 'Could not stop the agent.'
              await world.refreshSessions()
              return null
            }
          })
          return
        }
        setDialog({
          title: `Remove ${s.name}?`,
          subtitle: 'Takes this finished session off the floor.',
          warning: ["Its transcript is untouched. You can bring it back from the project's list."],
          taskField: false,
          submitLabel: 'Remove',
          onSubmit: async () => {
            await world.hideAgent(s.sessionId)
            return null
          }
        })
      },
      stopRun: (runId) => void cancel(runId),
      landWork: async (item) => {
        const s = item.session
        const room = roomById.get(item.projectId)
        if (!s || !room) return
        let projectId = room.id
        if (room.ephemeral) {
          const norm = (p: string): string => p.replace(/[\\/]+/g, '/').toLowerCase()
          const list = await window.agentShip.addProjectPath(room.path)
          const added = list.find((p) => norm(p.path) === norm(room.path))
          if (!added) return
          await world.refreshProjects()
          projectId = added.id
        }
        setCommitting({ projectId, projectName: room.name, cwd: s.cwd, sessionId: s.sessionId, sessionName: s.name })
      },
      land: async (item) => {
        const b = item.branch
        const room = roomById.get(item.projectId)
        if (!b || !room) return
        let projectId = room.id
        // A folder that was only discovered has to be part of Agent Ship before
        // it can run anything. That needs to be a real git repository.
        if (room.ephemeral) {
          const norm = (p: string): string => p.replace(/[\\/]+/g, '/').toLowerCase()
          const list = await window.agentShip.addProjectPath(room.path)
          const added = list.find((p) => norm(p.path) === norm(room.path))
          if (!added) {
            setDialog({
              title: 'Cannot land here',
              subtitle: room.name,
              warning: [`${room.path} is not a git repository Agent Ship can register.`],
              taskField: false,
              submitLabel: 'Close',
              onSubmit: async () => null
            })
            return
          }
          await world.refreshProjects()
          projectId = added.id
        }
        setLanding({ projectId, projectName: room.name, branch: b.branch })
      }
    }),
    [acknowledge, nav, roomById, gitByRoom, world]
  )

  const spawn = (room: Room): void =>
    setDialog({
      title: 'Start an agent',
      subtitle: `in ${room.name}. Runs outside any flow, so it has no budget ceiling or gate.`,
      roleField: true,
      submitLabel: 'Start',
      onSubmit: async ({ role, task }) => {
        const r = await window.agentShip.spawnAgent(room.path, role, task)
        return r.ok ? null : (r.error ?? 'Could not start the agent.')
      }
    })

  const addStarters = async (room: Room): Promise<void> => {
    for (const p of STARTERS) await window.agentShip.saveFlow(room.id, slugify(p.name), fromPattern(p), null)
    await refreshRoom(room.id)
  }

  const register = async (room: Room): Promise<void> => {
    await window.agentShip.addProjectPath(room.path)
    await world.refreshProjects()
  }

  /** The project's own live Autopilot run, if it has one - this alone is what
   *  the switch's on/off reflects; there is no separate stored toggle. */
  const autopilotRunFor = (roomId: string): (typeof runs)[number] | undefined =>
    runs.find((r) => r.projectId === roomId && r.flowSlug === AUTOPILOT_SLUG && isActive(r.status))

  const toggleAutopilot = async (room: Room): Promise<void> => {
    const live = autopilotRunFor(room.id)
    if (live) {
      void cancel(live.runId)
      return
    }
    let projectId = room.id
    if (room.ephemeral) {
      const norm = (p: string): string => p.replace(/[\\/]+/g, '/').toLowerCase()
      const list = await window.agentShip.addProjectPath(room.path)
      const added = list.find((p) => norm(p.path) === norm(room.path))
      if (!added) {
        setDialog({
          title: 'Cannot start Autopilot here',
          subtitle: room.name,
          warning: [`${room.path} is not a git repository Agent Ship can register.`],
          taskField: false,
          submitLabel: 'Close',
          onSubmit: async () => null
        })
        return
      }
      await world.refreshProjects()
      projectId = added.id
    }
    // Ensure the project has the flow saved; a copy already there (maybe
    // user-edited) is left alone - null means "only if it doesn't exist yet".
    await window.agentShip.saveFlow(projectId, AUTOPILOT_SLUG, fromPattern(AUTOPILOT_PATTERN), null)
    const { exists } = await window.agentShip.checkPlan(projectId)
    if (exists) nav.requestRun(projectId, AUTOPILOT_SLUG, { plan: PLAN_FILE })
    else setPlanSetup({ projectId, projectName: room.name })
  }

  // --- derived numbers ---------------------------------------------------------

  const counts = {
    needs: model.byLane.needs.length,
    running: model.byLane.running.length,
    ready: model.byLane.ready.length,
    verified: model.byLane.ready.filter((i) => i.verification?.state === 'verified').length
  }

  const railRooms = useMemo(
    () =>
      [...rooms].sort(
        (a, b) =>
          (model.attentionByProject.get(b.id) ?? 0) - (model.attentionByProject.get(a.id) ?? 0) ||
          model.items.filter((i) => i.projectId === b.id && i.lane === 'running').length -
            model.items.filter((i) => i.projectId === a.id && i.lane === 'running').length ||
          a.name.localeCompare(b.name)
      ),
    [rooms, model]
  )

  const selectedRoom = selected ? roomById.get(selected.projectId) : undefined

  return (
    <div className="fl">
      <header className="fl-top">
        <div className="fl-title">
          <span className="brand-mark" />
          Floor
        </div>
        <div className="fl-chips">
          <span className={`fl-chip${counts.needs ? ' fl-chip-alert' : ''}`}>
            <strong>{counts.needs}</strong> need you
          </span>
          <span className="fl-chip">
            <strong>{counts.running}</strong> running
          </span>
          <span className="fl-chip" title="Branches with commits the base branch does not have">
            <strong>{counts.ready}</strong> to land
            {counts.verified > 0 && <span className="fl-chip-sub"> · {counts.verified} verified</span>}
          </span>
          <span className="fl-chip" title="Dollars spent by flow runs today. Sessions started outside a flow are not priced.">
            <strong>{formatUsd(model.spendTodayUsd)}</strong> flows today
          </span>
        </div>
        <UsageGauge weeklyTokens={world.weeklyTokens} budget={world.settings.weeklyTokenBudget} onBudgetChange={(b) => void world.setBudget(b)} />
        <button
          type="button"
          className="btn btn-primary"
          onClick={async () => {
            await window.agentShip.addProject()
            await world.refreshProjects()
          }}
        >
          + Add project
        </button>
      </header>

      <div className="fl-body">
        <nav className="fl-rail" aria-label="Projects">
          <button type="button" className={`fl-proj-btn${project === 'all' ? ' fl-proj-on' : ''}`} onClick={() => setProject('all')}>
            <strong>All projects</strong>
            <span className="fl-proj-sub">{rooms.length} on the floor</span>
          </button>

          {railRooms.map((room) => {
            const git = gitByRoom.get(room.id)
            const attention = model.attentionByProject.get(room.id) ?? 0
            const running = model.items.filter((i) => i.projectId === room.id && i.lane === 'running').length
            const flows = flowsByRoom.get(room.id) ?? []
            const open = launchOpen === room.id
            return (
              <div key={room.id} className={`fl-proj${project === room.id ? ' fl-proj-on' : ''}`}>
                <button type="button" className="fl-proj-btn" onClick={() => setProject((cur) => (cur === room.id ? 'all' : room.id))}>
                  <span className="fl-proj-name">
                    {running > 0 && <span className="fl-live" title={`${running} running`} />}
                    <strong>{room.name}</strong>
                    {attention > 0 && <span className="fl-badge" title={`${attention} need you`}>{attention}</span>}
                  </span>
                  <span className="fl-proj-sub">
                    {git?.isRepo ? `${git.branch}${git.dirtyFiles ? ` · ${git.dirtyFiles} changed` : ''}` : 'not a git repo'}
                  </span>
                </button>

                <div className="fl-proj-actions">
                  {room.ephemeral ? (
                    <button type="button" className="fl-link" onClick={() => void register(room)} title="Register this folder so flows can run here">
                      + Add to Agent Ship
                    </button>
                  ) : (
                    <>
                      <button type="button" className="fl-link" onClick={() => setLaunchOpen(open ? null : room.id)} aria-expanded={open}>
                        ▶ Run a flow {open ? '▴' : '▾'}
                      </button>
                      <button type="button" className="fl-link" onClick={() => spawn(room)}>
                        New agent
                      </button>
                    </>
                  )}
                </div>

                {!room.ephemeral && (
                  <button
                    type="button"
                    className={`fl-autopilot${autopilotRunFor(room.id) ? ' fl-autopilot-on' : ''}`}
                    onClick={() => void toggleAutopilot(room)}
                    title={
                      autopilotRunFor(room.id)
                        ? 'Autopilot is running: build, test, land, repeat, until the plan is done. Click to stop.'
                        : `Autopilot: works ${PLAN_FILE} one item at a time - build, test, land, repeat - until an agent judges it done.`
                    }
                  >
                    <span className="fl-autopilot-dot" />
                    Autopilot{autopilotRunFor(room.id) ? ': on' : ''}
                  </button>
                )}

                {open && (
                  <ul className="fl-launch">
                    {flows.filter((f) => !f.error).map((f) => (
                      <li key={f.slug}>
                        <button
                          type="button"
                          onClick={() => {
                            setLaunchOpen(null)
                            nav.requestRun(room.id, f.slug)
                          }}
                        >
                          <strong>{f.name}</strong>
                          <span>{f.description || `${f.nodeCount} nodes`}</span>
                        </button>
                      </li>
                    ))}
                    {flows.length === 0 && (
                      <li>
                        <button type="button" onClick={() => void addStarters(room)}>
                          <strong>Add starter flows</strong>
                          <span>Supervisor and a gated build pipeline, saved into this repo.</span>
                        </button>
                      </li>
                    )}
                    <li>
                      <button type="button" onClick={() => nav.setMode('blueprint')}>
                        <strong>Design flows…</strong>
                        <span>Open the blueprint editor.</span>
                      </button>
                    </li>
                  </ul>
                )}
              </div>
            )
          })}

          {rooms.length === 0 && <p className="fl-rail-empty">No projects yet.</p>}
        </nav>

        <main className="fl-board">
          {rooms.length === 0 ? (
            <div className="fl-welcome">
              <h2>Nothing on the floor yet</h2>
              <p>The Floor is where you run and supervise agent work across your projects.</p>
              <ol>
                <li>
                  <strong>Add a project</strong> (any git repo), or just run <code>claude</code> in one and it appears here.
                </li>
                <li>
                  <strong>Run a flow</strong> on it: a Pipeline builds in its own branch, tests it, and stops at a dollar cap.
                </li>
                <li>
                  <strong>Land what passed.</strong> Verified branches are ranked first; nothing is merged without you.
                </li>
              </ol>
            </div>
          ) : (
            <div className="fl-lanes">
              {LANES.map((lane) => {
                const meta = LANE_META[lane]
                const all = lanes[lane]
                const list = lane === 'ready' && !showStale ? all.filter((i) => !i.stale) : all
                const staleCount = all.length - list.length
                return (
                  <section key={lane} className={`fl-lane fl-lane-${lane}${lane === 'needs' && all.length ? ' fl-lane-alert' : ''}`} aria-label={meta.title}>
                    <header className="fl-lane-head">
                      <h2>{meta.title}</h2>
                      <span className="fl-count">{all.length}</span>
                      {lane === 'ready' && list.length >= 2 && (
                        <button type="button" className="btn btn-primary fl-land-all" onClick={() => setLandingAll(landAllTargets(list))}>
                          Land all {list.length}
                        </button>
                      )}
                      <span className="fl-lane-blurb">{meta.blurb}</span>
                    </header>
                    <div className="fl-cards">
                      {list.map((item) => (
                        <WorkCard
                          key={item.id}
                          item={item}
                          selected={item.id === selectedId}
                          projectName={project === 'all' ? (roomById.get(item.projectId)?.name ?? null) : null}
                          actions={actions}
                        />
                      ))}
                      {all.length === 0 && <p className={`fl-empty${lane === 'needs' ? ' fl-empty-ok' : ''}`}>{lane === 'needs' ? '✓ ' : ''}{meta.empty}</p>}
                      {lane === 'ready' && staleCount > 0 && (
                        <button type="button" className="fl-link fl-more" onClick={() => setShowStale(true)}>
                          Show {staleCount} stale branch{staleCount === 1 ? '' : 'es'} (older than 2 weeks)
                        </button>
                      )}
                      {lane === 'ready' && showStale && all.some((i) => i.stale) && (
                        <button type="button" className="fl-link fl-more" onClick={() => setShowStale(false)}>
                          Hide stale branches
                        </button>
                      )}
                      {lane === 'done' && model.hiddenOlder > 0 && project === 'all' && (
                        <p className="fl-empty">{model.hiddenOlder} older session{model.hiddenOlder === 1 ? '' : 's'} not shown.</p>
                      )}
                    </div>
                  </section>
                )
              })}
            </div>
          )}
        </main>

        {selected && selectedRoom && (
          <Drawer
            item={selected}
            projectName={selectedRoom.name}
            projectPath={selectedRoom.path}
            baseBranch={gitByRoom.get(selectedRoom.id)?.baseBranch ?? ''}
            actions={actions}
            onRunOf={(branch) => {
              const run = runs.find((r) => r.branch === branch)
              if (run) nav.openFlow(run.projectId, run.flowSlug)
            }}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>

      {dialog && <TaskDialog spec={dialog} onClose={() => setDialog(null)} />}
      {landing && <LandDialog target={landing} onClose={() => setLanding(null)} />}
      {committing && <CommitLandDialog target={committing} onClose={() => setCommitting(null)} />}
      {landingAll && <LandAllDialog items={landingAll} onClose={() => setLandingAll(null)} />}
      {planSetup && (
        <PlanSetupDialog
          target={planSetup}
          onClose={() => setPlanSetup(null)}
          onReady={() => {
            const { projectId } = planSetup
            setPlanSetup(null)
            nav.requestRun(projectId, AUTOPILOT_SLUG, { plan: PLAN_FILE })
          }}
        />
      )}
    </div>
  )
}

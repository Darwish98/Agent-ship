import type { JSX, ReactNode } from 'react'
import { budgetCeiling, BUILTIN_VARS, usdCeiling } from '../../../shared/blueprint'
import type { Blueprint, BlueprintEdge, BlueprintNode, Budget } from '../../../shared/schema'

interface Props {
  bp: Blueprint
  node: BlueprintNode | null
  edge: BlueprintEdge | null
  onNode: (next: BlueprintNode, key: string) => void
  onFlow: (next: Blueprint, key: string) => void
  onEdge: (next: BlueprintEdge) => void
  onDelete: () => void
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): JSX.Element {
  return (
    <label className="insp-field">
      <span className="insp-label">{label}</span>
      {children}
      {hint && <span className="insp-hint">{hint}</span>}
    </label>
  )
}

/** Blank means "no limit set", not zero. */
function numberOrUndefined(v: string): number | undefined {
  const n = Number(v)
  return v.trim() === '' || !Number.isFinite(n) || n <= 0 ? undefined : Math.floor(n)
}

const fmt = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`)

function BudgetFields({
  budget,
  gate,
  onChange
}: {
  budget: Budget | undefined
  gate: boolean
  onChange: (b: Budget | undefined) => void
}): JSX.Element {
  const set = (patch: Partial<Budget>): void => {
    const next = { ...budget, ...patch }
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)) as Budget
    onChange(Object.keys(clean).length ? clean : undefined)
  }
  return (
    <fieldset className="insp-group">
      <legend>Budget</legend>
      {!gate && (
        <Field label="Max dollars" hint="The hard limit. Enforced by the CLI after each model call, so a step can overshoot by one call. Under ~$0.05 is not meaningful.">
          <input
            type="number"
            min={0.01}
            step={0.1}
            value={budget?.maxUsd ?? ''}
            placeholder="flow default"
            onChange={(e) => {
              const n = Number(e.target.value)
              set({ maxUsd: e.target.value.trim() === '' || !(n > 0) ? undefined : n })
            }}
          />
        </Field>
      )}
      {!gate && (
        <Field label="Max tokens" hint="Checked when a step ends: a step that used more stops the run. A cold call alone costs ~30k.">
          <input
            type="number"
            min={1}
            value={budget?.maxTokens ?? ''}
            placeholder="flow default"
            onChange={(e) => set({ maxTokens: numberOrUndefined(e.target.value) })}
          />
        </Field>
      )}
      <Field label="Max minutes">
        <input
          type="number"
          min={1}
          value={budget?.maxMinutes ?? ''}
          placeholder="no limit"
          onChange={(e) => set({ maxMinutes: numberOrUndefined(e.target.value) })}
        />
      </Field>
      {gate && (
        <Field label="Max retries" hint="How many times a failing gate may loop back before the run stops.">
          <input
            type="number"
            min={1}
            max={20}
            value={budget?.maxRetries ?? ''}
            placeholder="required for a fail edge"
            onChange={(e) => set({ maxRetries: numberOrUndefined(e.target.value) })}
          />
        </Field>
      )}
    </fieldset>
  )
}

function NodeFields({ node, onNode }: { node: BlueprintNode; onNode: Props['onNode'] }): JSX.Element {
  const key = (f: string): string => `${node.id}:${f}`
  switch (node.kind) {
    case 'trigger':
      return <p className="insp-note">Runs when you press Run. Scheduled, git and webhook triggers arrive later.</p>
    case 'agent': {
      const c = node.config
      const set = (patch: Partial<typeof c>, f: string): void =>
        onNode({ ...node, config: { ...c, ...patch } }, key(f))
      return (
        <>
          <Field label="Role">
            <input value={c.role} onChange={(e) => set({ role: e.target.value }, 'role')} />
          </Field>
          <Field label="Model">
            <select value={c.model} onChange={(e) => set({ model: e.target.value as typeof c.model }, 'model')}>
              {['default', 'opus', 'sonnet', 'haiku', 'fable'].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
          <Field
            label="Prompt"
            hint={`Variables: ${BUILTIN_VARS.map((v) => `{{${v}}}`).join(' ')}, a flow input, or an earlier node: {{node-id.result}} {{node-id.branch}}.`}
          >
            <textarea rows={7} value={c.prompt} onChange={(e) => set({ prompt: e.target.value }, 'prompt')} />
          </Field>
          <Field label="Access" hint="Edit lets the agent modify files in its working directory. The worktree, not this setting, is what contains it.">
            <select value={c.access} onChange={(e) => set({ access: e.target.value as typeof c.access }, 'access')}>
              <option value="read">read-only</option>
              <option value="edit">can edit files</option>
            </select>
          </Field>
          <label className="insp-check">
            <input
              type="checkbox"
              checked={c.worktree}
              onChange={(e) => set({ worktree: e.target.checked }, 'worktree')}
            />
            Own git worktree and branch
          </label>
          <Field label="Allowed tools" hint="One per line, e.g. Bash(npm test). Empty = normal permissions.">
            <textarea
              rows={3}
              value={c.tools.join('\n')}
              onChange={(e) => set({ tools: e.target.value.split('\n').filter((t) => t.trim()) }, 'tools')}
            />
          </Field>
          <Field label="Output JSON schema" hint="Optional. The result must validate against it.">
            <textarea
              rows={3}
              value={c.outputSchema}
              onChange={(e) => set({ outputSchema: e.target.value }, 'schema')}
            />
          </Field>
        </>
      )
    }
    case 'fanout': {
      const c = node.config
      return (
        <Field label="Copies" hint="Each copy runs the connected node in parallel.">
          <input
            type="number"
            min={2}
            max={16}
            value={c.count}
            onChange={(e) =>
              onNode(
                { ...node, config: { ...c, count: Math.min(16, Math.max(2, Number(e.target.value) || 2)) } },
                key('count')
              )
            }
          />
        </Field>
      )
    }
    case 'join': {
      const c = node.config
      return (
        <>
          <Field label="Continue when">
            <select
              value={c.strategy}
              onChange={(e) => onNode({ ...node, config: { ...c, strategy: e.target.value as typeof c.strategy } }, key('s'))}
            >
              <option value="all">all branches finish</option>
              <option value="first">the first one finishes</option>
              <option value="quorum">a quorum finishes</option>
              <option value="best">all finish, keep the best</option>
            </select>
          </Field>
          {c.strategy === 'quorum' && (
            <Field label="Quorum">
              <input
                type="number"
                min={1}
                max={16}
                value={c.quorum}
                onChange={(e) =>
                  onNode({ ...node, config: { ...c, quorum: Math.max(1, Number(e.target.value) || 1) } }, key('q'))
                }
              />
            </Field>
          )}
        </>
      )
    }
    case 'gate': {
      const c = node.config
      return (
        <>
          <Field label="Check">
            <select
              value={c.check}
              onChange={(e) => onNode({ ...node, config: { ...c, check: e.target.value as typeof c.check } }, key('check'))}
            >
              <option value="command">a command exits 0</option>
              <option value="human">a person approves</option>
            </select>
          </Field>
          {c.check === 'command' ? (
            <Field label="Command" hint="Run in the upstream branch's worktree.">
              <input
                value={c.command}
                placeholder="npm test"
                onChange={(e) => onNode({ ...node, config: { ...c, command: e.target.value } }, key('cmd'))}
              />
            </Field>
          ) : (
            <Field label="What to check">
              <textarea
                rows={3}
                value={c.instructions}
                onChange={(e) => onNode({ ...node, config: { ...c, instructions: e.target.value } }, key('ins'))}
              />
            </Field>
          )}
          <p className="insp-note">
            Connect two edges out of a gate: one for <b>pass</b>, one for <b>fail</b> (a retry loop).
          </p>
        </>
      )
    }
    case 'merge': {
      const c = node.config
      return (
        <>
          <p className="insp-note">
            Merges the run&apos;s branch into the base in a <b>scratch copy</b>. Your checkout is not touched. Later gates test the merged result.
          </p>
          <Field label="Base branch">
            <input
              value={c.baseBranch}
              onChange={(e) => onNode({ ...node, config: { ...c, baseBranch: e.target.value } }, key('base'))}
            />
          </Field>
          <label className="insp-check">
            <input
              type="checkbox"
              checked={c.resolveConflicts}
              onChange={(e) => onNode({ ...node, config: { ...c, resolveConflicts: e.target.checked } }, key('rc'))}
            />
            An agent resolves conflicts (only if there are any)
          </label>
          <Field label="Resolver brief" hint="Variables: {{branch}} {{baseBranch}} {{conflicts}}. Empty uses the default.">
            <textarea
              rows={7}
              value={c.resolverPrompt}
              onChange={(e) => onNode({ ...node, config: { ...c, resolverPrompt: e.target.value } }, key('rp'))}
            />
          </Field>
        </>
      )
    }
    case 'land': {
      const c = node.config
      return (
        <>
          <p className="insp-note">
            Moves the base branch to the merged result, only after everything before it passed. If the base moved in the meantime it is left alone.
          </p>
          <Field label="Base branch">
            <input
              value={c.baseBranch}
              onChange={(e) => onNode({ ...node, config: { ...c, baseBranch: e.target.value } }, key('base'))}
            />
          </Field>
        </>
      )
    }
  }
}

export function Inspector({ bp, node, edge, onNode, onFlow, onEdge, onDelete }: Props): JSX.Element {
  if (edge) {
    const from = bp.nodes.find((n) => n.id === edge.from)
    return (
      <aside className="inspector">
        <h3>Connection</h3>
        <Field label="Carries">
          <select value={edge.type} onChange={(e) => onEdge({ ...edge, type: e.target.value as BlueprintEdge['type'] })}>
            <option value="artifact">an artifact (text/JSON)</option>
            <option value="branch">a git branch</option>
            <option value="verdict">a verdict</option>
            <option value="control">control only</option>
          </select>
        </Field>
        {from?.kind === 'gate' && (
          <Field label="Follow when">
            <select
              value={edge.condition}
              onChange={(e) => onEdge({ ...edge, condition: e.target.value as BlueprintEdge['condition'] })}
            >
              <option value="pass">the gate passes</option>
              <option value="fail">the gate fails (retry loop)</option>
              <option value="always">always</option>
            </select>
          </Field>
        )}
        <button type="button" className="btn insp-delete" onClick={onDelete}>
          Delete connection
        </button>
      </aside>
    )
  }

  if (node) {
    return (
      <aside className="inspector">
        <h3>{node.kind}</h3>
        <Field label="Name">
          <input value={node.label} onChange={(e) => onNode({ ...node, label: e.target.value }, `${node.id}:label`)} />
        </Field>
        <NodeFields node={node} onNode={onNode} />
        {node.kind !== 'trigger' && (
          <BudgetFields
            budget={node.budget}
            gate={node.kind === 'gate'}
            onChange={(budget) => onNode({ ...node, budget }, `${node.id}:budget`)}
          />
        )}
        <button type="button" className="btn insp-delete" onClick={onDelete}>
          Delete node
        </button>
      </aside>
    )
  }

  const ceiling = budgetCeiling(bp)
  const usd = usdCeiling(bp)
  return (
    <aside className="inspector">
      <h3>Flow</h3>
      <Field label="Name">
        <input value={bp.name} onChange={(e) => onFlow({ ...bp, name: e.target.value || bp.name }, 'name')} />
      </Field>
      <Field label="Description">
        <textarea rows={3} value={bp.description} onChange={(e) => onFlow({ ...bp, description: e.target.value }, 'desc')} />
      </Field>
      <fieldset className="insp-group">
        <legend>Budget</legend>
        <Field label="Default dollars per agent" hint="Applies to any agent without its own limit. A run needs one to start.">
          <input
            type="number"
            min={0.01}
            step={0.1}
            value={bp.defaultBudget.maxUsd ?? ''}
            placeholder="none"
            onChange={(e) => {
              const n = Number(e.target.value)
              onFlow({ ...bp, defaultBudget: { ...bp.defaultBudget, maxUsd: e.target.value.trim() === '' || !(n > 0) ? undefined : n } }, 'dusd')
            }}
          />
        </Field>
        <Field label="Default tokens per agent" hint="Applies to any agent without its own limit.">
          <input
            type="number"
            min={1}
            value={bp.defaultBudget.maxTokens ?? ''}
            placeholder="none"
            onChange={(e) =>
              onFlow({ ...bp, defaultBudget: { ...bp.defaultBudget, maxTokens: numberOrUndefined(e.target.value) } }, 'dbudget')
            }
          />
        </Field>
        <p className={`insp-ceiling${usd === null ? ' insp-ceiling-bad' : ''}`}>
          {usd === null ? (
            <>
              <b>No dollar ceiling.</b> Give every agent a dollar limit (or a flow default) and this flow can run.
            </>
          ) : (
            <>
              Run ceiling <b>${usd.toFixed(2)}</b> in the worst case (fan-out and retries counted).
            </>
          )}
        </p>
        {ceiling !== null && (
          <p className="insp-ceiling">
            Token limits add up to <b>{fmt(ceiling)}</b> in the worst case. Tokens are checked when each step ends; the dollar
            limit is what the CLI enforces during a step.
          </p>
        )}
      </fieldset>
      <fieldset className="insp-group">
        <legend>Inputs</legend>
        {bp.inputs.map((input, i) => (
          <div className="insp-input-row" key={i}>
            <input
              value={input.name}
              aria-label="Input name"
              onChange={(e) => {
                const inputs = bp.inputs.slice()
                inputs[i] = { ...input, name: e.target.value.replace(/[^A-Za-z0-9_]/g, '') }
                onFlow({ ...bp, inputs }, `in${i}`)
              }}
            />
            <button
              type="button"
              className="btn"
              aria-label="Remove input"
              onClick={() => onFlow({ ...bp, inputs: bp.inputs.filter((_, j) => j !== i) }, `in${i}:rm`)}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn"
          onClick={() =>
            onFlow({ ...bp, inputs: [...bp.inputs, { name: `input${bp.inputs.length + 1}`, label: '', required: true }] }, 'in:add')
          }
        >
          + Add input
        </button>
      </fieldset>
    </aside>
  )
}

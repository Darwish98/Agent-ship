import { describe, expect, it } from 'vitest'
import {
  budgetCeiling,
  flowLevels,
  hasErrors,
  parallelSection,
  renderTemplate,
  summarizeRun,
  templateVars,
  unrunnableReasons,
  usdCeiling,
  validateBlueprint
} from './blueprint'
import { buildPlanBlueprint, DESIGN_FILE, emptyBlueprint, fromPattern, OVERVIEW_FILE, PATTERNS, PLAN_FILE, PLANNING_DIR } from './patterns'
import { promptVars } from './runs'
import { parseBlueprint, type Blueprint } from './schema'

const messages = (bp: Blueprint, severity?: 'error' | 'warning'): string[] =>
  validateBlueprint(bp)
    .filter((p) => !severity || p.severity === severity)
    .map((p) => p.message)

describe('schema', () => {
  it('round-trips every shipped pattern through parse', () => {
    for (const p of PATTERNS) {
      const parsed = parseBlueprint(JSON.parse(JSON.stringify(p)))
      expect(parsed.ok, p.name).toBe(true)
    }
  })

  it('fills defaults for a minimal hand-written file', () => {
    const parsed = parseBlueprint({
      name: 'x',
      nodes: [{ id: 'a', kind: 'agent', position: { x: 0, y: 0 }, config: { role: 'r', prompt: 'p' } }],
      edges: []
    })
    expect(parsed.ok).toBe(true)
    if (parsed.ok && parsed.blueprint.nodes[0].kind === 'agent') {
      expect(parsed.blueprint.nodes[0].config.worktree).toBe(false)
      expect(parsed.blueprint.version).toBe(1)
    }
  })

  it('rejects unknown node kinds and reports where', () => {
    const parsed = parseBlueprint({
      name: 'x',
      nodes: [{ id: 'a', kind: 'teleport', position: { x: 0, y: 0 }, config: {} }],
      edges: []
    })
    expect(parsed.ok).toBe(false)
  })

  it('refuses a file from a newer schema instead of guessing', () => {
    const parsed = parseBlueprint({ schemaVersion: 99, name: 'x', nodes: [], edges: [] })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toMatch(/newer/)
  })
})

describe('validation', () => {
  it('accepts every shipped pattern with no errors', () => {
    for (const p of PATTERNS) expect(messages(p, 'error'), p.name).toEqual([])
  })

  it('requires a trigger', () => {
    const bp = emptyBlueprint()
    bp.nodes = []
    expect(messages(bp, 'error')).toContain('A flow needs a Trigger to start from.')
  })

  it('flags a fan-out with no join', () => {
    const bp = fromPattern(PATTERNS[3])
    bp.nodes = bp.nodes.filter((n) => n.id !== 'pick')
    bp.edges = bp.edges.filter((e) => e.from !== 'pick' && e.to !== 'pick')
    expect(messages(bp, 'error').some((m) => /never reaches a Join/.test(m))).toBe(true)
  })

  it('flags an ordinary cycle but allows a gate retry loop', () => {
    const pipeline = fromPattern(PATTERNS[2])
    expect(messages(pipeline, 'error')).toEqual([])

    const looped = fromPattern(PATTERNS[2])
    looped.edges.push({ id: 'review->plan', from: 'review', to: 'plan', type: 'artifact', condition: 'always' })
    expect(messages(looped, 'error').some((m) => /loop/.test(m))).toBe(true)
  })

  it('requires a retry cap on a gate that loops back', () => {
    const bp = fromPattern(PATTERNS[2])
    const gate = bp.nodes.find((n) => n.id === 'tests')!
    gate.budget = undefined
    expect(messages(bp, 'error').some((m) => /no retry cap/.test(m))).toBe(true)
  })

  it('accepts maxRetries: 0 as a real cap ("try exactly once"), not the same as no cap at all', () => {
    const bp = fromPattern(PATTERNS[2])
    const gate = bp.nodes.find((n) => n.id === 'tests')!
    gate.budget = { maxRetries: 0 }
    expect(messages(bp, 'error').some((m) => /no retry cap/.test(m))).toBe(false)
  })

  it('flags nodes nothing can reach', () => {
    const bp = fromPattern(PATTERNS[0])
    bp.nodes.push({
      id: 'orphan',
      kind: 'agent',
      label: 'Orphan',
      position: { x: 0, y: 0 },
      config: { role: 'o', model: 'default', prompt: 'x', worktree: false, access: 'read', tools: [], outputSchema: '' }
    })
    expect(messages(bp, 'error').some((m) => /can never run/.test(m))).toBe(true)
  })

  it('warns when parallel agents share a working tree', () => {
    const bp = fromPattern(PATTERNS[3])
    const contender = bp.nodes.find((n) => n.id === 'contender')!
    if (contender.kind === 'agent') contender.config.worktree = false
    expect(messages(bp, 'warning').some((m) => /own worktree/.test(m))).toBe(true)
  })

  it('warns on prompt variables that are not declared inputs', () => {
    const bp = fromPattern(PATTERNS[0])
    const a = bp.nodes.find((n) => n.id === 'orchestrator')!
    if (a.kind === 'agent') a.config.prompt = '{{brief}} and {{mystery}}'
    const warnings = messages(bp, 'warning')
    expect(warnings.some((m) => m.includes('{{mystery}}'))).toBe(true)
    expect(warnings.some((m) => m.includes('{{brief}}'))).toBe(false)
  })

  it('treats hasErrors as errors only', () => {
    expect(hasErrors([{ severity: 'warning', message: 'w' }])).toBe(false)
    expect(hasErrors([{ severity: 'error', message: 'e' }])).toBe(true)
  })
})

describe('templates', () => {
  it('lists unique variables', () => {
    expect(templateVars('a {{x}} b {{ y }} c {{x}}').sort()).toEqual(['x', 'y'])
  })

  it('substitutes known names and leaves unknown ones visible', () => {
    expect(renderTemplate('Land {{a}} on {{b}}', { a: 'x' })).toBe('Land x on {{b}}')
  })

  it('does not treat $-patterns in values as regex replacements', () => {
    expect(renderTemplate('{{a}}', { a: '$& $1' })).toBe('$& $1')
  })
})

describe('budget ceiling', () => {
  it('is null when an agent has no bound at all', () => {
    expect(budgetCeiling(fromPattern(PATTERNS[0]))).toBeNull()
  })

  it('multiplies fan-out interiors', () => {
    // 3 contenders x 300k, each allowed one gate retry (x2), plus the judge and
    // the Merge step's conflict resolver (300k each, run once).
    expect(budgetCeiling(fromPattern(PATTERNS[3]))).toBe(3 * 300_000 * 2 + 300_000 + 300_000)
    // Dollars: 3 x $0.5 x 2, the $0.3 judge, and the resolver's default $1.
    expect(usdCeiling(fromPattern(PATTERNS[3]))).toBeCloseTo(3 + 0.3 + 1)
  })

  it('multiplies a gate retry loop over the loop body only', () => {
    // plan 150k (outside the loop) + build 600k x (1 + 3 retries)
    // + review 200k (after the gate, outside the loop).
    expect(budgetCeiling(fromPattern(PATTERNS[2]))).toBe(150_000 + 600_000 * 4 + 200_000)
  })
})

describe('node output references', () => {
  it('resolves {{node.output.field}} from a structured result, including nested fields and whole arrays', () => {
    const bp = fromPattern(PATTERNS[2])
    const plan = bp.nodes.find((n) => n.id === 'plan')!
    if (plan.kind === 'agent') plan.config.outputSchema = '{"type":"object"}'
    const view = {
      inputs: {},
      blueprint: bp,
      nodes: { plan: { state: 'passed' as const, attempts: 1, costUsd: 0.1, tokens: 1, detail: '{"title":"T","steps":["a","b"],"meta":{"risk":"low"}}' } }
    }
    const vars = promptVars(view, 'up')
    expect(renderTemplate('{{plan.output.title}} / {{plan.output.meta.risk}} / {{plan.output.steps}} / {{plan.output.steps.1}}', vars)).toBe('T / low / ["a","b"] / b')
    expect(vars.upstream).toBe('up')
    expect(vars['plan.cost']).toBe('0.1000')
  })

  it('leaves an output reference visible when the node had no JSON output', () => {
    const bp = fromPattern(PATTERNS[2])
    const view = { inputs: {}, blueprint: bp, nodes: { plan: { state: 'passed' as const, attempts: 1, costUsd: 0, tokens: 0, detail: 'plain text' } } }
    expect(renderTemplate('{{plan.output.x}}', promptVars(view, ''))).toBe('{{plan.output.x}}')
  })
})

describe('shipped prompts', () => {
  it('renders the conflict-resolver brief with the branch and files and no leftover placeholders', () => {
    const node = PATTERNS[1].nodes.find((n) => n.kind === 'merge')
    if (node?.kind !== 'merge') throw new Error('no merge node')
    const text = renderTemplate(node.config.resolverPrompt, {
      branch: 'feat/a',
      baseBranch: 'main',
      conflicts: '  - src/a.ts\n  - src/b.ts'
    })
    expect(text).toContain('merge of "feat/a" into "main"')
    expect(text).toContain('  - src/a.ts\n  - src/b.ts')
    expect(text).toMatch(/Do NOT commit/)
    expect(text).not.toMatch(/\{\{/)
  })

  it('passes the supervisor brief through untouched', () => {
    const node = PATTERNS[0].nodes.find((n) => n.kind === 'agent')
    if (node?.kind !== 'agent') throw new Error('no agent node')
    expect(renderTemplate(node.config.prompt, { brief: 'do the thing {{x}}' })).toBe('do the thing {{x}}')
  })
})

describe('run planning helpers', () => {
  it('summarises what a pipeline run will do', () => {
    const s = summarizeRun(fromPattern(PATTERNS[2]))
    expect(s.agents.map((a) => [a.label, a.edits, a.ownBranch])).toEqual([
      ['Planner', false, false],
      ['Builder', true, true],
      ['Reviewer', false, false]
    ])
    expect(s.commands).toEqual([{ label: 'Tests pass', command: 'npm test' }])
    expect(s.ceilingUsd).toBeCloseTo(0.5 + 1 * 4 + 0.5)
  })

  it('the plan-writing flow (Autopilot switch, no plan yet) is one agent that writes to the live checkout, and it is runnable', () => {
    const bp = buildPlanBlueprint()
    expect(unrunnableReasons(bp)).toEqual([])
    expect(bp.inputs.map((i) => i.name)).toEqual(['idea'])
    const write = bp.nodes.find((n) => n.kind === 'agent')!
    expect(write.kind).toBe('agent')
    if (write.kind === 'agent') {
      expect(write.config.worktree).toBe(false) // the plan belongs in the real checkout, not a throwaway branch
      expect(write.config.access).toBe('edit')
      expect(write.config.prompt).toContain('{{idea}}')
      // For a genuinely new project: the actionable list, and the fuller
      // record behind it, generically named (not this project's own
      // PLATFORM_PLAN/FLOOR_DESIGN, which are agent-ship's own names).
      expect(write.config.prompt).toContain(PLAN_FILE)
      expect(write.config.prompt).toContain(OVERVIEW_FILE)
      expect(write.config.prompt).toContain(DESIGN_FILE)
      expect(OVERVIEW_FILE.startsWith(`${PLANNING_DIR}/`)).toBe(true)
      expect(DESIGN_FILE.startsWith(`${PLANNING_DIR}/`)).toBe(true)
      // For a project that already has real planning docs: read and
      // summarise them, never blindly overwrite what is already decided.
      expect(write.config.prompt).toMatch(/already holds real planning documents/)
      expect(write.config.prompt).toMatch(/do not overwrite or contradict/)
    }
  })

  it('ships runnable patterns, including the parallel tournament and Autopilot', () => {
    expect(unrunnableReasons(fromPattern(PATTERNS[0]))).toEqual([])
    expect(unrunnableReasons(fromPattern(PATTERNS[2]))).toEqual([])
    expect(unrunnableReasons(fromPattern(PATTERNS[3]))).toEqual([])
    expect(unrunnableReasons(fromPattern(PATTERNS[4]))).toEqual([])
  })

  describe('parallel sections', () => {
    const tournament = (): Blueprint => fromPattern(PATTERNS[3])
    const why = (bp: Blueprint): string => unrunnableReasons(bp).join(' | ')

    it('finds what runs once per copy, including the gate that repairs it', () => {
      const s = parallelSection(tournament(), 'spread')
      expect(s.body.map((n) => n.id).sort()).toEqual(['contender', 'tests'])
      expect(s.join?.id).toBe('pick')
      expect(s.escapes).toBe(false)
    })

    it('refuses a human gate inside the copies', () => {
      const bp = tournament()
      const gate = bp.nodes.find((n) => n.id === 'tests')!
      if (gate.kind === 'gate') gate.config = { check: 'human', command: '', instructions: 'look', agentPrompt: '', agentModel: 'default', agentTools: [] }
      expect(why(bp)).toMatch(/human or agent-checked gates/)
    })

    it('refuses nesting, and a merge inside the copies', () => {
      const nested = tournament()
      nested.nodes.push({ id: 'inner', kind: 'fanout', label: 'Inner', position: { x: 0, y: 0 }, config: { count: 2 } })
      nested.edges = nested.edges.filter((e) => e.id !== 'contender->tests')
      nested.edges.push({ id: 'contender->inner', from: 'contender', to: 'inner', type: 'artifact', condition: 'always' }, { id: 'inner->tests', from: 'inner', to: 'tests', type: 'artifact', condition: 'always' })
      expect(why(nested)).toMatch(/no nesting/)
    })

    it('refuses a Join that nothing feeds, a shared Join, a quorum larger than the copies, and a fan-out with two branches', () => {
      const orphan = tournament()
      orphan.nodes.push({ id: 'j2', kind: 'join', label: 'Lonely', position: { x: 0, y: 0 }, config: { strategy: 'all', quorum: 2, criteria: '' } })
      expect(why(orphan)).toMatch(/no Fan-out feeding it/)

      const quorum = tournament()
      const pick = quorum.nodes.find((n) => n.id === 'pick')!
      if (pick.kind === 'join') pick.config = { strategy: 'quorum', quorum: 5, criteria: '' }
      expect(why(quorum)).toMatch(/wants 5 finishing, but there are only 3 copies/)

      const two = tournament()
      two.edges.push({ id: 'spread->pick', from: 'spread', to: 'pick', type: 'artifact', condition: 'always' })
      expect(why(two)).toMatch(/exactly one node/)
    })
  })

  it('refuses to run a flow with no dollar ceiling', () => {
    const bp = fromPattern(PATTERNS[2])
    bp.defaultBudget = {}
    for (const n of bp.nodes) n.budget = n.kind === 'gate' ? n.budget : undefined
    expect(unrunnableReasons(bp).join(' ')).toMatch(/dollar limit/)
    expect(usdCeiling(bp)).toBeNull()
  })

  it('refuses a flow whose trigger goes nowhere', () => {
    const bp = fromPattern(PATTERNS[0])
    bp.edges = []
    expect(unrunnableReasons(bp).join(' ')).toMatch(/not connected/)
  })

  it('refuses a step that fans out to two nodes', () => {
    const bp = fromPattern(PATTERNS[2])
    bp.edges.push({ id: 'plan->review', from: 'plan', to: 'review', type: 'artifact', condition: 'always' })
    expect(unrunnableReasons(bp).join(' ')).toMatch(/continues to 2 nodes/)
  })

  it('lays a pipeline out in columns, keeping the retry edge out of the ordering', () => {
    const cols = flowLevels(fromPattern(PATTERNS[2])).map((c) => c.map((n) => n.id))
    expect(cols).toEqual([['start'], ['plan'], ['build'], ['tests'], ['review']])
  })

  it('accepts node references in prompts and rejects an unknown one', () => {
    const bp = fromPattern(PATTERNS[2])
    const msgs = validateBlueprint(bp).map((p) => p.message)
    expect(msgs.some((m) => m.includes('{{plan.result}}'))).toBe(false)
    const build = bp.nodes.find((n) => n.id === 'build')!
    if (build.kind === 'agent') build.config.prompt = '{{nope.result}} {{plan.output.steps}}'
    const after = validateBlueprint(bp).map((p) => p.message)
    expect(after.some((m) => m.includes('{{nope.result}}'))).toBe(true)
    expect(after.some((m) => m.includes('{{plan.output.steps}}'))).toBe(false)
  })

  it('flags an output schema that is not JSON, and an editing agent with no worktree', () => {
    const bp = fromPattern(PATTERNS[2])
    const build = bp.nodes.find((n) => n.id === 'build')!
    if (build.kind === 'agent') {
      build.config.outputSchema = '{ nope'
      build.config.worktree = false
    }
    const msgs = validateBlueprint(bp)
    expect(msgs.some((p) => p.severity === 'error' && /not valid JSON/.test(p.message))).toBe(true)
    expect(msgs.some((p) => p.severity === 'warning' && /live checkout/.test(p.message))).toBe(true)
  })
})

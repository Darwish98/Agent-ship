import { describe, expect, it } from 'vitest'
import { budgetCeiling, hasErrors, renderTemplate, templateVars, validateBlueprint } from './blueprint'
import { emptyBlueprint, fromPattern, PATTERNS } from './patterns'
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

  it('flags nodes nothing can reach', () => {
    const bp = fromPattern(PATTERNS[0])
    bp.nodes.push({
      id: 'orphan',
      kind: 'agent',
      label: 'Orphan',
      position: { x: 0, y: 0 },
      config: { role: 'o', model: 'default', prompt: 'x', worktree: false, tools: [], outputSchema: '' }
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
    // 3 contenders x 300k (the only agent).
    expect(budgetCeiling(fromPattern(PATTERNS[3]))).toBe(900_000)
  })

  it('multiplies a gate retry loop over the loop body only', () => {
    // plan 150k (outside the loop) + build 600k x (1 + 3 retries)
    // + review 200k (after the gate, outside the loop).
    expect(budgetCeiling(fromPattern(PATTERNS[2]))).toBe(150_000 + 600_000 * 4 + 200_000)
  })
})

describe('shipped prompts', () => {
  it('renders the merge brief with the branches and no leftover placeholders', () => {
    const node = PATTERNS[1].nodes.find((n) => n.kind === 'merge')
    if (node?.kind !== 'merge') throw new Error('no merge node')
    const text = renderTemplate(node.config.resolverPrompt, {
      baseBranch: 'main',
      branches: '  - feat/a\n  - feat/b'
    })
    expect(text).toContain('Land these branches on "main"')
    expect(text).toContain('  - feat/a\n  - feat/b')
    expect(text).not.toMatch(/\{\{/)
  })

  it('passes the supervisor brief through untouched', () => {
    const node = PATTERNS[0].nodes.find((n) => n.kind === 'agent')
    if (node?.kind !== 'agent') throw new Error('no agent node')
    expect(renderTemplate(node.config.prompt, { brief: 'do the thing {{x}}' })).toBe('do the thing {{x}}')
  })
})

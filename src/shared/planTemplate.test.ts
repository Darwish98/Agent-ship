import { describe, expect, it } from 'vitest'
import { buildPlanBlueprint } from './patterns'
import { DESIGN_FILE, OVERVIEW_FILE, PLAN_FILE, PLAN_ITEM_FORMAT, PLAN_TEMPLATE, planDoc, templateForPrompt, templateMarkdown } from './planTemplate'

describe('plan template', () => {
  it('has three documents, all inside planning/, with unique section ids', () => {
    expect(PLAN_TEMPLATE.map((d) => d.file)).toEqual([OVERVIEW_FILE, DESIGN_FILE, PLAN_FILE])
    for (const d of PLAN_TEMPLATE) {
      expect(d.file.startsWith('planning/')).toBe(true)
      const ids = d.sections.map((s) => s.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(d.sections.some((s) => s.required)).toBe(true)
    }
  })

  it('the skeleton of each document carries every section heading and hint', () => {
    for (const d of PLAN_TEMPLATE) {
      const md = templateMarkdown(d.id)
      expect(md.startsWith(`# ${d.title}`)).toBe(true)
      for (const s of d.sections) expect(md).toContain(s.title)
    }
    expect(templateMarkdown('plan')).toContain('Done when')
    expect(templateMarkdown('overview', 'Acme')).toMatch(/^# Acme - Overview/)
  })

  it('every plan item must say how to tell it is done', () => {
    expect(PLAN_ITEM_FORMAT).toMatch(/Done when/)
    expect(planDoc('plan').sections[0].id).toBe('items')
  })

  it('the prompt text lists every file and section, and the writing flow uses it', () => {
    const text = templateForPrompt()
    for (const d of PLAN_TEMPLATE) {
      expect(text).toContain(d.file)
      for (const s of d.sections) expect(text).toContain(s.hint)
    }
    const write = buildPlanBlueprint().nodes.find((n) => n.kind === 'agent')!
    if (write.kind === 'agent') expect(write.config.prompt).toContain(text)
  })
})

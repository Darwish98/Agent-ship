import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PLAN_FILE } from '../shared/patterns'
import { planExists, savePlan } from './plan'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-test-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('planExists', () => {
  it('is false when there is no plan file, true once one is written', () => {
    expect(planExists(dir)).toBe(false)
    fs.writeFileSync(path.join(dir, PLAN_FILE), 'x')
    expect(planExists(dir)).toBe(true)
  })

  it('never throws for a project directory that does not exist at all', () => {
    expect(planExists(path.join(dir, 'nope', 'nope'))).toBe(false)
  })
})

describe('savePlan', () => {
  it('writes the text as PLAN.md, trimmed and newline-terminated', () => {
    const r = savePlan(dir, '  # My plan\n\n1. Do the thing  \n')
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(path.join(dir, PLAN_FILE), 'utf8')).toBe('# My plan\n\n1. Do the thing\n')
  })

  it('overwrites an existing plan', () => {
    savePlan(dir, 'first')
    savePlan(dir, 'second')
    expect(fs.readFileSync(path.join(dir, PLAN_FILE), 'utf8')).toBe('second\n')
  })

  it('refuses an empty or whitespace-only plan, and touches nothing', () => {
    expect(savePlan(dir, '').ok).toBe(false)
    expect(savePlan(dir, '   \n  ').ok).toBe(false)
    expect(planExists(dir)).toBe(false)
  })

  it('refuses a plan over the size cap', () => {
    const r = savePlan(dir, 'x'.repeat(300_000))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/too long/)
  })
})

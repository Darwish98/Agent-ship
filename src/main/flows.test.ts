import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyBlueprint } from '../shared/patterns'
import { deleteFlow, listFlows, loadFlow, peekFlow, saveFlow } from './flows'

let userData: string
let repo: string
const PROJECT = 'p1'

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flows-test-'))
  userData = path.join(root, 'userdata')
  repo = path.join(root, 'repo')
  fs.mkdirSync(userData)
  fs.mkdirSync(repo)
  fs.writeFileSync(path.join(userData, 'shipyard.json'), JSON.stringify([{ id: PROJECT, name: 'repo', path: repo }]))
})

afterEach(() => {
  fs.rmSync(path.dirname(userData), { recursive: true, force: true })
})

const flowFile = (slug: string): string => path.join(repo, '.agentship', 'flows', `${slug}.flow.json`)

describe('flow store', () => {
  it('saves into the repo, then lists and loads it back', () => {
    const saved = saveFlow(userData, PROJECT, 'my-flow', emptyBlueprint('My flow'))
    expect(saved.ok).toBe(true)
    expect(fs.existsSync(flowFile('my-flow'))).toBe(true)

    expect(listFlows(userData, PROJECT).map((f) => f.name)).toEqual(['My flow'])
    const loaded = loadFlow(userData, PROJECT, 'my-flow')
    expect(loaded.ok && loaded.blueprint.name).toBe('My flow')
  })

  it('leaves no temp file behind after a save', () => {
    saveFlow(userData, PROJECT, 'a', emptyBlueprint())
    expect(fs.readdirSync(path.dirname(flowFile('a')))).toEqual(['a.flow.json'])
  })

  it('refuses an unregistered project, so the renderer cannot pick a directory', () => {
    const r = saveFlow(userData, 'not-registered', 'a', emptyBlueprint())
    expect(r.ok).toBe(false)
    expect(fs.existsSync(path.join(repo, '.agentship'))).toBe(false)
  })

  it.each(['../evil', '..\\evil', 'a/b', 'A', '', '.hidden', 'x'.repeat(65)])(
    'refuses the slug %j',
    (slug) => {
      expect(saveFlow(userData, PROJECT, slug, emptyBlueprint()).ok).toBe(false)
      expect(loadFlow(userData, PROJECT, slug).ok).toBe(false)
      expect(deleteFlow(userData, PROJECT, slug).ok).toBe(false)
    }
  )

  it('rejects an invalid blueprint without touching the existing file', () => {
    saveFlow(userData, PROJECT, 'a', emptyBlueprint('Good'))
    const before = fs.readFileSync(flowFile('a'), 'utf8')
    expect(saveFlow(userData, PROJECT, 'a', { name: '', nodes: [], edges: [] }).ok).toBe(false)
    expect(fs.readFileSync(flowFile('a'), 'utf8')).toBe(before)
  })

  it('lists a corrupt file as unreadable instead of throwing', () => {
    fs.mkdirSync(path.dirname(flowFile('bad')), { recursive: true })
    fs.writeFileSync(flowFile('bad'), '{ not json')
    const [entry] = listFlows(userData, PROJECT)
    expect(entry.slug).toBe('bad')
    expect(entry.error).toBeTruthy()
  })

  describe('external edits (compare-and-swap)', () => {
    it('accepts a save made against the version on disk, and returns the new hash', () => {
      const first = saveFlow(userData, PROJECT, 'a', emptyBlueprint('One'), null)
      if (!first.ok) throw new Error(first.error)
      const second = saveFlow(userData, PROJECT, 'a', emptyBlueprint('Two'), first.hash)
      expect(second.ok).toBe(true)
      expect(peekFlow(userData, PROJECT, 'a')).toBe(second.ok ? second.hash : '')
    })

    it('refuses to overwrite a file that changed underneath the editor', () => {
      const first = saveFlow(userData, PROJECT, 'a', emptyBlueprint('Mine'), null)
      if (!first.ok) throw new Error(first.error)
      // e.g. `git checkout` brought a different version
      const theirs = JSON.stringify({ ...emptyBlueprint('Theirs') }, null, 2)
      fs.writeFileSync(flowFile('a'), theirs)
      const r = saveFlow(userData, PROJECT, 'a', emptyBlueprint('Mine v2'), first.hash)
      expect(r.ok).toBe(false)
      expect(!r.ok && r.conflict).toBe(true)
      expect(fs.readFileSync(flowFile('a'), 'utf8')).toBe(theirs)
    })

    it('lets the user deliberately keep their copy', () => {
      saveFlow(userData, PROJECT, 'a', emptyBlueprint('Mine'), null)
      fs.writeFileSync(flowFile('a'), '{}')
      expect(saveFlow(userData, PROJECT, 'a', emptyBlueprint('Mine v2')).ok).toBe(true)
    })

    it('does not let a new flow silently replace an existing file of the same name', () => {
      saveFlow(userData, PROJECT, 'a', emptyBlueprint('Existing'), null)
      const r = saveFlow(userData, PROJECT, 'a', emptyBlueprint('New'), null)
      expect(!r.ok && r.conflict).toBe(true)
    })

    it('reports a deleted file as a conflict, and peek as null', () => {
      const first = saveFlow(userData, PROJECT, 'a', emptyBlueprint(), null)
      if (!first.ok) throw new Error(first.error)
      fs.rmSync(flowFile('a'))
      expect(peekFlow(userData, PROJECT, 'a')).toBeNull()
      const r = saveFlow(userData, PROJECT, 'a', emptyBlueprint(), first.hash)
      expect(!r.ok && r.conflict).toBe(true)
    })
  })

  it('deletes only the flow file', () => {
    saveFlow(userData, PROJECT, 'a', emptyBlueprint())
    expect(deleteFlow(userData, PROJECT, 'a').ok).toBe(true)
    expect(fs.existsSync(flowFile('a'))).toBe(false)
    expect(fs.existsSync(repo)).toBe(true)
  })
})

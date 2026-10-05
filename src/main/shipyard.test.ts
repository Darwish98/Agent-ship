import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addProject, hideProjectPath, loadHiddenProjects, loadProjects, removeProject } from './shipyard'

let dir: string
let repo: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-test-'))
  repo = path.join(dir, 'my-repo')
  fs.mkdirSync(repo)
  fs.writeFileSync(path.join(repo, 'keep.txt'), 'x')
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))

describe('removing a project', () => {
  it('drops it from the list, hides its folder, and touches nothing on disk', () => {
    const [p] = addProject(dir, repo)
    expect(removeProject(dir, p.id)).toEqual([])
    expect(loadProjects(dir)).toEqual([])
    expect(loadHiddenProjects(dir)).toEqual([path.resolve(repo)])
    expect(fs.readFileSync(path.join(repo, 'keep.txt'), 'utf8')).toBe('x')
  })

  it('adding the folder again lifts the hiding', () => {
    const [p] = addProject(dir, repo)
    removeProject(dir, p.id)
    addProject(dir, repo)
    expect(loadHiddenProjects(dir)).toEqual([])
    expect(loadProjects(dir)).toHaveLength(1)
  })

  it('hiding a folder that was never registered is remembered once, case-insensitively', () => {
    hideProjectPath(dir, repo)
    hideProjectPath(dir, repo.toLowerCase())
    expect(loadHiddenProjects(dir)).toHaveLength(1)
  })

  it('removing an unknown id changes nothing', () => {
    addProject(dir, repo)
    expect(removeProject(dir, 'nope')).toHaveLength(1)
    expect(loadHiddenProjects(dir)).toEqual([])
  })
})

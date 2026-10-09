// Opt-in: runs the REAL Autopilot flow with the REAL `claude` CLI on scratch projects
// and prints a timeline of what it did and what it cost. Spends real usage.
//   AGENT_SHIP_LIVE=1 AUTOPILOT_EVAL=<names> AUTOPILOT_EVAL_ROOT=<folder> npx vitest run src/main/engine/autopilot.live.test.ts
// <names> is a comma list of: ticks, legacy, python, project. `project` copies the
// markdown files in AUTOPILOT_EVAL_PLAN_DIR (a folder holding OVERVIEW.md, DESIGN.md,
// PLAN.md) into a fresh repo, and stops itself once AUTOPILOT_EVAL_MAX_USD is spent.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fromPattern, PATTERNS } from '../../shared/patterns'
import { foldRun, type RunEvent } from '../../shared/runs'
import { ClaudeCodeAdapter } from './adapter'
import { RunEngine } from './runner'

const live = Boolean(process.env.AGENT_SHIP_LIVE)
const wanted = (process.env.AUTOPILOT_EVAL ?? 'ticks').split(',').map((s) => s.trim())

const TICKS = `# Slug tool - Plan

- [ ] 1. **Slugify.** Add \`src/slug.js\` exporting \`slugify(text)\` (lower-case, runs of non-alphanumerics become one "-", no leading/trailing "-") and \`test/slug.test.js\` using node:test.
      Why: the core of the tool.
      Done when: \`npm test\` passes, including a test that \`slugify("  Hello, World!! ")\` is \`"hello-world"\`.

- [ ] 2. **Word count.** Add \`src/words.js\` exporting \`countWords(text)\` (whitespace-separated words; empty string is 0) and \`test/words.test.js\`.
      Why: the second thing the CLI reports.
      Done when: \`npm test\` passes with tests for an empty string, one word, and several words separated by mixed whitespace.

- [ ] 3. **CLI.** Add \`bin/tool.js\` that reads its arguments as one string and prints the slug and the word count in colour using the \`picocolors\` package, and add \`picocolors\` as a dependency in package.json. Add \`test/cli.test.js\` that runs it with child_process and checks the output contains the slug.
      Why: makes it usable from a terminal.
      Done when: \`npm test\` passes and \`node bin/tool.js "Hello World"\` prints hello-world.
`

const LEGACY = `# Duration tools - Plan

1. **Project setup.** Create a TypeScript project: package.json with devDependencies \`typescript\` and \`vitest\` and the script \`"test": "vitest run"\`, a tsconfig.json, and \`src/index.ts\` exporting nothing yet. Add one trivial test in \`test/smoke.test.ts\`.
   Why: everything else builds on it.
   Done when: \`npm test\` passes with at least one test.

2. **Stack.** Add \`src/stack.ts\` with a generic \`Stack<T>\` class (push, pop, peek, size). \`pop\` and \`peek\` on an empty stack throw an Error with the message "empty". Add \`test/stack.test.ts\` covering push/pop order, size, and both empty-stack errors.
   Why: a small data structure with edge cases.
   Done when: \`npm test\` passes, including the empty-stack error cases.

3. **Duration parser.** Add \`src/duration.ts\` exporting \`parseDuration(input: string): number\` returning seconds for strings like "1h30m", "45s", "2h" (units h, m, s, in any order, each at most once). Anything else, including an empty string, throws an Error. Add \`test/duration.test.ts\` with valid and invalid cases.
   Why: a parser where the edge cases matter.
   Done when: \`npm test\` passes, with tests for repeated units and an empty string.
`

const PYTHON = `# Text stats (Python) - Plan

- [ ] 1. **Word frequency.** Add \`textstats/freq.py\` with \`word_freq(text: str) -> dict[str, int]\` (lower-cased words, punctuation ignored) and \`tests/test_freq.py\` using unittest, with tests for an empty string and repeated words differing in case.
      Why: the core function.
      Done when: \`python -m unittest discover -s tests\` passes and includes those tests.

- [ ] 2. **Longest word.** Add \`textstats/longest.py\` with \`longest_word(text: str) -> str\` (first one wins a tie; empty string gives ""), and \`tests/test_longest.py\`.
      Why: a second function with a tie rule.
      Done when: \`python -m unittest discover -s tests\` passes, with a test for the tie rule.
`

interface Scenario {
  key: string
  name: string
  /** What to put in the repo: file name -> content. */
  files: Record<string, string>
  base: string
  test: string
  maxUsd: number
  /** Overrides for the shipped flow's caps, so an evaluation cannot run away. */
  passes: number
  builderUsd: number
}

function scenarios(): Scenario[] {
  const out: Scenario[] = [
    {
      key: 'ticks',
      name: 'tick-box plan, node:test, no dependencies, main',
      files: { 'planning/PLAN.md': TICKS, 'package.json': JSON.stringify({ name: 'slug-tool', version: '0.1.0', private: true, scripts: { test: 'node --test' } }, null, 2), '.gitignore': 'node_modules\n' },
      base: 'main', test: 'npm test', maxUsd: 3, passes: 5, builderUsd: 0.75
    },
    {
      key: 'legacy',
      name: 'older numbered plan, typescript + vitest installed for real',
      files: { 'planning/PLAN.md': LEGACY, 'package.json': JSON.stringify({ name: 'duration-tools', version: '0.1.0', private: true, scripts: { test: 'echo no tests yet && exit 1' } }, null, 2), '.gitignore': 'node_modules\n' },
      base: 'main', test: 'npm test', maxUsd: 3, passes: 5, builderUsd: 0.75
    },
    {
      key: 'python',
      name: 'python + unittest, base branch is master (nothing here is npm or main)',
      files: { 'planning/PLAN.md': PYTHON, '.gitignore': '__pycache__/\n*.pyc\n', 'textstats/__init__.py': '' },
      base: 'master', test: 'python -m unittest discover -s tests', maxUsd: 3, passes: 4, builderUsd: 0.75
    }
  ]
  const dir = process.env.AUTOPILOT_EVAL_PLAN_DIR
  if (dir && fs.existsSync(dir)) {
    const files: Record<string, string> = {}
    for (const f of ['OVERVIEW.md', 'DESIGN.md', 'PLAN.md']) {
      const p = path.join(dir, f)
      if (fs.existsSync(p)) files[`planning/${f}`] = fs.readFileSync(p, 'utf8')
    }
    out.push({
      key: 'project',
      name: `a real project's own planning files (${path.basename(path.dirname(dir))})`,
      files,
      base: 'main', test: 'npm test', maxUsd: Number(process.env.AUTOPILOT_EVAL_MAX_USD ?? 6), passes: 25, builderUsd: 0.75
    })
  }
  return out
}

describe.skipIf(!live)('autopilot against the real CLI', () => {
  it.each(scenarios().filter((s) => wanted.includes(s.key)))('$name', async (sc) => {
    const dir = path.join(process.env.AUTOPILOT_EVAL_ROOT ?? os.tmpdir(), `autopilot-eval-${sc.key}`)
    const work = `${dir}-work`
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(work, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    const git = (...a: string[]): string => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
    git('init', '-q', '-b', sc.base)
    git('config', 'user.name', 'eval')
    git('config', 'user.email', 'eval@example.com')
    git('config', 'core.autocrlf', 'false')
    for (const [rel, content] of Object.entries(sc.files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      fs.writeFileSync(path.join(dir, rel), content)
    }
    git('add', '-A')
    git('commit', '-q', '-m', 'Initial planning files')

    // The shipped flow, with only the dollar caps and the pass cap tightened.
    const bp = fromPattern(PATTERNS[4])
    for (const n of bp.nodes) {
      if (n.id === 'build') n.budget = { ...n.budget, maxUsd: sc.builderUsd }
      if (n.id === 'progress') n.budget = { maxRetries: sc.passes }
      if (n.id === 'plancheck') n.budget = { maxRetries: 3, maxUsd: 0.3 }
    }

    const events: RunEvent[] = []
    let stoppedForMoney = false
    const engine = new RunEngine({
      adapter: new ClaudeCodeAdapter(),
      worktreeRoot: path.join(work, 'wt'),
      depsRoot: path.join(work, 'deps'),
      emit: (e) => {
        events.push(e)
        // The evaluation's own safety net: the engine's ceiling is a computed worst case, far above this.
        const v = foldRun(events)
        if (v && v.spentUsd > sc.maxUsd && !stoppedForMoney && e.type !== 'run.finished') {
          stoppedForMoney = true
          engine.cancel(e.runId)
        }
      }
    })
    const started = Date.now()
    const r = await engine.start({ projectId: 'eval', projectName: sc.key, projectPath: dir, flowSlug: 'autopilot', blueprint: bp, inputs: { plan: 'planning/PLAN.md', base: sc.base, test: sc.test } })
    if (!r.ok) throw new Error(r.error)
    await engine.whenDone(r.runId)

    const v = foldRun(events)!
    const lines: string[] = []
    let t0 = 0
    for (const e of events) {
      const at = (e as { at: number }).at
      if (!t0) t0 = at
      const sec = `${String(Math.round((at - t0) / 1000)).padStart(4)}s`
      if (e.type === 'node.finished') lines.push(`${sec}  ${e.nodeId.padEnd(9)} #${e.attempt} ${e.status}  $${(e.costUsd ?? 0).toFixed(3)}  ${e.tokens ?? 0} tok  ${String(e.summary ?? e.error ?? '').replace(/\s+/g, ' ').slice(0, 120)}`)
      else if (e.type === 'gate.result') lines.push(`${sec}  ${e.nodeId.padEnd(9)} #${e.attempt} gate ${e.pass ? 'PASS' : 'FAIL'}  ${e.detail.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').slice(0, 140)}`)
      else if (e.type === 'run.finished') lines.push(`${sec}  RUN ${e.status}: ${e.reason}`)
    }
    const items = git('show', `${sc.base}:planning/PLAN.md`).split('\n').filter((l) => /^\s*(?:[-*+]|\d+[.)])\s+\[/.test(l)).map((l) => l.slice(0, 90))
    console.log(
      `\n=== AUTOPILOT EVAL: ${sc.name} ===\nproject: ${dir}\nstatus: ${v.status}${stoppedForMoney ? ' (stopped by the evaluation: over $' + sc.maxUsd + ')' : ''}  spent: $${v.spentUsd.toFixed(3)}  wall: ${Math.round((Date.now() - started) / 1000)}s\n\n${lines.join('\n')}\n\n${sc.base} log:\n${git('log', '--oneline', sc.base)}\n\nplan on ${sc.base}:\n${items.join('\n')}\n`
    )
    expect(['passed', 'failed', 'budget', 'cancelled']).toContain(v.status)
  }, 3_600_000)
})

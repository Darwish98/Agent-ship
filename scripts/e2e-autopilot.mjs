// Drives the REAL Agent Ship app (Electron, built with `npm run build`) through the
// Floor's Autopilot switch on a scratch project, with the REAL `claude` CLI. It spends
// real usage. Isolated: its own user-data dir and hook port; nothing of yours is touched.
//
//   npm run build && node scripts/e2e-autopilot.mjs --shots ./e2e-shots
//   node scripts/e2e-autopilot.mjs --plan python      (a Python project on `master`)
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : fallback
}
const KIND = arg('--plan', 'node')
const NODE_ENV = arg('--node-env', '')
const SHOTS = path.resolve(arg('--shots', 'e2e-shots'))
const MAX_MIN = Number(arg('--minutes', 12))
const CDP_PORT = 9334
const HOOK_PORT = 8991

const NODE_PLAN = `# Slug tool - Plan

- [ ] 1. **Slugify.** Add \`src/slug.js\` exporting \`slugify(text)\` (lower-case, runs of non-alphanumerics become one "-", no leading or trailing "-") and \`test/slug.test.js\` using node:test.
      Why: the core of the tool.
      Done when: \`npm test\` passes, including a test that \`slugify("  Hello, World!! ")\` is \`"hello-world"\`.

- [ ] 2. **Word count.** Add \`src/words.js\` exporting \`countWords(text)\` (whitespace-separated words; an empty string is 0) and \`test/words.test.js\`.
      Why: the second thing the tool reports.
      Done when: \`npm test\` passes with tests for an empty string, one word, and several words separated by mixed whitespace.
`
const VITE_PLAN = `# Neighbourhood toy - Plan

- [ ] 1. **Scaffold.** Create a Vite + TypeScript project with \`three\` and \`@types/three\` as dependencies and \`vite\`, \`typescript\` and \`vitest\` as devDependencies. Add \`index.html\`, \`src/main.ts\` (a renderer, scene, light and a rotating cube), a tsconfig, and the scripts \`dev\`, \`build\` and \`test\`. Add one smoke test.
      Why: everything else builds on it.
      Done when: \`npm run build\` passes and \`npm test\` passes with at least one test.

- [ ] 2. **Layout data.** Add \`src/layout.ts\` exporting \`roadGrid()\`: road segments for a neighbourhood about 150 m across (a 3 by 3 grid of blocks), as plain data, with tests that every segment lies inside the map and that segments meet at intersections.
      Why: the world is built from data.
      Done when: \`npm test\` passes with those tests.

- [ ] 3. **Ball physics.** Add \`src/ball.ts\` with pure functions \`stepBall(state, dt)\` for a ball under gravity bouncing on the ground with restitution 0.7, and tests showing it bounces at least 3 times with decreasing height and comes to rest.
      Why: the core toy.
      Done when: \`npm test\` passes with those tests.

- [ ] 4. **Player movement.** Add \`src/player.ts\` with a pure \`movePlayer(state, input, dt)\` for WASD movement at a fixed speed, normalised on diagonals, clamped to the map, with tests for each direction, a diagonal and the map edge.
      Why: the character walks around.
      Done when: \`npm test\` passes with those tests.

- [ ] 5. **Follow camera.** Add \`src/camera.ts\` with \`cameraFor(target)\` returning a fixed top-right offset position and look-at point, with tests that the offset never changes as the target moves.
      Why: the fixed angled camera.
      Done when: \`npm test\` passes with those tests.

- [ ] 6. **Scene.** Add \`src/scene.ts\` exporting \`createScene()\` that builds a THREE.Scene with a ground plane sized from the layout and a light, with a test (it runs in node, no browser) that checks the scene contains a ground mesh and a light, and make \`src/main.ts\` use it.
      Why: ties layout and rendering together.
      Done when: \`npm run build\` and \`npm test\` pass.

- [ ] 7. **Respawn rule.** Add \`src/respawn.ts\` with \`shouldRespawn(ball, courtCentre, restSeconds)\`: true when the ball is below y -5 or has rested more than 5 seconds more than 20 m from the court, with tests for both rules and for a ball resting near the court.
      Why: the ball must not get lost.
      Done when: \`npm test\` passes with those tests.

- [ ] 8. **Game state.** Add \`src/game.ts\`: a small state machine (title, playing, paused) with \`next(state, event)\` and tests for every legal and illegal transition.
      Why: menus and pause need it.
      Done when: \`npm test\` passes and \`npm run build\` passes.
`
const PY_PLAN = `# Text stats (Python) - Plan

- [ ] 1. **Word frequency.** Add \`textstats/freq.py\` with \`word_freq(text: str) -> dict[str, int]\` (lower-cased words, punctuation ignored) and \`tests/test_freq.py\` using unittest, with tests for an empty string and repeated words that differ in case.
      Why: the core function.
      Done when: \`python -m unittest discover -s tests\` passes and includes those tests.

- [ ] 2. **Longest word.** Add \`textstats/longest.py\` with \`longest_word(text: str) -> str\` (the first wins a tie; an empty string gives ""), and \`tests/test_longest.py\`.
      Why: a second function with a tie rule.
      Done when: \`python -m unittest discover -s tests\` passes, with a test for the tie rule.
`

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentship-e2e-'))
const userData = path.join(tmp, 'userdata')
const project = path.join(tmp, KIND === 'python' ? 'text-stats' : KIND === 'vite' ? 'neighbourhood-toy' : 'slug-tool')
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(path.join(project, 'planning'), { recursive: true })
const git = (...a) => execFileSync('git', a, { cwd: project, encoding: 'utf8' }).trim()
git('init', '-q', '-b', KIND === 'python' ? 'master' : 'main')
git('config', 'user.name', 'e2e')
git('config', 'user.email', 'e2e@example.com')
git('config', 'core.autocrlf', 'false')
if (KIND === 'python') {
  fs.mkdirSync(path.join(project, 'textstats'))
  fs.writeFileSync(path.join(project, 'textstats', '__init__.py'), '')
  fs.writeFileSync(path.join(project, '.gitignore'), '__pycache__/\n*.pyc\n')
  fs.writeFileSync(path.join(project, 'planning', 'PLAN.md'), PY_PLAN)
  // Where a Python project keeps its test command: the app has to find it by itself.
  fs.writeFileSync(path.join(project, 'pyproject.toml'), '[project]\nname = "text-stats"\nversion = "0.1.0"\n')
} else if (KIND === 'vite') {
  // A new project, like a person's first: nothing but the plan.
  fs.writeFileSync(path.join(project, '.gitignore'), ['node_modules', 'dist', ''].join(String.fromCharCode(10)))
  fs.writeFileSync(path.join(project, 'planning', 'PLAN.md'), VITE_PLAN)
} else {
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'slug-tool', version: '0.1.0', private: true, scripts: { test: 'node --test' } }, null, 2))
  fs.writeFileSync(path.join(project, '.gitignore'), 'node_modules\n')
  fs.writeFileSync(path.join(project, 'planning', 'PLAN.md'), NODE_PLAN)
}
git('add', '-A')
git('commit', '-q', '-m', 'Initial plan')
fs.writeFileSync(path.join(userData, 'shipyard.json'), JSON.stringify([{ id: 'e2e1', name: path.basename(project), path: project }]))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? '  ok ' : ' FAIL'}  ${what}`)
  if (!ok) failures++
}

const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const child = spawn(electron, [root, `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`], {
  env: { ...process.env, AGENT_SHIP_PORT: String(HOOK_PORT), AGENT_SHIP_SKIP_HOOKS: '1', ...(NODE_ENV ? { NODE_ENV } : {}) },
  stdio: 'ignore'
})
const killApp = () => (process.platform === 'win32' ? spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) : child.kill('SIGTERM'))

async function cdpTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  throw new Error('Electron never exposed a CDP page')
}

try {
  const ws = new WebSocket(await cdpTarget())
  await new Promise((r) => (ws.onopen = r))
  let seq = 0
  const pending = new Map()
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg)
  }
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evalJs = async (expression) => {
    const msg = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (msg.error || msg.result?.exceptionDetails) throw new Error(JSON.stringify(msg.error ?? msg.result.exceptionDetails.text))
    return msg.result.result.value
  }
  const shot = async (name) => {
    fs.mkdirSync(SHOTS, { recursive: true })
    await sleep(400)
    const res = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(res.result.data, 'base64'))
  }
  const waitFor = async (fn, ms = 10000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await fn()) return true
      await sleep(250)
    }
    return false
  }
  const clickIn = (scope, selector, text) =>
    evalJs(`(() => {
      const root = ${scope} ;
      const el = [...(root ?? document).querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.includes(${JSON.stringify(text)}) && !e.disabled);
      if (!el) return false; el.click(); return true;
    })()`)

  check(await waitFor(() => evalJs(`Boolean(document.querySelector('.fl-lanes'))`), 30000), 'the Floor renders')
  await shot('1-floor')

  // 1. flip the Autopilot switch on the project's row
  const name = path.basename(project)
  const row = `[...document.querySelectorAll('.fl-proj')].find(e => e.textContent.includes(${JSON.stringify(name)}))`
  check(await waitFor(() => evalJs(`Boolean(${row})`), 15000), `the project "${name}" is listed in the rail`)
  check(await evalJs(`Boolean(${row}?.querySelector('.fl-autopilot'))`), 'it has an Autopilot switch')
  await evalJs(`${row}.querySelector('.fl-autopilot').click()`)

  // 2. a plan exists, so the run confirmation opens straight away, pre-filled
  check(await waitFor(() => evalJs(`Boolean(document.querySelector('.rdlg'))`), 15000), 'flipping it opens the run confirmation (the plan already exists)')
  await sleep(800)
  const dlg = await evalJs(`document.querySelector('.rdlg')?.innerText ?? ''`)
  const values = await evalJs(`[...document.querySelectorAll('.rdlg textarea')].map(t => t.value)`)
  console.log('--- the confirmation said:\n' + dlg.split('\n').filter(Boolean).join('\n') + '\n--- inputs: ' + JSON.stringify(values))
  const wantBase = KIND === 'python' ? 'master' : 'main'
  const wantTest = KIND === 'python' ? 'pytest' : 'npm test'
  check(values.includes('planning/PLAN.md'), 'the plan input is filled in')
  check(values.includes(wantBase), `the base branch input is filled in from the repo (${wantBase})`)
  check(values.includes(wantTest), `the test command is detected from the project (${wantTest})`)
  check(/moves your .*branch/i.test(dlg) && dlg.includes(wantBase), `it says it will move your ${wantBase} branch (it does not claim to merge nothing)`)
  check(!/Merges nothing/.test(dlg), 'it does not claim "Merges nothing"')
  // The spending limit is the person's, with a modest default, not the flow's $500+ worst case.
  const limitDefault = await evalJs(`document.querySelector('.rdlg input[type=number]')?.value ?? ''`)
  check(limitDefault !== '' && Number(limitDefault) > 0 && Number(limitDefault) <= 10, `there is a spending limit field with a modest default ($${limitDefault})`)
  const shownMax = Number((/Spends at most \$([\d,.]+)/.exec(dlg) ?? [])[1]?.replace(/,/g, ''))
  check(shownMax > 0 && shownMax <= 10, `the confirmation says it spends at most $${shownMax}, not the flow's worst case`)
  // If the detected test program is missing on this machine, the dialog must say so (and only then).
  const missing = spawnSync(process.platform === 'win32' ? 'where' : 'which', [wantTest.split(' ')[0]], { stdio: 'ignore' }).status !== 0
  await sleep(600)
  const warned = await evalJs(`document.querySelector('.rdlg')?.innerText.includes('was not found on this machine') ?? false`)
  check(warned === missing, `the dialog ${missing ? 'warns that' : 'does not warn about'} "${wantTest.split(' ')[0]}" ${missing ? 'is not installed' : '(it is installed)'}`)
  await shot('2-confirmation')
  // `--warning-only`: type a command that cannot exist, check the dialog says so, and stop without spending anything.
  if (process.argv.includes('--warning-only')) {
    await evalJs(`(() => {
      const t = [...document.querySelectorAll('.rdlg textarea')].find(x => x.value === ${JSON.stringify(wantTest)});
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, 'definitely-not-a-program-xyz --run');
      t.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    check(await waitFor(() => evalJs(`document.querySelector('.rdlg')?.innerText.includes('"definitely-not-a-program-xyz" was not found on this machine')`), 5000), 'a test command that cannot run is called out in the dialog')
    await shot('2b-warning')
    check(await evalJs(`!document.querySelector('.rdlg button.btn-primary')?.disabled`), 'and it is a warning, not a block (the person may know better)')
    throw Object.assign(new Error('warning-only: stopped before starting'), { stopQuietly: true })
  }
  // Choose a limit of $2 for this run.
  await evalJs(`(() => {
    const i = document.querySelector('.rdlg input[type=number]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '2');
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)

  // For the Python project the detected command (`pytest`) is not installed here;
  // a person would edit the field, so do exactly that.
  if (KIND === 'python') {
    await evalJs(`(() => {
      const t = [...document.querySelectorAll('.rdlg textarea')].find(x => x.value === 'pytest');
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      set.call(t, 'python -m unittest discover -s tests');
      t.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await sleep(300)
  }

  // 3. Start
  check(await evalJs(`(() => { const b = [...document.querySelectorAll('.rdlg button')].find(e => e.textContent.includes('Start run')); if (!b || b.disabled) return false; b.click(); return true })()`), 'Start run is enabled and clicked')
  check(await waitFor(() => evalJs(`!document.querySelector('.rdlg')`), 20000), 'the dialog closes and the run starts')

  // 4. watch it
  const startedAt = Date.now()
  let n = 0
  let view = null
  while (Date.now() - startedAt < MAX_MIN * 60_000) {
    await sleep(15_000)
    view = await evalJs(`window.agentShip.listRuns().then(rs => { const r = rs.find(x => x.events.some(e => e.type === 'run.started' && e.flowSlug === 'autopilot')); if (!r) return null; const ev = r.events; const fin = ev.find(e => e.type === 'run.finished'); return { n: ev.length, finished: fin ? { status: fin.status, reason: fin.reason } : null } })`)
    console.log(`  ${Math.round((Date.now() - startedAt) / 1000)}s  events=${view?.n ?? 0}  ${view?.finished ? 'FINISHED ' + view.finished.status : 'running'}`)
    if (++n % 2 === 0) await shot(`3-running-${String(n).padStart(2, '0')}`)
    if (view?.finished) break
  }
  await sleep(1500)
  await shot('4-final-floor')
  check(Boolean(view?.finished), 'the run finished within the time limit')
  const ceiling = await evalJs(`window.agentShip.listRuns().then(rs => rs.flatMap(r => r.events).find(e => e.type === 'run.started' && e.flowSlug === 'autopilot')?.ceilingUsd)`)
  check(ceiling === 2, `the run's ceiling is the $2 limit that was typed (not the worst case): $${ceiling}`)
  check(!(await evalJs(`${row}?.textContent.includes('changed')`)), "the project row does not claim changed files (Agent Ship's own .agentship folder is not work in progress)")
  check(view?.finished?.status === 'passed', `it passed${view?.finished ? ` (${view.finished.status}: ${view.finished.reason})` : ''}`)

  // 5. the real outcome, in the real repo
  const timeline = await evalJs(`window.agentShip.listRuns().then(rs => { const r = rs.find(x => x.events.some(e => e.type === 'run.started' && e.flowSlug === 'autopilot')); const t0 = r.events[0].at; return r.events.filter(e => ['node.finished','gate.result','run.finished'].includes(e.type)).map(e => Math.round((e.at - t0)/1000) + 's ' + (e.nodeId ?? '') + ' ' + (e.type === 'gate.result' ? (e.pass ? 'PASS ' : 'FAIL ') + String(e.detail).replace(/\\s+/g,' ').slice(0,110) : e.type === 'node.finished' ? e.status + ' $' + (e.costUsd ?? 0).toFixed(3) + ' | ' + String(e.summary ?? e.error ?? '').replace(/\s+/g,' ').slice(-190) : e.status + ': ' + e.reason)) })`)
  console.log('--- timeline\n' + timeline.join('\n'))
  const spent = await evalJs(`window.agentShip.listRuns().then(rs => { const r = rs.find(x => x.events.some(e => e.type === 'run.started' && e.flowSlug === 'autopilot')); return r.events.reduce((s, e) => s + (e.costUsd ?? 0), 0) })`)
  console.log(`spent: $${spent.toFixed(3)}`)
  const base = KIND === 'python' ? 'master' : 'main'
  console.log('--- ' + base + ' log:\n' + git('log', '--oneline', base))
  const planNow = git('show', `${base}:planning/PLAN.md`)
  check(!/\[ \]/.test(planNow), 'every plan item is ticked on the base branch')
  check(git('worktree', 'list').split('\n').length === 1, 'no scratch worktrees are left behind')
  check(fs.readdirSync(path.join(userData, 'worktrees')).length === 0, 'the app\'s scratch folder is empty')
  const tracked = git('ls-tree', '-r', '--name-only', base)
  check(!/node_modules/.test(tracked), 'no node_modules was committed')
  console.log('--- files on ' + base + ':\n' + tracked)
  check(await evalJs(`!document.querySelector('.crash')`), 'the app never showed an error screen')
} catch (err) {
  if (!err.stopQuietly) {
    failures++
    console.log(`FAIL  ${err.stack ?? err}`)
  }
} finally {
  killApp()
}
console.log(failures ? `\n${failures} check(s) failed. Screenshots: ${SHOTS}` : `\nall checks passed. Screenshots: ${SHOTS}`)
process.exit(failures ? 1 : 0)

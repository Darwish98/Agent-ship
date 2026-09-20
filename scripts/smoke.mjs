// End-to-end smoke test against the REAL Electron app (needs `npm run build`
// first). Isolated: its own user-data dir, its own hook-server port, a
// throwaway git repo, and a FAKE `claude` CLI so no tokens are spent.
//
// It drives the real UI through a whole run: launch a flow from the Floor,
// watch its gate fail once and the builder repair it, then check the result is
// a verified branch in a real git repo with the scratch worktree cleaned up.
//
//   npm run build && npm run smoke
//   npm run smoke -- --soak 90 --shots ./shots
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : fallback
}
const SOAK_S = Number(arg('--soak', 12))
const SHOTS = arg('--shots', '') ? path.resolve(arg('--shots', '')) : ''
const CDP_PORT = 9333
const HOOK_PORT = 8990

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentship-smoke-'))
const userData = path.join(tmp, 'userdata')
const project = path.join(tmp, 'demo-project')
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(project, { recursive: true })

const git = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim()
git('init', '-q', '-b', 'main')
git('config', 'user.name', 'smoke')
git('config', 'user.email', 'smoke@example.com')
git('config', 'core.autocrlf', 'false')
fs.writeFileSync(path.join(project, 'README.md'), 'demo\n')
git('add', '-A')
git('commit', '-q', '-m', 'init')

// A second repository that only shows up because a session ran in it: the
// case that used to leave the Blueprints project dropdown empty.
const other = path.join(tmp, 'other-project')
fs.mkdirSync(other, { recursive: true })
const gitOther = (...args) => execFileSync('git', args, { cwd: other, encoding: 'utf8' }).trim()
gitOther('init', '-q', '-b', 'main')
gitOther('config', 'user.name', 'smoke')
gitOther('config', 'user.email', 'smoke@example.com')
fs.writeFileSync(path.join(other, 'README.md'), 'other\n')
gitOther('add', '-A')
gitOther('commit', '-q', '-m', 'init')

// Work a session has done but not committed.
fs.writeFileSync(path.join(project, 'wip-1.txt'), 'x\n')
fs.writeFileSync(path.join(project, 'wip-2.txt'), 'y\n')

fs.writeFileSync(path.join(userData, 'shipyard.json'), JSON.stringify([{ id: 'smoke1', name: 'demo-project', path: project }]))

// A blueprint written by hand (the schema fills in defaults), so the test also
// proves that a file authored outside the editor loads and runs.
const flowsDir = path.join(project, '.agentship', 'flows')
fs.mkdirSync(flowsDir, { recursive: true })
const at = (c) => ({ x: c * 290, y: 0 })
fs.writeFileSync(
  path.join(flowsDir, 'e2e.flow.json'),
  JSON.stringify({
    name: 'E2E build',
    description: 'Builds, tests, reviews.',
    inputs: [{ name: 'task', label: 'Task' }],
    defaultBudget: { maxUsd: 1 },
    nodes: [
      { id: 'start', kind: 'trigger', label: 'Start', position: at(0), config: { type: 'manual' } },
      { id: 'build', kind: 'agent', label: 'Builder', position: at(1), config: { role: 'Builder', prompt: 'Do: {{task}}', worktree: true, access: 'edit' } },
      {
        id: 'tests', kind: 'gate', label: 'Tests pass', position: at(2), budget: { maxRetries: 2 },
        config: { check: 'command', command: 'node -e "process.exit(require(\'fs\').existsSync(\'fixed.txt\')?0:1)"' }
      },
      { id: 'review', kind: 'agent', label: 'Reviewer', position: at(3), config: { role: 'Reviewer', prompt: 'Review: {{build.result}}' } }
    ],
    edges: [
      { id: 'a', from: 'start', to: 'build', type: 'control' },
      { id: 'b', from: 'build', to: 'tests', type: 'branch' },
      { id: 'c', from: 'tests', to: 'review', type: 'verdict', condition: 'pass' },
      { id: 'd', from: 'tests', to: 'build', type: 'verdict', condition: 'fail' }
    ]
  })
)

// The fake CLI: builds on the first call, and only "fixes" the code when asked
// to repair (a --resume), so the gate fails once and the loop is exercised.
const agentsFile = path.join(tmp, 'agents.json')
const setAgents = (status) =>
  fs.writeFileSync(agentsFile, JSON.stringify([{ pid: 4242, cwd: project, kind: 'interactive', sessionId: 'smoke-0', name: 'crew0', status, startedAt: Date.now() }]))
setAgents('busy')
const fake = path.join(tmp, 'fake-claude.cjs')
fs.writeFileSync(
  fake,
  `const fs = require('fs')
const a = process.argv.slice(2)
const at = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : '' }
if (a[0] === 'agents') {
  try { process.stdout.write(fs.readFileSync(${JSON.stringify(agentsFile)}, 'utf8')) } catch { process.stdout.write('[]') }
  process.exit(0)
}
let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  const edit = at('--permission-mode') === 'acceptEdits'
  const resume = a.includes('--resume')
  if (edit) fs.writeFileSync('built.txt', 'built\\n')
  if (edit && resume) fs.writeFileSync('fixed.txt', 'fixed\\n')
  setTimeout(() => {
    console.log(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      result: (edit ? 'edited' : 'read-only') + (resume ? ' (repair)' : ''),
      session_id: at('--session-id') || at('--resume'),
      total_cost_usd: 0.05,
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 1000 }
    }))
  }, 250)
})
`
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? '  ok ' : ' FAIL'}  ${what}`)
  if (!ok) failures++
}

const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const child = spawn(electron, [root, `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`], {
  env: {
    ...process.env,
    AGENT_SHIP_PORT: String(HOOK_PORT),
    AGENT_SHIP_SKIP_HOOKS: '1',
    AGENT_SHIP_CLAUDE_CMD: JSON.stringify([process.execPath, fake])
  },
  stdio: 'ignore'
})

function killApp() {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill('SIGTERM')
}

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

function postEvent(body) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: HOOK_PORT, path: '/event', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      res.resume()
      res.on('end', resolve)
    })
    req.on('error', resolve)
    req.end(JSON.stringify(body))
  })
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
  const evalJs = (expression) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, (msg) => (msg.error || msg.result?.exceptionDetails ? reject(new Error(JSON.stringify(msg.error ?? msg.result.exceptionDetails.text))) : resolve(msg.result.result.value)))
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
    })
  const clickText = (selector, text) =>
    evalJs(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.includes(${JSON.stringify(text)}) && !e.closest('[hidden]'));
      if (!el) return false; el.click(); return true;
    })()`)
  const count = (selector) => evalJs(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
  const shot = async (name) => {
    if (!SHOTS) return
    fs.mkdirSync(SHOTS, { recursive: true })
    await sleep(500)
    const id = ++seq
    const res = await new Promise((resolve) => {
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method: 'Page.captureScreenshot', params: { format: 'png' } }))
    })
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(res.result.data, 'base64'))
  }
  const waitFor = async (fn, ms = 10000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await fn()) return true
      await sleep(200)
    }
    return false
  }

  check(await waitFor(() => count('.fl-lanes'), 25000), 'the Floor renders')

  // --- 1. Floor under sustained event load --------------------------------------
  console.log(`Floor soak: ${SOAK_S}s of events`)
  let crashed = false
  let sawCards = 0
  let dropped = false
  const until = Date.now() + SOAK_S * 1000
  for (let n = 0; Date.now() < until; n++) {
    await postEvent({ sessionId: `smoke-${n % 3}`, agentName: `crew${n % 3}`, role: 'Dev', projectPath: project, project: 'demo-project', hookEvent: 'PreToolUse', toolName: 'Edit' })
    if (await count('.crash')) crashed = true
    const cards = await count('.fc')
    if (cards > 0) sawCards = Math.max(sawCards, cards)
    if (sawCards > 0 && cards === 0) dropped = true
    await sleep(1000)
  }
  check(!crashed, 'no error screen appeared')
  check(sawCards > 0 && !dropped, `cards appeared and never vanished (max ${sawCards})`)
  check((await count('.fl-proj')) >= 1, 'the registered project is listed even before it has any work')
  await shot('1-floor')

  // --- 1b. A session that finished its turn is no longer "building" ---------------
  console.log('Session state')
  // crew0 is the session that was last active in the checkout, so it is the one
  // that owns the uncommitted files (three sessions share this directory).
  await postEvent({ sessionId: 'smoke-0', agentName: 'crew0', role: 'Dev', projectPath: project, project: 'demo-project', hookEvent: 'PreToolUse', toolName: 'Edit' })
  // Every check is pinned to crew0, so nothing else on this machine can satisfy it.
  const crew0 = (lane) =>
    `[...document.querySelectorAll('.fc.fc-k-session.fc-lane-${lane}')].find(e => e.querySelector('.fc-title')?.textContent === 'crew0')`
  const inLane = (lane) => evalJs(`Boolean(${crew0(lane)})`)
  check(await waitFor(() => inLane('running'), 15000), 'while Claude Code reports it busy, crew0 is in Running')
  check(await evalJs(`(${crew0('running')}?.querySelector('.pl-stage.pl-running')?.textContent ?? '').includes('Build')`), 'and Build is lit')
  setAgents('idle') // it finished its response; the process is still open
  check(await waitFor(() => inLane('ready'), 40000), 'once it reports idle it leaves Running for Ready (finished, not landed)')
  check(!(await inLane('running')), 'and is no longer counted as building')
  check(await evalJs(`(${crew0('ready')}?.textContent ?? '').includes('uncommitted file')`), 'its card says it left uncommitted files behind')
  check(
    (await evalJs(`[...(${crew0('ready')}?.querySelectorAll('.pl-stage') ?? [])].map(e => e.className.match(/pl-(passed|idle|running|skipped|failed)/)?.[1]).join()`)) === 'passed,idle,idle,idle',
    'the pipeline reads Build done, then Test, Merge and Land waiting'
  )
  await shot('1b-idle-session')

  // --- 2. A whole run, launched from the Floor ----------------------------------
  console.log('Run a flow from the Floor')
  check(await clickText('.fl-proj-actions .fl-link', 'Run a flow'), 'opened the project launchpad')
  check(await clickText('.fl-launch button', 'E2E build'), 'picked the hand-written flow')
  check(await waitFor(() => count('.rdlg')), 'the confirmation dialog opened')
  const plan = await evalJs(`document.querySelector('.rdlg-plan')?.textContent ?? ''`)
  check(/Builder.*can modify files.*own git branch/.test(plan), 'it says the builder edits, in its own branch')
  check(/runs .*fixed\.txt/.test(plan), 'it names the gate command that will run on your machine')
  check(/Spends at most \$/.test(plan) && /Merges nothing/.test(plan), 'it states a spending ceiling and that nothing is merged')
  await evalJs(`(() => { const t = document.querySelector('.rdlg textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'add a file'); t.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await shot('2-dialog')
  check(await clickText('.rdlg .btn-primary', 'Start run'), 'started the run')

  check(await waitFor(() => count('.fc-k-run'), 8000), 'a run card appeared on the Floor')
  await shot('3-running')

  // The branch shows up in "Ready to land" once the run passes, verified by its gate.
  const verified = await waitFor(() => count('.fc-lane-ready .vb-ok'), 60000)
  check(verified, 'the finished branch is in Ready to land, marked ✓ tests passed')
  await shot('4-verified')

  const branches = git('branch', '--list', 'agentship/*')
  check(/agentship\//.test(branches), 'a real agentship/* branch exists in the repo')
  const branch = branches.replace('*', '').trim().split('\n')[0].trim()
  const files = git('ls-tree', '-r', '--name-only', branch)
  check(files.includes('built.txt') && files.includes('fixed.txt'), 'the branch holds the builder’s work and its repair')
  check(!git('ls-tree', '-r', '--name-only', 'main').includes('built.txt'), 'main is untouched (nothing was merged)')
  check(git('worktree', 'list').split('\n').length === 1, 'the scratch worktree was removed')
  const runsDir = path.join(userData, 'runs')
  const runFile = fs.readdirSync(runsDir).find((f) => f.endsWith('.jsonl'))
  const events = fs.readFileSync(path.join(runsDir, runFile), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  check(events.filter((e) => e.type === 'gate.result').map((e) => e.pass).join() === 'false,true', 'the gate failed once, then passed')
  check(events.some((e) => e.type === 'node.started' && e.nodeId === 'build' && e.attempt === 2), 'the builder was re-run to repair it')
  const cost = events.filter((e) => e.type === 'node.finished').reduce((s, e) => s + e.costUsd, 0)
  check(Math.abs(cost - 0.15) < 1e-6, `the ledger summed the three agent calls (builder, repair, reviewer) ($${cost.toFixed(2)})`)

  // Open the branch card's drawer.
  check(await clickText('.fc.fc-lane-ready', 'agentship/'), 'opened the branch details')
  check(await waitFor(() => evalJs(`(document.querySelector('.fl-drawer')?.textContent ?? '').includes('tests passed')`)), 'the drawer shows the branch as verified')
  await shot('5-drawer')

  // --- 2b. Pipeline inside every card, and landing it -------------------------------
  console.log('Landing')
  const cards = await count('.fc')
  const withStrip = await count('.fc .pl')
  check(cards > 0 && cards === withStrip, `every card carries a pipeline strip (${withStrip}/${cards})`)
  const stageText = await evalJs(`(document.querySelector('.fl-drawer .pp')?.innerText ?? '').replace(/\\s+/g, ' ')`)
  check(/Build.*Test.*Merge.*Land/.test(stageText), 'the drawer shows the pipeline')
  check(await clickText('.fl-drawer .pl-stage', 'Test'), 'opened the Test stage')
  check(await waitFor(() => evalJs(`(document.querySelector('.fl-drawer .pp')?.innerText ?? '').includes('A gate passed')`)), 'the Test stage says what proved it')
  await evalJs(`document.querySelector('.fl-drawer .btn-primary')?.click()`)
  check(await waitFor(() => count('.rdlg')), 'Land… opened its dialog')
  await waitFor(() => count('.rdlg-plan')) // the plan is computed by the main process
  const landPlan = await evalJs(`document.querySelector('.rdlg-plan')?.innerText ?? ''`)
  check(/Test the branch/.test(landPlan) && /Merge/.test(landPlan) && /Test the merged result/.test(landPlan) && /only now does/.test(landPlan), 'it lists test, merge, test the merge, then land')
  check(/left exactly as it is now/.test(landPlan), 'it promises the base branch is untouched if anything fails')
  // This project has no package.json, so nothing is detected: the user supplies the test.
  const testCmd = `node -e "process.exit(require('fs').existsSync('built.txt')?0:1)"`
  await evalJs(`(() => { const i = document.querySelector('.rdlg input:not([type=checkbox])'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(testCmd)}); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await shot('5b-land-dialog')
  const mainBefore = git('rev-parse', 'main')
  check(await clickText('.rdlg .btn-primary', 'Land it'), 'started landing')
  check(await waitFor(() => count('.fc-k-branch.fc-lane-running'), 8000) || (await waitFor(() => git('rev-parse', 'main') !== mainBefore, 30000)), 'the branch card moved to Running while it landed')
  check(await waitFor(() => git('rev-parse', 'main') !== mainBefore, 45000), 'main moved')
  const landed = git('ls-tree', '-r', '--name-only', 'main')
  check(landed.includes('built.txt') && landed.includes('fixed.txt'), 'main now contains the branch’s work')
  check(git('rev-list', '--parents', '-n', '1', 'main').split(' ').length === 3, 'as a real merge commit')
  check(fs.existsSync(path.join(project, 'built.txt')), 'and the checked-out files updated with it')
  // The run reports "finished" a moment before its final cleanup removes the scratch copies.
  check(await waitFor(() => git('worktree', 'list').split('\n').length === 1, 8000), 'the scratch copies are gone')
  check(await waitFor(() => evalJs(`[...document.querySelectorAll('.fc-lane-done')].some(e => e.textContent.includes('Landed'))`), 20000), 'the finished landing shows in Done as "Landed"')
  await shot('5c-landed')

  // --- 3. Blueprint editor ------------------------------------------------------
  console.log('Blueprint editor')
  check(await clickText('.rail-btn', 'Blueprints'), 'switched to the Blueprints view')
  check(await waitFor(() => count('.bp-library')), 'library is shown')
  check(await waitFor(() => evalJs(`document.querySelectorAll('.bp-project select option').length >= 1`)), 'the project dropdown is not empty')
  // A folder that was only discovered from a session is offered, and registered when chosen.
  await postEvent({ sessionId: 'other-1', agentName: 'wanderer', role: 'Dev', projectPath: other, project: 'other-project', hookEvent: 'PreToolUse', toolName: 'Read' })
  check(await waitFor(() => evalJs(`[...document.querySelectorAll('.bp-project select option')].some(o => o.textContent.includes('other-project') && o.textContent.includes('not added yet'))`), 10000), 'a discovered project is offered as "not added yet"')
  await evalJs(`(() => { const s = document.querySelector('.bp-project select'); const o = [...s.options].find(o => o.textContent.includes('other-project')); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, o.value); s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  check(await waitFor(() => fs.readFileSync(path.join(userData, 'shipyard.json'), 'utf8').includes('other-project'), 8000), 'choosing it registered the project')
  check(await waitFor(() => evalJs(`document.querySelector('.bp-project select')?.selectedOptions[0]?.textContent === 'other-project'`), 8000), 'and selected it')
  // Back to the project the rest of the test uses.
  await evalJs(`(() => { const s = document.querySelector('.bp-project select'); const o = [...s.options].find(o => o.textContent === 'demo-project'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, o.value); s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  await sleep(600)
  await shot('6-library')
  // The library shows at once; its flow list arrives a moment later.
  check(await waitFor(() => clickText('.bp-card-main', 'E2E build')), 'opened the flow that was just run')
  check(await waitFor(() => count('.bp-runbar')), 'the editor shows that flow’s latest run')
  check(await waitFor(() => count('.bp-editor .bp-run-passed')), 'its nodes are lit by the run')
  await shot('7-editor-run')
  check(await waitFor(() => clickText('.bp-toolbar .btn', 'Flows')), 'went back to the library')
  check(await waitFor(() => clickText('.bp-card-main', 'Plan')), 'created a flow from the Pipeline pattern')
  check(await waitFor(() => evalJs(`document.querySelectorAll('.bp-editor .react-flow__node').length === 5`)), 'editor shows all 5 nodes')
  const file = path.join(flowsDir, 'plan-build-test-review.flow.json')
  check(await waitFor(() => fs.existsSync(file)), 'flow file written into the project repo')
  check(await clickText('.bp-palette-item', 'Agent'), 'added an Agent node from the palette')
  check(await waitFor(() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).nodes.length === 6 } catch { return false } }, 5000), 'autosave persisted the new node')

  // Simulate `git checkout` bringing a different version of the open file.
  const theirs = JSON.parse(fs.readFileSync(file, 'utf8'))
  theirs.name = 'Changed by git'
  theirs.nodes = theirs.nodes.slice(0, 5)
  fs.writeFileSync(file, JSON.stringify(theirs, null, 2))
  check(await waitFor(() => evalJs(`document.querySelector('.bp-flow-name')?.textContent === 'Changed by git'`), 8000), 'an outside edit to the open file was picked up, not overwritten')

  // --- 4. Back to the Floor -----------------------------------------------------
  check(await clickText('.rail-btn', 'Floor'), 'switched back to the Floor')
  await sleep(1000)
  check((await count('.fl-lanes')) === 1 && (await count('.crash')) === 0, 'Floor intact after the round trip')
  const logs = path.join(userData, 'logs', 'main.log')
  check(!fs.existsSync(logs) || !/ERROR/.test(fs.readFileSync(logs, 'utf8')), 'main-process log has no errors')
} catch (err) {
  console.error(err)
  failures++
} finally {
  killApp()
  await sleep(500)
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* Windows may still hold the dir for a moment; it is in the OS temp dir */
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll smoke checks passed')
process.exit(failures ? 1 : 0)

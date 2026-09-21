// End-to-end test of the parallel engine and of resume, against the REAL
// Electron app (needs `npm run build` first). Isolated like smoke.mjs: its own
// user-data dir, hook port, throwaway git repo and a FAKE `claude` CLI.
//
//   1. A Best-of-N tournament launched from the Floor: two copies in parallel,
//      a judge, one surviving branch.
//   2. The window is closed mid-run: the run must be "Interrupted" (not
//      cancelled), leave no scratch worktree, and Resume must finish it.
//   3. The app is killed outright mid-run (taskkill /F): on the next launch the
//      run is Interrupted, and Resume must clear the orphans and finish it.
//
//   npm run build && npm run smoke:parallel
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CDP_PORT = 9334
const HOOK_PORT = 8991
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentship-parallel-'))
const userData = path.join(tmp, 'userdata')
const project = path.join(tmp, 'demo-project')
const markers = path.join(tmp, 'markers')
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(project, { recursive: true })
fs.mkdirSync(markers, { recursive: true })

const git = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim()
git('init', '-q', '-b', 'main')
git('config', 'user.name', 'smoke')
git('config', 'user.email', 'smoke@example.com')
git('config', 'core.autocrlf', 'false')
fs.writeFileSync(path.join(project, 'README.md'), 'demo\n')
git('add', '-A')
git('commit', '-q', '-m', 'init')
fs.writeFileSync(path.join(userData, 'shipyard.json'), JSON.stringify([{ id: 'smoke1', name: 'demo-project', path: project }]))

const flowsDir = path.join(project, '.agentship', 'flows')
fs.mkdirSync(flowsDir, { recursive: true })
const at = (c) => ({ x: c * 290, y: 0 })
fs.writeFileSync(
  path.join(flowsDir, 'tournament.flow.json'),
  JSON.stringify({
    name: 'Tournament',
    description: 'Two contenders, a judge.',
    inputs: [{ name: 'task', label: 'Task' }],
    defaultBudget: { maxUsd: 0.5 },
    nodes: [
      { id: 'start', kind: 'trigger', label: 'Start', position: at(0), config: { type: 'manual' } },
      { id: 'spread', kind: 'fanout', label: 'Spread', position: at(1), config: { count: 2 } },
      {
        id: 'contender', kind: 'agent', label: 'Contender', position: at(2),
        config: { role: 'Contender', prompt: 'You are contender {{copy}} of {{copies}}. {{task}}', worktree: true, access: 'edit' }
      },
      {
        id: 'tests', kind: 'gate', label: 'Attempt exists', position: at(3), budget: { maxRetries: 1 },
        config: { check: 'command', command: 'node -e "process.exit(require(\'fs\').readdirSync(\'.\').some(f=>f.startsWith(\'attempt-\'))?0:1)"' }
      },
      {
        id: 'pick', kind: 'join', label: 'Judge', position: at(4), budget: { maxUsd: 0.2 },
        config: { strategy: 'best', quorum: 2, criteria: 'Prefer copy 2.' }
      }
    ],
    edges: [
      { id: 'a', from: 'start', to: 'spread', type: 'control' },
      { id: 'b', from: 'spread', to: 'contender', type: 'artifact' },
      { id: 'c', from: 'contender', to: 'tests', type: 'branch' },
      { id: 'd', from: 'tests', to: 'pick', type: 'verdict', condition: 'pass' },
      { id: 'e', from: 'tests', to: 'contender', type: 'verdict', condition: 'fail' }
    ]
  })
)

// The fake CLI. A contender writes attempt-N.txt (N parsed from its prompt) and
// drops a marker so the test knows it is in flight; it then waits `delay.txt`
// milliseconds, which the test changes to hold a run open. The judge answers
// with structured output.
const delayFile = path.join(tmp, 'delay.txt')
fs.writeFileSync(delayFile, '300')
const fake = path.join(tmp, 'fake-claude.cjs')
fs.writeFileSync(
  fake,
  `const fs = require('fs')
const a = process.argv.slice(2)
const at = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : '' }
if (a[0] === 'agents') { process.stdout.write('[]'); process.exit(0) }
let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  const schema = at('--json-schema')
  const judge = schema.includes('winner')
  const n = (/contender (\\d+) of/.exec(input) || [])[1]
  const edit = at('--permission-mode') === 'acceptEdits'
  if (n) {
    fs.writeFileSync('attempt-' + n + '.txt', 'attempt ' + n + '\\n')
    fs.writeFileSync(${JSON.stringify(markers)} + '/started-' + process.pid, n)
  }
  let delay = 300
  try { delay = Number(fs.readFileSync(${JSON.stringify(delayFile)}, 'utf8')) } catch {}
  setTimeout(() => {
    const out = {
      type: 'result', subtype: 'success', is_error: false,
      result: judge ? '{}' : (edit ? 'attempt ' + n + ' done' : 'ok'),
      session_id: at('--session-id') || at('--resume'),
      total_cost_usd: 0.05,
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 1000 }
    }
    if (judge) out.structured_output = { winner: 2, reason: 'copy 2 is preferred' }
    console.log(JSON.stringify(out))
  }, delay)
})
`
)

let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? '  ok ' : ' FAIL'}  ${what}`)
  if (!ok) failures++
}

let child = null
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const launch = () => {
  child = spawn(electron, [root, `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`], {
    env: { ...process.env, AGENT_SHIP_PORT: String(HOOK_PORT), AGENT_SHIP_SKIP_HOOKS: '1', AGENT_SHIP_CLAUDE_CMD: JSON.stringify([process.execPath, fake]) },
    stdio: 'ignore'
  })
  child.exited = new Promise((r) => child.on('exit', (code) => r(code)))
}
const hardKill = () => {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else process.kill(child.pid, 'SIGKILL')
}

async function connect() {
  let url = ''
  for (let i = 0; i < 80 && !url; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
      url = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? ''
    } catch {
      /* not up yet */
    }
    if (!url) await sleep(500)
  }
  if (!url) throw new Error('Electron never exposed a CDP page')
  const ws = new WebSocket(url)
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
  const count = (selector) => evalJs(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
  const clickText = (selector, text) =>
    evalJs(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.includes(${JSON.stringify(text)}) && !e.closest('[hidden]'));
      if (!el) return false; el.click(); return true;
    })()`)
  const waitFor = async (fn, ms = 10000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      try {
        if (await fn()) return true
      } catch {
        /* page may be reloading */
      }
      await sleep(200)
    }
    return false
  }
  return { ws, evalJs, count, clickText, waitFor }
}

const runFiles = () => {
  const dir = path.join(userData, 'runs')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => ({ id: f.slice(0, -6), t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((x, y) => y.t - x.t)
}
const events = (id) => fs.readFileSync(path.join(userData, 'runs', `${id}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const branchesOf = (id) => git('branch', '--list', `agentship/${id.slice(0, 8)}-*`).split('\n').map((s) => s.replace(/^[*+]\s*/, '').trim()).filter(Boolean)
const worktreeCount = () => git('worktree', 'list').split('\n').length
const scratchDirs = () => (fs.existsSync(path.join(userData, 'worktrees')) ? fs.readdirSync(path.join(userData, 'worktrees')) : [])
const cleanedUp = async (ui) => ui.waitFor(() => worktreeCount() === 1 && scratchDirs().length === 0, 15000)
const markerCount = () => fs.readdirSync(markers).length

/** Launch the tournament from the Floor's launchpad. */
async function startTournament(ui, task) {
  check(await ui.waitFor(() => ui.count('.fl-lanes'), 30000), 'the Floor renders')
  check(await ui.clickText('.fl-proj-actions .fl-link', 'Run a flow'), 'opened the project launchpad')
  const picked = await ui.waitFor(() => ui.clickText('.fl-launch button', 'Tournament'), 10000)
  check(picked, 'picked the tournament flow')
  if (!picked) console.log('    launchpad says: ' + (await ui.evalJs(`document.querySelector('.fl-launch')?.innerText ?? '(no launchpad)'`)))
  check(await ui.waitFor(() => ui.count('.rdlg')), 'the confirmation dialog opened')
  const plan = await ui.evalJs(`document.querySelector('.rdlg-plan')?.textContent ?? ''`)
  check(/2 copies/.test(plan) && /at most 4 at a\s*time/.test(plan), 'it says how many copies will run, and the limit')
  check(/judge agent/.test(plan) && /other branches are deleted/.test(plan), 'it says a judge agent will run and losing branches are deleted')
  check(/Contender.*can modify files.*own git branch/.test(plan), 'it says each contender edits in its own branch')
  await ui.evalJs(`(() => { const t = document.querySelector('.rdlg textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ${JSON.stringify(task)}); t.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  check(await ui.clickText('.rdlg .btn-primary', 'Start run'), 'started the run')
}

try {
  // ===== 1. A tournament, start to finish =============================================
  console.log('Tournament from the Floor')
  launch()
  let ui = await connect()
  await startTournament(ui, 'write your attempt')
  check(await ui.waitFor(() => ui.count('.fc-k-run'), 8000), 'a run card appeared')
  check(await ui.waitFor(() => runFiles().length === 1 && events(runFiles()[0].id).some((e) => e.type === 'run.finished'), 60000), 'the run finished')
  const r1 = runFiles()[0].id
  const ev1 = events(r1)
  check(ev1.find((e) => e.type === 'run.finished')?.status === 'passed', `it passed (${ev1.find((e) => e.type === 'run.finished')?.reason})`)
  check(ev1.filter((e) => e.type === 'node.started' && e.nodeId === 'contender').length === 2, 'two contenders ran')
  const starts = ev1.filter((e) => e.type === 'node.started' && e.nodeId === 'contender')
  const firstEnd = ev1.find((e) => e.type === 'node.finished' && e.nodeId === 'contender')
  check(starts.every((s) => ev1.indexOf(s) < ev1.indexOf(firstEnd)), 'both started before either finished: they really ran in parallel')
  check(new Set(starts.map((s) => s.cwd)).size === 2, 'each in its own working copy')
  await cleanedUp(ui)
  const winner = branchesOf(r1)
  check(winner.length === 1 && /contender/.test(winner[0]), `exactly one branch survived (${winner.join(', ')})`)
  check(git('ls-tree', '-r', '--name-only', winner[0]).includes('attempt-2.txt'), 'and it is the judge’s pick: copy 2')
  check(worktreeCount() === 1 && scratchDirs().length === 0, 'no scratch worktree is left behind')
  check(git('rev-parse', 'main') === git('rev-parse', 'HEAD') && !git('ls-tree', '-r', '--name-only', 'main').includes('attempt-'), 'main is untouched')
  // A passed run folds into its branch card on the Floor; its per-copy steps are in the editor's run drawer.
  check(await ui.clickText('.rail-btn', 'Blueprints'), 'opened Blueprints')
  check(await ui.waitFor(() => ui.clickText('.bp-card-main', 'Tournament'), 10000), 'opened the tournament flow')
  check(await ui.waitFor(() => ui.count('.bp-editor .bp-run-passed'), 10000), 'its nodes are lit by the run')
  check(await ui.clickText('.bp-runbar button', 'Show run'), 'opened the run drawer')
  check(await ui.waitFor(() => ui.evalJs(`/copy 1/.test(document.querySelector('.rd-steps')?.textContent ?? '') && /copy 2/.test(document.querySelector('.rd-steps')?.textContent ?? '')`), 8000), 'the run drawer lists "copy 1" and "copy 2" as separate steps')
  await ui.evalJs(`[...document.querySelectorAll('.rd-step-head')].forEach((b) => b.click())`) // expand every step
  check(await ui.waitFor(() => ui.evalJs(`/Picked copy 2 of 2/.test(document.querySelector('.rd-steps')?.textContent ?? '')`), 5000), 'and the join’s step says which copy the judge picked, and why')
  check(await ui.waitFor(() => ui.clickText('.rail-btn', 'Floor'), 5000), 'back to the Floor')

  // ===== 2. Close the window mid-run, then resume ========================================
  console.log('Close the window mid-run, then Resume')
  fs.writeFileSync(delayFile, '60000') // hold every agent call open
  for (const f of fs.readdirSync(markers)) fs.rmSync(path.join(markers, f))
  await ui.evalJs(`document.querySelector('.rdlg')?.remove()`)
  await startTournament(ui, 'second attempt')
  check(await ui.waitFor(() => markerCount() >= 2, 20000), 'both copies are in flight')
  const t0 = Date.now()
  await ui.evalJs('window.close()')
  const code = await Promise.race([child.exited, sleep(30000).then(() => 'hung')])
  check(code !== 'hung', `the app exited on its own (${((Date.now() - t0) / 1000).toFixed(1)}s, code ${code})`)
  if (code === 'hung') hardKill()
  const r2 = runFiles()[0].id
  check(r2 !== r1, 'this is a second run')
  const ev2 = events(r2)
  const fin2 = ev2.find((e) => e.type === 'run.finished')
  check(fin2?.status === 'interrupted', `it was recorded as interrupted, not cancelled (${fin2?.status})`)
  check(worktreeCount() === 1 && scratchDirs().length === 0, 'the copies’ scratch worktrees were cleaned up on the way out')

  fs.writeFileSync(delayFile, '300')
  for (const f of fs.readdirSync(markers)) fs.rmSync(path.join(markers, f))
  launch()
  ui = await connect()
  check(await ui.waitFor(() => ui.count('.fl-lanes'), 30000), 'the app relaunches')
  check(await ui.waitFor(() => ui.evalJs(`[...document.querySelectorAll('.fc-k-run.fc-lane-needs')].some(e => /Interrupted/.test(e.textContent))`), 15000), 'the run is in Needs you, labelled Interrupted')
  check(await ui.waitFor(() => ui.clickText('.fc-lane-needs .fc-actions button', 'Resume run'), 5000), 'and its card has a Resume run button')
  check(await ui.waitFor(() => events(r2).filter((e) => e.type === 'run.finished').length === 2, 60000), 'the resumed run finished')
  const ev2b = events(r2)
  check(ev2b.some((e) => e.type === 'run.resumed'), 'the log records the resume')
  check(ev2b.filter((e) => e.type === 'run.finished').pop()?.status === 'passed', 'and it passed')
  await cleanedUp(ui)
  const b2 = branchesOf(r2)
  check(b2.length === 1 && git('ls-tree', '-r', '--name-only', b2[0]).includes('attempt-2.txt'), `one branch survived, the judge’s pick (${b2.join(', ')})`)
  check(worktreeCount() === 1 && scratchDirs().length === 0, 'no scratch worktree left')

  // ===== 3. Kill the app outright mid-run, then resume ====================================
  console.log('Kill the app mid-run, then Resume')
  fs.writeFileSync(delayFile, '60000')
  for (const f of fs.readdirSync(markers)) fs.rmSync(path.join(markers, f))
  await ui.evalJs(`document.querySelector('.rdlg')?.remove()`)
  await startTournament(ui, 'third attempt')
  check(await ui.waitFor(() => markerCount() >= 2, 20000), 'both copies are in flight')
  const r3 = runFiles()[0].id
  hardKill()
  await child.exited
  await sleep(1500)
  check(!events(r3).some((e) => e.type === 'run.finished'), 'the log has no finish event: nothing got to say goodbye')
  check(scratchDirs().length > 0 || worktreeCount() > 1, `the kill left orphans behind (${scratchDirs().length} scratch dirs)`)

  fs.writeFileSync(delayFile, '300')
  for (const f of fs.readdirSync(markers)) fs.rmSync(path.join(markers, f))
  launch()
  ui = await connect()
  check(await ui.waitFor(() => ui.count('.fl-lanes'), 30000), 'the app relaunches')
  check(await ui.waitFor(() => events(r3).some((e) => e.type === 'run.finished' && e.status === 'interrupted'), 10000), 'the run is marked interrupted at startup')
  check(await ui.waitFor(() => ui.clickText('.fc-lane-needs .fc-actions button', 'Resume run'), 15000), 'its card offers Resume run')
  check(await ui.waitFor(() => events(r3).filter((e) => e.type === 'run.finished').length === 2, 60000), 'the resumed run finished')
  check(events(r3).filter((e) => e.type === 'run.finished').pop()?.status === 'passed', 'and it passed')
  await cleanedUp(ui)
  const b3 = branchesOf(r3)
  check(b3.length === 1 && git('ls-tree', '-r', '--name-only', b3[0]).includes('attempt-2.txt'), `one branch survived, the judge’s pick (${b3.join(', ')})`)
  check(worktreeCount() === 1 && scratchDirs().length === 0, 'orphans were cleared and no scratch worktree is left')
  // The first two runs' work is untouched by all of this.
  check(branchesOf(r1).length === 1 && branchesOf(r2).length === 1, 'earlier runs’ branches are intact')

  const logs = path.join(userData, 'logs', 'main.log')
  check(!fs.existsSync(logs) || !/ERROR/.test(fs.readFileSync(logs, 'utf8')), 'main-process log has no errors')
  if (fs.existsSync(logs)) console.log('  log: ' + fs.readFileSync(logs, 'utf8').split('\n').filter(Boolean).slice(-3).join(' | '))
} catch (err) {
  console.error(err)
  failures++
} finally {
  try {
    hardKill()
  } catch {
    /* already gone */
  }
  await sleep(500)
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* Windows may still hold the dir for a moment; it is in the OS temp dir */
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll parallel/resume smoke checks passed')
process.exit(failures ? 1 : 0)

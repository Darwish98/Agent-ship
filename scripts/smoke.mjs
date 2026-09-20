// End-to-end smoke test against the REAL Electron app (needs `npm run build`
// first). Isolated: its own user-data dir, its own hook-server port, a
// throwaway project. It stands in for the manual repro of the "canvas goes
// blank after ~1 minute" bug and also drives the blueprint editor.
//
//   npm run build && npm run smoke            # ~30s soak
//   npm run smoke -- --soak 90                # long enough to span the 1-min bug
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const soakArg = process.argv.indexOf('--soak')
const SOAK_S = soakArg > 0 ? Number(process.argv[soakArg + 1]) : 30
const shotsArg = process.argv.indexOf('--shots')
const SHOTS = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : ''
const CDP_PORT = 9333
const HOOK_PORT = 8990

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentship-smoke-'))
const userData = path.join(tmp, 'userdata')
const project = path.join(tmp, 'demo-project')
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(project, { recursive: true })
fs.writeFileSync(
  path.join(userData, 'shipyard.json'),
  JSON.stringify([{ id: 'smoke1', name: 'demo-project', path: project }])
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? '  ok ' : ' FAIL'}  ${what}`)
  if (!ok) failures++
}

const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const child = spawn(electron, [root, `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`], {
  env: { ...process.env, AGENT_SHIP_PORT: String(HOOK_PORT), AGENT_SHIP_SKIP_HOOKS: '1' },
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
    const req = http.request(
      { host: '127.0.0.1', port: HOOK_PORT, path: '/event', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        res.resume()
        res.on('end', resolve)
      }
    )
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

  // Counts nodes React Flow has laid out vs. left hidden, in the visible view.
  const nodeStats = (scope) =>
    evalJs(`(() => {
      const view = document.querySelector('${scope}');
      const all = [...view.querySelectorAll('.react-flow__node')];
      const hid = all.filter(n => getComputedStyle(n).visibility === 'hidden');
      return { total: all.length, hidden: hid.length, ids: hid.map(n => n.dataset.id + ' (' + n.className.replace(/react-flow__node/g,'').trim() + ')') };
    })()`)
  const clickText = (selector, text) =>
    evalJs(`(() => {
      const el = [...document.querySelectorAll('${selector}')].find(e => e.textContent.includes(${JSON.stringify(text)}));
      if (!el) return false; el.click(); return true;
    })()`)
  const shot = async (name) => {
    if (!SHOTS) return
    fs.mkdirSync(SHOTS, { recursive: true })
    await sleep(400)
    const id = ++seq
    const res = await new Promise((resolve) => {
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method: 'Page.captureScreenshot', params: { format: 'png' } }))
    })
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(res.result.data, 'base64'))
  }
  const waitFor = async (fn, ms = 8000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await fn()) return true
      await sleep(200)
    }
    return false
  }

  await waitFor(() => evalJs(`document.querySelectorAll('.react-flow__node').length > 0`), 20000)

  // --- 1. Floor under sustained event load (the original bug) -----------------
  console.log(`Floor soak: ${SOAK_S}s of events`)
  // A node is briefly hidden on the frame it first appears (React Flow has not
  // measured it yet). The bug was nodes STAYING hidden, so fail only when the
  // same node is hidden in two consecutive samples a second apart.
  let stuck = []
  let prevHidden = new Set()
  let minTotal = Infinity
  const until = Date.now() + SOAK_S * 1000
  let n = 0
  while (Date.now() < until) {
    await postEvent({ sessionId: `smoke-${n % 3}`, agentName: `crew${n % 3}`, role: 'Dev', projectPath: project, project: 'demo-project', hookEvent: 'PreToolUse', toolName: 'Edit' })
    n++
    const s = await nodeStats('.shell-view:not([hidden])')
    const now = new Set(s.ids)
    for (const id of now) if (prevHidden.has(id)) stuck.push(`${id} at t+${n}s`)
    prevHidden = now
    minTotal = Math.min(minTotal, s.total)
    await sleep(1000)
  }
  check(stuck.length === 0, `no Floor node stayed hidden${stuck.length ? ` (${stuck.length} stuck, e.g. ${stuck.slice(0, 2).join(', ')})` : ''}`)
  check(minTotal >= 2, `Floor kept its nodes throughout (fewest seen: ${minTotal})`)

  // --- 2. Blueprint editor ----------------------------------------------------
  await shot('1-floor')
  console.log('Blueprint editor')
  check(await clickText('.rail-btn', 'Blueprints'), 'switched to the Blueprints view')
  check(await waitFor(() => evalJs(`document.querySelector('.bp-library') !== null`)), 'library is shown')
  await shot('2-library')
  check(await clickText('.bp-card-main', 'Plan'), 'created a flow from the Pipeline pattern')
  check(await waitFor(() => evalJs(`document.querySelectorAll('.bp-editor .react-flow__node').length === 5`)), 'editor shows all 5 nodes')
  await sleep(500)
  const editorStats = await nodeStats('.bp-editor')
  check(editorStats.hidden === 0, `no editor node hidden (${editorStats.hidden}/${editorStats.total})`)

  const flowsDir = path.join(project, '.agentship', 'flows')
  const file = path.join(flowsDir, 'plan-build-test-review.flow.json')
  check(await waitFor(() => fs.existsSync(file)), 'flow file written into the project repo')

  check(await clickText('.bp-palette-item', 'Agent'), 'added an Agent node from the palette')
  check(await waitFor(() => evalJs(`document.querySelectorAll('.bp-editor .react-flow__node').length === 6`)), 'canvas shows 6 nodes')
  check(
    await waitFor(() => {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8')).nodes.length === 6
      } catch {
        return false
      }
    }, 5000),
    'autosave persisted the new node'
  )
  await shot('3-editor')
  const problemsText = await evalJs(`document.querySelector('.bp-problems')?.textContent ?? ''`)
  check(/error/.test(problemsText), 'the new, unconnected Agent is reported as a problem')

  await evalJs(`document.querySelector('.bp-toolbar .btn[title^="Undo"]').click()`)
  check(
    await waitFor(() => evalJs(`document.querySelectorAll('.bp-editor .react-flow__node').length === 5`)),
    'undo removed it again'
  )

  // --- 3. Back to the Floor ---------------------------------------------------
  check(await clickText('.rail-btn', 'Floor'), 'switched back to the Floor')
  await sleep(1500)
  const back = await nodeStats('.shell-view:not([hidden])')
  check(back.total >= 2 && back.hidden === 0, `Floor intact after the round trip (${back.total} nodes, ${back.hidden} hidden)`)
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

// Drives the PACKAGED app (not the dev build) in a throwaway home directory.
// It checks what only a packaged install can get wrong:
//   - the app starts from its installer layout and shows a build id;
//   - it installs its OWN hook into <home>/.claude/settings.json, exactly once;
//   - that hook command, run the way Claude Code runs it (Git Bash on Windows),
//     really delivers an event through the packaged executable in Node mode;
//   - the event shows up in the UI.
//
//   npm run build && npx electron-builder --win --dir --config.directories.output=<dir> --publish never
//   node scripts/smoke-packaged.mjs <dir>/win-unpacked
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const unpacked = process.argv[2]
if (!unpacked || !fs.existsSync(unpacked)) {
  console.error('usage: node scripts/smoke-packaged.mjs <path to win-unpacked>')
  process.exit(2)
}
const exe = path.join(unpacked, process.platform === 'win32' ? 'Agent Ship.exe' : 'agent-ship')
const CDP_PORT = 9335
const HOOK_PORT = 8992
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentship-packaged-'))
const home = path.join(tmp, 'home')
const userData = path.join(tmp, 'userdata')
const project = path.join(tmp, 'demo-project')
fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(project, { recursive: true })
// The user already has their own hook and setting; neither may be disturbed.
fs.writeFileSync(
  path.join(home, '.claude', 'settings.json'),
  JSON.stringify({ model: 'opus', hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo mine' }] }] } }, null, 2)
)
spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: project })
fs.writeFileSync(path.join(userData, 'shipyard.json'), JSON.stringify([{ id: 'p1', name: 'demo-project', path: project }]))

let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? '  ok ' : ' FAIL'}  ${what}`)
  if (!ok) failures++
}

const env = { ...process.env, USERPROFILE: home, HOME: home, AGENT_SHIP_PORT: String(HOOK_PORT) }
delete env.AGENT_SHIP_SKIP_HOOKS
const child = spawn(exe, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`], { env, stdio: 'ignore' })
const hardKill = () => spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })

try {
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
  check(Boolean(url), 'the packaged app starts')
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
  const waitFor = async (fn, ms = 10000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      try {
        if (await fn()) return true
      } catch {
        /* still loading */
      }
      await sleep(200)
    }
    return false
  }

  check(await waitFor(() => evalJs(`document.querySelectorAll('.fl-lanes').length === 1`), 30000), 'the Floor renders from the packaged files')
  check(await evalJs(`typeof window.agentShip?.listRuns === 'function'`), 'the preload bridge is present (renderer sandbox on)')

  // --- the hook it installed ------------------------------------------------------
  const settingsFile = path.join(home, '.claude', 'settings.json')
  check(await waitFor(() => JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hooks?.PreToolUse?.length > 0, 10000), 'it installed its hook into the (throwaway) Claude settings')
  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  const ours = Object.values(s.hooks).flatMap((l) => l.flatMap((e) => e.hooks)).filter((h) => h.description === 'agent-ship')
  check(ours.length === 6, `exactly one hook per event (${ours.length})`)
  check(s.model === 'opus' && s.hooks.Stop.some((e) => e.hooks.some((h) => h.command === 'echo mine')), 'the user’s own setting and hook are untouched')
  const command = s.hooks.PreToolUse.flatMap((e) => e.hooks).find((h) => h.description === 'agent-ship').command
  console.log('  hook command: ' + command)
  check(!/set ELECTRON_RUN_AS_NODE|&&/.test(command), 'the command is not the cmd-only `set X=1&&` form')

  // --- run it the way Claude Code does: through Git Bash -------------------------------
  const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find((p) => fs.existsSync(p))
  const payload = JSON.stringify({ session_id: 'packaged-1', hook_event_name: 'PreToolUse', tool_name: 'Edit', cwd: project, agent_type: '' })
  for (const [shellName, shell, args] of [
    ['Git Bash', gitBash, ['-c', command]],
    ['cmd.exe', 'cmd.exe', ['/d', '/s', '/c', `"${command}"`]]
  ]) {
    if (!shell) continue
    const t0 = Date.now()
    const r = spawnSync(shell, args, { input: payload, env, encoding: 'utf8', windowsVerbatimArguments: shellName === 'cmd.exe', timeout: 20000 })
    check(r.status === 0 && !r.stdout.trim(), `${shellName}: the hook exits 0 and prints nothing (${Date.now() - t0} ms)`)
  }
  check(await waitFor(() => evalJs(`document.body.innerText.includes('demo-project')`), 5000), 'the project is on the Floor')
  check(
    await waitFor(() => evalJs(`[...document.querySelectorAll('.fc')].some(e => e.textContent.includes('demo-project') || e.textContent.includes('packaged-1'))`), 15000),
    'the event the packaged bridge sent produced a card in the UI'
  )
  // Top-level (non --type=) Agent Ship processes: a hook that launched the GUI would make a second one.
  const top = spawnSync('powershell', ['-NoProfile', '-Command', "@(Get-CimInstance Win32_Process -Filter \"Name='Agent Ship.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' }).Count"], { encoding: 'utf8' }).stdout.trim()
  check(top === '1', `exactly one top-level Agent Ship process after two hook calls (${top})`)

  const logs = path.join(userData, 'logs', 'main.log')
  check(!fs.existsSync(logs) || !/ERROR/.test(fs.readFileSync(logs, 'utf8')), 'main-process log has no errors')
  check(fs.existsSync(logs) && /INFO\s+start Agent Ship [0-9a-f]{7}/.test(fs.readFileSync(logs, 'utf8')), 'the log records the build id')
} catch (err) {
  console.error(err)
  failures++
} finally {
  hardKill()
  await sleep(800)
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* Windows may hold the dir briefly */
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll packaged-app checks passed')
process.exit(failures ? 1 : 0)

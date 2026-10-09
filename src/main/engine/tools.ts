// Whether the program a command starts is installed. A flow that runs `pytest` on a
// machine without it fails at its first gate, after the person has already pressed
// Start; saying so in the confirmation is cheaper.
import { spawnSync } from 'node:child_process'

/** Shell builtins and the like: there is no program to look for. */
const BUILTINS = new Set(['cd', 'echo', 'exit', 'set', 'export', 'true', 'false', 'test', 'type'])

/** The program a shell command starts: its first word, ignoring `VAR=value` prefixes and quotes. */
export function programOf(command: string): string {
  for (const word of command.trim().split(/\s+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue
    return word.replace(/^["']|["']$/g, '')
  }
  return ''
}

export function commandExists(command: string): { tool: string; found: boolean } {
  const tool = programOf(command)
  if (!tool || BUILTINS.has(tool)) return { tool, found: true }
  // A path (./run-tests.sh, C:\tools\x.exe) is not looked up on PATH.
  if (/[\\/]/.test(tool)) return { tool, found: true }
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [tool], { windowsHide: true, encoding: 'utf8', timeout: 5_000 })
  return { tool, found: r.status === 0 }
}

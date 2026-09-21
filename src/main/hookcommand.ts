// The command Claude Code runs for each hook event.
//
// Claude Code runs hooks through a shell, and which shell varies: on Windows
// it uses Git Bash (verified against the real CLI), on macOS/Linux the user's
// login shell. So the command must mean the same thing to cmd.exe AND to bash.
//
//  - In development `node "bridge.js"` does.
//  - The packaged app has no separate Node; it runs its own executable in Node
//    mode, which needs ELECTRON_RUN_AS_NODE=1 in the environment. Windows has
//    no syntax for that shared by cmd and bash (`set X=1&& cmd` works only in
//    cmd, and in bash it silently launches the whole GUI app), so on Windows
//    the command is a small .cmd launcher, which both shells can execute.
//  - macOS/Linux shells share `VAR=1 command`.
import path from 'node:path'

export interface HookCommand {
  command: string
  /** A file that must exist for `command` to work. The caller writes it. */
  launcher?: { path: string; content: string }
}

export function hookCommand(o: {
  platform: NodeJS.Platform
  packaged: boolean
  execPath: string
  bridgePath: string
  /** Where the app keeps its own files (the launcher goes in `<dataDir>/hooks`). */
  dataDir: string
}): HookCommand {
  if (!o.packaged) return { command: `node "${o.bridgePath}"` }
  if (o.platform === 'win32') {
    const file = path.join(o.dataDir, 'hooks', 'agentship-hook.cmd')
    return {
      command: `"${file}"`,
      launcher: { path: file, content: `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${o.execPath}" "${o.bridgePath}"\r\n` }
    }
  }
  return { command: `ELECTRON_RUN_AS_NODE=1 "${o.execPath}" "${o.bridgePath}"` }
}

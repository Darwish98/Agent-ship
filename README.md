# Agent ship

A desktop app that shows your Claude Code agent sessions as crew members on a
spaceship, live, using Claude Code's own hook system. No API key, no OAuth,
no model calls - it never talks to Anthropic at all. It just reads the local
JSON events Claude Code already writes when you use it.

## How it works

1. Claude Code fires lifecycle events (`PreToolUse`, `PostToolUse`,
   `SessionStart`, `Stop`, etc.) as JSON on stdin to any command configured
   in `~/.claude/settings.json`.
2. `hooks/bridge.js` is that command. It forwards a small summary (session
   id, project folder, tool name) to `http://127.0.0.1:8934`, a server this
   app runs.
3. The Electron app renders each active session as a character standing at
   a station - `Bash` calls go to the engine room, `Edit`/`Write` to the
   lab, `Read`/`Grep`/`Glob` to the bridge - with a speech bubble showing
   its current status.

Everything stays on your machine. The server only binds to `127.0.0.1`.

## For end users

Download the installer for your OS and double-click it - no terminal, no
Node.js required:

- **Linux**: `Agent Ship-0.1.0.AppImage` - already built in `dist/`. Mark it
  executable if needed (`chmod +x`) and run it.
- **macOS**: build produces a `.dmg` (see "Building the installers" below -
  must be built on a Mac, or via the included GitHub Actions workflow).
- **Windows**: build produces a one-click `.exe` installer (must be built on
  Windows, or via GitHub Actions).

The app installs its own Claude Code hooks automatically the first time it
launches - it detects `~/.claude/`, and if found, writes the hook config
itself using its own bundled runtime (no separate Node.js install needed on
the user's machine). If Claude Code isn't installed yet, it just skips
silently; installing Claude Code and relaunching the app is enough.

## Building the installers (one-time, for whoever maintains this)

```bash
npm install
npm run dist:linux   # -> dist/*.AppImage
npm run dist:mac     # must run on macOS -> dist/*.dmg
npm run dist:win     # must run on Windows -> dist/*.exe
```

Or push a `v*` tag to trigger `.github/workflows/build.yml`, which builds
all three installers on their native OS via GitHub Actions and uploads them
as artifacts - useful since mac/Windows installers can't be cross-built from
Linux.

## Developing

```bash
npm install
npm start            # runs from source via Electron, for iterating on the UI
npm run uninstall-hooks   # removes the hooks this app added
```

## Limitations

- Only covers Claude Code sessions (terminal / IDE), since that's the
  surface with a documented hook system. Claude.ai and Claude Desktop chat
  sessions don't fire these hooks and won't show up here.
- Status text is only as detailed as what Claude Code puts in the hook
  payload - tool name and event type, not a full description of the task.
- One machine at a time - this doesn't aggregate sessions across devices.

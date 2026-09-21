import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

/** What this build was made from, so a running window can say whether it is stale.
 *  `electron-vite preview` serves `out/`, which only changes when someone builds. */
function buildId(): string {
  const git = (...args: string[]): string => {
    try {
      return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return ''
    }
  }
  const sha = git('rev-parse', '--short', 'HEAD') || 'unknown'
  const dirty = git('status', '--porcelain') ? '+edits' : ''
  const at = new Date().toISOString().slice(0, 16).replace('T', ' ')
  return `${sha}${dirty} · built ${at}`
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: { __BUILD_ID__: JSON.stringify(buildId()) }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: { '@': resolve('src/renderer/src') }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    },
    plugins: [react()]
  }
})

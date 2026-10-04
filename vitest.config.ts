import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Most engine tests drive real git processes and temp worktrees. On Windows,
    // under load (antivirus scanning new files, a Land run testing this very
    // project), the 5s default is too tight and fails tests that are not wrong.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // `.claude/worktrees/*` are other sessions' checkouts of this repo; running
    // their copies of the tests counts old code as if it were ours.
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**', '.claude/**']
  }
})

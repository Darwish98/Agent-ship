import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `.claude/worktrees/*` are other sessions' checkouts of this repo; running
    // their copies of the tests counts old code as if it were ours.
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**', '.claude/**']
  }
})

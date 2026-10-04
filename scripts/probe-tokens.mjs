// Measures what each headless `claude -p` step costs BEFORE it does any work,
// and whether the "lean" flags in src/main/engine/adapter.ts really shrink it.
// Costs a few cents (Haiku, one trivial prompt per variant). Needs a working
// `claude` login for headless use.
//
//   npm run probe:tokens
//
// Prints, per variant: billed tokens (input + cache writes + output; cache reads
// are re-sent context and excluded, as in the Usage gauge), cache reads, cost.
// The last two variants check the thing that could not be verified without a
// live call: that `--tools` leaves structured (--json-schema) output working.
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'

const baseArgs = ['-p', '--output-format', 'json', '--model', 'haiku', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--max-budget-usd', '0.3']
const lean = ['--exclude-dynamic-system-prompt-sections', '--disable-slash-commands', '--strict-mcp-config']
const schema = JSON.stringify({ type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] })

const variants = [
  { name: 'baseline (what ran before)', extra: [], prompt: 'Reply with the single word ok.' },
  { name: 'lean flags', extra: lean, prompt: 'Reply with the single word ok.' },
  { name: 'lean + --tools Read,Glob,Grep', extra: [...lean, '--tools', 'Read', 'Glob', 'Grep'], prompt: 'Reply with the single word ok.' },
  { name: 'schema, lean (no --tools)', extra: [...lean, '--json-schema', schema], prompt: 'Answer with ok=true.', schema: true },
  { name: 'schema, lean + --tools', extra: [...lean, '--tools', 'Read', 'Glob', 'Grep', '--json-schema', schema], prompt: 'Answer with ok=true.', schema: true }
]

let failed = false
for (const v of variants) {
  const args = [...baseArgs, '--session-id', crypto.randomUUID(), ...v.extra, '--allowedTools', 'Read', 'Glob', 'Grep']
  const r = spawnSync('claude', args, { input: v.prompt, encoding: 'utf8', shell: process.platform === 'win32', timeout: 120_000 })
  let j
  try {
    j = JSON.parse(r.stdout)
  } catch {
    console.log(v.name.padEnd(34), 'no result:', (r.stderr || r.stdout || '').trim().slice(0, 200))
    failed = true
    continue
  }
  if (j.is_error) {
    console.log(v.name.padEnd(34), 'ERROR:', String(j.result).slice(0, 200))
    failed = true
    continue
  }
  const u = j.usage ?? {}
  const billed = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0)
  const structured = v.schema ? (j.structured_output && j.structured_output.ok === true ? '  structured OK' : '  STRUCTURED OUTPUT MISSING') : ''
  if (v.schema && !structured.endsWith('OK')) failed = true
  console.log(
    v.name.padEnd(34),
    `billed ${String(billed).padStart(6)}`,
    `cacheRead ${String(u.cache_read_input_tokens ?? 0).padStart(7)}`,
    `$${(j.total_cost_usd ?? 0).toFixed(4)}`,
    structured
  )
}
console.log(failed ? '\nSomething failed above - do not enable --tools for structured-output steps.' : '\nAll variants worked.')
process.exit(failed ? 1 : 0)

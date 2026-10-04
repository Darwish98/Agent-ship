// Measures what each headless `claude -p` step costs BEFORE it does any work,
// and whether the "lean" flags in src/main/engine/adapter.ts really shrink it.
// Uses a sliver of the subscription allowance (Haiku, two trivial prompts per variant). Needs a working
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

// No shell: the app spawns `claude` directly too, and a shell on Windows mangles
// the quotes in the --json-schema argument.
function run(v) {
  const args = [...baseArgs, '--session-id', crypto.randomUUID(), ...v.extra, '--allowedTools', 'Read', 'Glob', 'Grep']
  const r = spawnSync('claude', args, { input: v.prompt, encoding: 'utf8', timeout: 120_000 })
  if (r.error) return { error: r.error.message }
  let j
  try {
    j = JSON.parse(r.stdout)
  } catch {
    return { error: (r.stderr || r.stdout || '').trim().slice(0, 200) }
  }
  if (j.is_error) return { error: String(j.result).slice(0, 200) }
  const u = j.usage ?? {}
  return {
    billed: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0),
    cacheRead: u.cache_read_input_tokens ?? 0,
    cost: j.total_cost_usd ?? 0,
    structuredOk: j.structured_output?.ok === true
  }
}

// Each variant runs twice. The first call of a changed prompt prefix writes the
// cache (cold); the second reads it (warm), which is what steps in a real run
// see. "context" = billed + cacheRead = everything the model was sent.
for (const v of variants) {
  for (const phase of ['cold', 'warm']) {
    const r = run(v)
    const label = `${v.name} [${phase}]`.padEnd(46)
    if (r.error) {
      console.log(label, 'ERROR:', r.error)
      failed = true
      break
    }
    const structured = v.schema ? (r.structuredOk ? '  structured OK' : '  STRUCTURED OUTPUT MISSING') : ''
    if (v.schema && !r.structuredOk) failed = true
    console.log(
      label,
      `billed ${String(r.billed).padStart(6)}`,
      `cacheRead ${String(r.cacheRead).padStart(7)}`,
      `context ${String(r.billed + r.cacheRead).padStart(7)}`,
      `~$${r.cost.toFixed(4)}`,
      structured
    )
  }
}
console.log(failed ? '\nSomething failed above - do not enable --tools for structured-output steps.' : '\nAll variants worked.')
process.exit(failed ? 1 : 0)

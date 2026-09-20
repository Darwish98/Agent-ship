// The blueprint file format. A blueprint is a plain JSON file kept in the repo
// (`<repo>/.agentship/flows/<name>.flow.json`), so it is diffable, reviewable
// and shareable. Everything that reads one goes through `parseBlueprint`, so
// a hand-edited or foreign file can never reach the editor half-valid.
import { z } from 'zod'
import { SCHEMA_VERSION } from './blueprint'

export const budgetSchema = z.object({
  /** Enforced between steps: a step that ends over this stops the run. */
  maxTokens: z.number().int().positive().optional(),
  /** Enforced natively (`--max-budget-usd`) per model call. The CLI checks it
   *  after each call, so a run stops within one call of the cap. */
  maxUsd: z.number().positive().optional(),
  maxMinutes: z.number().positive().optional(),
  maxRetries: z.number().int().min(0).max(20).optional()
})

const modelSchema = z.enum(['default', 'opus', 'sonnet', 'haiku', 'fable'])

const triggerConfig = z.object({ type: z.literal('manual') })

const agentConfig = z.object({
  role: z.string().max(80),
  model: modelSchema.default('default'),
  /** May contain `{{variable}}` placeholders, see `templateVars`. */
  prompt: z.string().max(20_000),
  /** Run in its own git worktree/branch. Parallel writers must. */
  worktree: z.boolean().default(false),
  /** read = may only look. edit = may modify files in its working directory
   *  (Claude Code's acceptEdits mode). Containment comes from the worktree. */
  access: z.enum(['read', 'edit']).default('read'),
  /** Tool allow-list. Empty = the session's normal permission behaviour. */
  tools: z.array(z.string().max(120)).max(50).default([]),
  /** JSON Schema (as text) the result must satisfy. Empty = free text. */
  outputSchema: z.string().max(10_000).default('')
})

const fanoutConfig = z.object({
  count: z.number().int().min(2).max(16).default(3)
})

const joinConfig = z.object({
  strategy: z.enum(['all', 'first', 'quorum', 'best']).default('all'),
  quorum: z.number().int().min(1).max(16).default(2)
})

const gateConfig = z.object({
  check: z.enum(['command', 'human']).default('command'),
  /** Shell command; exit 0 = pass. Used when check = command. */
  command: z.string().max(2_000).default(''),
  /** What the reviewer should look at. Used when check = human. */
  instructions: z.string().max(2_000).default('')
})

const mergeConfig = z.object({
  baseBranch: z.string().max(200).default('main'),
  resolveConflicts: z.boolean().default(true),
  /** Brief for the agent that lands the branches and resolves conflicts. */
  resolverPrompt: z.string().max(20_000).default('')
})

const nodeBase = {
  id: z.string().min(1).max(64),
  label: z.string().max(80).default(''),
  position: z.object({ x: z.number(), y: z.number() }),
  budget: budgetSchema.optional()
}

export const nodeSchema = z.discriminatedUnion('kind', [
  z.object({ ...nodeBase, kind: z.literal('trigger'), config: triggerConfig }),
  z.object({ ...nodeBase, kind: z.literal('agent'), config: agentConfig }),
  z.object({ ...nodeBase, kind: z.literal('fanout'), config: fanoutConfig }),
  z.object({ ...nodeBase, kind: z.literal('join'), config: joinConfig }),
  z.object({ ...nodeBase, kind: z.literal('gate'), config: gateConfig }),
  z.object({ ...nodeBase, kind: z.literal('merge'), config: mergeConfig })
])

export const edgeSchema = z.object({
  id: z.string().min(1).max(140),
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  /** What travels along the edge. */
  type: z.enum(['artifact', 'branch', 'verdict', 'control']).default('artifact'),
  /** Only meaningful out of a gate: follow on pass, on fail, or always. */
  condition: z.enum(['always', 'pass', 'fail']).default('always')
})

export const inputSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,40}$/),
  label: z.string().max(80).default(''),
  required: z.boolean().default(true)
})

export const blueprintSchema = z.object({
  schemaVersion: z.number().int().default(SCHEMA_VERSION),
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  /** Bumped by the author when the flow's meaning changes (not on every
   *  autosave); a run records the version it executed. */
  version: z.number().int().min(1).default(1),
  defaultBudget: budgetSchema.default({}),
  inputs: z.array(inputSchema).max(20).default([]),
  nodes: z.array(nodeSchema).max(200),
  edges: z.array(edgeSchema).max(600)
})

export type Budget = z.infer<typeof budgetSchema>
export type BlueprintNode = z.infer<typeof nodeSchema>
export type BlueprintEdge = z.infer<typeof edgeSchema>
export type BlueprintInput = z.infer<typeof inputSchema>
export type Blueprint = z.infer<typeof blueprintSchema>
export type NodeKind = BlueprintNode['kind']

export type ParseResult = { ok: true; blueprint: Blueprint } | { ok: false; error: string }

/** Older files are upgraded here. Version 1 is the first, so this is the seam
 *  where a future migration goes rather than something that does work today. */
function migrate(raw: unknown): unknown {
  return raw
}

export function parseBlueprint(raw: unknown): ParseResult {
  const parsed = blueprintSchema.safeParse(migrate(raw))
  if (parsed.success) {
    if (parsed.data.schemaVersion > SCHEMA_VERSION) {
      return {
        ok: false,
        error: `Made by a newer Agent Ship (schema v${parsed.data.schemaVersion}); this build reads v${SCHEMA_VERSION}.`
      }
    }
    return { ok: true, blueprint: parsed.data }
  }
  const issue = parsed.error.issues[0]
  const where = issue?.path.length ? ` at ${issue.path.join('.')}` : ''
  return { ok: false, error: `${issue?.message ?? 'Invalid blueprint'}${where}` }
}

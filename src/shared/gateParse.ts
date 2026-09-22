// Turns a command gate's raw output into something a person can scan and an
// agent can act on, for the test/typecheck/lint runners people actually use.
// Pure text processing: no Node APIs, so the renderer can call it too (for a
// compact summary badge) without duplicating logic in the engine.
//
// A gate's `detail` (see runner.ts) is always `exit <code>\n<tail>` or
// `Timed out.\n<tail>`, where `<tail>` is the last ~6,000 characters of the
// command's combined stdout+stderr. Every detector here works on that tail,
// which is why it matters that test/lint/typecheck tools print their summary
// LAST — the ones below all do.
//
// Recognising a tool is a best effort over its typical console output, not a
// guarantee: a custom reporter, a very quiet `-q` run, or a tool not listed
// here falls back to an honest "could not parse" rather than a wrong guess.

export interface GateFailure {
  /** A test name, `path::test`, `file:line:col`, or similar - whatever the
   *  tool itself uses to name the thing that failed. */
  name: string
  message?: string
}

export type GateTool = 'vitest' | 'jest' | 'mocha' | 'pytest' | 'go-test' | 'cargo-test' | 'eslint' | 'tsc' | 'junit'

export interface ParsedGateOutput {
  /** Which detector matched. `null` means none did - the raw output is all there is. */
  tool: GateTool | null
  /** One line for a compact badge, e.g. "2 failed, 12 passed" or "4 errors". */
  summary: string
  passed?: number
  failed?: number
  total?: number
  /** Individual failures, most useful ones first. Capped (see MAX_FAILURES); a
   *  longer list still counts fully in `failed`. */
  failures: GateFailure[]
  timedOut: boolean
}

const MAX_FAILURES = 12
const MAX_MESSAGE = 200

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)
const num = (s: string | undefined): number | undefined => (s === undefined ? undefined : Number(s))

interface Detection {
  tool: GateTool
  passed?: number
  failed?: number
  total?: number
  failures: GateFailure[]
}

/** Vitest: "Test Files  1 failed | 2 passed (3)" / "Tests  2 failed | 12 passed (14)". */
function detectVitest(text: string): Detection | null {
  const m = /Tests\s+(?:(\d+)\s*failed\s*\|\s*)?(?:(\d+)\s*passed)?(?:\s*\|\s*(\d+)\s*skipped)?\s*\((\d+)\)/.exec(text)
  if (!m) return null
  const failures: GateFailure[] = []
  // Vitest lists each failing test as its own line before the detail blocks:
  // "FAIL  src/foo.test.ts > describe > does the thing"
  for (const fm of text.matchAll(/^\s*FAIL\s+(\S.*?)(?:\s*\d+\s*ms)?\s*$/gm)) {
    if (failures.length >= MAX_FAILURES) break
    failures.push({ name: fm[1].trim() })
  }
  return { tool: 'vitest', failed: num(m[1]) ?? 0, passed: num(m[2]), total: num(m[4]), failures }
}

/** Jest: "Tests:       2 failed, 12 passed, 14 total". */
function detectJest(text: string): Detection | null {
  const m = /Tests:\s+(?:(\d+)\s*failed,\s*)?(?:(\d+)\s*skipped,\s*)?(?:(\d+)\s*passed,\s*)?(\d+)\s*total/.exec(text)
  if (!m) return null
  const failures: GateFailure[] = []
  // The assertion-failure name, one per block: "  ● Suite name › does the thing".
  // More specific than the file-level "FAIL <path>" lines, so preferred.
  for (const fm of text.matchAll(/^\s*●\s+(.+)$/gm)) {
    if (failures.length >= MAX_FAILURES) break
    const name = fm[1].trim()
    if (name && !/^Console$/.test(name)) failures.push({ name })
  }
  if (!failures.length) {
    for (const fm of text.matchAll(/^\s*FAIL\s+(\S+)/gm)) {
      if (failures.length >= MAX_FAILURES) break
      failures.push({ name: fm[1].trim() })
    }
  }
  return { tool: 'jest', failed: num(m[1]) ?? 0, passed: num(m[3]), total: num(m[4]), failures }
}

/** Mocha: "  14 passing (32ms)" / "  2 failing", each failure numbered "  1) suite\n       test:"
 *  in the detail section below the counts. The same "N)" also appears earlier,
 *  inline in the spec tree next to just the test title - only the detail
 *  section (after "N failing") gives the full suite + test name. */
function detectMocha(text: string): Detection | null {
  const passing = /(\d+)\s*passing/.exec(text)
  const failing = /(\d+)\s*failing/.exec(text)
  if (!passing && !failing) return null
  const failures: GateFailure[] = []
  const lines = text.split('\n')
  const detailStart = lines.findIndex((l) => /^\s*\d+\s*failing\s*$/.test(l)) + 1 || 0
  for (let i = detailStart; i < lines.length && failures.length < MAX_FAILURES; i++) {
    const head = /^\s*\d+\)\s+(.+)$/.exec(lines[i])
    if (!head) continue
    let name = head[1].trim()
    const next = lines[i + 1]?.trim() ?? ''
    if (next.endsWith(':')) name = `${name} ${next}`
    failures.push({ name })
  }
  return { tool: 'mocha', passed: num(passing?.[1]), failed: num(failing?.[1]) ?? 0, failures }
}

/** pytest: "FAILED path/test_x.py::test_y - AssertionError: ..." and a final
 *  "===== 2 failed, 10 passed in 1.23s =====" (order and presence of each count
 *  varies). Both markers are distinctive to pytest (`FAILED path::test` with a
 *  double colon; the "=== ... in Ns ===" banner), unlike a bare word "failed"
 *  elsewhere, which cargo/go's own summaries also happen to contain. */
function detectPytest(text: string): Detection | null {
  const bannerMatch = /={3,}[^\n]*?in\s+[\d.]+s[^\n]*?={3,}/.exec(text)
  const hasFailedTest = /^FAILED\s+\S+::/m.test(text)
  if (!bannerMatch && !hasFailedTest) return null
  const banner = bannerMatch?.[0] ?? ''
  const failed = num(/(\d+)\s*failed/.exec(banner)?.[1])
  const passed = num(/(\d+)\s*passed/.exec(banner)?.[1])
  const failures: GateFailure[] = []
  for (const fm of text.matchAll(/^FAILED\s+(\S+)(?:\s*-\s*(.+))?$/gm)) {
    if (failures.length >= MAX_FAILURES) break
    failures.push({ name: fm[1].trim(), message: fm[2]?.trim() })
  }
  return { tool: 'pytest', failed: failed ?? (failures.length || undefined), passed, failures }
}

/** `go test`: "--- FAIL: TestName (0.00s)" per test; no total without -v. */
function detectGoTest(text: string): Detection | null {
  const fails = [...text.matchAll(/^\s*--- FAIL:\s+(\S+)/gm)]
  const failLine = /^FAIL(?:\s|\t)/m.test(text)
  if (!fails.length && !failLine) return null
  const failures: GateFailure[] = fails.slice(0, MAX_FAILURES).map((m) => ({ name: m[1] }))
  return { tool: 'go-test', failed: fails.length || (failLine ? 1 : 0), failures }
}

/** `cargo test`: "test result: FAILED. 3 passed; 2 failed; ..." and per-test
 *  "test path::to::it ... FAILED". */
function detectCargoTest(text: string): Detection | null {
  const m = /test result:\s+\w+\.\s+(\d+)\s+passed;\s+(\d+)\s+failed/.exec(text)
  if (!m) return null
  const failures: GateFailure[] = []
  for (const fm of text.matchAll(/^test\s+(\S+)\s+\.\.\.\s+FAILED\s*$/gm)) {
    if (failures.length >= MAX_FAILURES) break
    failures.push({ name: fm[1] })
  }
  return { tool: 'cargo-test', passed: num(m[1]), failed: num(m[2]), failures }
}

/** ESLint's default "stylish" formatter: a bare file path line, then each of
 *  its problems indented below it as "  line:col  severity  message  rule",
 *  then a final "✖ 5 problems (3 errors, 2 warnings)". The row lines don't
 *  repeat the file, so it has to be tracked as the file header lines go by. */
function detectEslint(text: string): Detection | null {
  const m = /(\d+)\s*problems?\s*\((\d+)\s*errors?,\s*(\d+)\s*warnings?\)/.exec(text)
  if (!m) return null
  const failures: GateFailure[] = []
  let file = ''
  for (const raw of text.split('\n')) {
    const row = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?\s*$/.exec(raw)
    if (row) {
      if (row[3] === 'error' && failures.length < MAX_FAILURES) {
        failures.push({ name: `${file}:${row[1]}:${row[2]}`, message: row[5] ? `${row[4].trim()} (${row[5]})` : row[4].trim() })
      }
      continue
    }
    const trimmed = raw.trim()
    // Anything else non-blank, at the left margin, that isn't the summary
    // line itself is the path the following rows belong to.
    if (trimmed && raw === trimmed && !/^[✖✗]/.test(trimmed)) file = trimmed
  }
  return { tool: 'eslint', failed: num(m[2]), failures }
}

/** tsc: "Found 4 errors." plus "file.ts(12,3): error TS2322: message". */
function detectTsc(text: string): Detection | null {
  const m = /Found\s+(\d+)\s+errors?(?:\s+in\s+\d+\s+files?)?\.?/.exec(text)
  if (!m) return null
  const failures: GateFailure[] = []
  for (const fm of text.matchAll(/^(?<file>\S.*?)\((?<line>\d+),(?<col>\d+)\):\s*error\s+(?<code>TS\d+):\s*(?<msg>.+)$/gm)) {
    if (failures.length >= MAX_FAILURES) break
    const g = fm.groups!
    failures.push({ name: `${g.file}:${g.line}:${g.col}`, message: `${g.code}: ${g.msg}` })
  }
  return { tool: 'tsc', failed: num(m[1]), failures }
}

/** A JUnit-style summary, e.g. Maven Surefire: "Tests run: 14, Failures: 2, Errors: 0, Skipped: 1". */
function detectJUnitStyle(text: string): Detection | null {
  const m = /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+)(?:,\s*Skipped:\s*(\d+))?/.exec(text)
  if (!m) return null
  const failed = Number(m[2]) + Number(m[3])
  return { tool: 'junit', total: num(m[1]), failed, passed: Number(m[1]) - failed - (num(m[4]) ?? 0), failures: [] }
}

const DETECTORS = [detectVitest, detectJest, detectMocha, detectPytest, detectGoTest, detectCargoTest, detectEslint, detectTsc, detectJUnitStyle]

function summarize(d: Detection | null, timedOut: boolean, exitCode: number | null): string {
  if (timedOut) return 'Timed out.'
  if (!d) return exitCode === 0 ? 'Passed.' : exitCode === null ? 'Failed.' : `Failed (exit ${exitCode}).`
  const parts: string[] = []
  if (d.failed !== undefined) parts.push(`${d.failed} failed`)
  if (d.passed !== undefined) parts.push(`${d.passed} passed`)
  if (!parts.length && d.total !== undefined) parts.push(`${d.total} total`)
  return parts.length ? parts.join(', ') : d.failed ? `${d.failed} failed` : 'No result count found.'
}

/**
 * `detail` is a gate's stored output exactly as the engine builds it:
 * `exit <code>\n<tail>` or `Timed out.\n<tail>`.
 */
export function parseGateOutput(detail: string): ParsedGateOutput {
  const nl = detail.indexOf('\n')
  const head = nl < 0 ? detail : detail.slice(0, nl)
  const timedOut = head.startsWith('Timed out')
  const exitCode = /^exit (-?\d+)/.exec(head)
  const code = exitCode ? Number(exitCode[1]) : null
  const text = stripAnsi(nl < 0 ? '' : detail.slice(nl + 1))

  let hit: Detection | null = null
  for (const detect of DETECTORS) {
    hit = detect(text)
    if (hit) break
  }

  return {
    tool: hit?.tool ?? null,
    summary: summarize(hit, timedOut, code),
    passed: hit?.passed,
    failed: hit?.failed,
    total: hit?.total,
    failures: (hit?.failures ?? []).slice(0, MAX_FAILURES),
    timedOut
  }
}

/**
 * What a repair prompt tells the agent about a failed gate: the parsed
 * failures when any were found, else the same raw-tail excerpt the engine
 * always used. Never loses information the old behaviour had - parsing only
 * adds structure on top when it can.
 */
export function repairFeedback(detail: string, rawExcerptChars = 4_000): string {
  const raw = detail.length > rawExcerptChars ? `…(truncated)\n${detail.slice(-rawExcerptChars)}` : detail
  const parsed = parseGateOutput(detail)
  if (parsed.timedOut || !parsed.failures.length) return raw

  const lines = parsed.failures.map((f) => `- ${f.name}${f.message ? `: ${clip(f.message, MAX_MESSAGE)}` : ''}`)
  const extra = (parsed.failed ?? parsed.failures.length) - parsed.failures.length
  if (extra > 0) lines.push(`…and ${extra} more.`)
  return [parsed.summary, '', ...lines].join('\n')
}

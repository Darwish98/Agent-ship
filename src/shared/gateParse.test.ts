import { describe, expect, it } from 'vitest'
import { parseGateOutput, repairFeedback } from './gateParse'

const fail = (tail: string, code = 1): string => `exit ${code}\n${tail}`
const pass = (tail: string): string => `exit 0\n${tail}`

describe('parseGateOutput', () => {
  it('vitest: counts and the failing test names', () => {
    const out = fail(
      [
        ' FAIL  src/shared/blueprint.test.ts > run planning helpers > refuses to run with no budget',
        ' FAIL  src/main/engine/runner.test.ts > run engine > runs a pipeline end to end',
        '',
        ' Test Files  1 failed | 4 passed (5)',
        '      Tests  2 failed | 12 passed (14)'
      ].join('\n')
    )
    const p = parseGateOutput(out)
    expect(p.tool).toBe('vitest')
    expect(p.failed).toBe(2)
    expect(p.passed).toBe(12)
    expect(p.total).toBe(14)
    expect(p.summary).toBe('2 failed, 12 passed')
    expect(p.failures.map((f) => f.name)).toEqual([
      'src/shared/blueprint.test.ts > run planning helpers > refuses to run with no budget',
      'src/main/engine/runner.test.ts > run engine > runs a pipeline end to end'
    ])
  })

  it('vitest: all passing, no FAIL lines', () => {
    const p = parseGateOutput(pass(' Test Files  5 passed (5)\n      Tests  14 passed (14)'))
    expect(p.tool).toBe('vitest')
    expect(p.failed).toBe(0)
    expect(p.failures).toEqual([])
  })

  it('jest: counts and assertion-block names', () => {
    const out = fail(
      [
        'FAIL src/App.test.js',
        '  ● renders without crashing',
        '',
        '    expect(received).toBe(expected)',
        '',
        'Tests:       1 failed, 8 passed, 9 total',
        'Test Suites: 1 failed, 3 passed, 4 total'
      ].join('\n')
    )
    const p = parseGateOutput(out)
    expect(p.tool).toBe('jest')
    expect(p.failed).toBe(1)
    expect(p.passed).toBe(8)
    expect(p.total).toBe(9)
    expect(p.failures[0].name).toBe('renders without crashing')
  })

  it('mocha: passing/failing counts and numbered failures with the test name', () => {
    const out = fail(
      [
        '  Adder',
        '    ✓ adds two numbers',
        '    1) subtracts two numbers',
        '',
        '  1 passing (12ms)',
        '  1 failing',
        '',
        '  1) Adder',
        '       subtracts two numbers:',
        '     AssertionError: expected 3 to equal 2'
      ].join('\n')
    )
    const p = parseGateOutput(out)
    expect(p.tool).toBe('mocha')
    expect(p.passed).toBe(1)
    expect(p.failed).toBe(1)
    expect(p.failures[0].name).toBe('Adder subtracts two numbers:')
  })

  it('pytest: FAILED lines with the assertion, and the summary line', () => {
    const out = fail(
      [
        'FAILED tests/test_math.py::test_add - AssertionError: assert 3 == 4',
        'FAILED tests/test_math.py::test_sub - ZeroDivisionError: division by zero',
        '===================== 2 failed, 8 passed in 0.42s ====================='
      ].join('\n')
    )
    const p = parseGateOutput(out)
    expect(p.tool).toBe('pytest')
    expect(p.failed).toBe(2)
    expect(p.passed).toBe(8)
    expect(p.failures).toEqual([
      { name: 'tests/test_math.py::test_add', message: 'AssertionError: assert 3 == 4' },
      { name: 'tests/test_math.py::test_sub', message: 'ZeroDivisionError: division by zero' }
    ])
  })

  it('go test: --- FAIL: lines, no passed count without -v', () => {
    const out = fail(
      ['--- FAIL: TestAdd (0.00s)', '    add_test.go:12: expected 4, got 5', '--- FAIL: TestSub (0.00s)', 'FAIL', 'FAIL\texample.com/pkg\t0.004s'].join('\n')
    )
    const p = parseGateOutput(out)
    expect(p.tool).toBe('go-test')
    expect(p.failed).toBe(2)
    expect(p.failures.map((f) => f.name)).toEqual(['TestAdd', 'TestSub'])
    expect(p.passed).toBeUndefined()
  })

  it('cargo test: the result line and per-test FAILED lines', () => {
    const out = fail(
      ['running 3 tests', 'test tests::it_adds ... ok', 'test tests::it_subtracts ... FAILED', '', 'test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out'].join('\n')
    )
    const p = parseGateOutput(out)
    expect(p.tool).toBe('cargo-test')
    expect(p.passed).toBe(2)
    expect(p.failed).toBe(1)
    expect(p.failures).toEqual([{ name: 'tests::it_subtracts' }])
  })

  it('eslint: the problem count and file:line:col errors (warnings excluded from failed)', () => {
    const out = fail(
      [
        '/repo/src/index.js',
        '  12:3  error    \'x\' is defined but never used  no-unused-vars',
        '  20:1  warning  Missing semicolon                semi',
        '',
        '✖ 2 problems (1 error, 1 warning)'
      ].join('\n')
    )
    const p = parseGateOutput(out)
    expect(p.tool).toBe('eslint')
    expect(p.failed).toBe(1)
    expect(p.failures).toEqual([{ name: '/repo/src/index.js:12:3', message: "'x' is defined but never used (no-unused-vars)" }])
  })

  it('tsc: Found N errors, and each file(line,col): error TSxxxx line', () => {
    const out = fail(
      ["src/foo.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.", 'src/bar.ts(3,1): error TS2304: Cannot find name \'Foo\'.', 'Found 2 errors in 2 files.'].join('\n')
    )
    const p = parseGateOutput(out)
    expect(p.tool).toBe('tsc')
    expect(p.failed).toBe(2)
    expect(p.failures).toEqual([
      { name: 'src/foo.ts:10:5', message: "TS2322: Type 'string' is not assignable to type 'number'." },
      { name: 'src/bar.ts:3:1', message: "TS2304: Cannot find name 'Foo'." }
    ])
  })

  it('a Maven/JUnit-style summary line, counts only (no per-failure text)', () => {
    const p = parseGateOutput(fail('Tests run: 14, Failures: 2, Errors: 1, Skipped: 1'))
    expect(p.tool).toBe('junit')
    expect(p.total).toBe(14)
    expect(p.failed).toBe(3)
    expect(p.failures).toEqual([])
  })

  it('a timeout is reported as a timeout, not run through the detectors', () => {
    const p = parseGateOutput('Timed out.\nTests  2 failed | 12 passed (14)')
    expect(p.timedOut).toBe(true)
    expect(p.summary).toBe('Timed out.')
  })

  it('nothing recognisable: an honest fallback that still reports pass/fail from the exit code', () => {
    expect(parseGateOutput(fail('some custom script printed nothing useful')).tool).toBeNull()
    expect(parseGateOutput(fail('...', 1)).summary).toBe('Failed (exit 1).')
    expect(parseGateOutput(pass('...')).summary).toBe('Passed.')
  })

  it('strips ANSI colour codes before matching', () => {
    const colored = fail('[31mTests[0m  [1m1[0m failed | [32m9[0m passed (10)')
    expect(parseGateOutput(colored).tool).toBe('vitest')
    expect(parseGateOutput(colored).failed).toBe(1)
  })

  it('caps the number of failures kept, even when many more exist', () => {
    const many = Array.from({ length: 40 }, (_, i) => `FAILED tests/test_x.py::test_${i} - boom`).join('\n')
    const p = parseGateOutput(fail(`${many}\n===================== 40 failed in 1.00s =====================`))
    expect(p.failed).toBe(40)
    expect(p.failures).toHaveLength(12)
  })
})

describe('repairFeedback', () => {
  it('turns parsed failures into a short, addressable list for the repair prompt', () => {
    const out = fail(
      ['FAILED tests/test_math.py::test_add - AssertionError: assert 3 == 4', '===================== 1 failed, 8 passed in 0.42s ====================='].join('\n')
    )
    const fb = repairFeedback(out)
    expect(fb).toContain('1 failed, 8 passed')
    expect(fb).toContain('- tests/test_math.py::test_add: AssertionError: assert 3 == 4')
  })

  it('says how many more failures exist beyond the ones listed', () => {
    const many = Array.from({ length: 20 }, (_, i) => `FAILED tests/test_x.py::test_${i} - boom`).join('\n')
    const fb = repairFeedback(fail(`${many}\n===================== 20 failed in 1.00s =====================`))
    expect(fb).toContain('…and 8 more.')
  })

  it('falls back to the raw tail, unchanged, when nothing could be parsed (never regresses on an unknown tool)', () => {
    const raw = fail('a custom test runner\nprinted a summary in a format nobody here recognises')
    expect(repairFeedback(raw)).toBe(raw)
  })

  it('falls back to the raw tail on a timeout too', () => {
    const raw = 'Timed out.\nsome output that was still streaming'
    expect(repairFeedback(raw)).toBe(raw)
  })

  it('truncates a very long raw fallback from the front, keeping the end', () => {
    const long = fail('x'.repeat(10_000))
    const fb = repairFeedback(long, 100)
    expect(fb.length).toBeLessThan(200)
    expect(fb.endsWith('x'.repeat(50))).toBe(true)
  })

  it('never drops the fact that MORE than the shown failures exist', () => {
    const many = Array.from({ length: 15 }, (_, i) => `FAILED t.py::test_${i} - x`).join('\n')
    const fb = repairFeedback(fail(`${many}\n===================== 15 failed in 1.00s =====================`))
    expect(fb.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(12)
    expect(fb).toContain('…and 3 more.')
  })
})

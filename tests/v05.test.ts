import { expect } from 'claude-code/testing'

import * as R from '../hooks/register.ts'
import { agent, handBack, quiet, ROOT, startSession, stop, test, world } from './harness'

// Handler-level tests for truss ADR-0004 sections 3-7 (foreman stop gate, bounded repair loop, head guard,
// main-session rule), written from the ADR before the producer exists. The pure functions of section 9 are
// covered by contract-gates.test.ts; this file drives the real hook entry points (Agent tool calls,
// SubagentHandback, foreman stops). It imports the hooks as a namespace and checks `typeof` inside each test, so on
// old code a test fails on a missing export or missing behaviour, never on an import error.
//
// The harness registers `process.run` once, and a second registration is an error. To script the head guard's
// git calls, the world is built through a wrapped `on` that puts this file's handler in front of the harness one:
// the git-common-dir lookup is delegated to the harness (it answers C:/r/.git), every other git call is recorded
// in `gitCalls` and answered by the test's `git` script. The same wrapper lets a test make fs.list / fs.read throw.

const MARK = '[truss]'
const H1 = 'a'.repeat(40)
const H2 = 'b'.repeat(40)
const P1 = '1'.repeat(40)
const P2 = '2'.repeat(40)
const APPROVED = '2026-10-17T11:00:00Z'
const SINCE = Date.parse(APPROVED)
const SENTINEL = 'ZXQ-SENTINEL-7731'
const PLAN = `${ROOT}/plan.json`
const EVENTS = `${ROOT}/events.jsonl`
const REPORTS = `${ROOT}/reports/auth`
const qcPath = (name: string) => `${REPORTS}/${name}.md`

const constant = (name: string): unknown => (R as Record<string, unknown>)[name]
// a string constant of the hooks; a missing one fails here, so a test can never pass by comparing undefined to undefined
const str = (name: string): string => {
  const v = constant(name)
  expect(typeof v === 'string' ? 'string' : `R.${name} is not a string`).toBe('string')
  return v as string
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fn = (name: string): any => {
  const v = constant(name)
  expect(typeof v === 'function' ? 'function' : `R.${name} is not a function`).toBe('function')
  return v
}

type GitResult = { exitCode: number; stdout: string } | 'throw'
type Call = { argv: string[]; init: { cwd?: string; timeoutMs?: number; stdin?: string } }
type Opts = {
  git?: (argv: string[], init: Call['init']) => GitResult
  listThrowsFor?: string
  readThrowsFor?: string
  inRepo?: boolean
}

// a git that behaves: head `head`, diff text 'DIFF', patch id `patch`
const gitAt =
  (head: string, patch: string) =>
  (argv: string[]): GitResult => {
    if (argv[1] === 'rev-parse') return { exitCode: 0, stdout: `${head}\n` }
    if (argv[1] === 'diff') return { exitCode: 0, stdout: 'DIFF-TEXT\n' }
    if (argv[1] === 'patch-id') return { exitCode: 0, stdout: `${patch}  ${head}\n` }
    return { exitCode: 1, stdout: '' }
  }

function build($: never, on: never, o: Opts = {}) {
  const gitCalls: Call[] = []
  const ctl = { git: o.git ?? gitAt(H1, P1) }
  const rawOn = on as unknown as (ev: string, h: (...a: unknown[]) => unknown) => unknown
  const wrapped = ((ev: string, h: (...a: unknown[]) => unknown) => {
    if (ev === 'process.run') {
      return rawOn(ev, async (c: unknown, e: unknown) => {
        const call = e as Call
        if (call.argv.includes('--git-common-dir')) return h(c, e)
        gitCalls.push({ argv: call.argv, init: call.init ?? {} })
        const r = ctl.git(call.argv, call.init ?? {})
        if (r === 'throw') throw new Error('git blew up')
        return { value: { exitCode: r.exitCode, stdout: r.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      })
    }
    if (ev === 'fs.list' && o.listThrowsFor !== undefined) {
      return rawOn(ev, async (c: unknown, e: unknown) => {
        if (String((e as { path?: string }).path ?? '').replace(/\\/g, '/').includes(o.listThrowsFor as string)) throw new Error('list is down')
        return h(c, e)
      })
    }
    if (ev === 'fs.read' && o.readThrowsFor !== undefined) {
      return rawOn(ev, async (c: unknown, e: unknown) => {
        if (String((e as { path?: string }).path ?? '').replace(/\\/g, '/').endsWith(o.readThrowsFor as string)) throw new Error('read is down')
        return h(c, e)
      })
    }
    return rawOn(ev, h)
  }) as never
  const wopts: { inRepo?: boolean; listFails?: boolean } = o.inRepo === false ? { inRepo: false } : {}
  const w = quiet(world($ as never, wrapped, wopts))
  return { w, gitCalls, ctl, wopts }
}

// one world per test (the kit refuses a second world()); between cases a test resets what the hooks read
const reset = (b: Built) => {
  for (const k of [...b.w.files.keys()]) if (k.includes('/reports/') || k === EVENTS) b.w.files.delete(k)
  b.w.mtimes.clear()
  b.gitCalls.length = 0
}

type Built = ReturnType<typeof build>
type W = Built['w']

const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

// a symbol value is dropped by JSON.stringify: passing OMIT leaves the reworkAllowance key out of the plan
const OMIT = Symbol('omit')
const setPlan = (w: W, version: unknown, reworkAllowance: unknown = 2, crews: unknown[] = [{ slug: 'auth', stage: 0, verdict: 'change', status: 'running' }]) =>
  w.files.set(PLAN, JSON.stringify({ version, goal: 'g', approval: 'auto', approvedAt: APPROVED, maxParallelCrews: 4, reworkAllowance, crews }))

const BRANCH_LINE = 'auth-branch at abc1234, based on def5678.'
const EXAM = ['## Examined', '- callers of planVerdict: `grep -rn planVerdict plugins/`', '## Not examined', 'None.']
const report = (o: { branch?: string; extra?: string[]; marker?: string } = {}) =>
  [
    '## Summary',
    `did the work ${o.marker ?? SENTINEL}`,
    '## Branch',
    o.branch ?? BRANCH_LINE,
    '## Changes',
    'a.ts',
    '## Proof',
    'tests pass',
    '## Checks run',
    'bun test',
    ...(o.extra ?? EXAM),
    '## Open questions',
    'None.',
  ].join('\n')
const withoutHeadings = () => report({ extra: [] })

const qcText = (verdict: 'PASS' | 'FAIL', o: { head?: string | null; patch?: string | null; findings?: string } = {}) =>
  [
    `VERDICT: ${verdict}`,
    '',
    '## Proof checked',
    ...(o.head === null ? [] : [`Head: ${o.head ?? H1}`]),
    ...(o.patch === null ? [] : [`Patch: ${o.patch ?? P1}`]),
    '',
    '## Findings',
    o.findings ?? `nothing wrong ${SENTINEL}`,
  ].join('\n')

const setQc = (w: W, name: string, text: string, mtimeMs?: number) => {
  w.files.set(qcPath(name), text)
  if (mtimeMs !== undefined) w.mtimes.set(qcPath(name), mtimeMs)
}

const foreman = async ($: never, text: string, active = false): Promise<string | undefined> => {
  const r = (await ($ as unknown as { classic: { SubagentStop: (e: never) => Promise<unknown> } }).classic.SubagentStop(stop('L1', text, active))) as { block?: string }
  return r.block
}

const eventLines = (w: W) =>
  (w.files.get(EVENTS) ?? '')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Record<string, unknown>)
const allowanceLines = (w: W) => eventLines(w).filter(e => e.event === 'allowance-spent')

const qcAgent = (w: W, id: string, name: string, parent = 'L1') => w.agents.push(agent(id, 'truss:qc-engineer', name, parent))
const spawnQc = (w: W, from: string, name: string | undefined) =>
  w.agentCall(from, { subagent_type: 'truss:qc-engineer', ...(name === undefined ? {} : { name }), model: 'opus', effort: 'medium' })

const FAIL_BODY = `VERDICT: FAIL\n\n## Findings\nthe acceptance test still fails and the diff leaves a stale caller ${SENTINEL}`

// a v2 world with a clean PASS for head H1 and a git whose head is H1: the report with both headings goes through
async function cleanWorld($: never, on: never, o: Opts = {}) {
  const b = build($, on, { git: gitAt(H1, P1), ...o })
  setPlan(b.w, 2, 2)
  setQc(b.w, 'auth-qc', qcText('PASS'), SINCE + 1000)
  await startSession($ as never)
  return b
}

// ---------------------------------------------------------------------------------------------
// 1. foreman stop gate, section 4
// ---------------------------------------------------------------------------------------------

test('s4: v2 plan, untagged report with the six sections but neither heading, or only one, is sent back with EXAMINED_REASON', async ($, on) => {
  const { w } = await cleanWorld($ as never, on as never)
  const reason = str('EXAMINED_REASON')
  expect(await foreman($ as never, withoutHeadings())).toBe(reason)
  expect(await foreman($ as never, report({ extra: ['## Examined', '- x: y'] }))).toBe(reason)
  expect(await foreman($ as never, report({ extra: ['## Not examined', 'None.'] }))).toBe(reason)
  expect(w.files.size).toBeGreaterThan(0)
})

test('s4: v2 plan, both headings and a clean head guard go through', async ($, on) => {
  await cleanWorld($ as never, on as never)
  str('EXAMINED_REASON')
  expect(await foreman($ as never, report())).toBeUndefined()
})

test('s4: a heading counts only at line start, full line (trailing spaces and tabs allowed)', async ($, on) => {
  await cleanWorld($ as never, on as never)
  const reason = str('EXAMINED_REASON')
  const bad: string[][] = [
    ['## Examined stuff', '## Not examined', 'None.'],
    ['## Examined', '## Not examined list', 'None.'],
    ['  ## Examined', '## Not examined'],
    ['## Examined', '\t## Not examined'],
    ['see ## Examined', '## Not examined'],
    ['## Examined', 'and ## Not examined'],
    ['### Examined', '### Not examined'],
  ]
  for (const extra of bad) expect([extra, await foreman($ as never, report({ extra }))]).toEqual([extra, reason])
  const good: string[][] = [
    ['## Examined   ', '- x: y', '## Not examined\t', 'None.'],
    ['## Examined\t \t', '## Not examined  '],
  ]
  for (const extra of good) expect([extra, await foreman($ as never, report({ extra }))]).toEqual([extra, undefined])
})

test('s4: tagged stops (CHECKPOINT:, BLOCKED:, QUESTION:, PROPOSAL:) are exempt on a v2 plan, with or without a Proof section', async ($, on) => {
  const { w, gitCalls } = await cleanWorld($ as never, on as never)
  str('EXAMINED_REASON')
  w.files.delete(qcPath('auth-qc'))
  for (const tag of ['CHECKPOINT:', 'BLOCKED:', 'QUESTION:', 'PROPOSAL:']) {
    expect([tag, await foreman($ as never, `${tag} half done\n${withoutHeadings()}`)]).toEqual([tag, undefined])
    expect([tag, await foreman($ as never, `${tag} half done`)]).toEqual([tag, undefined])
  }
  expect(gitCalls).toEqual([])
})

test('s4: a v1 plan, no plan and an unparseable plan.json let the same report through as in 0.4.3, running no git', async ($, on) => {
  const { w, gitCalls } = build($ as never, on as never)
  await startSession($ as never)
  for (const setup of ['v1', 'none', 'garbage', 'noversion'] as const) {
    w.files.delete(PLAN)
    if (setup === 'v1') setPlan(w, 1, undefined)
    if (setup === 'garbage') w.files.set(PLAN, '{not json at all')
    if (setup === 'noversion') w.files.set(PLAN, JSON.stringify({ goal: 'g', approval: 'auto', approvedAt: APPROVED, maxParallelCrews: 4, crews: [] }))
    expect([setup, await foreman($ as never, withoutHeadings())]).toEqual([setup, undefined])
    expect([setup, gitCalls]).toEqual([setup, []])
  }
})

test('s4: a v3 plan gets the v2 rules', async ($, on) => {
  const { w } = build($ as never, on as never)
  setPlan(w, 3, 2)
  await startSession($ as never)
  expect(await foreman($ as never, withoutHeadings())).toBe(str('EXAMINED_REASON'))
})

// ---------------------------------------------------------------------------------------------
// 2. head guard, section 6 table, end to end through a foreman stop
// ---------------------------------------------------------------------------------------------

test('s6: no qc file, a FAIL, or a PASS with an UNSCOPED finding is sent back with NO_PASS_REASON', async ($, on) => {
  const reason = str('NO_PASS_REASON')
  const b = build($ as never, on as never, { git: gitAt(H1, P1) })
  setPlan(b.w, 2, 2)
  await startSession($ as never)
  for (const [label, text] of [
    ['no file', undefined],
    ['FAIL', qcText('FAIL')],
    ['PASS with UNSCOPED', qcText('PASS', { findings: '- UNSCOPED: no other caller, in the foreman report' })],
  ] as const) {
    reset(b)
    if (text !== undefined) setQc(b.w, 'auth-qc', text, SINCE + 1000)
    expect([label, await foreman($ as never, report())]).toEqual([label, reason])
  }
})

test('s6: a PASS with no head or no patch line is sent back with NO_HEAD_REASON', async ($, on) => {
  const reason = str('NO_HEAD_REASON')
  const b = build($ as never, on as never, { git: gitAt(H1, P1) })
  setPlan(b.w, 2, 2)
  await startSession($ as never)
  for (const [label, text] of [
    ['neither', qcText('PASS', { head: null, patch: null })],
    ['no patch', qcText('PASS', { patch: null })],
    ['no head', qcText('PASS', { head: null })],
    ['uppercase head', qcText('PASS', { head: H1.toUpperCase() })],
    ['short head', qcText('PASS', { head: 'abc1234' })],
    ['lines outside Proof checked', `VERDICT: PASS\n\n## Findings\nHead: ${H1}\nPatch: ${P1}\n`],
  ] as const) {
    reset(b)
    setQc(b.w, 'auth-qc', text, SINCE + 1000)
    expect([label, await foreman($ as never, report())]).toEqual([label, reason])
  }
})

test('s6: git rev-parse failing (non-zero, throwing, garbage stdout) lets the stop through, running no diff', async ($, on) => {
  str('NO_HEAD_REASON')
  const cases: [string, Opts['git']][] = [
    ['non-zero', () => ({ exitCode: 1, stdout: '' })],
    ['throws', () => 'throw'],
    ['garbage', argv => (argv[1] === 'rev-parse' ? { exitCode: 0, stdout: 'not a sha\n' } : { exitCode: 0, stdout: 'x' })],
    ['empty', () => ({ exitCode: 0, stdout: '' })],
  ]
  const { gitCalls, ctl } = await cleanWorld($ as never, on as never)
  for (const [label, git] of cases) {
    ctl.git = git as never
    gitCalls.length = 0
    expect([label, await foreman($ as never, report())]).toEqual([label, undefined])
    expect([label, gitCalls.filter(c => c.argv[1] === 'diff' || c.argv[1] === 'patch-id')]).toEqual([label, []])
  }
})

test('s6: head equal to the qcd head goes through and runs only rev-parse', async ($, on) => {
  const { gitCalls } = await cleanWorld($ as never, on as never, { git: gitAt(H1, P2) })
  expect(await foreman($ as never, report())).toBeUndefined()
  expect(gitCalls.length).toBeGreaterThan(0)
  expect(gitCalls.every(c => c.argv[1] === 'rev-parse')).toBe(true)
})

test('s6: head moved with the same patch id goes through (the PASS survives the rebase)', async ($, on) => {
  const { gitCalls } = await cleanWorld($ as never, on as never, { git: gitAt(H2, P1) })
  expect(await foreman($ as never, report())).toBeUndefined()
  expect(gitCalls.map(c => c.argv[1])).toEqual(['rev-parse', 'diff', 'patch-id'])
})

test('s6: head moved with a different patch id is sent back with headMovedReason(qcd, head)', async ($, on) => {
  await cleanWorld($ as never, on as never, { git: gitAt(H2, P2) })
  const moved = fn('headMovedReason')(H1, H2)
  expect(typeof moved).toBe('string')
  expect(await foreman($ as never, report())).toBe(moved)
  expect(moved).toContain(H1)
  expect(moved).toContain(H2)
})

test('s6: head moved and the patch-id call failing (non-zero, throwing, garbage, diff failing) lets the stop through', async ($, on) => {
  str('NO_HEAD_REASON')
  const cases: [string, Opts['git']][] = [
    ['patch-id non-zero', a => (a[1] === 'patch-id' ? { exitCode: 1, stdout: '' } : gitAt(H2, P2)(a))],
    ['patch-id throws', a => (a[1] === 'patch-id' ? 'throw' : gitAt(H2, P2)(a))],
    ['patch-id garbage', a => (a[1] === 'patch-id' ? { exitCode: 0, stdout: 'zzz  yyy\n' } : gitAt(H2, P2)(a))],
    ['patch-id empty', a => (a[1] === 'patch-id' ? { exitCode: 0, stdout: '' } : gitAt(H2, P2)(a))],
    ['diff fails', a => (a[1] === 'diff' ? { exitCode: 128, stdout: '' } : gitAt(H2, P2)(a))],
    ['diff throws', a => (a[1] === 'diff' ? 'throw' : gitAt(H2, P2)(a))],
  ]
  const { ctl } = await cleanWorld($ as never, on as never, { git: gitAt(H2, P2) })
  for (const [label, git] of cases) {
    ctl.git = git as never
    expect([label, await foreman($ as never, report())]).toEqual([label, undefined])
  }
})

test('s6: the git calls have the exact argv, cwd and timeout the ADR fixes, and the diff output is the patch-id stdin', async ($, on) => {
  const { gitCalls } = await cleanWorld($ as never, on as never, { git: gitAt(H2, P1) })
  expect(await foreman($ as never, report())).toBeUndefined()
  expect(gitCalls.map(c => c.argv)).toEqual([
    ['git', 'rev-parse', '--verify', '--quiet', 'auth-branch^{commit}'],
    ['git', 'diff', '--no-color', '--no-ext-diff', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', 'def5678...auth-branch'],
    ['git', 'patch-id', '--stable'],
  ])
  for (const c of gitCalls) expect([c.argv[1], c.init.timeoutMs, c.init.cwd]).toEqual([c.argv[1], 15_000, 'C:/r'])
  expect(gitCalls[2]?.init.stdin).toBe('DIFF-TEXT\n')
})

test('s6: a Branch line wrapped in single backticks reads the same branch and base', async ($, on) => {
  const { gitCalls } = await cleanWorld($ as never, on as never, { git: gitAt(H2, P1) })
  expect(await foreman($ as never, report({ branch: '`auth-branch` at `abc1234`, based on `def5678`.' }))).toBeUndefined()
  expect(gitCalls[0]?.argv).toEqual(['git', 'rev-parse', '--verify', '--quiet', 'auth-branch^{commit}'])
  expect(gitCalls[1]?.argv.at(-1)).toBe('def5678...auth-branch')
})

test('s6: a Branch line whose branch or base starts with "-" runs no git at all and fails open', async ($, on) => {
  str('NO_HEAD_REASON')
  const { gitCalls } = await cleanWorld($ as never, on as never, { git: gitAt(H2, P2) })
  for (const branch of ['-evil at abc1234, based on def5678.', 'auth-branch at abc1234, based on -x.', '`--upload-pack=x` at abc1234, based on def5678.']) {
    gitCalls.length = 0
    expect([branch, await foreman($ as never, report({ branch }))]).toEqual([branch, undefined])
    expect([branch, gitCalls]).toEqual([branch, []])
  }
})

test('s6: no readable Branch line means head unknown: the stop goes through, no git run', async ($, on) => {
  const { gitCalls } = await cleanWorld($ as never, on as never, { git: gitAt(H2, P2) })
  expect(await foreman($ as never, report({ branch: 'it is on some branch' }))).toBeUndefined()
  expect(gitCalls).toEqual([])
})

test('s6: stale qc files (mtime before approvedAt) are ignored: a stale PASS is not a PASS', async ($, on) => {
  const reason = str('NO_PASS_REASON')
  const { w } = build($ as never, on as never, { git: gitAt(H1, P1) })
  setPlan(w, 2, 2)
  setQc(w, 'auth-qc', qcText('PASS'), SINCE - 86_400_000)
  await startSession($ as never)
  expect(await foreman($ as never, report())).toBe(reason)
  // a stale PASS under a fresh FAIL is still no PASS; a fresh PASS next to a stale FAIL is a PASS
  setQc(w, 'auth-qc-2', qcText('FAIL'), SINCE + 1000)
  expect(await foreman($ as never, report())).toBe(reason)
  setQc(w, 'auth-qc', qcText('FAIL'), SINCE - 86_400_000)
  setQc(w, 'auth-qc-2', qcText('PASS'), SINCE + 1000)
  expect(await foreman($ as never, report())).toBeUndefined()
})

test('s6: the latest this-run qc file rules: a newer FAIL over an older PASS is no PASS, a newer PASS over an older FAIL is one', async ($, on) => {
  const reason = str('NO_PASS_REASON')
  const { w } = build($ as never, on as never, { git: gitAt(H1, P1) })
  setPlan(w, 2, 2)
  setQc(w, 'auth-qc', qcText('PASS'), SINCE + 1000)
  setQc(w, 'auth-qc-2', qcText('FAIL'), SINCE + 2000)
  await startSession($ as never)
  expect(await foreman($ as never, report())).toBe(reason)
  setQc(w, 'auth-qc', qcText('FAIL'), SINCE + 1000)
  setQc(w, 'auth-qc-2', qcText('PASS'), SINCE + 2000)
  expect(await foreman($ as never, report())).toBeUndefined()
})

test('s6: a stress test file is not the latest qc file', async ($, on) => {
  const { w } = await cleanWorld($ as never, on as never)
  w.files.set(`${REPORTS}/auth-stress.md`, 'STRESSTEST: x\nVERDICT: FAIL\n')
  w.mtimes.set(`${REPORTS}/auth-stress.md`, SINCE + 9000)
  expect(await foreman($ as never, report())).toBeUndefined()
})

test('s6: the head guard runs only after the examined check: a missing heading is sent back with EXAMINED_REASON and no git runs', async ($, on) => {
  const { gitCalls } = await cleanWorld($ as never, on as never, { git: gitAt(H2, P2) })
  expect(await foreman($ as never, withoutHeadings())).toBe(str('EXAMINED_REASON'))
  expect(gitCalls).toEqual([])
})

// ---------------------------------------------------------------------------------------------
// 3. streak
// ---------------------------------------------------------------------------------------------

test('streak: examined send-backs share the streak: FOREMAN_STOP_BLOCKS in a row, then the next stop goes through', async ($, on) => {
  const { w } = await cleanWorld($ as never, on as never)
  expect(R.FOREMAN_STOP_BLOCKS).toBe(2)
  const reason = str('EXAMINED_REASON')
  expect(await foreman($ as never, withoutHeadings(), false)).toBe(reason)
  expect(await foreman($ as never, withoutHeadings(), true)).toBe(reason)
  expect(await foreman($ as never, withoutHeadings(), true)).toBeUndefined()
  // a fresh streak (stop_hook_active false) blocks again
  expect(await foreman($ as never, withoutHeadings(), false)).toBe(reason)
  expect(w.files.size).toBeGreaterThan(0)
})

test('streak: no-PASS send-backs count the same way', async ($, on) => {
  const noPass = str('NO_PASS_REASON')
  const a = build($ as never, on as never, { git: gitAt(H1, P1) })
  setPlan(a.w, 2, 2)
  await startSession($ as never)
  expect(await foreman($ as never, report(), false)).toBe(noPass)
  expect(await foreman($ as never, report(), true)).toBe(noPass)
  expect(await foreman($ as never, report(), true)).toBeUndefined()
})

test('streak: a moved-head send-back counts the same way', async ($, on) => {
  await cleanWorld($ as never, on as never, { git: gitAt(H2, P2) })
  const moved = fn('headMovedReason')(H1, H2)
  expect(await foreman($ as never, report(), false)).toBe(moved)
  expect(await foreman($ as never, report(), true)).toBe(moved)
  expect(await foreman($ as never, report(), true)).toBeUndefined()
})

test('streak: FOREMAN_STOP_REASON and the new send-backs share one count', async ($, on) => {
  await cleanWorld($ as never, on as never)
  expect(await foreman($ as never, 'chatter', false)).toBe(R.FOREMAN_STOP_REASON)
  expect(await foreman($ as never, withoutHeadings(), true)).toBe(str('EXAMINED_REASON'))
  expect(await foreman($ as never, withoutHeadings(), true)).toBeUndefined()
})

// ---------------------------------------------------------------------------------------------
// 4. fail open
// ---------------------------------------------------------------------------------------------

test('fail open: listing the qc folder throws -> the stop goes through', async ($, on) => {
  str('NO_PASS_REASON')
  const { w } = build($ as never, on as never, { listThrowsFor: '/reports/auth' })
  setPlan(w, 2, 2)
  // a non-qc file makes the folder exist, so the list call is made and throws
  w.files.set(`${REPORTS}/notes.txt`, 'x')
  await startSession($ as never)
  expect(await foreman($ as never, report())).toBeUndefined()
})

test('s6: a v2 plan with no reports/<crew> folder at all has no qc file: NO_PASS_REASON', async ($, on) => {
  const { w } = build($ as never, on as never, { git: gitAt(H1, P1) })
  setPlan(w, 2, 2)
  await startSession($ as never)
  expect([...w.files.keys()].some(k => k.includes('/reports/auth/'))).toBe(false)
  expect(await foreman($ as never, report())).toBe(str('NO_PASS_REASON'))
})

test('fail open: reading the qc file throws -> the stop goes through', async ($, on) => {
  str('NO_PASS_REASON')
  const { w } = build($ as never, on as never, { readThrowsFor: '/reports/auth/auth-qc.md' })
  setPlan(w, 2, 2)
  setQc(w, 'auth-qc', qcText('FAIL'), SINCE + 1000)
  await startSession($ as never)
  expect(await foreman($ as never, report())).toBeUndefined()
})

test('fail open: an unreadable plan.json means the 0.4.3 gate: the report without headings goes through', async ($, on) => {
  const { w, gitCalls } = build($ as never, on as never, { readThrowsFor: '/plan.json' })
  setPlan(w, 2, 2)
  await startSession($ as never)
  expect(await foreman($ as never, withoutHeadings())).toBeUndefined()
  expect(gitCalls).toEqual([])
})

test('fail open: a v1 plan never runs the head guard git calls, even with a moved head on disk', async ($, on) => {
  const { w, gitCalls } = build($ as never, on as never, { git: gitAt(H2, P2) })
  setPlan(w, 1, undefined)
  setQc(w, 'auth-qc', qcText('PASS'), SINCE + 1000)
  await startSession($ as never)
  expect(await foreman($ as never, report())).toBeUndefined()
  expect(gitCalls.some(c => c.argv.includes('--verify'))).toBe(false)
  expect(gitCalls).toEqual([])
})

// ---------------------------------------------------------------------------------------------
// 5. hand-back path
// ---------------------------------------------------------------------------------------------

const savedWith = (w: W, marker: string) => [...w.files.entries()].some(([k, v]) => k.includes('/reports/') && v.includes(marker))

test('hand-back: a foreman hand-back without the headings on a v2 plan is not saved as the report; with them it is; git is not run', async ($, on) => {
  const { w, gitCalls } = build($ as never, on as never, { git: gitAt(H2, P2) })
  setPlan(w, 2, 2)
  await startSession($ as never)
  str('EXAMINED_REASON')
  await handBack($ as never, 'L1', report({ extra: [], marker: 'HB-NOHEAD' }))
  await settle()
  expect(savedWith(w, 'HB-NOHEAD')).toBe(false)
  await handBack($ as never, 'L1', report({ marker: 'HB-HEADS' }))
  await settle()
  // saved although no qc file exists and the head moved: the guard does not run on hand-back
  expect(savedWith(w, 'HB-HEADS')).toBe(true)
  expect(gitCalls).toEqual([])
})

test('hand-back: a tagged foreman hand-back is saved on a v2 plan', async ($, on) => {
  const a = build($ as never, on as never)
  setPlan(a.w, 2, 2)
  await startSession($ as never)
  str('EXAMINED_REASON')
  await handBack($ as never, 'L1', `CHECKPOINT: half done, HB-TAG\n${withoutHeadings()}`)
  await settle()
  expect(savedWith(a.w, 'HB-TAG')).toBe(true)
})

test('hand-back: on a v1 plan the headingless report is saved as in 0.4.3', async ($, on) => {
  const b = build($ as never, on as never)
  setPlan(b.w, 1, undefined)
  await startSession($ as never)
  await handBack($ as never, 'L1', report({ extra: [], marker: 'HB-V1' }))
  await settle()
  expect(savedWith(b.w, 'HB-V1')).toBe(true)
  expect(b.gitCalls).toEqual([])
})

// ---------------------------------------------------------------------------------------------
// 6. allowance
// ---------------------------------------------------------------------------------------------

test('s5: allowance-spent is appended only when the saved FAIL leaves fails > reworkAllowance (allowances 0, 1, 2)', async ($, on) => {
  const cases: [number, number, boolean][] = [
    // [reworkAllowance, FAIL files already on disk, line expected after saving one more FAIL]
    [0, 0, true],
    [1, 0, false],
    [1, 1, true],
    [2, 0, false],
    [2, 1, false],
    [2, 2, true],
  ]
  const b = build($ as never, on as never)
  await startSession($ as never)
  let n = 0
  for (const [allowance, prior, expected] of cases) {
    reset(b)
    const { w } = b
    setPlan(w, 2, allowance === undefined ? OMIT : allowance)
    for (let i = 1; i <= prior; i++) setQc(w, i === 1 ? 'auth-qc' : `auth-qc-${i}`, 'VERDICT: FAIL\nx', SINCE + i)
    const id = `J${++n}`
    qcAgent(w, id, prior === 0 ? 'auth-qc' : `auth-qc-${prior + 1}`)
    await handBack($ as never, id, FAIL_BODY)
    await settle()
    expect([allowance, prior, allowanceLines(w).length]).toEqual([allowance, prior, expected ? 1 : 0])
    // the report line itself is always written
    expect(eventLines(w).some(e => e.event === 'report')).toBe(true)
  }
})

test('s5: a PASS saved after the allowance is spent adds no allowance-spent line', async ($, on) => {
  const { w } = build($ as never, on as never)
  setPlan(w, 2, 1)
  setQc(w, 'auth-qc', 'VERDICT: FAIL\nx', SINCE + 1)
  setQc(w, 'auth-qc-2', 'VERDICT: FAIL\nx', SINCE + 2)
  qcAgent(w, 'J9', 'auth-qc-3')
  await startSession($ as never)
  await handBack($ as never, 'J9', qcText('PASS'))
  await settle()
  expect(savedWith(w, 'VERDICT: PASS')).toBe(true)
  expect(eventLines(w).some(e => e.event === 'report')).toBe(true)
  expect(allowanceLines(w)).toEqual([])
})

test('s5: stress test files never count toward the allowance, and a stress test spawn is not gated', async ($, on) => {
  const { w } = build($ as never, on as never)
  setPlan(w, 2, 0)
  for (const n of ['auth-stress', 'auth-stress-2', 'auth-stress-3']) setQc(w, n, 'VERDICT: FAIL\nx', SINCE + 5)
  qcAgent(w, 'J9', 'auth-qc')
  await startSession($ as never)
  expect((await spawnQc(w, 'A1', 'auth-qc-2')).deny).toBeUndefined()
  // a qc FAIL of its own with allowance 0 spends it; the stress test files add nothing to that
  await handBack($ as never, 'J9', FAIL_BODY)
  await settle()
  expect(allowanceLines(w).length).toBe(1)
})

test('s5: a PASS saved beside stress test FAIL files is no spend', async ($, on) => {
  const { w } = build($ as never, on as never)
  setPlan(w, 2, 0)
  for (const n of ['auth-stress', 'auth-stress-2']) setQc(w, n, 'VERDICT: FAIL\nx', SINCE + 5)
  qcAgent(w, 'J9', 'auth-qc')
  await startSession($ as never)
  await handBack($ as never, 'J9', qcText('PASS'))
  await settle()
  expect(allowanceLines(w)).toEqual([])
})

test('s5: a successor foreman <crew>-2 has its own folder and its own count', async ($, on) => {
  const { w } = build($ as never, on as never)
  setPlan(w, 2, 1, [
    { slug: 'auth', stage: 0, verdict: 'change', status: 'running' },
  ])
  w.agents.push(agent('L3', R.FOREMAN_TYPE, 'auth-2'), agent('A3', 'kit:builder', 'auth-2-builder', 'L3'))
  qcAgent(w, 'J3', 'auth-2-qc', 'L3')
  // crew auth has spent its allowance of 1 (two FAILs)
  setQc(w, 'auth-qc', 'VERDICT: FAIL\nx', SINCE + 1)
  setQc(w, 'auth-qc-2', 'VERDICT: FAIL\nx', SINCE + 2)
  await startSession($ as never)
  expect(String((await spawnQc(w, 'A1', 'auth-qc-3')).deny).startsWith(`${MARK} Refused: rework allowance spent:`)).toBe(true)
  expect((await spawnQc(w, 'A3', 'auth-2-qc-2')).deny).toBeUndefined()
  // the successor's first FAIL leaves 1 FAIL, not above 1: no line
  await handBack($ as never, 'J3', FAIL_BODY)
  await settle()
  expect(w.files.get(`${ROOT}/reports/auth-2/auth-2-qc.md`)?.startsWith('VERDICT: FAIL')).toBe(true)
  expect(allowanceLines(w)).toEqual([])
})

test('s5 spawn gate: a qc spawn without a name, and a non-qc name even when spent, are not gated', async ($, on) => {
  const { w } = build($ as never, on as never)
  setPlan(w, 2, 0)
  setQc(w, 'auth-qc', 'VERDICT: FAIL\nx', SINCE + 1)
  setQc(w, 'auth-qc-2', 'VERDICT: FAIL\nx', SINCE + 2)
  await startSession($ as never)
  expect((await spawnQc(w, 'A1', undefined)).deny).toBeUndefined()
  expect((await spawnQc(w, 'A1', 'auth-builder-3')).deny).toBeUndefined()
  expect((await w.agentCall('A1', { subagent_type: 'kit:builder', name: 'auth-builder-3', model: 'opus', effort: 'medium' })).deny).toBeUndefined()
  // control: a qc name is refused
  expect(String((await spawnQc(w, 'A1', 'auth-qc-3')).deny).startsWith(`${MARK} Refused: rework allowance spent:`)).toBe(true)
})

test('s5 spawn gate: a refused qc spawn logs no spawn event, an allowed one does', async ($, on) => {
  const { w } = build($ as never, on as never)
  setPlan(w, 2, 0)
  setQc(w, 'auth-qc', 'VERDICT: FAIL\nx', SINCE + 1)
  await startSession($ as never)
  expect(String((await spawnQc(w, 'A1', 'auth-qc-2')).deny).startsWith(`${MARK} Refused: rework allowance spent:`)).toBe(true)
  await settle()
  expect(eventLines(w).filter(e => e.event === 'spawn')).toEqual([])
  expect((await spawnQc(w, 'A1', 'auth-helper')).deny).toBeUndefined()
  await settle()
  expect(eventLines(w).filter(e => e.event === 'spawn').length).toBe(1)
})

test('s5: a missing, negative, non-integer or string reworkAllowance on a v2 plan means no allowance rule', async ($, on) => {
  str('ALLOWANCE_REFUSAL')
  const b = build($ as never, on as never)
  const { w } = b
  qcAgent(w, 'J9', 'auth-qc-5')
  await startSession($ as never)
  for (const allowance of [undefined, -1, 1.5, '2', null, 'abc']) {
    reset(b)
    setPlan(w, 2, allowance === undefined ? OMIT : allowance)
    for (let i = 1; i <= 4; i++) setQc(w, i === 1 ? 'auth-qc' : `auth-qc-${i}`, 'VERDICT: FAIL\nx', SINCE + i)
    expect([allowance, (await spawnQc(w, 'A1', 'auth-qc-5')).deny]).toEqual([allowance, undefined])
    await handBack($ as never, 'J9', FAIL_BODY)
    await settle()
    expect([allowance, allowanceLines(w)]).toEqual([allowance, []])
  }
})

// ---------------------------------------------------------------------------------------------
// 7. main-session rule
// ---------------------------------------------------------------------------------------------

const mainCall = (w: W, input: Record<string, unknown>) => w.agentCall(undefined, { subagent_type: 'truss:qc-engineer', name: 'x-qc', ...input })

test('s7: on a v2 plan the model check runs before the effort check, and effort max is refused', async ($, on) => {
  const { w } = build($ as never, on as never)
  setPlan(w, 2, 2)
  await startSession($ as never)
  const model = str('MAIN_MODEL_REFUSAL')
  const effort = str('MAIN_EFFORT_REFUSAL')
  // neither model nor effort: the model reason
  expect((await mainCall(w, {})).deny).toBe(model)
  // no model and effort max: still the model reason
  expect((await mainCall(w, { effort: 'max' })).deny).toBe(model)
  expect((await mainCall(w, { model: 'opus' })).deny).toBe(effort)
  expect((await mainCall(w, { model: 'opus', effort: 'max' })).deny).toBe(effort)
  expect((await mainCall(w, { model: 'opus', effort: 'ultra' })).deny).toBe(effort)
  for (const e of ['low', 'medium', 'high', 'xhigh']) expect([e, (await mainCall(w, { model: 'sonnet', effort: e })).deny]).toEqual([e, undefined])
})

test('s7: a non-truss: type from the main session, and a call from inside a crew, are unaffected by the main rule', async ($, on) => {
  const { w } = build($ as never, on as never)
  setPlan(w, 2, 2)
  await startSession($ as never)
  const model = str('MAIN_MODEL_REFUSAL')
  for (const type of ['general-purpose', 'kit:builder', 'Explore']) expect([type, (await w.agentCall(undefined, { subagent_type: type, name: 'q' })).deny]).toEqual([type, undefined])
  // inside a crew the 0.4.0 rules stand: the old refusal, not the main one
  const inside = await w.agentCall('A1', { subagent_type: 'truss:qc-engineer', name: 'auth-helper' })
  expect(inside.deny).toBe(R.MODEL_REFUSAL)
  expect(inside.deny).not.toBe(model)
  expect((await w.agentCall('A1', { subagent_type: 'truss:qc-engineer', name: 'auth-helper', model: 'opus', effort: 'xhigh' })).deny).toBeUndefined()
})

test('s7: outside a repo (no truss dir) a truss:* main call with no model goes through', async ($, on) => {
  str('MAIN_MODEL_REFUSAL')
  const a = build($ as never, on as never, { inRepo: false })
  await startSession($ as never)
  expect((await mainCall(a.w, {})).deny).toBeUndefined()
})

test('s7: with no plan.json a truss:* main call with no model goes through', async ($, on) => {
  str('MAIN_MODEL_REFUSAL')
  const b = build($ as never, on as never)
  await startSession($ as never)
  expect((await mainCall(b.w, {})).deny).toBeUndefined()
  expect((await mainCall(b.w, { subagent_type: 'truss:design-engineer', name: 'arch' })).deny).toBeUndefined()
})

test('s7: with an unparseable plan.json a truss:* main call with no model goes through', async ($, on) => {
  str('MAIN_MODEL_REFUSAL')
  const c = build($ as never, on as never)
  c.w.files.set(PLAN, '{nope')
  await startSession($ as never)
  expect((await mainCall(c.w, {})).deny).toBeUndefined()
})

test('s7: the main rule runs before the plan gates: a truss:foreman call with no model whose stage gate would also refuse gets MAIN_MODEL_REFUSAL', async ($, on) => {
  const { w } = build($ as never, on as never)
  setPlan(w, 2, 2, [
    { slug: 'billing-x', stage: 0, verdict: 'change', status: 'running' },
    { slug: 'ship', stage: 1, verdict: 'change', status: 'planned' },
  ])
  await startSession($ as never)
  const model = str('MAIN_MODEL_REFUSAL')
  const foreman1 = (extra: Record<string, unknown>) => w.agentCall(undefined, { subagent_type: R.FOREMAN_TYPE, name: 'ship', ...extra })
  expect((await foreman1({})).deny).toBe(model)
  // control: with model and effort set, the stage gate is what refuses
  expect(String((await foreman1({ model: 'opus', effort: 'medium' })).deny)).toContain("stage 0 isn't merged yet")
})

// ---------------------------------------------------------------------------------------------
// 8. logs
// ---------------------------------------------------------------------------------------------

const newLogs = (w: W, before: number) => w.logs.slice(before)
const named = (lines: string[], rule: RegExp) => lines.some(l => (l.includes('[truss]') || l.includes('truss:')) && rule.test(l))

test('logs: each refusal and send-back adds a [truss]/truss: line naming the rule, and no line holds report text', async ($, on) => {
  const { w } = build($ as never, on as never, { git: gitAt(H2, P2) })
  setPlan(w, 2, 0)
  w.agents.push({ ...agent('J9', 'truss:qc-engineer', 'auth-qc', 'L1'), status: 'completed' })
  await startSession($ as never)
  str('EXAMINED_REASON')

  let before = w.logs.length
  await foreman($ as never, withoutHeadings())
  expect(named(newLogs(w, before), /examin/i)).toBe(true)

  before = w.logs.length
  await foreman($ as never, report())
  expect(named(newLogs(w, before), /qc|pass/i)).toBe(true)

  setQc(w, 'auth-qc', qcText('PASS'), SINCE + 1000)
  before = w.logs.length
  await foreman($ as never, report())
  expect(named(newLogs(w, before), /head/i)).toBe(true)

  // allowance 0 and a PASS on disk: not spent; spend it, then refuse
  setQc(w, 'auth-qc-2', qcText('FAIL', { findings: SENTINEL }), SINCE + 2000)
  before = w.logs.length
  expect(String((await spawnQc(w, 'A1', 'auth-qc-3')).deny).startsWith(`${MARK} Refused: rework allowance spent:`)).toBe(true)
  expect(named(newLogs(w, before), /allowance/i)).toBe(true)

  before = w.logs.length
  expect((await mainCall(w, { effort: 'medium' })).deny).toBe(str('MAIN_MODEL_REFUSAL'))
  expect(named(newLogs(w, before), /model|main/i)).toBe(true)
  before = w.logs.length
  expect((await mainCall(w, { model: 'opus' })).deny).toBe(str('MAIN_EFFORT_REFUSAL'))
  expect(named(newLogs(w, before), /effort|main/i)).toBe(true)

  // a foreman hand-back that is sent back, and a qc FAIL report that spends the allowance
  await handBack($ as never, 'L1', report({ extra: [] }))
  await handBack($ as never, 'J9', FAIL_BODY)
  await settle()

  expect(w.logs.join('\n')).not.toContain(SENTINEL)
})

// ---------------------------------------------------------------------------------------------
// 9. regression tests for stress test breaks
// ---------------------------------------------------------------------------------------------

test('regression A: a held-back v2 hand-back is saved when the stop goes through on a failing agent list', async ($, on) => {
  str('EXAMINED_REASON')
  const { w, wopts } = await cleanWorld($ as never, on as never)
  await handBack($ as never, 'L1', report({ extra: [], marker: 'HB-HELD' }))
  await settle()
  expect(savedWith(w, 'HB-HELD')).toBe(false)
  wopts.listFails = true
  expect(await foreman($ as never, 'sign-off, no report here')).toBeUndefined()
  await settle()
  expect(savedWith(w, 'HB-HELD')).toBe(true)
})

test('regression B: a Branch name git would read as a revision expression runs no git and goes through', async ($, on) => {
  str('NO_HEAD_REASON')
  const { gitCalls } = await cleanWorld($ as never, on as never, { git: gitAt(H2, P2) })
  const lines = [
    ...['HEAD', '@', 'a@{1}', 'a~1', 'head', 'Head', 'orig_head', 'refs/worktree/x', 'refs/bisect/bad', 'main-worktree/HEAD'].map(n => `${n} at abc1234, based on def5678.`),
    'auth-branch at abc1234, based on head.',
  ]
  const bad: string[] = []
  for (const branch of lines) {
    gitCalls.length = 0
    const block = await foreman($ as never, report({ branch }))
    if (block !== undefined || gitCalls.length > 0) bad.push(branch)
  }
  // every offending Branch line is listed, not just the first
  expect(bad).toEqual([])
})

test('regression B control: a normal branch whose name contains "head" still runs git and gets HEAD_MOVED when the patch differs', async ($, on) => {
  str('NO_HEAD_REASON')
  const { gitCalls } = await cleanWorld($ as never, on as never, { git: gitAt(H2, P2) })
  const block = await foreman($ as never, report({ branch: 'feature/head-guard at abc1234, based on def5678.' }))
  expect(block).toBe(fn('headMovedReason')(H1, H2))
  expect(gitCalls[0]?.argv).toEqual(['git', 'rev-parse', '--verify', '--quiet', 'feature/head-guard^{commit}'])
})

test('regression C: a hung read of the qc file does not hold a foreman stop past the 2000 ms bound', async ($, on) => {
  str('NO_PASS_REASON')
  const { w } = await cleanWorld($ as never, on as never)
  w.holds.set(qcPath('auth-qc'), new Promise(() => {}))
  let done = false
  let block: string | undefined = 'pending'
  void foreman($ as never, report()).then(b => {
    block = b
    done = true
  })
  await settle()
  await w.clock.advance(3000)
  await settle()
  expect(done).toBe(true)
  expect(block).toBeUndefined()
})

test('regression C: a hung read of plan.json does not hold a main-session truss:qc-engineer call past the bound', async ($, on) => {
  str('MAIN_MODEL_REFUSAL')
  const { w } = await cleanWorld($ as never, on as never)
  w.holds.set(PLAN, new Promise(() => {}))
  let done = false
  let deny: string | undefined = 'pending'
  void mainCall(w, { model: 'opus', effort: 'medium' }).then(r => {
    deny = r.deny
    done = true
  })
  await settle()
  await w.clock.advance(3000)
  await settle()
  expect(done).toBe(true)
  expect(deny).toBeUndefined()
})

test('regression D: qc names in other letter cases are gated by a spent allowance, and log no spawn', async ($, on) => {
  str('ALLOWANCE_REFUSAL')
  const { w } = build($ as never, on as never)
  setPlan(w, 2, 0)
  setQc(w, 'auth-qc', 'VERDICT: FAIL\nx', SINCE + 1000)
  await startSession($ as never)
  const prefix = `${MARK} Refused: rework allowance spent:`
  const denied = async (name: string) => String((await spawnQc(w, 'A1', name)).deny).startsWith(prefix)
  // control: the exact lower-case names are refused, a builder is not
  expect(await denied('auth-qc-2')).toBe(true)
  expect((await w.agentCall('A1', { subagent_type: 'kit:builder', name: 'auth-builder', model: 'opus', effort: 'medium' })).deny).toBeUndefined()
  const slipped: string[] = []
  for (const name of ['AUTH-QC', 'Auth-Qc-2']) if (!(await denied(name))) slipped.push(name)
  expect(slipped).toEqual([])
  await settle()
  expect(eventLines(w).filter(e => e.event === 'spawn' && (e.agent === 'AUTH-QC' || e.agent === 'Auth-Qc-2'))).toEqual([])
})

test('regression D: a qc named AUTH-QC handing back a FAIL with allowance 0 writes one allowance-spent line for crew auth', async ($, on) => {
  str('ALLOWANCE_REFUSAL')
  const { w } = build($ as never, on as never)
  setPlan(w, 2, 0)
  qcAgent(w, 'J9', 'AUTH-QC')
  await startSession($ as never)
  await handBack($ as never, 'J9', FAIL_BODY)
  await settle()
  const lines = allowanceLines(w)
  expect(lines.length).toBe(1)
  expect([lines[0]?.agent, lines[0]?.crew]).toEqual(['AUTH-QC', 'auth'])
})

test('regression D: a qc file saved as AUTH-QC.md is read by the head guard (case-sensitive fs)', async ($, on) => {
  const reason = str('NO_PASS_REASON')
  const b = build($ as never, on as never, { git: gitAt(H1, P1) })
  setPlan(b.w, 2, 2)
  await startSession($ as never)
  // a FAIL under the upper-case name: sent back
  setQc(b.w, 'AUTH-QC', qcText('FAIL'), SINCE + 1000)
  expect(await foreman($ as never, report())).toBe(reason)
  // control: a clean PASS under the same name, head equal to git's head: through
  reset(b)
  setQc(b.w, 'AUTH-QC', qcText('PASS'), SINCE + 1000)
  expect(await foreman($ as never, report())).toBeUndefined()
})

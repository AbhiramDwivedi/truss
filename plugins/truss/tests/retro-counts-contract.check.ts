// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// Contract test for truss's retro counts (`retro/cli.ts counts`), truss ADR-0003 section 3 and "Seams" 2.
// Ported from the Python test_contract_retro.py. The fixtures under fixtures/ are synthetic (P8), shaped like the two
// real pre-0.4.0 session dirs and like a 0.4.0 dir; the expected counts are worked out by hand from them and
// written here, not computed.
// Run with: node --test tests/retro-counts-contract.check.ts
import assert from 'node:assert/strict'
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, test } from 'node:test'
import { FIXTURES, mktmp, NR, retro, runCounts, snapshot } from './retro-counts-lib.ts'

const PRE = join(FIXTURES, 'retro-pre040')
const NEW = join(FIXTURES, 'retro-040')
const TOP_KEYS = ['leftovers', 'leftoverDetails', 'retro', 'dir', 'split', 'runs', 'qcFiles', 'plan', 'eventsSkipped', 'eventsOutsideRuns'].sort()
const RUN_KEYS = ['started', 'goal', 'decisions', 'freeform', 'recommendations', 'messages', 'spawns', 'stalls', 'escalations', 'qcs', 'allowancesSpent', 'fetches', 'refusals', 'extendPasses', 'defaultDecisions', 'openClientActions'].sort()

const cache = new Map()
const out = (path: string) => {
  if (!cache.has(path)) cache.set(path, retro(path))
  return cache.get(path)
}

describe('shape', () => {
  for (const path of [PRE, NEW]) {
    test(`output shape: ${basename(path)}`, () => {
      const o = out(path)
      assert.deepEqual(Object.keys(o).sort(), TOP_KEYS)
      assert.equal(o.retro, 1)
      for (const run of o.runs) assert.deepEqual(Object.keys(run).sort(), RUN_KEYS)
    })
  }

  test('writes nothing', () => {
    const before = [snapshot(PRE), snapshot(NEW)]
    runCounts(PRE)
    runCounts(NEW)
    assert.deepEqual([snapshot(PRE), snapshot(NEW)], before)
  })

  test('a missing dir exits 2 with NO_TRUSS_DIR on stderr', () => {
    const tmp = mktmp('retro-contract-')
    const r = runCounts(join(tmp, 'no-such-dir'))
    assert.equal(r.code, 2)
    assert.ok(r.stderr.startsWith('retro: NO_TRUSS_DIR:'), `stderr: ${r.stderr}`)
    assert.equal(r.stdout, '')
  })
})

describe('pre-0.4.0 dir: no headings, no events', () => {
  test('is one unsplit run', () => {
    const o = out(PRE)
    assert.equal(o.split, NR)
    assert.equal(o.runs.length, 1)
    assert.equal(o.runs[0].started, NR)
    assert.equal(o.runs[0].goal, NR)
  })

  test('decisions', () => {
    // 10 structured decision lines: 3 dated, 5 clock (one RFC 3339), 2 literal HH:MM.
    // Outcomes: 7 followed (one of them "followed (deferred)"; the other deferred line is a RECOMMEND, counted
    // separately), 1 overruled, 2 "—".
    assert.deepEqual(out(PRE).runs[0].decisions, { total: 10, clock: 5, dateOnly: 3, notRecorded: 2, followed: 7, overruled: 1, other: 2 })
  })

  test('free-form lines are counted and indented sub-bullets are skipped', () => {
    // 5 free-form "- " lines; the indented sub-bullets (one shaped like a decision) don't count.
    assert.equal(out(PRE).runs[0].freeform, 5)
  })

  test('recommendations', () => {
    assert.deepEqual(out(PRE).runs[0].recommendations, { total: 4, answer: 2, defer: 1, pass: 1 })
  })

  test('messages include rolled logs', () => {
    assert.equal(out(PRE).runs[0].messages, 4)
  })

  test('event categories are not recorded', () => {
    const run = out(PRE).runs[0]
    for (const key of ['spawns', 'stalls', 'escalations', 'qcs']) assert.equal(run[key], NR, key)
    assert.equal(out(PRE).eventsSkipped, 0)
    assert.equal(out(PRE).eventsOutsideRuns, 0)
  })

  test('qc files', () => {
    // quartz-qc FAIL, quartz-qc-2 PASS, lantern-qc PASS, ferry-qc CHECKPOINT;
    // not .interim.md, not builder/stress reports, not a report saved under an agent id.
    assert.deepEqual(out(PRE).qcFiles, { files: 4, pass: 2, fail: 1, other: 1 })
  })

  test('plan', () => {
    // Read as: crews = len(crews), stages = distinct stage values, estAgents = sum (see report: ADR gap).
    assert.deepEqual(out(PRE).plan, { crews: 3, stages: 2, estAgents: 12, agentCap: 20, status: { merged: 2, failed: 1 } })
  })
})

describe('0.4.0 dir: two headings and an event log', () => {
  test('splits into a pre-heading run and two runs', () => {
    const o = out(NEW)
    assert.equal(o.split, 'headings')
    assert.deepEqual(
      o.runs.map((r) => [r.started, r.goal]),
      [
        [NR, NR],
        ['2026-10-27T09:00:30Z', 'build the retro script'],
        ['2026-10-27T13:00:00Z', 'docs pass'],
      ],
    )
  })

  test('decisions per run', () => {
    assert.deepEqual(
      out(NEW).runs.map((r) => r.decisions),
      [
        { total: 1, clock: 1, dateOnly: 0, notRecorded: 0, followed: 1, overruled: 0, other: 0 },
        { total: 2, clock: 1, dateOnly: 0, notRecorded: 1, followed: 1, overruled: 1, other: 0 },
        // the 14:00 line after "## Notes" stays in the second run
        { total: 3, clock: 2, dateOnly: 1, notRecorded: 0, followed: 2, overruled: 0, other: 1 },
      ],
    )
  })

  test('free-form and recommendations per run', () => {
    const runs = out(NEW).runs
    assert.deepEqual(runs.map((r) => r.freeform), [0, 1, 0])
    assert.deepEqual(
      runs.map((r) => r.recommendations),
      [
        { total: 0, answer: 0, defer: 0, pass: 0 },
        { total: 1, answer: 1, defer: 0, pass: 0 },
        { total: 2, answer: 0, defer: 1, pass: 1 },
      ],
    )
  })

  test('messages per run', () => {
    assert.deepEqual(out(NEW).runs.map((r) => r.messages), [1, 2, 1])
  })

  test('spawns per run', () => {
    const runs = out(NEW).runs
    assert.equal(runs[0].spawns, NR)
    assert.deepEqual(runs[1].spawns, { total: 3, byModelEffort: { 'sonnet/medium': 2, 'opus/unset': 1 } })
    // events.1.jsonl (rolled) counts too
    assert.deepEqual(runs[2].spawns, { total: 2, byModelEffort: { 'unset/unset': 1, 'sonnet/low': 1 } })
  })

  test('stalls per run', () => {
    assert.deepEqual(out(NEW).runs.map((r) => r.stalls), [NR, { agent: 2, idleForeman: 1 }, { agent: 0, idleForeman: 0 }])
  })

  test('escalations per run', () => {
    // the v:2 PROPOSAL line is skipped, not counted
    assert.deepEqual(out(NEW).runs.map((r) => r.escalations), [
      NR,
      { QUESTION: 1, BLOCKED: 1, PROPOSAL: 0 },
      { QUESTION: 0, BLOCKED: 0, PROPOSAL: 1 },
    ])
  })

  test('qcs count only qc-named reports', () => {
    assert.deepEqual(out(NEW).runs.map((r) => r.qcs), [NR, { pass: 1, fail: 1 }, { pass: 1, fail: 0 }])
  })

  test('skipped and outside events', () => {
    assert.equal(out(NEW).eventsSkipped, 2)
    assert.equal(out(NEW).eventsOutsideRuns, 1)
  })

  test('qc files and no plan', () => {
    assert.deepEqual(out(NEW).qcFiles, { files: 3, pass: 2, fail: 1, other: 0 })
    assert.equal(out(NEW).plan, NR)
  })

  test('CRLF and a BOM are stripped', () => {
    const dst = join(mktmp('retro-contract-'), 'dir')
    cpSync(NEW, dst, { recursive: true })
    const p = join(dst, 'decisions.md')
    const text = readFileSync(p, 'utf8')
    writeFileSync(p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text.replaceAll('\n', '\r\n'), 'utf8')]))
    const got = retro(dst)
    const want = out(NEW)
    assert.deepEqual(got.runs.map((x) => x.decisions), want.runs.map((x) => x.decisions))
    assert.deepEqual(got.runs.map((x) => x.goal), want.runs.map((x) => x.goal))
  })
})

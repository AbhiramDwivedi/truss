// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// Edge-case tests for `retro/cli.ts counts` that retro-counts-contract.check.ts does not pin. Ported from the Python
// test_retro.py. All data is synthetic and written to a temp dir, never to fixtures/ (P8).
// Run with: node --test tests/retro-counts-edges.check.ts
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { ev, mktmp, NR, retro, runCounts, write } from './retro-counts-lib.ts'

let dir: string
beforeEach(() => {
  dir = mktmp('retro-edge-')
})
const put = (name: string, data: string | Buffer) => write(dir, name, data)
const lines = (...l: string[]) => `${l.join('\n')}\n`

describe('input edges', () => {
  test('corrupt and v2 lines are skipped and counted', () => {
    put('decisions.md', '## Run 2026-01-01T00:00:00Z | g\n')
    const l = [
      ev('2026-01-01T01:00:00.000Z', 'tag', { tag: 'QUESTION' }),
      '{not json',
      '[1,2]',
      '',
      JSON.stringify({ v: 2, ts: '2026-01-01T01:00:00Z', event: 'tag', tag: 'BLOCKED' }),
      ev('not a time', 'tag', { tag: 'BLOCKED' }),
    ]
    put('events.jsonl', lines(...l))
    const out = retro(dir)
    assert.equal(out.eventsSkipped, 4)
    assert.deepEqual(out.runs[0].escalations, { QUESTION: 1, BLOCKED: 0, PROPOSAL: 0 })
  })

  test('workflow finish lines count as escalations and spent allowances', () => {
    // the shapes factory finish writes for a Workflow crew (ADR-0009 "finish, escalation lines")
    put('decisions.md', '## Run 2026-01-01T00:00:00Z | g\n')
    put('events.jsonl', lines(
      ev('2026-01-01T01:00:00.000Z', 'tag', { crew: 'ui-web', agent: 'ui-web', tag: 'BLOCKED', run: 'wf_1' }),
      ev('2026-01-01T01:00:00.000Z', 'tag', { crew: 'ui-api', agent: 'ui-api', tag: 'QUESTION', run: 'wf_1' }),
      ev('2026-01-01T02:00:00.000Z', 'tag', { crew: 'ui-web', agent: 'ui-web', tag: 'BLOCKED', run: 'wf_2' }),
      ev('2026-01-01T02:00:00.000Z', 'allowance-spent', { crew: 'ui-session', agent: 'ui-session-qc-3' }),
    ))
    const run = retro(dir).runs[0]
    assert.deepEqual(run.escalations, { QUESTION: 1, BLOCKED: 2, PROPOSAL: 0 })
    assert.equal(run.allowancesSpent, 1)
  })

  test('non-UTF-8 bytes do not crash', () => {
    put('decisions.md', Buffer.concat([
      Buffer.from('## Run 2026-01-01T00:00:00Z | g'), Buffer.from([0xff, 0xfe]),
      Buffer.from('\n- 09:00 | a'), Buffer.from([0xff]), Buffer.from(' | b | c | followed\n'),
    ]))
    put('events.jsonl', Buffer.concat([Buffer.from([0xff, 0xfe, 0x00]), Buffer.from('garbage\n')]))
    const out = retro(dir)
    assert.equal(out.runs[0].decisions.followed, 1)
    assert.equal(out.eventsSkipped, 1)
  })

  test('mixed grammars classify line by line', () => {
    put('decisions.md', lines(
      '- 2026-02-02 | d1 | r | c | followed',
      '- 2026-02-02T10:00:00+02:00 | d2 | r | c | overruled: x',
      '- HH:MM | d3 | r | c | —',
      '- 9:05 | checker-1 RECOMMEND pass: nope | followed',
      '- 2026-02-02 free text without a bar',
      '- checker-1 RECOMMEND answer: no time field',
      '    - 09:00 | indented | r | c | followed',
    ))
    const run = retro(dir).runs[0]
    assert.deepEqual(run.decisions, { total: 3, clock: 1, dateOnly: 1, notRecorded: 1, followed: 1, overruled: 1, other: 1 })
    assert.equal(run.freeform, 2)
    assert.deepEqual(run.recommendations, { total: 1, answer: 0, defer: 0, pass: 1 })
  })

  test('an offset heading is echoed and compared as an instant', () => {
    // 10:00+02:00 is 08:00Z. The 08:30Z event is after it; the 07:30Z one is before it.
    put('decisions.md', '## Run 2026-03-03T10:00:00+02:00 | offset run\n')
    put('events.jsonl', lines(
      ev('2026-03-03T08:30:00.000Z', 'stall', { kind: 'agent', minutes: 5 }),
      ev('2026-03-03T07:30:00.000Z', 'stall', { kind: 'agent', minutes: 5 }),
    ))
    const out = retro(dir)
    assert.equal(out.runs[0].started, '2026-03-03T10:00:00+02:00')
    assert.deepEqual(out.runs[0].stalls, { agent: 1, idleProjectManager: 0 })
    assert.equal(out.eventsOutsideRuns, 1)
  })

  test('an unparsable heading start is not recorded and gets no events', () => {
    put('decisions.md', '## Run yesterday-ish | odd goal\n- 09:00 | a | b | c | followed\n')
    put('events.jsonl', lines(ev('2026-03-03T08:30:00.000Z', 'spawn', { model: 'opus', effort: null })))
    const out = retro(dir)
    assert.equal(out.split, 'headings')
    const run = out.runs[0]
    assert.deepEqual([run.started, run.goal], [NR, 'odd goal'])
    assert.equal(run.decisions.total, 1)
    assert.equal(run.spawns, NR)
    assert.equal(out.eventsOutsideRuns, 1)
  })

  test('a heading first means no pre-heading run', () => {
    put('decisions.md', '# Title\n\n## Run 2026-01-01T00:00:00Z | g\n- 09:00 | a | b | c | followed\n')
    assert.equal(retro(dir).runs.length, 1)
  })

  test('events without headings are outside and not recorded', () => {
    put('decisions.md', '- 09:00 | a | b | c | followed\n')
    put('events.jsonl', lines(ev('2026-03-03T08:30:00.000Z', 'tag', { tag: 'BLOCKED' })))
    const out = retro(dir)
    assert.equal(out.split, NR)
    assert.equal(out.runs[0].escalations, NR)
    assert.equal(out.eventsOutsideRuns, 1)
  })

  test('an empty events file gives zeros for headed runs', () => {
    put('decisions.md', '## Run 2026-01-01T00:00:00Z | g\n')
    put('events.jsonl', '')
    assert.deepEqual(retro(dir).runs[0].stalls, { agent: 0, idleProjectManager: 0 })
  })

  test('no decisions file and an odd plan', () => {
    put('plan.json', JSON.stringify({ crews: 'nope' }))
    const out = retro(dir)
    assert.equal(out.split, NR)
    assert.equal(out.plan.crews, 0)
    put('plan.json', 'not json')
    assert.equal(retro(dir).plan, NR)
  })

  test('a huge line is skipped, not loaded', () => {
    put('decisions.md', '## Run 2026-01-01T00:00:00Z | g\n')
    put('events.jsonl', Buffer.concat([
      Buffer.from('{"v":1,"pad":"'), Buffer.alloc(3 << 20, 'x'), Buffer.from('"}\n'),
      Buffer.from(`${ev('2026-01-01T01:00:00.000Z', 'tag', { tag: 'PROPOSAL' })}\n`),
    ]))
    const out = retro(dir)
    assert.equal(out.eventsSkipped, 1)
    assert.equal(out.runs[0].escalations.PROPOSAL, 1)
  })

  test('runs from another cwd', () => {
    const other = mktmp('retro-cwd-')
    put('decisions.md', '- 09:00 | a | b | c | followed\n')
    assert.equal(runCounts(dir, { cwd: other }).code, 0)
  })
})

// stress-test regressions: no input may crash the script or break strict JSON (retro() parses with JSON.parse, which
// rejects NaN and Infinity)
describe('stress regressions', () => {
  test('deeply nested lines do not crash', () => {
    put('decisions.md', '## Run 2026-01-01T00:00:00Z | g\n')
    put('events.jsonl', `${ev('2026-01-01T01:00:00Z', 'stall', { kind: 'agent' })}\n${'['.repeat(200000)}\n`)
    put('messages.jsonl', `${'['.repeat(200000)}\n`)
    put('plan.json', '['.repeat(200000))
    const out = retro(dir)
    assert.equal(out.eventsSkipped, 1)
    assert.equal(out.runs[0].stalls.agent, 1)
    assert.equal(out.runs[0].messages, 0)
    assert.equal(out.plan, NR)
  })

  test('wrong-typed event fields are ignored', () => {
    put('decisions.md', '## Run 2026-01-01T00:00:00Z | g\n')
    const t = '2026-01-01T01:00:00Z'
    put('events.jsonl', lines(
      ev(t, 'tag', { tag: ['QUESTION'] }), ev(t, 'tag', { tag: { a: 1 } }), ev(t, 'tag', { tag: 'BLOCKED' }),
      ev(t, 'stall', { kind: ['agent'] }), ev(t, 'report', { agent: ['x-qc'], marker: ['VERDICT: PASS'] }),
      ev(t, 'report', { agent: 'c-qc', marker: { a: 1 } }),
      ev(t, 'spawn', { model: ['opus'], effort: 5 }), ev(t, ['spawn']),
    ))
    const out = retro(dir)
    const run = out.runs[0]
    assert.equal(out.eventsSkipped, 0)
    assert.deepEqual(run.escalations, { QUESTION: 0, BLOCKED: 1, PROPOSAL: 0 })
    assert.deepEqual(run.stalls, { agent: 0, idleProjectManager: 0 })
    assert.deepEqual(run.qcs, { pass: 0, fail: 0 })
    assert.deepEqual(run.spawns, { total: 1, byModelEffort: { 'unset/unset': 1 } })
  })

  test('plan output is strict JSON', () => {
    put('plan.json', '{"agentCap": NaN, "crews":[{"stage":1,"estAgents":Infinity,"status":"done"},{"stage":1,"estAgents":3},{"estAgents":true},{"estAgents":1.5}]}')
    const plan = retro(dir).plan
    assert.equal(plan.estAgents, 3)
    assert.equal(plan.agentCap, 'not recorded')
    assert.equal(plan.crews, 4)
  })

  test('plan huge ints do not crash', () => {
    const n = '9'.repeat(4300)
    put('plan.json', `{"agentCap": ${n}, "crews":[{"estAgents":${n}},{"estAgents":${n}},{"estAgents":2}]}`)
    const plan = retro(dir).plan
    assert.equal(plan.estAgents, 2)
    assert.equal(plan.agentCap, 'not recorded')
  })

  test('a plan without agentCap says not recorded', () => {
    put('plan.json', '{"crews":[{"stage":1,"estAgents":2}]}')
    assert.equal(retro(dir).plan.agentCap, 'not recorded')
  })

  test('a valid agentCap is copied', () => {
    put('plan.json', '{"agentCap": 12, "crews":[]}')
    assert.equal(retro(dir).plan.agentCap, 12)
  })

  test('a structured decision line needs a space after the pipe', () => {
    put('decisions.md', '## Run 2026-01-01T00:00:00Z | g\n- 10:05| a | r | c | followed\n- 10:06 |nospace | followed\n- 10:07 |\n- 10:08 | ok | r | c | followed\n')
    const run = retro(dir).runs[0]
    assert.equal(run.freeform, 3)
    assert.equal(run.decisions.total, 1)
  })
})

// half-failed roll: events.<n>.jsonl byte-identical to events.jsonl must count once
describe('rolled files', () => {
  test('an identical rolled events file counts once', () => {
    put('decisions.md', '## Run 2026-01-01T00:00:00Z | g\n')
    const line = `${ev('2026-01-01T01:00:00Z', 'spawn', { model: 'opus', effort: 'high' })}\n`
    put('events.1.jsonl', line)
    put('events.jsonl', line)
    assert.equal(retro(dir).runs[0].spawns.total, 1)
  })

  test('an identical rolled messages file counts once', () => {
    put('decisions.md', '## Run 2026-01-01T00:00:00Z | g\n')
    const line = `${JSON.stringify({ ts: '2026-01-01T01:00:00Z', from: 'a', to: 'b' })}\n`
    put('messages.1.jsonl', line)
    put('messages.jsonl', line)
    assert.equal(retro(dir).runs[0].messages, 1)
  })

  test('different rolled files both count', () => {
    put('decisions.md', '## Run 2026-01-01T00:00:00Z | g\n')
    put('events.1.jsonl', `${ev('2026-01-01T01:00:00Z', 'spawn', { model: 'opus', effort: 'high' })}\n`)
    put('events.jsonl', `${ev('2026-01-01T01:00:00Z', 'spawn', { model: 'opus', effort: 'low' })}\n`) // same size, different bytes
    const m = `${JSON.stringify({ ts: '2026-01-01T01:00:00Z' })}\n`
    put('messages.1.jsonl', m)
    put('messages.jsonl', m + m) // rolled file is a prefix of the live one
    const out = retro(dir).runs[0]
    assert.equal(out.spawns.total, 2)
    assert.equal(out.messages, 3)
  })
})

// A RECOMMEND in the checker field (4th field) of a decision line counts as a recommendation, and the line still
// counts as a decision.
describe('checker field recommendations', () => {
  const recsOf = (...l: string[]) => {
    put('decisions.md', lines(...l))
    return retro(dir).runs[0]
  }

  test('bare RECOMMEND', () => {
    const run = recsOf('- 19:04 | d | r | RECOMMEND: answer (soft) | followed')
    assert.deepEqual(run.recommendations, { total: 1, answer: 1, defer: 0, pass: 0 })
    assert.deepEqual([run.decisions.total, run.decisions.followed], [1, 1])
  })

  test('numbered RECOMMEND on an overruled line', () => {
    const run = recsOf('- 22:30 | d | r | checker-3 RECOMMEND: answer (conditional on x) | overruled: y')
    assert.deepEqual(run.recommendations, { total: 1, answer: 1, defer: 0, pass: 0 })
    assert.deepEqual([run.decisions.total, run.decisions.overruled], [1, 1])
  })

  test('a colon after the checker name', () => {
    const run = recsOf('- 00:08 | d | r | checker-4: RECOMMEND: pass, option (a) | followed')
    assert.deepEqual(run.recommendations, { total: 1, answer: 0, defer: 0, pass: 1 })
  })

  test('a multiplier counts n outcomes', () => {
    const run = recsOf('- 00:08 | d1; d2 | r | checker-4: RECOMMEND: defer (x2) | followed')
    assert.deepEqual(run.recommendations, { total: 2, answer: 0, defer: 2, pass: 0 })
    assert.equal(run.decisions.total, 1)
  })

  test('none counts nothing', () => {
    const run = recsOf(
      '- 09:00 | d | r | none | followed',
      '- 09:01 | d naming RECOMMEND: answer | r | none | followed',
      '- 09:02 | d | r | checker-4 correctness flag | followed',
      '- 09:03 | d | r | RECOMMEND: defer | followed (deferred)',
    )
    assert.deepEqual(run.recommendations, { total: 1, answer: 0, defer: 1, pass: 0 })
    assert.equal(run.decisions.total, 4)
  })

  test('the line form still counts beside the checker-field form without double counting', () => {
    const run = recsOf(
      '- 09:10 | checker-1 RECOMMEND answer: x | followed',
      '- 09:11 | checker-1 RECOMMEND defer: y | followed (deferred)',
      '- 09:12 | d | r | checker-1 RECOMMEND: pass | followed',
    )
    assert.deepEqual(run.recommendations, { total: 3, answer: 1, defer: 1, pass: 1 })
    assert.equal(run.decisions.total, 1)
  })
})

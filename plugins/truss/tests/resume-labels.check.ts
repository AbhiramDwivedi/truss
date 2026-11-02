// @ts-nocheck
// Contract test for resumed-workflow report filing in `factory finish` (ADR-0020, goal resume-labels).
// A resumed run's journal holds two agentIds under one label. The k-th distinct agentId (journal `started` order)
// owns <label>.md for k=1 and <label>.run<k>.md for k>=2; a refusal ("different text already exists") happens only
// for the same agentId whose file holds different text, and for a gate label (<slug>-qc, <slug>-stress).
// Imports only from the shared harness; uses its temp dirs only.

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { test } from 'node:test'
import { appendEvent, assertOneLine, crew, factorySpawn, mkEnv, mkRun, planObj, readEvents, readPlan, writePlan, writeReport } from './fixtures/workflow-run/harness.ts'

const CFG = { merge: 'sequential', target: 'main' }
const A1 = 'aaa1'
const B2 = 'bbb2'
const OLD = () => new Date(Date.now() - 3 * 3600_000).toISOString()

/** One world: crew `s` running with its factory spawn line, and run wf_1 holding `agents` (RunAgent list). */
function world(agents) {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew('s', { status: 'running' })], { approvedAt: '2026-10-01T00:00:00.000Z' }))
  appendEvent(env.dir, factorySpawn('s', OLD()))
  const run = mkRun(env.transcripts, 'wf_1', agents)
  const w = { env, run, t: run.dir }
  w.finish = () => env.run('finish', { transcript: w.t })
  w.file = (name) => `${env.dir}/reports/s/${name}.md`
  w.snap = () => {
    const d = `${env.dir}/reports`
    const files = existsSync(d) ? readdirSync(d, { recursive: true }).map(String).sort() : []
    return {
      files: files.map((f) => [f, statSync(`${d}/${f}`).isFile() ? readFileSync(`${d}/${f}`, 'utf8') : '']),
      events: readFileSync(`${env.dir}/events.jsonl`, 'utf8'),
    }
  }
  return w
}

/** The resumed run: two agentIds under the non-gate label s-planner, different text. */
const resumed = () => world([
  { id: A1, label: 's-planner', metaModel: 'sonnet', effort: 'medium', result: 'first plan' },
  { id: B2, label: 's-planner', metaModel: 'sonnet', effort: 'medium', result: 'second plan' },
])

const labelAudited = (j, label) => (j.audit ?? []).some((a) => String(a.label).includes(label))

test('rl 1: two agentIds under one non-gate label are filed as <label>.md and <label>.run2.md, no audit', () => {
  const w = resumed()
  const j = assertOneLine(w.finish())
  const msg = `audit: ${JSON.stringify(j.audit)}`
  assert.ok(!labelAudited(j, 's-planner'), `s-planner must not be audited; ${msg}`)
  assert.ok(existsSync(w.file('s-planner')), `s-planner.md is missing; ${msg}`)
  assert.equal(readFileSync(w.file('s-planner'), 'utf8'), 'first plan', `s-planner.md must hold the first agentId's text; ${msg}`)
  assert.ok(existsSync(w.file('s-planner.run2')), `s-planner.run2.md is missing; ${msg}`)
  assert.equal(readFileSync(w.file('s-planner.run2'), 'utf8'), 'second plan', `s-planner.run2.md must hold the second agentId's text; ${msg}`)
  const spawns = readEvents(w.env.dir).filter((e) => e.event === 'spawn' && e.agent === 's-planner')
  for (const id of [A1, B2]) assert.ok(spawns.some((e) => e.agentId === id), `no spawn line for agentId ${id}; ${msg}`)
})

test('rl 2: the same agentId whose file already holds different text is audited and the file is unchanged', () => {
  const w = world([{ id: A1, label: 's-planner', metaModel: 'sonnet', effort: 'medium', result: 'first plan' }])
  writeReport(w.env.dir, 's', 's-planner', 'DIFFERENT\n', Date.parse('2026-10-29T09:00:00Z'))
  appendEvent(w.env.dir, { v: 1, ts: OLD(), event: 'spawn', crew: 's', agent: 's-planner', agentId: A1, type: 'general-purpose', model: null, effort: null, by: 'workflow:wf_1' })
  const j = assertOneLine(w.finish())
  const msg = `audit: ${JSON.stringify(j.audit)}`
  assert.ok(labelAudited(j, 's-planner'), `s-planner must be audited; ${msg}`)
  assert.equal(readFileSync(w.file('s-planner'), 'utf8'), 'DIFFERENT\n', `the file must be unchanged; ${msg}`)
  assert.ok(!existsSync(w.file('s-planner.run2')), `no .run2 file for the same agentId; ${msg}`)
})

test('rl 3: finishing the resumed run twice gives the same stdout, report files and events, and <label>.run2.md exists', () => {
  const w = resumed()
  const r1 = w.finish()
  const j1 = assertOneLine(r1)
  const s1 = w.snap()
  const r2 = w.finish()
  const msg = `audit: ${JSON.stringify(j1.audit)} then ${JSON.stringify(r2.json?.audit)}`
  assert.ok(existsSync(w.file('s-planner.run2')), `s-planner.run2.md is missing after the first finish; ${msg}`)
  assert.equal(r2.stdout, r1.stdout, `stdout differs between the two finishes; ${msg}`)
  assert.equal(r2.status, r1.status, `exit status differs; ${msg}`)
  assert.deepEqual(w.snap(), s1, `report files or events.jsonl changed on the second finish; ${msg}`)
  assert.ok(existsSync(w.file('s-planner.run2')), `s-planner.run2.md is missing after the second finish; ${msg}`)
})

test('rl 4: a second agentId under <slug>-qc with different text is still refused and the crew is not merged', () => {
  const w = world([
    { id: A1, label: 's-qc', agentType: 'truss:qc-engineer', metaModel: 'opus', effort: 'medium', result: 'VERDICT: PASS\n\n## Findings\n\n## Proof checked\n' },
    { id: B2, label: 's-qc', agentType: 'truss:qc-engineer', metaModel: 'opus', effort: 'medium', result: 'VERDICT: PASS\n\n## Findings\n- note\n\n## Proof checked\n' },
  ])
  const j = assertOneLine(w.finish())
  const msg = `audit: ${JSON.stringify(j.audit)}`
  assert.ok(labelAudited(j, 's-qc'), `s-qc must be audited; ${msg}`)
  assert.ok(!existsSync(w.file('s-qc.run2')), `a gate label must not be filed as .run2; ${msg}`)
  const merged = (j.merged ?? []).some((x) => (typeof x === 'string' ? x : x.slug) === 's')
  assert.ok(!merged, `crew s must not be merged; ${msg}`)
  assert.equal(readPlan(w.env.dir).crews.find((x) => x.slug === 's').status, 'running', `crew s must still be running; ${msg}`)
})

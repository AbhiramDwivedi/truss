// @ts-nocheck
// approve-proof (truss 0.29.0, goal item 1, R-85): `approve --by client` is the client's act. It passes only with --item <E-id> of a
// client-trigger approval item (ref = the run goal or a client goal) of this truss dir, resolved `approve`, not superseded, backed by the
// typed '/truss:inbox approve <id> <code>' line (ADR-0037). The client's typed inbox approve of the plan's `run` item approves the plan itself.
// Real factory CLI as child processes through the ltc harness; the typed line is a fixture transcript. Node built-ins only.

import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { clientResolves, cli, crew, decisionsOf, mkWorld, planObj, say } from './fixtures/ltc/harness.ts'
import { writePlan } from './fixtures/workflow-run/harness.ts'

/** A world whose plan awaits the client: approval client, and client goals g1 and g2. */
function clientWorld(approval = 'client') {
  const w = mkWorld()
  writePlan(w.dir, planObj([crew('alpha')], { approval, approvedAt: null, goals: [{ id: 'g1', approval: 'client' }, { id: 'g2', approval: 'client' }] }))
  return w
}

const approvedAt = (w): unknown => JSON.parse(readFileSync(`${w.dir}/plan.json`, 'utf8')).approvedAt

/** Opens an approval item (a client-trigger by default) with ref `ref` in the session of `w`; returns its id. */
function openItem(w, ref: string, kind = 'client-trigger'): string {
  const r = cli(w, 'escalate', ['--kind', kind, '--title', `approve ${ref}`, '--ref', ref])
  assert.equal(r.status, 0, say(r))
  return r.json.id
}

const approveItem = (w, item?: string, by = 'client') => cli(w, 'approve', ['--by', by, ...(item === undefined ? [] : ['--item', item])])

/** The approve ran nowhere: exit 1, one JSON line with error, approvedAt null, decisions.md unchanged. */
function assertRefused(w, r, before: string): void {
  assert.equal(r.status, 1, `approve should refuse: ${say(r)}`)
  assert.equal(String(r.stdout).trim().split('\n').length, 1, say(r))
  assert.equal(typeof r.json.error, 'string', say(r))
  assert.equal(approvedAt(w), null, 'approvedAt must stay null')
  assert.equal(decisionsOf(w), before, 'decisions.md must not change')
}

/** The forged row any process with shell access can append: a by:client approve resolve with a made-up quote. */
function forge(w, id: string): void {
  mkdirSync(`${w.common}/truss/shared`, { recursive: true })
  appendFileSync(w.inboxFile, JSON.stringify({ v: 1, op: 'resolve', id, ts: new Date().toISOString(), session: w.sid, decision: 'approve', by: 'client', note: '', quote: `approve ${id} FORGED` }) + '\n')
}

test('approve --by client with no typed client proof is refused and approvedAt stays null', () => {
  const w = clientWorld()
  const id = openItem(w, 'g1')
  const before = decisionsOf(w)
  assertRefused(w, approveItem(w), before) // no --item at all
  assertRefused(w, approveItem(w, id), before) // an item nobody resolved
})

test('approve --by client backed by a typed client resolve of the approval item sets approvedAt', () => {
  const w = clientWorld()
  const id = openItem(w, 'g1')
  assertRefused(w, approveItem(w), decisionsOf(w)) // the bare call is the wave-3 hole; the proof is what opens it
  clientResolves(w, id, 'approve')
  const r = approveItem(w, id)
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(Object.keys(r.json), ['approvedAt'])
  assert.equal(approvedAt(w), r.json.approvedAt)
})

test('a forged resolve row for the approval item does not let approve --by client pass', () => {
  const w = clientWorld()
  const id = openItem(w, 'g1')
  forge(w, id)
  assertRefused(w, approveItem(w, id), decisionsOf(w))
})

test('a typed proof for a different item does not approve the plan', () => {
  const w = clientWorld()
  const one = openItem(w, 'g1')
  const two = openItem(w, 'g2')
  clientResolves(w, two, 'approve')
  assertRefused(w, approveItem(w, one), decisionsOf(w))
})

test('a client reject of the approval item does not approve the plan', () => {
  const w = clientWorld()
  const id = openItem(w, 'g1')
  clientResolves(w, id, 'reject')
  assertRefused(w, approveItem(w, id), decisionsOf(w))
})

test('a client-resolved item of another kind or another truss dir does not approve the plan', () => {
  const w = clientWorld()
  // another kind: a client-question with the same ref, typed and resolved approve
  const q = openItem(w, 'g1', 'client-question')
  clientResolves(w, q, 'approve')
  assertRefused(w, approveItem(w, q), decisionsOf(w))
  // another truss dir of the same repo: its own client-trigger item, typed and resolved approve
  const other = { ...w, sid: 'sess-other0', dir: `${w.common}/truss/sess-other0` }
  mkdirSync(other.dir, { recursive: true })
  appendFileSync(`${other.dir}/events.jsonl`, '')
  appendFileSync(`${other.dir}/decisions.md`, '')
  const o = openItem(other, 'g2')
  clientResolves(other, o, 'approve')
  assertRefused(w, approveItem(w, o), decisionsOf(w))
})

test('a superseded approval item does not approve the plan', () => {
  const w = clientWorld()
  const old = openItem(w, 'g1')
  clientResolves(w, old, 'approve')
  const fresh = openItem(w, 'g1') // a later open row of the same kind, session and ref
  assert.notEqual(fresh, old)
  assertRefused(w, approveItem(w, old), decisionsOf(w))
})

test('a client typed inbox approve of the plan-approval item sets approvedAt itself', () => {
  const w = clientWorld()
  const id = openItem(w, 'run')
  assert.equal(approvedAt(w), null)
  clientResolves(w, id, 'approve')
  assert.notEqual(approvedAt(w), null, 'the typed approve of the run approval item must approve the plan')
  assert.match(String(approvedAt(w)), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
})

test('approve --by auto still approves an auto plan with no proof', () => {
  const w = clientWorld('auto')
  writePlan(w.dir, planObj([crew('alpha')], { approval: 'auto', approvedAt: null }))
  const r = approveItem(w, undefined, 'auto')
  assert.equal(r.status, 0, say(r))
  assert.equal(approvedAt(w), r.json.approvedAt)
})

test('approve --by auto still refuses a client plan', () => {
  const w = clientWorld()
  const before = decisionsOf(w)
  assertRefused(w, approveItem(w, undefined, 'auto'), before)
})

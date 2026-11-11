// @ts-nocheck
// truss 0.25.0 wave 2, A2: the long-term cost guard (contract-025 section 3, ADR-0034), written from the contract before bin/guard.ts is built.
// Every gate runs through the real factory CLI as child processes: plan-write, approve, resolve, land and finish. A costly item is opened by the
// factory, its code reaches the client only through the notify recorder, and the client resolves it with a typed '/truss:inbox approve <id> <code>'
// line in the fixture main transcript. ltcLines is called directly for the reversal case.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ltcLines } from '../bin/guard.ts'
import { CHEAP, COSTLY, ID_RE, assertOneLine, clientResolves, cli, codeOf, crewWorld, decisionsOf, designerResult, ltcItems, mkWorld, planWrite, say } from './fixtures/ltc/harness.ts'

const PKG_BASE = '{\n  "name": "client-app",\n  "dependencies": {}\n}\n'
const PKG_WITH_DEP = '{\n  "name": "client-app",\n  "dependencies": {\n    "left-pad": "1.3.0"\n  }\n}\n'
const BLOCKED = /long-term-cost: E-[0-9]{8}-[0-9a-f]{6}/

/** A land refused by the long-term cost gate: exit 1, merged false, the why names the item; returns the item id. */
function assertBlocked(cw: any, r: any): string {
  assert.equal(r.status, 1, say(r))
  assert.equal(r.json?.merged, false, say(r))
  assert.match(String(r.json.why), BLOCKED, say(r))
  assert.equal(cw.merged(), false, 'the crew branch is not on main')
  return String(r.json.why).match(BLOCKED)[0].slice('long-term-cost: '.length)
}

/** The crew is blocked, the client approves the one item, and the crew then lands. */
function blockedThenApproved(w: any, cw: any, id: string): void {
  const items = ltcItems(w)
  assert.equal(items.length, 1, `exactly one long-term-cost item: ${JSON.stringify(items)}`)
  assert.equal(items[0].id, id)
  assert.equal(items[0].state, 'open')
  assert.equal(items[0].blocking, true)
  clientResolves(w, id, 'approve')
  const r2 = cw.land()
  assert.equal(r2.status, 0, say(r2))
  assert.equal(r2.json.merged, true, say(r2))
  assert.equal(cw.merged(), true)
}

test('ltc guard: plan-write escalates a costly line and approve refuses', () => {
  const w = mkWorld()
  const pw = planWrite(w, 'wf_ltcplan1-aaa', designerResult([COSTLY]))
  assert.equal(pw.status, 0, say(pw))
  assert.equal(pw.json.written, true, say(pw))
  assert.equal(pw.json.longTermCosts.length, 1, `plan-write names the one escalated id: ${say(pw)}`)
  const id = pw.json.longTermCosts[0]
  assert.match(id, ID_RE)
  const items = ltcItems(w)
  assert.equal(items.length, 1, JSON.stringify(items))
  assert.equal(items[0].id, id)
  assert.equal(items[0].state, 'open')
  assert.equal(items[0].blocking, true)
  assert.match(items[0].title, /public REST route/)
  const r = cli(w, 'approve', ['--by', 'client'])
  assert.equal(r.status, 1, say(r))
  const j = assertOneLine(r)
  assert.equal(j.error, 'long-term cost awaiting the client')
  assert.deepEqual(j.ids, [id])
})

test('ltc guard: approve passes after a client approve', () => {
  const w = mkWorld()
  const pw = planWrite(w, 'wf_ltcplan2-aaa', designerResult([COSTLY]), ['Checker: agree.\nLONG-TERM-COST: a stored shape | later: a history migration | reversal: irreversible'])
  assert.equal(pw.status, 0, say(pw))
  const ids = pw.json.longTermCosts
  assert.equal(ids.length, 2, `the designer's and the checker's lines each escalate: ${say(pw)}`)
  assert.equal(cli(w, 'approve', ['--by', 'client']).status, 1, 'approve is refused while both are open')
  clientResolves(w, ids[0], 'approve')
  const half = cli(w, 'approve', ['--by', 'client'])
  assert.equal(half.status, 1, `one open item still blocks: ${say(half)}`)
  assert.deepEqual(half.json.ids, [ids[1]])
  clientResolves(w, ids[1], 'approve')
  const r = cli(w, 'approve', ['--by', 'client'])
  assert.equal(r.status, 0, say(r))
  assert.equal(typeof r.json.approvedAt, 'string')
  const items = ltcItems(w)
  assert.deepEqual(items.map((i) => i.decision), ['approve', 'approve'])
})

test('ltc guard: a re-plan clears a rejection', () => {
  const w = mkWorld()
  const first = planWrite(w, 'wf_ltcplan3-aaa', designerResult([COSTLY], 'v1'))
  assert.equal(first.status, 0, say(first))
  const id = first.json.longTermCosts[0]
  assert.match(String(id), ID_RE, say(first))
  clientResolves(w, id, 'reject')
  const refused = cli(w, 'approve', ['--by', 'client'])
  assert.equal(refused.status, 1, `a rejected item still blocks approve: ${say(refused)}`)
  assert.equal(refused.json.error, 'long-term cost awaiting the client')
  assert.deepEqual(refused.json.ids, [id])
  // the designer re-plans without the costly line: a new revision, so the old rejection no longer blocks
  const second = planWrite(w, 'wf_ltcplan3-bbb', designerResult([CHEAP], 'v2'))
  assert.equal(second.status, 0, say(second))
  assert.deepEqual(second.json.longTermCosts, [], say(second))
  const ok = cli(w, 'approve', ['--by', 'client'])
  assert.equal(ok.status, 0, say(ok))
  assert.equal(ltcItems(w).find((i) => i.id === id).decision, 'reject', 'the rejection itself stays on record')
})

test('ltc guard: a QC costly line blocks finish until approved', () => {
  const w = mkWorld()
  const cw = crewWorld(w, { slug: 's', process: 'full', qcLines: [`- ${COSTLY}`] })
  const r = cw.finish()
  assert.equal(r.status, 1, say(r))
  assert.deepEqual(r.json.merged, [], say(r))
  const refusal = r.json.refused.find((x) => x.slug === 's')
  assert.match(String(refusal?.why), BLOCKED, say(r))
  assert.equal(cw.merged(), false, 'the crew branch is not on main')
  const items = ltcItems(w)
  assert.equal(items.length, 1, JSON.stringify(items))
  assert.equal(items[0].state, 'open')
  assert.deepEqual(items[0].crews, ['s'])
  assert.equal(items[0].id, String(refusal.why).match(BLOCKED)[0].slice('long-term-cost: '.length))
  clientResolves(w, items[0].id, 'approve')
  const r2 = cw.finish()
  assert.equal(r2.status, 0, say(r2))
  assert.deepEqual(r2.json.merged, ['s'], say(r2))
  assert.equal(cw.merged(), true)
})

test('ltc guard: a solo crew adding a dependency is blocked at land', () => {
  const w = mkWorld({}, { 'package.json': PKG_BASE })
  const cw = crewWorld(w, { process: 'solo', files: { 'package.json': PKG_WITH_DEP } })
  const id = assertBlocked(cw, cw.land())
  blockedThenApproved(w, cw, id)
})

test('ltc guard: a solo crew adding a migration is blocked at land', () => {
  const w = mkWorld()
  const cw = crewWorld(w, { process: 'solo', files: { 'db/migrations/001_add_users.js': 'export const up = () => {}\n' } })
  const id = assertBlocked(cw, cw.land())
  blockedThenApproved(w, cw, id)
})

test('ltc guard: a cheap line only logs', () => {
  const w = mkWorld()
  const pw = planWrite(w, 'wf_ltcplan4-aaa', designerResult([CHEAP]))
  assert.equal(pw.status, 0, say(pw))
  assert.deepEqual(pw.json.longTermCosts, [], say(pw))
  assert.equal(ltcItems(w).length, 0, 'a cheap line opens no inbox item')
  assert.match(decisionsOf(w), /a renamed internal helper/, 'a cheap line is logged in decisions.md')
  const r = cli(w, 'approve', ['--by', 'client'])
  assert.equal(r.status, 0, `a cheap line never blocks approve: ${say(r)}`)
})

test('ltc guard: a line with no valid reversal counts as costly', () => {
  assert.deepEqual(ltcLines('LONG-TERM-COST: a | later: b | reversal: maybe'), [{ what: 'a', later: 'b', reversal: 'costly' }])
  assert.deepEqual(ltcLines('LONG-TERM-COST: a | later: b'), [{ what: 'a', later: 'b', reversal: 'costly' }])
  assert.deepEqual(ltcLines('notes\n  - LONG-TERM-COST: c | later: d | reversal: cheap\nLONG-TERM-COST: e | later: f | reversal: irreversible\nnot LONG-TERM-COST: g | later: h | reversal: cheap'), [
    { what: 'c', later: 'd', reversal: 'cheap' },
    { what: 'e', later: 'f', reversal: 'irreversible' },
  ])
  // and the gate treats it so: plan-write escalates a line whose reversal is not one of the three words
  const w = mkWorld()
  const pw = planWrite(w, 'wf_ltcplan5-aaa', designerResult(['LONG-TERM-COST: a new queue service | later: ops carry it | reversal: unsure']))
  assert.equal(pw.status, 0, say(pw))
  assert.equal(pw.json.longTermCosts.length, 1, say(pw))
  assert.equal(cli(w, 'approve', ['--by', 'client']).status, 1)
})

test('ltc guard: a qc:false crew adding a dependency is blocked at land', () => {
  const w = mkWorld({}, { 'package.json': PKG_BASE })
  const cw = crewWorld(w, { process: 'lean', qc: false, files: { 'package.json': PKG_WITH_DEP } })
  const id = assertBlocked(cw, cw.land())
  blockedThenApproved(w, cw, id)
})

test('ltc guard: a qc:false crew adding a new *.sql file is blocked at land', () => {
  const w = mkWorld()
  const cw = crewWorld(w, { process: 'lean', qc: false, files: { 'queries/report.sql': 'select 1;\n' } })
  const id = assertBlocked(cw, cw.land())
  blockedThenApproved(w, cw, id)
})

test('ltc guard: a qc:false crew adding a new *.schema.json file is blocked at land', () => {
  const w = mkWorld()
  const cw = crewWorld(w, { process: 'lean', qc: false, files: { 'docs/thing.schema.json': '{"type":"object"}\n' } })
  const id = assertBlocked(cw, cw.land())
  blockedThenApproved(w, cw, id)
})

test('ltc guard: a qc:false crew adding a new schema.* file is blocked at land', () => {
  const w = mkWorld()
  const cw = crewWorld(w, { process: 'lean', qc: false, files: { 'src/model/schema.prisma': 'model A { id Int }\n' } })
  const id = assertBlocked(cw, cw.land())
  blockedThenApproved(w, cw, id)
})

test('ltc guard: a repeat gate call opens no second inbox item', () => {
  const w = mkWorld({}, { 'package.json': PKG_BASE })
  const cw = crewWorld(w, { process: 'solo', files: { 'package.json': PKG_WITH_DEP } })
  const id = assertBlocked(cw, cw.land())
  const again = assertBlocked(cw, cw.land())
  assert.equal(again, id, 'the second land names the same item')
  const items = ltcItems(w)
  assert.equal(items.length, 1, `one item after two gate calls: ${JSON.stringify(items)}`)
  assert.equal(items[0].id, id)
  const notified = codeOf(w, id)
  assert.match(notified, /^[A-Z2-9]{6}$/, 'the one open sent one notify holding the code')
})

test('ltc guard: a cheap QC line does not block', () => {
  const w = mkWorld()
  const cw = crewWorld(w, { process: 'lean', qc: true, qcLines: [`- ${CHEAP}`] })
  const r = cw.land()
  assert.equal(r.status, 0, say(r))
  assert.equal(r.json.merged, true, say(r))
  assert.equal(cw.merged(), true)
  assert.equal(ltcItems(w).length, 0, 'a cheap QC line opens no inbox item')
})

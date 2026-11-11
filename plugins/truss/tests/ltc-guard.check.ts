// @ts-nocheck
// truss 0.25.0 wave 2, A2: the long-term cost guard (contract-025 section 3, ADR-0034), written from the contract before bin/guard.ts is built.
// Every gate runs through the real factory CLI as child processes: plan-write, approve, resolve, land and finish. A costly item is opened by the
// factory, its code reaches the client only through the notify recorder, and the client resolves it with a typed '/truss:inbox approve <id> <code>'
// line in the fixture main transcript. ltcLines is called directly for the reversal case.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ltcLines } from '../bin/guard.ts'
import { CHEAP, COSTLY, ID_RE, assertOneLine, clientResolves, cli, codeOf, crewWorld, decisionsOf, designerResult, ltcItems, mkWorld, planWrite, say } from './fixtures/ltc/harness.ts'
import { clientTypes, crew, git, mk, planObj } from './fixtures/ltc/harness.ts'
import { writePlan } from './fixtures/workflow-run/harness.ts'
import { commitMessages, eventLines, inboxOps, itemsOf, layBudgetCrew, ledgerRows, mkE2eWorld, originRefs, refNames, runUnattendedFlow, textsUnder } from './fixtures/ltc/e2e.ts'
import { existsSync, readFileSync } from 'node:fs'

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

// ltcLinesOf of workflows/stage.js, loaded from its source so the two line regexes cannot drift apart
const stageLtcLinesOf = new Function(`${/^const ltcLinesOf = .*$/m.exec(readFileSync(new URL('../workflows/stage.js', import.meta.url), 'utf8'))[0]}\nreturn ltcLinesOf`)()

const FORMS = [
  'LONG-TERM-COST: x | later: l | reversal: costly',
  '- LONG-TERM-COST: x | later: l | reversal: costly',
  '* LONG-TERM-COST: x | later: l | reversal: costly',
  '+ LONG-TERM-COST: x | later: l | reversal: costly',
  '1. LONG-TERM-COST: x | later: l | reversal: costly',
  '2) LONG-TERM-COST: x | later: l | reversal: costly',
  '> LONG-TERM-COST: x | later: l | reversal: costly',
  '   \t LONG-TERM-COST: x | later: l | reversal: costly',
  '**LONG-TERM-COST:** x | later: l | reversal: costly',
  '- **LONG-TERM-COST**: x | later: l | reversal: costly',
  '`LONG-TERM-COST: x | later: l | reversal: costly`',
  'LONG-TERM-COST: x | later: l | reversal: costly\r',
]
const COSTLY_X = [{ what: 'x', later: 'l', reversal: 'costly' }]

test('ltc guard: a LONG-TERM-COST line is read in each markdown form', () => {
  for (const f of FORMS) {
    assert.deepEqual(ltcLines(f), COSTLY_X, JSON.stringify(f))
    assert.equal(stageLtcLinesOf(f).length, 1, `stage.js: ${JSON.stringify(f)}`)
  }
  assert.deepEqual(ltcLines('intro\r\n- **LONG-TERM-COST**: x | later: l | reversal: costly\r\n'), COSTLY_X)
  assert.equal(stageLtcLinesOf('intro\r\n> LONG-TERM-COST: x\r\n').length, 1)
})

test('ltc guard: lines that only mention the marker are not read', () => {
  for (const f of [
    'Long-term cost: when the change adds a cost, write one line',
    '> Long-term cost:',
    'see `LONG-TERM-COST: <what>` for the format',
    'No LONG-TERM-COST: here',
    'long-term-cost: x | later: l | reversal: costly',
  ]) {
    assert.deepEqual(ltcLines(f), [], JSON.stringify(f))
    assert.deepEqual(stageLtcLinesOf(f), [], `stage.js: ${JSON.stringify(f)}`)
  }
})

test('ltc guard: a none-word line is no cost, an empty what with other fields still is', () => {
  for (const f of ['LONG-TERM-COST: none', 'LONG-TERM-COST: None', '- **LONG-TERM-COST:** N/A', 'LONG-TERM-COST: -', '**LONG-TERM-COST:** **none**', '`LONG-TERM-COST: none`']) {
    assert.deepEqual(ltcLines(f), [], JSON.stringify(f))
    assert.deepEqual(stageLtcLinesOf(f), [], `stage.js: ${JSON.stringify(f)}`)
  }
  assert.deepEqual(ltcLines('LONG-TERM-COST: | later: l | reversal: costly'), [{ what: '(unnamed cost)', later: 'l', reversal: 'costly' }])
  assert.deepEqual(ltcLines('LONG-TERM-COST: none of the existing tables | later: l'), [{ what: 'none of the existing tables', later: 'l', reversal: 'costly' }])
})

test('ltc guard: a bare LONG-TERM-COST line is kept and blocks (814f9f9, fail closed)', () => {
  for (const f of ['LONG-TERM-COST:', '**LONG-TERM-COST:**', '- LONG-TERM-COST:   ']) {
    assert.deepEqual(ltcLines(f), [{ what: '(unnamed cost)', later: '', reversal: 'costly' }], JSON.stringify(f))
    assert.equal(stageLtcLinesOf(f).length, 1, `stage.js: ${JSON.stringify(f)}`)
  }
  const w = mkWorld()
  const pw = planWrite(w, 'wf_ltcplan6-aaa', designerResult(['LONG-TERM-COST:']))
  assert.equal(pw.status, 0, say(pw))
  assert.equal(pw.json.longTermCosts.length, 1, say(pw))
  assert.equal(cli(w, 'approve', ['--by', 'client']).status, 1)
})

test('ltc guard: a qc:false crew adding Data/Migrations/x.cs is blocked at land', () => {
  const w = mkWorld()
  const cw = crewWorld(w, { process: 'lean', qc: false, files: { 'Data/Migrations/x.cs': 'class X {}\n' } })
  const id = assertBlocked(cw, cw.land())
  blockedThenApproved(w, cw, id)
})

test('ltc guard: a qc:false crew adding schema.SQL is blocked at land', () => {
  const w = mkWorld()
  const cw = crewWorld(w, { process: 'lean', qc: false, files: { 'db/schema.SQL': 'select 1;\n' } })
  const id = assertBlocked(cw, cw.land())
  blockedThenApproved(w, cw, id)
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

test('ltc guard: a qc:false crew renaming an existing *.sql file is blocked at land', () => {
  const sql = 'select a, b, c from t where a = 1;\nselect d, e, f from u where d = 2;\n'
  const w = mkWorld({}, { 'queries/old.sql': sql })
  const cw = crewWorld(w, { process: 'lean', qc: false })
  git(cw.wt, ['mv', 'queries/old.sql', 'queries/new.sql'])
  git(cw.wt, ['commit', '-m', 'rename old.sql'])
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

// ---- Round 4: end to end, real factory processes in a temp git repo with a bare origin (contract-025 sections 4, 6, 7) ----

/** The flow's end state, the facts both the end-of-run case and the hostile-title case rest on. */
function assertFlowLanded(w: any, f: any): void {
  assert.equal(git(w.repo, ['merge-base', '--is-ancestor', f.crewHead, 'refs/heads/main']) === '', true)
  assert.equal(git(w.repo, ['show', 'refs/heads/main:src/' + f.slug + '/retry.ts']), 'export const retries = 3', 'the crew work is on local main')
  assert.equal(f.pushPr.length, 1, `exactly one push-pr item: ${JSON.stringify(f.pushPr)}`)
  assert.equal(f.pushPr[0].state, 'open')
  assert.equal(f.originAfter, f.originBefore, 'nothing was pushed: the origin refs are byte-equal')
  assert.equal(ledgerRows(w).length, 1, `one ledger row: ${JSON.stringify(ledgerRows(w))}`)
}

test('e2e 025: a crew priced at 5.20 against crewUsd 5 opens exactly one budget inbox item, a repeat admit opens no second, and a client resolve with raise-usd 3 lets the next admit pass', () => {
  const w = mkE2eWorld({ budget: { crewUsd: 5 } })
  writePlan(w.dir, planObj([crew('bcrew')]))
  layBudgetCrew(w)
  const first = cli(w, 'admit', ['--slug', 'bcrew'])
  assert.equal(first.status, 1, say(first))
  assert.equal(first.json.admitted, false, say(first))
  assert.equal(first.json.budget, true, say(first))
  assert.ok(String(first.json.why).startsWith('budget:'), say(first))
  const items = itemsOf(w, 'budget')
  assert.equal(items.length, 1, `exactly one budget item: ${JSON.stringify(items)}`)
  assert.equal(items[0].state, 'open')
  assert.equal(items[0].blocking, true)
  const id = items[0].id
  const second = cli(w, 'admit', ['--slug', 'bcrew'])
  assert.equal(second.status, 1, say(second))
  assert.equal(second.json.admitted, false, say(second))
  assert.equal(itemsOf(w, 'budget').length, 1, 'a repeat admit opens no second item')
  assert.equal(inboxOps(w).filter((o) => o.op === 'open' && o.kind === 'budget').length, 1, 'one open op in the inbox file')
  // the client types the approval in this session, then resolves with a raise of 3 (limit 5 + 3 = 8 against 5.2 spent)
  const code = clientTypes(w, id, 'approve', 'raise 3')
  const res = cli(w, 'resolve', [id, '--decision', 'approve', '--by', 'client', '--code', code, '--raise-usd', '3'])
  assert.equal(res.status, 0, say(res))
  const third = cli(w, 'admit', ['--slug', 'bcrew'])
  assert.equal(third.status, 0, say(third))
  assert.equal(third.json.admitted, true, say(third))
  assert.equal(itemsOf(w, 'budget').length, 1, 'still the one item, now resolved')
  assert.equal(itemsOf(w, 'budget')[0].state, 'resolved')
})

test('e2e 025: an unattended next run claims through queue-next, approves by auto, finishes and lands locally, opens exactly one push-pr item and leaves the bare origin refs unchanged', () => {
  const w = mkE2eWorld({}, { 'docs/queue.md': '- [ ] add a retry to the uploader\n' })
  const f = runUnattendedFlow(w)
  assertFlowLanded(w, f)
  assert.equal(readFileSync(`${w.shared}/queue/items/${f.id}.json`, 'utf8').includes('"state": "done"'), true, 'the queue item is done')
  assert.equal(existsSync(`${w.dir}/unattended.json`), false, 'unattended is off')
  const row = ledgerRows(w)[0]
  assert.equal(row.crew, f.slug)
  assert.equal(row.workType, 'docs')
  assert.equal(row.head, git(w.repo, ['rev-parse', 'refs/heads/main']))
  assert.equal(originRefs(w), f.originBefore)
})

test('e2e 025: a hostile queue title reaches no branch name, commit message, ledger row or events line, and its dollar subshell never runs', () => {
  const marker = `${mk('ltc-marker-')}/pwned.marker`
  const title = `fix \`rm -rf ~\` $(touch ${marker}) --force`
  const w = mkE2eWorld({}, { 'docs/queue.md': `- [ ] ${title}\n  second line \`$(touch ${marker})\` --force\n` })
  const f = runUnattendedFlow(w)
  assertFlowLanded(w, f)
  const fragments = ['rm -rf', '$(', '`', 'touch', '--force', marker, 'pwned']
  const clean = (what: string, text: string): void => {
    for (const x of fragments) assert.ok(!text.includes(x), `${what} holds the title fragment ${JSON.stringify(x)}`)
  }
  clean('a branch name (before land)', f.branchesBeforeLand.join('\n'))
  clean('a branch name (after land)', f.branches.join('\n'))
  clean('a ref name', refNames(w))
  clean('a commit message', commitMessages(w))
  clean('the ledger row', JSON.stringify(ledgerRows(w)))
  clean('an events.jsonl line', eventLines(w).join('\n'))
  assert.ok(eventLines(w).length > 0, 'the session logged events')
  for (const [p, text] of Object.entries(textsUnder(w.dir, ['.json', '.md', '.jsonl']))) {
    if (p.endsWith('/unattended.json')) continue
    clean(`the session file ${p.slice(w.dir.length)}`, text)
  }
  clean('the push-pr inbox item', JSON.stringify(itemsOf(w, 'push-pr')))
  assert.equal(existsSync(marker), false, 'the subshell never ran')
})

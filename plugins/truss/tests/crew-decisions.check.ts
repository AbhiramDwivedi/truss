// @ts-nocheck
// truss ADR-0033, crew product calls reach the main session as they happen. Written from the contract before the change.
//   factory crew-decision --crew <slug> --task <id> --question <q> --answer <a> --by <who>   -> {id}; decisions.md line + crew-decision event
//   factory decision-reply <id> ack|change [--note <text>]                                   -> decision-reply event; change needs --note
//   factory decision-replies --crew <slug>                                                    -> [{id, reply, note}] not yet consumed, then consumed
//   factory decisions [--open] [--crew <slug>]                                                -> {decisions: [...]} with reply status
// Run with: node --test tests/crew-decisions.check.ts

import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { addCrewWorktree, crew, git, mkEnv, planObj, putFile, readEvents, assertUsageError, validateEvent, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')
const t = (name, fn) => test(name, { timeout: 60000 }, fn)

const decide = (env, over = {}) =>
  env.run('crew-decision', { crew: 'api', task: 'build-api', question: 'Show totals in cents?', answer: 'No, dollars', by: 'api-builder', ...over })
const reply = (env, id, verdict, extra = []) => env.run('decision-reply', {}, [id, verdict, ...extra])

t('cd 1: crew-decision appends the decide line, writes a crew-decision event and prints {id}', () => {
  const env = mkEnv({ useRealPlugin: true })
  const r = decide(env)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.deepEqual(Object.keys(r.json), ['id'])
  assert.match(r.json.id, /^d-api-\d+$/)
  const lines = readFileSync(`${env.dir}/decisions.md`, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^- \d\d:\d\d \| PO crew api: Show totals in cents\? \| No, dollars \| api-builder \| decided$/)
  const ev = readEvents(env.dir).filter((e) => e.event === 'crew-decision')
  assert.equal(ev.length, 1)
  assert.deepEqual({ ...ev[0], v: undefined, ts: undefined }, { v: undefined, ts: undefined, event: 'crew-decision', id: r.json.id, crew: 'api', task: 'build-api', question: 'Show totals in cents?', answer: 'No, dollars', by: 'api-builder' })
})

t('cd 2: ids are unique within the run, per crew counted; a | or newline in a field cannot split the decide line', () => {
  const env = mkEnv({ useRealPlugin: true })
  const a = decide(env).json.id
  const b = decide(env).json.id
  const c = decide(env, { crew: 'web', question: 'a | b\nc' }).json.id
  assert.deepEqual([a, b, c], ['d-api-1', 'd-api-2', 'd-web-1'])
  const last = readFileSync(`${env.dir}/decisions.md`, 'utf8').trim().split('\n').pop()
  assert.equal(last.split(' | ').length, 5, last)
})

t('cd 3: crew-decision refuses a missing field, an empty value and a bad crew slug, and writes nothing', () => {
  const env = mkEnv({ useRealPlugin: true })
  for (const over of [{ crew: null }, { task: null }, { question: null }, { answer: null }, { by: null }, { question: '   ' }, { crew: 'Not A Slug' }]) assertUsageError(decide(env, over))
  assert.equal(readFileSync(`${env.dir}/decisions.md`, 'utf8'), '')
  assert.equal(readEvents(env.dir).length, 0)
})

t('cd 4: decision-reply ack/change writes a decision-reply event; change needs --note; an unknown id and a bad verdict fail', () => {
  const env = mkEnv({ useRealPlugin: true })
  const id = decide(env).json.id
  const ack = reply(env, id, 'ack')
  assert.equal(ack.status, 0, ack.stderr + ack.stdout)
  assert.equal(ack.json.id, id)
  assert.equal(ack.json.reply, 'ack')
  const ev = readEvents(env.dir).filter((e) => e.event === 'decision-reply')
  assert.equal(ev.length, 1)
  assert.deepEqual({ id: ev[0].id, crew: ev[0].crew, reply: ev[0].reply, note: ev[0].note }, { id, crew: 'api', reply: 'ack', note: null })
  const id2 = decide(env).json.id
  assertUsageError(reply(env, id2, 'change'))
  assertUsageError(reply(env, id2, 'change', ['--note', '  ']))
  assertUsageError(reply(env, 'd-api-99', 'ack'))
  assertUsageError(reply(env, id2, 'maybe'))
  const ch = reply(env, id2, 'change', ['--note', 'use cents after all'])
  assert.equal(ch.status, 0, ch.stderr + ch.stdout)
  assert.equal(readEvents(env.dir).filter((e) => e.event === 'decision-reply').pop().note, 'use cents after all')
})

t('cd 5: decision-replies lists a crew\'s unacked replies, marks nothing consumed, and leaves another crew\'s replies alone (review 4)', () => {
  const env = mkEnv({ useRealPlugin: true })
  const a = decide(env).json.id
  const b = decide(env).json.id
  const w = decide(env, { crew: 'web' }).json.id
  assert.deepEqual(env.run('decision-replies', { crew: 'api' }).json, [], 'no reply yet')
  reply(env, a, 'ack')
  reply(env, b, 'change', ['--note', 'cents'])
  reply(env, w, 'ack')
  const first = env.run('decision-replies', { crew: 'api' })
  assert.equal(first.status, 0, first.stderr)
  assert.deepEqual(first.json, [{ id: a, reply: 'ack', note: null }, { id: b, reply: 'change', note: 'cents' }])
  assert.deepEqual(env.run('decision-replies', { crew: 'api' }).json, first.json, 'reading twice gives the same list: a garbled runner result loses nothing')
  assert.deepEqual(env.run('decision-replies', { crew: 'web' }).json, [{ id: w, reply: 'ack', note: null }])
})

t('cd 5b: decision-ack marks the given replies consumed, once: {acked, already}; decision-replies then leaves them out', () => {
  const env = mkEnv({ useRealPlugin: true })
  const a = decide(env).json.id
  const b = decide(env).json.id
  reply(env, a, 'ack')
  reply(env, b, 'change', ['--note', 'cents'])
  const ack = env.run('decision-ack', { crew: 'api', ids: `${a}` })
  assert.equal(ack.status, 0, ack.stderr + ack.stdout)
  assert.deepEqual(ack.json, { acked: [a], already: [] })
  assert.deepEqual(env.run('decision-replies', { crew: 'api' }).json, [{ id: b, reply: 'change', note: 'cents' }])
  const again = env.run('decision-ack', { crew: 'api', ids: `${a},${b}` })
  assert.deepEqual(again.json, { acked: [b], already: [a] })
  assert.deepEqual(env.run('decision-replies', { crew: 'api' }).json, [])
  const ev = readEvents(env.dir).filter((e) => e.event === 'decision-ack')
  assert.deepEqual(ev.map((e) => e.ids), [[a], [b]])
  for (const e of ev) assert.deepEqual(validateEvent(e), [], JSON.stringify(e))
})

t('cd 5c: decision-ack refuses an id of another crew, an id with no reply, an unknown id and an empty list, and acks nothing', () => {
  const env = mkEnv({ useRealPlugin: true })
  const a = decide(env).json.id
  const w = decide(env, { crew: 'web' }).json.id
  const noReply = decide(env).json.id
  reply(env, a, 'ack')
  reply(env, w, 'ack')
  for (const ids of [`${a},${w}`, `${a},${noReply}`, `${a},d-api-99`, '', ' , ']) assertUsageError(env.run('decision-ack', { crew: 'api', ids }))
  assert.deepEqual(env.run('decision-replies', { crew: 'api' }).json.map((r) => r.id), [a], 'nothing was acked by the refused calls')
  assertUsageError(env.run('decision-ack', { crew: 'api' }))
})

t('cd 6: parallel decision-ack calls for the same replies ack each id exactly once (exclusive create)', async () => {
  const env = mkEnv({ useRealPlugin: true })
  const ids = []
  for (let i = 0; i < 6; i++) {
    const id = decide(env, { question: `q${i}` }).json.id
    ids.push(id)
    reply(env, id, 'ack')
  }
  const callOnce = () => new Promise((ok) => {
    const p = spawn(process.execPath, [env.factory, 'decision-ack', '--crew', 'api', '--ids', ids.join(','), '--dir', env.dir, '--repo', env.repo], { cwd: env.repo })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('close', () => ok(JSON.parse(out)))
  })
  const rounds = await Promise.all([1, 2, 3, 4].map(callOnce))
  const acked = rounds.flatMap((r) => r.acked)
  assert.deepEqual(acked.slice().sort(), ids.slice().sort(), 'each id was acked by exactly one call')
  for (const r of rounds) assert.equal(r.acked.length + r.already.length, ids.length)
})

t('cd 7: ids stay unique when many crew-decisions for one crew run at once', async () => {
  const env = mkEnv({ useRealPlugin: true })
  const one = (i) => new Promise((ok) => {
    const p = spawn(process.execPath, [env.factory, 'crew-decision', '--crew', 'api', '--task', 't', '--question', `q${i}`, '--answer', 'a', '--by', 'x', '--dir', env.dir, '--repo', env.repo], { cwd: env.repo })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('close', () => ok(JSON.parse(out).id))
  })
  const ids = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(one))
  assert.equal(new Set(ids).size, 8, ids.join(','))
})

t('cd 8: decisions lists every crew decision with its reply status; --open keeps the ones with no reply; --crew filters', () => {
  const env = mkEnv({ useRealPlugin: true })
  assert.deepEqual(env.run('decisions').json, { decisions: [] })
  const a = decide(env).json.id
  const b = decide(env, { question: 'Second?' }).json.id
  const w = decide(env, { crew: 'web' }).json.id
  reply(env, a, 'ack')
  env.run('decision-ack', { crew: 'api', ids: a })
  const all = env.run('decisions')
  assert.equal(all.status, 0, all.stderr)
  assert.deepEqual(all.json.decisions.map((d) => [d.id, d.reply]), [[a, 'ack'], [b, null], [w, null]])
  const first = all.json.decisions[0]
  assert.deepEqual({ crew: first.crew, task: first.task, question: first.question, answer: first.answer, by: first.by, note: first.note, consumed: first.consumed }, { crew: 'api', task: 'build-api', question: 'Show totals in cents?', answer: 'No, dollars', by: 'api-builder', note: null, consumed: true })
  assert.deepEqual(env.run('decisions', { open: true }).json.decisions.map((d) => d.id), [b, w])
  assert.deepEqual(env.run('decisions', { open: true, crew: 'web' }).json.decisions.map((d) => d.id), [w])
})

t('cd 9: help text says crew lead and main session, never the old crew-lead name or PM', () => {
  const src = readFileSync(`${PLUGIN}/bin/factory.ts`, 'utf8')
  const from = src.indexOf('// ==== crew decisions ====')
  assert.ok(from > 0, 'a crew decisions section')
  const section = src.slice(from, src.indexOf('// ==== main ====', from))
  // the old crew-lead name is built from pieces so this file never holds it
  assert.doesNotMatch(section, new RegExp('fore' + '(man|men)|\\bPM\\b', 'i'))
})

// ---------------------------------------------------------------- fix round 2: review findings 4, 10, 11 and the new commands

const cdir = (env) => `${env.dir}/crew-decisions`

t('cd 10: decision-reply writes with an exclusive create: a second reply is refused, and two at once leave exactly one (review 4)', async () => {
  const env = mkEnv({ useRealPlugin: true })
  const id = decide(env).json.id
  assert.equal(reply(env, id, 'ack').status, 0)
  const second = reply(env, id, 'change', ['--note', 'cents'])
  assertUsageError(second)
  assert.equal(JSON.parse(readFileSync(`${cdir(env)}/${id}.reply.json`, 'utf8')).reply, 'ack', 'the first reply stands')
  const id2 = decide(env).json.id
  const one = (verdict, note) => new Promise((ok) => {
    const p = spawn(process.execPath, [env.factory, 'decision-reply', id2, verdict, '--note', note, '--dir', env.dir, '--repo', env.repo], { cwd: env.repo })
    p.on('close', (code) => ok(code))
  })
  const codes = await Promise.all([one('ack', 'x'), one('change', 'y'), one('ack', 'z'), one('change', 'w')])
  assert.equal(codes.filter((c) => c === 0).length, 1, `exactly one reply wins: ${codes}`)
  assert.equal(readEvents(env.dir).filter((e) => e.event === 'decision-reply' && e.id === id2).length, 1)
})

t('cd 11: every flag takes the --flag=value form, so a value that starts with -- is safe (review 11)', () => {
  const env = mkEnv({ useRealPlugin: true })
  const r = env.run('crew-decision', { crew: 'api', task: 'build-api', by: 'api-builder' }, ['--question=--cents or dollars?', '--answer=--dollars'])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const d = env.run('decisions').json.decisions[0]
  assert.equal(d.question, '--cents or dollars?')
  assert.equal(d.answer, '--dollars')
  const rp = env.run('decision-reply', {}, [r.json.id, 'change', '--note=--use cents'])
  assert.equal(rp.status, 0, rp.stderr + rp.stdout)
  assert.equal(env.run('decision-replies', { crew: 'api' }).json[0].note, '--use cents')
  const named = env.run('decision-reply', {}, [`--id=${decide(env).json.id}`, '--reply=ack'])
  assert.equal(named.status, 0, named.stderr + named.stdout)
  const eq = env.run('decisions', {}, ['--crew=api'])
  assert.equal(eq.json.decisions.length, 2)
})

t('cd 12: decisions gains crewStatus (the plan status, unknown with no plan); --open leaves out a crew past its checkpoint', () => {
  const env = mkEnv({ useRealPlugin: true })
  const a = decide(env).json.id
  const w = decide(env, { crew: 'web' }).json.id
  assert.deepEqual(env.run('decisions').json.decisions.map((d) => d.crewStatus), ['unknown', 'unknown'])
  writePlan(env.dir, planObj([crew('api', { status: 'running' }), crew('web', { status: 'running' })]))
  assert.deepEqual(env.run('decisions').json.decisions.map((d) => d.crewStatus), ['running', 'running'])
  assert.deepEqual(env.run('decisions', { open: true }).json.decisions.map((d) => d.id), [a, w])
  const cp = env.run('decision-checkpoint', { crew: 'api' })
  assert.equal(cp.status, 0, cp.stderr + cp.stdout)
  assert.deepEqual(cp.json, { crew: 'api', checkpoint: true })
  assert.deepEqual(env.run('decisions', { open: true }).json.decisions.map((d) => d.id), [w], 'api passed its checkpoint, so a Monitor on --open goes quiet for it')
  assert.deepEqual(env.run('decisions').json.decisions.map((d) => d.id), [a, w], 'the plain list keeps every decision')
  assert.deepEqual(env.run('decision-checkpoint', { crew: 'api' }).json, { crew: 'api', checkpoint: true }, 'calling it again is fine')
  assertUsageError(env.run('decision-checkpoint', { crew: 'Not A Slug' }))
  assertUsageError(env.run('decision-checkpoint'))
})

t('cd 13: a merged crew is out of --open and has crewStatus merged; a crew finish marked finished or stopped is too', () => {
  const env = mkEnv({ useRealPlugin: true })
  const a = decide(env).json.id
  const w = decide(env, { crew: 'web' }).json.id
  const s = decide(env, { crew: 'ui' }).json.id
  writePlan(env.dir, planObj([crew('api', { status: 'merged' }), crew('web', { status: 'running' }), crew('ui', { status: 'running' })]))
  const by = Object.fromEntries(env.run('decisions').json.decisions.map((d) => [d.id, d.crewStatus]))
  assert.deepEqual(by, { [a]: 'merged', [w]: 'running', [s]: 'running' })
  assert.deepEqual(env.run('decisions', { open: true }).json.decisions.map((d) => d.id), [w, s])
  mkdirSync(`${env.dir}/crews/web`, { recursive: true })
  writeFileSync(`${env.dir}/crews/web/state.json`, JSON.stringify({ state: 'finished' }))
  mkdirSync(`${env.dir}/crews/ui`, { recursive: true })
  writeFileSync(`${env.dir}/crews/ui/state.json`, JSON.stringify({ state: 'stopped' }))
  const by2 = Object.fromEntries(env.run('decisions').json.decisions.map((d) => [d.id, d.crewStatus]))
  assert.deepEqual(by2, { [a]: 'merged', [w]: 'finished', [s]: 'stopped' })
  assert.deepEqual(env.run('decisions', { open: true }).json.decisions.map((d) => d.id), [s], 'a stopped crew with no checkpoint can resume, so its call stays open')
})

t('cd 14: decision-reply to a crew past its checkpoint (or finished, merged, dropped) adds crewPastCheckpoint and a hint; before, neither key', () => {
  const env = mkEnv({ useRealPlugin: true })
  const a = decide(env).json.id
  const before = reply(env, a, 'ack')
  assert.deepEqual(before.json, { id: a, reply: 'ack' })
  const b = decide(env).json.id
  env.run('decision-checkpoint', { crew: 'api' })
  const late = reply(env, b, 'change', ['--note', 'cents'])
  assert.equal(late.status, 0, late.stderr + late.stdout)
  assert.equal(late.json.id, b)
  assert.equal(late.json.reply, 'change')
  assert.equal(late.json.crewPastCheckpoint, true)
  assert.match(late.json.hint, /fix at merge/)
  assert.equal(JSON.parse(readFileSync(`${cdir(env)}/${b}.reply.json`, 'utf8')).reply, 'change', 'the reply is still recorded')
  writePlan(env.dir, planObj([crew('web', { status: 'merged' })]))
  const w = decide(env, { crew: 'web' }).json.id
  const merged = reply(env, w, 'ack')
  assert.equal(merged.json.crewPastCheckpoint, true)
  assert.match(merged.json.hint, /fix at merge/)
})

t('cd 14b: a stopped crew with no checkpoint is not past it (a resume still applies replies); with a checkpoint it is', () => {
  const env = mkEnv({ useRealPlugin: true })
  const a = decide(env, { crew: 'api' }).json.id
  const w = decide(env, { crew: 'web' }).json.id
  mkdirSync(`${env.dir}/crews/api`, { recursive: true })
  writeFileSync(`${env.dir}/crews/api/state.json`, JSON.stringify({ state: 'stopped' }))
  mkdirSync(`${env.dir}/crews/web`, { recursive: true })
  writeFileSync(`${env.dir}/crews/web/state.json`, JSON.stringify({ state: 'stopped' }))
  assert.deepEqual(env.run('decisions', { open: true }).json.decisions.map((d) => d.id), [a, w])
  const early = reply(env, a, 'ack')
  assert.equal(early.json.crewPastCheckpoint, undefined)
  env.run('decision-checkpoint', { crew: 'web' })
  assert.deepEqual(env.run('decisions', { open: true }).json.decisions.map((d) => d.id), [], 'api has its reply, web is past its checkpoint')
  const late = reply(env, w, 'ack')
  assert.equal(late.json.crewPastCheckpoint, true)
})

t('cd 15: knowledge-commit records the crew\'s knowledge commit sha and a knowledge-commit event; a bad or unknown sha is refused', () => {
  const env = mkEnv({ useRealPlugin: true })
  const sha = git(env.repo, ['rev-parse', 'HEAD'])
  const r = env.run('knowledge-commit', { slug: 'api', sha })
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.deepEqual(r.json, { slug: 'api', sha })
  const ev = readEvents(env.dir).filter((e) => e.event === 'knowledge-commit')
  assert.deepEqual(ev.map((e) => [e.crew, e.sha]), [['api', sha]])
  assert.deepEqual(validateEvent(ev[0]), [], JSON.stringify(ev[0]))
  assert.equal(JSON.parse(readFileSync(`${env.dir}/crews/api/knowledge-commit.json`, 'utf8')).shas[0], sha)
  assert.deepEqual(env.run('knowledge-commit', { slug: 'api', sha }).json, { slug: 'api', sha }, 'recording it again is fine')
  for (const bad of ['', 'xyz', '0'.repeat(40), '--no']) assertUsageError(env.run('knowledge-commit', { slug: 'api', sha: bad }))
  assertUsageError(env.run('knowledge-commit', { slug: 'Not A Slug', sha }))
  assertUsageError(env.run('knowledge-commit', { slug: 'api' }))
})

t('cd 15b (review 3): decisions --crew carries a top-level checkpoint, true once the crew recorded its checkpoint; without --crew there is none', () => {
  const env = mkEnv({ useRealPlugin: true })
  assert.deepEqual(env.run('decisions', {}, ['--crew=api']).json, { decisions: [], checkpoint: false })
  assert.equal(env.run('decision-checkpoint', { crew: 'api' }).status, 0)
  assert.equal(env.run('decisions', {}, ['--crew=api']).json.checkpoint, true)
  assert.equal(env.run('decisions', {}, ['--crew=web']).json.checkpoint, false, 'per crew')
  assert.ok(!Object.hasOwn(env.run('decisions').json, 'checkpoint'))
})

t('cd 16: crew-learned appends the items of a member report to the crew\'s learned list; --add=<json> works; bad input appends nothing', () => {
  const env = mkEnv({ useRealPlugin: true })
  const one = { kind: 'feature', text: 'The export lives in src/export.ts', source: 'src/export.ts:1', target: 'docs/knowledge/export.md', task: 'build', member: 'api-builder' }
  const two = { kind: 'decision', text: '--dashes survive', source: '' }
  const r = env.run('crew-learned', { slug: 'api' }, [`--add=${JSON.stringify([one])}`])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.deepEqual(r.json, { slug: 'api', added: 1, total: 1 })
  const r2 = env.run('crew-learned', { slug: 'api', add: JSON.stringify([two]) })
  assert.deepEqual(r2.json, { slug: 'api', added: 1, total: 2 })
  const lines = readFileSync(`${env.dir}/crews/api/learned.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(lines, [one, two])
  for (const bad of ['not json', '{"kind":"feature"}', '[1]', '[{"kind":"feature"}]', '[{"text":"x"}]', '[]', '']) assertUsageError(env.run('crew-learned', { slug: 'api' }, [`--add=${bad}`]))
  assertUsageError(env.run('crew-learned', { slug: 'Not A Slug' }, [`--add=${JSON.stringify([one])}`]))
  assert.equal(readFileSync(`${env.dir}/crews/api/learned.jsonl`, 'utf8').trim().split('\n').length, 2, 'the refused calls appended nothing')
  assert.equal(readEvents(env.dir).filter((e) => e.event === 'crew-learned').length, 0, 'no event: the list is state, not a count')
})

t('cd 17: start --resume gives the crew entry learned: [...] from crew-learned, and the crew\'s decisions are readable by decisions --crew (review 2)', () => {
  const env = mkEnv({ config: { merge: 'sequential', target: 'main' } })
  writePlan(env.dir, planObj([crew('x', { status: 'running' })], { approvedAt: new Date(Date.now() - 4 * 3600_000).toISOString() }))
  writeGoal(env.dir, 'x', {})
  addCrewWorktree(env.repo, 'x')
  appendFileSync(`${env.dir}/events.jsonl`, JSON.stringify({ v: 1, ts: new Date(Date.now() - 3 * 3600_000).toISOString(), event: 'spawn', crew: 'x', agent: 'x', agentId: null, type: 'workflow-crew', model: null, effort: null, by: 'factory' }) + '\n')
  const fresh = env.run('start', { slug: 'x', resume: 'merge-ready' })
  assert.equal(fresh.status, 0, fresh.stderr + fresh.stdout)
  assert.deepEqual(fresh.json.truss.crews[0].learned, [], 'a resume with nothing stored carries an empty list')
  const item = { kind: 'feature', text: 'A fact', source: 'a.ts:1', task: 't1', member: 'x-builder' }
  assert.equal(env.run('crew-learned', { slug: 'x' }, [`--add=${JSON.stringify([item])}`]).status, 0)
  const again = env.run('start', { slug: 'x', resume: 'merge-ready' })
  assert.deepEqual(again.json.truss.crews[0].learned, [item])
})

const ROOT = resolve(PLUGIN, '..', '..')

t('qc-3 docs 1: the inbox knowledge "Hold wording" bullet says a pm-question hold reads awaiting program manager (holdStop), not awaiting client', () => {
  const bullet = readFileSync(`${ROOT}/docs/knowledge/inbox.md`, 'utf8').split('\n').find((l) => l.includes('Hold wording')) || ''
  assert.ok(bullet, 'bullet exists')
  assert.match(bullet, /awaiting program manager/)
  assert.match(bullet, /holdStop/)
  assert.doesNotMatch(bullet, /reads as a client wait/)
  assert.match(bullet, /a crew resumed while its fix-step pm-question is still open stops awaiting the program manager, not the client/)
})

t('qc-3 docs 2: run SKILL.md product-call paragraph lists PO: SCOPE-CHANGE, opens an inbox item, and leaves no scope question to the PM', () => {
  const para = readFileSync(`${PLUGIN}/skills/run/SKILL.md`, 'utf8').split('\n').find((l) => l.startsWith('A product question inside a crew')) || ''
  assert.ok(para, 'paragraph exists')
  assert.match(para, /PO: SCOPE-CHANGE/)
  assert.match(para, /pm-question/)
  assert.match(para, /scope-change/)
  assert.doesNotMatch(para, /Cross-crew and scope questions stay yours/)
  assert.doesNotMatch(para, /escalates to you \(a `QUESTION:`\) when the question is not a product question, is outside the crew's approved scope/)
})

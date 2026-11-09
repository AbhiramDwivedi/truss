// @ts-nocheck
// truss ADR-0033, crew product calls reach the main session as they happen. Written from the contract before the change.
//   factory crew-decision --crew <slug> --task <id> --question <q> --answer <a> --by <who>   -> {id}; decisions.md line + crew-decision event
//   factory decision-reply <id> ack|change [--note <text>]                                   -> decision-reply event; change needs --note
//   factory decision-replies --crew <slug>                                                    -> [{id, reply, note}] not yet consumed, then consumed
//   factory decisions [--open] [--crew <slug>]                                                -> {decisions: [...]} with reply status
// Run with: node --test tests/crew-decisions.check.ts

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { mkEnv, readEvents, assertUsageError } from './fixtures/workflow-run/harness.ts'

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

t('cd 5: decision-replies returns a crew\'s unconsumed replies once, with notes, and another crew\'s replies are left alone', () => {
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
  assert.deepEqual(env.run('decision-replies', { crew: 'api' }).json, [], 'consumed')
  assert.deepEqual(env.run('decision-replies', { crew: 'web' }).json, [{ id: w, reply: 'ack', note: null }])
})

t('cd 6: two crews call decision-replies at the same time and each gets exactly its own replies once', async () => {
  const env = mkEnv({ useRealPlugin: true })
  const ids = { api: [], web: [] }
  for (const crew of ['api', 'web']) for (let i = 0; i < 6; i++) {
    const id = decide(env, { crew, question: `q${i}` }).json.id
    ids[crew].push(id)
    reply(env, id, 'ack')
  }
  const callOnce = (crew) => new Promise((ok) => {
    const p = spawn(process.execPath, [env.factory, 'decision-replies', '--crew', crew, '--dir', env.dir, '--repo', env.repo], { cwd: env.repo })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('close', () => ok(JSON.parse(out)))
  })
  const rounds = await Promise.all(['api', 'web', 'api', 'web', 'api', 'web'].map(callOnce))
  const got = { api: [], web: [] }
  ;['api', 'web', 'api', 'web', 'api', 'web'].forEach((crew, i) => got[crew].push(...rounds[i].map((r) => r.id)))
  for (const crew of ['api', 'web']) assert.deepEqual(got[crew].sort(), ids[crew].slice().sort(), `${crew} got each of its replies exactly once`)
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
  env.run('decision-replies', { crew: 'api' })
  const all = env.run('decisions')
  assert.equal(all.status, 0, all.stderr)
  assert.deepEqual(all.json.decisions.map((d) => [d.id, d.reply]), [[a, 'ack'], [b, null], [w, null]])
  const first = all.json.decisions[0]
  assert.deepEqual({ crew: first.crew, task: first.task, question: first.question, answer: first.answer, by: first.by, note: first.note, consumed: first.consumed }, { crew: 'api', task: 'build-api', question: 'Show totals in cents?', answer: 'No, dollars', by: 'api-builder', note: null, consumed: true })
  assert.deepEqual(env.run('decisions', { open: true }).json.decisions.map((d) => d.id), [b, w])
  assert.deepEqual(env.run('decisions', { open: true, crew: 'web' }).json.decisions.map((d) => d.id), [w])
})

t('cd 9: help text says crew lead and main session, never foreman or PM', () => {
  const src = readFileSync(`${PLUGIN}/bin/factory.ts`, 'utf8')
  const from = src.indexOf('// ==== crew decisions ====')
  assert.ok(from > 0, 'a crew decisions section')
  const section = src.slice(from, src.indexOf('// ==== main ====', from))
  assert.doesNotMatch(section, /foreman|\bPM\b/)
})

// @ts-nocheck
// truss ADR-0033 review fix: docs/events.schema.json knows the crew-decision and decision-reply events factory.ts writes,
// and every older event still validates.
// Run with: node --test tests/events-schema-decisions.check.ts

import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { mkRepo, mkTrussDir, readEvents, runCli, validateEvent } from './fixtures/workflow-run/harness.ts'

const FACTORY = `${resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')}/bin/factory.ts`
const TS = '2026-11-09T10:00:00.000Z'
const t = (name, fn) => test(name, { timeout: 60000 }, fn)

const DECISION = { v: 1, ts: TS, event: 'crew-decision', id: 'd-a-1', crew: 'a', task: 'build-ui', question: 'Include archived items?', answer: 'Yes, flagged.', by: 'product-owner' }
const REPLY = { v: 1, ts: TS, event: 'decision-reply', id: 'd-a-1', crew: 'a', reply: 'change', note: 'Exclude them.' }

t('schema 1: a crew-decision line and a decision-reply line validate (reply ack with a null note too)', () => {
  assert.deepEqual(validateEvent(DECISION), [])
  assert.deepEqual(validateEvent(REPLY), [])
  assert.deepEqual(validateEvent({ ...REPLY, reply: 'ack', note: null }), [])
})

t('schema 2: a missing field, an extra field, a bad reply or a bad id is refused', () => {
  for (const k of ['id', 'crew', 'task', 'question', 'answer', 'by']) {
    const { [k]: _gone, ...rest } = DECISION
    assert.ok(validateEvent(rest).some((e) => e.includes(`required ${k}`)), `crew-decision without ${k}`)
  }
  assert.ok(validateEvent({ ...DECISION, extra: 1 }).some((e) => e.includes('additionalProperties extra')))
  assert.ok(validateEvent({ ...REPLY, reply: 'maybe' }).length > 0)
  assert.ok(validateEvent({ ...REPLY, note: 5 }).length > 0)
  assert.ok(validateEvent({ ...REPLY, id: 'x' }).length > 0)
  const { note: _n, ...noNote } = REPLY
  assert.ok(validateEvent(noNote).some((e) => e.includes('required note')))
})

t('schema 3: the lines factory.ts really writes for crew-decision and decision-reply validate', () => {
  const dir = mkTrussDir()
  const repo = mkRepo()
  const a = runCli(FACTORY, 'crew-decision', ['--crew', 'a', '--task', 'build-ui', '--question', 'Q?', '--answer', 'A.', '--by', 'product-owner', '--dir', dir, '--repo', repo])
  assert.equal(a.status, 0, a.stderr)
  assert.equal(runCli(FACTORY, 'decision-reply', ['d-a-1', 'change', '--note', 'Do B.', '--dir', dir, '--repo', repo]).status, 0)
  assert.equal(runCli(FACTORY, 'crew-decision', ['--crew', 'a', '--task', 't2', '--question', 'Q2?', '--answer', 'A2.', '--by', 'product-owner', '--dir', dir, '--repo', repo]).status, 0)
  assert.equal(runCli(FACTORY, 'decision-reply', ['d-a-2', 'ack', '--dir', dir, '--repo', repo]).status, 0)
  const ev = readEvents(dir)
  assert.deepEqual(ev.map((e) => e.event), ['crew-decision', 'decision-reply', 'crew-decision', 'decision-reply'])
  for (const e of ev) assert.deepEqual(validateEvent(e), [], JSON.stringify(e))
})

t('schema 4: backward compatible: the older events still need agent, and a line with no agent that is not a decision event is refused', () => {
  assert.deepEqual(validateEvent({ v: 1, ts: TS, event: 'report', crew: 's', agent: 's-qc', marker: 'BLOCKED' }), [])
  assert.ok(validateEvent({ v: 1, ts: TS, event: 'report', crew: 's', marker: 'BLOCKED' }).some((e) => e.includes('required agent')))
  assert.ok(validateEvent({ v: 1, ts: TS, event: 'nope', crew: 's', agent: 's' }).length > 0)
})

// @ts-nocheck
// Contract check for replyStep (ADR-0014 Decision 3, Seams section 3; amends ADR-0011 Decision 3).
// Written from the spec before any implementation exists. Node built-ins plus the producer only.
// replyStep(state, msg, backgroundTasks) decides when a reply-needed card opens;
// backgroundTasks is the count after foldMessage.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const producerUrl = pathToFileURL(path.join(path.dirname(here), 'server/session/index.ts')).href
let replyStep
try {
  replyStep = (await import(producerUrl)).replyStep
} catch {
  replyStep = undefined
}

function need() {
  if (typeof replyStep !== 'function') throw new Error('producer missing: ui/server/session replyStep')
  return replyStep
}

const rand = () => 'reply-' + randomBytes(6).toString('hex')
const idle = () => ({ turnRunning: false, held: null })
const init = () => ({ type: 'system', subtype: 'init', session_id: rand() })
const tasksChanged = () => ({ type: 'system', subtype: 'background_tasks_changed' })
const result = (text, extra = {}) => ({ type: 'result', subtype: 'success', result: text, is_error: false, ...extra })

test('case: a top-level result with tasks above 0 opens no card and holds its text', () => {
  const text = rand()
  const out = need()({ turnRunning: true, held: null }, result(text), 2)
  assert.equal(out.open, null)
  assert.equal(out.state.turnRunning, false)
  assert.equal(out.state.held.text, text)
  assert.equal(out.state.held.isError, false)
})

test('case: a held error result keeps isError', () => {
  const text = rand()
  const out = need()({ turnRunning: true, held: null }, result(text, { is_error: true }), 1)
  assert.equal(out.open, null)
  assert.equal(out.state.held.text, text)
  assert.equal(out.state.held.isError, true)
})

test('case: tasks dropping to 0 with no turn running and a held text open exactly one card with that text', () => {
  const rs = need()
  const text = rand()
  const held = rs({ turnRunning: true, held: null }, result(text), 3)
  const mid = rs(held.state, tasksChanged(), 1)
  assert.equal(mid.open, null)
  const drop = rs(mid.state, tasksChanged(), 0)
  assert.ok(drop.open, 'a card opens')
  assert.equal(drop.open.text, text)
  assert.equal(drop.open.isError, false)
  assert.equal(drop.open.backgroundTasks, 0)
  const again = rs(drop.state, tasksChanged(), 0)
  assert.equal(again.open, null, 'only one card opens')
})

test('case: a held error text opens its card with isError true', () => {
  const rs = need()
  const text = rand()
  const held = rs({ turnRunning: true, held: null }, result(text, { is_error: true }), 1)
  const drop = rs(held.state, tasksChanged(), 0)
  assert.equal(drop.open.text, text)
  assert.equal(drop.open.isError, true)
})

test('case: a result with 0 tasks opens a card', () => {
  const text = rand()
  const out = need()({ turnRunning: true, held: null }, result(text), 0)
  assert.ok(out.open, 'a card opens')
  assert.equal(out.open.text, text)
  assert.equal(out.open.isError, false)
  assert.equal(out.open.backgroundTasks, 0)
  assert.equal(out.state.turnRunning, false)
  assert.equal(out.state.held, null)
})

test('case: an init after a held result clears it, and a later drop to 0 opens nothing', () => {
  const rs = need()
  const held = rs({ turnRunning: true, held: null }, result(rand()), 2)
  const started = rs(held.state, init(), 2)
  assert.equal(started.open, null)
  assert.equal(started.state.turnRunning, true)
  assert.equal(started.state.held, null)
  const drop = rs(started.state, tasksChanged(), 0)
  assert.equal(drop.open, null)
})

test('case: a drop to 0 while a turn is running opens nothing', () => {
  const rs = need()
  const out = rs({ turnRunning: true, held: null }, tasksChanged(), 0)
  assert.equal(out.open, null)
})

test('case: a subagent result opens nothing', () => {
  const rs = need()
  const sub = result(rand(), { parent_tool_use_id: 'toolu_' + rand() })
  const a = rs({ turnRunning: true, held: null }, sub, 0)
  assert.equal(a.open, null)
  assert.equal(a.state.held, null)
  assert.equal(a.state.turnRunning, true)
  const b = rs({ turnRunning: true, held: null }, sub, 2)
  assert.equal(b.open, null)
  assert.equal(b.state.held, null)
})

test('case: a drop to 0 with nothing held opens nothing', () => {
  const out = need()(idle(), tasksChanged(), 0)
  assert.equal(out.open, null)
  assert.equal(out.state.held, null)
})

test('case: a drop to 0 after a result already opened a card opens nothing more', () => {
  const rs = need()
  const first = rs({ turnRunning: true, held: null }, result(rand()), 0)
  assert.ok(first.open)
  const drop = rs(first.state, tasksChanged(), 0)
  assert.equal(drop.open, null)
})

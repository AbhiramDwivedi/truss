// Spec-first checks for views/transcript/thread.ts: PAGE, mergeThread, systemText, isGrouped (ADR-0028, UX direction section 2).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRenderer, type Renderer } from '../../test/render.ts'

let r: Renderer
let m: Record<string, any>
before(async () => {
  r = await createRenderer()
  m = await r.load('views/transcript/thread.ts')
})
after(async () => { await r?.close() })

const T = (min: number, sec = 0) => new Date(Date.parse('2026-11-02T11:00:00.000Z') + min * 60_000 + sec * 1000).toISOString()
const msg = (n: number, role: string, at: string, id: string | null = null): any => ({ n, role, text: 'm' + n, ts: at, id })
const flow = (at: string, to: string | null, summary = 'did a thing'): any => ({ at, tool: 'Agent', to, summary })
const queued = (id: string, at: string): any => ({ id, text: 'q ' + id, intent: 'goal', at })
const kinds = (xs: any[]) => xs.map((x) => x.kind)

test('PAGE is 50', () => { assert.equal(m.PAGE, 50) })

test('mergeThread: messages come in ts order and are message items', () => {
  const out = m.mergeThread([msg(1, 'user', T(0)), msg(2, 'assistant', T(1)), msg(3, 'user', T(2))], [], [])
  assert.deepEqual(kinds(out), ['message', 'message', 'message'])
  assert.deepEqual(out.map((x: any) => x.entry.n), [1, 2, 3])
  assert.equal(out[0].at, T(0))
})
test('mergeThread: flow entries merge in by at, between the messages', () => {
  const out = m.mergeThread(
    [msg(1, 'user', T(0)), msg(2, 'assistant', T(4))],
    [flow(T(2), 'rework-chat', 'brief'), flow(T(5), null, 'wrap up')],
    [],
  )
  assert.deepEqual(kinds(out), ['message', 'system', 'message', 'system'])
  assert.equal(out[1].entry.to, 'rework-chat')
  assert.equal(out[1].text, 'PM → crew rework-chat: brief')
  assert.equal(out[3].text, 'PM: wrap up')
})
test('mergeThread: an out-of-order transcript is sorted by ts', () => {
  const out = m.mergeThread([msg(2, 'assistant', T(3)), msg(1, 'user', T(1))], [flow(T(2), 'a')], [])
  assert.deepEqual(kinds(out), ['message', 'system', 'message'])
  assert.deepEqual([out[0].entry.n, out[2].entry.n], [1, 2])
})
test('mergeThread: queued messages come after everything else', () => {
  const out = m.mergeThread([msg(1, 'user', T(5))], [flow(T(6), 'x')], [queued('q1', T(0)), queued('q2', T(1))])
  assert.deepEqual(kinds(out), ['message', 'system', 'queued', 'queued'])
  assert.deepEqual(out.slice(2).map((x: any) => x.message.id), ['q1', 'q2'])
})
test('mergeThread: a queued message already in the transcript by entry id is dropped', () => {
  const out = m.mergeThread([msg(1, 'user', T(0), 'q1')], [], [queued('q1', T(0)), queued('q2', T(1))])
  assert.deepEqual(kinds(out), ['message', 'queued'])
  assert.equal(out[1].message.id, 'q2')
})
test('mergeThread: empty inputs give an empty list', () => {
  assert.deepEqual(m.mergeThread([], [], []), [])
})
test('mergeThread: keys are unique, even for two flow entries at the same time', () => {
  const out = m.mergeThread(
    [msg(1, 'user', T(0)), msg(2, 'assistant', T(1))],
    [flow(T(2), 'a', 's'), flow(T(2), 'a', 's')],
    [queued('q1', T(3))],
  )
  const keys = out.map((x: any) => x.key)
  assert.ok(keys.every((k: unknown) => typeof k === 'string' && k.length > 0))
  assert.equal(new Set(keys).size, keys.length)
})

test('systemText: PM → crew <slug>: <summary> when to is set', () => {
  assert.equal(m.systemText(flow(T(0), 'rework-chat', 'Build the thread')), 'PM → crew rework-chat: Build the thread')
})
test('systemText: PM: <summary> when to is null', () => {
  assert.equal(m.systemText(flow(T(0), null, 'Merging')), 'PM: Merging')
})
test('systemText: a long slug and summary are never truncated', () => {
  const slug = 'x'.repeat(60)
  const summary = 'y'.repeat(200)
  assert.equal(m.systemText(flow(T(0), slug, summary)), `PM → crew ${slug}: ${summary}`)
})

const item = (n: number, role: string, at: string) => m.mergeThread([msg(n, role, at)], [], [])[0]
test('isGrouped: no previous item is not grouped', () => {
  assert.equal(m.isGrouped(undefined, item(1, 'assistant', T(0))), false)
})
test('isGrouped: same role within 2 minutes is grouped', () => {
  assert.equal(m.isGrouped(item(1, 'assistant', T(0)), item(2, 'assistant', T(1, 59))), true)
  assert.equal(m.isGrouped(item(1, 'user', T(0)), item(2, 'user', T(0, 5))), true)
})
test('isGrouped: more than 2 minutes apart is not grouped', () => {
  assert.equal(m.isGrouped(item(1, 'assistant', T(0)), item(2, 'assistant', T(2, 1))), false)
  assert.equal(m.isGrouped(item(1, 'assistant', T(0)), item(2, 'assistant', T(30))), false)
})
test('isGrouped: a different sender is not grouped', () => {
  assert.equal(m.isGrouped(item(1, 'user', T(0)), item(2, 'assistant', T(0, 10))), false)
  assert.equal(m.isGrouped(item(1, 'assistant', T(0)), item(2, 'error', T(0, 10))), false)
})
test('isGrouped: a system line or queued item on either side is not grouped', () => {
  const sys = m.mergeThread([], [flow(T(0), 'a')], [])[0]
  const q = m.mergeThread([], [], [queued('q1', T(0))])[0]
  const a = item(1, 'assistant', T(0))
  assert.equal(m.isGrouped(sys, item(2, 'assistant', T(0, 10))), false)
  assert.equal(m.isGrouped(a, sys), false)
  assert.equal(m.isGrouped(q, a), false)
  assert.equal(m.isGrouped(a, q), false)
})

// Spec-first checks for views/move/format.ts: cardName, sendStage, replyTarget (ADR-0028 section 2, R-47).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRenderer, appDir, type Renderer } from '../../test/render.ts'

let r: Renderer
let m: Record<string, any>
before(async () => {
  r = await createRenderer()
  m = await r.load('views/move/format.ts')
})
after(async () => { await r?.close() })

const reply = (extra: Record<string, unknown> = {}): any => ({
  id: 'r1', kind: 'reply', status: 'open', createdAt: '2026-11-02T11:58:00.000Z', answeredAt: null, cancelReason: null,
  text: 'Done.', isError: false, backgroundTasks: 0, decision: null, message: null, ...extra,
})

test('stripMarkdown: emphasis, code, headings, list markers, quotes and links lose their syntax', () => {
  const out = m.stripMarkdown('# Done\n\n**`greet.sh`:** now *runs*.\n\n- one\n- two\n1. three\n> quote\n[docs](https://x.y)')
  assert.equal(out, 'Done\n\ngreet.sh: now runs.\n\none\ntwo\nthree\nquote\ndocs')
  assert.doesNotMatch(out, /\*|`|^- /m)
})
test('previewText: short text is kept whole; long text is cut at a word with an ellipsis', () => {
  assert.equal(m.previewText('**Hi** there'), 'Hi there')
  const out = m.previewText('word '.repeat(100).trim(), 50)
  assert.ok(out.endsWith('…'))
  assert.ok(out.length <= 51)
  assert.match(out, /^(word )*word…$/)
  assert.equal(m.previewText(null), '')
})
test('cardName: a reply is Approval needed only when approvalAsk is true', () => {
  assert.equal(m.cardName(reply({ approvalAsk: true })), 'Approval needed')
})
test('cardName: a reply with approvalAsk absent or false is The PM replied', () => {
  assert.equal(m.cardName(reply()), 'The PM replied')
  assert.equal(m.cardName(reply({ approvalAsk: false })), 'The PM replied')
  assert.equal(m.cardName(reply({ approvalAsk: false, isError: true })), 'The PM replied')
})
test('"Reply needed" leaves format.ts, ReplyCard.tsx and YourMove.tsx', () => {
  for (const f of ['format.ts', 'ReplyCard.tsx', 'YourMove.tsx']) {
    const src = fs.readFileSync(path.join(appDir, 'views', 'move', f), 'utf8')
    assert.ok(!src.includes('Reply needed'), `${f} has no "Reply needed"`)
  }
})

test('sendStage: no start time is idle', () => {
  assert.equal(m.sendStage(null, 50_000, false), 'idle')
})
test('sendStage: failed wins over every timer', () => {
  assert.equal(m.sendStage(null, 50_000, true), 'failed')
  assert.equal(m.sendStage(1000, 1500, true), 'failed')
  assert.equal(m.sendStage(1000, 40_000, true), 'failed')
})
test('sendStage: under 10 s is sending, 10 s to under 30 s is slow, 30 s and over is stuck', () => {
  const t0 = 100_000
  assert.equal(m.sendStage(t0, t0, false), 'sending')
  assert.equal(m.sendStage(t0, t0 + 9_999, false), 'sending')
  assert.equal(m.sendStage(t0, t0 + 10_000, false), 'slow')
  assert.equal(m.sendStage(t0, t0 + 29_999, false), 'slow')
  assert.equal(m.sendStage(t0, t0 + 30_000, false), 'stuck')
  assert.equal(m.sendStage(t0, t0 + 600_000, false), 'stuck')
})

const iso = (min: number) => new Date(Date.parse('2026-11-02T11:00:00.000Z') + min * 60_000).toISOString()
const e = (n: number, role: string, min: number): any => ({ n, role, text: 't' + n, ts: iso(min) })

test('replyTarget: the last assistant entry at or before the request time', () => {
  const t = [e(1, 'user', 0), e(2, 'assistant', 5), e(3, 'user', 6), e(4, 'assistant', 10), e(5, 'assistant', 30)]
  assert.equal(m.replyTarget(t, reply({ createdAt: iso(12) })), 4)
})
test('replyTarget: an entry stamped exactly at createdAt counts', () => {
  const t = [e(1, 'assistant', 5), e(2, 'assistant', 10), e(3, 'assistant', 11)]
  assert.equal(m.replyTarget(t, reply({ createdAt: iso(10) })), 2)
})
test('replyTarget: an error entry counts as a target', () => {
  const t = [e(1, 'assistant', 5), e(2, 'error', 9), e(3, 'user', 9.5)]
  assert.equal(m.replyTarget(t, reply({ createdAt: iso(10), isError: true })), 2)
})
test('replyTarget: user entries are never the target', () => {
  const t = [e(1, 'assistant', 1), e(2, 'user', 5)]
  assert.equal(m.replyTarget(t, reply({ createdAt: iso(10) })), 1)
})
test('replyTarget: with none at or before it falls back to the last assistant entry', () => {
  const t = [e(1, 'user', 0), e(2, 'assistant', 20), e(3, 'assistant', 25), e(4, 'user', 26)]
  assert.equal(m.replyTarget(t, reply({ createdAt: iso(10) })), 3)
})
test('replyTarget: null when there is no assistant entry or no transcript', () => {
  assert.equal(m.replyTarget([], reply()), null)
  assert.equal(m.replyTarget([e(1, 'user', 0)], reply({ createdAt: iso(10) })), null)
})

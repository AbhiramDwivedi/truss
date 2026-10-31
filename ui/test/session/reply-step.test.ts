// replyStep replayed over the real SDK recording (ui/contract/fixtures/sdk-stream.jsonl), the way
// onMessage drives it: fold first, then replyStep with the folded background task count.
// ADR-0014 Decision 3. Every expected text is read from the recording.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const uiDir = path.resolve(here, '../..')
const { initialView, foldMessage, replyStep } = (await import(
  pathToFileURL(path.join(uiDir, 'server/session/index.ts')).href
)) as any

const messages: any[] = fs
  .readFileSync(path.join(uiDir, 'contract/fixtures/sdk-stream.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l))
  .filter((m) => !('_spike' in m))

const bySeq = (n: number) => {
  const m = messages.find((x) => x._seq === n)
  assert.ok(m, `recording has _seq ${n}`)
  return m
}

type Step = { seq: number; msg: any; open: any; state: any; held: any; tasks: number }

function replay(start: any): { steps: Step[]; final: any } {
  let view = initialView()
  let state = start
  const steps: Step[] = []
  for (const msg of messages) {
    view = foldMessage(view, msg)
    const tasks = view.session.backgroundTasks.length
    const out = replyStep(state, msg, tasks)
    state = out.state
    steps.push({ seq: msg._seq, msg, open: out.open, state, held: state.held, tasks })
  }
  return { steps, final: state }
}

const stepAt = (steps: Step[], seq: number) => {
  const s = steps.find((x) => x.seq === seq)
  assert.ok(s, `replayed _seq ${seq}`)
  return s
}

test('the top-level result at _seq 49 opens one card with its text and is_error', () => {
  const { steps } = replay({ turnRunning: false, held: null })
  const msg = bySeq(49)
  const s = stepAt(steps, 49)
  assert.equal(s.tasks, 0)
  assert.ok(s.open, 'a card opens')
  assert.equal(s.open.text, msg.result)
  assert.equal(s.open.isError, msg.is_error)
})

test('the top-level result at _seq 58 with 0 background tasks opens one card with its text and is_error', () => {
  const { steps } = replay({ turnRunning: false, held: null })
  const msg = bySeq(58)
  const s = stepAt(steps, 58)
  assert.equal(s.tasks, 0)
  assert.ok(s.open, 'a card opens')
  assert.equal(s.open.text, msg.result)
  assert.equal(s.open.isError, msg.is_error)
})

test('the result at _seq 69 with one background task opens nothing and holds its text', () => {
  const { steps } = replay({ turnRunning: false, held: null })
  const msg = bySeq(69)
  const s = stepAt(steps, 69)
  assert.equal(s.tasks, 1)
  assert.equal(s.open, null)
  assert.ok(s.held, 'text is held')
  assert.equal(s.held.text, msg.result)
  assert.equal(s.held.isError, msg.is_error)
})

test('the background_tasks_changed to [] at _seq 79 opens exactly one card with the _seq 69 text', () => {
  const { steps } = replay({ turnRunning: false, held: null })
  const held = bySeq(69)
  const drop = bySeq(79)
  assert.deepEqual(drop.tasks ?? [], [])
  const s = stepAt(steps, 79)
  assert.equal(s.tasks, 0)
  assert.ok(s.open, 'a card opens')
  assert.equal(s.open.text, held.result)
  assert.equal(s.open.isError, held.is_error)
  assert.equal(s.open.backgroundTasks, 0)
  assert.equal(s.held, null)
})

test('the init at _seq 80 opens nothing and leaves held null', () => {
  const { steps } = replay({ turnRunning: false, held: null })
  const s = stepAt(steps, 80)
  assert.equal(s.open, null)
  assert.equal(s.held, null)
})

test('the result at _seq 82 opens one card with its text', () => {
  const { steps } = replay({ turnRunning: false, held: null })
  const msg = bySeq(82)
  const s = stepAt(steps, 82)
  assert.ok(s.open, 'a card opens')
  assert.equal(s.open.text, msg.result)
  assert.equal(s.open.isError, msg.is_error)
})

test('across the whole replay exactly 4 cards open, none from a non-result, non-drop message', () => {
  const { steps } = replay({ turnRunning: false, held: null })
  const opened = steps.filter((s) => s.open)
  assert.equal(opened.length, 4)
  assert.deepEqual(opened.map((s) => s.seq), [49, 58, 79, 82])
  for (const s of opened) {
    const isResult = s.msg.type === 'result'
    const isDrop = s.msg.type === 'system' && s.msg.subtype === 'background_tasks_changed' && s.tasks === 0
    assert.ok(isResult || isDrop, `_seq ${s.seq} is a result or a drop`)
  }
})

test('replaying twice from a queued state through fresh state gives the same cards and leaves the input untouched', () => {
  const queued = { turnRunning: true, held: null }
  const snapshot = JSON.parse(JSON.stringify(queued))
  const a = replay(queued)
  assert.deepEqual(queued, snapshot, 'input state was not mutated')
  const b = replay(queued)
  assert.deepEqual(queued, snapshot, 'input state still not mutated')
  assert.deepEqual(
    a.steps.map((s) => s.open),
    b.steps.map((s) => s.open),
  )
  assert.deepEqual(a.final, b.final)
  assert.equal(a.steps.filter((s) => s.open).length, 4)
})

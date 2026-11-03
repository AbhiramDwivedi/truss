// tally.seen bound (crew ui-server-fixes, item 3): seen holds at most 256 recent message ids, the live totals
// stay exact, an id repeated on consecutive content blocks counts once, and foldMessage stays pure.
// Erasable TypeScript, node:test, built-ins only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const uiDir = path.resolve(here, '../..')
const { initialView, foldMessage } = (await import(
  pathToFileURL(path.join(uiDir, 'server/session/index.ts')).href
)) as any

const BOUND = 256

const assistant = (id: string, usage: Record<string, number>, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: { id, role: 'assistant', content: [{ type: 'text', text: 'x' }], usage },
  parent_tool_use_id: null,
  session_id: 's1',
  ...extra,
})
const usage = { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 11 }
const PER = 3 + 5 + 7 + 11
const size = (seen: unknown): number =>
  seen instanceof Map || seen instanceof Set ? seen.size : Array.isArray(seen) ? seen.length : Object.keys(seen as object).length

test('seen stays at or under 256 after 1000 distinct message ids, and the live totals are exact', () => {
  let view = initialView()
  for (let i = 0; i < 1000; i++) view = foldMessage(view, assistant('m' + i, usage))
  assert.ok(size(view.tally.seen) <= BOUND, `seen holds ${size(view.tally.seen)} ids, bound is ${BOUND}`)
  assert.ok(size(view.tally.seen) > 0, 'seen still remembers recent ids')
  const live = view.tally.live
  assert.equal(live.inputTokens, 3000)
  assert.equal(live.outputTokens, 5000)
  assert.equal(live.cacheReadInputTokens, 7000)
  assert.equal(live.cacheCreationInputTokens, 11000)
  assert.equal(live.totalTokens, 1000 * PER)
})

test('seen drops the oldest ids first: the newest id is kept', () => {
  let view = initialView()
  for (let i = 0; i < 1000; i++) view = foldMessage(view, assistant('m' + i, usage))
  const has = (id: string) => {
    const s = view.tally.seen
    return s instanceof Map || s instanceof Set ? s.has(id) : Array.isArray(s) ? s.includes(id) : Boolean(s[id])
  }
  assert.ok(has('m999'), 'newest id kept')
  assert.ok(has('m' + (1000 - BOUND)), 'the 256th newest id kept')
  assert.ok(!has('m0'), 'oldest id dropped')
})

test('an id repeated on consecutive content blocks counts once, past the bound too', () => {
  let view = initialView()
  for (let i = 0; i < 600; i++) {
    view = foldMessage(view, assistant('r' + i, usage))
    view = foldMessage(view, assistant('r' + i, usage))
    view = foldMessage(view, assistant('r' + i, usage))
  }
  assert.ok(size(view.tally.seen) <= BOUND, `seen holds ${size(view.tally.seen)} ids`)
  assert.equal(view.tally.live.totalTokens, 600 * PER)
  assert.equal(view.tally.live.outputTokens, 600 * 5)
})

test('subagent messages (parent_tool_use_id) and id-less messages are not counted', () => {
  let view = initialView()
  view = foldMessage(view, assistant('sub1', usage, { parent_tool_use_id: 'toolu_1' }))
  view = foldMessage(view, { type: 'assistant', message: { role: 'assistant', content: [], usage }, parent_tool_use_id: null })
  assert.equal(view.tally.live, null)
  view = foldMessage(view, assistant('top', usage))
  assert.equal(view.tally.live.totalTokens, PER)
})

test('foldMessage does not mutate its input view or tally.seen', () => {
  let view = initialView()
  for (let i = 0; i < 300; i++) view = foldMessage(view, assistant('p' + i, usage))
  const before = JSON.stringify(view)
  const seenRef = view.tally.seen
  const seenBefore = size(seenRef)
  const next = foldMessage(view, assistant('fresh', usage))
  assert.notEqual(next, view)
  assert.equal(JSON.stringify(view), before, 'the input view is unchanged')
  assert.equal(view.tally.seen, seenRef)
  assert.equal(size(seenRef), seenBefore, 'the input seen is unchanged')
})

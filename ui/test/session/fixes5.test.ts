// fixes5 item 54 (crew ui-fixes5): tally.seen keeps arrival order of message ids and stays bounded at 256.
// Erasable TypeScript, node:test, built-ins only. Paths resolve from import.meta.url.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const uiDir = path.resolve(here, '../..')
const { initialView, foldMessage } = (await import(
  pathToFileURL(path.join(uiDir, 'server/session/index.ts')).href
)) as any

const usage = { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 11 }
const assistant = (id: string) => ({
  type: 'assistant',
  message: { id, role: 'assistant', content: [{ type: 'text', text: 'x' }], usage },
  parent_tool_use_id: null,
  session_id: 's1',
})
const size = (seen: unknown): number =>
  seen instanceof Map || seen instanceof Set ? seen.size : Array.isArray(seen) ? seen.length : Object.keys(seen as object).length
const has = (s: any, id: string): boolean =>
  s instanceof Map || s instanceof Set ? s.has(id) : Array.isArray(s) ? s.includes(id) : Boolean(s[id])

test('i54 1: seen keeps arrival order, bounded at 256: 300 ids keep "300" and drop "1"', () => {
  let view = initialView()
  for (let i = 1; i <= 300; i++) view = foldMessage(view, assistant(String(i)))
  const seen = view.tally.seen
  assert.ok(size(seen) <= 256, `seen holds ${size(seen)} ids`)
  assert.ok(has(seen, '300'), 'newest id "300" kept')
  assert.ok(!has(seen, '1'), 'oldest id "1" dropped')
  assert.ok(has(seen, '45'), 'the 256th newest id "45" kept')
  // Integer-like ids sort numerically in a plain object, so ascending arrival cannot tell arrival order from
  // numeric order. Arrive 300 down to 1: the newest is "1", the oldest "300".
  let down = initialView()
  for (let i = 300; i >= 1; i--) down = foldMessage(down, assistant(String(i)))
  const d = down.tally.seen
  assert.ok(size(d) <= 256, `seen holds ${size(d)} ids after descending arrival`)
  assert.ok(has(d, '1'), 'newest id "1" kept after descending arrival')
  assert.ok(!has(d, '300'), 'oldest id "300" dropped after descending arrival')
})

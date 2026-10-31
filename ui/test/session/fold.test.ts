// foldMessage tests from ADR-0011 Decision 2 (status, transcript), state.schema.json (session,
// usage, transcriptEntry) and architecture.md ai rule 8. Messages are built from the shapes in
// ui/contract/fixtures/sdk-stream.jsonl (lines 3, 63, 79-82).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const uiDir = path.resolve(here, '../..')
const { initialView, foldMessage } = (await import(
  pathToFileURL(path.join(uiDir, 'server/session/index.ts')).href
)) as any

const init = (plugins: any[] = [{ name: 'truss', path: '/p', source: 'truss@inline', version: '0.12.0' }]) => ({
  type: 'system',
  subtype: 'init',
  session_id: 's1',
  model: 'claude-opus-5-5',
  permissionMode: 'default',
  claude_code_version: '2.1.314',
  plugins,
})
const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
  parent_tool_use_id: null,
  session_id: 's1',
  ...extra,
})
const result = (extra: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'done',
  session_id: 's1',
  modelUsage: {
    'claude-opus-5-5': {
      inputTokens: 4,
      outputTokens: 260,
      cacheReadInputTokens: 39355,
      cacheCreationInputTokens: 742,
      costUSD: 0.1,
    },
  },
  ...extra,
})

test('background_tasks_changed maps tasks to {taskId, description, subagentType}', () => {
  // schema session.backgroundTasks; fixture line 63 (task_id, subagent_type, description)
  const msg = {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [
      { task_id: 't1', run_id: 'r', task_type: 'local_agent', subagent_type: 'general-purpose', description: 'Run ls' },
      { task_id: 't2', run_id: 'r2', task_type: 'local_agent', description: 'No type' },
    ],
  }
  const v = foldMessage(initialView(), msg)
  assert.deepEqual(v.session.backgroundTasks, [
    { taskId: 't1', description: 'Run ls', subagentType: 'general-purpose' },
    { taskId: 't2', description: 'No type', subagentType: null },
  ])
  // fixture line 79: an empty tasks array clears them
  const cleared = foldMessage(v, { type: 'system', subtype: 'background_tasks_changed', tasks: [] })
  assert.deepEqual(cleared.session.backgroundTasks, [])
})

test('init without a truss plugin gives plugin null', () => {
  // schema session.plugin: "or null when init lists none"
  const v = foldMessage(
    initialView(),
    init([{ name: 'engineering', path: '/e', source: 'engineering@synced', version: '1.2.0' }]),
  )
  assert.equal(v.session.plugin, null)
  assert.equal(v.session.model, 'claude-opus-5-5')
  assert.equal(foldMessage(initialView(), init([])).session.plugin, null)
})

test('a result without total_cost_usd gives costUsd null', () => {
  // schema usage.costUsd: "or null when absent"
  const v = foldMessage(foldMessage(initialView(), init()), result())
  assert.equal(v.session.usage.costUsd, null)
  assert.equal(v.session.usage.results, 1)
  assert.equal(v.session.status, 'waiting')
  assert.deepEqual(v.session.usage.models['claude-opus-5-5'], {
    inputTokens: 4,
    outputTokens: 260,
    cacheReadInputTokens: 39355,
    cacheCreationInputTokens: 742,
  })
})

test('a later result replaces the cost and counts results; nothing is summed', () => {
  // ADR Decision 2 Usage: "the latest result replaces the earlier one, and nothing is summed"
  let v = foldMessage(initialView(), result({ total_cost_usd: 0.4 }))
  v = foldMessage(v, result({ total_cost_usd: 0.5 }))
  assert.equal(v.session.usage.costUsd, 0.5)
  assert.equal(v.session.usage.results, 2)
})

test('assistant messages from a subagent add nothing to the transcript', () => {
  // ADR Decision 2 Transcript: top-level only (no parent_tool_use_id, no agent_id)
  const base = initialView()
  const a = foldMessage(base, assistant('from a tool', { parent_tool_use_id: 'toolu_1' }))
  assert.deepEqual(a.transcript, [])
  const b = foldMessage(base, assistant('from an agent', { agent_id: 'agent-7' }))
  assert.deepEqual(b.transcript, [])
  const c = foldMessage(base, assistant('top level'))
  assert.deepEqual(c.transcript.map((e: any) => [e.role, e.text]), [['assistant', 'top level']])
})

test('a message type foldMessage does not know leaves the view deep-equal', () => {
  // architecture.md ai rule 8: "a message it doesn't know is ignored, not passed on"
  let v = foldMessage(initialView(), init())
  v = foldMessage(v, assistant('hello'))
  const before = structuredClone(v)
  for (const msg of [
    { type: 'stream_event', event: {} },
    { type: 'system', subtype: 'something_new', x: 1 },
    { type: 'brand_new_type', payload: [1, 2, 3] },
    { type: 'rate_limit_event' },
    {},
  ]) {
    assert.deepEqual(foldMessage(v, msg), before, JSON.stringify(msg))
  }
  assert.deepEqual(v, before)
})

test('the transcript keeps only the last 500 entries and n keeps rising', () => {
  // ADR Decision 2 Transcript: "Only the last 500 entries stay in memory"; schema transcriptEntry.n
  let v = initialView()
  for (let i = 1; i <= 620; i++) v = foldMessage(v, assistant(`m${i}`))
  assert.equal(v.transcript.length, 500)
  assert.equal(v.transcript[0].text, 'm121')
  assert.equal(v.transcript[499].text, 'm620')
  assert.equal(v.transcript[499].n, 620)
  assert.equal(v.transcript[0].n, 121)
  for (let i = 1; i < v.transcript.length; i++) assert.equal(v.transcript[i].n, v.transcript[i - 1].n + 1)
  v = foldMessage(v, assistant('next'))
  assert.equal(v.transcript.length, 500)
  assert.equal(v.transcript[499].n, 621)
})

test('foldMessage never mutates the view or the message it was given', () => {
  const msgs = [
    init(),
    assistant('hi'),
    { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'x', description: 'd' }] },
    result({ total_cost_usd: 0.2 }),
    { type: 'unknown_thing' },
  ]
  let v = initialView()
  for (const m of msgs) {
    const vSnap = JSON.stringify(v)
    const mSnap = JSON.stringify(m)
    const next = foldMessage(v, m)
    assert.equal(JSON.stringify(v), vSnap, 'view unchanged')
    assert.equal(JSON.stringify(m), mSnap, 'message unchanged')
    v = next
  }
  // the initial view is not shared state: a fresh one is still idle after folding another
  assert.equal(initialView().session.status, 'idle')
  assert.deepEqual(initialView().transcript, [])
})

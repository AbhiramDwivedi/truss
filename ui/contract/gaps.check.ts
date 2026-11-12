// Contract check for the ADR-0023 server gaps a, b, d, e, f and g (c and h ship without).
// Written from ADR-0023 before any implementation exists: on the base server every case fails on an
// assertion about the missing behaviour. Run with `node --test ui/contract/gaps.check.ts`.
// Each case imports the server modules inside the case, so a missing export fails that case only.
// Erasable TypeScript, node:test, built-ins only. Temp dirs come from mkdtemp; every server binds port 0.
//
// The Agent SDK is replaced by a stand-in through a module resolve hook, so no live Claude session runs.
// The stand-in records every user message the session's input generator yields, and lets a case feed
// SDK messages (a result, say) back into the session.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const uiDir = path.dirname(here)
const serverUrl = (rel: string) => pathToFileURL(path.join(uiDir, 'server', rel)).href

// ---------------------------------------------------------------------------
// The SDK stand-in.
// ---------------------------------------------------------------------------
const STUB_SOURCE = `
const g = globalThis;
export function query({ prompt }) {
  const feed = [];
  let wake = null;
  let stopped = false;
  const rec = { sent: [], emit(m) { feed.push(m); if (wake) { const w = wake; wake = null; w(); } } };
  g.__trussStub = rec;
  (async () => { for await (const m of prompt) rec.sent.push(m.message.content); })().catch(() => {});
  return {
    async *[Symbol.asyncIterator]() {
      while (!stopped) {
        if (feed.length) { yield feed.shift(); continue; }
        await new Promise((r) => { wake = r; });
      }
    },
    async interrupt() { stopped = true; if (wake) { const w = wake; wake = null; w(); } },
  };
}
`
const HOOKS_SOURCE = `
export async function resolve(specifier, context, next) {
  if (specifier === '@anthropic-ai/claude-agent-sdk') {
    return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(STUB_SOURCE)}), shortCircuit: true };
  }
  return next(specifier, context);
}
`
register('data:text/javascript,' + encodeURIComponent(HOOKS_SOURCE))

interface Stub { sent: string[]; emit(m: unknown): void }
const stub = (): Stub | undefined => (globalThis as any).__trussStub

async function until(f: () => boolean, what: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (!f()) {
    if (Date.now() > end) assert.fail('timed out waiting for ' + what)
    await new Promise((r) => setTimeout(r, 10))
  }
}

// ---------------------------------------------------------------------------
// A small JSON Schema (2020-12 subset) validator for ui/contract/state.schema.json.
// ---------------------------------------------------------------------------
const schema = JSON.parse(fs.readFileSync(path.join(here, 'state.schema.json'), 'utf8'))

function resolveRef(ref: string): any {
  let node: any = schema
  for (const part of ref.slice(2).split('/')) node = node[part]
  return node
}
function typeOk(t: string, v: any): boolean {
  if (t === 'null') return v === null
  if (t === 'boolean') return typeof v === 'boolean'
  if (t === 'string') return typeof v === 'string'
  if (t === 'number') return typeof v === 'number' && Number.isFinite(v)
  if (t === 'integer') return Number.isInteger(v)
  if (t === 'array') return Array.isArray(v)
  if (t === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v)
  return false
}
function validate(s: any, v: any, at: string, errs: string[]): void {
  if (s.$ref) return validate(resolveRef(s.$ref), v, at, errs)
  const mine: string[] = []
  if ('const' in s && v !== s.const) mine.push(`${at}: expected const ${JSON.stringify(s.const)}`)
  if (s.enum && !s.enum.some((e: any) => e === v)) mine.push(`${at}: ${JSON.stringify(v)} not in enum ${JSON.stringify(s.enum)}`)
  if (s.type) {
    const ts = Array.isArray(s.type) ? s.type : [s.type]
    if (!ts.some((t: string) => typeOk(t, v))) mine.push(`${at}: expected type ${ts.join('|')}, got ${JSON.stringify(v)?.slice(0, 60)}`)
  }
  if (typeof v === 'string') {
    if (s.minLength !== undefined && v.length < s.minLength) mine.push(`${at}: shorter than ${s.minLength}`)
    if (s.format === 'date-time' && !(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(v) && !Number.isNaN(Date.parse(v)))) {
      mine.push(`${at}: ${v} is not an RFC 3339 date-time`)
    }
  }
  if (typeof v === 'number' && s.minimum !== undefined && v < s.minimum) mine.push(`${at}: below minimum ${s.minimum}`)
  if (Array.isArray(v) && s.items) v.forEach((x, i) => validate(s.items, x, `${at}[${i}]`, mine))
  if (typeOk('object', v)) {
    for (const k of s.required ?? []) if (!(k in v)) mine.push(`${at}: missing required ${k}`)
    const props = s.properties ?? {}
    for (const [k, x] of Object.entries(v)) {
      if (k in props) validate(props[k], x, `${at}.${k}`, mine)
      else if (s.additionalProperties === false) mine.push(`${at}: unexpected property ${k}`)
      else if (typeOk('object', s.additionalProperties)) validate(s.additionalProperties, x, `${at}.${k}`, mine)
    }
  }
  if (s.oneOf) {
    const ok = s.oneOf.filter((o: any) => { const e: string[] = []; validate(o, v, at, e); return e.length === 0 })
    if (ok.length !== 1) mine.push(`${at}: matches ${ok.length} of ${s.oneOf.length} oneOf branches`)
  }
  errs.push(...mine)
}
function assertSchema(defName: string, value: unknown): void {
  const errs: string[] = []
  validate({ $ref: `#/$defs/${defName}` }, value, defName, errs)
  assert.deepEqual(errs.slice(0, 10), [], `${defName} breaks state.schema.json`)
}

// ---------------------------------------------------------------------------
// The fixed lines of ADR-0023 gap a.
// ---------------------------------------------------------------------------
const GOAL_LINE = '[Truss UI: new goal] Plan this as a new goal for the run.'
const ADD_LINE = '[Truss UI: detail] Add this to the current goal.'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'truss-gaps-check-'))
let counter = 0
const tmpDir = (name: string) => {
  const d = path.join(tmpRoot, `${name}-${++counter}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

// ---------------------------------------------------------------------------
// The wired server: the real store, the real session (SDK stand-in) and the real HTTP server.
// ---------------------------------------------------------------------------
async function boot() {
  const { createStore } = await import(serverUrl('state/index.ts'))
  const { createSession } = await import(serverUrl('session/index.ts'))
  const { createServer } = await import(serverUrl('http/index.ts'))
  ;(globalThis as any).__trussStub = undefined
  const repo = tmpDir('repo')
  const store = createStore({ repo, pollMs: 50 })
  // ADR-0028 section 1: createSession takes hasPlan(); these cases run with no plan.json.
  const session = createSession({ repo, pluginPath: path.join(path.dirname(uiDir), 'plugins', 'truss'), hasPlan: () => false })
  session.subscribe((v: unknown) => store.setSession(v))
  const server = createServer({ state: store, session, webDir: tmpDir('web') })
  const { port, token } = await server.listen(0)
  const post = (route: string, body: unknown): Promise<{ status: number; json: any }> =>
    new Promise((resolve, reject) => {
      const data = JSON.stringify(body)
      const r = http.request(
        {
          host: '127.0.0.1', port, method: 'POST', path: route, agent: false,
          headers: {
            host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(data)), cookie: `truss-ui-${port}=${token}`,
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            let json: any = null
            try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* not json */ }
            resolve({ status: res.statusCode ?? 0, json })
          })
        },
      )
      r.on('error', reject)
      r.end(data)
    })
  return {
    store, session, post,
    state: () => store.snapshot().state as any,
    async close() {
      await session.close()
      await server.close()
      store.close()
    },
  }
}

// ---------------------------------------------------------------------------
// A Truss dir with a plan.json and events.jsonl, behind a real store.
// ---------------------------------------------------------------------------
async function storeFor(files: Record<string, string>) {
  const { createStore } = await import(serverUrl('state/index.ts'))
  const repo = tmpDir('repo')
  const truss = tmpDir('truss')
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(truss, name), text)
  const store = createStore({ repo, trussDir: truss, pollMs: 50 })
  return { store, run: () => store.snapshot().state.run as any, snapshot: () => store.snapshot() }
}
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'

const FIRST = { goal: 'Add rate limiting to the API', approval: 'client', approvedAt: '2026-10-27T08:00:00Z' }
const planWith = (crews: unknown[], goals?: unknown[]) =>
  JSON.stringify({
    version: 3, ...FIRST, architecture: 'docs/architecture.md', maxParallelCrews: 2, reworkAllowance: 2,
    ...(goals ? { goals } : {}),
    crews,
  })
const crewRow = (slug: string, status: string, estAgents: number) => ({
  slug, stage: 0, verdict: 'build', modules: ['m'], owns: [`src/${slug}.ts`], acceptanceTest: 'npm test', acceptanceTestProved: true, estAgents, status,
})
const spawn = (ts: string, crew: string, agent: string) => ({
  v: 1, ts, event: 'spawn', crew, agent, agentId: 'id-' + agent, type: agent === crew ? 'truss:project-manager' : 'kit:builder', model: 'opus', effort: 'high', by: 'main',
})
const stall = (ts: string, crew: string, agent: string, kind: string, minutes: number) => ({ v: 1, ts, event: 'stall', crew, agent, kind, minutes })

// ===========================================================================
// Gap a: an intent and an id on every message
// ===========================================================================

test('gap a: POST /api/message answers 202 {ok, id} and the transcript entry carries that id and intent', async () => {
  const w = await boot()
  try {
    const r = await w.post('/api/message', { text: 'build the rate limiter', intent: 'goal' })
    assert.equal(r.status, 202)
    assert.equal(r.json.ok, true)
    assert.equal(typeof r.json.id, 'string', 'the 202 body carries an id string')
    assert.ok(r.json.id.length > 0, 'the id is non-empty')
    const entries = w.state().transcript.filter((e: any) => e.role === 'user')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].id, r.json.id, 'the user entry carries the message id')
    assert.equal(entries[0].intent, 'goal')
    assert.equal(entries[0].text, 'build the rate limiter', 'the entry text is the text as typed')
    assertSchema('snapshot', w.store.snapshot())
  } finally {
    await w.close()
  }
})

test('gap a: ids are unique per message and an add intent is recorded as add', async () => {
  const w = await boot()
  try {
    const one = await w.post('/api/message', { text: 'first', intent: 'goal' })
    const two = await w.post('/api/message', { text: 'second', intent: 'add' })
    assert.equal(typeof one.json.id, 'string')
    assert.equal(typeof two.json.id, 'string')
    assert.notEqual(one.json.id, two.json.id)
    const entries = w.state().transcript.filter((e: any) => e.role === 'user')
    assert.deepEqual(entries.map((e: any) => [e.id, e.intent]), [[one.json.id, 'goal'], [two.json.id, 'add']])
  } finally {
    await w.close()
  }
})

test('gap a: an intent prepends the fixed line, a blank line, then the text as typed', async () => {
  const w = await boot()
  try {
    const r = await w.post('/api/message', { text: 'the quota plan', intent: 'goal' })
    assert.equal(r.status, 202)
    await until(() => (stub()?.sent.length ?? 0) >= 1, 'the session to take the first message')
    // ADR-0028 section 1: with no plan.json and no earlier goal, intent goal starts the run (R-41).
    assert.equal(stub()!.sent[0], '/truss:run the quota plan')
    stub()!.emit({ type: 'result', subtype: 'success', total_cost_usd: 0.01, modelUsage: {} })
    await until(() => w.state().session.status === 'waiting', 'the turn to end')
    const r2 = await w.post('/api/message', { text: 'also per key', intent: 'add' })
    assert.equal(r2.status, 202)
    await until(() => (stub()?.sent.length ?? 0) >= 2, 'the session to take the second message')
    assert.equal(stub()!.sent[1], `${ADD_LINE}\n\nalso per key`)
  } finally {
    await w.close()
  }
})

test('gap a: text without an intent goes to the session unchanged and its entry has intent null', async () => {
  const w = await boot()
  try {
    const r = await w.post('/api/message', { text: 'plain words' })
    assert.equal(r.status, 202)
    assert.equal(typeof r.json.id, 'string', 'the 202 body carries an id even without an intent')
    await until(() => (stub()?.sent.length ?? 0) >= 1, 'the session to take the message')
    assert.equal(stub()!.sent[0], 'plain words')
    const e = w.state().transcript.find((x: any) => x.role === 'user')
    assert.equal(e.id, r.json.id)
    assert.equal(e.intent, null)
    const r2 = await w.post('/api/message', { text: 'explicit null', intent: null })
    assert.equal(r2.status, 202)
    assert.equal(typeof r2.json.id, 'string')
  } finally {
    await w.close()
  }
})

test('gap a: any other intent value answers 400 {error: "intent"} and sends nothing', async () => {
  const w = await boot()
  try {
    const r = await w.post('/api/message', { text: 'x', intent: 'bogus' })
    assert.equal(r.status, 400)
    assert.deepEqual(r.json, { error: 'intent' })
    assert.equal(w.state().transcript.length, 0)
    assert.equal(stub()?.sent.length ?? 0, 0)
  } finally {
    await w.close()
  }
})

// ===========================================================================
// Gap b: session.queue
// ===========================================================================

test('gap b: session.queue holds a message accepted while a turn runs, and drops it when the SDK takes it', async () => {
  const w = await boot()
  try {
    const first = await w.post('/api/message', { text: 'start the run', intent: 'goal' })
    assert.equal(first.status, 202)
    assert.ok(Array.isArray(w.state().session.queue), 'session.queue is an array')
    await until(() => (stub()?.sent.length ?? 0) >= 1, 'the session to take the first message')
    await until(() => w.state().session.queue.length === 0, 'the first message to leave the queue')

    const second = await w.post('/api/message', { text: 'one more detail', intent: 'add' })
    assert.equal(second.status, 202)
    await until(() => w.state().session.queue.length === 1, 'the second message to be queued')
    const q = w.state().session.queue
    assert.deepEqual(Object.keys(q[0]).sort(), ['at', 'id', 'intent', 'text'])
    assert.equal(q[0].id, second.json.id, 'the queue item carries the message id')
    assert.equal(q[0].text, 'one more detail', 'the queue item text is the text as typed')
    assert.equal(q[0].intent, 'add')
    assert.ok(!Number.isNaN(Date.parse(q[0].at)), 'at is a date-time')
    assertSchema('snapshot', w.store.snapshot())

    stub()!.emit({ type: 'result', subtype: 'success', total_cost_usd: 0.02, modelUsage: {} })
    await until(() => (stub()?.sent.length ?? 0) >= 2, 'the queued message to go out')
    await until(() => w.state().session.queue.length === 0, 'the queue to empty')
    assert.equal(stub()!.sent[1], `${ADD_LINE}\n\none more detail`)
  } finally {
    await w.close()
  }
})

test('gap b: an idle session has queue []', async () => {
  const w = await boot()
  try {
    assert.deepEqual(w.state().session.queue, [])
  } finally {
    await w.close()
  }
})

// ===========================================================================
// Gap d: run.goals
// ===========================================================================

test('gap d: run.goals lists the run goal as id run, then plan.json goals in file order', async () => {
  const goals = [
    { id: 'second-goal', goal: 'Add audit logging', addedAt: '2026-10-27T10:00:00Z', approval: 'auto', approvedAt: '2026-10-27T10:01:00Z' },
    { id: 'third-goal', goal: 'Document the quotas', addedAt: '2026-10-27T11:00:00Z', approval: 'client', approvedAt: null },
  ]
  const w = await storeFor({ 'plan.json': planWith([crewRow('alpha', 'running', 3)], goals) })
  try {
    assert.deepEqual(w.run().goals, [
      { id: 'run', goal: FIRST.goal, approval: 'client', approvedAt: '2026-10-27T08:00:00Z' },
      { id: 'second-goal', goal: 'Add audit logging', approval: 'auto', approvedAt: '2026-10-27T10:01:00Z' },
      { id: 'third-goal', goal: 'Document the quotas', approval: 'client', approvedAt: null },
    ])
    assertSchema('snapshot', w.snapshot())
  } finally {
    w.store.close()
  }
})

test('gap d: a plan.json with no goals array gives just the run goal, and no plan.json gives []', async () => {
  const one = await storeFor({ 'plan.json': planWith([crewRow('alpha', 'running', 3)]) })
  try {
    assert.deepEqual(one.run().goals, [{ id: 'run', goal: FIRST.goal, approval: 'client', approvedAt: '2026-10-27T08:00:00Z' }])
  } finally {
    one.store.close()
  }
  const none = await storeFor({ 'events.jsonl': jsonl([spawn('2026-10-27T09:00:00.000Z', 'alpha', 'alpha')]) })
  try {
    assert.ok(none.run() !== null, 'the Truss dir exists, so run is not null')
    assert.deepEqual(none.run().goals, [])
  } finally {
    none.store.close()
  }
})

// ===========================================================================
// Gap e: usage.live
// ===========================================================================

test('gap e: usage.live sums top-level assistant usage once per message id, adds subagent tokens, and carries an at stamp', async () => {
  const { initialView, foldMessage } = await import(serverUrl('session/index.ts'))
  const assistant = (id: string, usage: unknown, extra: Record<string, unknown> = {}) => ({
    type: 'assistant', parent_tool_use_id: null, ...extra,
    message: { id, content: [{ type: 'text', text: 'ok' }, { type: 'text', text: 'again' }], usage },
  })
  const u1 = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }
  const u2 = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }
  const before = Date.now()
  let v = initialView()
  v = foldMessage(v, assistant('msg_1', u1))
  v = foldMessage(v, assistant('msg_1', u1)) // the stream repeats one message's usage on each content block
  v = foldMessage(v, assistant('msg_2', u2))
  v = foldMessage(v, assistant('msg_3', { input_tokens: 999, output_tokens: 999, cache_read_input_tokens: 999, cache_creation_input_tokens: 999 }, { parent_tool_use_id: 'toolu_x' }))
  v = foldMessage(v, { type: 'system', subtype: 'task_progress', task_id: 't1', usage: { total_tokens: 100 } })
  v = foldMessage(v, { type: 'system', subtype: 'task_progress', task_id: 't1', usage: { total_tokens: 150 } })
  v = foldMessage(v, { type: 'system', subtype: 'task_progress', task_id: 't2', usage: { total_tokens: 50 } })
  v = foldMessage(v, { type: 'result', subtype: 'success', total_cost_usd: 0.5, modelUsage: {} })
  const after = Date.now()
  const live = v.session.usage?.live
  assert.ok(live, 'usage.live is set once a result has arrived')
  assert.equal(live.inputTokens, 11)
  assert.equal(live.outputTokens, 22)
  assert.equal(live.cacheReadInputTokens, 33)
  assert.equal(live.cacheCreationInputTokens, 44)
  assert.equal(live.subagentTokens, 200, 'the latest task_progress total per task id, summed')
  assert.equal(live.totalTokens, 11 + 22 + 33 + 44 + 200)
  const at = Date.parse(live.at)
  assert.ok(at >= before && at <= after, 'at is the server clock when the last message that changed live arrived')
  assert.equal(v.session.usage.costUsd, 0.5, 'result usage keeps its meaning')
  assert.equal(v.session.usage.results, 1)
  assertSchema('session', v.session)
})

test('gap e: a message that changes nothing leaves live.at alone, one that adds tokens moves it', async () => {
  const { initialView, foldMessage } = await import(serverUrl('session/index.ts'))
  const usage = { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 5, cache_creation_input_tokens: 5 }
  const assistant = (id: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { id, content: [{ type: 'text', text: 'hi' }], usage } })
  let v = foldMessage(initialView(), assistant('msg_a'))
  v = foldMessage(v, { type: 'result', subtype: 'success', total_cost_usd: 0.1, modelUsage: {} })
  const first = v.session.usage?.live
  assert.ok(first, 'usage.live is set')
  await new Promise((r) => setTimeout(r, 15))
  v = foldMessage(v, assistant('msg_a'))
  assert.equal(v.session.usage.live.at, first.at, 'a repeat of the same message id changes nothing')
  assert.equal(v.session.usage.live.totalTokens, 20)
  await new Promise((r) => setTimeout(r, 15))
  v = foldMessage(v, assistant('msg_b'))
  assert.equal(v.session.usage.live.totalTokens, 40)
  assert.ok(Date.parse(v.session.usage.live.at) > Date.parse(first.at), 'new tokens move the stamp')
})

// ===========================================================================
// Gap f: crew.estAgents
// ===========================================================================

test('gap f: crew.estAgents comes from plan.json, and is null for a crew only in the events', async () => {
  const w = await storeFor({
    'plan.json': planWith([crewRow('alpha', 'running', 5), crewRow('beta', 'planned', 2)]),
    'events.jsonl': jsonl([spawn('2026-10-27T09:00:00.000Z', 'alpha', 'alpha'), spawn('2026-10-27T09:01:00.000Z', 'ghost', 'ghost')]),
  })
  try {
    const by = Object.fromEntries(w.run().crews.map((c: any) => [c.slug, c]))
    assert.deepEqual(Object.keys(by).sort(), ['alpha', 'beta', 'ghost'])
    assert.equal(by.alpha.estAgents, 5)
    assert.equal(by.beta.estAgents, 2)
    assert.equal(by.ghost.estAgents, null)
    assertSchema('snapshot', w.snapshot())
  } finally {
    w.store.close()
  }
})

// ===========================================================================
// Gap g: crew.stuck
// ===========================================================================

test('gap g: crew.stuck is {kind, since, minutes, detail} from the latest stall event of a running crew', async () => {
  const w = await storeFor({
    'plan.json': planWith([crewRow('alpha', 'running', 3), crewRow('delta', 'running', 2), crewRow('epsilon', 'running', 1)]),
    'events.jsonl': jsonl([
      spawn('2026-10-27T09:00:00.000Z', 'alpha', 'alpha'),
      spawn('2026-10-27T09:01:00.000Z', 'alpha', 'alpha-builder'),
      stall('2026-10-27T09:40:00.000Z', 'alpha', 'alpha-builder', 'agent', 15),
      spawn('2026-10-27T09:02:00.000Z', 'delta', 'delta'),
      stall('2026-10-27T09:55:00.000Z', 'delta', 'delta', 'idle-project-manager', 20),
      spawn('2026-10-27T09:03:00.000Z', 'epsilon', 'epsilon'),
    ]),
  })
  try {
    const by = Object.fromEntries(w.run().crews.map((c: any) => [c.slug, c]))
    const a = by.alpha.stuck
    assert.ok(a && typeof a === 'object', 'alpha is stuck')
    assert.deepEqual(Object.keys(a).sort(), ['detail', 'kind', 'minutes', 'since'])
    assert.equal(a.kind, 'stalled')
    assert.equal(a.minutes, 15)
    assert.equal(a.detail, 'alpha-builder stalled 15 min')
    assert.equal(Date.parse(a.since), Date.parse('2026-10-27T09:25:00.000Z'), 'since is the event ts minus minutes')
    const d = by.delta.stuck
    assert.ok(d && typeof d === 'object', 'delta is stuck')
    assert.equal(d.kind, 'idle-project-manager')
    assert.equal(d.minutes, 20)
    assert.equal(Date.parse(d.since), Date.parse('2026-10-27T09:35:00.000Z'))
    assert.equal(by.epsilon.stuck, null, 'a crew with no stall event is not stuck')
    assertSchema('snapshot', w.snapshot())
  } finally {
    w.store.close()
  }
})

test('gap g: stuck is null when the stalled agent has a later event, or when the crew is not running', async () => {
  const w = await storeFor({
    'plan.json': planWith([crewRow('beta', 'running', 2), crewRow('gamma', 'merged', 2), crewRow('zeta', 'running', 2)]),
    'events.jsonl': jsonl([
      spawn('2026-10-27T09:00:00.000Z', 'beta', 'beta-builder'),
      stall('2026-10-27T09:40:00.000Z', 'beta', 'beta-builder', 'agent', 15),
      { v: 1, ts: '2026-10-27T09:45:00.000Z', event: 'tag', crew: 'beta', agent: 'beta-builder', tag: 'DONE' },
      spawn('2026-10-27T09:00:00.000Z', 'gamma', 'gamma-builder'),
      stall('2026-10-27T09:40:00.000Z', 'gamma', 'gamma-builder', 'agent', 15),
      spawn('2026-10-27T09:00:00.000Z', 'zeta', 'zeta-builder'),
      stall('2026-10-27T09:40:00.000Z', 'zeta', 'zeta-builder', 'agent', 15),
    ]),
  })
  try {
    const by = Object.fromEntries(w.run().crews.map((c: any) => [c.slug, c]))
    assert.ok(by.zeta.stuck && by.zeta.stuck.kind === 'stalled', 'the control crew with an unanswered stall is stuck')
    assert.equal(by.beta.stuck, null, 'the stalled agent has a later event')
    assert.equal(by.gamma.stuck, null, 'a merged crew is not stuck')
  } finally {
    w.store.close()
  }
})

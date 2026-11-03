// Spec tests for ui/app/store/api.ts (ADR-0018 section 9, ADR-0011 Decision 5).
// Written before the implementation exists; the builder treats this file as read-only.
import { test, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { postAnswer, postMessage } from './api.ts'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

interface Call {
  url: string
  init: any
}

function stub(respond: () => Response | Promise<Response>): Call[] {
  const calls: Call[] = []
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init })
    return respond()
  }) as typeof fetch
  return calls
}

function header(init: any, name: string): string | null {
  const h = init?.headers
  if (!h) return null
  if (typeof h.get === 'function') return h.get(name)
  for (const k of Object.keys(h)) if (k.toLowerCase() === name.toLowerCase()) return h[k]
  return null
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

test('postMessage POSTs {text} as JSON to /api/message', async () => {
  const calls = stub(() => json(200, { ok: true }))
  const r = await postMessage('hello there')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/message')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(header(calls[0].init, 'Content-Type'), 'application/json')
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: 'hello there' })
  assert.deepEqual(r, { status: 200, error: null })
})

test('postMessage sends text with quotes and newlines intact', async () => {
  const calls = stub(() => json(200, {}))
  const text = 'a "quoted"\nline & <tag>'
  await postMessage(text)
  assert.deepEqual(JSON.parse(calls[0].init.body), { text })
})

test('postAnswer POSTs the body as given to the encoded request id', async () => {
  const calls = stub(() => json(200, { ok: true }))
  const body = { answers: { 'Which?': 'A, B' } }
  const r = await postAnswer('abc-123', body)
  assert.equal(calls[0].url, '/api/requests/abc-123/answer')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(header(calls[0].init, 'Content-Type'), 'application/json')
  assert.deepEqual(JSON.parse(calls[0].init.body), body)
  assert.deepEqual(r, { status: 200, error: null })
})

test('postAnswer percent-encodes the id', async () => {
  const calls = stub(() => json(200, {}))
  const id = 'a/b c?d#e%f'
  await postAnswer(id, { decision: 'allow' })
  assert.equal(calls[0].url, `/api/requests/${encodeURIComponent(id)}/answer`)
  assert.ok(!calls[0].url.slice('/api/requests/'.length, -'/answer'.length).includes('/'))
})

test('a 409 answered resolves with that status and error', async () => {
  stub(() => json(409, { error: 'answered' }))
  assert.deepEqual(await postAnswer('r1', { decision: 'allow' }), { status: 409, error: 'answered' })
  assert.deepEqual(await postMessage('x'), { status: 409, error: 'answered' })
})

test('a 409 ended resolves with that status and error', async () => {
  stub(() => json(409, { error: 'ended' }))
  assert.deepEqual(await postAnswer('r1', { decision: 'deny', message: 'no' }), { status: 409, error: 'ended' })
  assert.deepEqual(await postMessage('x'), { status: 409, error: 'ended' })
})

test('a fetch that rejects resolves to status 0, error network', async () => {
  globalThis.fetch = (async () => {
    throw new TypeError('Failed to fetch')
  }) as typeof fetch
  assert.deepEqual(await postMessage('x'), { status: 0, error: 'network' })
  assert.deepEqual(await postAnswer('r1', {}), { status: 0, error: 'network' })
})

test('neither function rejects on a failing response', async () => {
  stub(() => json(500, { error: 'boom' }))
  await assert.doesNotReject(postMessage('x'))
  await assert.doesNotReject(postAnswer('r1', {}))
})

// ---- floor-shell seam: intent, id, timeout, error kinds (ADR-0023 section 1) ----

function hangingFetch(): { signals: AbortSignal[] } {
  const signals: AbortSignal[] = []
  globalThis.fetch = ((_url: any, init: any) =>
    new Promise((_resolve, reject) => {
      const sig: AbortSignal = init.signal
      signals.push(sig)
      sig.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })) as typeof fetch
  return { signals }
}

test('postMessage(text) without intent sends exactly {text}', async () => {
  const calls = stub(() => json(200, { ok: true }))
  await postMessage('hi')
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: 'hi' })
  assert.ok(!('intent' in JSON.parse(calls[0].init.body)))
})

test('postMessage(text, intent) sends {text, intent}', async () => {
  const calls = stub(() => json(202, { ok: true, id: 'm-1' }))
  await postMessage('build it', 'goal')
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: 'build it', intent: 'goal' })
  await postMessage('more', 'add')
  assert.deepEqual(JSON.parse(calls[1].init.body), { text: 'more', intent: 'add' })
})

test('a 202 {ok:true,id} resolves {status:202, error:null, id}', async () => {
  stub(() => json(202, { ok: true, id: 'm-42' }))
  assert.deepEqual(await postMessage('x', 'goal'), { status: 202, error: null, id: 'm-42' })
})

test('postAnswer keeps its route and body after the change', async () => {
  const calls = stub(() => json(200, { ok: true }))
  await postAnswer('r 1', { decision: 'allow' })
  assert.equal(calls[0].url, '/api/requests/r%201/answer')
  assert.deepEqual(JSON.parse(calls[0].init.body), { decision: 'allow' })
})

test('every POST passes an AbortSignal to fetch', async () => {
  const calls = stub(() => json(200, {}))
  await postMessage('x')
  await postAnswer('r1', {})
  for (const c of calls) assert.ok(c.init.signal instanceof AbortSignal)
})

test('postMessage times out at 15 s: resolves {status:0, error:timeout}', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] })
  const { signals } = hangingFetch()
  const p = postMessage('x', 'goal')
  ctx.mock.timers.tick(14_999)
  assert.equal(signals[0].aborted, false)
  ctx.mock.timers.tick(1)
  assert.equal(signals[0].aborted, true)
  assert.deepEqual(await p, { status: 0, error: 'timeout' })
})

test('postAnswer times out at 15 s: resolves {status:0, error:timeout}', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] })
  const { signals } = hangingFetch()
  const p = postAnswer('r1', { decision: 'allow' })
  ctx.mock.timers.tick(15_000)
  assert.equal(signals[0].aborted, true)
  assert.deepEqual(await p, { status: 0, error: 'timeout' })
})

test('a response that arrives in time is not turned into a timeout', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] })
  stub(() => json(200, { ok: true }))
  const r = await postMessage('x')
  ctx.mock.timers.tick(20_000)
  assert.deepEqual(r, { status: 200, error: null })
})

test('a non-JSON error body gives error http with that status', async () => {
  stub(() => new Response('<html>bad gateway</html>', { status: 502 }))
  assert.deepEqual(await postMessage('x'), { status: 502, error: 'http' })
  assert.deepEqual(await postAnswer('r1', {}), { status: 502, error: 'http' })
})

test('a JSON {error: string} body gives that string', async () => {
  stub(() => json(400, { error: 'empty-text' }))
  assert.deepEqual(await postMessage(''), { status: 400, error: 'empty-text' })
  assert.deepEqual(await postAnswer('r1', {}), { status: 400, error: 'empty-text' })
})

test('postMessage and postAnswer never reject: network, timeout and http', async (ctx) => {
  globalThis.fetch = (async () => {
    throw new TypeError('Failed to fetch')
  }) as typeof fetch
  await assert.doesNotReject(postMessage('x'))
  await assert.doesNotReject(postAnswer('r1', {}))
  stub(() => new Response('nope', { status: 500 }))
  await assert.doesNotReject(postMessage('x'))
  await assert.doesNotReject(postAnswer('r1', {}))
  ctx.mock.timers.enable({ apis: ['setTimeout'] })
  hangingFetch()
  const a = postMessage('x')
  const b = postAnswer('r1', {})
  ctx.mock.timers.tick(15_000)
  await assert.doesNotReject(a)
  await assert.doesNotReject(b)
})

test('the caller text is passed through unchanged (whitespace, unicode, long)', async () => {
  const calls = stub(() => json(200, {}))
  const text = '  padded \t\né\u{1F600} ' + 'z'.repeat(5000) + '  '
  await postMessage(text, 'add')
  assert.equal(JSON.parse(calls[0].init.body).text, text)
})

// Spec tests for ui/app/store/store.ts (ADR-0018 section 9, ADR-0011 Decision 5).
// Written before the implementation exists; the builder treats this file as read-only.
import { test, mock } from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { createStore } from './store.ts'
import type { SourceLike } from './store.ts'

const INSTANCE = '0123456789abcdef'

class FakeSource implements SourceLike {
  url: string
  closed = false
  listeners = new Map<string, Array<(ev: { data: string }) => void>>()
  constructor(url: string) {
    this.url = url
  }
  addEventListener(type: string, fn: (ev: { data: string }) => void) {
    const l = this.listeners.get(type) ?? []
    l.push(fn)
    this.listeners.set(type, l)
  }
  close() {
    this.closed = true
  }
  // Emits regardless of closed: a real closed source may still deliver a queued event.
  emit(type: string, data: string) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data })
  }
  send(type: string, msg: unknown) {
    this.emit(type, JSON.stringify(msg))
  }
}

function setup() {
  const sources: FakeSource[] = []
  let reloads = 0
  // A fresh storage per store: the default is globalThis.sessionStorage, which Node 25+ has and which every test in
  // this file would share, so one test's reload throttled the next test's (order-dependent failure).
  const kept = new Map<string, string>()
  const store = createStore({
    storage: { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => void kept.set(k, v) },
    open: (url) => {
      const s = new FakeSource(url)
      sources.push(s)
      return s
    },
    reload: () => {
      reloads++
    },
  })
  let calls = 0
  store.subscribe(() => {
    calls++
  })
  return {
    store,
    sources,
    get reloads() {
      return reloads
    },
    get calls() {
      return calls
    },
    get live() {
      return sources.filter((s) => !s.closed)
    },
    get cur() {
      return sources[sources.length - 1]
    },
  }
}

function entry(n: number) {
  return { n, role: 'assistant', text: `line ${n}`, ts: '2026-11-01T01:00:00Z' }
}

function makeState(over: Record<string, unknown> = {}): any {
  return {
    v: 1,
    repo: '/work/repo',
    trussDir: { path: null, exists: false },
    session: {
      status: 'idle',
      sessionId: null,
      model: null,
      claudeCodeVersion: null,
      permissionMode: null,
      plugin: null,
      usage: null,
      backgroundTasks: [],
      error: null,
    },
    requests: [],
    transcript: [],
    run: null,
    decisions: [],
    adrs: [],
    design: { planMd: null, architecture: null, images: [] },
    notices: [],
    ...over,
  }
}

const snap = (state: any, seq = 0) => ({ type: 'snapshot', instance: INSTANCE, seq, state })
const delta = (seq: number, rest: Record<string, unknown>) => ({ type: 'delta', seq, ...rest })

test('start opens /api/events once; a second start opens nothing more', () => {
  const t = setup()
  assert.equal(t.sources.length, 0)
  t.store.start()
  assert.equal(t.sources.length, 1)
  assert.equal(t.sources[0].url, '/api/events')
  t.store.start()
  assert.equal(t.sources.length, 1)
})

test('it listens for the SSE event names snapshot and delta', () => {
  const t = setup()
  t.store.start()
  assert.ok(t.cur.listeners.has('snapshot'))
  assert.ok(t.cur.listeners.has('delta'))
})

test('getState is null before the first snapshot', () => {
  const t = setup()
  t.store.start()
  assert.equal(t.store.getState(), null)
})

test('a snapshot sets the state and notifies once', () => {
  const t = setup()
  t.store.start()
  t.cur.send('snapshot', snap(makeState({ repo: '/a' })))
  assert.equal(t.store.getState()!.repo, '/a')
  assert.equal(t.calls, 1)
})

test('a delta that changes something notifies once and swaps the state reference', () => {
  const t = setup()
  t.store.start()
  t.cur.send('snapshot', snap(makeState(), 0))
  const before = t.store.getState()
  t.cur.send('delta', delta(1, { set: { notices: [{ id: 'no-config', text: 'x' }] } }))
  assert.equal(t.calls, 2)
  assert.notEqual(t.store.getState(), before)
  assert.equal(t.store.getState()!.notices.length, 1)
  assert.equal(t.store.getState()!.repo, before!.repo)
})

test('getState returns the same reference until a message that changed something', () => {
  const t = setup()
  t.store.start()
  t.cur.send('snapshot', snap(makeState({ transcript: [entry(1), entry(2)] }), 4))
  const s = t.store.getState()
  assert.equal(t.store.getState(), s)
  t.cur.send('delta', delta(3, { set: { notices: [] } })) // old seq: ignored
  t.cur.send('delta', delta(5, { append: { transcript: [entry(2)] } })) // applied, nothing new
  assert.equal(t.store.getState(), s)
  assert.equal(t.calls, 1)
})

test('ignored messages never notify', () => {
  const t = setup()
  t.store.start()
  t.cur.send('snapshot', snap(makeState(), 5))
  t.cur.send('delta', delta(5, { set: { notices: [{ id: 'a', text: 'b' }] } }))
  t.cur.send('delta', delta(2, { set: { notices: [{ id: 'a', text: 'b' }] } }))
  assert.equal(t.calls, 1)
  assert.deepEqual(t.store.getState()!.notices, [])
})

test('a gap resyncs: the source is closed, a new /api/events opens, the held state stays', () => {
  const t = setup()
  t.store.start()
  t.cur.send('snapshot', snap(makeState({ repo: '/kept' }), 2))
  const first = t.cur
  const held = t.store.getState()
  const calls = t.calls
  first.send('delta', delta(9, { set: { notices: [] } }))
  assert.equal(first.closed, true)
  assert.equal(t.sources.length, 2)
  assert.equal(t.cur.url, '/api/events')
  assert.equal(t.cur.closed, false)
  assert.equal(t.store.getState(), held)
  assert.equal(t.calls, calls)
  // the fresh connection's snapshot is applied
  t.cur.send('snapshot', snap(makeState({ repo: '/fresh' }), 9))
  assert.equal(t.store.getState()!.repo, '/fresh')
  assert.equal(t.calls, calls + 1)
})

test('a delta before any snapshot resyncs', () => {
  const t = setup()
  t.store.start()
  const first = t.cur
  first.send('delta', delta(1, { set: { notices: [] } }))
  assert.equal(first.closed, true)
  assert.equal(t.sources.length, 2)
  assert.equal(t.store.getState(), null)
  assert.equal(t.calls, 0)
})

test('events a closed source still emits are ignored', () => {
  const t = setup()
  t.store.start()
  t.cur.send('snapshot', snap(makeState({ repo: '/a' }), 0))
  const old = t.cur
  old.send('delta', delta(5, { set: { notices: [] } })) // gap: resync, old is now closed
  const calls = t.calls
  const state = t.store.getState()
  old.send('snapshot', snap(makeState({ repo: '/stale' }), 0))
  old.send('delta', delta(1, { set: { notices: [{ id: 'x', text: 'y' }] } }))
  assert.equal(t.store.getState(), state)
  assert.equal(t.calls, calls)
  assert.equal(t.sources.length, 2)
})

test('a reconnect storm: ten resyncs in a row leave exactly one open source', () => {
  const t = setup()
  t.store.start()
  t.cur.send('snapshot', snap(makeState(), 0))
  for (let i = 0; i < 10; i++) {
    const s = t.cur
    s.send('delta', delta(100 + i, { set: { notices: [] } }))
    // the same closed source delivering more gap events must not open more sources
    s.send('delta', delta(200 + i, { set: { notices: [] } }))
  }
  assert.equal(t.live.length, 1)
  assert.equal(t.sources.length, 11)
  assert.equal(t.live[0], t.cur)
  assert.equal(t.store.getState()!.repo, '/work/repo')
})

test('a snapshot with v other than 1 calls reload once and notifies nobody', () => {
  const t = setup()
  t.store.start()
  t.cur.send('snapshot', snap(makeState({ v: 2 })))
  assert.equal(t.reloads, 1)
  assert.equal(t.calls, 0)
  assert.equal(t.store.getState(), null)
})

test('a v mismatch after a good snapshot keeps the held state and reloads', () => {
  const t = setup()
  t.store.start()
  t.cur.send('snapshot', snap(makeState({ repo: '/a' })))
  const s = t.store.getState()
  t.cur.send('snapshot', snap(makeState({ v: 2, repo: '/b' })))
  assert.equal(t.reloads, 1)
  assert.equal(t.calls, 1)
  assert.equal(t.store.getState(), s)
})

test('malformed JSON data is ignored without throwing', () => {
  const t = setup()
  t.store.start()
  t.cur.send('snapshot', snap(makeState(), 0))
  const s = t.store.getState()
  const calls = t.calls
  assert.doesNotThrow(() => t.cur.emit('snapshot', '{not json'))
  assert.doesNotThrow(() => t.cur.emit('delta', ''))
  assert.doesNotThrow(() => t.cur.emit('delta', 'undefined'))
  assert.equal(t.store.getState(), s)
  assert.equal(t.calls, calls)
  assert.equal(t.reloads, 0)
  assert.equal(t.live.length, 1)
})

test('unsubscribe stops notifications for that subscriber only', () => {
  const t = setup()
  let a = 0
  let b = 0
  const offA = t.store.subscribe(() => {
    a++
  })
  t.store.subscribe(() => {
    b++
  })
  t.store.start()
  t.cur.send('snapshot', snap(makeState(), 0))
  offA()
  t.cur.send('delta', delta(1, { set: { notices: [{ id: 'a', text: 'b' }] } }))
  assert.equal(a, 1)
  assert.equal(b, 2)
})

test('each subscriber is called once per applied message', () => {
  const t = setup()
  let n = 0
  t.store.subscribe(() => {
    n++
  })
  t.store.start()
  t.cur.send('snapshot', snap(makeState(), 0))
  t.cur.send('delta', delta(1, { set: { notices: [{ id: 'a', text: 'b' }] } }))
  t.cur.send('delta', delta(2, { append: { transcript: [entry(1)] } }))
  assert.equal(n, 3)
})

test('stop closes the source and later events change nothing', () => {
  const t = setup()
  t.store.start()
  t.cur.send('snapshot', snap(makeState(), 0))
  const s = t.cur
  const state = t.store.getState()
  const calls = t.calls
  t.store.stop()
  assert.equal(s.closed, true)
  s.send('delta', delta(1, { set: { notices: [{ id: 'a', text: 'b' }] } }))
  s.send('delta', delta(7, { set: { notices: [] } })) // would be a resync
  assert.equal(t.store.getState(), state)
  assert.equal(t.calls, calls)
  assert.equal(t.sources.length, 1)
})

test('stop before start does not throw', () => {
  const t = setup()
  assert.doesNotThrow(() => t.store.stop())
  assert.equal(t.sources.length, 0)
})

// ---- floor-shell seam: connection, lastMessageAt, listeners, gap fields (ADR-0023 section 1) ----

test('connection: connecting after start() and before any message', () => {
  const t = setup()
  t.store.start()
  assert.equal(t.store.getConnection(), 'connecting')
  assert.equal(t.store.getLastMessageAt(), null)
})

test('connection: the store registers listeners for error and open on the source', () => {
  const t = setup()
  t.store.start()
  assert.ok(t.cur.listeners.has('error'))
  assert.ok(t.cur.listeners.has('open'))
})

test('connection: an error event moves live to reconnecting, the next delta moves it back to live', () => {
  const t = setup()
  t.store.start()
  t.cur.send('snapshot', snap(makeState(), 0))
  assert.equal(t.store.getConnection(), 'live')
  t.cur.emit('error', '')
  assert.equal(t.store.getConnection(), 'reconnecting')
  t.cur.send('delta', delta(1, { set: { notices: [{ id: 'a', text: 'b' }] } }))
  assert.equal(t.store.getConnection(), 'live')
})

test('connection: an error before any snapshot is reconnecting, the next snapshot is live', () => {
  const t = setup()
  t.store.start()
  t.cur.emit('error', '')
  assert.equal(t.store.getConnection(), 'reconnecting')
  t.cur.send('snapshot', snap(makeState(), 0))
  assert.equal(t.store.getConnection(), 'live')
})

test('connection: an open event alone does not make it live', () => {
  const t = setup()
  t.store.start()
  t.cur.emit('open', '')
  assert.equal(t.store.getConnection(), 'connecting')
  t.cur.emit('error', '')
  t.cur.emit('open', '')
  assert.equal(t.store.getConnection(), 'reconnecting')
})

test('connection: subscribers are notified on each connection change', () => {
  const t = setup()
  t.store.start()
  const seen: string[] = []
  t.store.subscribe(() => {
    seen.push(t.store.getConnection())
  })
  t.cur.send('snapshot', snap(makeState(), 0))
  t.cur.emit('error', '')
  t.cur.send('delta', delta(1, { set: { notices: [{ id: 'a', text: 'b' }] } }))
  assert.deepEqual(seen, ['live', 'reconnecting', 'live'])
})

test('connection: a delta that changes nothing still returns the connection to live and notifies', () => {
  const t = setup()
  t.store.start()
  t.cur.send('snapshot', snap(makeState({ transcript: [entry(1)] }), 0))
  t.cur.emit('error', '')
  const calls = t.calls
  t.cur.send('delta', delta(1, { append: { transcript: [entry(1)] } })) // applied, nothing new
  assert.equal(t.store.getConnection(), 'live')
  assert.ok(t.calls > calls)
})

test('connection: a repeated error while reconnecting does not notify again', () => {
  const t = setup()
  t.store.start()
  t.cur.send('snapshot', snap(makeState(), 0))
  t.cur.emit('error', '')
  const calls = t.calls
  t.cur.emit('error', '')
  assert.equal(t.calls, calls)
})

test('getState stays null until the first snapshot, an error does not change that', () => {
  const t = setup()
  t.store.start()
  t.cur.emit('error', '')
  assert.equal(t.store.getState(), null)
})

test('getState is never null again after a snapshot, also after error events', () => {
  const t = setup()
  t.store.start()
  t.cur.send('snapshot', snap(makeState({ repo: '/kept' }), 0))
  const s = t.store.getState()
  t.cur.emit('error', '')
  assert.equal(t.store.getState(), s)
  t.cur.emit('error', '')
  assert.equal(t.store.getState()!.repo, '/kept')
})

test('lastMessageAt: null before the first message, the epoch ms after each snapshot or delta', (ctx) => {
  ctx.mock.timers.enable({ apis: ['Date'], now: 1_000 })
  const t = setup()
  t.store.start()
  assert.equal(t.store.getLastMessageAt(), null)
  t.cur.send('snapshot', snap(makeState(), 0))
  assert.equal(t.store.getLastMessageAt(), 1_000)
  ctx.mock.timers.tick(2_500)
  t.cur.send('delta', delta(1, { set: { notices: [{ id: 'a', text: 'b' }] } }))
  assert.equal(t.store.getLastMessageAt(), 3_500)
})

test('lastMessageAt: an error event does not change it', (ctx) => {
  ctx.mock.timers.enable({ apis: ['Date'], now: 5_000 })
  const t = setup()
  t.store.start()
  t.cur.send('snapshot', snap(makeState(), 0))
  ctx.mock.timers.tick(10_000)
  t.cur.emit('error', '')
  assert.equal(t.store.getLastMessageAt(), 5_000)
})

test('gap fields pass through a snapshot whole: transcript id and intent, queue, usage.live, run.goals, crew estAgents and stuck', () => {
  const t = setup()
  t.store.start()
  const transcript = [
    { n: 1, role: 'user', text: 'do it', ts: '2026-11-01T01:00:00Z', id: 'm-1', intent: 'goal' },
    { n: 2, role: 'assistant', text: 'ok', ts: '2026-11-01T01:00:01Z', id: null, intent: null },
  ]
  const session = {
    ...makeState().session,
    queue: [{ id: 'm-2', text: 'later', intent: 'add', at: '2026-11-01T01:00:02Z' }],
    usage: { live: { inputTokens: 1, outputTokens: 2 } },
  }
  const run = {
    goals: [{ id: 'g1', goal: 'ship', approval: 'approved', approvedAt: '2026-11-01T00:00:00Z' }],
    crews: [{ slug: 'floor-shell', estAgents: 4, stuck: { since: '2026-11-01T01:00:00Z', reason: 'x' } }],
  }
  t.cur.send('snapshot', snap(makeState({ transcript, session, run }), 0))
  const got = t.store.getState() as any
  assert.deepEqual(got.transcript, transcript)
  assert.deepEqual(got.session.queue, session.queue)
  assert.deepEqual(got.session.usage.live, session.usage.live)
  assert.deepEqual(got.run.goals, run.goals)
  assert.equal(got.run.crews[0].estAgents, 4)
  assert.deepEqual(got.run.crews[0].stuck, run.crews[0].stuck)
})

test('gap fields pass through a delta set and append whole', () => {
  const t = setup()
  t.store.start()
  t.cur.send('snapshot', snap(makeState(), 0))
  const session = {
    ...makeState().session,
    queue: [{ id: 'm-3', text: 'q', intent: null, at: '2026-11-01T01:00:02Z' }],
    usage: { live: { inputTokens: 9, outputTokens: 8 } },
  }
  const run = {
    goals: [{ id: 'g2', goal: 'g', approval: 'pending', approvedAt: null }],
    crews: [{ slug: 'c', estAgents: null, stuck: null }],
  }
  t.cur.send('delta', delta(1, { set: { session, run } }))
  const added = { n: 1, role: 'user', text: 'hi', ts: '2026-11-01T01:00:03Z', id: 'm-9', intent: 'add' }
  t.cur.send('delta', delta(2, { append: { transcript: [added] } }))
  const got = t.store.getState() as any
  assert.deepEqual(got.session.queue, session.queue)
  assert.deepEqual(got.session.usage.live, session.usage.live)
  assert.deepEqual(got.run.goals, run.goals)
  assert.deepEqual(got.run.crews[0], run.crews[0])
  assert.deepEqual(got.transcript[0], added)
})

test('react.ts exports useConnection and useRun (static check)', () => {
  const text = readFileSync(new URL('./react.ts', import.meta.url), 'utf8')
  assert.match(text, /export\s+(function|const)\s+useConnection\b/)
  assert.match(text, /export\s+(function|const)\s+useRun\b/)
})

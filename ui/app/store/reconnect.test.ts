// Spec tests for the store's reload throttle and EventSource re-open (ui-store-fixes).
// Written before the implementation exists; the builder treats this file as read-only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from './store.ts'

const INSTANCE = '0123456789abcdef'

class FakeSource {
  url: string
  closed = false
  readyState?: number
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
  emit(type: string, data: string) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data })
  }
  send(type: string, msg: unknown) {
    this.emit(type, JSON.stringify(msg))
  }
}

class MapStorage {
  m = new Map<string, string>()
  getItem(k: string): string | null {
    return this.m.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v)
  }
}

interface Timer {
  fn: () => void
  ms: number
}

function setup(opts: { storage?: MapStorage; readyState?: number } = {}) {
  const sources: FakeSource[] = []
  const timers: Timer[] = []
  const clock = { t: 1_000_000 }
  const storage = opts.storage ?? new MapStorage()
  let reloads = 0
  const deps = {
    open: (url: string) => {
      const s = new FakeSource(url)
      if (opts.readyState !== undefined) s.readyState = opts.readyState
      sources.push(s)
      return s
    },
    reload: () => {
      reloads++
    },
    storage,
    now: () => clock.t,
    setTimer: (fn: () => void, ms: number) => {
      timers.push({ fn, ms })
      return timers.length
    },
  }
  const store = createStore(deps as never)
  return {
    store,
    sources,
    timers,
    clock,
    storage,
    get reloads() {
      return reloads
    },
  }
}

const snap2 = { type: 'snapshot', instance: INSTANCE, seq: 0, state: { v: 2 } }

test('two v:2 snapshots inside 5 s give exactly one reload', () => {
  const h = setup()
  h.store.start()
  h.sources[0]!.send('snapshot', snap2)
  h.clock.t += 4000
  h.sources[0]!.send('snapshot', snap2)
  assert.equal(h.reloads, 1)
})

test('a v:2 snapshot 5 s after the first reload gives a second reload', () => {
  const h = setup()
  h.store.start()
  h.sources[0]!.send('snapshot', snap2)
  assert.equal(h.reloads, 1)
  h.clock.t += 5000
  h.sources[0]!.send('snapshot', snap2)
  assert.equal(h.reloads, 2)
})

test('the reload time is written under truss-ui-reload in the storage', () => {
  const h = setup()
  h.store.start()
  h.sources[0]!.send('snapshot', snap2)
  assert.equal(h.storage.getItem('truss-ui-reload'), String(h.clock.t))
})

test('a second store sharing the storage within 5 s does not reload (across page loads)', () => {
  const storage = new MapStorage()
  const a = setup({ storage })
  a.store.start()
  a.sources[0]!.send('snapshot', snap2)
  assert.equal(a.reloads, 1)
  const b = setup({ storage })
  b.clock.t = a.clock.t + 2000
  b.store.start()
  b.sources[0]!.send('snapshot', snap2)
  assert.equal(b.reloads, 0)
})

test('a CLOSED error on the current source schedules a 1000 ms re-open that opens exactly one new source', () => {
  const h = setup({ readyState: 2 })
  h.store.start()
  h.sources[0]!.emit('error', '')
  assert.equal(h.timers.length, 1)
  assert.equal(h.timers[0]?.ms, 1000)
  assert.equal(h.sources.length, 1)
  assert.ok(h.timers[0])
  h.timers[0].fn()
  assert.equal(h.sources.length, 2)
  assert.equal(h.sources[1]!.url, '/api/events')
})

test('stop() before the re-open timer runs opens no source', () => {
  const h = setup({ readyState: 2 })
  h.store.start()
  h.sources[0]!.emit('error', '')
  assert.equal(h.timers.length, 1)
  h.store.stop()
  assert.ok(h.timers[0])
  h.timers[0].fn()
  assert.equal(h.sources.length, 1)
})

test('a CLOSED error after stop() schedules nothing and opens no source', () => {
  const h = setup({ readyState: 2 })
  h.store.start()
  const first = h.sources[0]!
  h.store.stop()
  first.emit('error', '')
  assert.equal(h.timers.length, 0)
  assert.equal(h.sources.length, 1)
})

test('an error on a source with no readyState schedules nothing', () => {
  const h = setup()
  h.store.start()
  h.sources[0]!.emit('error', '')
  assert.equal(h.store.getConnection(), 'reconnecting')
  assert.equal(h.timers.length, 0)
  assert.equal(h.sources.length, 1)
})

test('an error with readyState 0 (CONNECTING) schedules nothing: EventSource retries by itself', () => {
  const h = setup({ readyState: 0 })
  h.store.start()
  h.sources[0]!.emit('error', '')
  assert.equal(h.timers.length, 0)
  assert.equal(h.sources.length, 1)
})

test('a CLOSED error from a replaced source schedules nothing', () => {
  const h = setup({ readyState: 2 })
  h.store.start()
  const old = h.sources[0]!
  old.emit('error', '')
  assert.equal(h.timers.length, 1)
  assert.ok(h.timers[0])
  h.timers[0].fn()
  assert.equal(h.sources.length, 2)
  old.emit('error', '')
  assert.equal(h.timers.length, 1)
})

// Spec tests for ui/app/store/wire.ts (ADR-0018 section 9, ADR-0011 Decision 5).
// Written before the implementation exists; the builder treats this file as read-only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOTHING_HELD, TRANSCRIPT_LIMIT, reduce } from './wire.ts'
import type { Held } from './wire.ts'

const INSTANCE = '0123456789abcdef'
const OTHER = 'fedcba9876543210'

function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const k of Object.keys(o as object)) deepFreeze((o as Record<string, unknown>)[k])
  }
  return o
}

function entry(n: number, text = `line ${n}`) {
  return { n, role: 'assistant', text, ts: '2026-11-01T01:00:00Z' }
}

function entries(from: number, to: number) {
  const out = []
  for (let n = from; n <= to; n++) out.push(entry(n))
  return out
}

// A state that matches state.schema.json.
function makeState(over: Record<string, unknown> = {}): any {
  return {
    v: 1,
    repo: '/work/repo',
    trussDir: { path: '/work/repo/.git/truss/abc', exists: true },
    session: {
      status: 'running',
      sessionId: 's-1',
      model: 'claude-sonnet-5-5',
      claudeCodeVersion: '2.0.0',
      permissionMode: 'default',
      plugin: null,
      usage: null,
      backgroundTasks: [],
      error: null,
    },
    requests: [],
    transcript: [entry(1), entry(2)],
    run: {
      goal: 'g',
      version: 3,
      approval: 'auto',
      approvedAt: '2026-11-01T01:41:19Z',
      crews: [],
      skipped: [],
    },
    decisions: [{ n: 1, run: null, text: 'a decision' }],
    adrs: [{ file: '0001-x.md', title: 'X', status: 'Accepted' }],
    design: { planMd: null, architecture: null, images: [] },
    notices: [],
    retro: null,
    ...over,
  }
}

function snap(state: any, seq = 0, instance = INSTANCE): any {
  return { type: 'snapshot', instance, seq, state }
}

function held(state: any = makeState(), seq = 4): Held {
  return { instance: INSTANCE, seq, state }
}

test('NOTHING_HELD is the empty start', () => {
  assert.deepEqual(NOTHING_HELD, { instance: null, seq: 0, state: null })
})

test('TRANSCRIPT_LIMIT is 500', () => {
  assert.equal(TRANSCRIPT_LIMIT, 500)
})

test('snapshot with v 1 is applied: instance, seq and state come from the message', () => {
  const state = makeState()
  const msg = deepFreeze(snap(state, 7))
  const r = reduce(deepFreeze({ ...NOTHING_HELD }), msg)
  assert.equal(r.outcome, 'applied')
  assert.equal(r.held.instance, INSTANCE)
  assert.equal(r.held.seq, 7)
  assert.deepEqual(r.held.state, state)
})

test('snapshot changed lists every state key', () => {
  const state = makeState()
  const r = reduce(NOTHING_HELD, snap(state))
  assert.deepEqual([...r.changed].sort(), Object.keys(state).sort())
})

test('snapshot replaces the whole held state and the held seq, even a lower seq or another instance', () => {
  const old = held(makeState({ repo: '/old' }), 40)
  const next = makeState({ repo: '/new', transcript: [] })
  const r = reduce(old, snap(next, 2, OTHER))
  assert.equal(r.outcome, 'applied')
  assert.equal(r.held.instance, OTHER)
  assert.equal(r.held.seq, 2)
  assert.equal(r.held.state!.repo, '/new')
  assert.deepEqual(r.held.state!.transcript, [])
})

test('snapshot with v other than 1 gives reload and the very same held object', () => {
  for (const v of [2, 0, 999]) {
    const h = held()
    const r = reduce(h, snap(makeState({ v })))
    assert.equal(r.outcome, 'reload')
    assert.equal(r.held, h)
    assert.deepEqual(r.changed, [])
  }
  const r = reduce(NOTHING_HELD, snap(makeState({ v: 2 })))
  assert.equal(r.outcome, 'reload')
  assert.equal(r.held, NOTHING_HELD)
})

test('a delta before any snapshot gives resync and the same held object', () => {
  const msg: any = { type: 'delta', seq: 1, set: { notices: [] } }
  const r = reduce(NOTHING_HELD, msg)
  assert.equal(r.outcome, 'resync')
  assert.equal(r.held, NOTHING_HELD)
  assert.deepEqual(r.changed, [])
})

test('a delta with seq at or below held.seq is ignored', () => {
  for (const seq of [4, 3, 1]) {
    const h = held(makeState(), 4)
    const r = reduce(h, { type: 'delta', seq, set: { notices: [{ id: 'x', text: 'y' }] } } as any)
    assert.equal(r.outcome, 'ignored')
    assert.equal(r.held, h)
    assert.deepEqual(r.changed, [])
  }
})

test('a delta that skips a seq gives resync', () => {
  for (const seq of [6, 7, 100]) {
    const h = held(makeState(), 4)
    const r = reduce(h, { type: 'delta', seq, set: { notices: [] } } as any)
    assert.equal(r.outcome, 'resync')
    assert.equal(r.held, h)
    assert.deepEqual(r.changed, [])
  }
})

test('the next delta replaces each set key whole, not merged', () => {
  const state = makeState({
    session: { ...makeState().session, status: 'running', model: 'm1', error: null },
  })
  const h = held(state, 4)
  const newSession = {
    status: 'waiting',
    sessionId: null,
    model: null,
    claudeCodeVersion: null,
    permissionMode: null,
    plugin: null,
    usage: null,
    backgroundTasks: [],
    error: null,
  }
  const r = reduce(deepFreeze(h), deepFreeze({ type: 'delta', seq: 5, set: { session: newSession } } as any))
  assert.equal(r.outcome, 'applied')
  assert.deepEqual(r.held.state!.session, newSession)
  assert.equal(r.held.state!.session.model, null)
  assert.deepEqual(r.changed, ['session'])
  assert.equal(r.held.seq, 5)
  assert.equal(r.held.instance, INSTANCE)
})

test('a delta with several set keys reports each key in changed', () => {
  const r = reduce(held(), {
    type: 'delta',
    seq: 5,
    set: { notices: [{ id: 'no-config', text: 't' }], decisions: [] },
  } as any)
  assert.deepEqual([...r.changed].sort(), ['decisions', 'notices'])
})

test('untouched state keys keep their reference', () => {
  const state = makeState()
  const h = held(state, 4)
  const r = reduce(h, { type: 'delta', seq: 5, set: { notices: [{ id: 'a', text: 'b' }] } } as any)
  for (const k of Object.keys(state)) {
    if (k === 'notices') continue
    assert.equal(r.held.state![k as keyof typeof state], state[k], `${k} kept by reference`)
  }
  assert.notEqual(r.held.state!.notices, state.notices)
})

test('append.transcript appends entries above the last held n', () => {
  const h = held(makeState({ transcript: entries(1, 2) }), 4)
  const r = reduce(deepFreeze(h), deepFreeze({ type: 'delta', seq: 5, append: { transcript: [entry(3), entry(4)] } } as any))
  assert.equal(r.outcome, 'applied')
  assert.deepEqual(r.held.state!.transcript.map((e: any) => e.n), [1, 2, 3, 4])
  assert.deepEqual(r.changed, ['transcript'])
})

test('a replayed overlap appends nothing twice', () => {
  const h = held(makeState({ transcript: entries(1, 3) }), 4)
  const r = reduce(h, { type: 'delta', seq: 5, append: { transcript: [entry(2), entry(3), entry(4)] } } as any)
  assert.deepEqual(r.held.state!.transcript.map((e: any) => e.n), [1, 2, 3, 4])
})

test('a delta of only replayed entries changes nothing but still advances seq', () => {
  const state = makeState({ transcript: entries(1, 3) })
  const h = held(state, 4)
  const r = reduce(h, { type: 'delta', seq: 5, append: { transcript: [entry(2), entry(3)] } } as any)
  assert.equal(r.outcome, 'applied')
  assert.deepEqual(r.changed, [])
  assert.equal(r.held.seq, 5)
  assert.deepEqual(r.held.state!.transcript.map((e: any) => e.n), [1, 2, 3])
  const next = reduce(r.held, { type: 'delta', seq: 6, append: { transcript: [entry(4)] } } as any)
  assert.equal(next.outcome, 'applied')
  assert.deepEqual(next.held.state!.transcript.map((e: any) => e.n), [1, 2, 3, 4])
})

test('append into an empty transcript works', () => {
  const h = held(makeState({ transcript: [] }), 0)
  const r = reduce(h, { type: 'delta', seq: 1, append: { transcript: [entry(1)] } } as any)
  assert.deepEqual(r.held.state!.transcript.map((e: any) => e.n), [1])
})

test('set and append in one delta apply both', () => {
  const h = held(makeState({ transcript: entries(1, 2) }), 4)
  const r = reduce(h, {
    type: 'delta',
    seq: 5,
    set: { notices: [{ id: 'a', text: 'b' }] },
    append: { transcript: [entry(3)] },
  } as any)
  assert.deepEqual([...r.changed].sort(), ['notices', 'transcript'])
  assert.equal(r.held.state!.transcript.length, 3)
  assert.equal(r.held.state!.notices.length, 1)
})

test('the transcript never holds more than TRANSCRIPT_LIMIT entries, newest kept', () => {
  const h = held(makeState({ transcript: entries(1, TRANSCRIPT_LIMIT - 2) }), 4)
  const r = reduce(h, { type: 'delta', seq: 5, append: { transcript: entries(TRANSCRIPT_LIMIT - 1, TRANSCRIPT_LIMIT + 5) } } as any)
  const t = r.held.state!.transcript
  assert.equal(t.length, TRANSCRIPT_LIMIT)
  assert.equal(t[t.length - 1].n, TRANSCRIPT_LIMIT + 5)
  assert.equal(t[0].n, 6)
})

test('a full transcript drops the oldest one per appended entry', () => {
  const h = held(makeState({ transcript: entries(1, TRANSCRIPT_LIMIT) }), 4)
  const r = reduce(h, { type: 'delta', seq: 5, append: { transcript: [entry(TRANSCRIPT_LIMIT + 1)] } } as any)
  const t = r.held.state!.transcript
  assert.equal(t.length, TRANSCRIPT_LIMIT)
  assert.equal(t[0].n, 2)
  assert.equal(t[t.length - 1].n, TRANSCRIPT_LIMIT + 1)
})

test('deltas apply in a row after a snapshot', () => {
  let r = reduce(NOTHING_HELD, snap(makeState({ transcript: [] }), 10))
  r = reduce(r.held, { type: 'delta', seq: 11, append: { transcript: [entry(1)] } } as any)
  r = reduce(r.held, { type: 'delta', seq: 12, set: { notices: [] } } as any)
  r = reduce(r.held, { type: 'delta', seq: 13, append: { transcript: [entry(2)] } } as any)
  assert.equal(r.held.seq, 13)
  assert.deepEqual(r.held.state!.transcript.map((e: any) => e.n), [1, 2])
})

test('reduce never mutates its inputs (applied snapshot and delta)', () => {
  const h = deepFreeze(held(makeState({ transcript: entries(1, 3) }), 4))
  const d = deepFreeze({
    type: 'delta',
    seq: 5,
    set: { notices: [{ id: 'a', text: 'b' }] },
    append: { transcript: [entry(4)] },
  } as any)
  assert.doesNotThrow(() => reduce(h, d))
  const s = deepFreeze(snap(makeState(), 3))
  assert.doesNotThrow(() => reduce(h, s))
  assert.doesNotThrow(() => reduce(NOTHING_HELD, s))
})

test('reduce never mutates its inputs (non-applied outcomes)', () => {
  const h = deepFreeze(held(makeState(), 4))
  assert.doesNotThrow(() => reduce(h, deepFreeze({ type: 'delta', seq: 2, set: { notices: [] } } as any)))
  assert.doesNotThrow(() => reduce(h, deepFreeze({ type: 'delta', seq: 9, set: { notices: [] } } as any)))
  assert.doesNotThrow(() => reduce(h, deepFreeze(snap(makeState({ v: 2 })))))
})

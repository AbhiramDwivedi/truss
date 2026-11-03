// Contract check for the client store against the D2 fixtures (ADR-0023 section 7, ADR-0018 section 9).
// Written before ui/app/store/store.ts exists: every case fails until floor-shell builds it. Each case folds
// one state of fixtures/run into the store as a single snapshot and reads getState() back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const here = import.meta.dirname
const storeFile = path.resolve(here, '..', '..', 'app', 'store', 'store.ts')
const fixtureRoot = path.resolve(here, '../fixtures/run') // ui/contract/fixtures/run

interface Listener { (ev: { data: string }): void }

// A fake SourceLike (addEventListener(type, listener) and close()) that the case feeds by hand.
function fakeSource() {
  const listeners = new Map<string, Listener[]>()
  return {
    closed: false,
    addEventListener(type: string, fn: Listener) { listeners.set(type, [...(listeners.get(type) ?? []), fn]) },
    close() { this.closed = true },
    emit(type: string, msg: unknown) { for (const fn of listeners.get(type) ?? []) fn({ data: JSON.stringify(msg) }) },
  }
}

// Folds <state>/state.json (or <state>/<file>) into a fresh store through one snapshot and returns both sides.
async function fold(file: string): Promise<{ fixture: any; got: any }> {
  const mod: any = await import(storeFile)
  const fixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, file), 'utf8'))
  const src = fakeSource()
  const store = mod.createStore({ open: () => src, reload: () => { throw new Error('reload') } })
  store.start()
  src.emit('snapshot', { type: 'snapshot', instance: '0123456789abcdef', seq: 0, state: fixture })
  const got = store.getState()
  assert.ok(got, 'getState() is null after a snapshot')
  return { fixture, got }
}

// The six gap fields (ADR-0023 gaps a, b, d, e, f, g), each compared with what the fixture holds.
function assertGapFields({ fixture, got }: { fixture: any; got: any }): void {
  // gap b: session.queue
  assert.deepEqual(got.session.queue, fixture.session.queue, 'queue')
  // gap e: usage.live
  assert.deepEqual(got.session.usage?.live, fixture.session.usage?.live, 'live')
  // gap d: run.goals, the first goal as id run
  assert.deepEqual(got.run?.goals, fixture.run?.goals, 'goals')
  if (fixture.run) assert.equal(got.run.goals[0].id, 'run', 'the first goal is run')
  // gap f: crew.estAgents
  assert.deepEqual((got.run?.crews ?? []).map((c: any) => [c.slug, c.estAgents]), (fixture.run?.crews ?? []).map((c: any) => [c.slug, c.estAgents]), 'estAgents')
  // gap g: crew.stuck
  assert.deepEqual((got.run?.crews ?? []).map((c: any) => [c.slug, c.stuck]), (fixture.run?.crews ?? []).map((c: any) => [c.slug, c.stuck]), 'stuck')
  // gap a: transcript id and intent
  assert.deepEqual(got.transcript.map((e: any) => [e.n, e.id, e.intent]), fixture.transcript.map((e: any) => [e.n, e.id, e.intent]), 'intent')
  assert.deepEqual(got.requests, fixture.requests)
}

test('empty', async () => {
  const r = await fold('empty/state.json')
  assertGapFields(r)
  assert.deepEqual(r.got.session.queue, [])
  assert.equal(r.got.run, null)
  assert.equal(r.got.session.usage?.live, undefined)
})

test('question', async () => {
  const r = await fold('question/state.json')
  assertGapFields(r)
  assert.equal(r.got.run.goals[0].id, 'run')
  assert.equal(r.got.requests[0].questions[0].options[0].recommended, true)
  assert.deepEqual(r.got.transcript.map((e: any) => e.intent), ['goal', null])
})

test('approval', async () => {
  const r = await fold('approval/state.json')
  assertGapFields(r)
  assert.deepEqual(r.got.requests.map((q: any) => q.kind), ['reply', 'permission'])
  assert.deepEqual(r.got.run.crews.map((c: any) => c.estAgents), [5, 4])
})

test('follow-up', async () => {
  const r = await fold('follow-up/state.json')
  assertGapFields(r)
  assert.equal(r.got.session.queue.length, 1)
  assert.equal(r.got.session.queue[0].intent, 'add')
  assert.deepEqual(r.got.transcript.filter((e: any) => e.role === 'user').map((e: any) => e.intent), ['goal', 'add', null, 'add'])
})

test('crews-running', async () => {
  const r = await fold('crews-running/state.json')
  assertGapFields(r)
  assert.deepEqual(r.got.run.crews.map((c: any) => c.estAgents), [5, 4, 3, 2])
  assert.ok(r.got.run.crews.every((c: any) => c.stuck === null))
})

test('stuck-crew', async () => {
  const r = await fold('stuck-crew/state.json')
  assertGapFields(r)
  const stuck = r.got.run.crews.filter((c: any) => c.stuck !== null)
  assert.equal(stuck.length, 1)
  assert.equal(stuck[0].stuck.kind, 'stalled')
  assert.equal(stuck[0].stuck.minutes, 15)
  assert.ok(r.got.run.crews.some((c: any) => c.slug.length === 80))
})

test('artifacts', async () => {
  const r = await fold('artifacts/state.json')
  assertGapFields(r)
  assert.ok(r.got.design.images.length >= 3)
  assert.ok(r.got.transcript.some((e: any) => e.intent === 'add' && e.text.length === 300))
})

test('live-counter', async () => {
  const r = await fold('live-counter/state.json')
  assertGapFields(r)
  assert.equal(r.got.session.usage.live.totalTokens, 719000)
  assert.equal(r.got.run.goals[0].id, 'run')
  assert.equal(r.got.run.goals[0].approvedAt, '2026-11-02T11:05:00.000Z')
})

test('live-counter stale', async () => {
  const r = await fold('live-counter/stale.json')
  assertGapFields(r)
  assert.equal(r.got.session.usage.live.at, '2026-11-02T11:54:00.000Z')
})

test('decisions', async () => {
  const r = await fold('decisions/state.json')
  assertGapFields(r)
  assert.equal(r.got.decisions.length, 3)
  assert.equal(r.got.run.goals[0].id, 'run')
})

test('retro', async () => {
  const r = await fold('retro/state.json')
  assertGapFields(r)
  assert.equal(r.got.retro.steps.judges.status, 'running')
  assert.deepEqual(r.got.session.queue, [])
})

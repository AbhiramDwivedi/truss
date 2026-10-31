// Store tests for ui-state (ADR-0011 Decisions 4, 5 and 9; R-14), written from the ADR and
// ui/contract/state.schema.json before any implementation exists. They add to what
// ui/contract/state.check.ts pins and never repeat it. Self-contained: the validator and the
// helpers below are copied from that check, not imported. Every test runs on temp copies of
// tests/fixtures/retro-040 and docs/plan.example.json and removes them.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const uiDir = path.dirname(path.dirname(here))
const root = path.dirname(uiDir)
const MODULE = 'ui/server/state'
const producerUrl = pathToFileURL(path.join(uiDir, 'server/state/index.ts')).href
const producer: any = await import(producerUrl).catch(() => null)

// ---------------------------------------------------------------------------
// A small JSON Schema (2020-12 subset) validator for ui/contract/state.schema.json.
// ---------------------------------------------------------------------------
const schema = JSON.parse(fs.readFileSync(path.join(uiDir, 'contract/state.schema.json'), 'utf8'))

function resolveRef(ref: string): any {
  assert.ok(ref.startsWith('#/'), `unsupported $ref ${ref}`)
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
    if (s.pattern && !new RegExp(s.pattern).test(v)) mine.push(`${at}: ${v} does not match ${s.pattern}`)
    if (s.format === 'date-time' && !(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(v) && !Number.isNaN(Date.parse(v)))) {
      mine.push(`${at}: ${v} is not an RFC 3339 date-time`)
    }
  }
  if (typeof v === 'number' && s.minimum !== undefined && v < s.minimum) mine.push(`${at}: below minimum ${s.minimum}`)
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) mine.push(`${at}: fewer than ${s.minItems} items`)
    if (s.maxItems !== undefined && v.length > s.maxItems) mine.push(`${at}: more than ${s.maxItems} items`)
    if (s.items) v.forEach((x, i) => validate(s.items, x, `${at}[${i}]`, mine))
  }
  if (typeOk('object', v)) {
    if (s.minProperties !== undefined && Object.keys(v).length < s.minProperties) mine.push(`${at}: too few properties`)
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
  if (s.anyOf) {
    const ok = s.anyOf.some((o: any) => { const e: string[] = []; validate(o, v, at, e); return e.length === 0 })
    if (!ok) mine.push(`${at}: matches no anyOf branch`)
  }
  errs.push(...mine)
}

function assertSchema(defName: string, value: unknown): void {
  const errs: string[] = []
  validate({ $ref: `#/$defs/${defName}` }, value, defName, errs)
  assert.deepEqual(errs.slice(0, 10), [], `${defName} breaks state.schema.json`)
}

// ---------------------------------------------------------------------------
// Fixture helpers (copied pattern from ui/contract/state.check.ts)
// ---------------------------------------------------------------------------
const fixtureDir = path.join(root, 'tests/fixtures/retro-040')
const planExample = path.join(root, 'docs/plan.example.json')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'truss-state-store-'))
let counter = 0

interface World { base: string; repo: string; truss: string }

function makeWorld(config: Record<string, unknown> | null = { architecture: 'docs/architecture.md', adr: 'docs/adr', merge: 'sequential', target: 'main' }): World {
  const base = path.join(tmpRoot, `w${++counter}`)
  const repo = path.join(base, 'repo')
  const truss = path.join(base, 'truss')
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'docs/adr'), { recursive: true })
  if (config !== null) fs.writeFileSync(path.join(repo, '.claude/truss.json'), JSON.stringify(config))
  fs.writeFileSync(path.join(repo, 'docs/architecture.md'), '# Architecture\n\nA unique line, 7f3a.\n')
  fs.writeFileSync(path.join(repo, 'docs/adr/0001-first.md'), '# ADR-0001: first choice\n\nStatus: accepted, 2026-01-02\n')
  fs.cpSync(fixtureDir, truss, { recursive: true })
  fs.copyFileSync(planExample, path.join(truss, 'plan.json'))
  return { base, repo, truss }
}

function gitRepo(repo: string): void {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env })
  execFileSync('git', ['add', '-A'], { cwd: repo, env })
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'], { cwd: repo, env })
}

// Every file and directory under dir with size and mtime, skipping a top-level name.
function listing(dir: string, skip: string[] = []): string[] {
  const out: string[] = []
  const walk = (d: string, rel: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`
      if (rel === '' && skip.includes(e.name)) continue
      const st = fs.lstatSync(path.join(d, e.name))
      out.push(`${r} ${st.isDirectory() ? 'dir' : st.size} ${st.mtimeMs}`)
      if (e.isDirectory()) walk(path.join(d, e.name), r)
    }
  }
  walk(dir, '')
  return out.sort()
}

function applyDelta(st: any, d: any): any {
  const next = structuredClone(st)
  for (const [k, v] of Object.entries(d.set ?? {})) next[k] = structuredClone(v)
  if (d.append?.transcript) next.transcript = [...next.transcript, ...structuredClone(d.append.transcript)].slice(-500)
  return next
}

const NOW = '2026-10-30T10:00:00.000Z'

// A SessionView built from plain objects that satisfy the schema; no SDK, no mocked session.
function sessionState(over: Record<string, unknown> = {}): any {
  return {
    status: 'waiting', sessionId: 'sess-1', model: 'claude-opus-x', claudeCodeVersion: '2.1.0', permissionMode: 'default',
    plugin: { name: 'truss', version: '0.4.0', path: '/plugins/truss', source: null },
    usage: { costUsd: 0.12, models: { 'claude-opus-x': { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 } }, results: 1, at: NOW },
    backgroundTasks: [{ taskId: 't1', description: 'a task', subagentType: null }],
    error: null,
    ...over,
  }
}
function questionRequest(id: string, over: Record<string, unknown> = {}): any {
  return {
    id, kind: 'question', status: 'open', createdAt: NOW, answeredAt: null, cancelReason: null,
    questions: [{ question: 'Which one?', header: 'Pick', multiSelect: false, options: [{ label: 'A (Recommended)', description: 'first', recommended: true }, { label: 'B', description: 'second', recommended: false }] }],
    answers: null,
    ...over,
  }
}
function permissionRequest(id: string, over: Record<string, unknown> = {}): any {
  return {
    id, kind: 'permission', status: 'open', createdAt: NOW, answeredAt: null, cancelReason: null,
    toolName: 'Bash', title: 'Run it', summary: 'ls -la', input: { command: 'ls -la' }, decisionReason: null, blockedPath: null, decision: null, message: null,
    ...over,
  }
}
const entry = (n: number, role = 'assistant', text = `text ${n}`): any => ({ n, role, text, ts: NOW })

const crew = (s: any, slug: string): any => s.run.crews.find((c: any) => c.slug === slug)
const member = (c: any, name: string): any => c.members.find((m: any) => m.name === name)

async function until(store: any, pred: (s: any) => boolean, ms: number, what: string): Promise<number> {
  const t0 = Date.now()
  for (;;) {
    const s = store.snapshot().state
    let ok = false
    try { ok = pred(s) } catch { ok = false }
    if (ok) return Date.now() - t0
    if (Date.now() - t0 > ms) assert.fail(`not shown within ${ms} ms: ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const spawnLine = (ts: string, c: string, agent: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ v: 1, ts, event: 'spawn', crew: c, agent, agentId: null, type: 'kit:builder', model: 'sonnet', effort: 'low', by: c, ...extra }) + '\n'

function registerTests(mod: any): void {
  const stores: any[] = []
  after(() => {
    for (const s of stores) { try { s.close() } catch { /* ignore */ } }
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  async function ready(w: World, opts: Record<string, unknown> = {}): Promise<any> {
    const store = mod.createStore({ repo: w.repo, trussDir: w.truss, pollMs: 50, ...opts })
    stores.push(store)
    await store.ready
    return store
  }

  // ---- Decision 5: instance, seq, snapshot, ring, subscribe --------------------------------

  test('ADR-0011 D5 Sequence: instance is 16 lowercase hex, stable for one store, different for another', async () => {
    const a = await ready(makeWorld())
    const b = await ready(makeWorld())
    const i1 = a.snapshot().instance
    assert.match(i1, /^[0-9a-f]{16}$/)
    a.setSession({ session: sessionState(), requests: [], transcript: [] })
    assert.equal(a.snapshot().instance, i1)
    assert.match(b.snapshot().instance, /^[0-9a-f]{16}$/)
    assert.notEqual(b.snapshot().instance, i1)
  })

  test('ADR-0011 D5 Sequence: snapshot.seq is the last delta included, and deltas since an older snapshot rebuild the newer state', async () => {
    const store = await ready(makeWorld())
    const seen: any[] = []
    store.subscribe((d: any) => seen.push(d))
    const base = store.snapshot()
    assertSchema('snapshot', base)
    assert.equal(base.state.session.status, 'idle')
    assert.deepEqual(base.state.requests, [])
    assert.deepEqual(base.state.transcript, [])
    store.setSession({ session: sessionState({ status: 'running' }), requests: [questionRequest('r1')], transcript: [entry(1, 'user')] })
    store.setSession({ session: sessionState(), requests: [questionRequest('r1', { status: 'answered', answeredAt: NOW, answers: { 'Which one?': 'A (Recommended)' } })], transcript: [entry(1, 'user'), entry(2)] })
    const last = store.snapshot()
    assertSchema('snapshot', last)
    assert.equal(last.seq, Math.max(...seen.map((d) => d.seq)), 'seq is the last delta included')
    assert.ok(seen.length >= 2)
    seen.forEach((d, i) => { assertSchema('delta', d); assert.equal(d.seq, base.seq + 1 + i) })
    const replay = store.since(base.seq)
    assert.deepEqual(replay.map((d: any) => d.seq), seen.map((d) => d.seq))
    const rebuilt = replay.reduce(applyDelta, base.state)
    assert.deepEqual(rebuilt, last.state)
  })

  test('ADR-0011 D5 Replay ring: since(seq) serves exactly the last 1024 deltas, null when older or ahead', async () => {
    const store = await ready(makeWorld())
    const base = store.snapshot().seq
    for (let i = 1; i <= 1100; i++) store.setSession({ session: sessionState({ status: 'error', error: `boom ${i}` }), requests: [], transcript: [] })
    const top = store.snapshot().seq
    assert.ok(top >= base + 1100, `1100 distinct session changes gave seq ${top} from ${base}`)
    const all = store.since(top - 1024)
    assert.ok(Array.isArray(all), 'every delta after top-1024 is in the ring')
    assert.equal(all.length, 1024)
    assert.deepEqual(all.map((d: any) => d.seq), Array.from({ length: 1024 }, (_, i) => top - 1023 + i))
    all.forEach((d: any) => assertSchema('delta', d))
    assert.equal(store.since(top - 1025), null, 'one delta older than the ring')
    assert.equal(store.since(0), null)
    assert.equal(store.since(base), null)
    assert.deepEqual(store.since(top), [])
    assert.equal(store.since(top + 1), null, 'ahead')
    assert.equal(store.since(top + 1000), null, 'ahead')
    assert.equal(store.snapshot().state.session.error, 'boom 1100')
  })

  test('ADR-0011 D9 subscribe: returns an unsubscribe; each subscriber sees the deltas in order, none after it unsubscribes', async () => {
    const store = await ready(makeWorld())
    const a: any[] = []
    const b: any[] = []
    const offA = store.subscribe((d: any) => a.push(d.seq))
    store.subscribe((d: any) => b.push(d.seq))
    assert.equal(typeof offA, 'function')
    store.setSession({ session: sessionState({ status: 'running' }), requests: [], transcript: [] })
    const seenByA = a.length
    assert.ok(seenByA >= 1)
    offA()
    store.setSession({ session: sessionState({ status: 'waiting' }), requests: [], transcript: [] })
    assert.equal(a.length, seenByA, 'no delta after unsubscribe')
    assert.ok(b.length > a.length)
    assert.deepEqual(b, [...b].sort((x, y) => x - y))
    offA() // a second call is harmless
  })

  // ---- Decision 9: setSession ----------------------------------------------------------------

  test('ADR-0011 D9 setSession: replaces session, requests and transcript, with schema-valid deltas', async () => {
    const store = await ready(makeWorld())
    const seen: any[] = []
    store.subscribe((d: any) => seen.push(d))
    const run0 = store.snapshot().state.run
    const v1 = { session: sessionState(), requests: [questionRequest('r1'), permissionRequest('r2')], transcript: [entry(1, 'user'), entry(2)] }
    store.setSession(v1)
    let s = store.snapshot().state
    assertSchema('snapshot', store.snapshot())
    assert.deepEqual(s.session, v1.session)
    assert.deepEqual(s.requests, v1.requests)
    assert.deepEqual(s.transcript, v1.transcript)
    assert.deepEqual(s.run, run0, 'a session change leaves run alone')
    const v2 = { session: sessionState({ status: 'ended' }), requests: [questionRequest('r1', { status: 'cancelled', answeredAt: NOW, cancelReason: 'ended' })], transcript: [entry(1, 'user'), entry(2), entry(3, 'error', 'it threw')] }
    store.setSession(v2)
    s = store.snapshot().state
    assert.deepEqual(s.session, v2.session)
    assert.deepEqual(s.requests, v2.requests, 'requests are replaced whole')
    assert.deepEqual(s.transcript, v2.transcript)
    assert.ok(seen.length >= 2)
    for (const d of seen) assertSchema('delta', d)
    assert.ok(seen.some((d) => d.set?.requests), 'requests travel in set')
    assert.ok(seen.some((d) => d.append?.transcript), 'new transcript entries travel in append')
    assert.ok(!seen.some((d) => d.set && 'transcript' in d.set), 'transcript is never in set (schema)')
  })

  test('ADR-0011 D9 setSession: snapshot transcript keeps the last 500 entries, oldest first', async () => {
    const store = await ready(makeWorld())
    const transcript = Array.from({ length: 600 }, (_, i) => entry(i + 1))
    store.setSession({ session: sessionState(), requests: [], transcript })
    const s = store.snapshot().state
    assertSchema('snapshot', store.snapshot())
    assert.equal(s.transcript.length, 500)
    assert.equal(s.transcript[0].n, 101)
    assert.equal(s.transcript[499].n, 600)
  })

  // ---- Decision 9: setTrussDir -------------------------------------------------------------

  test('ADR-0011 D9 setTrussDir: null gives path null, run null and a no-truss-dir notice; a path brings the run back', async () => {
    const w = makeWorld()
    const store = await ready(w)
    const seen: any[] = []
    store.subscribe((d: any) => seen.push(d))
    assert.equal(store.snapshot().state.trussDir.path, w.truss)
    store.setTrussDir(null)
    let s = store.snapshot().state
    assertSchema('snapshot', store.snapshot())
    assert.deepEqual(s.trussDir, { path: null, exists: false })
    assert.equal(s.run, null)
    assert.ok(s.notices.some((n: any) => n.id === 'no-truss-dir'))
    store.setTrussDir(w.truss)
    await until(store, (st) => st.run !== null, 2000, 'run after setTrussDir(path)')
    s = store.snapshot().state
    assert.deepEqual(s.trussDir, { path: w.truss, exists: true })
    assert.ok(!s.notices.some((n: any) => n.id === 'no-truss-dir'))
    assert.deepEqual(s.run.crews.map((c: any) => c.slug).slice(0, 3), ['ratelimit-design', 'quotas', 'gateway'])
    assert.ok(seen.some((d) => d.set?.trussDir), 'a trussDir delta')
    for (const d of seen) assertSchema('delta', d)
  })

  test('ADR-0011 D9 setTrussDir: a path not on disk gives exists false and the notice, until it appears', async () => {
    const w = makeWorld()
    const store = await ready(w, { trussDir: undefined })
    assert.deepEqual(store.snapshot().state.trussDir, { path: null, exists: false })
    const later = path.join(w.base, 'later')
    store.setTrussDir(later)
    let s = store.snapshot().state
    assert.deepEqual(s.trussDir, { path: later, exists: false })
    assert.equal(s.run, null)
    assert.ok(s.notices.some((n: any) => n.id === 'no-truss-dir'))
    fs.cpSync(w.truss, later, { recursive: true })
    await until(store, (st) => st.run !== null && st.trussDir.exists, 2000, 'run once the new dir exists')
    s = store.snapshot().state
    assert.ok(!s.notices.some((n: any) => n.id === 'no-truss-dir'))
  })

  test('ADR-0011 D9 setTrussDir: pointing at a second dir drops the first dir\'s crews and offsets', async () => {
    const w = makeWorld()
    const store = await ready(w)
    const other = path.join(w.base, 'other')
    fs.mkdirSync(other)
    fs.writeFileSync(path.join(other, 'events.jsonl'), spawnLine('2026-10-28T01:00:00.000Z', 'solo', 'solo', { type: 'truss:foreman' }))
    store.setTrussDir(other)
    await until(store, (st) => st.run !== null && crew(st, 'solo') !== undefined, 2000, 'solo crew from the other dir')
    const s = store.snapshot().state
    assert.equal(crew(s, 'auth'), undefined)
    assert.deepEqual(s.run.crews.map((c: any) => c.slug), ['solo'])
    assert.deepEqual(s.run.skipped, [])
  })

  // ---- Decision 4: reading, rolling -------------------------------------------------------

  test('ADR-0011 D4 Rolling: a live file that shrank with no new rolled file waits, neither resets nor doubles', async () => {
    const w = makeWorld()
    const store = await ready(w)
    const live = path.join(w.truss, 'events.jsonl')
    const full = fs.readFileSync(live, 'utf8')
    const before = structuredClone(store.snapshot().state.run)
    assert.equal(before.skipped.length, 2)
    // a torn rewrite: the hooks' rewrite is seen part way, only the first 5 lines on disk
    const head = full.split('\n').slice(0, 5).join('\n') + '\n'
    fs.writeFileSync(live, head)
    await sleep(400) // many 50 ms polls
    assert.deepEqual(store.snapshot().state.run, before, 'a shrunk file must not reset the state')
    // the rewrite finishes: the whole old content plus one new line
    fs.writeFileSync(live, full + spawnLine('2026-10-27T20:00:00.000Z', 'auth', 'auth-torn'))
    await until(store, (s) => member(crew(s, 'auth'), 'auth-torn') !== undefined, 2000, 'auth-torn after the rewrite finished')
    const s = store.snapshot().state
    assert.equal(s.run.skipped.length, 2, 'nothing read twice')
    assert.deepEqual(crew(s, 'auth').members.map((m: any) => m.name), ['auth-builder', 'auth-tester', 'auth-qc', 'auth-qc-2', 'auth-stress', 'auth-torn'])
    assert.equal(crew(s, 'auth').foreman.detail, 'QUESTION')
  })

  test('ADR-0011 D4 Rolling: a rolled file equal to the newest older rolled file is a duplicate and is skipped', async () => {
    const w = makeWorld()
    // events.1.jsonl gets one bad line so a re-read of a copy would show as a second skipped entry
    const e1 = path.join(w.truss, 'events.1.jsonl')
    fs.appendFileSync(e1, 'not json at all\n')
    fs.copyFileSync(e1, path.join(w.truss, 'events.2.jsonl'))
    const store = await ready(w)
    let s = store.snapshot().state
    const skipped = s.run.skipped as any[]
    assert.equal(skipped.filter((k) => k.file === 'events.1.jsonl').length, 1)
    assert.equal(skipped.filter((k) => k.file === 'events.2.jsonl').length, 0, JSON.stringify(skipped))
    assert.equal(skipped.length, 3)
    // the same mid-run: a third copy appears, then the live file takes a new line
    fs.copyFileSync(e1, path.join(w.truss, 'events.3.jsonl'))
    await sleep(300)
    assert.equal(store.snapshot().state.run.skipped.length, 3, 'the mid-run duplicate is skipped too')
    fs.appendFileSync(path.join(w.truss, 'events.jsonl'), spawnLine('2026-10-27T21:00:00.000Z', 'auth', 'auth-after-dup'))
    await until(store, (st) => member(crew(st, 'auth'), 'auth-after-dup') !== undefined, 2000, 'a live line after the duplicates')
    s = store.snapshot().state
    assert.equal(s.run.skipped.length, 3)
    assert.ok(s.run.crews.length >= 6)
  })

  test('ADR-0011 D4 Sources: messages.<n>.jsonl present at start feeds the latest activity', async () => {
    const w = makeWorld()
    fs.writeFileSync(path.join(w.truss, 'messages.1.jsonl'), '{"ts":"2026-10-27T20:00:00.000Z","from":"docs","to":"auth","summary":"from a rolled file"}\n')
    const s = (await ready(w)).snapshot().state
    assert.deepEqual(crew(s, 'docs').latest, { ts: '2026-10-27T20:00:00.000Z', agent: 'docs', event: 'message', text: 'docs to auth: from a rolled file' })
  })

  test('ADR-0011 D4 Rolling: a messages.<n>.jsonl appearing mid-run, as the hooks roll it, gives the new live line and no doubling', async () => {
    const w = makeWorld()
    const store = await ready(w)
    const live = path.join(w.truss, 'messages.jsonl')
    fs.copyFileSync(live, path.join(w.truss, 'messages.1.jsonl'))
    fs.writeFileSync(live, '{"ts":"2026-10-27T21:00:00.000Z","from":"billing","to":"auth","summary":"after the roll"}\n')
    await until(store, (s) => crew(s, 'billing').latest.text === 'billing to auth: after the roll', 2000, 'message after the roll')
    const s = store.snapshot().state
    assert.deepEqual(crew(s, 'auth').latest.event, 'report')
    assert.equal(s.run.skipped.length, 2)
    fs.appendFileSync(live, '{"ts":"2026-10-27T21:05:00.000Z","from":"auth","to":"billing","summary":"one more"}\n')
    await until(store, (st) => crew(st, 'auth').latest.text === 'auth to billing: one more', 2000, 'a line after the roll')
  })

  test('ADR-0011 D4 Reading: changes that fs.watch is unlikely to report (rename into place) still show through the poll', async () => {
    const w = makeWorld()
    const store = await ready(w)
    const outside = path.join(w.base, 'staging')
    fs.mkdirSync(outside)
    // events.jsonl replaced by a rename of a longer file written elsewhere
    const live = path.join(w.truss, 'events.jsonl')
    fs.writeFileSync(path.join(outside, 'events.jsonl'), fs.readFileSync(live, 'utf8') + spawnLine('2026-10-27T22:00:00.000Z', 'auth', 'auth-renamed'))
    fs.renameSync(path.join(outside, 'events.jsonl'), live)
    await until(store, (s) => member(crew(s, 'auth'), 'auth-renamed') !== undefined, 2000, 'auth-renamed via rename into place')
    assert.equal(store.snapshot().state.run.skipped.length, 2)
    // plan.json and plan.md arrive the same way
    const plan = JSON.parse(fs.readFileSync(path.join(w.truss, 'plan.json'), 'utf8'))
    plan.goal = 'A goal that arrived by rename'
    fs.writeFileSync(path.join(outside, 'plan.json'), JSON.stringify(plan))
    fs.renameSync(path.join(outside, 'plan.json'), path.join(w.truss, 'plan.json'))
    fs.writeFileSync(path.join(outside, 'plan.md'), '# Plan by rename\n')
    fs.renameSync(path.join(outside, 'plan.md'), path.join(w.truss, 'plan.md'))
    await until(store, (s) => s.run.goal === 'A goal that arrived by rename' && s.design.planMd === '# Plan by rename\n', 2000, 'plan.json and plan.md by rename')
    // a whole new report file, then decisions.md, by rename
    fs.mkdirSync(path.join(w.truss, 'reports/quotas'), { recursive: true })
    fs.writeFileSync(path.join(outside, 'q.md'), 'VERDICT: PASS\n')
    fs.renameSync(path.join(outside, 'q.md'), path.join(w.truss, 'reports/quotas/quotas-qc.md'))
    await until(store, (s) => crew(s, 'quotas').qc?.verdict === 'PASS', 2000, 'quotas QC verdict by rename')
    assert.equal(crew(store.snapshot().state, 'quotas').qc.file, 'reports/quotas/quotas-qc.md')
  })

  // ---- Decision 4: design sources -----------------------------------------------------------

  test('ADR-0011 D4 No config: no .claude/truss.json gives architecture null, an empty ADR list and a no-config notice', async () => {
    const w = makeWorld(null)
    const s = (await ready(w)).snapshot().state
    assertSchema('state', s)
    assert.equal(s.design.architecture, null)
    assert.deepEqual(s.adrs, [])
    assert.ok(s.notices.some((n: any) => n.id === 'no-config'), JSON.stringify(s.notices))
    assert.ok(s.run !== null, 'the rest of the state is unaffected')
  })

  test('ADR-0011 D4 No config: a config without the architecture key gives architecture null and the notice, ADRs still listed', async () => {
    const w = makeWorld({ adr: 'docs/adr', merge: 'sequential', target: 'main' })
    const s = (await ready(w)).snapshot().state
    assert.equal(s.design.architecture, null)
    assert.deepEqual(s.adrs.map((a: any) => a.file), ['0001-first.md'])
    assert.ok(s.notices.some((n: any) => n.id === 'no-config'), JSON.stringify(s.notices))
  })

  test('ADR-0011 D4 No config: a config without the adr key gives an empty ADR list and the notice, architecture still read', async () => {
    const w = makeWorld({ architecture: 'docs/architecture.md', merge: 'sequential', target: 'main' })
    const s = (await ready(w)).snapshot().state
    assert.deepEqual(s.adrs, [])
    assert.equal(s.design.architecture.path, 'docs/architecture.md')
    assert.ok(s.notices.some((n: any) => n.id === 'no-config'), JSON.stringify(s.notices))
  })

  test('ADR-0011 D4 Sources: a complete config has no no-config notice', async () => {
    const s = (await ready(makeWorld())).snapshot().state
    assert.ok(!s.notices.some((n: any) => n.id === 'no-config'))
  })

  test('ADR-0011 D4 Sources: plan.md feeds design.planMd, null until it exists, and follows edits', async () => {
    const w = makeWorld()
    const store = await ready(w)
    assert.equal(store.snapshot().state.design.planMd, null)
    fs.writeFileSync(path.join(w.truss, 'plan.md'), '# The plan\n\nstage 0 first\n')
    await until(store, (s) => s.design.planMd === '# The plan\n\nstage 0 first\n', 2000, 'plan.md shown')
    fs.writeFileSync(path.join(w.truss, 'plan.md'), '# The plan v2\n')
    await until(store, (s) => s.design.planMd === '# The plan v2\n', 2000, 'plan.md edit shown')
    assertSchema('snapshot', store.snapshot())
  })

  // ---- R-14 and the read-only rule ----------------------------------------------------------

  test('R-14 at 12 crews and 100 agents from real fixture lines: state right, a later append shown within 2 s', async () => {
    const w = makeWorld()
    // Lines derived from the real fixture: a foreman spawn (events.jsonl line 1), a member spawn
    // (line 2), a stall (line 5) and a report (line 12).
    const real = fs.readFileSync(path.join(fixtureDir, 'events.jsonl'), 'utf8').split('\n').filter((l) => l !== '')
    const foremanT = JSON.parse(real[0])
    const memberT = JSON.parse(real[1])
    const stallT = JSON.parse(real[4])
    const reportT = JSON.parse(real[11])
    assert.equal(foremanT.type, 'truss:foreman')
    assert.equal(memberT.agent, 'auth-builder')
    assert.equal(stallT.event, 'stall')
    assert.equal(reportT.event, 'report')
    const slugs = Array.from({ length: 12 }, (_, i) => `crew-${String(i + 1).padStart(2, '0')}`)
    const plan = JSON.parse(fs.readFileSync(path.join(w.truss, 'plan.json'), 'utf8'))
    const proto = plan.crews[1]
    plan.crews = slugs.map((slug, i) => ({ ...proto, slug, stage: i < 6 ? 1 : 2, modules: [slug], owns: [`src/${slug}/**`], status: 'planned' }))
    fs.writeFileSync(path.join(w.truss, 'plan.json'), JSON.stringify(plan))
    fs.rmSync(path.join(w.truss, 'events.1.jsonl'))
    const out: string[] = []
    let t = Date.UTC(2026, 9, 27, 9, 0, 0)
    const ts = (): string => new Date((t += 1000)).toISOString()
    let agents = 0
    slugs.forEach((slug, ci) => {
      out.push(JSON.stringify({ ...foremanT, ts: ts(), crew: slug, agent: slug, agentId: `f${ci}` }))
      agents++
      const members = ci < 4 ? 8 : 7 // 4 * 9 + 8 * 8 = 100 agents with the foremen
      for (let k = 1; k <= members; k++) {
        out.push(JSON.stringify({ ...memberT, ts: ts(), crew: slug, agent: `${slug}-m${k}`, agentId: `a${ci}-${k}`, by: slug }))
        agents++
      }
      out.push(JSON.stringify({ ...stallT, ts: ts(), crew: slug, agent: `${slug}-m1`, minutes: 15 }))
      out.push(JSON.stringify({ ...reportT, ts: ts(), crew: slug, agent: `${slug}-m2`, marker: 'VERDICT: PASS' }))
    })
    assert.equal(agents, 100)
    fs.writeFileSync(path.join(w.truss, 'events.jsonl'), out.join('\n') + '\n')
    const t0 = Date.now()
    const store = await ready(w)
    assert.ok(Date.now() - t0 < 10000, `first read took ${Date.now() - t0} ms`)
    const s = store.snapshot().state
    assertSchema('snapshot', store.snapshot())
    assert.deepEqual(s.run.crews.map((c: any) => c.slug), slugs)
    assert.equal(s.run.crews.reduce((n: number, c: any) => n + c.members.length + (c.foreman === null ? 0 : 1), 0), 100)
    assert.deepEqual(s.run.crews.map((c: any) => c.members.length), [8, 8, 8, 8, 7, 7, 7, 7, 7, 7, 7, 7])
    for (const c of s.run.crews) {
      assert.equal(c.foreman.name, c.slug)
      assert.equal(c.foreman.model, 'opus')
      assert.equal(member(c, `${c.slug}-m1`).state, 'stalled')
      assert.equal(member(c, `${c.slug}-m1`).detail, '15 min')
      assert.equal(member(c, `${c.slug}-m2`).state, 'reported')
      assert.equal(member(c, `${c.slug}-m3`).model, 'sonnet')
      assert.equal(c.latest.text, `${c.slug}-m2 reported VERDICT: PASS`)
    }
    assert.deepEqual(s.run.skipped, [])
    const marker = 'late-r14'
    fs.appendFileSync(path.join(w.truss, 'events.jsonl'), spawnLine('2026-10-28T09:00:00.000Z', 'crew-12', marker))
    const took = await until(store, (st) => member(crew(st, 'crew-12'), marker) !== undefined, 2000, `${marker} with 12 crews and 100 agents`)
    assert.ok(took < 2000)
    assert.equal(crew(store.snapshot().state, 'crew-12').latest.agent, marker)
  })

  test('ADR-0011 D1 The UI never writes: the Truss dir and the repo are unchanged after a store has run and closed', async () => {
    const w = makeWorld()
    gitRepo(w.repo)
    fs.writeFileSync(path.join(w.truss, 'plan.md'), '# Plan\n')
    // .git is left out: git itself may refresh its own bookkeeping there when it runs
    const repoBefore = listing(w.repo, ['.git'])
    const trussBefore = listing(w.truss)
    const store = mod.createStore({ repo: w.repo, trussDir: w.truss, pollMs: 50 })
    await store.ready
    store.setSession({ session: sessionState(), requests: [questionRequest('r1')], transcript: [entry(1)] })
    store.setTrussDir(null)
    store.setTrussDir(w.truss)
    await until(store, (s) => s.run !== null, 2000, 'run')
    await sleep(500) // ten polls
    store.close()
    await sleep(100)
    assert.deepEqual(listing(w.truss), trussBefore)
    assert.deepEqual(listing(w.repo, ['.git']), repoBefore)
  })
}

if (producer === null) {
  test(`producer missing: ${MODULE}`, () => {
    throw new Error(`producer missing: ${MODULE}`)
  })
} else {
  registerTests(producer)
}

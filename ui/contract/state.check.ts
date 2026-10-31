// Contract check for ui-state (ADR-0011 Decisions 4, 5 and 9; R-3, R-14, R-15).
// Written from the ADR before any implementation exists. Self-contained on purpose.
// It copies the real fixtures (tests/fixtures/retro-040, docs/plan.example.json) into a
// fresh temp dir and never edits them in place.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const uiDir = path.dirname(here)
const root = path.dirname(uiDir)
const MODULE = 'ui/server/state'
const producerUrl = pathToFileURL(path.join(uiDir, 'server/state/index.ts')).href
const producer: any = await import(producerUrl).catch(() => null)

// ---------------------------------------------------------------------------
// A small JSON Schema (2020-12 subset) validator for ui/contract/state.schema.json.
// ---------------------------------------------------------------------------
const schema = JSON.parse(fs.readFileSync(path.join(here, 'state.schema.json'), 'utf8'))

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
// Fixture helpers
// ---------------------------------------------------------------------------
const fixtureDir = path.join(root, 'tests/fixtures/retro-040')
const planExample = path.join(root, 'docs/plan.example.json')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'truss-state-check-'))
let counter = 0

interface World { repo: string; truss: string }

// A fresh repo dir (with .claude/truss.json, an architecture doc and two ADRs) and a Truss dir
// holding copies of the real fixtures.
function makeWorld(): World {
  const base = path.join(tmpRoot, `w${++counter}`)
  const repo = path.join(base, 'repo')
  const truss = path.join(base, 'truss')
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'docs/adr'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.claude/truss.json'), JSON.stringify({ architecture: 'docs/architecture.md', adr: 'docs/adr', merge: 'sequential', target: 'main' }))
  fs.writeFileSync(path.join(repo, 'docs/architecture.md'), '# Architecture\n\nA unique line, 7f3a.\n')
  fs.writeFileSync(path.join(repo, 'docs/adr/0002-second.md'), '# ADR-0002: second choice\n\nStatus: proposed, 2026-10-30\n')
  fs.writeFileSync(path.join(repo, 'docs/adr/0001-first.md'), '# ADR-0001: first choice\n\nStatus: accepted, 2026-01-02\n')
  fs.writeFileSync(path.join(repo, 'docs/adr/notes.txt'), 'not an adr\n')
  fs.cpSync(fixtureDir, truss, { recursive: true })
  fs.copyFileSync(planExample, path.join(truss, 'plan.json'))
  // QC files: auth-qc.md and auth-qc-2.md tie on mtime (the higher k wins); the interim file
  // is newer but is not a QC file by the hooks' rule.
  const t = new Date('2026-10-27T11:00:00Z')
  fs.utimesSync(path.join(truss, 'reports/auth/auth-qc.md'), t, t)
  fs.utimesSync(path.join(truss, 'reports/auth/auth-qc-2.md'), t, t)
  const later = new Date('2026-10-27T12:00:00Z')
  fs.utimesSync(path.join(truss, 'reports/auth/auth-qc-2.interim.md'), later, later)
  return { repo, truss }
}

function state(store: any): any {
  const snap = store.snapshot()
  assertSchema('snapshot', snap)
  return snap.state
}

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

const crew = (s: any, slug: string): any => s.run.crews.find((c: any) => c.slug === slug)
const member = (c: any, name: string): any => c.members.find((m: any) => m.name === name)

function registerTests(mod: any): void {
  const stores: any[] = []
  after(() => {
    for (const s of stores) { try { s.close() } catch { /* ignore */ } }
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })
  before(() => {
    assert.equal(typeof mod.createStore, 'function', `${MODULE} must export createStore`)
  })

  async function ready(w: World, pollMs = 50): Promise<any> {
    const store = mod.createStore({ repo: w.repo, trussDir: w.truss, pollMs })
    stores.push(store)
    await store.ready
    return store
  }

  test('real fixtures: crews, in plan order then event-only crews by first appearance', async () => {
    const w = makeWorld()
    const s = state(await ready(w))
    assert.equal(s.v, 1)
    assert.equal(s.repo, w.repo)
    assert.deepEqual(s.trussDir, { path: w.truss, exists: true })
    assert.deepEqual(s.run.crews.map((c: any) => c.slug), ['ratelimit-design', 'quotas', 'gateway', 'docs', 'auth', 'billing'])
    assert.ok(!s.run.crews.some((c: any) => c.slug === 'main'))
    assert.equal(s.run.goal, 'Add rate limiting to the public API, with per-key quotas stored in Postgres')
    assert.equal(s.run.version, 2)
    assert.equal(s.run.approval, 'client')
    assert.equal(s.run.approvedAt, null)
  })

  test('real fixtures: plan crews carry stage, verdict, status, owns and nothing from events', async () => {
    const s = state(await ready(makeWorld()))
    const rd = crew(s, 'ratelimit-design')
    assert.equal(rd.stage, 0)
    assert.equal(rd.verdict, 'design')
    assert.equal(rd.status, 'planned')
    assert.equal(rd.goal, null)
    assert.deepEqual(rd.owns, ['docs/architecture.md', 'docs/adr/0007-rate-limiting.md', 'tests/contract/quota-store.test.ts'])
    assert.equal(rd.foreman, null)
    assert.deepEqual(rd.members, [])
    assert.equal(rd.latest, null)
    assert.equal(rd.qc, null)
    assert.equal(crew(s, 'quotas').stage, 1)
    assert.equal(crew(s, 'quotas').verdict, 'change')
    assert.deepEqual(crew(s, 'quotas').owns, ['src/quotas/**', 'migrations/0012_quotas.sql', 'tests/quotas/**'])
    assert.equal(crew(s, 'gateway').verdict, 'extend')
    assert.deepEqual(crew(s, 'gateway').owns, ['src/gateway/middleware/ratelimit.ts', 'tests/gateway/ratelimit.test.ts'])
  })

  test('real fixtures: auth foreman and members with type, model, effort, state and detail', async () => {
    const s = state(await ready(makeWorld()))
    const auth = crew(s, 'auth')
    assert.equal(auth.status, null)
    assert.equal(auth.stage, null)
    assert.equal(auth.foreman.name, 'auth')
    assert.equal(auth.foreman.type, 'truss:foreman')
    assert.equal(auth.foreman.model, 'opus')
    assert.equal(auth.foreman.effort, 'high')
    assert.equal(auth.foreman.state, 'tagged')
    assert.equal(auth.foreman.detail, 'QUESTION') // the v:2 PROPOSAL line after it is skipped
    assert.deepEqual(auth.members.map((m: any) => m.name), ['auth-builder', 'auth-tester', 'auth-qc', 'auth-qc-2', 'auth-stress'])
    const b = member(auth, 'auth-builder')
    assert.deepEqual([b.type, b.model, b.effort, b.state, b.detail], ['kit:builder', 'sonnet', 'medium', 'reported', 'VERDICT: PASS'])
    const t = member(auth, 'auth-tester')
    assert.deepEqual([t.type, t.model, t.effort, t.state, t.detail], ['kit:test-writer', 'sonnet', 'medium', 'spawned', null])
    assert.equal(member(auth, 'auth-qc').state, 'reported')
    assert.equal(member(auth, 'auth-qc').detail, 'VERDICT: FAIL')
    assert.equal(member(auth, 'auth-qc-2').detail, 'VERDICT: PASS')
    const st = member(auth, 'auth-stress')
    assert.deepEqual([st.type, st.model, st.effort, st.state, st.detail], [null, null, null, 'reported', 'STRESSTEST'])
    assert.equal(b.ts, '2026-10-27T11:05:00.000Z')
  })

  test('real fixtures: billing members from stall lines, docs members across the rolled file', async () => {
    const s = state(await ready(makeWorld()))
    const billing = crew(s, 'billing')
    assert.equal(billing.foreman.state, 'tagged')
    assert.equal(billing.foreman.detail, 'BLOCKED')
    assert.equal(billing.foreman.effort, null)
    assert.deepEqual(billing.members.map((m: any) => m.name), ['billing-builder'])
    const bb = member(billing, 'billing-builder')
    assert.deepEqual([bb.type, bb.state, bb.detail], [null, 'stalled', '16 min'])
    const docs = crew(s, 'docs')
    assert.equal(docs.foreman.name, 'docs')
    assert.equal(docs.foreman.model, null)
    assert.equal(docs.foreman.state, 'tagged')
    assert.equal(docs.foreman.detail, 'PROPOSAL')
    assert.deepEqual(docs.members.map((m: any) => m.name), ['docs-writer', 'docs-qc']) // docs-writer is only in events.1.jsonl
    const w = member(docs, 'docs-writer')
    assert.deepEqual([w.type, w.model, w.effort, w.state], ['truss:writer', 'sonnet', 'low', 'spawned'])
    assert.equal(member(docs, 'docs-qc').detail, 'VERDICT: PASS')
  })

  test('real fixtures: latest activity per crew, in the words of the schema', async () => {
    const s = state(await ready(makeWorld()))
    assert.deepEqual(crew(s, 'auth').latest, { ts: '2026-10-27T11:10:00.000Z', agent: 'auth-stress', event: 'report', text: 'auth-stress reported STRESSTEST' })
    assert.deepEqual(crew(s, 'billing').latest, { ts: '2026-10-27T10:06:00.000Z', agent: 'billing', event: 'tag', text: 'billing sent BLOCKED' })
    assert.deepEqual(crew(s, 'docs').latest, { ts: '2026-10-27T13:40:00.000Z', agent: 'docs-qc', event: 'report', text: 'docs-qc reported VERDICT: PASS' })
  })

  test('real fixtures: a message line is the latest activity of its from-agent crew', async () => {
    const w = makeWorld()
    fs.appendFileSync(path.join(w.truss, 'messages.jsonl'), '{"ts":"2026-10-27T14:00:00.000Z","from":"billing","to":"auth","summary":"late note"}\n')
    const store = await ready(w)
    await until(store, (s) => crew(s, 'billing').latest.event === 'message', 2000, 'billing message')
    assert.deepEqual(crew(store.snapshot().state, 'billing').latest, { ts: '2026-10-27T14:00:00.000Z', agent: 'billing', event: 'message', text: 'billing to auth: late note' })
    assert.equal(crew(store.snapshot().state, 'auth').latest.event, 'report')
  })

  test('real fixtures: QC verdicts from reports/ (isQcFile, higher k wins a tie, interim file ignored)', async () => {
    const s = state(await ready(makeWorld()))
    assert.deepEqual(crew(s, 'auth').qc, { verdict: 'PASS', file: 'reports/auth/auth-qc-2.md' })
    assert.deepEqual(crew(s, 'docs').qc, { verdict: 'PASS', file: 'reports/docs/docs-qc.md' })
    assert.equal(crew(s, 'billing').qc, null)
    assert.equal(crew(s, 'quotas').qc, null)
  })

  test('real fixtures: a newer QC file replaces the verdict, then a missing VERDICT line gives null', async () => {
    const w = makeWorld()
    const store = await ready(w)
    const f = path.join(w.truss, 'reports/auth/auth-qc-3.md')
    fs.writeFileSync(f, '\n\nVERDICT: FAIL\n\nnope\n')
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(f, future, future)
    await until(store, (s) => crew(s, 'auth').qc.file === 'reports/auth/auth-qc-3.md', 2000, 'auth-qc-3')
    assert.equal(crew(store.snapshot().state, 'auth').qc.verdict, 'FAIL')
    fs.writeFileSync(f, 'no verdict here\n')
    const later = new Date(Date.now() + 6000)
    fs.utimesSync(f, later, later)
    await until(store, (s) => crew(s, 'auth').qc.verdict === null, 2000, 'auth-qc-3 without verdict')
  })

  test('real fixtures: decisions.md entries with run headings and continuation lines', async () => {
    const s = state(await ready(makeWorld()))
    const r1 = '2026-10-27T09:00:30Z | build the retro script'
    const r2 = '2026-10-27T13:00:00Z | docs pass'
    assert.deepEqual(s.decisions.map((d: any) => [d.n, d.run]), [[2, null], [4, r1], [5, r1], [6, r1], [8, r1], [10, r2], [11, r2], [12, r2], [13, r2], [15, r2]])
    assert.equal(s.decisions[0].text, '08:00 | a decision written before the first run heading | old habit | checker: none | followed')
    assert.equal(s.decisions[3].text, '09:20 | checker-1 RECOMMEND answer: merge auth first | overruled: client chose billing first\na two-space continuation of the line above')
    assert.equal(s.decisions[4].text, 'a free-form note inside the first run')
  })

  test('real fixtures: ADRs sorted by file name, design from .claude/truss.json', async () => {
    const s = state(await ready(makeWorld()))
    assert.deepEqual(s.adrs, [
      { file: '0001-first.md', title: 'ADR-0001: first choice', status: 'accepted, 2026-01-02' },
      { file: '0002-second.md', title: 'ADR-0002: second choice', status: 'proposed, 2026-10-30' },
    ])
    assert.deepEqual(s.design.architecture, { path: 'docs/architecture.md', markdown: '# Architecture\n\nA unique line, 7f3a.\n' })
    assert.equal(s.design.planMd, null)
    assert.ok(Array.isArray(s.design.images))
  })

  test('edge: events.jsonl lines 10 and 11 (not JSON, v 2) are skipped and recorded, nothing else is', async () => {
    const s = state(await ready(makeWorld()))
    assert.deepEqual(s.run.skipped, [
      { file: 'events.jsonl', line: 10, reason: 'json' },
      { file: 'events.jsonl', line: 11, reason: 'version' },
    ])
    // the v:2 line named crew auth with PROPOSAL; the auth foreman did not take it
    assert.equal(crew(s, 'auth').foreman.detail, 'QUESTION')
  })

  test('edge: a partial last line waits for its newline, is not skipped, then lands', async () => {
    const w = makeWorld()
    const store = await ready(w)
    const live = path.join(w.truss, 'events.jsonl')
    const full = '{"v":1,"ts":"2026-10-27T15:00:00.000Z","event":"spawn","crew":"zeta-crew","agent":"zeta-crew","agentId":"z0","type":"truss:foreman","model":"opus","effort":"low","by":"main"}'
    const cut = full.indexOf('"event"')
    fs.appendFileSync(live, full.slice(0, cut))
    await new Promise((r) => setTimeout(r, 400)) // several 50 ms polls
    let s = store.snapshot().state
    assert.equal(crew(s, 'zeta-crew'), undefined, 'a half line must not create a crew')
    assert.equal(s.run.skipped.length, 2, 'a half line must not be recorded as skipped')
    fs.appendFileSync(live, full.slice(cut) + '\n')
    await until(store, (st) => crew(st, 'zeta-crew') !== undefined, 2000, 'zeta-crew after its newline')
    s = state(store)
    assert.equal(crew(s, 'zeta-crew').foreman.model, 'opus')
    assert.equal(s.run.skipped.length, 2)
    assert.deepEqual(s.run.crews.map((c: any) => c.slug).slice(-1), ['zeta-crew'])
  })

  test('edge: an unknown v appended later is skipped with reason version, a message with v 2 too', async () => {
    const w = makeWorld()
    const store = await ready(w)
    fs.appendFileSync(path.join(w.truss, 'events.jsonl'), '{"v":3,"ts":"2026-10-27T16:00:00.000Z","event":"spawn","crew":"future-crew","agent":"future-crew","agentId":null,"type":null,"model":null,"effort":null,"by":"main"}\n')
    fs.appendFileSync(path.join(w.truss, 'messages.jsonl'), '{"v":2,"ts":"2026-10-27T16:01:00.000Z","from":"auth","to":"billing","summary":"from the future"}\n{"ts":"2026-10-27T16:02:00.000Z","from":"auth","to":"billing","summary":"no v is fine"}\n')
    await until(store, (s) => crew(s, 'auth').latest.text === 'auth to billing: no v is fine', 2000, 'message without v')
    const s = state(store)
    assert.equal(crew(s, 'future-crew'), undefined)
    assert.ok(s.run.skipped.some((k: any) => k.file === 'events.jsonl' && k.line === 19 && k.reason === 'version'), JSON.stringify(s.run.skipped))
    assert.ok(s.run.skipped.some((k: any) => k.file === 'messages.jsonl' && k.line === 5 && k.reason === 'version'), JSON.stringify(s.run.skipped))
  })

  test('edge: a new rolled file holding what the live file held does not double or lose anything', async () => {
    const w = makeWorld()
    const store = await ready(w)
    const live = path.join(w.truss, 'events.jsonl')
    // what appendLine does: copy live to events.2.jsonl, start the live file over
    fs.copyFileSync(live, path.join(w.truss, 'events.2.jsonl'))
    fs.writeFileSync(live, '{"v":1,"ts":"2026-10-27T17:00:00.000Z","event":"spawn","crew":"auth","agent":"auth-late","agentId":"l1","type":"kit:builder","model":"haiku","effort":"low","by":"auth"}\n')
    await until(store, (s) => member(crew(s, 'auth'), 'auth-late') !== undefined, 2000, 'auth-late after the roll')
    const s = state(store)
    assert.deepEqual(crew(s, 'auth').members.map((m: any) => m.name), ['auth-builder', 'auth-tester', 'auth-qc', 'auth-qc-2', 'auth-stress', 'auth-late'])
    assert.equal(crew(s, 'auth').foreman.detail, 'QUESTION')
    assert.equal(s.run.skipped.length, 2, 'the rolled copy was read from the live offset, not again')
  })

  test('no Truss dir on disk: run is null, trussDir.exists false, a no-truss-dir notice', async () => {
    const w = makeWorld()
    const gone = path.join(path.dirname(w.truss), 'not-yet')
    const store = mod.createStore({ repo: w.repo, trussDir: gone, pollMs: 50 })
    stores.push(store)
    await store.ready
    const s = state(store)
    assert.deepEqual(s.trussDir, { path: gone, exists: false })
    assert.equal(s.run, null)
    assert.ok(s.notices.some((n: any) => n.id === 'no-truss-dir'))
    fs.cpSync(w.truss, gone, { recursive: true })
    await until(store, (st) => st.run !== null, 2000, 'run once the dir exists')
    assert.equal(store.snapshot().state.trussDir.exists, true)
    assert.ok(!store.snapshot().state.notices.some((n: any) => n.id === 'no-truss-dir'))
  })

  test('deltas: a change gives a delta whose set replaces run whole, seq with no gaps', async () => {
    const w = makeWorld()
    const store = await ready(w)
    const seen: any[] = []
    const off = store.subscribe((d: any) => seen.push(d))
    const base = store.snapshot()
    assertSchema('snapshot', base)
    fs.appendFileSync(path.join(w.truss, 'events.jsonl'), '{"v":1,"ts":"2026-10-27T18:00:00.000Z","event":"spawn","crew":"auth","agent":"auth-delta","agentId":"d1","type":"kit:builder","model":"sonnet","effort":"low","by":"auth"}\n')
    await until(store, () => seen.some((d) => d.set?.run), 2000, 'a delta with set.run')
    off()
    seen.forEach((d, i) => { assertSchema('delta', d); assert.equal(d.seq, base.seq + 1 + i) })
    const d = seen.find((x) => x.set?.run)
    assert.ok(member(d.set.run.crews.find((c: any) => c.slug === 'auth'), 'auth-delta'))
    assert.deepEqual(store.since(base.seq)?.map((x: any) => x.seq), seen.map((x) => x.seq))
    assert.equal(store.since(base.seq + 1000), null)
  })

  test('R-14: 30 MiB of the real fixture lines across rolled files, state right and a change shown inside 2 s', async () => {
    const w = makeWorld()
    // Rolled files of ~3 MiB (ROLL_BYTES), each made from the real events lines with the
    // milliseconds changed per file so no file equals the one before it (equal files are
    // skipped as duplicate copies). The live file stays the real events.jsonl.
    const real = fs.readFileSync(path.join(fixtureDir, 'events.1.jsonl'), 'utf8') + fs.readFileSync(path.join(fixtureDir, 'events.jsonl'), 'utf8')
    const lines = real.split('\n').filter((l) => l !== '')
    const ROLL = 3 * 1024 * 1024
    let bytes = fs.statSync(path.join(w.truss, 'events.jsonl')).size
    fs.rmSync(path.join(w.truss, 'events.1.jsonl'))
    for (let k = 1; k <= 10; k++) {
      const ms = String(k).padStart(3, '0')
      const parts: string[] = []
      let size = 0
      while (size < ROLL) {
        for (const l of lines) {
          const t = l.replace('.000Z', `.${ms}Z`) + '\n'
          parts.push(t)
          size += t.length
        }
      }
      fs.writeFileSync(path.join(w.truss, `events.${k}.jsonl`), parts.join(''))
      bytes += size
    }
    assert.ok(bytes >= 30 * 1024 * 1024, `built only ${bytes} bytes`)
    const t0 = Date.now()
    const store = await ready(w, 500)
    const loadMs = Date.now() - t0
    const s = state(store)
    assert.ok(loadMs < 30000, `first read of ${bytes} bytes took ${loadMs} ms`)
    assert.deepEqual(s.run.crews.map((c: any) => c.slug), ['ratelimit-design', 'quotas', 'gateway', 'docs', 'auth', 'billing'])
    assert.deepEqual(crew(s, 'auth').members.map((m: any) => m.name), ['auth-builder', 'auth-tester', 'auth-qc', 'auth-qc-2', 'auth-stress'])
    assert.deepEqual(crew(s, 'docs').members.map((m: any) => m.name), ['docs-writer', 'docs-qc'])
    assert.equal(member(crew(s, 'auth'), 'auth-builder').model, 'sonnet')
    assert.equal(crew(s, 'auth').latest.text, 'auth-stress reported STRESSTEST')
    assert.deepEqual(crew(s, 'auth').qc, { verdict: 'PASS', file: 'reports/auth/auth-qc-2.md' })
    assert.equal(s.run.skipped.length, 100, 'skipped is capped at 100')
    for (const k of s.run.skipped) {
      assert.match(k.file, /^events(\.\d+)?\.jsonl$/)
      assert.ok(k.line >= 1)
      assert.ok(k.reason === 'json' || k.reason === 'version')
    }
    // R-15: a change shows within 2 s with the 30 MiB loaded
    const marker = `late-${Math.random().toString(36).slice(2, 8)}`
    fs.appendFileSync(path.join(w.truss, 'events.jsonl'), `{"v":1,"ts":"2026-10-27T19:00:00.000Z","event":"spawn","crew":"auth","agent":"${marker}","agentId":"m1","type":"kit:builder","model":"sonnet","effort":"low","by":"auth"}\n`)
    await until(store, (st) => member(crew(st, 'auth'), marker) !== undefined, 2000, `${marker} with 30 MiB loaded`)
    assert.equal(crew(store.snapshot().state, 'auth').latest.agent, marker)
  })

  // R-23: ADR-0012 Decision 8. <truss dir>/retro/state.json shows under the state's retro key.
  test('R-23: a per-run value in retro/state.json shows under the retro key, null while the file is absent or unreadable', async () => {
    const w = makeWorld()
    const file = path.join(w.truss, 'retro/state.json')
    const run = Math.random().toString(36).slice(2, 10)
    const at = '2026-10-31T08:30:00Z'
    const steps = (over: Record<string, any>): any => {
      const base: any = {}
      for (const k of ['extract', 'judges', 'triage', 'fixGoal', 'applied']) base[k] = { status: 'pending', at: null, detail: null }
      return { ...base, ...over }
    }
    const write = (v: any, extra: any = {}) => {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ v, updatedAt: at, steps: steps(extra) }))
    }
    // Absent file: the key is there and null.
    const store = await ready(w)
    const first = state(store)
    if (!('retro' in first)) throw new Error(`producer missing: ${MODULE} retro (the state has no retro key)`)
    assert.equal(first.retro, null)
    // A file with a per-run detail shows under the key, step by step.
    const d1 = `${run} findings kept`
    write(1, { extract: { status: 'done', at, detail: d1 }, judges: { status: 'running', at, detail: null } })
    await until(store, (s) => s.retro?.steps?.extract?.detail === d1, 2000, `retro extract detail ${d1}`)
    let s = state(store)
    assert.equal(s.retro.v, 1)
    assert.equal(s.retro.updatedAt, at)
    assert.equal(s.retro.steps.judges.status, 'running')
    assert.equal(s.retro.steps.applied.status, 'pending')
    assert.equal(s.run.crews.length, 6, 'the crew lanes stay as they were')
    // A change shows: fixes applied.
    const d2 = `${run} crews merged`
    write(1, { extract: { status: 'done', at, detail: d1 }, judges: { status: 'done', at, detail: null }, triage: { status: 'done', at, detail: null }, fixGoal: { status: 'done', at, detail: null }, applied: { status: 'done', at, detail: d2 } })
    await until(store, (st) => st.retro?.steps?.applied?.detail === d2, 2000, `retro applied detail ${d2}`)
    assert.equal(state(store).retro.steps.applied.status, 'done')
    // Not JSON, or a v other than 1: null again.
    fs.writeFileSync(file, '{ not json')
    await until(store, (st) => st.retro === null, 2000, 'retro null for a file that is not JSON')
    write(2, { extract: { status: 'done', at, detail: d1 } })
    await new Promise((r) => setTimeout(r, 300)) // several 50 ms polls
    assert.equal(state(store).retro, null, 'a v other than 1 reads as absent')
    write(1, { extract: { status: 'done', at, detail: d1 } })
    await until(store, (st) => st.retro?.steps?.extract?.detail === d1, 2000, 'retro back for a v 1 file')
  })
}

if (producer === null) {
  test(`producer missing: ${MODULE}`, () => {
    throw new Error(`producer missing: ${MODULE}`)
  })
  test(`R-23: producer missing: ${MODULE} retro`, () => {
    throw new Error(`producer missing: ${MODULE} retro`)
  })
} else {
  registerTests(producer)
}

// Contract check for the D2 state fixtures (ADR-0023 section 6): ui/contract/fixtures/run/<state>/state.json.
// Every file must be a whole state valid against ui/contract/state.schema.json ($defs.state), gap fields
// included, and each state must hold the content its spec block asserts. Self-contained on purpose: the
// validator below is a copy of the one in ui/contract/state.check.ts, not an import.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const here = import.meta.dirname
const runDir = path.resolve(here, '..', 'fixtures', 'run')
const adr = fs.readFileSync(path.resolve(here, '..', '..', '..', 'plugins', 'truss', 'docs', 'adr', '0023-factory-floor-ui.md'), 'utf8')
const STATES = (adr.match(/^Screenshot states: (.+)$/m)?.[1] ?? '').split(', ').filter(Boolean)
const ANCHOR = Date.parse('2026-11-02T12:00:00.000Z')
const schema = JSON.parse(fs.readFileSync(path.resolve(here, '..', 'state.schema.json'), 'utf8'))

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

function assertState(value: unknown): void {
  const errs: string[] = []
  validate({ $ref: '#/$defs/state' }, value, 'state', errs)
  assert.deepEqual(errs.slice(0, 10), [], 'breaks state.schema.json')
}

const load = (rel: string): any => JSON.parse(fs.readFileSync(path.join(runDir, rel), 'utf8'))
const state = (name: string): any => load(path.join(name, 'state.json'))
const times = (v: any, out: number[] = []): number[] => {
  if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(v)) out.push(Date.parse(v))
  else if (Array.isArray(v)) v.forEach((x) => times(x, out))
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => times(x, out))
  return out
}
const crews = (s: any): any[] => s.run?.crews ?? []
const LONG_SLUG = 'crew-with-a-very-long-slug-that-must-truncate-but-keep-its-full-name-for-readers'

test('the ADR names the ten D2 states', () => {
  assert.equal(STATES.length, 10)
})

test('there is one state.json per state, and the live-counter has stale.json', () => {
  for (const s of STATES) assert.ok(fs.existsSync(path.join(runDir, s, 'state.json')), `${s}/state.json is missing`)
  assert.ok(fs.existsSync(path.join(runDir, 'live-counter', 'stale.json')))
})

for (const name of ['empty', 'question', 'approval', 'follow-up', 'crews-running', 'stuck-crew', 'artifacts', 'live-counter', 'decisions', 'retro', 'live-counter/stale', 'stuck-crew/idle-foreman', 'artifacts/no-images']) {
  const rel = name.includes('/') ? `${name}.json` : path.join(name, 'state.json')
  test(`${name}: a whole state valid against state.schema.json, times at or before the anchor`, () => {
    const s = load(rel)
    assertState(s)
    assert.ok(times(s).every((t) => t <= ANCHOR), 'a time is after the anchor 2026-11-02T12:00:00.000Z')
    assert.ok(Array.isArray(s.session.queue), 'session.queue (gap b) is present')
  })
}

test('empty: idle session, no requests, no run, no transcript', () => {
  const s = state('empty')
  assert.equal(s.session.status, 'idle')
  assert.deepEqual(s.requests, [])
  assert.equal(s.run, null)
  assert.deepEqual(s.transcript, [])
})

test('question: one open question, recommended option first, label ends (Recommended)', () => {
  const s = state('question')
  assert.equal(s.requests.length, 1)
  const r = s.requests[0]
  assert.equal(r.kind, 'question')
  assert.equal(r.status, 'open')
  const first = r.questions[0].options[0]
  assert.ok(first.label.endsWith(' (Recommended)'))
  assert.equal(first.recommended, true)
})

test('approval: a reply request and a permission request, both open, with the permission detail', () => {
  const s = state('approval')
  assert.deepEqual(s.requests.map((r: any) => r.kind), ['reply', 'permission'])
  assert.ok(s.requests.every((r: any) => r.status === 'open'))
  const p = s.requests[1]
  for (const k of ['toolName', 'title', 'summary', 'decisionReason', 'blockedPath']) assert.ok(typeof p[k] === 'string' && p[k].length > 0, `permission ${k}`)
})

test('follow-up: transcript rows carry id and intent in goal, add and null; the queue holds one row; one 300-character text', () => {
  const s = state('follow-up')
  const users = s.transcript.filter((e: any) => e.role === 'user')
  assert.ok(users.every((e: any) => typeof e.id === 'string' && ['goal', 'add', null].includes(e.intent)))
  assert.deepEqual([...new Set(users.map((e: any) => e.intent))].sort(), [null, 'add', 'goal'].sort())
  assert.equal(s.session.queue.length, 1)
  assert.ok(users.some((e: any) => e.id === s.session.queue[0].id), 'the queued message also has a transcript row')
  assert.ok(users.some((e: any) => e.text.length === 300))
  assert.ok(users.some((e: any) => !s.session.queue.some((q: any) => q.id === e.id)), 'a sent row that is not queued')
  assert.ok(!/In the plan|plan revision/i.test(JSON.stringify(s)))
})

test('crews-running: stage groups, crews with estAgents and members', () => {
  const cs = crews(state('crews-running'))
  assert.ok(new Set(cs.map((c) => c.stage)).size >= 2)
  assert.ok(cs.every((c) => Number.isInteger(c.estAgents)))
  assert.ok(cs.filter((c) => c.status === 'running').length >= 2)
  assert.ok(cs.some((c) => c.status === 'running' && c.members.length > 0))
})

test('stuck-crew: one crew stuck (stalled, 15 min), an 80-character slug, a 300-character follow-up', () => {
  const s = state('stuck-crew')
  const stuck = crews(s).filter((c) => c.stuck !== null)
  assert.equal(stuck.length, 1)
  assert.equal(stuck[0].status, 'running')
  assert.equal(stuck[0].stuck.kind, 'stalled')
  assert.equal(stuck[0].stuck.minutes, 15)
  assert.equal(stuck[0].stuck.since, new Date(ANCHOR - 15 * 60000).toISOString())
  assert.equal(stuck[0].stuck.detail, `${stuck[0].members[0].name} stalled 15 min`)
  assert.ok(crews(s).some((c) => c.slug.length === 80 && c.slug === LONG_SLUG))
  assert.ok(s.transcript.some((e: any) => e.role === 'user' && e.text.length === 300))
  assert.deepEqual(s.requests, [], 'Your move holds nothing for a stuck crew')
})

test('artifacts: deliverables from a merged crew and from crews not merged; an 80-character slug; a 300-character follow-up', () => {
  const s = state('artifacts')
  const status = new Map(crews(s).map((c) => [`truss-${c.slug}`, c.status]))
  assert.ok(s.design.images.length >= 3)
  assert.ok(s.design.images.every((i: any) => status.has(i.ref)), 'every image ref names a crew branch truss-<slug>')
  assert.ok(s.design.images.some((i: any) => status.get(i.ref) === 'merged'))
  assert.ok(s.design.images.some((i: any) => status.get(i.ref) !== 'merged'), 'a pending deliverable: its crew is not merged')
  assert.ok(typeof s.design.planMd === 'string' && s.design.architecture !== null && s.adrs.length >= 1)
  assert.ok(crews(s).some((c) => c.slug.length === 80))
  assert.ok(s.transcript.some((e: any) => e.role === 'user' && e.text.length === 300))
})

test('live-counter: usage.live with its stamp, run.goals[0] is run with approvedAt; stale.json is more than 2 minutes older', () => {
  const s = state('live-counter')
  assert.equal(s.run.goals[0].id, 'run')
  assert.ok(typeof s.run.goals[0].approvedAt === 'string')
  const live = s.session.usage.live
  assert.equal(live.totalTokens, live.inputTokens + live.outputTokens + live.cacheReadInputTokens + live.cacheCreationInputTokens + live.subagentTokens)
  assert.ok(ANCHOR - Date.parse(live.at) < 2 * 60000, 'fresh stamp')
  const stale = load(path.join('live-counter', 'stale.json'))
  assert.ok(ANCHOR - Date.parse(stale.session.usage.live.at) > 2 * 60000, 'stale stamp')
  assert.deepEqual({ ...stale, session: null }, { ...s, session: null }, 'stale.json differs from state.json in the session only')
})

test('stuck-crew/idle-foreman.json: the same state, its one stuck crew of kind idle-foreman with the foreman stalled', () => {
  const s = state('stuck-crew')
  const v = load(path.join('stuck-crew', 'idle-foreman.json'))
  const stuck = crews(v).filter((c) => c.stuck !== null)
  assert.equal(stuck.length, 1)
  assert.equal(stuck[0].status, 'running')
  assert.equal(stuck[0].stuck.kind, 'idle-foreman')
  assert.equal(stuck[0].foreman.state, 'stalled')
  assert.equal(stuck[0].stuck.since, new Date(ANCHOR - stuck[0].stuck.minutes * 60000).toISOString())
  assert.equal(stuck[0].stuck.detail, `${stuck[0].foreman.name} stalled ${stuck[0].stuck.minutes} min`)
  assert.ok(crews(v).some((c) => c.slug === LONG_SLUG))
  assert.deepEqual({ ...v, run: null }, { ...s, run: null }, 'idle-foreman.json differs from state.json in the run only')
})

test('artifacts/no-images.json: the same state with design.images empty', () => {
  const s = state('artifacts')
  const v = load(path.join('artifacts', 'no-images.json'))
  assert.deepEqual(v.design.images, [])
  assert.deepEqual({ ...v, design: { ...v.design, images: s.design.images } }, s, 'no-images.json differs from state.json in design.images only')
})

test('decisions: decisions and ADRs, and no plan revision text', () => {
  const s = state('decisions')
  assert.ok(s.decisions.length >= 2 && s.adrs.length >= 2)
  assert.ok(s.run.goals[0].approvedAt)
  assert.ok(!/plan revision/i.test(JSON.stringify(s)))
})

test('retro: five steps, one running with detail', () => {
  const r = state('retro').retro
  assert.deepEqual(Object.keys(r.steps), ['extract', 'judges', 'triage', 'fixGoal', 'applied'])
  const running = Object.values(r.steps).filter((x: any) => x.status === 'running') as any[]
  assert.equal(running.length, 1)
  assert.ok(running[0].detail)
})

test('the root fixture files stay: plan.json, events.jsonl and decisions.md', () => {
  for (const f of ['plan.json', 'events.jsonl', 'decisions.md']) assert.ok(fs.existsSync(path.join(runDir, f)))
})

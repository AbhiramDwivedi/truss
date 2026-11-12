// Contract check for the rework fixture states (ADR-0028 section 11): ui/contract/fixtures/rework/<state>/state.json.
// Every state named on the ADR's "Rework fixture states:" line must exist and be a whole state valid against
// ui/contract/state.schema.json ($defs/state), and each state must hold the content the UX direction names for it.
// Self-contained on purpose: the validator is a copy of the one in ui/contract/redesign/fixtures.check.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const here = import.meta.dirname
const dir = path.resolve(here, '..', 'fixtures', 'rework')
const adr = fs.readFileSync(path.resolve(here, '..', '..', '..', 'plugins', 'truss', 'docs', 'adr', '0028-ui-rework.md'), 'utf8')
const STATES = (adr.match(/^Rework fixture states: (.+)$/m)?.[1] ?? '').split(', ').filter(Boolean)
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
    if (s.maxLength !== undefined && v.length > s.maxLength) mine.push(`${at}: longer than ${s.maxLength}`)
    if (s.pattern && !new RegExp(s.pattern).test(v)) mine.push(`${at}: ${v} does not match ${s.pattern}`)
    if (s.format === 'date-time' && !(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(v) && !Number.isNaN(Date.parse(v)))) mine.push(`${at}: ${v} is not an RFC 3339 date-time`)
  }
  if (typeof v === 'number' && s.minimum !== undefined && v < s.minimum) mine.push(`${at}: below minimum ${s.minimum}`)
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) mine.push(`${at}: fewer than ${s.minItems} items`)
    if (s.maxItems !== undefined && v.length > s.maxItems) mine.push(`${at}: more than ${s.maxItems} items`)
    if (s.items) v.forEach((x, i) => validate(s.items, x, `${at}[${i}]`, mine))
  }
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
  if (s.anyOf && !s.anyOf.some((o: any) => { const e: string[] = []; validate(o, v, at, e); return e.length === 0 })) mine.push(`${at}: matches no anyOf branch`)
  errs.push(...mine)
}
function assertState(value: unknown): void {
  const errs: string[] = []
  validate({ $ref: '#/$defs/state' }, value, 'state', errs)
  assert.deepEqual(errs.slice(0, 10), [], 'breaks state.schema.json')
}

const load = (name: string): any => JSON.parse(fs.readFileSync(path.join(dir, name, 'state.json'), 'utf8'))
const times = (v: any, out: number[] = []): number[] => {
  if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(v)) out.push(Date.parse(v))
  else if (Array.isArray(v)) v.forEach((x) => times(x, out))
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => times(x, out))
  return out
}
const crews = (s: any): any[] => s.run?.crews ?? []
const agents = (c: any): any[] => [...(c.projectManager ? [c.projectManager] : []), ...c.members]
const allAgents = (s: any): any[] => crews(s).flatMap(agents)

test('the ADR names the twelve rework states', () => {
  assert.deepEqual(STATES, ['no-run', 'planning', 'live', 'real-12', 'reply-open', 'approval-ask', 'architecture', 'long', 'thread', 'partial', 'finished', 'real-data'])
})

for (const name of STATES) {
  test(`${name}: a state.json valid against state.schema.json, times at or before the anchor`, () => {
    assert.ok(fs.existsSync(path.join(dir, name, 'state.json')), `${name}/state.json is missing`)
    const s = load(name)
    assertState(s)
    assert.ok(times(s).every((t) => t <= ANCHOR), 'a time is after the anchor 2026-11-02T12:00:00.000Z')
  })
}

test('no-run (F1): no messages, no plan.json', () => {
  const s = load('no-run')
  assert.deepEqual(s.transcript, [])
  assert.equal(s.run, null)
  assert.deepEqual(s.requests, [])
})

test('planning (F2): the goal is sent, the session is working, there is no plan.json', () => {
  const s = load('planning')
  assert.equal(s.run, null)
  assert.equal(s.session.status, 'running')
  assert.equal(s.transcript.filter((e: any) => e.role === 'user' && e.intent === 'goal').length, 1)
})

test('live (F3): active, done, waiting, stuck and planned crews; one crew has project manager, builder and QC engineer with tasks; a flow entry to the active crew', () => {
  const s = load('live')
  const by = Object.fromEntries(crews(s).map((c) => [c.slug, c]))
  assert.equal(crews(s).length, 5)
  const active = crews(s).find((c) => c.status === 'running' && !c.stuck && !['QUESTION', 'BLOCKED', 'PROPOSAL'].includes(c.projectManager?.detail))
  const done = crews(s).filter((c) => c.status === 'merged')
  const waiting = crews(s).filter((c) => c.status === 'running' && ['QUESTION', 'BLOCKED', 'PROPOSAL'].includes(c.projectManager?.detail))
  const stuck = crews(s).filter((c) => c.stuck !== null)
  const planned = crews(s).filter((c) => c.status === 'planned')
  assert.ok(active, 'an active crew')
  assert.deepEqual([done.length, waiting.length, stuck.length, planned.length], [1, 1, 1, 1])
  assert.ok(active.projectManager && active.members.length >= 2)
  assert.ok(active.members.some((m: any) => /qc-engineer$/.test(m.type)), 'a QC engineer')
  for (const a of agents(active).filter((m: any) => m.type !== 'truss:qc-engineer')) assert.ok(a.task, `${a.name} has a task`)
  for (const a of agents(active)) assert.ok(a.purpose, `${a.name} has a purpose`)
  assert.ok((s.session.flow ?? []).some((f: any) => f.to === active.slug))
  assert.ok(by[active.slug])
  assert.equal(s.requests.filter((r: any) => r.status === 'open').length, 0)
  assert.ok(s.adrs.length > 0 && s.decisions.length > 0)
})

test('real-12 (F4): 12 crews, at most 100 agents, every started crew over 6 agents', () => {
  const s = load('real-12')
  assert.equal(crews(s).length, 12)
  assert.ok(allAgents(s).length <= 100, `${allAgents(s).length} agents`)
  assert.ok(crews(s).filter((c) => c.status !== 'planned').every((c) => agents(c).length > 6))
})

test('real-12 is the trim of the real truss dir: its goal comes from plan.json and it has one planned, one running and nine merged crews', () => {
  const s = load('real-12')
  assert.match(s.run.goal, /local web UI/)
  assert.deepEqual(['merged', 'planned', 'running'].map((st) => crews(s).filter((c) => c.status === st).length), [9, 1, 1])
})

test('reply-open (F5): an open reply that is not an approval ask, with the bug note text', () => {
  const s = load('reply-open')
  const r = s.requests.filter((x: any) => x.kind === 'reply' && x.status === 'open')
  assert.equal(r.length, 1)
  assert.notEqual(r[0].approvalAsk, true)
  assert.match(r[0].text, /Nothing is waiting on approval/)
  assert.match(r[0].text, /give me something new\.$/)
})

test('approval-ask (F6): an open reply that asks for plan approval', () => {
  const s = load('approval-ask')
  const r = s.requests.filter((x: any) => x.kind === 'reply' && x.status === 'open')
  assert.equal(r.length, 1)
  assert.equal(r[0].approvalAsk, true)
  assert.match(r[0].text, /approve.*\?$/is)
  assert.ok(crews(s).length > 0 && crews(s).every((c) => c.status === 'planned'))
})

test('architecture (F7): a valid mermaid block, a bad one, and Change log and History sections', () => {
  const s = load('architecture')
  const md: string = s.design.architecture.markdown
  const blocks = [...md.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1])
  assert.equal(blocks.length, 2)
  assert.match(blocks[0]!, /^flowchart LR\n(  \w+ --> \w+\n)+$/)
  assert.match(blocks[1]!, /-->\n/)
  assert.match(md, /^## Change log$/m)
  assert.match(md, /^## History$/m)
  assert.equal(fs.readFileSync(path.join(dir, 'architecture', 'architecture.md'), 'utf8'), md, 'architecture.md is the planted file')
})

test('long (F8): a 60-char slug, a 300-char task, a 200-char ADR title, $12,345.67 and 9-digit counts', () => {
  const s = load('long')
  assert.ok(crews(s).some((c) => c.slug.length === 60))
  assert.ok(allAgents(s).some((a) => a.task?.length === 300))
  assert.ok(s.adrs.some((a: any) => a.title.length === 200))
  assert.equal(s.session.usage.costUsd, 12345.67)
  const counts = Object.values<any>(s.session.usage.models).flatMap((m) => Object.values<number>(m))
  assert.ok(counts.filter((n) => String(n).length === 9).length >= 4)
})

test('thread (F9): two client messages and two PM replies after 60 older messages', () => {
  const s = load('thread')
  assert.equal(s.transcript.length, 64)
  const last4 = s.transcript.slice(-4).map((e: any) => e.role)
  assert.deepEqual(last4, ['user', 'assistant', 'user', 'assistant'])
  assert.deepEqual(s.transcript.map((e: any) => e.n), Array.from({ length: 64 }, (_, i) => i + 1))
})

test('partial: one crew with unread events, the others fine', () => {
  const s = load('partial')
  const bad = crews(s).filter((c) => (c.eventsUnread ?? 0) > 0)
  assert.equal(bad.length, 1)
  assert.ok(agents(bad[0]).length > 0, 'the last known agents are kept')
  assert.ok(crews(s).length > 1)
  assert.ok(s.run.skipped.every((k: any) => k.reason === 'version'))
})

test('finished: every crew merged, no open request, the session is not running or waiting', () => {
  const s = load('finished')
  assert.ok(crews(s).length > 0 && crews(s).every((c) => c.status === 'merged'))
  assert.equal(s.requests.length, 0)
  assert.ok(!['running', 'waiting'].includes(s.session.status))
})

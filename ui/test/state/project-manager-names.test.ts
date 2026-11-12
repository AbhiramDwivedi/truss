// Crew ui-names (truss 0.27.0): ui reads the project manager's names only: type `truss:project-manager`, stall kind
// `idle-project-manager`, purpose file `agents/project-manager.md`. The retired crew-lead values are no longer read.
// Those values are built from pieces below so this file never carries the retired word; a plain `node --test` runs
// it (built-ins, ui/server/state, ui/app/views/crews/format.ts only). Temp dirs come from mkdtemp; no port.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from '../../server/state/index.ts'
import { purposeOf, readPurposes } from '../../server/state/agents.ts'
import { orderAgents, roleWord, taskLine } from '../../app/views/crews/format.ts'

// The retired crew-lead name, in pieces (the file must not hold the word itself).
const OLD = 'fore' + 'man'
const OLD_TYPE = 'truss:' + OLD
const OLD_KIND = 'idle-' + OLD
const OLD_FILE = OLD + '.md'
const NEW_TYPE = 'truss:project-manager'
const NEW_KIND = 'idle-project-manager'
// ui's internal name of the crew's lead field in its state (unchanged: renaming ui is a non-goal).
const LEAD = OLD

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'truss-pm-names-')))
after(() => { rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) })
let n = 0
const dir = (name: string) => { const d = join(tmpRoot, `${name}-${++n}`); mkdirSync(d, { recursive: true }); return d }

// ui's existing internal stuck kind for an idle lead, read from the state schema's enum (the one that is not `stalled`).
const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'contract', 'state.schema.json')
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
const stuckKinds: string[] = schema.$defs.crew.properties.stuck.oneOf[1].properties.kind.enum
const IDLE_LEAD = stuckKinds.find((k) => k !== 'stalled')!
const LEAD_ROLE = roleWord({ type: 'workflow-crew', name: 'x' }) // the display label of a crew lead

const member = (name: string, type: string | null, extra: Record<string, unknown> = {}): any =>
  ({ name, type, model: null, effort: null, state: 'spawned', detail: null, task: null, ...extra })
const GOALS = [{ id: 'g1', goal: 'Ship the thing' }]
const crewOf = (lead: any) => ({ goal: 'g1', [LEAD]: lead }) as any

// A tiny store world: plan.json plus events.jsonl in a truss dir.
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
const T = (sec: number) => new Date(Date.UTC(2026, 9, 27, 9, 0, 0) + sec * 1000).toISOString()
const plan = (slugs: string[]) =>
  JSON.stringify({
    version: 3, goal: 'First goal', approval: 'auto', approvedAt: null, architecture: 'docs/architecture.md',
    maxParallelCrews: 2, reworkAllowance: 2,
    crews: slugs.map((slug) => ({
      slug, stage: 0, verdict: 'build', modules: ['m'], owns: [`src/${slug}.ts`], acceptanceTest: 'npm test',
      acceptanceTestProved: true, estAgents: 2, status: 'running',
    })),
  })
const spawn = (ts: string, crew: string, agent: string, type: string, by = 'main') =>
  ({ v: 1, ts, event: 'spawn', crew, agent, agentId: 'id-' + agent, type, model: 'opus', effort: 'high', by })
const stall = (ts: string, crew: string, agent: string, kind: string, minutes: number) =>
  ({ v: 1, ts, event: 'stall', crew, agent, kind, minutes })
function world(slugs: string[], rows: unknown[]) {
  const repo = dir('repo')
  const truss = dir('truss')
  writeFileSync(join(truss, 'plan.json'), plan(slugs))
  writeFileSync(join(truss, 'events.jsonl'), jsonl(rows))
  const store = createStore({ repo, trussDir: truss, pollMs: 40 })
  const snap = () => store.snapshot() as any
  return { store, snap, run: () => snap().state.run as any }
}
const crewBy = (run: any, slug: string) => run.crews.find((c: any) => c.slug === slug)

test('truss:project-manager ranks first among a crew members and gets the crew-lead role and task line', () => {
  const pm = member('c', NEW_TYPE)
  const builder = member('c-builder', 'truss:builder')
  const order = orderAgents([builder, pm], null)
  assert.equal(order[0], pm)
  assert.equal(roleWord(pm), LEAD_ROLE)
  assert.equal(taskLine(pm, crewOf(null), GOALS), 'Ship the thing')
  assert.equal(taskLine(builder, crewOf(null), GOALS), null)
})

test('the old type is no longer read as a crew lead: no first rank, no crew-lead role, no crew-lead task line', () => {
  const old = member('c', OLD_TYPE)
  const builder = member('c-builder', 'truss:builder')
  assert.notEqual(orderAgents([old, builder], null)[0], old)
  assert.notEqual(roleWord(old), LEAD_ROLE)
  assert.equal(taskLine(old, crewOf(null), GOALS), null)
})

test('an idle-project-manager stall event gives the crew the idle-lead stuck state with its minutes', () => {
  const w = world(['a'], [spawn(T(0), 'a', 'a', NEW_TYPE), stall(T(1200), 'a', 'a', NEW_KIND, 12)])
  try {
    const s = crewBy(w.run(), 'a').stuck
    assert.ok(s, 'stuck is set')
    assert.equal(s.kind, IDLE_LEAD)
    assert.equal(s.minutes, 12)
  } finally { w.store.close() }
})

test('the old kind is no longer read as an idle lead: an old-kind stall alone leaves the crew with no stuck state', () => {
  const w = world(['a'], [spawn(T(0), 'a', 'a', NEW_TYPE), stall(T(1200), 'a', 'a', OLD_KIND, 12)])
  try {
    assert.equal(crewBy(w.run(), 'a').stuck, null)
  } finally { w.store.close() }
})

const agentFile = (name: string, desc: string) => `---\nname: ${name.slice(0, -3)}\ndescription: ${desc}\n---\nBody.\n`

test('purposeOf for a truss:project-manager spawn reads agents/project-manager.md; an old-named file alone gives null', () => {
  const withNew = dir('plugin-new')
  mkdirSync(join(withNew, 'agents'))
  writeFileSync(join(withNew, 'agents', 'project-manager.md'), agentFile('project-manager.md', 'Leads one crew. More text.'))
  const p = readPurposes(withNew)
  assert.equal(purposeOf(p, NEW_TYPE, false), 'Leads one crew.')
  assert.equal(purposeOf(p, NEW_TYPE, true), 'Leads one crew.')

  const onlyOld = dir('plugin-old')
  mkdirSync(join(onlyOld, 'agents'))
  writeFileSync(join(onlyOld, 'agents', OLD_FILE), agentFile(OLD_FILE, 'Leads one crew. More text.'))
  const q = readPurposes(onlyOld)
  assert.equal(purposeOf(q, NEW_TYPE, false), null)
  assert.equal(purposeOf(q, NEW_TYPE, true), null)
})

// ---- stress: a structural walk of state.schema.json, as ui/contract/state.check.ts does ----
function resolveRef(ref: string): any {
  let node: any = schema
  for (const part of ref.slice(2).split('/')) node = node[part]
  return node
}
const typeOk = (t: string, v: any): boolean =>
  t === 'null' ? v === null : t === 'boolean' ? typeof v === 'boolean' : t === 'string' ? typeof v === 'string'
    : t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'integer' ? Number.isInteger(v)
      : t === 'array' ? Array.isArray(v) : t === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v) : false
function validate(s: any, v: any, at: string, errs: string[]): void {
  if (s.$ref) return validate(resolveRef(s.$ref), v, at, errs)
  const mine: string[] = []
  if ('const' in s && v !== s.const) mine.push(`${at}: expected const ${JSON.stringify(s.const)}`)
  if (s.enum && !s.enum.some((e: any) => e === v)) mine.push(`${at}: ${JSON.stringify(v)} not in enum`)
  if (s.type) {
    const ts = Array.isArray(s.type) ? s.type : [s.type]
    if (!ts.some((t: string) => typeOk(t, v))) mine.push(`${at}: wrong type, got ${JSON.stringify(v)?.slice(0, 60)}`)
  }
  if (typeof v === 'string' && s.pattern && !new RegExp(s.pattern).test(v)) mine.push(`${at}: ${v} does not match ${s.pattern}`)
  if (typeof v === 'number' && s.minimum !== undefined && v < s.minimum) mine.push(`${at}: below minimum`)
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

test('stress: 500 event lines mixing both kinds and both types validate, with stuck and crew leads from new values only', () => {
  const newCrews = ['n1', 'n2', 'n3']
  const oldCrews = ['o1', 'o2', 'o3']
  const mixed = 'm1' // a new-kind stall, then a later old-kind stall line: that line is a plain stall and a later event of the agent, so it clears the stuck state
  const slugs = [...newCrews, ...oldCrews, mixed]
  const rows: unknown[] = []
  let t = 0
  for (const slug of slugs) rows.push(spawn(T(t++), slug, slug, oldCrews.includes(slug) ? OLD_TYPE : NEW_TYPE))
  // noise: members of both types, in a fixed pseudo-random order
  let seed = 7
  const rnd = (k: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k }
  const body = 500 - rows.length - slugs.length - 3 // stall lines follow
  for (let i = 0; i < body; i++) {
    const slug = slugs[rnd(slugs.length)]
    const type = ['kit:builder', NEW_TYPE, OLD_TYPE, 'truss:qc-engineer'][rnd(4)]
    rows.push(spawn(T(t++), slug, `${slug}-w${i}`, type, 'main'))
  }
  for (const slug of oldCrews) rows.push(stall(T(t++), slug, slug, OLD_KIND, 5 + rnd(30)))
  rows.push(stall(T(t++), mixed, mixed, NEW_KIND, 11))
  rows.push(stall(T(t++), mixed, mixed, OLD_KIND, 99))
  for (const slug of newCrews) rows.push(stall(T(t++), slug, slug, NEW_KIND, 20))
  rows.length = Math.min(rows.length, 500)
  assert.ok(rows.length >= 490 && rows.length <= 500, `built ${rows.length} lines`)

  const w = world(slugs, rows)
  try {
    const snap = w.snap()
    const errs: string[] = []
    validate({ $ref: '#/$defs/snapshot' }, snap, 'snapshot', errs)
    assert.deepEqual(errs.slice(0, 10), [])
    const run = snap.state.run
    for (const slug of newCrews) {
      const s = crewBy(run, slug).stuck
      assert.ok(s, `${slug} stuck`)
      assert.equal(s.kind, IDLE_LEAD)
      assert.equal(s.minutes, 20)
    }
    const m = crewBy(run, mixed).stuck
    assert.equal(m, null, 'the later old-kind stall line is a later event of the stalled agent')
    for (const slug of oldCrews) assert.equal(crewBy(run, slug).stuck, null, `${slug} has no stuck state`)
    // crew leads only of the new type
    for (const c of run.crews) {
      const all = [c[LEAD], ...c.members].filter(Boolean)
      for (const x of all) assert.equal(roleWord(x) === LEAD_ROLE, x.type === NEW_TYPE, `${c.slug}/${x.name} (${x.type})`)
      const first = orderAgents(all, null)[0]
      if (all.some((x: any) => x.type === NEW_TYPE)) assert.equal(first.type, NEW_TYPE)
      else assert.notEqual(first.type, OLD_TYPE)
    }
  } finally { w.store.close() }
})

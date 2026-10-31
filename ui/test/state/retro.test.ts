// Store tests for the retro key (ADR-0012 Decision 8; R-23), written from docs/retro-state.schema.json and
// ui/contract/state.schema.json ($defs/retro, $defs/retroStep) before reading the implementation. They add to
// what ui/contract/state.check.ts pins (a per-run detail shows, null for non-JSON and a wrong v) and never
// repeat it. Self-contained: the validator is copied from that check, not imported. Every case writes a value
// generated per run, so an empty or constant implementation fails. Temp copies of tests/fixtures/retro-040 and
// docs/plan.example.json per test; removed at the end.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
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
// Fixture helpers
// ---------------------------------------------------------------------------
const fixtureDir = path.join(root, 'tests/fixtures/retro-040')
const planExample = path.join(root, 'docs/plan.example.json')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'truss-state-retro-'))
let counter = 0
const rand = (): string => randomBytes(4).toString('hex')

interface World { base: string; repo: string; truss: string }

function makeWorld(): World {
  const base = path.join(tmpRoot, `w${++counter}`)
  const repo = path.join(base, 'repo')
  const truss = path.join(base, 'truss')
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'docs/adr'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.claude/truss.json'), JSON.stringify({ architecture: 'docs/architecture.md', adr: 'docs/adr', merge: 'sequential', target: 'main' }))
  fs.writeFileSync(path.join(repo, 'docs/architecture.md'), '# Architecture\n\nA unique line, 7f3a.\n')
  fs.writeFileSync(path.join(repo, 'docs/adr/0001-first.md'), '# ADR-0001: first choice\n\nStatus: accepted, 2026-01-02\n')
  fs.cpSync(fixtureDir, truss, { recursive: true })
  fs.copyFileSync(planExample, path.join(truss, 'plan.json'))
  return { base, repo, truss }
}

const STEPS = ['extract', 'judges', 'triage', 'fixGoal', 'applied'] as const
type StepName = (typeof STEPS)[number]
const AT = '2026-10-31T08:30:00Z'

function retroValue(over: Partial<Record<StepName, { status: string; at: string | null; detail: string | null }>> = {}, updatedAt = AT): any {
  const steps: any = {}
  for (const k of STEPS) steps[k] = over[k] ?? { status: 'pending', at: null, detail: null }
  return { v: 1, updatedAt, steps }
}
function writeRetro(truss: string, value: unknown): string {
  const file = path.join(truss, 'retro/state.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
  return file
}

async function open(w: World, trussDir: string | null = w.truss): Promise<any> {
  const opts: any = { repo: w.repo, trussDir, pollMs: 50 }
  const store = producer.createStore(opts)
  await store.ready
  return store
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(store: any, ok: (s: any) => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms
  for (;;) {
    if (ok(store.snapshot().state)) return
    if (Date.now() > end) assert.fail(`timed out after ${ms} ms waiting for ${what}`)
    await tick(25)
  }
}

function retroOf(store: any): any {
  const snap = store.snapshot()
  assertSchema('snapshot', snap)
  if (!('retro' in snap.state)) throw new Error(`producer missing: ${MODULE} retro (the state has no retro key)`)
  return snap.state.retro
}

// Every file under dir with its bytes (hex) and mtime, and every directory.
function tree(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string, rel: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`
      const full = path.join(d, e.name)
      if (e.isDirectory()) { out.push(`${r}/ dir`); walk(full, r) }
      else out.push(`${r} ${fs.readFileSync(full).toString('hex')} ${fs.lstatSync(full).mtimeMs}`)
    }
  }
  walk(dir, '')
  return out.sort()
}

after(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }) })

function registerTests(): void {
  test('R-23: no retro/ dir reads as retro null; creating retro/state.json later sends a delta that sets retro', async () => {
    const w = makeWorld()
    assert.equal(fs.existsSync(path.join(w.truss, 'retro')), false, 'the fixture has no retro/ dir')
    const store = await open(w)
    try {
      assert.equal(retroOf(store), null)
      const deltas: any[] = []
      const off = store.subscribe((d: any) => deltas.push(d))
      const detail = `${rand()} findings kept`
      writeRetro(w.truss, retroValue({ extract: { status: 'done', at: AT, detail }, judges: { status: 'running', at: AT, detail: null } }))
      await until(store, (s) => s.retro?.steps?.extract?.detail === detail, 2000, `retro extract detail ${detail}`)
      off()
      const withRetro = deltas.filter((d) => d.set && 'retro' in d.set)
      assert.ok(withRetro.length >= 1, `no delta set retro (deltas: ${JSON.stringify(deltas).slice(0, 300)})`)
      for (const d of deltas) assertSchema('delta', d)
      const last = withRetro[withRetro.length - 1]
      assert.equal(last.set.retro.steps.extract.detail, detail)
      assert.equal(last.set.retro.steps.judges.status, 'running')
      assert.deepEqual(last.set.retro, retroOf(store), 'the delta and the snapshot agree')
      for (const k of STEPS) assert.ok(k in last.set.retro.steps, `step ${k} is in the delta`)
    } finally { store.close() }
  })

  test('R-23: a rewrite that changes only the mtime sends no delta with retro; a changed detail does', async () => {
    const w = makeWorld()
    const detail = `${rand()} kept`
    const value = retroValue({ extract: { status: 'done', at: AT, detail } })
    const file = writeRetro(w.truss, value)
    const store = await open(w)
    try {
      await until(store, (s) => s.retro?.steps?.extract?.detail === detail, 2000, 'retro read at start')
      const deltas: any[] = []
      const off = store.subscribe((d: any) => deltas.push(d))
      const seq0 = store.snapshot().seq
      await tick(100)
      // Same bytes, a newer mtime; then the same value written with different whitespace.
      const later = new Date(Date.now() + 5000)
      fs.writeFileSync(file, JSON.stringify(value))
      fs.utimesSync(file, later, later)
      await tick(400)
      fs.writeFileSync(file, JSON.stringify(value, null, 2))
      await tick(400)
      assert.deepEqual(deltas.filter((d) => d.set && 'retro' in d.set), [], 'no delta with retro for an unchanged value')
      assert.equal(retroOf(store).steps.extract.detail, detail)
      // The kept side: a real change produces one.
      const next = `${rand()} changed`
      writeRetro(w.truss, retroValue({ extract: { status: 'done', at: AT, detail: next } }))
      await until(store, (s) => s.retro?.steps?.extract?.detail === next, 2000, `retro detail ${next}`)
      off()
      assert.ok(deltas.some((d) => d.set && 'retro' in d.set), 'a changed value sends a delta with retro')
      assert.ok(store.snapshot().seq > seq0)
    } finally { store.close() }
  })

  const bad: Array<[string, (v: any, tag: string) => void]> = [
    ['a missing step', (v) => { delete v.steps.triage }],
    ['a status outside the enum', (v, tag) => { v.steps.judges.status = `going-${tag}` }],
    ['an extra property on a step', (v, tag) => { v.steps.applied[`extra${tag}`] = 1 }],
    ['an extra property on the file', (v, tag) => { v[`extra${tag}`] = 1 }],
    ['a step without detail', (v) => { delete v.steps.fixGoal.detail }],
  ]
  for (const [name, breakIt] of bad) {
    test(`R-23: a v 1 file with ${name} reads as retro null (and the valid file before and after shows)`, async () => {
      const w = makeWorld()
      const tag = rand()
      const good = `${tag} good`
      const store = await open(w)
      try {
        assert.equal(retroOf(store), null)
        const broken = retroValue({ extract: { status: 'done', at: AT, detail: `${tag} broken` } })
        breakIt(broken, tag)
        writeRetro(w.truss, broken)
        await tick(300) // several polls
        assert.equal(retroOf(store), null, `${name} must not show under retro`)
        // The kept side: a valid file shows, then the broken one hides it again.
        writeRetro(w.truss, retroValue({ extract: { status: 'done', at: AT, detail: good } }))
        await until(store, (s) => s.retro?.steps?.extract?.detail === good, 2000, `valid retro ${good}`)
        writeRetro(w.truss, broken)
        await until(store, (s) => s.retro === null, 2000, `retro null again for ${name}`)
      } finally { store.close() }
    })
  }

  test('R-23: deleting retro/state.json brings retro back to null, with a delta that sets retro null', async () => {
    const w = makeWorld()
    const detail = `${rand()} kept`
    const file = writeRetro(w.truss, retroValue({ extract: { status: 'done', at: AT, detail } }))
    const store = await open(w)
    try {
      await until(store, (s) => s.retro?.steps?.extract?.detail === detail, 2000, 'retro read at start')
      const deltas: any[] = []
      const off = store.subscribe((d: any) => deltas.push(d))
      fs.rmSync(file)
      await until(store, (s) => s.retro === null, 2000, 'retro null after delete')
      off()
      const gone = deltas.filter((d) => d.set && 'retro' in d.set)
      assert.ok(gone.length >= 1, 'a delta carries retro')
      assert.equal(gone[gone.length - 1].set.retro, null)
      for (const d of deltas) assertSchema('delta', d)
      // It comes back when the file does.
      const again = `${rand()} again`
      writeRetro(w.truss, retroValue({ extract: { status: 'done', at: AT, detail: again } }))
      await until(store, (s) => s.retro?.steps?.extract?.detail === again, 2000, `retro back ${again}`)
    } finally { store.close() }
  })

  test('R-23: setTrussDir to a second dir shows the second dir\'s retro and never the first\'s', async () => {
    const a = makeWorld()
    const b = makeWorld()
    const da = `${rand()} first dir`
    const db = `${rand()} second dir`
    const fa = writeRetro(a.truss, retroValue({ extract: { status: 'done', at: AT, detail: da } }))
    const fb = writeRetro(b.truss, retroValue({ extract: { status: 'failed', at: AT, detail: db } }))
    const store = await open(a)
    try {
      await until(store, (s) => s.retro?.steps?.extract?.detail === da, 2000, 'first dir retro')
      const seen: string[] = []
      const off = store.subscribe((d: any) => { if (d.set && 'retro' in d.set) seen.push(JSON.stringify(d.set.retro)) })
      store.setTrussDir(b.truss)
      await until(store, (s) => s.retro?.steps?.extract?.detail === db, 2000, 'second dir retro')
      assert.equal(retroOf(store).steps.extract.status, 'failed')
      // A change in the first dir is not shown any more.
      writeRetro(a.truss, retroValue({ extract: { status: 'done', at: AT, detail: `${da} changed` } }))
      await tick(400)
      assert.equal(retroOf(store).steps.extract.detail, db)
      off()
      assert.ok(!seen.some((s) => s.includes(`${da} changed`)), 'the first dir is no longer watched')
      // A dir without a retro file reads as null; null path too.
      const c = makeWorld()
      store.setTrussDir(c.truss)
      await until(store, (s) => s.retro === null, 2000, 'retro null for a dir without retro/')
      store.setTrussDir(null)
      await tick(150)
      assert.equal(retroOf(store), null)
      store.setTrussDir(a.truss)
      await until(store, (s) => s.retro?.steps?.extract?.detail === `${da} changed`, 2000, 'first dir again')
      assert.ok(fs.existsSync(fa) && fs.existsSync(fb))
    } finally { store.close() }
  })

  test('R-23: the store never writes under retro/: files are byte-identical and none appeared', async () => {
    const w = makeWorld()
    const tag = rand()
    const file = writeRetro(w.truss, retroValue({ extract: { status: 'done', at: AT, detail: `${tag} kept` }, judges: { status: 'running', at: AT, detail: null } }))
    const extra = path.join(w.truss, 'retro/note.txt')
    fs.writeFileSync(extra, `note ${tag}\n`)
    // Settle mtimes, then take the listing.
    const old = new Date('2026-10-30T10:00:00Z')
    fs.utimesSync(file, old, old)
    fs.utimesSync(extra, old, old)
    fs.utimesSync(path.join(w.truss, 'retro'), old, old)
    const before = tree(path.join(w.truss, 'retro'))
    const dirMtime = fs.statSync(path.join(w.truss, 'retro')).mtimeMs
    const store = await open(w)
    try {
      await until(store, (s) => s.retro?.steps?.extract?.detail === `${tag} kept`, 2000, 'retro read')
      store.setTrussDir(w.truss)
      await tick(300)
      assert.equal(retroOf(store).steps.judges.status, 'running', 'the store did read the file')
    } finally { store.close() }
    await tick(100)
    assert.deepEqual(tree(path.join(w.truss, 'retro')), before, 'retro/ is unchanged after the store ran')
    assert.equal(fs.statSync(path.join(w.truss, 'retro')).mtimeMs, dirMtime, 'no file was created or removed in retro/')
    assert.deepEqual(fs.readdirSync(path.join(w.truss, 'retro')).sort(), ['note.txt', 'state.json'])
  })

  test('R-23: a store with no retro/ dir does not create one', async () => {
    const w = makeWorld()
    const store = await open(w)
    try {
      assert.equal(retroOf(store), null)
      await tick(300)
    } finally { store.close() }
    assert.equal(fs.existsSync(path.join(w.truss, 'retro')), false, 'the UI never creates retro/')
  })
}

if (producer === null) {
  test(`producer missing: ${MODULE} retro`, () => {
    throw new Error(`producer missing: ${MODULE} retro`)
  })
} else {
  registerTests()
}

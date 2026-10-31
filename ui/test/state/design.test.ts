// Design-panel and git tests for ui-state (ADR-0011 Decisions 4, 7 and 9), written from the ADR
// and ui/contract/state.schema.json before any implementation exists. Real git in temp repos
// (git init, commits, branches truss-<slug>). Self-contained: the validator and helpers are
// copied from ui/contract/state.check.ts, not imported. Temp copies of tests/fixtures/retro-040
// and docs/plan.example.json; every temp dir is removed at the end.
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
// Fixture and git helpers
// ---------------------------------------------------------------------------
const fixtureDir = path.join(root, 'tests/fixtures/retro-040')
const planExample = path.join(root, 'docs/plan.example.json')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'truss-state-design-'))
let counter = 0

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }

function git(cwd: string, args: string[], date?: string): string {
  const env: Record<string, string | undefined> = { ...GIT_ENV }
  if (date !== undefined) { env.GIT_AUTHOR_DATE = date; env.GIT_COMMITTER_DATE = date }
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, env, encoding: 'utf8' })
}

// The same cleaning as hooks/register.ts safeName (lines 115-118), copied here so this test
// does not import the plugin.
function safeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+|\.{2,}/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 100)
  return cleaned === '' ? 'agent' : cleaned
}

const bytesOf = (tag: string): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]), Buffer.from(`${tag}\n\u0000\u0001`)])

function writeFile(repo: string, rel: string, data: Buffer | string): void {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
  fs.writeFileSync(path.join(repo, rel), data)
}

interface World { base: string; repo: string; truss: string; target: string; approvedAt: string }

const OLD = '2026-10-01T12:00:00Z'
const APPROVED = '2026-10-15T00:00:00.000Z'
const NEW = '2026-10-20T12:00:00Z'

// A git repo whose target branch holds: C0 (before approvedAt) with img/old.png and img/mod.png,
// then C1 (after) adding one file of each extension and some non-images, and modifying
// img/mod.png. Branch truss-quotas is cut from C0 and adds three files, one not an image.
// Branch truss-gateway is cut from C0 with no image. The Truss dir holds the retro-040 fixture
// with docs/plan.example.json as plan.json and approvedAt set.
function makeWorld(target = 'main'): World {
  const base = path.join(tmpRoot, `w${++counter}`)
  const repo = path.join(base, 'repo')
  const truss = path.join(base, 'truss')
  fs.mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q', '-b', target])
  writeFile(repo, '.claude/truss.json', JSON.stringify({ architecture: 'docs/architecture.md', adr: 'docs/adr', merge: 'sequential', target }))
  writeFile(repo, 'docs/architecture.md', '# Architecture\n')
  writeFile(repo, 'docs/adr/0001-first.md', '# ADR-0001: first\n\nStatus: accepted, 2026-01-02\n')
  writeFile(repo, 'img/old.png', bytesOf('old'))
  writeFile(repo, 'img/mod.png', bytesOf('mod-1'))
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'C0'], OLD)
  git(repo, ['branch', 'truss-quotas'])
  git(repo, ['branch', 'truss-gateway'])
  for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp']) writeFile(repo, `img/new.${ext}`, bytesOf(`new-${ext}`))
  writeFile(repo, 'img/new.svg', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>\n')
  writeFile(repo, 'img/mod.png', bytesOf('mod-2'))
  writeFile(repo, 'img/notes.txt', 'not an image\n')
  writeFile(repo, 'img/doc.pdf', 'not an image either\n')
  writeFile(repo, 'img/pic.bmp', bytesOf('bmp'))
  writeFile(repo, 'img/lookspng', 'no dot, no extension\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'C1'], NEW)
  git(repo, ['checkout', '-q', 'truss-quotas'])
  writeFile(repo, 'shots/q.png', bytesOf('quotas-png'))
  writeFile(repo, 'shots/q.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>\n')
  writeFile(repo, 'shots/q.txt', 'text\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'quotas shots'], NEW)
  git(repo, ['checkout', '-q', target])
  fs.cpSync(fixtureDir, truss, { recursive: true })
  const plan = JSON.parse(fs.readFileSync(planExample, 'utf8'))
  plan.approvedAt = APPROVED
  fs.writeFileSync(path.join(truss, 'plan.json'), JSON.stringify(plan))
  return { base, repo, truss, target, approvedAt: APPROVED }
}

const pairKey = (p: any): string => `${p.ref}:${p.path}`
const sortedPairs = (images: any[]): string[] => images.map(pairKey).sort()

async function until(store: any, pred: (s: any) => boolean, ms: number, what: string): Promise<number> {
  const t0 = Date.now()
  for (;;) {
    const s = store.snapshot().state
    let ok = false
    try { ok = pred(s) } catch { ok = false }
    if (ok) return Date.now() - t0
    if (Date.now() - t0 > ms) assert.fail(`not shown within ${ms} ms: ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

// ADR-0011 D4: ui-state runs git again every 5 s and each child has a 10 s timeout.
const GIT_WAIT = 14000

function registerTests(mod: any): void {
  const stores: any[] = []
  after(() => {
    for (const s of stores) { try { s.close() } catch { /* ignore */ } }
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  async function ready(w: World): Promise<any> {
    const store = mod.createStore({ repo: w.repo, trussDir: w.truss, pollMs: 50 })
    stores.push(store)
    await store.ready
    return store
  }

  const wantMain = (t: string): string[] => ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].map((e) => `${t}:img/new.${e}`)
  const wantQuotas = ['truss-quotas:shots/q.png', 'truss-quotas:shots/q.svg']

  // ---- Decision 9: trussDirFor ---------------------------------------------------------------

  test('ADR-0011 D9 trussDirFor: gives <git common dir>/truss/<safeName(id)> in the main checkout', async () => {
    const w = makeWorld()
    const got = await mod.trussDirFor(w.repo, 'sess-abc-123')
    assert.equal(typeof got, 'string')
    assert.equal(path.basename(got), 'sess-abc-123')
    assert.equal(path.basename(path.dirname(got)), 'truss')
    assert.equal(fs.realpathSync(path.dirname(path.dirname(got))), fs.realpathSync(path.join(w.repo, '.git')))
    assert.ok(path.isAbsolute(got))
  })

  test('ADR-0011 D9 trussDirFor: from inside a worktree it is the main repo\'s git common dir, shared by every worktree', async () => {
    const w = makeWorld()
    const wt = path.join(w.base, 'wt')
    git(w.repo, ['worktree', 'add', '-q', '-b', 'side', wt])
    const fromMain = await mod.trussDirFor(w.repo, 'sess-1')
    const fromWt = await mod.trussDirFor(wt, 'sess-1')
    assert.equal(path.basename(fromWt), 'sess-1')
    assert.equal(fs.realpathSync(path.dirname(path.dirname(fromWt))), fs.realpathSync(path.join(w.repo, '.git')))
    assert.equal(fs.realpathSync(path.dirname(fromWt)), fs.realpathSync(path.dirname(fromMain)))
    assert.equal(path.dirname(path.dirname(fromWt)).includes(`${path.sep}worktrees${path.sep}`), false, 'not the per-worktree git dir')
  })

  test('ADR-0011 D9 trussDirFor: the id goes through safeName (cleaning, dots, length, empty)', async () => {
    const w = makeWorld()
    const cases: Array<[string, string]> = [
      ['sess 1/2', 'sess-1-2'],
      ['../../etc/passwd', safeName('../../etc/passwd')],
      ['a..b', 'a-b'],
      ['--x--', 'x'],
      ['', 'agent'],
      ['///', 'agent'],
      ['x'.repeat(150), 'x'.repeat(100)],
      ['é ü', safeName('é ü')],
    ]
    for (const [id, want] of cases) {
      const got = await mod.trussDirFor(w.repo, id)
      assert.equal(path.basename(got), want, `id ${JSON.stringify(id)}`)
      assert.equal(path.basename(path.dirname(got)), 'truss', `id ${JSON.stringify(id)} stays one segment under truss`)
      assert.equal(fs.realpathSync(path.dirname(path.dirname(got))), fs.realpathSync(path.join(w.repo, '.git')), `id ${JSON.stringify(id)}`)
    }
    assert.equal(safeName('sess 1/2'), 'sess-1-2')
  })

  // ---- Decision 7: images --------------------------------------------------------------------

  test('ADR-0011 D7 Images: the target lists image files added since approvedAt, each of the six extensions, nothing else', async () => {
    const w = makeWorld()
    const store = await ready(w)
    await until(store, (s) => s.design.images.some((i: any) => i.ref === 'main'), GIT_WAIT, 'main images')
    const snap = store.snapshot()
    assert.ok(snap.state.design.images.every((i: any) => typeof i.ref === 'string' && typeof i.path === 'string'))
    const onMain = sortedPairs(snap.state.design.images.filter((i: any) => i.ref === w.target))
    assert.deepEqual(onMain, wantMain(w.target).sort())
    assert.ok(!onMain.includes('main:img/old.png'), 'added before approvedAt')
    assert.ok(!onMain.includes('main:img/mod.png'), 'only modified since approvedAt, not added')
    for (const bad of ['notes.txt', 'doc.pdf', 'pic.bmp', 'lookspng']) assert.ok(!onMain.includes(`main:img/${bad}`), bad)
    assert.ok(!snap.state.design.images.some((i: any) => i.path.endsWith('.md') || i.path.endsWith('.json')))
  })

  test('ADR-0011 D7 Images: each existing truss-<slug> branch lists the images it added against the target, and no more', async () => {
    const w = makeWorld()
    const store = await ready(w)
    await until(store, (s) => s.design.images.some((i: any) => i.ref === 'truss-quotas'), GIT_WAIT, 'truss-quotas images')
    const images = store.snapshot().state.design.images
    assert.deepEqual(sortedPairs(images.filter((i: any) => i.ref === 'truss-quotas')), wantQuotas)
    assert.deepEqual(images.filter((i: any) => i.ref === 'truss-gateway'), [], 'a branch that added no image lists none')
    assert.equal(images.filter((i: any) => i.ref.startsWith('truss-') && i.ref !== 'truss-quotas').length, 0)
    assert.deepEqual(sortedPairs(images), [...wantMain(w.target), ...wantQuotas].sort())
    assertSchema('snapshot', store.snapshot())
  })

  test('ADR-0011 D7 Images: the target branch comes from .claude/truss.json, not from the name main', async () => {
    const w = makeWorld('trunk')
    const store = await ready(w)
    await until(store, (s) => s.design.images.some((i: any) => i.ref === 'trunk'), GIT_WAIT, 'trunk images')
    const images = store.snapshot().state.design.images
    assert.deepEqual(sortedPairs(images.filter((i: any) => i.ref === 'trunk')), wantMain('trunk').sort())
    assert.deepEqual(sortedPairs(images.filter((i: any) => i.ref === 'truss-quotas')), wantQuotas)
  })

  test('ADR-0011 D4 git: images added later are listed on a later git run, on the target and on a branch', async () => {
    const w = makeWorld()
    const store = await ready(w)
    await until(store, (s) => s.design.images.length >= 8, GIT_WAIT, 'first images')
    writeFile(w.repo, 'img/later.png', bytesOf('later'))
    git(w.repo, ['add', '-A'])
    git(w.repo, ['commit', '-q', '-m', 'later'], '2026-10-25T12:00:00Z')
    git(w.repo, ['checkout', '-q', 'truss-gateway'])
    writeFile(w.repo, 'gw/g.webp', bytesOf('gateway-webp'))
    git(w.repo, ['add', '-A'])
    git(w.repo, ['commit', '-q', '-m', 'gw'], '2026-10-25T12:00:00Z')
    git(w.repo, ['checkout', '-q', w.target])
    await until(store, (s) => { const k = sortedPairs(s.design.images); return k.includes('main:img/later.png') && k.includes('truss-gateway:gw/g.webp') }, GIT_WAIT, 'later images')
  })

  test('ADR-0011 D9 readImage: returns the committed bytes for each listed (ref, path) pair', async () => {
    const w = makeWorld()
    const store = await ready(w)
    await until(store, (s) => s.design.images.length >= 8, GIT_WAIT, 'images')
    const pairs = store.snapshot().state.design.images
    for (const p of pairs) {
      const got = await store.readImage(p.ref, p.path)
      assert.ok(Buffer.isBuffer(got), `${pairKey(p)} gives a Buffer`)
      const want = execFileSync('git', ['show', `${p.ref}:${p.path}`], { cwd: w.repo, maxBuffer: 1 << 20 })
      assert.equal(Buffer.compare(got, want), 0, `${pairKey(p)} bytes`)
    }
    const png = await store.readImage('truss-quotas', 'shots/q.png')
    assert.equal(Buffer.compare(png, bytesOf('quotas-png')), 0, 'binary bytes, with NUL and 0xff, come back untouched')
    const main = await store.readImage(w.target, 'img/new.png')
    assert.equal(Buffer.compare(main, bytesOf('new-png')), 0)
  })

  test('ADR-0011 D9 readImage: null for any pair that is not in design.images', async () => {
    const w = makeWorld()
    const store = await ready(w)
    await until(store, (s) => s.design.images.length >= 8, GIT_WAIT, 'images')
    const unlisted: Array<[string, string]> = [
      [w.target, 'img/old.png'], // in git, but added before approvedAt
      [w.target, 'img/mod.png'],
      [w.target, 'img/notes.txt'],
      [w.target, 'docs/architecture.md'],
      [w.target, '.claude/truss.json'],
      ['truss-quotas', 'img/new.png'], // listed under main, not under this ref
      ['truss-gateway', 'shots/q.png'],
      ['truss-quotas', 'shots/q.txt'],
      ['truss-nope', 'shots/q.png'], // no such ref
      [w.target, 'img/missing.png'],
      [w.target, '../../../../etc/passwd'],
      [w.target, 'img/../img/new.png'], // same file by another spelling is not the listed pair
      [w.target, '/img/new.png'],
      [`${w.target}:img`, 'new.png'],
      ['--output=/tmp/x', 'img/new.png'],
      ['', ''],
    ]
    for (const [ref, p] of unlisted) {
      assert.equal(await store.readImage(ref, p), null, `${JSON.stringify([ref, p])} must give null`)
    }
  })

  test('ADR-0011 D4 git: a git failure gives the git-error notice and keeps the last good images', async () => {
    const w = makeWorld()
    const store = await ready(w)
    await until(store, (s) => s.design.images.length >= 8, GIT_WAIT, 'good images first')
    const good = structuredClone(store.snapshot().state.design.images)
    assert.ok(!store.snapshot().state.notices.some((n: any) => n.id === 'git-error'))
    fs.renameSync(path.join(w.repo, '.git'), path.join(w.base, 'git-away')) // the repo stops being a repo
    await until(store, (s) => s.notices.some((n: any) => n.id === 'git-error'), GIT_WAIT, 'git-error notice')
    const s = store.snapshot().state
    assertSchema('snapshot', store.snapshot())
    assert.deepEqual(s.design.images, good, 'the last good images stay')
    assert.ok(s.notices.find((n: any) => n.id === 'git-error').text.length > 0)
    // the file-backed parts keep working while git is down
    assert.equal(s.design.architecture.path, 'docs/architecture.md')
    assert.ok(s.run !== null)
  })
}

if (producer === null) {
  test(`producer missing: ${MODULE}`, () => {
    throw new Error(`producer missing: ${MODULE}`)
  })
} else {
  registerTests(producer)
}

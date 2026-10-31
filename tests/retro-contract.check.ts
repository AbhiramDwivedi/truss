// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0012 Seams: contract checks for retro/extract.ts, retro/catalog.ts, retro/scrub.ts and retro/cli.ts.
// Written from the ADR and docs/*.schema.json before any of them exists (R-24, R-25, R-27, R-31, R-32, R-35).
//
// Run with: node --test tests/retro-contract.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs.
// Each producer is imported inside the test that needs it, so a missing file fails that test with
// "producer missing: retro/<file>" instead of crashing this file.
//
// Every value that could be answered by a fixed string is generated per run (random hex): the planted tokens, the
// session id, the catalog ids, the scrubber's email, path and secret. The committed fixtures under
// tests/fixtures/transcripts/ carry @@T_*@@ placeholders; a test copies them into a temp dir and fills them in.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = join(PLUGIN, 'tests', 'fixtures', 'transcripts')
const DOCS = join(PLUGIN, 'docs')

// ---------- producers ----------

const load = async (file: string) => {
  try {
    return await import(pathToFileURL(join(PLUGIN, 'retro', file)).href)
  } catch (e) {
    assert.fail(`producer missing: retro/${file} (${e?.code ?? e?.message})`)
  }
}
const extractMod = () => load('extract.ts')
const catalogMod = () => load('catalog.ts')
const scrubMod = () => load('scrub.ts')
const cliMod = () => load('cli.ts')

const tmps: string[] = []
const mktmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'retro-contract-'))
  tmps.push(d)
  return d
}
after(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true })
})

// ---------- a small JSON Schema (2020-12 subset) validator, copied from ui/contract/state.check.ts ----------

const readSchema = (name: string) => JSON.parse(readFileSync(join(DOCS, `${name}.schema.json`), 'utf8'))

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

function validate(root: any, s: any, v: any, at: string, errs: string[]): void {
  if (s.$ref) {
    assert.ok(s.$ref.startsWith('#'), `unsupported $ref ${s.$ref}`)
    let node: any = root
    for (const part of s.$ref.slice(1).split('/').filter(Boolean)) node = node[part]
    return validate(root, node, v, at, errs)
  }
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
    if (s.format === 'date-time' && !(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(v) && !Number.isNaN(Date.parse(v)))) {
      mine.push(`${at}: ${v} is not an RFC 3339 date-time`)
    }
    if (s.format === 'date' && !(/^\d{4}-\d\d-\d\d$/.test(v) && !Number.isNaN(Date.parse(v)))) mine.push(`${at}: ${v} is not a date`)
  }
  if (typeof v === 'number' && s.minimum !== undefined && v < s.minimum) mine.push(`${at}: below minimum ${s.minimum}`)
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) mine.push(`${at}: fewer than ${s.minItems} items`)
    if (s.maxItems !== undefined && v.length > s.maxItems) mine.push(`${at}: more than ${s.maxItems} items`)
    if (s.items) v.forEach((x, i) => validate(root, s.items, x, `${at}[${i}]`, mine))
  }
  if (typeOk('object', v)) {
    for (const k of s.required ?? []) if (!(k in v)) mine.push(`${at}: missing required ${k}`)
    const props = s.properties ?? {}
    for (const [k, x] of Object.entries(v)) {
      if (k in props) validate(root, props[k], x, `${at}.${k}`, mine)
      else if (s.additionalProperties === false) mine.push(`${at}: unexpected property ${k}`)
      else if (typeOk('object', s.additionalProperties)) validate(root, s.additionalProperties, x, `${at}.${k}`, mine)
    }
  }
  if (s.oneOf) {
    const ok = s.oneOf.filter((o: any) => {
      const e: string[] = []
      validate(root, o, v, at, e)
      return e.length === 0
    })
    if (ok.length !== 1) mine.push(`${at}: matches ${ok.length} of ${s.oneOf.length} oneOf branches`)
  }
  if (s.anyOf) {
    const ok = s.anyOf.some((o: any) => {
      const e: string[] = []
      validate(root, o, v, at, e)
      return e.length === 0
    })
    if (!ok) mine.push(`${at}: matches no anyOf branch`)
  }
  errs.push(...mine)
}

// schemaName: the docs/<name>.schema.json file; def: a $defs name, or null for the whole document
function assertSchema(schemaName: string, def: string | null, value: unknown): void {
  const root = readSchema(schemaName)
  const errs: string[] = []
  validate(root, def === null ? root : { $ref: `#/$defs/${def}` }, value, schemaName, errs)
  assert.deepEqual(errs.slice(0, 10), [], `${schemaName}${def ? ' $defs.' + def : ''} breaks its schema`)
}

// ---------- per-run values and the temp session dir ----------

const hex = (n = 5) => randomBytes(n).toString('hex')
// each token begins with a distinct letter pair, so no token is a substring of another
const tokens = () => ({
  ERR: `er${hex()}`,
  HOOK: `hk${hex()}`,
  CLS: `cl${hex()}`,
  CMD: `cm${hex()}`,
  CAT: `pl${hex()}`,
  CATF: `fx${hex()}`,
  CATN: `qt${hex()}`,
  ANC: `an${hex()}`,
})
type Tokens = ReturnType<typeof tokens>

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out.sort()
}

// copies the committed fixtures into <root>/proj/<sid>.jsonl and <root>/proj/<sid>/subagents/..., filling each placeholder
function buildSession(root: string, sid: string, t: Tokens): { projDir: string; sessionDir: string; main: string; agent: string; journal: string } {
  const projDir = join(root, 'proj')
  const sessionDir = join(projDir, sid)
  mkdirSync(projDir, { recursive: true })
  cpSync(join(FIXTURES, 'subagents'), join(sessionDir, 'subagents'), { recursive: true })
  cpSync(join(FIXTURES, 'session.jsonl'), join(projDir, `${sid}.jsonl`))
  for (const f of walk(projDir)) {
    if (!f.endsWith('.jsonl')) continue
    let text = readFileSync(f, 'utf8')
    for (const [k, v] of Object.entries(t)) text = text.replaceAll(`@@T_${k}@@`, v)
    writeFileSync(f, text)
  }
  return {
    projDir,
    sessionDir,
    main: `${sid}.jsonl`,
    agent: `${sid}/subagents/agent-fixture.jsonl`,
    journal: `${sid}/subagents/workflows/wf_fixture/journal.jsonl`,
  }
}

const planted = (t: Tokens, sid: string) => ({
  v: 1,
  entries: [
    { id: `planted-${t.CAT}`, kind: 'friction', title: `planted ${t.CAT}`, anchor: t.CAT, patterns: [`${t.CAT}: planted failure`], fix: `fix for ${t.CAT}`, fixedBy: null },
    { id: `fixed-${t.CATF}`, kind: 'mechanical bug', title: `fixed ${t.CATF}`, anchor: t.CATF, patterns: [`${t.CATF}: planted`], fix: `fix for ${t.CATF}`, fixedBy: { finding: `earlier-${sid}/F-3`, date: '2026-10-01' } },
    { id: `quiet-${t.CATN}`, kind: 'friction', title: `quiet ${t.CATN}`, anchor: t.CATN, patterns: [t.CATN], fix: `fix for ${t.CATN}`, fixedBy: { finding: `earlier-${sid}/F-4`, date: '2026-10-02' } },
    { id: `anchor-${t.ANC}`, kind: 'friction', title: `anchor ${t.ANC}`, anchor: t.ANC, patterns: ['.'], fix: `fix for ${t.ANC}`, fixedBy: null },
  ],
})

const sidOf = () => `${hex(4)}-${hex(2)}-4${hex(2).slice(0, 3)}-8${hex(2).slice(0, 3)}-${hex(6)}`

// one planted session, extracted once per file and shared by the tests that only read it
async function plantedRun() {
  const t = tokens()
  const sid = sidOf()
  const root = mktmp()
  const s = buildSession(root, sid, t)
  const catPath = join(root, 'planted-catalog.json')
  const catObj = planted(t, sid)
  writeFileSync(catPath, JSON.stringify(catObj, null, 2) + '\n')
  const { loadCatalog } = await catalogMod()
  const { extractSession, writeExtract } = await extractMod()
  const catalog = loadCatalog(catPath)
  const x = extractSession(s.sessionDir, catalog)
  const trussDir = join(root, 'truss')
  mkdirSync(trussDir, { recursive: true })
  const written = writeExtract(trussDir, x)
  return { t, sid, root, s, catPath, catObj, catalog, x, trussDir, written }
}

const find = (x: any, kind: string, file: string, line: number) => x.items.find((i: any) => i.kind === kind && i.file === file && i.line === line)

// ---------- fixtures themselves ----------

describe('committed fixtures (R-32): clean content, real record shapes', () => {
  test('the four fixture files exist and every line is JSON bar the one planted non-JSON line', () => {
    const files = walk(FIXTURES).map(f => relative(FIXTURES, f))
    assert.deepEqual(files, ['session.jsonl', 'subagents/agent-fixture.jsonl', 'subagents/agent-fixture.meta.json', 'subagents/workflows/wf_fixture/journal.jsonl'])
    let bad = 0
    for (const f of files.filter(x => x.endsWith('.jsonl'))) {
      for (const l of readFileSync(join(FIXTURES, f), 'utf8').split('\n').filter(Boolean)) {
        try {
          JSON.parse(l)
        } catch {
          bad++
        }
      }
    }
    assert.equal(bad, 1, 'exactly one line is not JSON (it is counted under skipped.json)')
  })

  test('no fixture holds an email, a /home/<name>/ path or a token', async () => {
    const { scrub } = await scrubMod()
    for (const f of walk(FIXTURES)) assert.deepEqual(scrub(readFileSync(f, 'utf8')), [], `${relative(FIXTURES, f)} must be clean`)
  })

  test('the fixtures hold placeholders, never a filled-in per-run token', () => {
    const all = walk(FIXTURES).map(f => readFileSync(f, 'utf8')).join('\n')
    for (const k of ['ERR', 'HOOK', 'CLS', 'CMD', 'CAT', 'CATF', 'ANC']) assert.ok(all.includes(`@@T_${k}@@`), `placeholder ${k}`)
  })
})

// ---------- extract (R-24, R-35, data 1, core 6) ----------

describe('retro/extract.ts: extractSession and writeExtract', () => {
  test('returns an extract that validates against docs/extract.schema.json, session = the dir name', async () => {
    const r = await plantedRun()
    assertSchema('extract', null, r.x)
    assert.equal(r.x.session, r.sid)
    assert.equal(r.x.v, 1)
  })

  test('files: every transcript read, relative to the project dir, in code-point order, with line counts', async () => {
    const { x, s } = await plantedRun()
    assert.deepEqual(
      x.files.map((f: any) => f.path),
      [s.main, s.agent, s.journal],
    )
    assert.deepEqual(
      x.files.map((f: any) => f.lines),
      [12, 13, 6],
    )
  })

  test('writeExtract returns <truss dir>/retro/extract.json and writes JSON.stringify(x, null, 2) + newline', async () => {
    const { x, trussDir, written } = await plantedRun()
    assert.equal(written, join(trussDir, 'retro', 'extract.json'))
    assert.equal(readFileSync(written, 'utf8'), JSON.stringify(x, null, 2) + '\n')
  })

  test('a tool_result error comes back as a toolError with its file:line, tool and agent', async () => {
    const { x, t, s } = await plantedRun()
    const i = find(x, 'toolError', s.main, 7)
    assert.ok(i, 'toolError at the main transcript, line 7')
    assert.ok(i.quote.includes(t.ERR), 'quote holds the per-run token')
    assert.equal(i.tool, 'Read')
    assert.equal(i.agent, 'main')
    assert.equal(i.ts, '2026-01-01T00:00:06.000Z')
  })

  test('a hook denial is a refusal from truss (not a toolError), with its file:line', async () => {
    const { x, t, s } = await plantedRun()
    const i = find(x, 'refusal', s.main, 5)
    assert.ok(i, 'refusal at the main transcript, line 5')
    assert.equal(i.source, 'truss')
    assert.equal(i.tool, 'Bash')
    assert.ok(i.quote.includes(t.HOOK))
    assert.equal(find(x, 'toolError', s.main, 5), undefined, 'a refusal is no toolError')
  })

  test('a classifier denial is a refusal from the classifier, in the agent transcript, with its file:line', async () => {
    const { x, t, s } = await plantedRun()
    const i = find(x, 'refusal', s.agent, 7)
    assert.ok(i, 'refusal at the agent transcript, line 7')
    assert.equal(i.source, 'classifier')
    assert.equal(i.agent, 'fixture')
    assert.ok(i.quote.includes(t.CLS))
    assert.equal(find(x, 'toolError', s.agent, 7), undefined)
  })

  test('the worktree guard is a refusal with source worktree-guard', async () => {
    const { x, s } = await plantedRun()
    const i = find(x, 'refusal', s.agent, 12)
    assert.ok(i, 'refusal at the agent transcript, line 12')
    assert.equal(i.source, 'worktree-guard')
    assert.equal(find(x, 'toolError', s.agent, 12), undefined)
  })

  test('a repeated Bash command is one repeat item: first line, count, every run, retried', async () => {
    const { x, t, s } = await plantedRun()
    const reps = x.items.filter((i: any) => i.kind === 'repeat')
    assert.equal(reps.length, 1, 'only the planted command repeats')
    const i = reps[0]
    assert.equal(i.file, s.agent)
    assert.equal(i.line, 2)
    assert.deepEqual(i.lines, [2, 4])
    assert.equal(i.count, 2)
    assert.equal(i.retried, true, 'the first run errored')
    assert.ok(i.quote.includes(t.CMD))
  })

  test('a Write in the main transcript is a handEdit; a checkFail holds the trace path; a stop holds its marker', async () => {
    const { x, s } = await plantedRun()
    const h = find(x, 'handEdit', s.main, 2)
    assert.ok(h)
    assert.equal(h.tool, 'Write')
    assert.equal(h.path, '/work/app/src/widget.ts')
    assert.equal(h.agent, 'main')
    const c = find(x, 'checkFail', s.agent, 9)
    assert.ok(c)
    assert.ok(c.traces.some((p: string) => p.includes('thing.ts:42')), `traces ${JSON.stringify(c.traces)}`)
    const stop = find(x, 'stop', s.agent, 13)
    assert.ok(stop)
    assert.equal(stop.marker, 'CHECKPOINT')
  })

  test('journal: started lines are steps; a BLOCKED result is a stop; a VERDICT: FAIL result is a qcFail', async () => {
    const { x, s } = await plantedRun()
    const s1 = find(x, 'step', s.journal, 2)
    const s2 = find(x, 'step', s.journal, 3)
    assert.ok(s1 && s2)
    assert.equal(s1.label, 'fixture-tester-1')
    assert.equal(s1.agent, 'wf-agent-1')
    assert.equal(s2.label, 'fixture-qc-1')
    const stop = find(x, 'stop', s.journal, 4)
    assert.ok(stop)
    assert.equal(stop.marker, 'BLOCKED')
    assert.ok(find(x, 'qcFail', s.journal, 5))
    assert.equal(find(x, 'qcFail', s.journal, 4), undefined, 'a BLOCKED result is no qcFail')
  })

  test('items come in file order, then line order', async () => {
    const { x } = await plantedRun()
    const order = x.files.map((f: any) => f.path)
    for (let n = 1; n < x.items.length; n++) {
      const a = x.items[n - 1]
      const b = x.items[n]
      const fa = order.indexOf(a.file)
      const fb = order.indexOf(b.file)
      assert.ok(fa < fb || (fa === fb && a.line <= b.line), `item ${n} (${b.kind} ${b.file}:${b.line}) is out of order after ${a.kind} ${a.file}:${a.line}`)
    }
  })

  test('records with an unknown type, and non-JSON lines, are skipped and counted (core 6)', async () => {
    const { x, s } = await plantedRun()
    assert.deepEqual(x.skipped, { json: 1, type: { 'api-request-blob': 1, 'fixture-future': 1, 'journal-future': 1 } })
    for (const i of x.items) assert.ok(!(i.file === s.main && (i.line === 8 || i.line === 9)), 'nothing is made of a skipped line')
  })

  test('the same transcripts and catalog give the same bytes, from a different temp dir (data 1)', async () => {
    const a = await plantedRun()
    const { extractSession, writeExtract } = await extractMod()
    const root2 = mktmp()
    const s2 = buildSession(root2, a.sid, a.t)
    const x2 = extractSession(s2.sessionDir, a.catalog)
    const trussDir2 = join(root2, 'truss')
    mkdirSync(trussDir2, { recursive: true })
    const w2 = writeExtract(trussDir2, x2)
    assert.equal(readFileSync(w2, 'utf8'), readFileSync(a.written, 'utf8'))
    // and over its own earlier file, whole
    const w3 = writeExtract(a.trussDir, extractSession(a.s.sessionDir, a.catalog))
    assert.equal(readFileSync(w3, 'utf8'), readFileSync(a.written, 'utf8'))
  })

  test('the extract still reads after the session dir is deleted (R-35)', async () => {
    const a = await plantedRun()
    const before = readFileSync(a.written, 'utf8')
    rmSync(a.root + '/proj', { recursive: true, force: true })
    assert.equal(existsSync(a.s.sessionDir), false)
    const back = JSON.parse(readFileSync(a.written, 'utf8'))
    assert.equal(readFileSync(a.written, 'utf8'), before)
    assertSchema('extract', null, back)
    assert.ok(back.items.some((i: any) => i.kind === 'refusal' && i.source === 'classifier' && i.quote.includes(a.t.CLS)))
    assert.deepEqual(back.files.map((f: any) => f.lines), [12, 13, 6], 'line counts survive for later evidence checks')
  })
})

// ---------- catalog (R-25) ----------

describe('retro/catalog.ts: the planted catalog is matched by the extractor (R-25)', () => {
  test('a planted catalog line is reported with the entry id (hit) and the entry keeps its fix', async () => {
    const { x, t, s, catalog } = await plantedRun()
    const entry = catalog.entries.find((e: any) => e.id === `planted-${t.CAT}`)
    assert.ok(entry, 'loadCatalog keeps the entry')
    assert.equal(entry.fix, `fix for ${t.CAT}`)
    const hits = x.catalogHits.filter((h: any) => h.id === entry.id)
    assert.deepEqual(hits.map((h: any) => `${h.file}:${h.line}`).sort(), [`${s.main}:11`, `${s.journal}:4`].sort())
    for (const h of hits) assert.ok(h.quote.includes(`${t.CAT}: planted failure`), 'the quote is the matched line, not the prose mention at line 3')
    assert.ok(!x.catalogHits.some((h: any) => h.id === entry.id && h.file === s.main && h.line === 3), 'the anchor in prose, with no pattern match, is no hit')
  })

  test('a line hits only when it holds the anchor: an always-true pattern hits just the anchor line', async () => {
    const { x, t, s } = await plantedRun()
    const hits = x.catalogHits.filter((h: any) => h.id === `anchor-${t.ANC}`)
    assert.equal(hits.length, 1)
    assert.equal(hits[0].file, s.main)
    assert.equal(hits[0].line, 11)
    assert.ok(hits[0].quote.includes(t.ANC))
  })

  test('an entry whose anchor is not in the transcripts gets no hit', async () => {
    const { x, t } = await plantedRun()
    assert.equal(x.catalogHits.filter((h: any) => h.id === `quiet-${t.CATN}`).length, 0)
  })

  test('matchLine returns hit ids in catalog order, and none for a clean line', async () => {
    const { catalog, t } = await plantedRun()
    const { matchLine } = await catalogMod()
    assert.deepEqual(matchLine(`${t.CAT}: planted failure`, catalog), [`planted-${t.CAT}`])
    assert.deepEqual(matchLine(`${t.CAT} mentioned in prose only`, catalog), [])
    assert.deepEqual(matchLine(`${t.CAT}: planted failure and ${t.ANC} too`, catalog), [`planted-${t.CAT}`, `anchor-${t.ANC}`])
    assert.deepEqual(matchLine('ok 14 - all good', catalog), [])
  })

  test('loadCatalog refuses a file that breaks the schema or holds a pattern that does not compile', async () => {
    const { loadCatalog } = await catalogMod()
    const t = tokens()
    const dir = mktmp()
    const good = planted(t, 'x')
    const bad = (name: string, obj: any) => {
      const p = join(dir, name)
      writeFileSync(p, JSON.stringify(obj))
      return p
    }
    assert.doesNotThrow(() => loadCatalog(bad('good.json', good)))
    assert.throws(() => loadCatalog(bad('v2.json', { ...good, v: 2 })))
    assert.throws(() => loadCatalog(bad('regex.json', { v: 1, entries: [{ ...good.entries[0], patterns: ['('] }] })))
    assert.throws(() => loadCatalog(bad('noanchor.json', { v: 1, entries: [{ ...good.entries[0], anchor: undefined }] })))
    assert.throws(() => loadCatalog(bad('id.json', { v: 1, entries: [{ ...good.entries[0], id: 'Not A Slug' }] })))
    assert.throws(() => loadCatalog(join(dir, 'missing.json')))
  })
})

describe('retro/catalog.json: the six seed entries (ADR-0012 Decision 3)', () => {
  const SEEDS: Record<string, string> = {
    'webkit-host-libs': 'libicudata',
    'settings-local-not-in-worktrees': 'settings.local.json',
    'worktree-guard-shell-shape': 'Refusing to run it',
    'harness-only-claude-code': "Cannot find package 'claude-code'",
    'node-modules-missing': "Cannot find package '",
    'tracked-pyc': '__pycache__',
  }
  const CLEAN = [
    'ok 14 - parses the plan',
    'all 14 tests passed in 3.2s',
    'On branch main',
    'nothing to commit, working tree clean',
    'Exit code 0',
    'x',
    '    at run (/work/app/src/thing.ts:42:7)',
  ]
  const seedCatalog = async () => {
    const { loadCatalog } = await catalogMod()
    const path = join(PLUGIN, 'retro', 'catalog.json')
    if (!existsSync(path)) assert.fail('producer missing: retro/catalog.json')
    return { catalog: loadCatalog(path), path, loadCatalog }
  }

  test('catalog.json validates against docs/catalog.schema.json and holds exactly the six ids and anchors', async () => {
    const { catalog, path } = await seedCatalog()
    assertSchema('catalog', null, JSON.parse(readFileSync(path, 'utf8')))
    assert.deepEqual(Object.fromEntries(catalog.entries.map((e: any) => [e.id, e.anchor])), SEEDS)
    for (const e of catalog.entries) assert.ok(e.fix.length > 10, `${e.id} has a real fix`)
  })

  test('only tracked-pyc carries a probe, and it is the one ADR-0012 fixes', async () => {
    const { catalog } = await seedCatalog()
    for (const e of catalog.entries) {
      if (e.id === 'tracked-pyc') assert.deepEqual(e.probe, { kind: 'command', run: `test -z "$(git ls-files -- '*.pyc')"` })
      else assert.equal(e.probe, undefined, `${e.id} has no probe`)
    }
  })

  test('each entry has patterns that compile and that fail on every clean line (an always-true pattern fails)', async () => {
    const { catalog } = await seedCatalog()
    for (const e of catalog.entries) {
      assert.ok(e.patterns.length > 0, e.id)
      for (const p of e.patterns) {
        const re = new RegExp(p)
        assert.notEqual(p, '', `${e.id}: empty pattern`)
        for (const line of CLEAN) assert.equal(re.test(line), false, `${e.id}: pattern ${p} matches the clean line "${line}"`)
        assert.equal(re.test(''), false, `${e.id}: pattern ${p} matches the empty line`)
      }
    }
  })

  test('matchLine returns nothing for any clean line, and no entry hits a line without its anchor', async () => {
    const { catalog } = await seedCatalog()
    const { matchLine } = await catalogMod()
    for (const line of CLEAN) assert.deepEqual(matchLine(line, catalog), [], line)
    for (const e of catalog.entries) {
      // the anchor-less version of a line that does hit it must not hit
      const stripped = `${e.id} ${CLEAN[1]}`
      assert.deepEqual(matchLine(stripped, catalog).filter((id: string) => id === e.id), [])
    }
  })

  test('real-shaped lines hit their own entry: webkit, the worktree guard, the harness-only package, a missing package', async () => {
    const { catalog } = await seedCatalog()
    const { matchLine } = await catalogMod()
    assert.deepEqual(
      matchLine('[pid=7][err] /cache/ms-playwright/webkit-2370/minibrowser-wpe/bin/MiniBrowser: error while loading shared libraries: libicudata.so.74: cannot open shared object file: No such file or directory', catalog),
      ['webkit-host-libs'],
    )
    assert.deepEqual(
      matchLine('This agent is isolated in the worktree /work/wt, but this command is too complex to verify that it stays inside the worktree. Refusing to run it — a worktree-isolated agent cannot do that.', catalog),
      ['worktree-guard-shell-shape'],
    )
    assert.deepEqual(
      matchLine("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'claude-code' imported from /work/app/tests/roles.test.ts", catalog),
      ['harness-only-claude-code'],
      "node-modules-missing's patterns must not match 'claude-code'",
    )
    assert.deepEqual(matchLine("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'vitest' imported from /work/app/tests/x.test.ts", catalog), ['node-modules-missing'])
  })
})

// ---------- findings (R-27) ----------

describe('retro/cli.ts findings: a finding with no cited line is dropped, a valid one is kept (R-27)', () => {
  const block = (o: any) => '```finding\n' + JSON.stringify(o, null, 2) + '\n```\n'
  const judged = (t: string, file: string, line: number, extra: any = {}) => ({
    kind: 'friction',
    title: `finding ${t}`,
    evidence: [{ file, line }],
    cost: `lost 2 turns on ${t}`,
    fix: `change the prompt for ${t}`,
    target: 'agents/foreman.md',
    signature: [`${t}: planted`],
    ...extra,
  })

  test('keeps the valid finding as F-1, drops the one with no evidence and the one citing a line past the file', async () => {
    const a = await plantedRun()
    const { main } = await cliMod()
    const label = `judge-${hex(3)}`
    const report = join(a.root, 'report.md')
    const good = judged(a.t.ERR, a.s.main, 7)
    writeFileSync(
      report,
      [
        'Some prose from the judge.\n',
        block(judged(`${a.t.HOOK}`, a.s.main, 7, { evidence: [] })),
        block(good),
        block(judged(`${a.t.CLS}`, a.s.agent, 999)),
        block(judged(`${a.t.CMD}`, `${a.sid}/subagents/not-in-the-extract.jsonl`, 1)),
        'trailing prose\n',
      ].join('\n'),
    )
    rmSync(join(a.root, 'proj'), { recursive: true, force: true }) // the session dir is gone: evidence is checked against the extract (R-35)
    const r = await main(['findings', a.trussDir, label, report])
    const lines = r.out.split('\n').filter(Boolean)
    assert.ok(lines.includes(`KEPT: F-1 | finding ${a.t.ERR}`), r.out)
    assert.ok(lines.some(l => l.startsWith('DROPPED: 1 | ')), `block 1 (no evidence) dropped: ${r.out}`)
    assert.ok(lines.some(l => l.startsWith('DROPPED: 3 | ')), `block 3 (line past the file) dropped: ${r.out}`)
    assert.ok(lines.some(l => l.startsWith('DROPPED: 4 | ')), `block 4 (file not in the extract) dropped: ${r.out}`)
    assert.ok(!lines.some(l => l.startsWith('KEPT: ') && l !== `KEPT: F-1 | finding ${a.t.ERR}`), 'nothing else is kept')
    assert.equal(lines[lines.length - 1], 'OK: 1 kept, 3 dropped')
    const saved = JSON.parse(readFileSync(join(a.trussDir, 'retro', 'findings.json'), 'utf8'))
    assertSchema('findings', null, saved)
    assert.equal(saved.findings.length, 1)
    assert.equal(saved.findings[0].id, 'F-1')
    assert.equal(saved.findings[0].judge, label)
    assert.deepEqual(saved.findings[0].evidence, good.evidence)
  })

  test('a second batch continues the numbering at F-2 and appends', async () => {
    const a = await plantedRun()
    const { main } = await cliMod()
    const report = join(a.root, 'report.md')
    writeFileSync(report, block(judged(a.t.ERR, a.s.main, 7)))
    await main(['findings', a.trussDir, 'j1', report])
    const again = `second-${a.t.CMD}`
    writeFileSync(report, block(judged(again, a.s.agent, 13)))
    const r = await main(['findings', a.trussDir, 'j2', report])
    assert.ok(r.out.includes(`KEPT: F-2 | finding ${again}`), r.out)
    const saved = JSON.parse(readFileSync(join(a.trussDir, 'retro', 'findings.json'), 'utf8'))
    assert.deepEqual(saved.findings.map((f: any) => `${f.id}/${f.judge}`), ['F-1/j1', 'F-2/j2'])
    assertSchema('findings', null, saved)
  })

  test('a finding whose kind is not one of the seven is dropped', async () => {
    const a = await plantedRun()
    const { main } = await cliMod()
    const report = join(a.root, 'report.md')
    writeFileSync(report, block(judged(a.t.ERR, a.s.main, 7, { kind: 'cosmetic' })) + block(judged(a.t.CMD, a.s.main, 7, { kind: 'missing hook or gate' })))
    const r = await main(['findings', a.trussDir, 'j', report])
    assert.ok(r.out.includes('DROPPED: 1 | '), r.out)
    assert.ok(r.out.includes(`KEPT: F-1 | finding ${a.t.CMD}`), r.out)
  })
})

// ---------- recurrence (R-31) ----------

describe('retro/cli.ts recur: a fixed finding whose signature recurs is reported, one that does not is not (R-31)', () => {
  test('RECURRED names the entry, cites the fix and the file:line; the quiet fixed entry and unfixed entries print nothing', async () => {
    const a = await plantedRun()
    const { main } = await cliMod()
    const r = await main(['recur', a.trussDir, a.catPath])
    const lines = r.out.split('\n').filter(Boolean)
    const fixed = a.catObj.entries[1]
    const recurred = lines.filter(l => l.startsWith('RECURRED: '))
    assert.deepEqual(recurred, [`RECURRED: ${fixed.id} | fixed by ${fixed.fixedBy.finding} (${fixed.fixedBy.date}) | ${a.s.main}:11`])
    assert.ok(!r.out.includes(`quiet-${a.t.CATN}`), 'the fixed entry that did not recur is not reported')
    assert.ok(!r.out.includes(`planted-${a.t.CAT}`), 'an entry no retro fixed is no recurrence')
    assert.equal(lines[lines.length - 1], 'OK: 1 recurred of 2 fixed')
    assert.equal(r.code, 0)
    const saved = JSON.parse(readFileSync(join(a.trussDir, 'retro', 'findings.json'), 'utf8'))
    assertSchema('findings', null, saved)
    assert.equal(saved.findings.length, 1)
    assert.equal(saved.findings[0].judge, 'recur')
    assert.equal(saved.findings[0].kind, fixed.kind)
    assert.deepEqual(saved.findings[0].recurs, { catalog: fixed.id, fixedBy: fixed.fixedBy })
    assert.ok(saved.findings[0].evidence.some((e: any) => e.file === a.s.main && e.line === 11))
  })

  test('recurrences(x, catalog) names the recurred entry and not the quiet one', async () => {
    const a = await plantedRun()
    const { recurrences } = await catalogMod()
    const out = recurrences(a.x, a.catalog)
    assert.ok(Array.isArray(out))
    const s = JSON.stringify(out)
    assert.ok(s.includes(`fixed-${a.t.CATF}`))
    assert.ok(!s.includes(`quiet-${a.t.CATN}`))
    assert.ok(!s.includes(`planted-${a.t.CAT}`))
  })

  test('with no fixed entry hit, nothing is reported and nothing is appended', async () => {
    const a = await plantedRun()
    const { main } = await cliMod()
    const cat = { v: 1, entries: [a.catObj.entries[0], a.catObj.entries[2]] }
    const p = join(a.root, 'only-quiet.json')
    writeFileSync(p, JSON.stringify(cat))
    const r = await main(['recur', a.trussDir, p])
    assert.ok(!r.out.includes('RECURRED'))
    assert.equal(r.out.split('\n').filter(Boolean).pop(), 'OK: 0 recurred of 1 fixed')
  })
})

// ---------- scrubber (R-32) ----------

describe('retro/scrub.ts: refuses an email, a /home/<name>/ path and a token; passes clean text (R-32)', () => {
  test('each per-run value is reported with its 1-based line and kind, and clean lines are not', async () => {
    const { scrub } = await scrubMod()
    const u = `u${hex(4)}`
    const email = `${u}@corp${hex(3)}.org`
    const homePath = `/home/${u}/work/${hex(2)}/notes.md`
    const macPath = `/Users/${u}/work/${hex(2)}`
    const ghp = `ghp_${hex(15)}`
    const sk = `sk-${hex(12)}`
    const kv = `api_key = ${hex(10)}`
    const text = ['clean first line', `mail me at ${email} please`, 'another clean line', `see ${homePath} for details`, `mac ${macPath}`, `Authorization: ${ghp}`, `key ${sk}`, `config ${kv}`, 'last clean line'].join('\n')
    const hits = scrub(text)
    const at = (line: number) => hits.filter((h: any) => h.line === line).map((h: any) => h.kind)
    assert.deepEqual(at(2), ['email'])
    assert.deepEqual(at(4), ['home-path'])
    assert.deepEqual(at(5), ['home-path'])
    assert.deepEqual(at(6), ['token'])
    assert.deepEqual(at(7), ['token'])
    assert.deepEqual(at(8), ['token'])
    for (const l of [1, 3, 9]) assert.deepEqual(at(l), [], `line ${l} is clean`)
    assert.equal(hits.length, 6)
  })

  test('passes clean text and the allowed exceptions', async () => {
    const { scrub } = await scrubMod()
    const clean = [
      'Plain prose with no secrets, 12345678901234567890 and a sk-short.',
      'Co-Authored-By: Claude <noreply@anthropic.com>',
      'write to someone@example.com or a@host.invalid',
      'the path /home/<name>/project is a placeholder',
      'the words token and password alone are not secrets',
      `see src/${hex(3)}.ts:42 and tests/${hex(3)}.check.ts`,
    ].join('\n')
    assert.deepEqual(scrub(clean), [])
    assert.deepEqual(scrub(''), [])
  })

  test('cli scrub: OK on clean files; HIT lines and exit 1 on a dirty one; usage error exits 2', async () => {
    const { main } = await cliMod()
    const dir = mktmp()
    const clean = join(dir, 'clean.md')
    const dirty = join(dir, 'dirty.md')
    const u = `u${hex(4)}`
    writeFileSync(clean, 'nothing to see\nhere\n')
    writeFileSync(dirty, `fine\ncontact ${u}@corp${hex(3)}.org\nfine\n`)
    const ok = await main(['scrub', clean])
    assert.equal(ok.code, 0)
    assert.equal(ok.out.trim(), 'OK: 1 files clean')
    const bad = await main(['scrub', clean, dirty])
    assert.equal(bad.code, 1)
    assert.ok(bad.out.split('\n').includes(`HIT: ${dirty}:2 | email`), bad.out)
    assert.ok(!bad.out.includes(`HIT: ${clean}`))
    const usage = await main(['scrub'])
    assert.equal(usage.code, 2)
    assert.ok(usage.out.startsWith('FAIL:'), usage.out)
    const missing = await main(['scrub', join(dir, 'nope.md')])
    assert.equal(missing.code, 2)
    assert.ok(missing.out.startsWith('FAIL:'), missing.out)
  })
})

// ---------- cli: the rest of the command table ----------

describe('retro/cli.ts: commands, extract and state (ADR-0012 Seams)', () => {
  test('COMMANDS lists extract, findings, recur, scrub and state; main with no or an unknown command is a usage error', async () => {
    const { main, COMMANDS } = await cliMod()
    const names = Array.isArray(COMMANDS) ? COMMANDS : COMMANDS instanceof Map ? [...COMMANDS.keys()] : Object.keys(COMMANDS)
    for (const c of ['extract', 'findings', 'recur', 'scrub', 'state']) assert.ok(names.includes(c), `COMMANDS has ${c}`)
    for (const argv of [[], [`bogus-${hex(3)}`]]) {
      const r = await main(argv)
      assert.equal(r.code, 2)
      assert.ok(r.out.startsWith('FAIL:'), r.out)
    }
  })

  test('extract writes <truss dir>/retro/extract.json and prints the counts line; a missing session dir is FAIL, exit 2', async () => {
    const a = await plantedRun()
    const { main } = await cliMod()
    const trussDir = join(a.root, 'truss-cli')
    mkdirSync(trussDir, { recursive: true })
    const r = await main(['extract', trussDir, a.s.sessionDir, a.catPath])
    const x = JSON.parse(readFileSync(join(trussDir, 'retro', 'extract.json'), 'utf8'))
    assert.equal(r.code, 0)
    assert.equal(r.out.trim(), `OK: ${x.items.length} items, ${x.catalogHits.length} catalog hits from ${x.files.length} files`)
    assert.equal(readFileSync(join(trussDir, 'retro', 'extract.json'), 'utf8'), readFileSync(a.written, 'utf8'), 'the CLI and writeExtract agree byte for byte')
    const gone = await main(['extract', trussDir, join(a.root, 'no-such-session'), a.catPath])
    assert.equal(gone.code, 2)
    assert.ok(gone.out.startsWith('FAIL:'), gone.out)
  })

  test('state writes retro/state.json under docs/retro-state.schema.json: every step pending at first, then the one set', async () => {
    const { main } = await cliMod()
    const trussDir = mktmp()
    const detail = `${hex(3)} findings kept`
    const r = await main(['state', trussDir, 'judges', 'running', detail])
    assert.equal(r.code, 0)
    assert.equal(r.out.trim(), 'OK: judges running')
    const st = JSON.parse(readFileSync(join(trussDir, 'retro', 'state.json'), 'utf8'))
    assertSchema('retro-state', null, st)
    assert.equal(st.steps.judges.status, 'running')
    assert.equal(st.steps.judges.detail, detail)
    for (const s of ['extract', 'triage', 'fixGoal', 'applied']) assert.equal(st.steps[s].status, 'pending', s)
    const r2 = await main(['state', trussDir, 'judges', 'done'])
    assert.equal(r2.code, 0)
    const st2 = JSON.parse(readFileSync(join(trussDir, 'retro', 'state.json'), 'utf8'))
    assert.equal(st2.steps.judges.status, 'done')
    assertSchema('retro-state', null, st2)
    const badStep = await main(['state', trussDir, 'nope', 'done'])
    assert.equal(badStep.code, 2)
    const badStatus = await main(['state', trussDir, 'judges', 'sideways'])
    assert.equal(badStatus.code, 2)
  })
})

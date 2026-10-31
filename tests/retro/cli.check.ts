// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0012 Decisions 5, 7, 8 and Seams: edge checks for retro/cli.ts.
// Written from the ADR and docs/*.schema.json before retro/ exists. tests/retro-contract.check.ts holds the first
// command cases (a mixed findings report, recur, one scrub, one state, usage on no command); this file adds the
// edges it lacks: bad blocks beside good ones, line-count boundaries, a missing or corrupt extract, a corrupt
// state file, argument counts, and several dirty files in one scrub.
//
// Run with: node --test tests/retro/cli.check.ts
// Self-contained on purpose: no shared helper and no import of another check file. Each producer is imported inside
// the test that needs it, so a missing file fails that test with "producer missing: retro/<file>".
// The cli's extract is built with retro/extract.ts from a temp session dir made per run. Every id, label, title and
// secret is generated per run (random hex); emails, home paths and tokens are assembled from parts so this file
// scrubs clean.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DOCS = join(PLUGIN, 'docs')

const load = async (file: string) => {
  try {
    return await import(pathToFileURL(join(PLUGIN, 'retro', file)).href)
  } catch (e) {
    assert.fail(`producer missing: retro/${file} (${e?.code ?? e?.message})`)
  }
}
const extractMod = () => load('extract.ts')
const catalogMod = () => load('catalog.ts')
const cliMod = () => load('cli.ts')

const tmps: string[] = []
const mktmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'retro-cli-'))
  tmps.push(d)
  return d
}
after(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true })
})

const hex = (n = 5) => randomBytes(n).toString('hex')
const sidOf = () => `${hex(4)}-${hex(2)}-4${hex(2).slice(0, 3)}-8${hex(2).slice(0, 3)}-${hex(6)}`

// ---------- a small JSON Schema (2020-12 subset) validator, copied from tests/retro-contract.check.ts ----------

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
  }
  if (typeof v === 'number' && s.minimum !== undefined && v < s.minimum) mine.push(`${at}: below minimum ${s.minimum}`)
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) mine.push(`${at}: fewer than ${s.minItems} items`)
    if (s.items) v.forEach((x, i) => validate(root, s.items, x, `${at}[${i}]`, mine))
  }
  if (typeOk('object', v)) {
    for (const k of s.required ?? []) if (!(k in v)) mine.push(`${at}: missing required ${k}`)
    const props = s.properties ?? {}
    for (const [k, x] of Object.entries(v)) {
      if (k in props) validate(root, props[k], x, `${at}.${k}`, mine)
      else if (s.additionalProperties === false) mine.push(`${at}: unexpected property ${k}`)
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
  errs.push(...mine)
}

function assertSchema(schemaName: string, value: unknown): void {
  const root = readSchema(schemaName)
  const errs: string[] = []
  validate(root, root, value, schemaName, errs)
  assert.deepEqual(errs.slice(0, 10), [], `${schemaName} breaks its schema`)
}

// ---------- a per-run session, its extract, and report blocks ----------

const ts = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString()
const MAIN_LINES = 6

// <root>/proj/<sid>.jsonl with MAIN_LINES records, extracted with retro/extract.ts into <root>/truss/retro/extract.json
async function prepared() {
  const { extractSession, writeExtract } = await extractMod()
  const { loadCatalog } = await catalogMod()
  const root = mktmp()
  const sid = sidOf()
  const projDir = join(root, 'proj')
  mkdirSync(projDir, { recursive: true })
  const err = `er${hex()}`
  const recs = [
    { type: 'user', message: { role: 'user', content: 'go' }, timestamp: ts(0) },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/w/app/x.txt' } }] }, timestamp: ts(1) },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: `File does not exist. ${err}`, is_error: true }] }, timestamp: ts(2) },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'one' }] }, timestamp: ts(3) },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'two' }] }, timestamp: ts(4) },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'three' }] }, timestamp: ts(5) },
  ]
  assert.equal(recs.length, MAIN_LINES)
  writeFileSync(join(projDir, `${sid}.jsonl`), recs.map(r => JSON.stringify(r)).join('\n') + '\n')
  const catPath = join(root, 'catalog.json')
  writeFileSync(catPath, JSON.stringify({ v: 1, entries: [{ id: `e-${hex(3)}`, kind: 'friction', title: 't', anchor: `an${hex(4)}`, patterns: ['.'], fix: 'f', fixedBy: null }] }))
  const trussDir = join(root, 'truss')
  mkdirSync(trussDir, { recursive: true })
  const x = extractSession(join(projDir, sid), loadCatalog(catPath))
  writeExtract(trussDir, x)
  assert.deepEqual(x.files, [{ path: `${sid}.jsonl`, lines: MAIN_LINES }], 'the helper session is what the cases below assume')
  return { root, sid, main: `${sid}.jsonl`, trussDir, catPath, x }
}

const block = (o: any) => '```finding\n' + (typeof o === 'string' ? o : JSON.stringify(o, null, 2)) + '\n```\n'
const judged = (title: string, file: string, line: number, extra: any = {}) => ({
  kind: 'friction',
  title,
  evidence: [{ file, line }],
  cost: `lost two turns to ${title}`,
  fix: `change the prompt for ${title}`,
  target: 'agents/foreman.md',
  signature: [`${title}: planted`],
  ...extra,
})
const readFindings = (trussDir: string) => JSON.parse(readFileSync(join(trussDir, 'retro', 'findings.json'), 'utf8'))
const linesOf = (out: string) => out.split('\n').filter(Boolean)

// ---------- findings: bad blocks beside good ones ----------

describe('retro/cli.ts findings: only a block that parses and passes $defs.judged is kept', () => {
  test('a non-JSON block, a block failing judged and a valid block in one report: the valid ones are kept as F-1, F-2; the rest drop by block position', async () => {
    const a = await prepared()
    const { main } = await cliMod()
    const tA = `A${hex(3)}`
    const tB = `B${hex(3)}`
    const label = `judge-${hex(3)}`
    const { cost: _cost, ...noCost } = judged(`nocost ${hex(3)}`, a.main, 3)
    const report = join(a.root, 'report.md')
    writeFileSync(
      report,
      [
        `Prose from the judge. ${hex(3)}\n`,
        block(`{ this is not json ${hex(4)}`), // 1
        block(noCost), // 2: missing a required field
        block(judged(tA, a.main, 3)), // 3: valid
        '```json\n' + JSON.stringify(judged(`notfinding ${hex(3)}`, a.main, 3)) + '\n```\n', // not a finding block: no number, no keep
        block(judged(`withid ${hex(3)}`, a.main, 3, { id: 'F-9' })), // 4: a judge may not pick its own id
        block(judged(tB, a.main, 6)), // 5: valid
        block(judged(`longquote ${hex(3)}`, a.main, 3, { evidence: [{ file: a.main, line: 3, quote: 'q'.repeat(201) }] })), // 6: quote over 200
        'closing prose\n',
      ].join('\n'),
    )
    const r = await main(['findings', a.trussDir, label, report])
    const lines = linesOf(r.out)
    assert.ok([0, 1].includes(r.code), `exit ${r.code}: ${r.out}`)
    assert.ok(lines.includes(`KEPT: F-1 | ${tA}`), r.out)
    assert.ok(lines.includes(`KEPT: F-2 | ${tB}`), r.out)
    assert.ok(lines.indexOf(`KEPT: F-1 | ${tA}`) < lines.indexOf(`KEPT: F-2 | ${tB}`), 'kept in report order')
    for (const n of [1, 2, 4, 6]) assert.ok(lines.some(l => new RegExp(`^DROPPED: ${n} \\| .+`).test(l)), `block ${n} is dropped, with a reason: ${r.out}`)
    for (const n of [3, 5]) assert.ok(!lines.some(l => l.startsWith(`DROPPED: ${n} |`)), `block ${n} was valid`)
    assert.equal(lines.filter(l => l.startsWith('KEPT: ')).length, 2)
    assert.equal(lines.filter(l => l.startsWith('DROPPED: ')).length, 4, 'the json block is not a finding block')
    assert.equal(lines[lines.length - 1], 'OK: 2 kept, 4 dropped')
    const saved = readFindings(a.trussDir)
    assertSchema('findings', saved)
    assert.deepEqual(saved.findings.map((f: any) => `${f.id}|${f.judge}|${f.title}`), [`F-1|${label}|${tA}`, `F-2|${label}|${tB}`])

    // a later batch from another judge continues the numbering and appends
    const tC = `C${hex(3)}`
    writeFileSync(report, block(judged(`nope ${hex(3)}`, a.main, 99)) + block(judged(tC, a.main, 2)))
    const r2 = await main(['findings', a.trussDir, 'judge-two', report])
    assert.ok(linesOf(r2.out).includes(`KEPT: F-3 | ${tC}`), `a dropped block takes no number: ${r2.out}`)
    const saved2 = readFindings(a.trussDir)
    assertSchema('findings', saved2)
    assert.deepEqual(saved2.findings.map((f: any) => f.id), ['F-1', 'F-2', 'F-3'])
    assert.equal(saved2.findings[2].judge, 'judge-two')
  })

  test('a report with no finding block gives OK: 0 kept, 0 dropped', async () => {
    const a = await prepared()
    const { main } = await cliMod()
    const report = join(a.root, 'report.md')
    writeFileSync(report, `Nothing found. ${hex(4)}\n\n\`\`\`\nnot a finding either\n\`\`\`\n`)
    const r = await main(['findings', a.trussDir, 'j', report])
    assert.equal(r.code, 0, r.out)
    assert.equal(linesOf(r.out).pop(), 'OK: 0 kept, 0 dropped')
    assert.ok(!r.out.includes('KEPT') && !r.out.includes('DROPPED'))
  })

  test('evidence is checked against the extract\u2019s line counts: the last line is kept, one past it, line 0 and one bad entry among good ones are dropped', async () => {
    const a = await prepared()
    const { main } = await cliMod()
    const names = { last: `last${hex(3)}`, past: `past${hex(3)}`, zero: `zero${hex(3)}`, mixed: `mixed${hex(3)}`, both: `both${hex(3)}`, other: `other${hex(3)}` }
    const report = join(a.root, 'report.md')
    writeFileSync(
      report,
      [
        block(judged(names.last, a.main, MAIN_LINES)), // 1: kept
        block(judged(names.past, a.main, MAIN_LINES + 1)), // 2
        block(judged(names.zero, a.main, 0)), // 3
        block(judged(names.mixed, a.main, 3, { evidence: [{ file: a.main, line: 3 }, { file: a.main, line: 99 }] })), // 4: one bad entry drops the finding
        block(judged(names.both, a.main, 3, { evidence: [{ file: a.main, line: 1 }, { file: a.main, line: MAIN_LINES }] })), // 5: kept
        block(judged(names.other, `${a.sid}/subagents/${hex(3)}.jsonl`, 1)), // 6: not in the extract's files
      ].join('\n'),
    )
    rmSync(join(a.root, 'proj'), { recursive: true, force: true }) // the extract alone decides (R-35)
    const r = await main(['findings', a.trussDir, 'j', report])
    const lines = linesOf(r.out)
    assert.ok(lines.includes(`KEPT: F-1 | ${names.last}`), r.out)
    assert.ok(lines.includes(`KEPT: F-2 | ${names.both}`), r.out)
    for (const n of [2, 3, 4, 6]) assert.ok(lines.some(l => l.startsWith(`DROPPED: ${n} | `)), `block ${n}: ${r.out}`)
    assert.equal(lines.pop(), 'OK: 2 kept, 4 dropped')
    assert.deepEqual(readFindings(a.trussDir).findings.map((f: any) => f.title), [names.last, names.both])
  })
})

// ---------- no extract, corrupt extract, no report ----------

describe('retro/cli.ts findings and recur: FAIL, exit 2, when the extract or the report cannot be read', () => {
  test('findings and recur against a truss dir with no extract give FAIL and exit 2, and write nothing', async () => {
    const a = await prepared()
    const { main } = await cliMod()
    const empty = join(a.root, 'truss-empty')
    mkdirSync(empty, { recursive: true })
    const report = join(a.root, 'report.md')
    writeFileSync(report, block(judged(`t${hex(3)}`, a.main, 3)))
    const f = await main(['findings', empty, 'j', report])
    assert.equal(f.code, 2, f.out)
    assert.ok(f.out.startsWith('FAIL:'), f.out)
    assert.ok(!f.out.includes('KEPT'), 'nothing is kept without an extract to check against')
    const r = await main(['recur', empty, a.catPath])
    assert.equal(r.code, 2, r.out)
    assert.ok(r.out.startsWith('FAIL:'), r.out)
    assert.equal(existsSync(join(empty, 'retro', 'findings.json')), false, 'no findings file is written')
  })

  test('an extract that is not JSON gives FAIL and exit 2 for both commands', async () => {
    const a = await prepared()
    const { main } = await cliMod()
    const dir = join(a.root, 'truss-bad')
    mkdirSync(join(dir, 'retro'), { recursive: true })
    writeFileSync(join(dir, 'retro', 'extract.json'), `{"v":1,"session":"${hex(3)}","files":[`)
    const report = join(a.root, 'report.md')
    writeFileSync(report, block(judged(`t${hex(3)}`, a.main, 3)))
    for (const argv of [['findings', dir, 'j', report], ['recur', dir, a.catPath]]) {
      const r = await main(argv)
      assert.equal(r.code, 2, `${argv[0]}: ${r.out}`)
      assert.ok(r.out.startsWith('FAIL:'), r.out)
    }
  })

  test('a missing report file gives FAIL and exit 2, and a missing catalog for recur does too', async () => {
    const a = await prepared()
    const { main } = await cliMod()
    const f = await main(['findings', a.trussDir, 'j', join(a.root, `nope-${hex(3)}.md`)])
    assert.equal(f.code, 2, f.out)
    assert.ok(f.out.startsWith('FAIL:'), f.out)
    const r = await main(['recur', a.trussDir, join(a.root, `nope-${hex(3)}.json`)])
    assert.equal(r.code, 2, r.out)
    assert.ok(r.out.startsWith('FAIL:'), r.out)
  })
})

// ---------- state ----------

describe('retro/cli.ts state: a corrupt or missing state.json starts from all-pending', () => {
  const STEPS = ['extract', 'judges', 'triage', 'fixGoal', 'applied']
  const readState = (dir: string) => JSON.parse(readFileSync(join(dir, 'retro', 'state.json'), 'utf8'))

  test('over a missing file, a missing retro dir and each kind of corrupt file, the result validates and only the one step is set', async () => {
    const { main } = await cliMod()
    const junk: Record<string, string> = {
      missing: null as any,
      garbage: `not json at all ${hex(8)}`,
      truncated: '{"v":1,"updatedAt":"2026-01-01T00:00:00Z","steps":{"extract":{"status":"do',
      empty: '',
      array: '[]',
      'other version': JSON.stringify({ v: 2, updatedAt: '2026-01-01T00:00:00Z', steps: {} }),
      'steps missing': JSON.stringify({ v: 1, updatedAt: '2026-01-01T00:00:00Z' }),
    }
    for (const [name, text] of Object.entries(junk)) {
      const dir = mktmp()
      if (text !== null) {
        mkdirSync(join(dir, 'retro'), { recursive: true })
        writeFileSync(join(dir, 'retro', 'state.json'), text)
      }
      const detail = `${hex(3)} findings kept`
      const r = await main(['state', dir, 'triage', 'running', detail])
      assert.equal(r.code, 0, `${name}: ${r.out}`)
      assert.equal(r.out.trim(), 'OK: triage running')
      const st = readState(dir)
      assertSchema('retro-state', st)
      assert.equal(st.v, 1, name)
      assert.equal(st.steps.triage.status, 'running', name)
      assert.equal(st.steps.triage.detail, detail, name)
      assert.ok(typeof st.steps.triage.at === 'string' && st.steps.triage.at.endsWith('Z'), `${name}: at is a UTC date-time`)
      for (const s of STEPS.filter(x => x !== 'triage')) assert.deepEqual(st.steps[s], { status: 'pending', at: null, detail: null }, `${name}: ${s} starts pending`)
    }
  })

  test('a valid earlier state is kept: a second call changes only its own step, and an absent detail is null', async () => {
    const { main } = await cliMod()
    const dir = mktmp()
    await main(['state', dir, 'extract', 'done', `${hex(3)} items`])
    const one = readState(dir)
    const r = await main(['state', dir, 'judges', 'running'])
    assert.equal(r.code, 0, r.out)
    const two = readState(dir)
    assertSchema('retro-state', two)
    assert.deepEqual(two.steps.extract, one.steps.extract, 'the earlier step is untouched, at included')
    assert.equal(two.steps.judges.status, 'running')
    assert.equal(two.steps.judges.detail, null)
    for (const s of ['triage', 'fixGoal', 'applied']) assert.equal(two.steps[s].status, 'pending')
    const r3 = await main(['state', dir, 'judges', 'failed', 'x'.repeat(40)])
    assert.equal(r3.code, 0)
    const three = readState(dir)
    assert.equal(three.steps.judges.status, 'failed')
    assert.equal(three.steps.judges.detail, 'x'.repeat(40))
    assertSchema('retro-state', three)
    for (const status of ['pending', 'running', 'done', 'failed', 'skipped']) {
      const rr = await main(['state', dir, 'applied', status])
      assert.equal(rr.code, 0, `${status}: ${rr.out}`)
      assert.equal(readState(dir).steps.applied.status, status)
    }
  })
})

// ---------- argument counts ----------

describe('retro/cli.ts: a wrong argument count is a usage error, exit 2, FAIL:, and nothing is written', () => {
  test('too few and too many arguments for every command', async () => {
    const { main } = await cliMod()
    const dir = mktmp()
    const f = join(dir, `f-${hex(3)}`)
    const x = (...rest: string[]) => rest
    const cases = [
      x('extract'),
      x('extract', dir),
      x('extract', dir, f, f, 'extra'),
      x('findings'),
      x('findings', dir),
      x('findings', dir, 'label'),
      x('findings', dir, 'label', f, 'extra'),
      x('recur'),
      x('recur', dir, f, 'extra'),
      x('state'),
      x('state', dir),
      x('state', dir, 'judges'),
      x('state', dir, 'judges', 'running', 'detail', 'extra'),
      x('scrub'),
    ]
    for (const argv of cases) {
      let r: any
      try {
        r = await main(argv)
      } catch (e) {
        assert.fail(`main(${JSON.stringify(argv.map(a => (a === dir ? '<dir>' : a === f ? '<file>' : a)))}) threw ${e?.message}`)
      }
      const shown = JSON.stringify(argv.map(a => (a === dir ? '<dir>' : a === f ? '<file>' : a)))
      assert.equal(r.code, 2, `${shown}: ${r.out}`)
      assert.ok(String(r.out).startsWith('FAIL:'), `${shown}: ${r.out}`)
    }
    assert.equal(existsSync(join(dir, 'retro')), false, 'a usage error writes nothing')
  })
})

// ---------- scrub over several files ----------

describe('retro/cli.ts scrub: several files, every hit listed', () => {
  const AT = '@'
  const homeDir = (root: string, name: string) => ['', root, name, 'x'].join('/')
  const tok = (n: number) => 'gh' + 'p_' + randomBytes(n).toString('hex').slice(0, 20)

  test('over three dirty files and a clean one, every HIT line is printed, in argument order then line order, and exit is 1', async () => {
    const { main } = await cliMod()
    const dir = mktmp()
    const u = `u${hex(4)}`
    const f1 = join(dir, `one-${hex(2)}.md`)
    const f2 = join(dir, `two-${hex(2)}.md`)
    const f3 = join(dir, `three-${hex(2)}.md`)
    const f4 = join(dir, `four-${hex(2)}.md`)
    writeFileSync(f1, ['fine', `mail ${u}${AT}corp${hex(3)}.org`, 'fine', `key ${tok(12)}`, 'fine'].join('\n') + '\n')
    writeFileSync(f2, `${homeDir('home', u)} at the top\nfine\n`)
    writeFileSync(f3, 'nothing here\nat all\n')
    writeFileSync(f4, ['fine', `api_key${'='}${hex(8)}`, 'fine', 'fine', `${u}${AT}d${hex(2)}.io and ${homeDir('Users', u)}`].join('\n') + '\n')
    const r = await main(['scrub', f4, f1, f3, f2])
    assert.equal(r.code, 1, r.out)
    const hits = linesOf(r.out).filter(l => l.startsWith('HIT: '))
    const want = [`HIT: ${f4}:2 | token`, `HIT: ${f4}:5 | email`, `HIT: ${f4}:5 | home-path`, `HIT: ${f1}:2 | email`, `HIT: ${f1}:4 | token`, `HIT: ${f2}:1 | home-path`]
    for (const w of want) assert.ok(hits.includes(w), `${w} is listed: ${r.out}`)
    assert.equal(hits.length, want.length, `exactly the hits there are: ${r.out}`)
    assert.ok(!r.out.includes(`HIT: ${f3}`), 'the clean file has no hit')
    const fileOrder = hits.map(h => h.slice('HIT: '.length, h.lastIndexOf(':', h.indexOf(' | '))))
    assert.deepEqual([...new Set(fileOrder)], [f4, f1, f2], 'files in argument order')
    const lineNos = hits.filter(h => h.includes(f4)).map(h => Number(h.match(/:(\d+) \|/)[1]))
    assert.deepEqual(lineNos, [...lineNos].sort((a, b) => a - b), 'lines ascending within a file')
  })

  test('over several clean files the answer is OK with the file count, and exit 0; one dirty file among them still exits 1', async () => {
    const { main } = await cliMod()
    const dir = mktmp()
    const files = [0, 1, 2].map(i => {
      const p = join(dir, `clean-${i}-${hex(2)}.md`)
      writeFileSync(p, `plain text ${hex(4)}\nsecond line\n`)
      return p
    })
    const ok = await main(['scrub', ...files])
    assert.equal(ok.code, 0, ok.out)
    assert.equal(ok.out.trim(), 'OK: 3 files clean')
    const dirty = join(dir, `dirty-${hex(2)}.md`)
    writeFileSync(dirty, `plain\n${homeDir('home', `u${hex(3)}`)}\n`)
    const bad = await main(['scrub', ...files, dirty])
    assert.equal(bad.code, 1, bad.out)
    assert.deepEqual(linesOf(bad.out).filter(l => l.startsWith('HIT: ')), [`HIT: ${dirty}:2 | home-path`])
    assert.ok(!bad.out.includes('OK:'), 'no OK line when a file is dirty')
  })
})

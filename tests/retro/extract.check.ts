// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0012 Decision 2: stress and edge checks for retro/extract.ts.
// Written from the ADR and docs/extract.schema.json before retro/ exists. tests/retro-contract.check.ts holds the
// fixture-driven cases; this file builds its own temp session dirs per run and never reads a real transcript.
//
// Run with: node --test tests/retro/extract.check.ts
// Self-contained on purpose: no shared helper and no import of another check file. Each producer is imported
// inside the test that needs it, so a missing file fails that test with "producer missing: retro/<file>".
// Every token, id, label and path below is generated per run (random hex).

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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

const tmps: string[] = []
const mktmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'retro-extract-'))
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
  if (s.enum && !s.enum.some((e: any) => e === v)) mine.push(`${at}: ${JSON.stringify(v)} not in enum`)
  if (s.type) {
    const ts = Array.isArray(s.type) ? s.type : [s.type]
    if (!ts.some((t: string) => typeOk(t, v))) mine.push(`${at}: expected type ${ts.join('|')}, got ${JSON.stringify(v)?.slice(0, 60)}`)
  }
  if (typeof v === 'string') {
    if (s.minLength !== undefined && v.length < s.minLength) mine.push(`${at}: shorter than ${s.minLength}`)
    if (s.maxLength !== undefined && v.length > s.maxLength) mine.push(`${at}: longer than ${s.maxLength}`)
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
  errs.push(...mine)
}

function assertExtractSchema(value: unknown): void {
  const root = readSchema('extract')
  const errs: string[] = []
  validate(root, root, value, 'extract', errs)
  assert.deepEqual(errs.slice(0, 10), [], 'the extract breaks docs/extract.schema.json')
}

// ---------- record builders and the temp session dir ----------

const ts = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString()
const prompt = (text: string, t = 0, extra: any = {}) => ({ type: 'user', message: { role: 'user', content: text }, timestamp: ts(t), ...extra })
const use = (id: string, name: string, input: any, t: number, extra: any = {}) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  timestamp: ts(t),
  ...extra,
})
const result = (id: string, content: any, isError: boolean, t: number, extra: any = {}) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
  timestamp: ts(t),
  ...extra,
})
const say = (text: string, t: number, extra: any = {}) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: ts(t), ...extra })

// files: path relative to the project dir -> lines (an object is written as JSON, a string as is). Written in reverse key order.
function writeTree(projDir: string, files: Record<string, (string | object)[]>): void {
  for (const rel of Object.keys(files).reverse()) {
    const p = join(projDir, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, files[rel].map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n')
  }
}

function session(files: (sid: string) => Record<string, (string | object)[]>, sid = sidOf()) {
  const root = mktmp()
  const projDir = join(root, 'proj')
  mkdirSync(projDir, { recursive: true })
  writeTree(projDir, files(sid))
  return { root, sid, projDir, sessionDir: join(projDir, sid) }
}

const catalogOf = async (dir: string, entries: any[]) => {
  const { loadCatalog } = await catalogMod()
  const p = join(dir, `catalog-${hex(3)}.json`)
  writeFileSync(p, JSON.stringify({ v: 1, entries }))
  return loadCatalog(p)
}
const entry = (id: string, anchor: string, patterns: string[]) => ({ id, kind: 'friction', title: `t ${id}`, anchor, patterns, fix: `fix ${id}`, fixedBy: null })
const emptyCatalog = async (dir: string) => catalogOf(dir, [])

const find = (x: any, kind: string, file: string, line: number) => x.items.find((i: any) => i.kind === kind && i.file === file && i.line === line)
const MB = 1024 * 1024

// ---------- malformed and truncated lines ----------

describe('retro/extract.ts: malformed and truncated jsonl', () => {
  test('bad lines are counted under skipped.json, make no item, and later lines keep their real line numbers', async () => {
    const { extractSession } = await extractMod()
    const e1 = `er${hex()}`
    const e2 = `er${hex()}`
    const whole = JSON.stringify(use('r1', 'Read', { file_path: '/w/app/x.txt' }, 9))
    const s = session(sid => ({
      [`${sid}.jsonl`]: [
        use('r1', 'Read', { file_path: '/w/app/x.txt' }, 1),
        whole.slice(0, 40 + Math.floor(whole.length / 3)), // 2: cut mid-record
        '[1,2,3]', // 3: JSON but no object
        '"just a string"', // 4
        'null', // 5
        '42', // 6
        '\u0000\u0001 garbage ' + hex(4), // 7
        result('r1', `File does not exist. ${e1}`, true, 2),
        JSON.stringify(result('r1', 'x', true, 3)).slice(0, 25), // 9: cut again
        use('b1', 'Bash', { command: `echo ${hex(3)}` }, 4),
        result('b1', `Exit code 2\n${e2}`, true, 5),
      ],
    }))
    const x = extractSession(s.sessionDir, await emptyCatalog(s.root))
    assertExtractSchema(x)
    const main = `${s.sid}.jsonl`
    assert.equal(x.skipped.json, 7, 'lines 2 to 7 and 9')
    assert.deepEqual(x.skipped.type, {})
    assert.deepEqual(x.files, [{ path: main, lines: 11 }])
    const a = find(x, 'toolError', main, 8)
    const b = find(x, 'toolError', main, 11)
    assert.ok(a && a.quote.includes(e1) && a.tool === 'Read', 'the error after the bad lines keeps line 8')
    assert.ok(b && b.quote.includes('Exit code 2') && b.tool === 'Bash', 'and line 11')
    assert.equal(x.items.length, 2, `nothing is made of a bad line: ${JSON.stringify(x.items.map((i: any) => `${i.kind}@${i.line}`))}`)
  })

  test('a last line cut short with no newline after it is skipped, counted, and throws nothing', async () => {
    const { extractSession } = await extractMod()
    const e = `er${hex()}`
    const s = session(sid => ({
      [`${sid}.jsonl`]: [use('r1', 'Read', { file_path: '/w/app/y.txt' }, 1), result('r1', `nope ${e}`, true, 2)],
    }))
    const main = join(s.projDir, `${s.sid}.jsonl`)
    writeFileSync(main, readFileSync(main, 'utf8') + JSON.stringify(say(`never finished ${hex(3)}`, 3)).slice(0, 30))
    const x = extractSession(s.sessionDir, await emptyCatalog(s.root))
    assertExtractSchema(x)
    assert.equal(x.skipped.json, 1)
    assert.ok(find(x, 'toolError', `${s.sid}.jsonl`, 2))
    assert.equal(x.items.length, 1)
  })

  test('truncated lines in an agent transcript and a journal are counted too, and the lines after them still read', async () => {
    const { extractSession } = await extractMod()
    const e = `er${hex()}`
    const s = session(sid => ({
      [`${sid}.jsonl`]: [prompt('go', 0)],
      [`${sid}/subagents/agent-a${hex(2)}.jsonl`]: ['{"type":"assistant","mess', use('c1', 'Bash', { command: `ls ${hex(3)}` }, 1, { agentId: 'ag' }), '{', result('c1', `Exit code 1\n${e}`, true, 2, { agentId: 'ag' })],
      [`${sid}/subagents/workflows/wf_${hex(3)}/journal.jsonl`]: [{ type: 'launched' }, '{"type":"started","ke', '}}}}'],
    }))
    const x = extractSession(s.sessionDir, await emptyCatalog(s.root))
    assertExtractSchema(x)
    assert.equal(x.skipped.json, 4)
    const err = x.items.find((i: any) => i.kind === 'toolError')
    assert.ok(err, 'the error after the cut line')
    assert.equal(err.line, 4)
    assert.ok(err.file.endsWith('.jsonl') && err.file.includes('/subagents/agent-a'))
    assert.equal(err.agent, 'ag')
  })
})

// ---------- huge bodies ----------

describe('retro/extract.ts: huge tool_result bodies', () => {
  test('a 5 MB body gives a quote of at most 200 characters, cut before the planted token, and does not throw', async () => {
    const { extractSession, writeExtract } = await extractMod()
    const tok = `tk${hex(6)}`
    const anc = `an${hex(5)}`
    const head = 'Error: ' + 'y'.repeat(300)
    const s = session(sid => ({
      [`${sid}.jsonl`]: [use('b1', 'Bash', { command: `node ${hex(3)}.mjs` }, 1), result('b1', `${head} ${tok} ${'z'.repeat(5 * MB)}\n${anc}: planted ${hex(3)}`, true, 2), say('Done.', 3)],
    }))
    const cat = await catalogOf(s.root, [entry(`e-${hex(4)}`, anc, [`${anc}: planted`])])
    let x: any
    assert.doesNotThrow(() => {
      x = extractSession(s.sessionDir, cat)
    })
    assertExtractSchema(x)
    const main = `${s.sid}.jsonl`
    const err = find(x, 'toolError', main, 2)
    assert.ok(err, 'the toolError for the huge result')
    assert.ok(err.quote.length <= 200, `quote is ${err.quote.length} characters`)
    assert.ok(!err.quote.includes(tok), 'the token sits past the first 200 characters')
    assert.equal(err.quote, head.slice(0, 200), 'the quote is the first 200 characters of the first line')
    assert.equal(x.catalogHits.length, 1, 'the planted line after the huge one is still matched')
    assert.ok(x.catalogHits[0].quote.includes(`${anc}: planted`) && x.catalogHits[0].quote.length <= 200)
    const trussDir = join(s.root, 'truss')
    mkdirSync(trussDir, { recursive: true })
    const out = writeExtract(trussDir, x)
    assert.ok(readFileSync(out, 'utf8').length < 100 * 1024, 'the extract holds quotes, not the body')
  })

  test('a 6 MB journal result that starts BLOCKED: is a stop with a quote of at most 200 characters', async () => {
    const { extractSession } = await extractMod()
    const tok = `tk${hex(6)}`
    const lead = 'BLOCKED: ' + 'w'.repeat(250)
    const run = `wf_${hex(3)}`
    const key = `v2:${hex(4)}`
    const s = session(sid => ({
      [`${sid}.jsonl`]: [prompt('go', 0)],
      [`${sid}/subagents/workflows/${run}/journal.jsonl`]: [
        { type: 'launched' },
        { type: 'started', key, agentId: `wf-${hex(3)}`, label: `lab-${hex(3)}` },
        { type: 'result', key, agentId: 'x', result: { task: 't', marker: 'BLOCKED', branch: 'b', commit: 'c', proof: 'p', text: `${lead} ${tok} ${'v'.repeat(6 * MB)}` } },
      ],
    }))
    const x = extractSession(s.sessionDir, await emptyCatalog(s.root))
    assertExtractSchema(x)
    const stop = x.items.find((i: any) => i.kind === 'stop')
    assert.ok(stop, 'a stop item')
    assert.equal(stop.marker, 'BLOCKED')
    assert.equal(stop.line, 3)
    assert.ok(stop.quote.length <= 200 && !stop.quote.includes(tok))
  })
})

// ---------- unknown record types and versions ----------

describe('retro/extract.ts: unknown record types and versions', () => {
  test('an unknown type is counted per type across every file, makes no item, and known types are not counted', async () => {
    const { extractSession } = await extractMod()
    const zz = `zz${hex(3)}`
    const yy = `yy${hex(3)}`
    const jj = `jj${hex(3)}`
    const run = `wf_${hex(3)}`
    const s = session(sid => ({
      [`${sid}.jsonl`]: [prompt('go', 0), { type: zz, n: 1 }, { type: zz, n: 2 }, { type: zz, n: 3 }, { type: yy, hash: hex(3) }, say('Done.', 1)],
      [`${sid}/subagents/agent-a${hex(2)}.jsonl`]: [{ type: 'system', subtype: 'x', timestamp: ts(2), agentId: 'ag' }, { type: zz }, prompt('p', 3, { agentId: 'ag' }), { type: zz, deep: { type: yy } }, say('Done.', 4, { agentId: 'ag' })],
      [`${sid}/subagents/workflows/${run}/journal.jsonl`]: [{ type: 'launched' }, { type: jj, v: 5 }, { type: 'started', key: 'k', agentId: 'w1', label: `l-${hex(3)}` }],
    }))
    const x = extractSession(s.sessionDir, await emptyCatalog(s.root))
    assertExtractSchema(x)
    assert.deepEqual(x.skipped, { json: 0, type: { [zz]: 5, [yy]: 1, [jj]: 1 } })
    assert.deepEqual(x.items.filter((i: any) => i.kind !== 'step'), [], 'no item from a skipped line or a plain text turn')
    assert.equal(x.files.length, 3)
  })

  test('a known type with an unfamiliar version field, and with odd field shapes, never throws and the output still validates', async () => {
    const { extractSession, writeExtract } = await extractMod()
    const e = `er${hex()}`
    const run = `wf_${hex(3)}`
    const s = session(sid => ({
      [`${sid}.jsonl`]: [
        prompt('go', 0, { version: `99.${hex(1)}.0-future`, v: 99 }),
        use('r1', 'Read', { file_path: '/w/app/x.txt' }, 1, { version: 7, schemaVersion: { major: 9 } }),
        result('r1', `nope ${e}`, true, 2, { version: '2.999.0' }),
        { type: 'user', version: '3', message: null },
        { type: 'user', message: { role: 'user', content: 42 } },
        { type: 'assistant', message: { role: 'assistant', content: [null, 3, 'str', { type: 'tool_use' }, { type: 'tool_use', id: 5, name: ['x'], input: null }, { type: 'text', text: 9 }] }, timestamp: 12345 },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'nope', content: null, is_error: true }, { type: 'tool_result', content: [null, { type: 'text' }, { type: 'text', text: { a: 1 } }], is_error: 'yes' }] } },
        { type: 'user' },
        { type: 'assistant', message: 'a string', timestamp: null },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'x', is_error: true }] }, timestamp: 'not a date' },
      ],
      [`${sid}/subagents/agent-a${hex(2)}.jsonl`]: [{ type: 'assistant', version: 12, agentId: 7, message: { role: 'assistant', content: [{ type: 'text', text: 'CHECKPOINT: x' }] } }, { type: 'user', message: { content: [] } }],
      [`${sid}/subagents/workflows/${run}/journal.jsonl`]: [
        { type: 'launched', v: 9 },
        { type: 'started', v: 9 },
        { type: 'started', key: 5, agentId: null, label: 7 },
        { type: 'result', v: 9, key: 'k', result: null },
        { type: 'result', key: 'k2', agentId: 'a', result: 'BLOCKED: plain string result' },
        { type: 'result', key: 'k3', agentId: 'a', result: { text: 5 } },
      ],
    }))
    const cat = await emptyCatalog(s.root)
    let x: any
    assert.doesNotThrow(() => {
      x = extractSession(s.sessionDir, cat)
    })
    assertExtractSchema(x)
    const trussDir = join(s.root, 'truss')
    mkdirSync(trussDir, { recursive: true })
    assert.doesNotThrow(() => writeExtract(trussDir, x))
    assertExtractSchema(JSON.parse(readFileSync(join(trussDir, 'retro', 'extract.json'), 'utf8')))
  })
})

// ---------- determinism and order ----------

const KIND_ORDER = ['toolError', 'refusal', 'repeat', 'step', 'stop', 'qcFail', 'handEdit', 'checkFail']

function richSession(sid: string, t: any) {
  const run = `wf_${t.RUN}`
  return {
    [`${sid}.jsonl`]: [
      prompt('go', 0),
      use('w1', 'Write', { file_path: `/w/app/src/${t.FILE}.ts`, content: 'x' }, 1),
      result('w1', 'File created', false, 2),
      use('b1', 'Bash', { command: `node run.mjs ${t.CMD}` }, 3),
      result('b1', `Exit code 1\nError: ${t.ERR}\n    at f (/w/app/src/${t.FILE}.ts:12:3)`, true, 4),
      say('Done.', 5),
    ],
    [`${sid}/subagents/agent-Zz${t.A1}.jsonl`]: [
      prompt('p', 10, { agentId: `Zz${t.A1}` }),
      use('c1', 'Bash', { command: `node same.mjs ${t.CMD}` }, 11, { agentId: `Zz${t.A1}` }),
      result('c1', `Exit code 1\nbad ${t.ERR}`, true, 12, { agentId: `Zz${t.A1}` }),
      use('c2', 'Bash', { command: `node same.mjs ${t.CMD}` }, 13, { agentId: `Zz${t.A1}` }),
      result('c2', 'ok', false, 14, { agentId: `Zz${t.A1}` }),
    ],
    [`${sid}/subagents/agent-aa${t.A2}.jsonl`]: [prompt('p', 20, { agentId: `aa${t.A2}` }), say(`CHECKPOINT: ${t.STOP}\nmore`, 21, { agentId: `aa${t.A2}` })],
    [`${sid}/subagents/workflows/${run}/journal.jsonl`]: [
      { type: 'launched' },
      { type: 'started', key: 'k1', agentId: `wf${t.W1}`, label: `lab-${t.W1}` },
      { type: 'result', key: 'k1', agentId: `wf${t.W1}`, result: { task: 't', marker: 'BLOCKED', branch: 'b', commit: 'c', proof: 'p', text: `BLOCKED: ${t.STOP}\nVERDICT: FAIL\n${t.ANC}: planted` } },
    ],
    [`${sid}/subagents/workflows/${run}/agent-wf${t.W1}.jsonl`]: [
      prompt('p', 30, { agentId: `wf${t.W1}` }),
      say('working', 33, { agentId: `wf${t.W1}` }),
    ],
  }
}
const richTokens = () => ({ RUN: hex(3), FILE: hex(3), CMD: hex(4), ERR: `er${hex()}`, A1: hex(2), A2: hex(2), STOP: `st${hex(4)}`, W1: hex(2), ANC: `an${hex(5)}` })

describe('retro/extract.ts: determinism and order (Decision 2)', () => {
  test('two copies in two temp dirs, one with other mtimes, give byte-identical extract.json; a rerun on the same dir too', async () => {
    const { extractSession, writeExtract } = await extractMod()
    const t = richTokens()
    const sid = sidOf()
    const make = () => {
      const root = mktmp()
      const projDir = join(root, 'p'.repeat(1 + (hex(1).charCodeAt(0) % 7)), 'proj')
      mkdirSync(projDir, { recursive: true })
      writeTree(projDir, richSession(sid, t))
      return { root, projDir, sessionDir: join(projDir, sid) }
    }
    const a = make()
    const b = make()
    const old = new Date('2001-02-03T04:05:06Z')
    for (const rel of [`${sid}.jsonl`, `${sid}/subagents/agent-aa${t.A2}.jsonl`]) utimesSync(join(b.projDir, rel), old, old)
    const cat = await catalogOf(a.root, [entry(`e-${hex(4)}`, t.ANC, [`${t.ANC}: planted`])])
    const outs = [a, b].map(s => {
      const dir = join(s.root, 'truss')
      mkdirSync(dir, { recursive: true })
      return readFileSync(writeExtract(dir, extractSession(s.sessionDir, cat)), 'utf8')
    })
    assertExtractSchema(JSON.parse(outs[0]))
    assert.equal(outs[0], outs[1], 'same bytes from a different dir and different mtimes')
    const again = join(a.root, 'truss-again')
    mkdirSync(again, { recursive: true })
    assert.equal(readFileSync(writeExtract(again, extractSession(a.sessionDir, cat)), 'utf8'), outs[0], 'same bytes on a rerun')
    assert.ok(!outs[0].includes(a.root) && !outs[0].includes(b.root), 'no absolute temp path leaks into the extract')
  })

  test('files are in code-point order of path (an upper-case name before a lower-case one); items by file, line, then kind', async () => {
    const { extractSession } = await extractMod()
    const t = richTokens()
    const s = session(sid => richSession(sid, t))
    const cat = await catalogOf(s.root, [entry(`e-${hex(4)}`, t.ANC, [`${t.ANC}: planted`])])
    const x = extractSession(s.sessionDir, cat)
    assertExtractSchema(x)
    const paths = x.files.map((f: any) => f.path)
    assert.deepEqual(paths, [...paths].sort(), 'code-point order')
    assert.equal(paths.length, 5)
    assert.ok(paths.findIndex((p: string) => p.includes(`agent-Zz${t.A1}`)) < paths.findIndex((p: string) => p.includes(`agent-aa${t.A2}`)), 'Z (90) sorts before a (97)')
    assert.equal(paths[0], `${s.sid}.jsonl`, 'the session transcript first')
    let prev = [-1, -1, -1]
    for (const i of x.items) {
      const cur = [paths.indexOf(i.file), i.line, KIND_ORDER.indexOf(i.kind)]
      assert.ok(cur[2] >= 0, `known kind ${i.kind}`)
      const ordered = cur[0] > prev[0] || (cur[0] === prev[0] && (cur[1] > prev[1] || (cur[1] === prev[1] && cur[2] >= prev[2])))
      assert.ok(ordered, `${i.kind} ${i.file}:${i.line} is out of order after ${prev.join(',')}`)
      prev = cur
    }
    const main = `${s.sid}.jsonl`
    const journal = paths.find((p: string) => p.endsWith('/journal.jsonl'))
    const kindsAt = (file: string, line: number) => x.items.filter((i: any) => i.file === file && i.line === line).map((i: any) => i.kind)
    assert.deepEqual(kindsAt(main, 5), ['toolError', 'checkFail'], 'two kinds on one line, in the schema’s kind order')
    assert.deepEqual(kindsAt(journal, 3), ['stop', 'qcFail'])
  })
})

// ---------- catalog hits per record ----------

describe('retro/extract.ts: at most one catalog hit per entry per record', () => {
  test('three matching lines in one result are one hit; the same entry in another record is another; two entries on one line are two', async () => {
    const { extractSession } = await extractMod()
    const a = `aa${hex(4)}`
    const b = `bb${hex(4)}`
    const idA = `e-${hex(4)}`
    const idB = `e-${hex(4)}`
    const run = `wf_${hex(3)}`
    const s = session(sid => ({
      [`${sid}.jsonl`]: [
        use('b1', 'Bash', { command: `echo ${hex(3)}` }, 1),
        result('b1', `${a}: one ${hex(2)}\n${a}: two ${hex(2)}\nok\n${a}: three ${b}: x ${hex(2)}`, false, 2),
        use('b2', 'Bash', { command: `echo ${hex(3)}` }, 3),
        result('b2', `${a}: again ${hex(2)}`, true, 4),
      ],
      [`${sid}/subagents/workflows/${run}/journal.jsonl`]: [
        { type: 'launched' },
        { type: 'result', key: 'k', agentId: 'x', result: { task: 't', marker: 'DONE', branch: 'b', commit: 'c', proof: 'p', text: `${a}: first\nfine\n${a}: second` } },
      ],
    }))
    const cat = await catalogOf(s.root, [entry(idA, a, [`${a}: `]), entry(idB, b, [`${b}: `])])
    const x = extractSession(s.sessionDir, cat)
    assertExtractSchema(x)
    const main = `${s.sid}.jsonl`
    const at = (id: string, file: string) => x.catalogHits.filter((h: any) => h.id === id && h.file === file).map((h: any) => h.line).sort((p: number, q: number) => p - q)
    assert.deepEqual(at(idA, main), [2, 4], 'one hit for record 2 and one for record 4')
    assert.deepEqual(at(idB, main), [2])
    const journal = x.files.map((f: any) => f.path).find((p: string) => p.endsWith('/journal.jsonl'))
    assert.deepEqual(at(idA, journal), [2], 'a journal result is one record too')
    assert.equal(x.catalogHits.length, 4)
    for (const h of x.catalogHits) assert.ok(h.quote.length <= 200 && h.quote.includes(h.id === idA ? a : b))
  })
})

// ---------- which files are read ----------

describe('retro/extract.ts: the files list', () => {
  test('lists the session transcript, subagent transcripts and workflow journals and agent transcripts, and nothing else', async () => {
    const { extractSession } = await extractMod()
    const run1 = `wf_${hex(3)}`
    const run2 = `wf_${hex(3)}`
    const ag = `agent-a${hex(3)}`
    const wag = `agent-w${hex(3)}`
    const other = sidOf()
    const s = session(sid => ({
      [`${sid}.jsonl`]: [prompt('a', 0), say('b', 1), say('c', 2)],
      [`${other}.jsonl`]: [prompt('someone else', 0)],
      [`${sid}/subagents/${ag}.jsonl`]: [prompt('a', 0, { agentId: 'q' }), say('b', 1, { agentId: 'q' })],
      [`${sid}/subagents/${ag}.meta.json`]: ['{"agentType":"x"}'],
      [`${sid}/subagents/workflows/${run1}/journal.jsonl`]: [{ type: 'launched' }, { type: 'started', key: 'k', agentId: 'w1', label: 'l' }, { type: 'launched' }],
      [`${sid}/subagents/workflows/${run1}/${wag}.jsonl`]: [prompt('a', 0, { agentId: 'w1' }), say('b', 1, { agentId: 'w1' }), say('c', 2, { agentId: 'w1' }), say('d', 3, { agentId: 'w1' })],
      [`${sid}/subagents/workflows/${run2}/journal.jsonl`]: [{ type: 'launched' }],
      [`${sid}/notes.txt`]: ['not a transcript'],
    }))
    const x = extractSession(s.sessionDir, await emptyCatalog(s.root))
    assertExtractSchema(x)
    assert.equal(x.session, s.sid)
    const want = [
      { path: `${s.sid}.jsonl`, lines: 3 },
      { path: `${s.sid}/subagents/${ag}.jsonl`, lines: 2 },
      { path: `${s.sid}/subagents/workflows/${run1}/journal.jsonl`, lines: 3 },
      { path: `${s.sid}/subagents/workflows/${run1}/${wag}.jsonl`, lines: 4 },
      { path: `${s.sid}/subagents/workflows/${run2}/journal.jsonl`, lines: 1 },
    ].sort((p, q) => (p.path < q.path ? -1 : 1))
    assert.deepEqual(x.files, want)
  })

  test('a session with only its own transcript (no subagents dir) reads that one file', async () => {
    const { extractSession } = await extractMod()
    const s = session(sid => ({ [`${sid}.jsonl`]: [prompt('a', 0), say('b', 1)] }))
    mkdirSync(s.sessionDir, { recursive: true })
    const x = extractSession(s.sessionDir, await emptyCatalog(s.root))
    assertExtractSchema(x)
    assert.deepEqual(x.files, [{ path: `${s.sid}.jsonl`, lines: 2 }])
    assert.deepEqual(x.items, [])
    assert.deepEqual(x.catalogHits, [])
    assert.deepEqual(x.skipped, { json: 0, type: {} })
  })
})

// ---------- writeExtract ----------

describe('retro/extract.ts writeExtract', () => {
  test('overwrites a longer earlier file whole: no tail of the old bytes is left', async () => {
    const { extractSession, writeExtract } = await extractMod()
    const s = session(sid => ({ [`${sid}.jsonl`]: [prompt('a', 0), say('b', 1)] }))
    const x = extractSession(s.sessionDir, await emptyCatalog(s.root))
    const trussDir = join(s.root, 'truss')
    const retro = join(trussDir, 'retro')
    mkdirSync(retro, { recursive: true })
    const old = `{"stale":"${hex(4)}${'G'.repeat(MB)}"}\n`
    writeFileSync(join(retro, 'extract.json'), old)
    const out = writeExtract(trussDir, x)
    assert.equal(out, join(retro, 'extract.json'))
    const text = readFileSync(out, 'utf8')
    assert.equal(text, JSON.stringify(x, null, 2) + '\n')
    assert.ok(text.length < old.length)
    assert.doesNotThrow(() => JSON.parse(text))
    assertExtractSchema(JSON.parse(text))
  })

  test('creates <truss dir>/retro when it is missing, and a second write of other content replaces the first', async () => {
    const { extractSession, writeExtract } = await extractMod()
    const s1 = session(sid => ({ [`${sid}.jsonl`]: [use('r1', 'Read', {}, 1), result('r1', `bad ${hex(4)}`, true, 2), say('x', 3)] }))
    const s2 = session(sid => ({ [`${sid}.jsonl`]: [prompt('a', 0)] }))
    const cat = await emptyCatalog(s1.root)
    const x1 = extractSession(s1.sessionDir, cat)
    const x2 = extractSession(s2.sessionDir, cat)
    const trussDir = join(mktmp(), 'truss')
    mkdirSync(trussDir)
    assert.equal(existsSync(join(trussDir, 'retro')), false)
    const p1 = writeExtract(trussDir, x1)
    assert.equal(readFileSync(p1, 'utf8'), JSON.stringify(x1, null, 2) + '\n')
    const p2 = writeExtract(trussDir, x2)
    assert.equal(p2, p1)
    assert.equal(readFileSync(p2, 'utf8'), JSON.stringify(x2, null, 2) + '\n')
  })
})

// ---------- stop items from a journal result's marker or stop.tag ----------

describe('retro/extract.ts: a journal result whose marker or stop.tag is BLOCKED, CHECKPOINT or QUESTION is one stop', () => {
  test('marker and stop.tag each give one stop with the first non-empty line of text and the journal line; other tags and no tag give none', async () => {
    const { extractSession } = await extractMod()
    const run = `wf_${hex(3)}`
    const q1 = `why-${hex(4)}`
    const q2 = `which-${hex(4)}`
    const q3 = `wait-${hex(4)}`
    const q4 = `both-${hex(4)}`
    const res = (key: string, result: any) => ({ type: 'result', key, agentId: `a-${key}`, result })
    const s = session(sid => ({
      [`${sid}.jsonl`]: [prompt('go', 0)],
      [`${sid}/subagents/workflows/${run}/journal.jsonl`]: [
        { type: 'launched' }, // 1
        res('k1', { task: 't', marker: 'BLOCKED', branch: 'b', commit: 'c', proof: 'p', text: `\n   \n  ${q1}  \nsecond line ${hex(3)}` }), // 2: marker, quote is the first non-empty line
        res('k2', { task: 't', stop: { tag: 'QUESTION' }, text: `${q2}\nmore` }), // 3: stop.tag
        res('k3', { task: 't', marker: 'CHECKPOINT', text: q3 }), // 4
        res('k4', { task: 't', marker: 'DONE', text: `finished ${hex(3)}` }), // 5: other tag
        res('k5', { task: 't', stop: { tag: 'DONE' }, text: `finished ${hex(3)}` }), // 6: other tag
        res('k6', { task: 't', text: `no marker at all ${hex(3)}` }), // 7: no marker
        res('k7', { task: 't', marker: 'BLOCKED', stop: { tag: 'BLOCKED' }, text: `BLOCKED: ${q4}` }), // 8: marker, tag and prefix together are one item
      ],
    }))
    const x = extractSession(s.sessionDir, await emptyCatalog(s.root))
    assertExtractSchema(x)
    const stops = x.items.filter((i: any) => i.kind === 'stop')
    const journal = x.files.map((f: any) => f.path).find((p: string) => p.endsWith('/journal.jsonl'))
    assert.deepEqual(
      stops.map((i: any) => [i.file, i.line, i.marker, i.quote]),
      [
        [journal, 2, 'BLOCKED', q1],
        [journal, 3, 'QUESTION', q2],
        [journal, 4, 'CHECKPOINT', q3],
        [journal, 8, 'BLOCKED', `BLOCKED: ${q4}`],
      ],
    )
  })
})

// ---------- results that only show text are not the run hitting the problem ----------

describe('retro/extract.ts: a catalog anchor quoted by a show-only command or a Read is no hit; a real run of it is', () => {
  const body = (a: string) => `${a}: line ${hex(3)}`

  test('git diff, git show, git log -p, gh pr diff, gh pr view, grep, rg, cat, sed -n, head, tail and pipelines of them give no hit', async () => {
    const { extractSession } = await extractMod()
    const a = `qa${hex(4)}`
    const id = `e-${hex(4)}`
    const quiet = [
      'git diff HEAD~1',
      'git show HEAD',
      'git log -p -3',
      'gh pr diff 12',
      'gh pr view 12',
      `grep -rn ${a} .`,
      `rg ${a} src`,
      'cat notes.md',
      'sed -n 1,40p notes.md',
      'head -50 notes.md',
      'tail -50 notes.md',
      'git diff | head -40',
      `git diff | grep ${hex(2)}`,
      `cat notes.md | sed -n 1,5p | tail -2`,
    ]
    const loud = ['npm test', 'git diff | node script.js', 'git diff | tee out.txt', `echo ${hex(3)}`, 'git commit -m x']
    const cmds = [...quiet, ...loud]
    const recs: any[] = []
    cmds.forEach((c, i) => {
      recs.push(use(`b${i}`, 'Bash', { command: c }, 2 * i + 1))
      recs.push(result(`b${i}`, body(a), false, 2 * i + 2))
    })
    const s = session(sid => ({ [`${sid}.jsonl`]: recs }))
    const x = extractSession(s.sessionDir, await catalogOf(s.root, [entry(id, a, [`${a}: `])]))
    assertExtractSchema(x)
    const want = loud.map((_, j) => 2 * (quiet.length + j) + 2)
    assert.deepEqual(
      x.catalogHits.filter((h: any) => h.id === id).map((h: any) => h.line),
      want,
      'only the commands that run something give a hit',
    )
  })

  test('a Read, Grep or Glob result and a Bash command naming catalog.json give no hit; a Bash failure with the same line does', async () => {
    const { extractSession } = await extractMod()
    const a = `qb${hex(4)}`
    const id = `e-${hex(4)}`
    const s = session(sid => ({
      [`${sid}.jsonl`]: [
        use('r1', 'Read', { file_path: '/w/app/catalog.json' }, 1), // 1
        result('r1', body(a), false, 2), // 2
        use('g1', 'Grep', { pattern: a }, 3), // 3
        result('g1', body(a), false, 4), // 4
        use('l1', 'Glob', { pattern: '**/*' }, 5), // 5
        result('l1', body(a), false, 6), // 6
        use('c1', 'Bash', { command: `node retro/cli.ts recur t retro/catalog.json` }, 7), // 7
        result('c1', body(a), false, 8), // 8
        use('b1', 'Bash', { command: 'npx playwright test' }, 9), // 9
        result('b1', body(a), true, 10), // 10
      ],
    }))
    const x = extractSession(s.sessionDir, await catalogOf(s.root, [entry(id, a, [`${a}: `])]))
    assert.deepEqual(
      x.catalogHits.filter((h: any) => h.id === id).map((h: any) => h.line),
      [10],
    )
  })
})

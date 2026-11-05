// Spec-first checks for Run metrics (rework-page): the formatters, RunMetrics and TokensTable.
// Rules: ADR-0028 section 8 (metrics, no ceiling) and rework-page-ux section 1 item 3. SSR only; interactions are e2e's job.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { createRenderer, uiDir, type Renderer } from '../../test/render.ts'

// ---- a tiny HTML tree over renderToStaticMarkup ----------------------------------------------------------
type N = { tag: string; a: Record<string, string>; k: (N | string)[]; up: N | null }
const VOID = new Set(['br', 'img', 'input', 'hr', 'meta', 'link', 'source', 'wbr'])
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
function parse(html: string): N {
  const root: N = { tag: '#root', a: {}, k: [], up: null }
  let cur = root
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>|([^<]+)/g
  for (const m of html.matchAll(re)) {
    if (m[5] !== undefined) { cur.k.push(decode(m[5])); continue }
    if (!m[2]) continue
    const tag = m[2].toLowerCase()
    if (m[1]) {
      let n: N | null = cur
      while (n && n.tag !== tag) n = n.up
      if (n && n.up) cur = n.up
      continue
    }
    const a: Record<string, string> = {}
    for (const x of m[3]!.matchAll(/([\w:.-]+)(?:="([^"]*)")?/g)) a[x[1]!] = decode(x[2] ?? '')
    const n: N = { tag, a, k: [], up: cur }
    cur.k.push(n)
    if (!m[4] && !VOID.has(tag)) cur = n
  }
  return root
}
const kids = (n: N) => n.k.filter((x): x is N => typeof x !== 'string')
function* walk(n: N): Generator<N> { for (const c of kids(n)) { yield c; yield* walk(c) } }
function text(n: N | string): string {
  if (typeof n === 'string') return n
  if (n.a['aria-hidden'] === 'true') return ''
  return n.k.map(text).join('')
}
const tidy = (s: string) => s.replace(/\s+/g, ' ').trim()
const rootOf = (n: N) => { while (n.up) n = n.up; return n }
const tags = (root: N, tag: string) => [...walk(root)].filter((n) => n.tag === tag)
const byId = (n: N, id: string) => [...walk(rootOf(n))].find((x) => x.a.id === id)
const hhmm = (iso: string) => {
  const d = new Date(iso)
  const p = (x: number) => String(x).padStart(2, '0')
  return [`${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`, `${p(d.getHours())}:${p(d.getMinutes())}`]
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A regexp for `<before>HH:MM` where HH:MM is the stamp in UTC or in the local zone. */
const atTime = (before: string, iso: string) => new RegExp(`${esc(before)}(?:${hhmm(iso).map(esc).join('|')})`)

// ---- fixtures and mounting -------------------------------------------------------------------------------
const fixDir = path.join(uiDir, 'contract', 'fixtures', 'rework')
const fx = (name: string): any => JSON.parse(fs.readFileSync(path.join(fixDir, name, 'state.json'), 'utf8'))
const NOW = Date.parse('2026-11-02T12:00:00.000Z')
const MIN = 60_000
let r: Renderer
before(async () => { r = await createRenderer() })
after(async () => { await r?.close() })
async function mount(file: string, name: string, props: Record<string, unknown>): Promise<N> {
  const mod = await r.load(`views/${file}.tsx`)
  assert.equal(typeof mod[name], 'function', `views/${file}.tsx exports a named function component ${name}`)
  return parse(r.render(React.createElement(mod[name], props)))
}
const metrics = (state: any, now = NOW) => mount('metrics/RunMetrics', 'RunMetrics', { state, now })
const fmt = () => r.load('views/metrics/format.ts')
/** The dt/dd tiles of a RunMetrics tree, keyed by label. Each value is the tile's whole text. */
function tiles(root: N): Record<string, string> {
  const out: Record<string, string> = {}
  for (const dt of tags(root, 'dt')) out[tidy(text(dt))] = tidy(text(dt.up!))
  return out
}

// ---- formatters ------------------------------------------------------------------------------------------
test('formatRunTime: 0m, 42m, 3h 05m and 2d 4h', async () => {
  const { formatRunTime } = await fmt()
  assert.equal(formatRunTime(0), '0m')
  assert.equal(formatRunTime(42 * MIN), '42m')
  assert.equal(formatRunTime((3 * 60 + 5) * MIN), '3h 05m')
  assert.equal(formatRunTime((2 * 24 * 60 + 4 * 60) * MIN), '2d 4h')
})

test('runTimeMs: null with no transcript, first entry to now while running', async () => {
  const { runTimeMs } = await fmt()
  assert.equal(runTimeMs(fx('no-run'), NOW), null)
  const live = fx('live')
  assert.equal(runTimeMs(live, NOW), NOW - Date.parse(live.transcript[0].ts))
  assert.equal(runTimeMs(live, NOW + 5 * MIN), NOW + 5 * MIN - Date.parse(live.transcript[0].ts))
})

test('runTimeMs: a finished run stops at the last entry and ignores now', async () => {
  const { runTimeMs } = await fmt()
  const fin = fx('finished')
  const want = Date.parse(fin.transcript.at(-1).ts) - Date.parse(fin.transcript[0].ts)
  assert.equal(runTimeMs(fin, NOW), want)
  assert.equal(runTimeMs(fin, NOW + 24 * 60 * MIN), want)
})

test('formatUsd: $0.00, $23.48 and $12,345.67', async () => {
  const { formatUsd } = await fmt()
  assert.equal(formatUsd(0), '$0.00')
  assert.equal(formatUsd(23.48), '$23.48')
  assert.equal(formatUsd(12345.67), '$12,345.67')
})

test('formatCount: en-US grouping, and a dash for null or undefined', async () => {
  const { formatCount } = await fmt()
  assert.equal(formatCount(123456789), '123,456,789')
  assert.equal(formatCount(0), '0')
  assert.equal(formatCount(null), '—')
  assert.equal(formatCount(undefined), '—')
})

// ---- RunMetrics ------------------------------------------------------------------------------------------
test('RunMetrics: section#run-metrics labelled by a focusable h2 "Run metrics"', async () => {
  const m = await metrics(fx('live'))
  const section = tags(m, 'section')[0]!
  assert.equal(section.a.id, 'run-metrics')
  const h2 = byId(section, section.a['aria-labelledby']!)
  assert.ok(h2, 'aria-labelledby points at an element that exists')
  assert.equal(h2.tag, 'h2')
  assert.equal(tidy(text(h2)), 'Run metrics')
  assert.equal(h2.a.tabindex, '-1')
  assert.equal(tags(m, 'h2').length, 1)
})

test('RunMetrics: four terms in order Cost, Run time, Agents started, Crews done', async () => {
  const m = await metrics(fx('live'))
  assert.deepEqual(tags(m, 'dt').map((n) => tidy(text(n))), ['Cost', 'Run time', 'Agents started', 'Crews done'])
  assert.equal(tags(m, 'dd').length >= 4, true)
  for (const dt of tags(m, 'dt')) assert.ok(kids(dt.up!).some((n) => n.tag === 'dd'), 'each dt has a dd in its tile')
})

test('RunMetrics: live values, sub lines, crews done n of m, agents counted from run.crews', async () => {
  const live = fx('live')
  const t = tiles(await metrics(live))
  assert.match(t['Cost']!, /\$23\.48/)
  assert.match(t['Cost']!, atTime('As of ', live.session.usage.at))
  assert.match(t['Run time']!, /Run time\s*53m/)
  assert.match(t['Run time']!, atTime('Since ', live.transcript[0].ts))
  assert.match(t['Agents started']!, /Agents started\s*6(?!\d)/)
  assert.match(t['Crews done']!, /Crews done\s*1 of 5/)
})

test('RunMetrics: finished run time is frozen with a Finished sub line', async () => {
  const fin = fx('finished')
  const a = tiles(await metrics(fin, NOW))['Run time']!
  const b = tiles(await metrics(fin, NOW + 600 * MIN))['Run time']!
  assert.equal(a, b)
  assert.match(a, /Run time\s*2h 28m/)
  assert.match(a, atTime('Finished ', fin.transcript.at(-1).ts))
  assert.match(tiles(await metrics(fin))['Crews done']!, /2 of 2/)
})

test('RunMetrics: a run with no usage shows a dash and "No usage yet" for Cost, real crew values', async () => {
  const t = tiles(await metrics(fx('partial')))
  assert.match(t['Cost']!, /—/)
  assert.match(t['Cost']!, /No usage yet/)
  assert.match(t['Agents started']!, /Agents started\s*4(?!\d)/)
  assert.match(t['Crews done']!, /1 of 3/)
})

test('RunMetrics: usage with no run gives dashes and "No crews yet" for crews', async () => {
  const t = tiles(await metrics({ ...fx('live'), run: null }))
  assert.match(t['Cost']!, /\$23\.48/)
  for (const k of ['Agents started', 'Crews done']) {
    assert.match(t[k]!, /—/, k)
    assert.match(t[k]!, /No crews yet/, k)
  }
})

test('RunMetrics: first use (no run) has at least four dashes and "No usage yet"', async () => {
  const m = await metrics(fx('no-run'))
  const all = tidy(text(m))
  assert.ok((all.match(/—/g) ?? []).length >= 4, `dashes in: ${all}`)
  assert.match(all, /No usage yet/)
  assert.match(all, /No tokens used yet\./)
  assert.equal(tags(m, 'table').length, 0)
})

test('RunMetrics: no limit, budget, ceiling or "of $" anywhere', async () => {
  for (const name of ['no-run', 'live', 'partial', 'finished', 'long']) {
    const html = r.render(React.createElement((await r.load('views/metrics/RunMetrics.tsx')).RunMetrics, { state: fx(name), now: NOW }))
    assert.doesNotMatch(tidy(text(parse(html))), /limit|budget|ceiling|of \$/i, name)
  }
})

test('RunMetrics: holds the Tokens by model table with a row per model', async () => {
  const m = await metrics(fx('live'))
  const rows = tags(m, 'tbody')[0] ? tags(tags(m, 'tbody')[0]!, 'tr') : []
  assert.equal(rows.length, 2)
  assert.match(tidy(text(m)), /Tokens by model/)
})

// ---- TokensTable -----------------------------------------------------------------------------------------
const table = (models: unknown) => mount('metrics/TokensTable', 'TokensTable', { models })

test('TokensTable: sr-only caption and column headers Model, In, Out, Cache read, Cache write', async () => {
  const t = await table(fx('live').session.usage.models)
  const cap = tags(t, 'caption')[0]!
  assert.equal(tidy(text(cap)), 'Tokens by model')
  assert.ok(cap.a.class!.split(/\s+/).includes('sr-only'))
  const cols = tags(t, 'th').filter((h) => h.a.scope === 'col')
  assert.deepEqual(cols.map((h) => tidy(text(h))), ['Model', 'In', 'Out', 'Cache read', 'Cache write'])
})

test('TokensTable: a th scope=row model cell per model, and a Total row in tfoot', async () => {
  const models = fx('live').session.usage.models
  const t = await table(models)
  const body = tags(t, 'tbody')[0]!
  const names = tags(body, 'th').filter((h) => h.a.scope === 'row').map((h) => tidy(text(h)))
  assert.deepEqual(names, Object.keys(models))
  const foot = tags(t, 'tfoot')[0]!
  const row = tidy(text(foot))
  assert.match(row, /^Total/)
  const sum = (f: string) => Object.values<any>(models).reduce((a, m) => a + m[f], 0).toLocaleString('en-US')
  assert.ok(row.includes(sum('inputTokens')), 'total input')
  assert.ok(row.includes(sum('outputTokens')), 'total output')
  assert.ok(row.includes(sum('cacheReadInputTokens')), 'total cache read')
  assert.ok(row.includes(sum('cacheCreationInputTokens')), 'total cache write')
})

test('TokensTable: counts are en-US grouped', async () => {
  const t = await table(fx('long').session.usage.models)
  const all = tidy(text(t))
  for (const n of ['123,456,789', '987,654,321', '444,555,666']) assert.ok(all.includes(n), n)
})

test('TokensTable: a null field shows a dash in that cell', async () => {
  const t = await table({ 'claude-opus-5-5': { inputTokens: 10, outputTokens: null, cacheReadInputTokens: 5, cacheCreationInputTokens: 1 } })
  const cells = tags(tags(t, 'tbody')[0]!, 'td').map((c) => tidy(text(c)))
  assert.ok(cells.includes('—'), `cells: ${cells.join('|')}`)
  assert.ok(cells.includes('10'))
})

test('TokensTable: wrapper is a focusable region named Tokens by model', async () => {
  const t = await table(fx('live').session.usage.models)
  const wrap = [...walk(t)].find((n) => n.a.role === 'region' && n.a['aria-label'] === 'Tokens by model')
  assert.ok(wrap, 'no region named Tokens by model')
  assert.equal(wrap.a.tabindex, '0')
  assert.ok([...walk(wrap)].some((n) => n.tag === 'table'), 'the table is inside the region')
})

test('TokensTable: no models says "No tokens used yet."', async () => {
  const t = await table({})
  assert.match(tidy(text(t)), /No tokens used yet\./)
})

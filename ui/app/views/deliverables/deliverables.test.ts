// Spec-first checks for Built artifacts and deliverables and the ADR preview (rework-docs; R-37, R-39; ADR-0028 section 3).
// Written from the brief before the builder lands: ADRs leave Deliverables, Architecture is the first Docs item,
// the Architecture preview is a scrollable labelled pane, and AdrPreview shows an ADR's fields. Interactions
// (filter clicks, dialog focus, lazy load) are docs.spec.ts's job.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { createRenderer, uiDir, type Renderer } from '../../test/render.ts'

// ---- a tiny HTML tree over renderToStaticMarkup (same shape as rail.test.ts) -----------------------------
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
function roleOf(n: N): string {
  if (n.a.role) return n.a.role
  const t = n.tag
  if (/^h[1-6]$/.test(t)) return 'heading'
  return ({ ul: 'list', ol: 'list', li: 'listitem', button: 'button', a: n.a.href !== undefined ? 'link' : '', dt: 'term', dd: 'definition', aside: 'complementary', section: 'region', fieldset: 'group', header: 'banner', main: 'main' } as Record<string, string>)[t] ?? ''
}
function nameOf(n: N): string {
  const r = rootOf(n)
  const byId = (id: string) => [...walk(r)].find((x) => x.a.id === id)
  if (n.a['aria-label']) return n.a['aria-label']
  if (n.a['aria-labelledby']) return tidy(n.a['aria-labelledby'].split(/\s+/).map((id) => { const e = byId(id); return e ? text(e) : '' }).join(' '))
  return tidy(text(n)) || n.a.title || ''
}
function find(root: N, role: string, name?: string | RegExp): N[] {
  return [...walk(root)].filter((n) => roleOf(n) === role && (name === undefined || (typeof name === 'string' ? nameOf(n) === name : name.test(nameOf(n)))))
}
const cls = (n: N, token: string) => (n.a.class ?? '').split(/\s+/).some((c) => c === token || c.endsWith(':' + token))

// ---- fixtures and mounting -------------------------------------------------------------------------------
const rework = path.join(uiDir, 'contract', 'fixtures', 'rework')
const fx = (name: string): any => JSON.parse(fs.readFileSync(path.join(rework, name, 'state.json'), 'utf8'))
const NOW = Date.parse('2026-11-02T12:00:00.000Z')
let r: Renderer
before(async () => { r = await createRenderer() })
after(async () => { await r?.close() })

const ADRS = [
  { file: '0011-keep-one-list.md', title: 'ADR-0011: Keep one list', status: 'accepted, 2026-10-20', number: 11, date: '2026-10-20', decidedBy: 'the client', links: [], summary: 'One list.' },
  { file: '0012-split-the-rail.md', title: 'ADR-0012: Split the rail', status: 'proposed', number: 12, date: '2026-10-21', decidedBy: 'the design engineer', links: [{ kind: 'amends', n: 11 }], summary: 'Two columns.' },
  { file: '0013-no-status.md', title: 'ADR-0013: Status never stated', status: null },
]
/** The architecture fixture, with a plan, three ADRs, one merged crew and one image whose crew hasn't merged. */
function populated(over: { plan?: boolean; images?: boolean } = {}): any {
  const s = fx('architecture')
  s.design = { ...s.design, planMd: over.plan === false ? null : '# Plan\n\nDo the thing.\n', architecture: { path: 'docs/architecture.md', markdown: '# Architecture\n\n## Modules\n\nText.\n' }, images: over.images === false ? [] : [{ ref: 'truss-not-merged-yet', path: 'shot-1.png' }] }
  s.adrs = ADRS
  return s
}
async function load(file: string, name: string): Promise<any> {
  const mod = await r.load(`views/${file}.tsx`)
  assert.equal(typeof mod[name], 'function', `views/${file}.tsx exports a named function ${name}`)
  return mod[name]
}
const deliv = async (state: any, props: Record<string, unknown> = {}) =>
  parse(r.render(React.createElement(await load('deliverables/Deliverables', 'Deliverables'), { state, now: NOW, ...props })))
const itemsOf = async (state: any): Promise<any[]> => (await load('deliverables/Deliverables', 'deliverablesOf'))(state)

// ---- 1. deliverablesOf: no ADR items, Architecture first in Docs ----------------------------------------
test('deliverablesOf: yields no ADR item (no adr- id, ADR title or docs/adr path) for a state with ADRs (R-37)', async () => {
  const items = await itemsOf(populated())
  for (const it of items) {
    assert.ok(!String(it.id).startsWith('adr-'), `no item id starts with adr-, got ${it.id}`)
    assert.ok(!String(it.path).includes('docs/adr/'), `no ADR path, got ${it.path}`)
    for (const a of ADRS) {
      assert.notEqual(it.title, a.title, `no item titled ${a.title}`)
      assert.notEqual(it.path, a.file, `no item at ${a.file}`)
    }
  }
})
test('deliverablesOf: exactly one Architecture item and it is the first Docs item', async () => {
  const items = await itemsOf(populated())
  assert.equal(items.filter((i) => i.title === 'Architecture').length, 1)
  const docs = items.filter((i) => i.type === 'docs')
  assert.equal(docs.length, 1, 'Docs holds the architecture and nothing else once ADRs are gone')
  assert.equal(docs[0].title, 'Architecture')
})

// ---- 2. empty first use ---------------------------------------------------------------------------------
test('Deliverables: empty first use reads the new copy, with no filter group and no button', async () => {
  const v = await deliv(fx('no-run'))
  assert.match(tidy(text(v)), /Nothing built yet\. Deliverables appear as crews finish\./)
  assert.equal(find(v, 'group').length, 0, 'no filter group')
  assert.equal(find(v, 'button').length, 0, 'no button')
})

// ---- 3. populated: chips and header ---------------------------------------------------------------------
test('Deliverables: chips All, Docs, Code, Plan and Images carry counts that include no ADR', async () => {
  const v = await deliv(populated())
  const filter = find(v, 'group', 'Filter by type')
  assert.equal(filter.length, 1)
  const want: Record<string, number> = { All: 4, Docs: 1, Code: 1, Plan: 1, Images: 1 }
  for (const [label, n] of Object.entries(want)) {
    const chip = find(filter[0]!, 'button', new RegExp(`^${label}\\b`))
    assert.equal(chip.length, 1, label)
    assert.match(nameOf(chip[0]!), new RegExp(`^${label}\\b.*\\b${n}\\b`), `${label} counts ${n}`)
  }
})
test('Deliverables: the Images chip shows 0 when there are no images', async () => {
  const v = await deliv(populated({ images: false }))
  const filter = find(v, 'group', 'Filter by type')[0]!
  assert.match(nameOf(find(filter, 'button', /^Images\b/)[0]!), /\b0\b/)
  assert.match(nameOf(find(filter, 'button', /^All\b/)[0]!), /\b3\b/)
})
test('Deliverables: the header count counts no ADRs', async () => {
  const v = await deliv(populated())
  assert.match(tidy(text(v)), /\b3 ready, 1 to come\b/)
  const w = await deliv(populated({ images: false }))
  assert.match(tidy(text(w)), /\b3 ready\b(?!, )/)
})
test('Deliverables: no ADR title or path shows anywhere in the list', async () => {
  const t = tidy(text(await deliv(populated())))
  for (const a of ADRS) {
    assert.ok(!t.includes(a.title) && !t.includes(a.title.replace(/^ADR-\d+:\s*/, '')), a.title)
    assert.ok(!t.includes(a.file), a.file)
  }
})

// ---- 4. Architecture preview ----------------------------------------------------------------------------
test('Deliverables: the Architecture preview is a scrollable labelled pane, not an h-56 box', async () => {
  const v = await deliv(populated({ plan: false }))
  const pv = find(v, 'complementary', 'Preview: Architecture')
  assert.equal(pv.length, 1, 'with no plan, Architecture is the selected preview')
  assert.ok(![...walk(pv[0]!)].some((n) => cls(n, 'h-56')), 'no h-56 box')
  const pane = [...walk(pv[0]!)].filter((n) => n.a['aria-label'] === 'Architecture document')
  assert.equal(pane.length, 1, 'one pane labelled Architecture document')
  assert.equal(pane[0]!.a.tabindex, '0')
  assert.ok(cls(pane[0]!, 'max-h-[70vh]'), 'max-h-[70vh]')
  assert.ok(cls(pane[0]!, 'overflow-y-auto'), 'overflow-y-auto')
})
test('Deliverables: the preview has Copy path, and Open in Design tab only when onOpenDesign is passed', async () => {
  const withIt = find(await deliv(populated({ plan: false }), { onOpenDesign: () => {} }), 'complementary', /^Preview: /)[0]!
  assert.equal(find(withIt, 'button', 'Copy path').length, 1)
  assert.equal(find(withIt, 'button', 'Open in Design tab').length, 1)
  const without = find(await deliv(populated({ plan: false })), 'complementary', /^Preview: /)[0]!
  assert.equal(find(without, 'button', 'Copy path').length, 1)
  assert.equal(find(without, 'button', 'Open in Design tab').length, 0, 'absent without onOpenDesign')
})

// ---- 5. AdrPreview --------------------------------------------------------------------------------------
const adrView = async (adr: any) =>
  parse(r.render(React.createElement(await load('deliverables/AdrPreview', 'AdrPreview'), { adr, onBack: () => {} })))
test('AdrPreview: h3 with the full title and tabindex -1', async () => {
  const v = await adrView(ADRS[1])
  const h3 = find(v, 'heading').filter((h) => h.tag === 'h3')
  assert.equal(h3.length, 1)
  assert.equal(tidy(text(h3[0]!)), ADRS[1]!.title)
  assert.equal(h3[0]!.a.tabindex, '-1')
})
test('AdrPreview: status word, number, date, Decided by, link chips, summary and path', async () => {
  const t = tidy(text(await adrView(ADRS[1])))
  assert.match(t, /Proposed/)
  assert.match(t, /\b0*12\b/)
  assert.match(t, /2026-10-21/)
  assert.match(t, /Decided by/)
  assert.match(t, /the design engineer/)
  assert.match(t, /amends 0*11\b/)
  assert.match(t, /Two columns\./)
  assert.match(t, /0012-split-the-rail\.md/)
  const accepted = tidy(text(await adrView(ADRS[0])))
  assert.match(accepted, /Accepted/)
})
test('AdrPreview: Copy path and Back to the list buttons', async () => {
  const v = await adrView(ADRS[0])
  assert.equal(find(v, 'button', 'Copy path').length, 1)
  assert.equal(find(v, 'button', 'Back to the list').length, 1)
})
test('AdrPreview: a missing field leaves its row out and a missing summary reads No summary recorded.', async () => {
  const v = await adrView(ADRS[2])
  const t = tidy(text(v))
  assert.match(t, /No summary recorded\./)
  assert.match(t, /Status not stated/)
  assert.equal(find(v, 'term', /Decided by/).length, 0, 'no Decided by row')
  assert.doesNotMatch(t, /\d{4}-\d{2}-\d{2}/, 'no date row')
  assert.doesNotMatch(t, /amends|supersedes|superseded-by/, 'no links')
})
test('AdrPreview: shows no body field', async () => {
  const t = tidy(text(await adrView({ ...ADRS[0], body: 'FULL BODY TEXT MARKER' })))
  assert.doesNotMatch(t, /FULL BODY TEXT MARKER/)
})

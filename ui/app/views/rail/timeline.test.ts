// Spec-first checks for the rail's "Decisions and ADRs" list (R-37, R-46, R-47; ADR-0028 sections 2 and 3).
// Written before the build from the UX direction and ui/contract/rework/docs.spec.ts; they fail until the timeline
// builder lands. Static render only: filter clicks, Show all focus and opening the preview are docs.spec.ts's job.
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
  return ({ ul: 'list', ol: 'list', li: 'listitem', button: 'button', a: n.a.href !== undefined ? 'link' : '', section: 'region', fieldset: 'group' } as Record<string, string>)[t] ?? ''
}
function nameOf(n: N): string {
  const r = rootOf(n)
  if (n.a['aria-label']) return n.a['aria-label']
  if (n.a['aria-labelledby']) {
    return tidy(n.a['aria-labelledby'].split(/\s+/).map((id) => { const e = [...walk(r)].find((x) => x.a.id === id); return e ? text(e) : '' }).join(' '))
  }
  if (n.tag === 'fieldset') { const l = kids(n).find((x) => x.tag === 'legend'); if (l) return tidy(text(l)) }
  return tidy(text(n)) || n.a.title || ''
}
function find(root: N, role: string, name?: string | RegExp): N[] {
  return [...walk(root)].filter((n) => roleOf(n) === role && (name === undefined || (typeof name === 'string' ? nameOf(n) === name : name.test(nameOf(n)))))
}
const hasCls = (n: N, token: string) => (n.a.class ?? '').split(/\s+/).some((c) => c === token || c.endsWith(':' + token))
const all = (root: N, pred: (n: N) => boolean) => [...walk(root)].filter(pred)

// ---- fixtures and mounting -------------------------------------------------------------------------------
const fx = (...p: string[]): any => JSON.parse(fs.readFileSync(path.join(uiDir, 'contract', 'fixtures', ...p) + '.json', 'utf8'))
const NOW = Date.parse('2026-11-02T12:00:00.000Z')
const REGION = 'Decisions and ADRs'
const KINDS = ['Accepted', 'Proposed', 'Rejected', 'Superseded', 'Unstated']
let r: Renderer
before(async () => { r = await createRenderer() })
after(async () => { await r?.close() })
async function timeline(state: unknown, props: Record<string, unknown> = {}): Promise<N> {
  const mod = await r.load('views/rail/Timeline.tsx')
  assert.equal(typeof mod.Timeline, 'function', 'views/rail/Timeline.tsx exports a named function component Timeline')
  return parse(r.render(React.createElement(mod.Timeline, { state, now: NOW, ...props })))
}
function region(v: N): N {
  const reg = find(v, 'region', REGION)
  assert.equal(reg.length, 1, `one region named "${REGION}"`)
  return reg[0]!
}
const adr = (n: number, status: string | null, over: Record<string, unknown> = {}) => ({
  file: `${String(n).padStart(4, '0')}-item-${n}.md`,
  title: `ADR-${String(n).padStart(4, '0')}: Item ${n}`,
  status,
  number: n,
  date: '2026-10-20',
  decidedBy: 'the client',
  links: [],
  summary: `Summary ${n}.`,
  ...over,
})
/** A small populated state: 3 accepted, 1 proposed, 1 superseded, 1 with no status; none rejected. */
function populated(): any {
  const s = fx('run', 'decisions', 'state')
  s.adrs = [adr(1, 'accepted, 2026-10-01'), adr(2, 'accepted, 2026-10-02'), adr(3, 'accepted, 2026-10-03'), adr(4, 'proposed'), adr(5, 'superseded by 0003'), adr(6, null)]
  return s
}
const adrButtons = (reg: N) => find(reg, 'button').filter((b) => /ADR-\d{4}: /.test(nameOf(b)))

// ---- shared interfaces ------------------------------------------------------------------------------------
test('AdrSection exports StatusStrip, kindOf, plainTitle and sortAdrs for the timeline to reuse', async () => {
  const mod = await r.load('views/decisions/AdrSection.tsx')
  for (const n of ['StatusStrip', 'kindOf', 'plainTitle', 'sortAdrs']) assert.equal(typeof mod[n], 'function', `AdrSection.tsx exports ${n}`)
})
test('preview-target.ts exports openAdr, usePreviewTarget and the previewTarget snapshot getter', async () => {
  const mod = await r.load('views/deliverables/preview-target.ts')
  for (const n of ['openAdr', 'usePreviewTarget', 'previewTarget']) assert.equal(typeof mod[n], 'function', `preview-target.ts exports ${n}`)
})

// ---- header, counts, strip, filter -----------------------------------------------------------------------
test('Timeline populated: a region named by its h2 "Decisions and ADRs" with the muted count', async () => {
  const s = populated()
  const reg = region(await timeline(s))
  const h2 = find(reg, 'heading').filter((h) => h.tag === 'h2')
  assert.equal(h2.length, 1)
  assert.equal(tidy(text(h2[0]!)), REGION)
  assert.ok(reg.a['aria-labelledby'] && reg.a['aria-labelledby'] === h2[0]!.a.id, 'the region is labelled by its h2')
  assert.match(tidy(text(reg)), new RegExp(`${s.adrs.length} ADRs, ${s.decisions.length} decisions`))
})
test('Timeline populated: the count reads "27 ADRs, 3 decisions" in that shape', async () => {
  const s = populated()
  s.adrs = Array.from({ length: 27 }, (_, i) => adr(i + 1, 'accepted'))
  s.decisions = s.decisions.slice(0, 3)
  while (s.decisions.length < 3) s.decisions.push(s.decisions[0])
  assert.match(tidy(text(region(await timeline(s)))), /27 ADRs, 3 decisions/)
})
test('Timeline populated: the old "ADR timeline" name is gone', async () => {
  const v = await timeline(populated())
  assert.equal(find(v, 'region', 'ADR timeline').length, 0)
})
test('Timeline populated: a group named "Filter by status" holds All and the five statuses, each with a count, and aria-pressed', async () => {
  const reg = region(await timeline(populated()))
  const groups = find(reg, 'group', 'Filter by status')
  assert.equal(groups.length, 1, 'one group named "Filter by status"')
  const chips = find(groups[0]!, 'button')
  const names = chips.map(nameOf)
  assert.equal(chips.length, 6, `All plus five statuses, got ${JSON.stringify(names)}`)
  const want: Record<string, number> = { All: 6, Accepted: 3, Proposed: 1, Rejected: 0, Superseded: 1, Unstated: 1 }
  for (const [label, count] of Object.entries(want)) {
    const chip = chips.find((c) => nameOf(c).startsWith(label))
    assert.ok(chip, `a chip for ${label}`)
    assert.match(nameOf(chip!), new RegExp(`^${label}\\D*${count}\\b`), `${label} shows its count ${count}`)
    assert.ok(chip!.a['aria-pressed'] === 'true' || chip!.a['aria-pressed'] === 'false', `${label} has aria-pressed`)
  }
  assert.equal(chips.find((c) => nameOf(c).startsWith('All'))!.a['aria-pressed'], 'true', 'All is pressed at first')
})
test('Timeline populated: all five statuses show as chips even when only one is present', async () => {
  const s = populated()
  s.adrs = [adr(1, 'accepted')]
  const chips = find(find(region(await timeline(s)), 'group', 'Filter by status')[0]!, 'button').map(nameOf)
  for (const k of KINDS) assert.ok(chips.some((n) => n.startsWith(k)), `${k} chip present`)
})
test('Timeline populated: a status strip shows each present status as a word with its count', async () => {
  const body = tidy(text(region(await timeline(populated()))))
  for (const k of ['Accepted', 'Proposed', 'Superseded']) assert.match(body, new RegExp(k), `${k} appears as a word`)
})

// ---- empty and loading -----------------------------------------------------------------------------------
test('Timeline empty first use: the exact empty text, no button at all even with onOpenLog', async () => {
  const s = fx('run', 'empty', 'state')
  s.adrs = []; s.decisions = []; s.requests = []; s.transcript = []
  if (s.run) s.run.crews = []
  if (s.session) s.session.queue = []
  const reg = region(await timeline(s, { onOpenLog: () => {} }))
  assert.match(tidy(text(reg)), /No ADRs or decisions yet\. They appear here as the design engineer records them\./)
  assert.equal(find(reg, 'button').length, 0, 'no button')
  assert.equal(find(reg, 'link').length, 0, 'no link')
  assert.equal(find(reg, 'group', 'Filter by status').length, 0, 'no filter')
})
test('Timeline populated: Open log shows only when onOpenLog is passed', async () => {
  const s = populated()
  assert.equal(find(region(await timeline(s, { onOpenLog: () => {} })), 'button', 'Open log').length, 1)
  assert.equal(find(region(await timeline(s)), 'button', 'Open log').length, 0)
})
test('Timeline loading (state null): three skeleton rows and no spinner', async () => {
  const v = await timeline(null)
  const pulses = all(v, (n) => hasCls(n, 'animate-pulse'))
  assert.equal(pulses.filter((n) => hasCls(n, 'h-14')).length, 3, 'three 56 px skeleton rows')
  assert.equal(all(v, (n) => hasCls(n, 'animate-spin') || n.a.role === 'progressbar').length, 0, 'no spinner')
  assert.equal(find(v, 'button').length, 0, 'nothing to click while loading')
})

// ---- ADR items -------------------------------------------------------------------------------------------
test('ADR item: one button type=button per ADR with no nested interactive element', async () => {
  const s = populated()
  const reg = region(await timeline(s))
  const items = adrButtons(reg)
  assert.equal(items.length, s.adrs.length)
  for (const b of items) {
    assert.equal(b.a.type, 'button')
    assert.equal(all(b, (n) => ['a', 'button', 'input', 'select', 'textarea'].includes(n.tag) || n.a.tabindex !== undefined).length, 0, 'nothing interactive inside the item')
  }
})
test('ADR item: the title is a.title as recorded (keeps the ADR-0001: prefix), clamped to two lines, full title in title= and the name', async () => {
  const s = populated()
  const long = 'ADR-0007: ' + 'Keep every long decision title readable '.repeat(6).slice(0, 190)
  assert.equal(long.length, 200)
  s.adrs.push(adr(7, 'accepted', { title: long }))
  const reg = region(await timeline(s))
  const b = adrButtons(reg).find((x) => nameOf(x).includes(long))
  assert.ok(b, 'a button whose accessible name holds the full 200-character title')
  assert.equal(b!.a.title, long, 'the full title is in title=')
  const clamped = all(b!, (n) => hasCls(n, 'line-clamp-2') && tidy(text(n)) === long)
  assert.equal(clamped.length, 1, 'the title element carries line-clamp-2 and the text as recorded')
  const first = adrButtons(reg).find((x) => nameOf(x).includes('ADR-0001: Item 1'))
  assert.ok(first, 'the "ADR-0001:" prefix is kept')
})
test('ADR item: shows the status word from kindOf and the date; no status reads "Status not stated"', async () => {
  const s = populated()
  const reg = region(await timeline(s))
  const byTitle = (t: string) => adrButtons(reg).find((x) => nameOf(x).includes(t))!
  assert.match(nameOf(byTitle('Item 1')), /Accepted/i)
  assert.match(nameOf(byTitle('Item 4')), /Proposed/i)
  assert.match(nameOf(byTitle('Item 5')), /Superseded/i)
  assert.match(nameOf(byTitle('Item 1')), /2026-10-20/, 'the date shows')
  assert.match(nameOf(byTitle('Item 6')), /Status not stated/)
  const dates = all(byTitle('Item 1'), (n) => hasCls(n, 'font-mono') && hasCls(n, 'text-micro') && /2026-10-20/.test(text(n)))
  assert.ok(dates.length >= 1, 'the date is font-mono text-micro')
})
test('Every ADR of a populated state appears in the timeline', async () => {
  for (const name of ['decisions', 'stuck-crew']) {
    const s = fx('run', name, 'state')
    const body = tidy(text(region(await timeline(s))))
    for (const a of s.adrs) assert.ok(body.includes(a.title), `${name}: ${a.title}`)
  }
  const s = fx('rework', 'real-12', 'state')
  const reg = region(await timeline(s))
  for (const a of s.adrs.slice(0, 50)) assert.ok(tidy(text(reg)).includes(a.title), a.title)
})

// ---- request items (R-47) --------------------------------------------------------------------------------
test('Request item: a reply with approvalAsk true is titled "Approval needed", tagged "Waiting on you"', async () => {
  const s = fx('rework', 'approval-ask', 'state')
  assert.equal(s.requests[0].approvalAsk, true)
  const reg = region(await timeline(s))
  const body = tidy(text(reg))
  assert.match(body, /Approval needed/)
  assert.match(body, /Waiting on you/)
  assert.doesNotMatch(body, /Reply needed/)
  assert.doesNotMatch(body, /The PM replied/)
})
test('Request item: a reply without approvalAsk is titled "The PM replied", tagged "Waiting on you"', async () => {
  const s = fx('rework', 'reply-open', 'state')
  assert.equal(s.requests[0].approvalAsk, false)
  const body = tidy(text(region(await timeline(s))))
  assert.match(body, /The PM replied/)
  assert.match(body, /Waiting on you/)
  assert.doesNotMatch(body, /Reply needed/)
  assert.doesNotMatch(body, /Approval needed/)
})
test('Request item: a reply with approvalAsk absent reads "The PM replied"', async () => {
  const s = fx('rework', 'reply-open', 'state')
  delete s.requests[0].approvalAsk
  assert.match(tidy(text(region(await timeline(s)))), /The PM replied/)
})
test('Request item: the rail shows no Approve or Deny button, for either reply', async () => {
  for (const name of ['reply-open', 'approval-ask']) {
    const reg = region(await timeline(fx('rework', name, 'state')))
    assert.equal(find(reg, 'button', /^(Approve|Deny)\b/).length, 0, `${name}: no Approve or Deny`)
  }
})

// ---- long lists ------------------------------------------------------------------------------------------
test('More than 200 items: 200 are rendered and a ghost button "Show 200 more" follows', async () => {
  const s = populated()
  s.adrs = Array.from({ length: 400 }, (_, i) => adr(i + 1, 'accepted'))
  const reg = region(await timeline(s))
  assert.equal(adrButtons(reg).length, 200, '200 items rendered')
  assert.equal(find(reg, 'button', 'Show 200 more').length, 1)
})
test('Up to 200 items: no "Show more" button', async () => {
  const s = populated()
  assert.equal(find(region(await timeline(s)), 'button', /^Show \d+ more/).length, 0)
})

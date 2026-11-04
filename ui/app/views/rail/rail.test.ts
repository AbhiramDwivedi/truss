// Spec-first checks for the rail views: RunContext, Timeline, DecisionsPanel, Deliverables.
// Pins roles, names and copy from ADR-0023 section 4 and ADR-0018 section 10. Interactions are the e2e specs' job.
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
function roleOf(n: N): string {
  if (n.a.role) return n.a.role
  const t = n.tag
  if (/^h[1-6]$/.test(t)) return 'heading'
  if (t === 'input') return n.a.type === 'radio' ? 'radio' : n.a.type === 'checkbox' ? 'checkbox' : 'textbox'
  return ({ article: 'article', form: 'form', ul: 'list', ol: 'list', li: 'listitem', button: 'button', a: n.a.href !== undefined ? 'link' : '', dt: 'term', dd: 'definition', aside: 'complementary', section: 'region', textarea: 'textbox', fieldset: 'group', header: 'banner', main: 'main' } as Record<string, string>)[t] ?? ''
}
function nameOf(n: N): string {
  const r = rootOf(n)
  const byId = (id: string) => [...walk(r)].find((x) => x.a.id === id)
  if (n.a['aria-label']) return n.a['aria-label']
  if (n.a['aria-labelledby']) return tidy(n.a['aria-labelledby'].split(/\s+/).map((id) => { const e = byId(id); return e ? text(e) : '' }).join(' '))
  const viaLabel = () => {
    if (n.a.id) { const l = [...walk(r)].find((x) => x.tag === 'label' && x.a.for === n.a.id); if (l) return tidy(text(l)) }
    for (let p = n.up; p; p = p.up) if (p.tag === 'label') return tidy(text(p))
    return ''
  }
  const role = roleOf(n)
  if (role === 'radio' || role === 'checkbox' || role === 'textbox') return viaLabel() || tidy(text(n)) || n.a.title || ''
  return tidy(text(n)) || n.a.title || ''
}
function find(root: N, role: string, name?: string | RegExp): N[] {
  return [...walk(root)].filter((n) => roleOf(n) === role && (name === undefined || (typeof name === 'string' ? nameOf(n) === name : name.test(nameOf(n)))))
}
const cls = (n: N, token: string) => (n.a.class ?? '').split(/\s+/).some((c) => c === token || c.endsWith(':' + token))
const all = (root: N, pred: (n: N) => boolean) => [...walk(root)].filter(pred)
const ancestors = (n: N) => { const o: N[] = []; for (let p = n.up; p; p = p.up) o.push(p); return o }
const hhmm = (iso: string) => {
  const d = new Date(iso)
  const p = (x: number) => String(x).padStart(2, '0')
  return [`${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`, `${p(d.getHours())}:${p(d.getMinutes())}`]
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A regexp for `<before>HH:MM<after>` where HH:MM is the stamp in UTC or in the local zone. */
const atTime = (before: string, iso: string, after = '') => new RegExp(`${esc(before)}(?:${hhmm(iso).map(esc).join('|')})${esc(after)}`)

// ---- fixtures and mounting -------------------------------------------------------------------------------
const fixDir = path.join(uiDir, 'contract', 'fixtures', 'run')
const fx = (name: string): any => JSON.parse(fs.readFileSync(path.join(fixDir, name + '.json'), 'utf8'))
const NOW = Date.parse('2026-11-02T12:00:00.000Z')
let r: Renderer
before(async () => { r = await createRenderer() })
after(async () => { await r?.close() })
async function mount(file: string, name: string, props: Record<string, unknown>): Promise<N> {
  const mod = await r.load(`views/${file}.tsx`)
  assert.equal(typeof mod[name], 'function', `views/${file}.tsx exports a named function component ${name}`)
  return parse(r.render(React.createElement(mod[name], props)))
}
const nothingBanned = (root: N) => assert.doesNotMatch(tidy(text(root)), /In the plan|plan revision/i)
/** The deliverable count per type chip, as ADR-0023 section 4 derives it from the state. */
function typeCounts(f: any): Record<string, number> {
  const Plan = f.design?.planMd != null ? 1 : 0
  const Docs = (f.design?.architecture != null ? 1 : 0) + (f.adrs ?? []).length
  const Code = (f.run?.crews ?? []).filter((c: any) => c.status === 'merged').length
  const Images = (f.design?.images ?? []).length
  return { All: Plan + Docs + Code + Images, Docs, Code, Plan, Images }
}

// ---- RunContext ------------------------------------------------------------------------------------------
test('RunContext: repo, the idea and the approval time, with Pause build disabled and explained', async () => {
  const s = fx('stuck-crew/state')
  const v = await mount('rail/RunContext', 'RunContext', { state: s, now: NOW })
  const reg = find(v, 'region', 'Run')
  assert.equal(reg.length, 1)
  const body = tidy(text(reg[0]!))
  assert.match(body, /Target repository/)
  assert.ok(body.includes(s.repo), 'the repo is shown')
  assert.match(body, /The idea/)
  assert.ok(body.includes(s.run.goal))
  assert.match(body, atTime('Approved by you at ', s.run.goals[0].approvedAt))
  const pause = find(reg[0]!, 'button', 'Pause build')
  assert.equal(pause.length, 1)
  assert.equal(pause[0]!.a['aria-disabled'], 'true')
  const tip = 'Pausing needs a server endpoint that doesn\'t exist yet.'
  const ref = pause[0]!.a['aria-describedby']
  assert.ok(ref, 'Pause build is described')
  const target = all(v, (n) => n.a.id === ref.split(/\s+/)[0])[0]
  assert.equal(tidy(text(target!)), tip)
  nothingBanned(v)
})
test('RunContext: an automatic approval reads Approved automatically', async () => {
  const s = fx('decisions/state')
  s.run.approval = 'auto'
  s.run.goals[0].approval = 'auto'
  const v = await mount('rail/RunContext', 'RunContext', { state: s, now: NOW })
  assert.match(tidy(text(v)), atTime('Approved automatically at ', s.run.goals[0].approvedAt))
})
test('RunContext: empty state shows the repo, No goal yet. and no Pause build', async () => {
  const s = fx('empty/state')
  const v = await mount('rail/RunContext', 'RunContext', { state: s, now: NOW })
  assert.ok(tidy(text(v)).includes(s.repo))
  assert.match(tidy(text(v)), /No goal yet\. Type one in the box to start\./)
  assert.equal(find(v, 'button', 'Pause build').length, 0)
})

// ---- Timeline --------------------------------------------------------------------------------------------
test('Timeline: ADR timeline region with Open log, ADRs and crews newest first', async () => {
  const s = fx('stuck-crew/state')
  const v = await mount('rail/Timeline', 'Timeline', { state: s, now: NOW })
  const reg = find(v, 'region', 'ADR timeline')
  assert.equal(reg.length, 1)
  assert.equal(find(reg[0]!, 'link', 'Open log').length + find(reg[0]!, 'button', 'Open log').length, 1)
  const body = tidy(text(reg[0]!))
  assert.ok(body.includes('quota-api') && body.includes('quota-store'))
  assert.ok(body.indexOf('quota-api') < body.indexOf('quota-store'), 'the stuck crew (11:45) comes before the merged one (11:40)')
  nothingBanned(v)
})
test('Timeline: lists the ADR titles', async () => {
  const s = fx('decisions/state')
  const reg = find(await mount('rail/Timeline', 'Timeline', { state: s, now: NOW }), 'region', 'ADR timeline')[0]!
  for (const a of s.adrs) assert.ok(tidy(text(reg)).includes(a.title), a.title)
})

// ---- DecisionsPanel --------------------------------------------------------------------------------------
test('DecisionsPanel: Decisions has an h3 per run and lines in file order', async () => {
  const s = fx('decisions/state')
  const v = await mount('decisions/DecisionsPanel', 'DecisionsPanel', { state: s, now: NOW })
  const reg = find(v, 'region', 'Decisions')
  assert.equal(reg.length, 1)
  const runs = new Set(s.decisions.map((d: any) => d.run))
  assert.equal(find(reg[0]!, 'heading').filter((h) => h.tag === 'h3').length, runs.size)
  const items = find(reg[0]!, 'listitem').map((i) => tidy(text(i)))
  assert.equal(items.length, s.decisions.length)
  ;['config valid', 'quotas live in SQLite', 'plan approved by the client'].forEach((t, i) => assert.ok(items[i]!.includes(t), `line ${i + 1} holds "${t}"`))
  nothingBanned(v)
})
test('DecisionsPanel: ADRs has titles with status words', async () => {
  const s = fx('decisions/state')
  s.adrs.push({ file: 'docs/adr/0003-old.md', title: 'ADR-0003: Old store', status: 'Superseded' })
  const v = await mount('decisions/DecisionsPanel', 'DecisionsPanel', { state: s, now: NOW })
  const reg = find(v, 'region', 'ADRs')
  assert.equal(reg.length, 1)
  // Cards, not the legend's items: a card holds the expand button. Old ADRs (no number) sort by file name, newest first.
  const items = find(reg[0]!, 'listitem').filter((i) => find(i, 'button', /./).length > 0).map((i) => tidy(text(i)))
  assert.equal(items.length, 3)
  const bare = (t: string) => t.replace(/^ADR-\d+:\s*/, '')
  s.adrs.forEach((a: any) => {
    const card = items.find((i) => i.includes(bare(a.title)))
    assert.ok(card, a.title)
    assert.ok(card!.toLowerCase().includes(String(a.status).toLowerCase()), `${a.title} shows ${a.status}`)
  })
})
const richAdrs = [
  { file: '0021-a.md', title: 'ADR-0021: Plugin deps', status: 'accepted, 2026-11-02', number: 21, date: '2026-11-02', decidedBy: 'client', links: [], summary: 'Depend on kit.' },
  { file: '0030-b.md', title: 'ADR-0030: New view', status: 'proposed, 2026-11-04', number: 30, date: '2026-11-04', decidedBy: 'default', links: [{ kind: 'amends', n: 21 }], summary: 'Cards for ADRs.' },
  { file: '0005-c.md', title: 'ADR-0005: Gone', status: 'superseded by ADR-0021, 2026-11-02', number: 5, date: '2026-11-02', decidedBy: null, links: [{ kind: 'superseded-by', n: 21 }], summary: null },
  { file: 'notes.md', title: 'notes.md', status: null },
]
test('DecisionsPanel: ADR cards are newest first, with number, date, decided-by, link chips and an expand button', async () => {
  const s = fx('decisions/state')
  s.adrs = richAdrs
  const v = await mount('decisions/DecisionsPanel', 'DecisionsPanel', { state: s, now: NOW })
  const list = find(find(v, 'region', 'ADRs')[0]!, 'list', 'ADRs')[0]!
  const cards = find(list, 'listitem').map((i) => tidy(text(i)))
  assert.equal(cards.length, 4)
  assert.ok(cards[0]!.includes('0030') && cards[0]!.includes('New view') && !cards[0]!.includes('ADR-0030'))
  assert.ok(cards[0]!.includes('2026-11-04') && cards[0]!.includes('decided by default') && cards[0]!.includes('amends 0021'))
  assert.ok(cards[0]!.includes('Cards for ADRs.'))
  assert.ok(cards[1]!.includes('0021') && cards[2]!.includes('superseded by 0021') && cards[3]!.includes('Status not stated'))
  const buttons = find(list, 'button', /./)
  assert.equal(buttons.length, 4)
  for (const b of buttons) assert.equal(b.a['aria-expanded'], 'false')
})
test('DecisionsPanel: the ADR strip counts each status and the filter offers the statuses present', async () => {
  const s = fx('decisions/state')
  s.adrs = richAdrs
  const v = await mount('decisions/DecisionsPanel', 'DecisionsPanel', { state: s, now: NOW })
  const reg = find(v, 'region', 'ADRs')[0]!
  assert.equal(find(reg, 'img', 'ADR status: 1 accepted, 1 proposed, 1 superseded, 1 unstated').length, 1)
  assert.equal(find(reg, 'list', 'ADR status counts').length, 1)
  assert.match(tidy(text(find(reg, 'list', 'ADR status counts')[0]!)), /1 accepteds*1 proposeds*0 rejecteds*1 supersededs*1 unstated/)
  const filter = find(reg, 'group', 'Filter ADRs by status')[0]!
  assert.deepEqual(find(filter, 'button', /./).map((b) => tidy(text(b))), ['All', 'Accepted', 'Proposed', 'Superseded', 'Unstated'])
  assert.equal(find(filter, 'button', 'All')[0]!.a['aria-pressed'], 'true')
})

// ---- Deliverables ----------------------------------------------------------------------------------------
const deliv = async (state: any) => mount('deliverables/Deliverables', 'Deliverables', { state, now: NOW })
test('Deliverables: empty state reads Nothing built yet. with no filter group', async () => {
  const v = await deliv(fx('empty/state'))
  assert.match(tidy(text(v)), /Nothing built yet\. Plans, ADRs and screenshots appear here as crews finish\./)
  assert.equal(find(v, 'group', 'Filter by type').length, 0)
})
test('Deliverables: the region is labelled by its h2 and offers the type filter and Group by toggles', async () => {
  const s = fx('artifacts/state')
  const v = await deliv(s)
  assert.equal(find(v, 'region', 'Built artifacts and deliverables').length, 1)
  assert.equal(find(v, 'heading', 'Built artifacts and deliverables').filter((h) => h.tag === 'h2').length, 1)
  const filter = find(v, 'group', 'Filter by type')
  assert.equal(filter.length, 1)
  for (const [label, n] of Object.entries(typeCounts(s))) {
    const chip = find(filter[0]!, 'button', new RegExp(`^${label}\\b`))
    assert.equal(chip.length, 1, label)
    assert.match(nameOf(chip[0]!), new RegExp(`^${label}\\b.*\\b${n}\\b`))
    assert.match(chip[0]!.a['aria-pressed'] ?? '', /^(true|false)$/)
  }
  const group = find(v, 'group', 'Group by')
  assert.equal(group.length, 1)
  assert.ok(find(group[0]!, 'button').length >= 2)
  for (const b of find(group[0]!, 'button')) assert.match(b.a['aria-pressed'] ?? '', /^(true|false)$/)
})
test('Deliverables: the Images chip counts 0 when there are no images', async () => {
  const s = fx('artifacts/no-images')
  const filter = find(await deliv(s), 'group', 'Filter by type')[0]!
  assert.match(nameOf(find(filter, 'button', /^Images\b/)[0]!), /\b0\b/)
})
test('Deliverables: a Deliverables list, sentence-case stage headings, items titled without the slug', async () => {
  const s = fx('artifacts/state')
  const v = await deliv(s)
  const list = find(v, 'list', 'Deliverables')
  assert.equal(list.length, 1)
  assert.ok(find(list[0]!, 'listitem').length > 0)
  const h3 = find(v, 'heading').filter((h) => h.tag === 'h3')
  assert.ok(h3.length > 0, 'stage groups have h3 headings')
  for (const h of h3) {
    assert.ok(!cls(h, 'uppercase'), 'headings are not uppercased')
    const t = tidy(text(h))
    assert.notEqual(t, t.toUpperCase(), `"${t}" is sentence case`)
  }
  assert.equal(find(v, 'button', /Merged code, stage 0/).length, 1, 'the merged crew is one item titled Merged code, stage 0')
  assert.equal(find(list[0]!, 'button', /quota-store/).length, 0, 'the item name is its title only, not the slug')
})
test('Deliverables: a pending image says when it arrives and is plain text', async () => {
  const v = await deliv(fx('artifacts/state'))
  const msg = all(v, (n) => /^Arrives when .+ merges\. Nothing to open yet\.$/.test(tidy(text(n))))
  assert.ok(msg.length > 0, 'a pending item reads Arrives when <crew> merges. Nothing to open yet.')
  for (const m of msg) {
    assert.ok(!['link', 'button'].includes(roleOf(m)), 'the pending text is not a link or button')
    assert.ok(!ancestors(m).some((p) => ['link', 'button'].includes(roleOf(p))), 'the pending text is not inside a link or button')
  }
  assert.equal(find(v, 'link', /Arrives when/).length + find(v, 'button', /Arrives when/).length, 0)
})
test('Deliverables: the desktop preview is an aside with Open in Design tab and Copy path', async () => {
  const v = await deliv(fx('artifacts/state'))
  const pv = find(v, 'complementary', /^Preview: /)
  assert.equal(pv.length, 1)
  assert.equal(find(pv[0]!, 'button', 'Open in Design tab').length, 1)
  assert.equal(find(pv[0]!, 'button', 'Copy path').length, 1)
  assert.equal(find(v, 'dialog').length + all(v, (n) => n.a.role === 'dialog').length, 0, 'no dialog until an item is opened')
  nothingBanned(v)
})

// Spec-first checks for the crews views: BuildNetwork, AgentCard, the format.ts helpers, RetroRail.
// Pins roles, names and copy from ADR-0028 sections 6, 7, 9 and 10 and the rework-network UX direction. Interactions, clamping,
// animation and layout are the contract specs' job (ui/contract/rework/network.spec.ts), the static renderer cannot measure them.
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
  return ({ article: 'article', form: 'form', ul: 'list', ol: 'list', li: 'listitem', button: 'button', a: n.a.href !== undefined ? 'link' : '', dt: 'term', dd: 'definition', aside: 'complementary', section: 'region', textarea: 'textbox', fieldset: 'group', header: 'banner', main: 'main', dl: 'list' } as Record<string, string>)[t] ?? ''
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
const rwDir = path.join(uiDir, 'contract', 'fixtures', 'rework')
const rx = (name: string): any => JSON.parse(fs.readFileSync(path.join(rwDir, name, 'state.json'), 'utf8'))
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
const network = (state: any, now = NOW) => mount('crews/BuildNetwork', 'BuildNetwork', { state, now })
const region = (v: N) => { const reg = find(v, 'region', 'Build network'); assert.equal(reg.length, 1, 'one region named Build network'); return reg[0]! }

// ---- network helpers -------------------------------------------------------------------------------------
const own = (n: N) => tidy(n.k.filter((x): x is string => typeof x === 'string').join(''))
const articleOf = (reg: N, slug: string) => { const a = find(reg, 'article').filter((x) => nameOf(x) === slug); assert.equal(a.length, 1, `exactly one article named ${slug}`); return a[0]! }
/** The crew card's own text: everything but the agent list. */
function headText(n: N): string {
  if (typeof n === 'string') return n
  if (n.tag === 'ul' || n.a['aria-hidden'] === 'true') return ''
  return n.k.map((x) => (typeof x === 'string' ? x : headText(x))).join('')
}
/** Agent cards of one crew card: list items that are not steps of a progress list. */
const agentCards = (art: N) => all(art, (n) => n.tag === 'li' && !ancestors(n).some((a) => a.tag === 'ol'))
const hasWordAndIcon = (root: N, word: string) =>
  all(root, (n) => tidy(text(n)) === word && all(n, (x) => x.tag === 'svg' || x.a['aria-hidden'] === 'true').length > 0).length > 0
const WORDS = ['Active', 'Done', 'Waiting on you', 'Stuck', 'Planned']
const hasWord = (s: string, w: string) => new RegExp(`(?:^|[^A-Za-z])${w}(?:[^A-Za-z]|$)`).test(s)
const mutate = (state: any, slug: string, f: (c: any) => void) => { f(state.run.crews.find((c: any) => c.slug === slug)); return state }

// ---- BuildNetwork: loading and first use -----------------------------------------------------------------
test('BuildNetwork: no state renders the Build network region aria-busy with no article, button or progressbar', async () => {
  const v = await network(null)
  const reg = find(v, 'region', 'Build network')
  assert.equal(reg.length, 1)
  assert.equal(reg[0]!.a['aria-busy'], 'true')
  assert.equal(find(v, 'region', 'Crews').length, 0, 'the old region name is gone')
  assert.equal(find(v, 'article').length, 0)
  assert.equal(find(v, 'progressbar').length, 0)
  assert.equal(find(v, 'button').length, 0)
})
test('BuildNetwork: a loaded state is not aria-busy and the region has an h2 Build network', async () => {
  const reg = region(await network(rx('live')))
  assert.notEqual(reg.a['aria-busy'], 'true')
  assert.equal(find(reg, 'heading', 'Build network').filter((h) => h.tag === 'h2').length, 1)
})
test('BuildNetwork: no-run shows the PM node, the Planned badge and one placeholder, with no crew and no No plan yet.', async () => {
  const v = await network(rx('no-run'))
  const reg = region(v)
  const body = tidy(text(reg))
  assert.ok(all(reg, (n) => own(n) === 'PM').length > 0, 'the PM chip')
  for (const s of ['Project manager', 'Waiting for your goal']) assert.ok(body.includes(s), s)
  assert.ok(hasWordAndIcon(reg, 'Planned'), 'the Planned badge has an icon in the same element')
  assert.equal(all(reg, (n) => own(n).includes('Crews appear here once the PM has a plan.')).length, 1, 'one placeholder card')
  assert.equal(all(v, (n) => n.a['data-crew'] !== undefined).length, 0, 'no wire')
  assert.equal(find(reg, 'article').length, 0)
  assert.doesNotMatch(tidy(text(v)), /No plan yet\./)
  assert.doesNotMatch(body, /Director/)
  assert.equal(find(reg, 'button').length, 0)
})
test('BuildNetwork: planning shows Planning the run and Active, not Waiting for your goal, and the placeholder', async () => {
  const reg = region(await network(rx('planning')))
  const body = tidy(text(reg))
  assert.ok(body.includes('Planning the run'))
  assert.ok(hasWordAndIcon(reg, 'Active'), 'the Active badge')
  assert.ok(!body.includes('Waiting for your goal'))
  assert.ok(body.includes('Crews appear here once the PM has a plan.'))
  assert.doesNotMatch(body, /Last hand-off/, 'no flow entry, no hand-off line')
  assert.equal(find(reg, 'article').length, 0)
})
test('BuildNetwork: planning with a flow entry shows Last hand-off <time>: <summary>', async () => {
  const s = rx('planning')
  s.session.flow = [{ at: '2026-11-02T11:59:00.000Z', tool: 'Agent', to: 'rework-network', summary: 'Plan the run.' }]
  assert.match(tidy(text(region(await network(s)))), atTime('Last hand-off ', '2026-11-02T11:59:00.000Z', ': Plan the run.'))
})

// ---- BuildNetwork: the live network ----------------------------------------------------------------------
test('BuildNetwork: live PM node reads Running 5 crews in 3 stages with an Active badge and no Director', async () => {
  const reg = region(await network(rx('live')))
  const body = tidy(text(reg))
  assert.match(body, /Running 5 crews in 3 stages/)
  assert.ok(body.includes('Project manager'))
  assert.ok(all(reg, (n) => own(n) === 'PM').length > 0)
  assert.doesNotMatch(body, /Director/)
  assert.doesNotMatch(body, /\d%/, 'no percentage anywhere')
  assert.equal(find(reg, 'progressbar').length, 0)
})
test('BuildNetwork: live has one list per stage holding articles, one article per crew named by its slug, none for agents', async () => {
  const s = rx('live')
  const reg = region(await network(s))
  const lists = all(reg, (n) => n.tag === 'ul' && kids(n).some((li) => li.tag === 'li' && kids(li).some((c) => c.tag === 'article')))
  assert.equal(lists.length, 3, 'one list per stage')
  assert.deepEqual(lists.map((l) => all(l, (n) => n.tag === 'article').length), [1, 3, 1])
  const articles = find(reg, 'article')
  assert.deepEqual(articles.map(nameOf), s.run.crews.map((c: any) => c.slug), 'the crews in stage order')
  for (const a of articles) assert.ok(ancestors(a).some((p) => p.tag === 'li'), 'each article sits in a list item')
  for (const a of articles) assert.equal(all(a, (n) => n.tag === 'article').length, 0, 'no article inside a crew article')
  for (const row of [/Stage 0\W*Merged/, /Stage 1\W*Running/, /Stage 2\W*(?:Next|Planned)/]) assert.match(tidy(text(reg)), row)
})
test('BuildNetwork: live has one aria-hidden [data-crew] wire per crew and the trunk has none', async () => {
  const s = rx('live')
  const v = await network(s)
  const wires = all(v, (n) => n.a['data-crew'] !== undefined)
  assert.deepEqual(wires.map((w) => w.a['data-crew']).sort(), s.run.crews.map((c: any) => c.slug).sort())
  for (const w of wires) {
    assert.equal(w.tag, 'svg')
    assert.equal(w.a['aria-hidden'], 'true')
    assert.ok(all(w, (n) => n.tag === 'line').length >= 2, 'a bus and a drop')
  }
})
test('BuildNetwork: each live crew shows exactly its own status word with an icon in one element', async () => {
  const reg = region(await network(rx('live')))
  const want: Record<string, string> = { 'rework-network': 'Active', 'rework-server': 'Done', 'rework-chat': 'Waiting on you', 'rework-docs': 'Stuck', 'rework-page': 'Planned' }
  for (const [slug, word] of Object.entries(want)) {
    const art = articleOf(reg, slug)
    const head = headText(art)
    for (const w of WORDS) assert.equal(hasWord(head, w), w === word, `${slug}: ${w} ${w === word ? 'shows' : 'does not show'}`)
    assert.ok(hasWordAndIcon(art, word), `${slug}: ${word} badge has an icon in the same element`)
  }
})
test('BuildNetwork: the rework-network card shows the latest hand-off from the PM with the full text in title', async () => {
  const art = articleOf(region(await network(rx('live'))), 'rework-network')
  const line = all(art, (n) => atTime('From PM ', '2026-11-02T11:59:55.000Z', ': Build the network view to the design.').test(own(n)))
  assert.equal(line.length, 1)
  assert.equal(line[0]!.a.title, own(line[0]!), 'title holds the full line')
  assert.equal(all(articleOf(region(await network(rx('live'))), 'rework-server'), (n) => /^From PM/.test(own(n))).length, 1, 'an old hand-off still shows, whatever its age')
})
test('BuildNetwork: the meta row has Stage n and n agents as separate spans with no middle dot', async () => {
  const art = articleOf(region(await network(rx('live'))), 'rework-network')
  assert.equal(all(art, (n) => n.tag === 'span' && own(n) === 'Stage 1').length, 1)
  assert.equal(all(art, (n) => n.tag === 'span' && own(n) === '3 agents').length, 1)
  assert.doesNotMatch(headText(art), /·/)
})
test('BuildNetwork: a waiting crew has the question notice and its foreman card is Waiting on you', async () => {
  const art = articleOf(region(await network(rx('live'))), 'rework-chat')
  assert.match(tidy(text(art)), /The foreman asked a question\. You'll answer it in Your move\./)
  const card = agentCards(art)[0]!
  assert.ok(hasWord(tidy(text(card)), 'Waiting on you'))
})
test('BuildNetwork: the notice follows the foreman detail: BLOCKED and PROPOSAL', async () => {
  for (const [detail, copy] of [['BLOCKED', 'The foreman is blocked.'], ['PROPOSAL', 'The foreman proposed a change.']] as const) {
    const s = mutate(rx('live'), 'rework-chat', (c) => { c.foreman.detail = detail + ': need a call' })
    const art = articleOf(region(await network(s)), 'rework-chat')
    assert.match(tidy(text(art)), new RegExp(`${esc(copy)} You'll answer it in Your move\\.`), detail)
    assert.ok(hasWord(headText(art), 'Waiting on you'), detail)
  }
})
test('BuildNetwork: a crew with no pending question has no notice', async () => {
  const reg = region(await network(rx('live')))
  assert.doesNotMatch(tidy(text(articleOf(reg, 'rework-network'))), /Your move/)
  assert.equal(tidy(text(reg)).split("You'll answer it in Your move.").length - 1, 1, 'one notice in the network')
})
test('BuildNetwork: a stuck crew keeps the StuckCard under the header and its foreman card reads Stuck, Stalled 14 min', async () => {
  const art = articleOf(region(await network(rx('live'))), 'rework-docs')
  assert.match(tidy(text(art)), /14 min/)
  assert.equal(find(art, 'term', 'Why').length, 1)
  assert.equal(find(art, 'term', 'How long').length, 1)
  assert.equal(find(art, 'term', 'Next').length, 1)
  const card = agentCards(art)[0]!
  assert.ok(hasWord(tidy(text(card)), 'Stuck'))
  assert.match(tidy(text(card)), /Stalled 14 min/)
})
test('BuildNetwork: a planned crew says Starts after stage 1. and No agents yet., stage 0 says Not started yet.', async () => {
  const art = articleOf(region(await network(rx('live'))), 'rework-page')
  assert.match(tidy(text(art)), /Starts after stage 1\./)
  assert.match(tidy(text(art)), /No agents yet\./)
  assert.equal(agentCards(art).length, 0)
  const s = mutate(rx('live'), 'rework-page', (c) => { c.stage = 0 })
  assert.match(tidy(text(articleOf(region(await network(s)), 'rework-page'))), /Not started yet\.[\s\S]*No agents yet\./)
})
test('BuildNetwork: a running crew with no agents says No agents yet.', async () => {
  const s = mutate(rx('live'), 'rework-network', (c) => { c.foreman = null; c.members = [] })
  const art = articleOf(region(await network(s)), 'rework-network')
  assert.match(tidy(text(art)), /No agents yet\./)
  assert.equal(agentCards(art).length, 0)
})
test('BuildNetwork: one polite status live region, empty on the first snapshot', async () => {
  const reg = region(await network(rx('live')))
  const live = find(reg, 'status')
  assert.equal(live.length, 1)
  assert.equal(live[0]!.tag, 'p')
  assert.equal(live[0]!.a['aria-live'], 'polite')
  assert.equal(tidy(text(live[0]!)), '', 'nothing announced on the first load')
})
test('BuildNetwork: no stock palette classes in the network', async () => {
  const reg = region(await network(rx('live')))
  const hue = /(?:^|:)(?:bg|text|border|ring|from|to|via|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d/
  assert.equal(all(reg, (n) => (n.a.class ?? '').split(/\s+/).some((c) => hue.test(c))).length, 0, 'no stock palette class')
})

// ---- BuildNetwork: agent cards in the network ------------------------------------------------------------
test('BuildNetwork: rework-network lists the foreman first, then the builder, then the QC engineer, each a list item', async () => {
  const art = articleOf(region(await network(rx('live'))), 'rework-network')
  const cards = agentCards(art)
  assert.equal(cards.length, 3)
  const t = cards.map((c) => tidy(text(c)))
  assert.ok(t[0]!.includes('Foreman') && t[1]!.includes('Builder') && t[2]!.includes('QC engineer'), 'foreman, builder, QC engineer in order')
  assert.ok(/opus/i.test(t[0]!) && t[0]!.includes('Leads one truss crew.') && t[0]!.includes('Splitting the network goal into builder tasks.'))
  assert.ok(t[0]!.includes('rework-network'))
  assert.ok(/sonnet/i.test(t[1]!) && t[1]!.includes('Builds the code a foreman task names, in the crew worktree.') && t[1]!.includes('Building AgentCard and Wire in views/crews.'))
  assert.ok(t[1]!.includes('rework-network-builder'))
  assert.match(t[2]!, /Rules on one truss crew's work/)
  assert.ok(t[2]!.includes('No activity yet'))
  assert.equal(all(cards[2]!, (n) => roleOf(n) === 'button').length, 0, 'No activity yet has no toggle')
})
test('BuildNetwork: every agent card shows Spawned, Working and Reported with the current step marked', async () => {
  const art = articleOf(region(await network(rx('live'))), 'rework-network')
  const current = ['Working', 'Working', 'Spawned']
  agentCards(art).forEach((card, i) => {
    const ols = all(card, (n) => n.tag === 'ol')
    assert.equal(ols.length, 1)
    assert.equal(ols[0]!.a['aria-label'], 'Progress')
    const steps = kids(ols[0]!).filter((x) => x.tag === 'li')
    assert.deepEqual(steps.map((s) => tidy(text(s))), ['Spawned', 'Working', 'Reported'])
    const marked = all(ols[0]!, (n) => n.a['aria-current'] === 'step')
    assert.equal(marked.length, 1, 'one current step')
    const holder = steps.find((s) => s === marked[0] || ancestors(marked[0]!).includes(s))!
    assert.equal(tidy(text(holder)), current[i])
  })
})
test('BuildNetwork: a reported foreman is at step Reported and Done', async () => {
  const art = articleOf(region(await network(rx('live'))), 'rework-server')
  const card = agentCards(art)[0]!
  assert.ok(hasWord(tidy(text(card)), 'Done'))
  const marked = all(card, (n) => n.a['aria-current'] === 'step')
  assert.equal(marked.length, 1)
  assert.match(tidy(text(marked[0]!.tag === 'li' ? marked[0]! : marked[0]!.up!)), /^Reported$/)
})
test('BuildNetwork: no agent card has an empty paragraph', async () => {
  const reg = region(await network(rx('live')))
  for (const card of find(reg, 'article').flatMap(agentCards)) assert.equal(all(card, (n) => n.tag === 'p' && !tidy(text(n))).length, 0, 'no empty line')
})

// ---- BuildNetwork: partial, real-12, long, stress --------------------------------------------------------
test('BuildNetwork: partial shows the unread-events notice once, with the last known agents, and the other crews render', async () => {
  const s = rx('partial')
  const reg = region(await network(s))
  const body = tidy(text(reg))
  assert.equal(body.split("Couldn't read this crew's events").length - 1, 1)
  assert.equal(body.split('Showing the last known agents.').length - 1, 1)
  const art = articleOf(reg, 'rework-network')
  assert.match(tidy(text(art)), /Couldn't read this crew's events/)
  assert.match(tidy(text(art)), /Showing the last known agents\./)
  assert.equal(agentCards(art).length, 2)
  assert.equal(find(reg, 'article').length, s.run.crews.length)
})
test('BuildNetwork: real-12 shows Done and a Dropped chip for a dropped crew and Done for a merged crew with a BLOCKED foreman', async () => {
  const reg = region(await network(rx('real-12')))
  const dropped = articleOf(reg, 'web-app')
  assert.ok(hasWord(headText(dropped), 'Done'))
  assert.ok(all(dropped, (n) => own(n) === 'Dropped').length > 0)
  for (const w of ['Waiting on you', 'Active']) assert.ok(!hasWord(headText(dropped), w), w)
  const merged = articleOf(reg, 'redesign-design')
  assert.ok(hasWord(headText(merged), 'Done'))
  assert.ok(!hasWord(headText(merged), 'Waiting on you'))
  assert.doesNotMatch(headText(merged), /Your move/, 'no question notice on a merged crew')
})
test('BuildNetwork: real-12 shows 6 named agent cards, a Show n more agents button and a collapsed N check runs row', async () => {
  const s = rx('real-12')
  const { isCheckRun } = await r.load('views/crews/format.ts')
  const reg = region(await network(s))
  assert.equal(find(reg, 'article').length, 12)
  for (const c of s.run.crews) {
    const art = articleOf(reg, c.slug)
    const agents = [...(c.foreman ? [c.foreman] : []), ...c.members]
    const runs = agents.filter(isCheckRun).length
    const named = agents.length - runs
    assert.equal(agentCards(art).length, Math.min(6, named), c.slug)
    const buttons = find(art, 'button').filter((b) => b.a['aria-expanded'] !== undefined)
    const more = buttons.filter((b) => /^Show \d+ more agent/.test(nameOf(b)))
    const runRow = buttons.filter((b) => /check runs?$/.test(nameOf(b)))
    if (named > 6) {
      assert.equal(more.length, 1, c.slug)
      assert.equal(nameOf(more[0]!), `Show ${named - 6} more agent${named - 6 === 1 ? '' : 's'}`)
      assert.equal(more[0]!.a['aria-expanded'], 'false')
    } else assert.equal(more.length, 0, c.slug)
    assert.equal(runRow.length, runs > 0 ? 1 : 0, c.slug)
    if (runs > 0) {
      assert.equal(nameOf(runRow[0]!), `${runs} check run${runs === 1 ? '' : 's'}`)
      assert.equal(runRow[0]!.a['aria-expanded'], 'false')
    }
  }
})
test('BuildNetwork: a crew with 7 named agents says Show 1 more agent', async () => {
  const s = rx('real-12')
  mutate(s, 'ui-fixes5', (c) => { c.members = Array.from({ length: 6 }, (_, i) => ({ ...c.foreman, name: `ui-fixes5-w${i}`, type: 'truss:writer', agentId: `w${i}` })) })
  const more = find(articleOf(region(await network(s)), 'ui-fixes5'), 'button').filter((b) => b.a['aria-expanded'] !== undefined)
  assert.equal(more.length, 1)
  assert.equal(nameOf(more[0]!), 'Show 1 more agent')
})
test('orderAgents: foreman first, then builder, tester, ux, qc, stress, planning, writer, resolver, then the rest', async () => {
  const { orderAgents } = await r.load('views/crews/format.ts')
  const m = (name: string, type: string | null) => member({ name, type })
  const fm = m('c', 'truss:foreman')
  const list = [m('c-x', 'general-purpose'), m('c-writer', 'truss:writer'), m('c-qc', 'truss:qc-engineer'), m('c-builder', 'general-purpose'), fm, m('c-tester', 'general-purpose'), m('c-ux', 'truss:ux-engineer'), m('c-resolver', 'truss:resolver')]
  assert.deepEqual(orderAgents(list, fm).map((x: any) => x.name), ['c', 'c-builder', 'c-tester', 'c-ux', 'c-qc', 'c-writer', 'c-resolver', 'c-x'])
})
test('typed agents: kit:builder reads Builder and is not a check run; untyped runners and unnamed general-purpose agents fold', async () => {
  const { isCheckRun, roleWord, orderAgents } = await r.load('views/crews/format.ts')
  const b = { type: 'kit:builder', name: 'crew-m001-ab12' }
  assert.equal(roleWord(b), 'Builder')
  assert.equal(isCheckRun(b), false)
  assert.equal(roleWord({ type: 'kit:test-writer', name: 'crew-m002' }), 'Tester')
  assert.equal(isCheckRun({ type: 'kit:test-writer', name: 'crew-m002' }), false)
  assert.equal(roleWord({ type: 'kit:reviewer', name: 'crew-m003' }), 'Reviewer')
  assert.equal(roleWord({ type: 'kit:scout', name: 'crew-m004' }), 'Scout')
  assert.equal(isCheckRun({ type: 'general-purpose', name: 'crew-runner-2' }), true)
  assert.equal(isCheckRun({ type: null, name: 'crew-runner-2' }), true)
  assert.equal(isCheckRun({ type: 'general-purpose', name: 'crew-agent-3' }), true)
  assert.equal(roleWord({ type: 'general-purpose', name: 'crew-agent-3' }), 'General purpose')
  const fm = { name: 'c', type: 'truss:foreman' }
  const list = [fm, { name: 'c-x', type: 'Explore' }, { name: 'c-m1', type: 'kit:test-writer' }, { name: 'c-m2', type: 'kit:builder' }]
  assert.deepEqual(orderAgents(list as any, fm as any).map((x: any) => x.name), ['c', 'c-m2', 'c-m1', 'c-x'])
})
test('isCheckRun and the runner purpose: runners and unnamed general-purpose agents fold, truss roles never', async () => {
  const { isCheckRun, RUNNER_PURPOSE } = await r.load('views/crews/format.ts')
  assert.equal(isCheckRun({ type: 'general-purpose', name: 'build-crew-runner' }), true)
  assert.equal(isCheckRun({ type: 'general-purpose', name: 'build-crew-builder' }), false)
  assert.equal(isCheckRun({ type: 'truss:foreman', name: 'build-crew' }), false)
  assert.equal(RUNNER_PURPOSE, 'Runs one check command for the crew.')
  const v = await card({ member: member({ name: 'c-runner', purpose: null }), role: 'Runner', task: 'x', status: 'active', step: 2 })
  assert.ok(tidy(text(v)).includes(RUNNER_PURPOSE))
})
test('BuildNetwork: a crew whose agents are all check runs shows the foreman card and one N check runs row, closed', async () => {
  const base = rx('real-12')
  const tpl = base.run.crews[0]
  const m = (j: number) => ({ name: `crew-0-agent-${j}`, type: 'general-purpose', model: 'claude-sonnet-5-5', effort: 'medium', state: 'tagged', detail: 'working', ts: '2026-11-02T11:58:00.000Z', agentId: `id-${j}`, purpose: null, task: null })
  const crew = { ...tpl, slug: 'crew-0', stage: 0, status: 'running', members: Array.from({ length: 30 }, (_, j) => m(j)), stuck: null, qc: null }
  const art = articleOf(region(await network({ ...base, run: { ...base.run, goals: undefined, crews: [crew] } })), 'crew-0')
  assert.equal(agentCards(art).length, 1)
  const row = find(art, 'button').filter((b) => nameOf(b) === '30 check runs')
  assert.equal(row.length, 1)
  assert.equal(row[0]!.a['aria-expanded'], 'false')
})
test('BuildNetwork: a 60 character slug is the whole h3, with title, tabindex 0 and the article named by it', async () => {
  const s = rx('long')
  const slug = s.run.crews[0].slug as string
  assert.equal(slug.length, 60)
  const reg = region(await network(s))
  const art = articleOf(reg, slug)
  const h3 = all(art, (n) => n.tag === 'h3')
  assert.equal(h3.length, 1)
  assert.equal(tidy(text(h3[0]!)), slug)
  assert.equal(h3[0]!.a.title, slug)
  assert.equal(h3[0]!.a.tabindex, '0')
  assert.ok(h3[0]!.a.id, 'the h3 has an id')
  assert.equal(art.a['aria-labelledby'], h3[0]!.a.id)
})
test('BuildNetwork: a 300 character task shows in full once per card, not twice', async () => {
  const s = rx('long')
  const c = s.run.crews[0]
  const art = articleOf(region(await network(s)), c.slug)
  for (const task of [c.foreman.task, c.members[0].task] as string[]) assert.equal(all(art, (n) => own(n) === task).length, 1)
  assert.equal(all(art, (n) => n.a['aria-controls'] !== undefined).length, 0, 'no toggle before the line is measured')
})
test('BuildNetwork: 12 crews with 100 agents render only the 12 foreman cards inside one second (the check runs fold)', async () => {
  const base = rx('real-12')
  const mk = (i: number, n: number) => {
    const m = (j: number) => ({ name: `crew-${i}-agent-${j}`, type: 'general-purpose', model: 'claude-sonnet-5-5', effort: 'medium', state: 'tagged', detail: 'working', ts: '2026-11-02T11:58:00.000Z', agentId: `id-${i}-${j}`, purpose: 'Builds one thing.', task: `Task ${i}-${j}` })
    const tpl = base.run.crews[0]
    return { ...tpl, slug: `crew-${i}`, stage: i % 3, status: 'running', foreman: { ...tpl.foreman, name: `crew-${i}`, state: 'tagged', detail: 'working' }, members: Array.from({ length: n }, (_, j) => m(j)), stuck: null, qc: null }
  }
  const s = { ...base, run: { ...base.run, crews: Array.from({ length: 12 }, (_, i) => mk(i, i < 4 ? 9 : 8)) } }
  assert.equal(s.run.crews.reduce((a: number, c: any) => a + c.members.length, 0), 100)
  await network(s)
  const t0 = performance.now()
  const reg = region(await network(s))
  const ms = performance.now() - t0
  assert.equal(find(reg, 'article').length, 12)
  assert.equal(find(reg, 'article').flatMap(agentCards).length, 12)
  assert.ok(ms < 1000, `rendered in ${Math.round(ms)} ms`)
})

// ---- BuildNetwork: the StuckCard (kept from ADR-0023) ----------------------------------------------------
test('BuildNetwork: a stuck crew names what stalled and gives Why, How long and Next once, and three actions', async () => {
  const reg = region(await network(fx('stuck-crew/state')))
  const art = articleOf(reg, 'quota-api')
  for (const label of ['Why', 'How long', 'Next']) assert.equal(find(art, 'term', label).length, 1, `${label} appears once`)
  assert.match(tidy(text(art)), /15 ?m/i)
  const restart = find(reg, 'button', 'Restart builder')
  assert.equal(restart.length, 1)
  assert.ok(cls(restart[0]!, 'bg-fail') && cls(restart[0]!, 'text-surface'))
  for (const label of ['Re-plan crew', 'Ask Claude']) {
    const b = find(reg, 'button', label)
    assert.equal(b.length, 1, label)
    assert.ok(cls(b[0]!, 'bg-danger-soft'), `${label} is danger-soft`)
  }
})
test('BuildNetwork: a stalled tester gives Restart tester', async () => {
  const s = fx('stuck-crew/state')
  s.run.crews[1].members[0].name = 'quota-api-tester'
  assert.equal(find(region(await network(s)), 'button', 'Restart tester').length, 1)
})
test('BuildNetwork: an idle foreman gives Start a successor foreman and no Restart button', async () => {
  const reg = region(await network(fx('stuck-crew/idle-foreman')))
  assert.equal(find(reg, 'button', 'Start a successor foreman').length, 1)
  assert.equal(find(reg, 'button', /^Restart /).length, 0)
})

// ---- AgentCard -------------------------------------------------------------------------------------------
const member = (o: Record<string, unknown> = {}) => ({ name: 'rework-network-builder', type: 'general-purpose', model: 'claude-sonnet-5-5', effort: 'medium', state: 'tagged', detail: 'working', ts: '2026-11-02T11:58:30.000Z', agentId: 'a1', purpose: 'Builds the code a foreman task names, in the crew worktree.', task: 'Building AgentCard and Wire in views/crews.', ...o })
async function card(props: Record<string, unknown>): Promise<N> {
  const mod = await r.load('views/crews/AgentCard.tsx')
  assert.ok(mod.AgentCard, 'views/crews/AgentCard.tsx exports AgentCard')
  return parse(r.render(React.createElement(mod.AgentCard, props)))
}
test('AgentCard: is a memoised named export', async () => {
  const mod = await r.load('views/crews/AgentCard.tsx')
  assert.equal(mod.AgentCard?.$$typeof, Symbol.for('react.memo'))
})
test('AgentCard: renders a list item with role, name, model chip, purpose, task and progress, never an article', async () => {
  const m = member()
  const v = await card({ member: m, role: 'Builder', task: m.task, status: 'active', step: 2 })
  const li = kids(v)[0]!
  assert.equal(li.tag, 'li')
  assert.equal(find(v, 'article').length, 0)
  const t = tidy(text(li))
  for (const s of [m.name, 'Builder', m.purpose!, m.task!]) assert.ok(t.includes(s), s)
  assert.match(t, /sonnet/i)
  assert.ok(hasWord(t, 'Active'))
  assert.ok(hasWordAndIcon(li, 'Active'))
  assert.doesNotMatch(t, /\d%/)
})
test('AgentCard: the progress list has three labelled steps and marks the step it is given', async () => {
  for (const [step, label] of [[1, 'Spawned'], [2, 'Working'], [3, 'Reported']] as const) {
    const v = await card({ member: member(), role: 'Builder', task: 'x', status: 'active', step })
    const ol = all(v, (n) => n.tag === 'ol')
    assert.equal(ol.length, 1)
    assert.equal(ol[0]!.a['aria-label'], 'Progress')
    const lis = kids(ol[0]!)
    assert.deepEqual(lis.map((l) => tidy(text(l))), ['Spawned', 'Working', 'Reported'])
    const cur = lis.filter((l) => l.a['aria-current'] === 'step' || all(l, (n) => n.a['aria-current'] === 'step').length > 0)
    assert.equal(cur.length, 1)
    assert.equal(tidy(text(cur[0]!)), label)
  }
})
test('AgentCard: each status shows its word with an icon', async () => {
  for (const [status, word] of [['active', 'Active'], ['done', 'Done'], ['waiting', 'Waiting on you'], ['stuck', 'Stuck'], ['planned', 'Planned']] as const) {
    const v = await card({ member: member(), role: 'Builder', task: 'x', status, step: 2 })
    assert.ok(hasWordAndIcon(v, word), word)
  }
})
test('AgentCard: a null purpose and a null task render no empty line, and No activity yet has no toggle', async () => {
  const v = await card({ member: member({ purpose: null, task: null, detail: null, state: 'spawned' }), role: 'Builder', task: null, status: 'active', step: 1 })
  assert.equal(all(v, (n) => n.tag === 'p' && !tidy(text(n))).length, 0)
  assert.ok(tidy(text(v)).includes('No activity yet'))
  assert.equal(find(v, 'button').length, 0)
  assert.ok(!tidy(text(v)).includes('null') && !tidy(text(v)).includes('undefined'))
})
test('AgentCard: the full task appears once, in a paragraph with an id', async () => {
  const task = 'Rework the network view. '.repeat(12).trim()
  const v = await card({ member: member({ task }), role: 'Builder', task, status: 'active', step: 2 })
  const p = all(v, (n) => own(n) === task)
  assert.equal(p.length, 1)
  assert.equal(p[0]!.tag, 'p')
  assert.ok(p[0]!.a.id)
})
test('AgentCard: a long name and purpose carry the full text in title', async () => {
  const name = 'rework-the-network-view-with-agent-cards-builder-number-seventeen'
  const purpose = 'Builds the code a foreman task names, in the crew worktree, and reports back when the task is done.'
  const v = await card({ member: member({ name, purpose }), role: 'Builder', task: 'x', status: 'active', step: 2 })
  assert.equal(all(v, (n) => n.a.title === name).length > 0, true)
  assert.equal(all(v, (n) => n.a.title === purpose).length > 0, true)
})

// ---- format.ts helpers -----------------------------------------------------------------------------------
const fmt = () => r.load('views/crews/format.ts')
test('AgentCard helpers: modelKey names opus, sonnet, the raw model, and is null for a null model (no "model unknown")', async () => {
  const { modelKey } = await fmt()
  assert.equal(typeof modelKey, 'function', 'format.ts exports modelKey')
  assert.equal(modelKey('claude-opus-5-5'), 'opus')
  assert.equal(modelKey('Claude-Sonnet-5-5'), 'sonnet')
  assert.equal(modelKey('haiku-9'), 'haiku-9')
  assert.equal(modelKey(null), null)
})
test('AgentCard helpers: roleWord names the foreman, QC engineer, other truss types and general-purpose by its name', async () => {
  const { roleWord } = await fmt()
  assert.equal(typeof roleWord, 'function', 'format.ts exports roleWord')
  const w = (type: string | null, name = 'x') => roleWord(member({ type, name }))
  assert.equal(w('truss:foreman'), 'Foreman')
  assert.equal(w('workflow-crew'), 'Foreman')
  assert.equal(w('truss:qc-engineer'), 'QC engineer')
  assert.equal(w('truss:design-engineer'), 'Design engineer')
  assert.equal(w('truss:ux-engineer'), 'Ux engineer')
  assert.equal(w('general-purpose', 'rework-network-builder'), 'Builder')
  for (const x of ['tester', 'writer', 'runner', 'planner', 'ux']) assert.equal(w('general-purpose', `crew-${x}`), x[0]!.toUpperCase() + x.slice(1), x)
  assert.equal(w('general-purpose', 'crew-gardener'), 'General purpose')
  assert.equal(w('general-purpose', 'solo'), 'General purpose')
})
test('AgentCard helpers: taskLine picks the task, then the foreman goal, then a real detail, else null', async () => {
  const { taskLine } = await fmt()
  assert.equal(typeof taskLine, 'function', 'format.ts exports taskLine')
  const fm = member({ type: 'truss:foreman', name: 'c', task: null, detail: null })
  const crew = { slug: 'c', goal: 'Ship the thing.', foreman: fm, members: [] }
  assert.equal(taskLine(member({ task: 'Do T.', detail: 'working' }), crew), 'Do T.')
  assert.equal(taskLine(fm, crew), 'Ship the thing.')
  assert.equal(taskLine({ ...fm, task: 'Foreman task.' }, crew), 'Foreman task.')
  assert.equal(taskLine(member({ task: null, detail: 'Reading the spec' }), crew), 'Reading the spec')
  assert.equal(taskLine(member({ task: null, detail: 'working' }), crew), null)
  assert.equal(taskLine(member({ task: null, detail: null }), crew), null)
  assert.equal(taskLine(fm, { ...crew, goal: null }), null)
})
test('AgentCard helpers: stepOf is Reported, Spawned only with no detail and no task, Working otherwise', async () => {
  const { stepOf } = await fmt()
  assert.equal(typeof stepOf, 'function', 'format.ts exports stepOf')
  assert.equal(stepOf(member({ state: 'reported' })), 3)
  assert.equal(stepOf(member({ state: 'reported', detail: null, task: null })), 3)
  assert.equal(stepOf(member({ state: 'spawned', detail: null, task: null })), 1)
  assert.equal(stepOf(member({ state: 'spawned', detail: null, task: 'T' })), 2)
  assert.equal(stepOf(member({ state: 'spawned', detail: 'working', task: null })), 2)
  assert.equal(stepOf(member({ state: 'tagged', detail: null, task: null })), 2)
  assert.equal(stepOf(member({ state: 'stalled', detail: '14 min', task: null })), 2)
})

// ---- RetroRail -------------------------------------------------------------------------------------------
test('RetroRail: without retro state there is no Retro stage region', async () => {
  const v = await mount('crews/RetroRail', 'RetroRail', { state: fx('crews-running/state'), now: NOW })
  assert.equal(find(v, 'region', 'Retro stage').length, 0)
})
test('RetroRail: five items named <Step>: <status>, the running detail shown, no plan revision', async () => {
  const s = fx('retro/state')
  const v = await mount('crews/RetroRail', 'RetroRail', { state: s, now: NOW })
  const reg = find(v, 'region', 'Retro stage')
  assert.equal(reg.length, 1)
  const items = find(reg[0]!, 'listitem')
  assert.equal(items.length, 5)
  const want = [['Extract', 'done'], ['Judges', 'running'], ['Triage', 'pending'], ['Fix goal', 'pending'], ['Fixes applied', 'pending']]
  want.forEach(([label, status], i) => assert.match(nameOf(items[i]!), new RegExp(`^${label}: ${status}`)))
  assert.ok(tidy(text(reg[0]!)).includes(s.retro.steps.judges.detail), 'the running step shows its detail')
  nothingBanned(v)
})
test('RetroRail: a failed step is named with its status word', async () => {
  const s = fx('retro/state')
  s.retro.steps.triage = { status: 'failed', at: '2026-11-02T11:58:00.000Z', detail: 'judge crashed' }
  const v = await mount('crews/RetroRail', 'RetroRail', { state: s, now: NOW })
  assert.equal(find(v, 'listitem', /^Triage: failed/).length, 1)
})

// ---- CrewCard QC verdict (ADR-0018 section 10, ADR-0023, ADR-0028 section 9) ----
for (const [verdict, words] of [['PASS', 'QC PASS'], ['FAIL', 'QC FAIL'], [null, 'QC none']] as const) {
  test(`CrewCard: a running crew with QC ${verdict ?? 'none'} shows "${words}" beside the status${verdict === 'FAIL' ? ' and blocked: QC FAIL' : ''}`, async () => {
    const base = rx('live').run.crews.find((c: any) => c.status === 'running' && !c.stuck && !/^\s*(QUESTION|BLOCKED|PROPOSAL)/.test(c.foreman?.detail ?? ''))
    const crew = { ...base, qc: verdict ? { verdict, file: 'reports/x/x-qc.md', at: '2026-11-02T11:00:00.000Z' } : null }
    const mod = await r.load('views/crews/CrewCard.tsx')
    const v = parse(r.render(React.createElement(mod.CrewCard, { crew, now: NOW, checkRunsOpen: true })))
    const t = tidy(text(v))
    assert.ok(t.includes(words), words)
    assert.equal(t.includes('blocked: QC FAIL'), verdict === 'FAIL')
  })
}

// ---- real-data-network (ADR-0029 points 1 and 3, R-42, R-44) ----
// Decision on the empty-line split: taskLine keeps returning null when it has nothing (the existing cases above stay as they
// are), and the card decides the words: a spawned agent shows "No activity yet", any other agent "No task recorded".
// So these cases pin the split on rendered cards, and the taskLine rules that do return text on taskLine itself.
const rd = () => rx('real-data')
/** Agent cards that do not hold another list item (the crew card may wrap each card in an outer li). */
const leafCards = (art: N) => { const a = agentCards(art); return a.filter((li) => !a.some((o) => o !== li && ancestors(o).includes(li))) }
const cardOf = (art: N, name: string) => {
  const hits = agentCards(art).filter((li) => all(li, (n) => n.a.title === name).length > 0)
  const c = hits.filter((li) => !hits.some((o) => o !== li && ancestors(o).includes(li)))
  assert.equal(c.length, 1, `exactly one agent card named ${name} (${hits.length} list items hold it)`)
  return c[0]!
}
const crewCard = async (crew: any) => {
  const mod = await r.load('views/crews/CrewCard.tsx')
  return parse(r.render(React.createElement(mod.CrewCard, { crew, now: NOW, checkRunsOpen: true })))
}
const crewOfRd = (slug: string) => rd().run.crews.find((c: any) => c.slug === slug)
const stepCurrent = (li: N) => {
  const cur = all(li, (n) => n.a['aria-current'] === 'step')
  assert.equal(cur.length, 1, 'one current step')
  return tidy(text(cur[0]!))
}
const mergedWithStalled = () => {
  const c = crewOfRd('docs-crew')
  c.members.push(
    member({ name: 'docs-crew-tester', state: 'stalled', detail: '14 min', task: 'Test the widget.', purpose: null }),
    member({ name: 'docs-crew-writer', state: 'stalled', detail: null, task: null, purpose: null }),
  )
  return c
}

test('taskLine: a detail with text after its marker shows whole, a bare marker never shows (any case, padded)', async () => {
  const { taskLine } = await fmt()
  const crew = { slug: 'c', goal: null, foreman: member({ name: 'c', type: 'truss:foreman' }), members: [] }
  const line = (detail: string) => taskLine(member({ task: null, state: 'tagged', detail }), crew)
  assert.equal(line('BLOCKED: need the API key'), 'BLOCKED: need the API key')
  assert.equal(line('QUESTION: which port?'), 'QUESTION: which port?')
  for (const d of ['BLOCKED', 'QUESTION', 'PROPOSAL', 'DONE', ' blocked ', 'Question', 'proposal']) {
    const got = line(d)
    assert.ok(got === null || !/^(blocked|question|proposal|done)$/i.test(got.trim()), `bare "${d}" never shows as a task line, got ${JSON.stringify(got)}`)
  }
})
test('taskLine: a foreman with no task shows the crew goal, never its raw BLOCKED marker', async () => {
  const { taskLine } = await fmt()
  const fm = member({ name: 'build-crew', type: 'workflow-crew', task: null, state: 'tagged', detail: 'BLOCKED' })
  const crew = { slug: 'build-crew', goal: 'Build the fixture widget.', foreman: fm, members: [] }
  assert.equal(taskLine(fm, crew), 'Build the fixture widget.')
  assert.equal(taskLine({ ...fm, task: 'Own task.' }, crew), 'Own task.')
})
test('taskLine: a reported agent with a bare-marker detail and no task reads exactly "Reported: DONE"', async () => {
  const { taskLine } = await fmt()
  const crew = { slug: 'c', goal: null, foreman: member({ name: 'c', type: 'truss:foreman' }), members: [] }
  assert.equal(taskLine(member({ state: 'reported', task: null, detail: 'DONE' }), crew), 'Reported: DONE')
  assert.equal(taskLine(member({ state: 'reported', task: null, detail: 'done' }), crew), 'Reported: DONE')
  assert.equal(taskLine(member({ state: 'reported', task: null, detail: ' DONE ' }), crew), 'Reported: DONE')
})
test('taskLine: a reported agent with no task and no detail reads exactly "Reported"', async () => {
  const { taskLine } = await fmt()
  const crew = { slug: 'c', goal: null, foreman: member({ name: 'c', type: 'truss:foreman' }), members: [] }
  assert.equal(taskLine(member({ state: 'reported', task: null, detail: null }), crew), 'Reported')
})
test('taskLine: a reported agent keeps its task, and a reported detail that carries text shows whole, over Reported', async () => {
  const { taskLine } = await fmt()
  const crew = { slug: 'c', goal: null, foreman: member({ name: 'c', type: 'truss:foreman' }), members: [] }
  assert.equal(taskLine(member({ state: 'reported', task: 'Write the note.', detail: 'DONE' }), crew), 'Write the note.')
  assert.equal(taskLine(member({ state: 'reported', task: null, detail: 'DONE: all green' }), crew), 'DONE: all green')
})
test('AgentCard helpers: stepOf with a merged or dropped crew is Reported (3) for a tagged foreman and a stalled member', async () => {
  const { stepOf } = await fmt()
  for (const status of ['merged', 'dropped']) {
    const c = { status }
    assert.equal(stepOf(member({ state: 'tagged', detail: 'BLOCKED', task: null }), c), 3, `${status} tagged`)
    assert.equal(stepOf(member({ state: 'stalled', detail: '14 min', task: null }), c), 3, `${status} stalled`)
    assert.equal(stepOf(member({ state: 'spawned', detail: null, task: null }), c), 3, `${status} spawned`)
  }
})
test('AgentCard helpers: stepOf with a running crew behaves as without one', async () => {
  const { stepOf } = await fmt()
  const c = { status: 'running' }
  assert.equal(stepOf(member({ state: 'reported' }), c), 3)
  assert.equal(stepOf(member({ state: 'spawned', detail: null, task: null }), c), 1)
  assert.equal(stepOf(member({ state: 'tagged', detail: null, task: null }), c), 2)
  assert.equal(stepOf(member({ state: 'stalled', detail: '14 min', task: null }), c), 2)
})
test('AgentCard helpers: the new strings Reported, "Reported: " and No task recorded live in format.ts', async () => {
  const src = fs.readFileSync(path.join(uiDir, 'app', 'views', 'crews', 'format.ts'), 'utf8')
  for (const s of ['Reported', 'Reported: ', 'No task recorded']) assert.ok(src.includes(s), s)
})

test('AgentCard: a null model renders no model badge, no "unknown" and no model text, and the status badge still renders', async () => {
  const withModel = await card({ member: member({ model: 'claude-sonnet-5-5' }), role: 'Builder', task: 'x', status: 'done', step: 3 })
  const v = await card({ member: member({ model: null }), role: 'Foreman', task: 'x', status: 'done', step: 3 })
  const chips = (root: N) => all(root, (n) => cls(n, 'bg-transparent')).length
  assert.ok(chips(withModel) >= 1, 'a known model shows the ModelBadge')
  assert.equal(chips(v), chips(withModel) - 1, 'a null model removes exactly the ModelBadge element')
  const t = tidy(text(v))
  assert.doesNotMatch(t, /unknown|opus|sonnet|haiku/i)
  assert.equal(all(v, (n) => n.a.title === '' || n.a.title === 'null').length, 0, 'no orphan title')
  assert.ok(hasWordAndIcon(v, 'Done'))
})
test('AgentCard: a known model still shows its badge', async () => {
  const v = await card({ member: member({ model: 'claude-sonnet-5-5' }), role: 'Builder', task: 'x', status: 'active', step: 2 })
  assert.match(tidy(text(v)), /sonnet/)
})
test('AgentCard: a non-spawned agent with no task says No task recorded in text-subtle, never No activity yet', async () => {
  const v = await card({ member: member({ purpose: null, task: null, detail: 'BLOCKED', state: 'tagged' }), role: 'Foreman', task: null, status: 'done', step: 3 })
  const t = tidy(text(v))
  assert.ok(t.includes('No task recorded'))
  assert.ok(!t.includes('No activity yet'))
  const p = all(v, (n) => n.tag === 'p' && tidy(text(n)) === 'No task recorded')
  assert.equal(p.length, 1)
  assert.ok(cls(p[0]!, 'text-subtle'))
  assert.equal(find(v, 'button').length, 0)
})
test('PmNode: a null model renders no model badge, and a known model still does', async () => {
  const props = { state: 'running', status: 'active', crewCount: 2, stageCount: 1 }
  const none = await mount('crews/PmNode', 'PmNode', { ...props, model: null })
  assert.equal(all(none, (n) => cls(n, 'bg-transparent')).length, 0)
  assert.doesNotMatch(tidy(text(none)), /unknown/i)
  const some = await mount('crews/PmNode', 'PmNode', { ...props, model: 'claude-opus-5-5' })
  assert.match(tidy(text(some)), /opus/)
})

test('CrewCard: a merged crew shows Done on every agent card, no Waiting on you, and Reported current on each', async () => {
  const c = mergedWithStalled()
  const art = await crewCard(c)
  const cards = leafCards(art)
  assert.ok(cards.length >= 1 + c.members.length)
  for (const li of cards) {
    const t = tidy(text(li))
    assert.ok(hasWordAndIcon(li, 'Done'), `Done in: ${t}`)
    for (const w of ['Waiting on you', 'Stuck', 'Active']) assert.ok(!hasWord(t, w), `${w} in: ${t}`)
    assert.ok(!/Stalled|Allowance spent|unknown/.test(t), t)
    assert.equal(stepCurrent(li), 'Reported', t)
  }
})
test('CrewCard: a dropped crew reads Done on every agent card too', async () => {
  const c = mergedWithStalled()
  c.status = 'dropped'
  const art = await crewCard(c)
  for (const li of leafCards(art)) {
    assert.ok(hasWordAndIcon(li, 'Done'))
    assert.equal(stepCurrent(li), 'Reported')
  }
})
test('CrewCard: a stalled member of a merged crew takes its line from the task chain, not Stalled N min', async () => {
  const art = await crewCard(mergedWithStalled())
  const withTask = tidy(text(cardOf(art, 'docs-crew-tester')))
  assert.ok(withTask.includes('Test the widget.'), withTask)
  assert.ok(!/Stalled/.test(withTask), withTask)
  const none = tidy(text(cardOf(art, 'docs-crew-writer')))
  assert.ok(none.includes('No task recorded') && !none.includes('No activity yet') && !/Stalled/.test(none), none)
})
test('CrewCard: a stalled member of a merged crew with no task and detail "14 min" reads No task recorded, never the minutes', async () => {
  for (const status of ['merged', 'dropped']) {
    const c = crewOfRd('docs-crew')
    c.status = status
    c.members.push(member({ name: 'docs-crew-writer', state: 'stalled', detail: '14 min', task: null, purpose: null }))
    const t = tidy(text(cardOf(await crewCard(c), 'docs-crew-writer')))
    assert.ok(t.includes('No task recorded'), `${status}: ${t}`)
    assert.ok(!/min/.test(t), `${status}: ${t}`)
    assert.ok(hasWord(t, 'Done'), `${status}: ${t}`)
  }
})
test('CrewCard: a running crew still shows Stalled N min on its stalled member', async () => {
  const c = crewOfRd('build-crew')
  c.members.push(member({ name: 'build-crew-tester', state: 'stalled', detail: '14 min', task: 'Test it.', purpose: null }))
  const t = tidy(text(cardOf(await crewCard(c), 'build-crew-tester')))
  assert.ok(t.includes('Stalled 14 min') && hasWord(t, 'Stuck'), t)
})
test('CrewCard: real-data docs-crew lines: the foreman reads the crew goal, runner-2 its task, no BLOCKED and no model text', async () => {
  const art = await crewCard(crewOfRd('docs-crew'))
  const fm = tidy(text(cardOf(art, 'docs-crew')))
  assert.ok(fm.includes('Write the design for the fixture widget.'), fm)
  assert.ok(!/BLOCKED|No activity yet|unknown|opus|sonnet|haiku/i.test(fm), fm)
  assert.ok(tidy(text(cardOf(art, 'docs-crew-runner-2'))).includes('Write the design note for the fixture widget in docs/widget.md.'))
  assert.ok(!tidy(text(art)).includes('No activity yet'))
  assert.ok(tidy(text(cardOf(art, 'docs-crew-runner'))).includes('sonnet'))
})
test('CrewCard: a running crew with a BLOCKED foreman keeps Waiting on you and the foreman Notice, and shows the goal', async () => {
  const art = await crewCard(crewOfRd('build-crew'))
  const fm = cardOf(art, 'build-crew')
  const t = tidy(text(fm))
  assert.ok(hasWordAndIcon(fm, 'Waiting on you'), t)
  assert.ok(!hasWord(t, 'Done'), t)
  assert.ok(t.includes('Build the fixture widget.') && !t.includes('BLOCKED') && !t.includes('No activity yet'), t)
  assert.ok(tidy(text(art)).includes("The foreman is blocked. You'll answer it in Your move."))
})
test('CrewCard: real-data build-crew lines: builder reads exactly Reported: DONE, runner (spawned) says No activity yet once', async () => {
  const art = await crewCard(crewOfRd('build-crew'))
  const b = cardOf(art, 'build-crew-builder')
  assert.equal(all(b, (n) => n.tag === 'p' && tidy(text(n)) === 'Reported: DONE').length, 0, 'the builder has a task, so it shows that, not Reported: DONE')
  assert.ok(tidy(text(b)).includes('Build the fixture widget in src/widget/ from the design note.'))
  assert.equal(tidy(text(art)).split('No activity yet').length - 1, 1)
  assert.ok(tidy(text(cardOf(art, 'build-crew-runner'))).includes('No activity yet'))
})
test('CrewCard: a reported agent with no task and detail DONE shows exactly Reported: DONE, with no detail shows Reported', async () => {
  const c = crewOfRd('build-crew')
  c.members[0].task = null
  c.members.push(member({ name: 'build-crew-writer', state: 'reported', detail: null, task: null, purpose: null }))
  const art = await crewCard(c)
  const lineOf = (name: string) => all(cardOf(art, name), (n) => n.tag === 'p' && /^Reported/.test(tidy(text(n)))).map((n) => tidy(text(n)))
  assert.deepEqual(lineOf('build-crew-builder'), ['Reported: DONE'])
  assert.deepEqual(lineOf('build-crew-writer'), ['Reported'])
})
test('CrewCard: a detail that is not a bare marker shows as the line, with text after a marker whole', async () => {
  const c = crewOfRd('build-crew')
  c.members.push(
    member({ name: 'build-crew-reader', state: 'tagged', detail: 'Reading the design note', task: null, purpose: null }),
    member({ name: 'build-crew-asker', state: 'tagged', detail: 'BLOCKED: need the API key', task: null, purpose: null }),
  )
  const art = await crewCard(c)
  assert.ok(tidy(text(cardOf(art, 'build-crew-reader'))).includes('Reading the design note'))
  assert.ok(tidy(text(cardOf(art, 'build-crew-asker'))).includes('BLOCKED: need the API key'))
})
test('CrewCard: a foreman of a merged crew with no goal and only a BLOCKED detail says No task recorded', async () => {
  const c = crewOfRd('docs-crew')
  c.goal = null
  const fm = tidy(text(cardOf(await crewCard(c), 'docs-crew')))
  assert.ok(fm.includes('No task recorded') && !fm.includes('No activity yet') && !/BLOCKED/.test(fm), fm)
})
test('BuildNetwork: the real-data fixture says No activity yet exactly once and never says model unknown', async () => {
  const reg = region(await network(rd()))
  const t = tidy(text(reg))
  assert.equal(t.split('No activity yet').length - 1, 0, 'the one spawned agent is a folded runner')
  assert.ok(!/model unknown/i.test(t))
  assert.ok(tidy(text(articleOf(reg, 'build-crew'))).includes('1 check run'), 'the spawned runner sits behind the check-runs row')
  assert.ok(!tidy(text(articleOf(reg, 'docs-crew'))).includes('No activity yet'))
})

// ---- goal grouping -------------------------------------------------------------------------------------------
const twoGoalState = () => {
  const s = rx('live')
  s.session.status = 'idle'
  s.requests = []
  s.run.crews = s.run.crews.map((c: any) => ({ ...c, goal: null }))
  const tpl = s.run.crews[0]
  s.run.crews.push({ ...tpl, slug: 'later-a', goal: 'g2', stage: 0, status: 'merged' }, { ...tpl, slug: 'later-b', goal: 'g2', stage: 1, status: 'merged' })
  s.run.goals = [
    { id: 'run', goal: 'The first goal', approval: 'auto', approvedAt: '2026-11-02T08:00:00.000Z' },
    { id: 'g2', goal: 'The second goal', approval: 'auto', approvedAt: '2026-11-02T11:00:00.000Z' },
  ]
  return s
}
test('BuildNetwork: two goals show the latest goal by default, with a PM count for it alone', async () => {
  const reg = region(await network(twoGoalState()))
  const slugs = find(reg, 'article').map(nameOf)
  assert.deepEqual(slugs.sort(), ['later-a', 'later-b'])
  assert.match(tidy(text(reg)), /Finished 2 crews in 2 stages/)
})
test('BuildNetwork: an earlier goal is a collapsed button named Earlier goal: <goal text>, with no crews until opened', async () => {
  const reg = region(await network(twoGoalState()))
  const b = find(reg, 'button').filter((x) => nameOf(x) === 'Earlier goal: The first goal')
  assert.equal(b.length, 1)
  assert.equal(b[0]!.a['aria-expanded'], 'false')
  assert.ok(b[0]!.a['aria-controls'])
})
test('goalGroups: a crew goal that plan.json does not list stays with the first goal; no goals gives one run group', async () => {
  const { goalGroups } = await r.load('views/crews/goals.ts')
  const s = twoGoalState()
  s.run.crews[0].goal = 'some goal text'
  const g = goalGroups(s.run)
  assert.deepEqual(g.map((x: any) => [x.id, x.crews.length]), [['run', s.run.crews.length - 2], ['g2', 2]])
  const one = { ...s.run, goals: undefined, crews: s.run.crews.map((c: any) => ({ ...c, goal: 'x' })) }
  assert.equal(goalGroups(one).length, 1)
})

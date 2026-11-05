// Spec-first checks for the page frame (rework-page): runStatusOf, crewAnnouncement, Announcer, the rail header
// and the skip link. Rules: ADR-0028 section 9 (run status) and rework-page-ux section 1 items 2, 4 and 5.
// Known conflicts that rework-design's tests win: the skip link label stays "Skip to Your move", the Session status
// stays always visible. This file does not pin either.
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
const roleOf = (n: N): string => n.a.role ?? ({ ul: 'list', ol: 'list', a: n.a.href !== undefined ? 'link' : '', p: '' } as Record<string, string>)[n.tag] ?? ''
const nameOf = (n: N): string => n.a['aria-label'] ?? (tidy(text(n)) || n.a.title || '')
const find = (root: N, role: string, name?: string | RegExp) =>
  [...walk(root)].filter((n) => roleOf(n) === role && (name === undefined || (typeof name === 'string' ? nameOf(n) === name : name.test(nameOf(n)))))
const cls = (n: N, token: string) => (n.a.class ?? '').split(/\s+/).includes(token)

// ---- fixtures and mounting -------------------------------------------------------------------------------
const fixDir = path.join(uiDir, 'contract', 'fixtures', 'rework')
const fx = (name: string): any => JSON.parse(fs.readFileSync(path.join(fixDir, name, 'state.json'), 'utf8'))
const NOW = Date.parse('2026-11-02T12:00:00.000Z')
let r: Renderer
before(async () => { r = await createRenderer() })
after(async () => { await r?.close() })
async function mount(file: string, name: string, props: Record<string, unknown>): Promise<N> {
  const mod = await r.load(`views/${file}.tsx`)
  assert.equal(typeof mod[name], 'function', `views/${file}.tsx exports a named function component ${name}`)
  return parse(r.render(React.createElement(mod[name], props)))
}
const banner = (state: any, connection = 'live') => mount('shell/Banner', 'Banner', { state, now: NOW, connection })
/** A deep copy of a state with one crew changed. */
function withCrew(state: any, slug: string, patch: Record<string, unknown>): any {
  const next = structuredClone(state)
  Object.assign(next.run.crews.find((c: any) => c.slug === slug), patch)
  return next
}
const STALLED = { kind: 'stalled', since: '2026-11-02T11:45:00.000Z', minutes: 14, detail: 'stalled 14 min' }

// ---- runStatusOf -----------------------------------------------------------------------------------------
test('runStatusOf: a null state is not-started on every connection', async () => {
  const { runStatusOf } = await r.load('views/shell/runStatus.ts')
  for (const c of ['connecting', 'live', 'reconnecting']) assert.equal(runStatusOf(null, c), 'not-started', c)
})

test('runStatusOf: with a state it equals runStatus(state) from views/status', async () => {
  const { runStatusOf } = await r.load('views/shell/runStatus.ts')
  const { runStatus } = await r.load('views/status/status.ts')
  const seen = new Set<string>()
  for (const name of ['no-run', 'planning', 'live', 'reply-open', 'finished', 'partial']) {
    const s = fx(name)
    const want = runStatus(s)
    seen.add(want)
    for (const c of ['connecting', 'live', 'reconnecting']) assert.equal(runStatusOf(s, c), want, `${name} / ${c}`)
  }
  assert.ok(seen.has('working') && seen.has('finished') && seen.has('not-started'), `fixtures cover: ${[...seen]}`)
})

// ---- crewAnnouncement ------------------------------------------------------------------------------------
test('crewAnnouncement: empty when prev is null (first snapshot)', async () => {
  const { crewAnnouncement } = await r.load('views/shell/announce.ts')
  assert.equal(crewAnnouncement(null, fx('live')), '')
})

test('crewAnnouncement: empty when nothing changed', async () => {
  const { crewAnnouncement } = await r.load('views/shell/announce.ts')
  assert.equal(crewAnnouncement(fx('live'), fx('live')), '')
})

test('crewAnnouncement: one crew gives "Crew <slug> is now <word in lower case>"', async () => {
  const { crewAnnouncement } = await r.load('views/shell/announce.ts')
  const prev = fx('live')
  assert.equal(crewAnnouncement(prev, withCrew(prev, 'rework-network', { stuck: STALLED })), 'Crew rework-network is now stuck')
  // Two-word status words stay lower case: rework-chat is Waiting on you in the live fixture; it becomes Active.
  assert.equal(
    crewAnnouncement(prev, withCrew(prev, 'rework-chat', { foreman: { ...prev.run.crews[2].foreman, detail: 'working on it' } })),
    'Crew rework-chat is now active',
  )
})

test('crewAnnouncement: several changes join with "; " in crew order', async () => {
  const { crewAnnouncement } = await r.load('views/shell/announce.ts')
  const prev = fx('live')
  const next = withCrew(withCrew(prev, 'rework-network', { stuck: STALLED }), 'rework-page', { status: 'running' })
  assert.equal(crewAnnouncement(prev, next), 'Crew rework-network is now stuck; Crew rework-page is now active')
})

// ---- Announcer -------------------------------------------------------------------------------------------
test('Announcer: exactly one polite sr-only p with role status, empty on a first snapshot', async () => {
  for (const state of [null, fx('live')]) {
    const a = await mount('shell/Announcer', 'Announcer', { state })
    const ps = [...walk(a)]
    assert.equal(ps.length, 1)
    const p = ps[0]!
    assert.equal(p.tag, 'p')
    assert.equal(p.a.role, 'status')
    assert.equal(p.a['aria-live'], 'polite')
    assert.ok(cls(p, 'sr-only'), 'sr-only class')
    assert.equal(tidy(text(p)), '')
  }
})

// ---- Banner (rail header) --------------------------------------------------------------------------------
test('Banner: a p role=status named Run status holds the status word and an icon', async () => {
  const want: [string, string][] = [['no-run', 'Not started'], ['live', 'Working'], ['reply-open', 'Waiting on you'], ['finished', 'Finished']]
  for (const [name, word] of want) {
    const b = await banner(fx(name))
    const hits = find(b, 'status', 'Run status')
    assert.equal(hits.length, 1, name)
    assert.equal(hits[0]!.tag, 'p', name)
    assert.ok(tidy(text(hits[0]!)).includes(word), `${name}: ${tidy(text(hits[0]!))}`)
    assert.ok([...walk(hits[0]!)].some((n) => n.tag === 'svg'), `${name}: an svg icon`)
  }
})

test('Banner: the summary link points to #run-metrics and reads "$0.00 · 0m" before any usage', async () => {
  const links = find(await banner(fx('no-run')), 'link').filter((n) => n.a.href === '#run-metrics')
  assert.equal(links.length, 1)
  assert.equal(tidy(text(links[0]!)), '$0.00 · 0m')
})

test('Banner: the summary link carries the cost on a live run', async () => {
  const links = find(await banner(fx('live')), 'link').filter((n) => n.a.href === '#run-metrics')
  assert.equal(links.length, 1)
  assert.match(tidy(text(links[0]!)), /^\$23\.48 · \d/)
})

test('Banner: no "Tokens by model" list or model chip in the rail header', async () => {
  const b = await banner(fx('live'))
  assert.equal(find(b, 'list', 'Tokens by model').length, 0)
  assert.doesNotMatch(tidy(text(b)), /Tokens by model|claude-(opus|sonnet)/i)
})

// ---- SkipLink --------------------------------------------------------------------------------------------
test('SkipLink: renders the href it is given', async () => {
  const s = await mount('shell/SkipLink', 'SkipLink', { href: '#main' })
  const a = find(s, 'link')
  assert.equal(a.length, 1)
  assert.equal(a[0]!.a.href, '#main')
})

test('SkipLink: with no props it still points at #your-move', async () => {
  const s = await mount('shell/SkipLink', 'SkipLink', {})
  assert.equal(find(s, 'link')[0]!.a.href, '#your-move')
})

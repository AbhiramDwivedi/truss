// Spec-first checks for the shell and metrics views: Banner, SkipLink, RunStatus, LiveMetrics.
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
const within = (n: N, pred: (x: N) => boolean) => pred(n) || all(n, pred).length > 0
const ancestors = (n: N) => { const o: N[] = []; for (let p = n.up; p; p = p.up) o.push(p); return o }
const hhmm = (iso: string) => {
  const d = new Date(iso)
  const p = (x: number) => String(x).padStart(2, '0')
  return [`${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`, `${p(d.getHours())}:${p(d.getMinutes())}`]
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A regexp for `<before>HH:MM<after>` where HH:MM is the stamp in UTC or in the local zone. */
const atTime = (before: string, iso: string, after = '') => new RegExp(`${esc(before)}(?:${hhmm(iso).map(esc).join('|')})${esc(after)}`)
/** A regexp for `<before><Ddd HH:MM><after>` in UTC or in the local zone. */
const atDayTime = (before: string, iso: string) => {
  const d = new Date(iso)
  const day = (tz?: string) => new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz }).format(d)
  const [u, l] = hhmm(iso)
  return new RegExp(`${esc(before)}(?:${day('UTC')} ${u}|${day()} ${l})`)
}

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
const metrics = (state: any, now = NOW) => mount('metrics/LiveMetrics', 'LiveMetrics', { state, now })
const tileOf = (term: N) => term.up!

// ---- Banner ----------------------------------------------------------------------------------------------
test('Banner: h1 Truss, status Session, notifications and theme buttons, no limit words', async () => {
  const b = await mount('shell/Banner', 'Banner', { state: fx('question/state'), now: NOW, connection: 'live' })
  assert.equal(find(b, 'heading', /^Truss/).filter((h) => h.tag === 'h1').length, 1)
  assert.equal(find(b, 'status', 'Session').length, 1)
  assert.equal(find(b, 'button', /^Turn on notifications$/).length, 1)
  const theme = find(b, 'button', 'Dark theme')
  assert.equal(theme.length, 1)
  assert.match(theme[0]!.a['aria-pressed'] ?? '', /^(true|false)$/)
  assert.doesNotMatch(tidy(text(b)), /\b(limit|budget|quota)/i)
})
test('Banner: Session reads connecting before the first snapshot', async () => {
  const b = await mount('shell/Banner', 'Banner', { state: null, now: NOW, connection: 'connecting' })
  assert.equal(tidy(text(find(b, 'status', 'Session')[0]!)), 'connecting')
})
test('Banner: Session reads idle for the empty state', async () => {
  const b = await mount('shell/Banner', 'Banner', { state: fx('empty/state'), now: NOW, connection: 'live' })
  assert.equal(tidy(text(find(b, 'status', 'Session')[0]!)), 'idle')
})
test('Banner: a session error reads error: <first line>', async () => {
  const s = fx('follow-up/state')
  s.session.status = 'error'
  s.session.error = 'rate limited\nretry in 30s'
  const b = await mount('shell/Banner', 'Banner', { state: s, now: NOW, connection: 'live' })
  assert.equal(tidy(text(find(b, 'status', 'Session')[0]!)), 'error: rate limited')
})

// ---- SkipLink --------------------------------------------------------------------------------------------
test('SkipLink: a link Skip to Your move to #your-move', async () => {
  const s = await mount('shell/SkipLink', 'SkipLink', {})
  const l = find(s, 'link', 'Skip to Your move')
  assert.equal(l.length, 1)
  assert.equal(l[0]!.a.href, '#your-move')
})

// ---- RunStatus -------------------------------------------------------------------------------------------
test('RunStatus: list Run status, each notice is Status: <text>, never Notice:', async () => {
  const s = fx('follow-up/state')
  s.notices = [{ id: 'n1', text: 'Reconnecting…' }, { id: 'n2', text: 'Saved' }]
  const v = await mount('shell/RunStatus', 'RunStatus', { state: s, now: NOW })
  const list = find(v, 'list', 'Run status')
  assert.equal(list.length, 1)
  const items = find(list[0]!, 'listitem').map((i) => tidy(text(i)))
  assert.deepEqual(items, ['Status: Reconnecting…', 'Status: Saved'])
  assert.doesNotMatch(tidy(text(v)), /Notice:/)
})

// ---- LiveMetrics -----------------------------------------------------------------------------------------
test('LiveMetrics: empty state has no Live metrics region', async () => {
  const v = await metrics(fx('empty/state'))
  assert.equal(find(v, 'region', 'Live metrics').length, 0)
})
test('LiveMetrics: six terms in order, six definitions, muted on a sunken tile, mono tabular values', async () => {
  const v = await metrics(fx('live-counter/state'))
  const reg = find(v, 'region', 'Live metrics')
  assert.equal(reg.length, 1)
  const terms = find(reg[0]!, 'term')
  assert.deepEqual(terms.map((t) => tidy(text(t))), ['Elapsed', 'Tokens', 'Spend', 'Agents', 'Crews merged', 'Tasks done'])
  assert.equal(find(reg[0]!, 'definition').length, 6)
  for (const t of terms) {
    assert.ok(cls(t, 'text-muted'), `${tidy(text(t))} is muted text`)
    assert.ok(!cls(t, 'text-subtle'), 'a term is never subtle')
    assert.ok(ancestors(t).some((p) => cls(p, 'bg-sunken')), `${tidy(text(t))} sits on a sunken tile`)
  }
  for (const d of find(reg[0]!, 'definition')) assert.ok(within(d, (x) => cls(x, 'font-mono') && cls(x, 'tabular-nums')) || ancestors(d).some((p) => cls(p, 'font-mono') && cls(p, 'tabular-nums')), 'values are mono with tabular numbers')
})
test('LiveMetrics: Elapsed, Tokens, Spend, Crews merged and Tasks done carry their copy', async () => {
  const s = fx('live-counter/state')
  const reg = find(await metrics(s), 'region', 'Live metrics')[0]!
  const tile = (label: string) => tidy(text(tileOf(find(reg, 'term').find((t) => tidy(text(t)) === label)!)))
  assert.match(tile('Elapsed'), atDayTime('since you approved, ', s.run.goals[0].approvedAt))
  assert.match(tile('Tokens'), /719,000/)
  assert.match(tile('Tokens'), atTime('as of ', s.session.usage.live.at))
  assert.doesNotMatch(tile('Tokens'), /\/min/, 'one live stamp gives no rate')
  assert.doesNotMatch(tile('Tokens'), /not updating/)
  assert.match(tile('Spend'), /\$4\.82/)
  assert.match(tile('Spend'), atTime('as of turn end ', s.session.usage.at))
  assert.match(tile('Crews merged'), /1 \/ 2/)
  const done = find(reg, 'definition').find((d) => tileOf(d) === tileOf(find(reg, 'term').find((t) => tidy(text(t)) === 'Tasks done')!))!
  assert.doesNotMatch(tidy(text(done)), /\//, 'Tasks done has no denominator')
  assert.doesNotMatch(tidy(text(reg)), /from events today|needs a server change/)
  nothingBanned(reg)
})
test('LiveMetrics: a stale live stamp reads as of HH:MM, not updating in signal-text', async () => {
  const s = fx('live-counter/stale')
  const reg = find(await metrics(s), 'region', 'Live metrics')[0]!
  const re = atTime('as of ', s.session.usage.live.at, ', not updating')
  assert.match(tidy(text(reg)), re)
  assert.ok(all(reg, (n) => re.test(tidy(text(n))) && cls(n, 'text-signal-text')).length > 0, 'the stale sub-line is signal-text')
})
test('LiveMetrics: a stuck crew gives a 1 crew stuck link to its card', async () => {
  const reg = find(await metrics(fx('stuck-crew/state')), 'region', 'Live metrics')[0]!
  const l = find(reg, 'link', '1 crew stuck')
  assert.equal(l.length, 1)
  assert.equal(l[0]!.a.href, '#crew-quota-api')
})
test('LiveMetrics: chips show only above zero and link to Your move and the composer', async () => {
  const q = find(await metrics(fx('question/state')), 'region', 'Live metrics')[0]!
  assert.ok(find(q, 'link').some((l) => l.a.href === '#your-move'), 'an open question links to #your-move')
  assert.equal(find(q, 'link').filter((l) => /^#crew-/.test(l.a.href ?? '')).length, 0, 'no stuck chip without a stuck crew')
  const f = find(await metrics(fx('follow-up/state')), 'region', 'Live metrics')[0]!
  assert.ok(find(f, 'link').some((l) => l.a.href === '#composer'), 'a queued message links to #composer')
})

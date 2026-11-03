// Spec-first checks for the floor views: LiveMetrics, BuildNetwork, RetroRail.
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
const network = (state: any, now = NOW) => mount('crews/BuildNetwork', 'BuildNetwork', { state, now })
const tileOf = (term: N) => term.up!

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

// ---- BuildNetwork ----------------------------------------------------------------------------------------
test('BuildNetwork: no state renders the Crews region aria-busy with no article, button or progressbar', async () => {
  const v = await network(null)
  const reg = find(v, 'region', 'Crews')
  assert.equal(reg.length, 1)
  assert.equal(reg[0]!.a['aria-busy'], 'true')
  assert.equal(find(v, 'article').length, 0)
  assert.equal(find(v, 'progressbar').length, 0)
  assert.equal(find(v, 'button').length, 0)
})
test('BuildNetwork: empty state reads No plan yet. with no buttons', async () => {
  const reg = find(await network(fx('empty/state')), 'region', 'Crews')[0]!
  assert.match(tidy(text(reg)), /No plan yet\./)
  assert.equal(find(reg, 'button').length, 0)
})
test('BuildNetwork: stage groups in order with an h3 each, and stage chips', async () => {
  const reg = find(await network(fx('crews-running/state')), 'region', 'Crews')[0]!
  assert.equal(find(reg, 'heading', 'Build network').length, 1)
  const groups = find(reg, 'group', /^Stage \d/)
  assert.deepEqual(groups.map(nameOf), ['Stage 0', 'Stage 1', 'Stage 2'])
  for (const g of groups) assert.ok(find(g, 'heading').some((h) => h.tag === 'h3' && tidy(text(h)).startsWith(nameOf(g))), `${nameOf(g)} has an h3`)
  assert.match(tidy(text(reg)), /Stage 1, running/)
  assert.match(tidy(text(reg)), /Stage 2, next/)
})
test('BuildNetwork: one toggle button per slug whose name holds slug, stage, status, verdict, QC and latest', async () => {
  const s = fx('crews-running/state')
  const reg = find(await network(s), 'region', 'Crews')[0]!
  const toggles = find(reg, 'button').filter((b) => b.a['aria-expanded'] !== undefined)
  for (const c of s.run.crews) {
    const mine = toggles.filter((b) => nameOf(b).includes(c.slug))
    assert.equal(mine.length, 1, `one button for ${c.slug}`)
    const name = nameOf(mine[0]!)
    assert.match(name, new RegExp(`stage ${c.stage}`, 'i'))
    assert.match(name, new RegExp(c.status, 'i'))
    assert.ok(name.includes(c.verdict), 'the verdict is in the name')
    assert.match(name, c.qc?.verdict ? new RegExp(`QC ${c.qc.verdict}`) : /QC none/)
    if (c.latest?.text) assert.ok(name.includes(c.latest.text), 'the latest activity is in the name')
  }
  const api = toggles.find((b) => nameOf(b).includes('quota-api'))!
  assert.equal(api.a['aria-expanded'], 'false', 'a running crew starts collapsed')
})
test('BuildNetwork: crews show agents planned, a Merged chip in fg text, and dashed planned cards', async () => {
  const s = fx('crews-running/state')
  const reg = find(await network(s), 'region', 'Crews')[0]!
  const body = tidy(text(reg))
  for (const c of s.run.crews) assert.ok(body.includes(`${c.estAgents} agents planned`), `${c.slug}: ${c.estAgents} agents planned`)
  const merged = all(reg, (n) => tidy(text(n)) === 'Merged')
  assert.ok(merged.length > 0 && merged.some((n) => cls(n, 'text-fg') || (n.up && cls(n.up, 'text-fg'))), 'the Merged chip text is fg')
  assert.match(body, /About 2 agents\. Starts when stage 1 merges\./)
  assert.ok(all(reg, (n) => cls(n, 'border-dashed')).length > 0, 'a planned card has a dashed border')
})
test('BuildNetwork: no stock palette classes, identity tiles are brand-soft', async () => {
  const reg = find(await network(fx('crews-running/state')), 'region', 'Crews')[0]!
  const hue = /(?:^|:)(?:bg|text|border|ring|from|to|via|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d/
  const bad = all(reg, (n) => (n.a.class ?? '').split(/\s+/).some((c) => hue.test(c)))
  assert.equal(bad.length, 0, 'no stock palette class')
  assert.ok(all(reg, (n) => cls(n, 'bg-brand-soft')).length > 0)
})
test('BuildNetwork: a stuck crew is open with the fail band, Alert image, Why/How long/Next once, and three actions', async () => {
  const s = fx('stuck-crew/state')
  const reg = find(await network(s), 'region', 'Crews')[0]!
  const toggles = find(reg, 'button').filter((b) => b.a['aria-expanded'] !== undefined)
  const head = toggles.find((b) => nameOf(b).includes('quota-api'))!
  assert.equal(head.a['aria-expanded'], 'true', 'the stuck crew starts expanded')
  assert.match(nameOf(head), /stuck: stalled 15 min/)
  assert.equal(find(reg, 'list', 'quota-api members').length, 1)
  assert.match(tidy(text(reg)), /Stuck, silent 15m/)
  assert.match(tidy(text(reg)), /Silent 15m/)
  assert.ok(all(reg, (n) => /Stuck, silent 15m/.test(tidy(text(n))) && cls(n, 'bg-fail') && cls(n, 'text-surface')).length > 0, 'the band is fail with surface text')
  assert.equal(find(reg, 'img', 'Alert').length, 1)
  for (const label of ['Why', 'How long', 'Next']) assert.equal(find(reg, 'term', label).length, 1, `${label} appears once`)
  const restart = find(reg, 'button', 'Restart builder')
  assert.equal(restart.length, 1)
  assert.ok(cls(restart[0]!, 'bg-fail') && cls(restart[0]!, 'text-surface'))
  for (const label of ['Re-plan crew', 'Ask Claude']) {
    const b = find(reg, 'button', label)
    assert.equal(b.length, 1, label)
    assert.ok(cls(b[0]!, 'bg-danger-soft'), `${label} is danger-soft`)
  }
  const long = s.run.crews[2].slug as string
  const longHead = toggles.find((b) => nameOf(b).includes(long))!
  assert.ok(longHead, 'the long slug stays whole in the button name')
  assert.ok(all(longHead, (n) => cls(n, 'truncate') && tidy(text(n)).includes(long)).length > 0, 'the slug is cut with an ellipsis')
})
test('BuildNetwork: a stalled tester gives Restart tester', async () => {
  const s = fx('stuck-crew/state')
  s.run.crews[1].members[0].name = 'quota-api-tester'
  const reg = find(await network(s), 'region', 'Crews')[0]!
  assert.equal(find(reg, 'button', 'Restart tester').length, 1)
})
test('BuildNetwork: an idle foreman gives the stuck: foreman idle name and Start a successor foreman', async () => {
  const reg = find(await network(fx('stuck-crew/idle-foreman')), 'region', 'Crews')[0]!
  const head = find(reg, 'button').filter((b) => b.a['aria-expanded'] !== undefined).find((b) => nameOf(b).includes('quota-api'))!
  assert.match(nameOf(head), /stuck: foreman idle 20 min/)
  assert.equal(find(reg, 'button', 'Start a successor foreman').length, 1)
  assert.equal(find(reg, 'button', /^Restart /).length, 0)
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

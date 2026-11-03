// Spec-first checks for the move views: Banner, SkipLink, RunStatus, YourMove, Composer, FollowUps.
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

// ---- YourMove --------------------------------------------------------------------------------------------
test('YourMove: no state renders the region aria-busy with no article and no progressbar', async () => {
  const v = await mount('move/YourMove', 'YourMove', { state: null, now: NOW })
  const reg = find(v, 'region', 'Your move')
  assert.equal(reg.length, 1)
  assert.equal(reg[0]!.a.id, 'your-move')
  assert.equal(reg[0]!.a['aria-busy'], 'true')
  assert.equal(find(v, 'article').length, 0)
  assert.equal(find(v, 'progressbar').length, 0)
})
test('YourMove: empty state is a quiet Start a run card, no article, no move fill', async () => {
  const v = await mount('move/YourMove', 'YourMove', { state: fx('empty/state'), now: NOW })
  const reg = find(v, 'region', 'Your move')[0]!
  assert.equal(find(reg, 'heading').filter((h) => h.tag === 'h2').length, 1)
  assert.equal(find(reg, 'heading', 'Start a run').length, 1)
  assert.match(tidy(text(reg)), /Type a goal\. Truss plans it, and asks you here when it needs a call\./)
  assert.equal(find(reg, 'article').length, 0)
  assert.equal(all(reg, (n) => cls(n, 'bg-move') || n.a['data-surface'] === 'move').length, 0)
})
test('YourMove: a run with nothing open says Nothing needs you right now and counts running crews', async () => {
  const v = await mount('move/YourMove', 'YourMove', { state: fx('crews-running/state'), now: NOW })
  const reg = find(v, 'region', 'Your move')[0]!
  assert.equal(find(reg, 'heading', 'Nothing needs you right now').length, 1)
  assert.match(tidy(text(reg)), /2 crews running in stage 1\./)
  assert.equal(find(reg, 'article').length, 0)
})
test('YourMove: an open reply with background tasks asks nothing of the person', async () => {
  const s = fx('approval/state')
  s.requests = [{ ...s.requests[0], backgroundTasks: 2 }]
  const v = await mount('move/YourMove', 'YourMove', { state: s, now: NOW })
  assert.match(tidy(text(v)), /Agents still running; nothing needed from you/)
  assert.equal(find(v, 'button', 'Approve').length, 0)
  assert.equal(find(v, 'button', 'Deny').length, 0)
})
test('YourMove: the question card is the hero with pill, recommended option, own answer and submit', async () => {
  const s = fx('question/state')
  const q = s.requests[0].questions[0]
  const v = await mount('move/YourMove', 'YourMove', { state: s, now: NOW })
  const card = find(v, 'article', `Question from Claude: ${q.header}`)
  assert.equal(card.length, 1)
  const c = card[0]!
  assert.ok(cls(c, 'bg-move'), 'the card is the move fill')
  assert.equal(c.a['data-surface'], 'move')
  const pill = all(c, (n) => tidy(text(n)) === 'Your move' && n.tag !== 'h2')
  assert.ok(pill.some((p) => cls(p, 'bg-signal-soft') && cls(p, 'text-signal-text')), 'the Your move pill is signal-soft with signal-text')
  const chip = all(c, (n) => tidy(text(n)) === 'Recommended' && n.tag !== 'label')
  assert.ok(chip.some((p) => cls(p, 'bg-move') && cls(p, 'text-move-fg')), 'the Recommended chip is move with move-fg text')
  assert.match(tidy(text(c)), /Asked 2m ago/)
  const group = find(c, 'radiogroup', q.question)
  assert.equal(group.length, 1)
  const radios = find(group[0]!, 'radio')
  assert.equal(radios.length, q.options.length)
  assert.match(nameOf(radios[0]!), /\(Recommended\)$/)
  assert.equal(find(c, 'textbox', 'Your own answer').length, 1)
  assert.equal(find(c, 'button', 'Submit answers').length, 1)
})
test('YourMove: approval shows the oldest card as the hero and the next as a surface card', async () => {
  const s = fx('approval/state')
  const [reply, perm] = s.requests
  const v = await mount('move/YourMove', 'YourMove', { state: s, now: NOW })
  const articles = find(v, 'article')
  assert.equal(articles.length, 2)
  const rc = find(v, 'article', 'Reply needed')[0]!
  const pc = find(v, 'article', `Permission request: ${perm.toolName}`)[0]!
  assert.ok(rc && pc)
  assert.equal(articles[0], rc, 'the oldest card comes first')
  assert.ok(cls(rc, 'bg-move'))
  assert.ok(!cls(pc, 'bg-move'))
  assert.match(tidy(text(rc)), new RegExp(esc(reply.text.slice(0, 40))))
  for (const b of ['Approve', 'Deny']) { assert.equal(find(rc, 'button', b).length, 1); assert.equal(find(pc, 'button', b).length, 1) }
  assert.equal(find(rc, 'textbox', 'Message with your answer').length, 1)
  for (const t of [perm.toolName, perm.title, perm.summary, perm.decisionReason, perm.blockedPath]) assert.ok(tidy(text(pc)).includes(t), `the permission card shows ${t}`)
  assert.match(tidy(text(v)), /1 more waiting on you/)
})
test('YourMove: an answered card keeps its name and reads Answered.', async () => {
  const s = fx('question/state')
  s.requests[0].status = 'answered'
  s.requests[0].answeredAt = '2026-11-02T11:59:00.000Z'
  s.requests[0].answers = { [s.requests[0].questions[0].question]: 'SQLite' }
  const v = await mount('move/YourMove', 'YourMove', { state: s, now: NOW })
  const card = find(v, 'article', `Question from Claude: ${s.requests[0].questions[0].header}`)
  assert.equal(card.length, 1)
  assert.match(tidy(text(card[0]!)), /Answered\./)
  assert.ok(!cls(card[0]!, 'bg-move'), 'an answered card loses the move fill')
})
test('YourMove: a cancelled card reads Cancelled with the reason and has no buttons', async () => {
  const s = fx('question/state')
  s.requests[0].status = 'cancelled'
  s.requests[0].cancelReason = 'aborted'
  const v = await mount('move/YourMove', 'YourMove', { state: s, now: NOW })
  const card = find(v, 'article')[0]!
  assert.match(tidy(text(card)), /Cancelled/)
  assert.match(tidy(text(card)), /aborted/)
  assert.equal(find(card, 'button').length, 0)
})
test('YourMove: a stuck crew gets no Your move card', async () => {
  const v = await mount('move/YourMove', 'YourMove', { state: fx('stuck-crew/state'), now: NOW })
  assert.equal(find(v, 'article').length, 0)
})

// ---- Composer --------------------------------------------------------------------------------------------
test('Composer: empty state has the Message form, a goal box, Send, and no intent radiogroup', async () => {
  const v = await mount('composer/Composer', 'Composer', { state: fx('empty/state'), now: NOW })
  const form = find(v, 'form', 'Message')
  assert.equal(form.length, 1)
  assert.equal(form[0]!.a.id, 'composer')
  assert.equal(find(form[0]!, 'textbox', 'Goal or message').length, 1)
  assert.equal(find(form[0]!, 'radiogroup', 'What this message is').length, 0)
  const send = find(form[0]!, 'button', 'Send')
  assert.equal(send.length, 1)
  assert.ok(cls(send[0]!, 'bg-move') && cls(send[0]!, 'text-move-fg'), 'the send button is move with move-fg text')
  assert.match(tidy(text(form[0]!)), /Nothing sent yet\./)
  assert.equal(find(form[0]!, 'list').length, 0, 'no follow-up list when nothing was sent')
})
test('Composer: follow-up has the segmented intents, Add to current goal checked, and Send details', async () => {
  const v = await mount('composer/Composer', 'Composer', { state: fx('follow-up/state'), now: NOW })
  const form = find(v, 'form', 'Message')[0]!
  const group = find(form, 'radiogroup', 'What this message is')
  assert.equal(group.length, 1)
  assert.equal(find(group[0]!, 'radio', 'New goal').length, 1)
  const add = find(group[0]!, 'radio', 'Add to current goal')
  assert.equal(add.length, 1)
  assert.equal(add[0]!.a['aria-checked'] ?? (add[0]!.a.checked !== undefined ? 'true' : 'false'), 'true')
  assert.equal(find(group[0]!, 'radio', 'Answer the question').length, 0)
  const send = find(form, 'button', 'Send details')
  assert.equal(send.length, 1)
  assert.ok(cls(send[0]!, 'bg-move') && cls(send[0]!, 'text-move-fg'))
  assert.match(tidy(text(form)), /Details for the approved goal\. Claude checks them against the frozen scope: a crew that hasn't started takes them in its brief, and anything bigger asks you first\./)
  assert.equal(find(form, 'region', 'Follow-ups').length, 1, 'the Follow-ups region sits inside the form')
})
test('Composer: an open question adds the signal note and the Answer the question intent', async () => {
  const v = await mount('composer/Composer', 'Composer', { state: fx('question/state'), now: NOW })
  const form = find(v, 'form', 'Message')[0]!
  assert.match(tidy(text(form)), /Claude's turn is open on your question\. Anything you send now waits in the queue and goes out once you answer it\./)
  const group = find(form, 'radiogroup', 'What this message is')[0]!
  assert.equal(find(group, 'radio', 'Answer the question').length, 1)
  const add = find(group, 'radio', 'Add to current goal')[0]!
  assert.equal(add.a['aria-checked'] ?? (add.a.checked !== undefined ? 'true' : 'false'), 'true')
})
test('Composer: no state still renders the form and never mentions a plan revision', async () => {
  const v = await mount('composer/Composer', 'Composer', { state: null, now: NOW })
  assert.equal(find(v, 'form', 'Message').length, 1)
  nothingBanned(v)
})

// ---- FollowUps -------------------------------------------------------------------------------------------
test('FollowUps: empty state reads Nothing sent yet. with no list', async () => {
  const v = await mount('composer/FollowUps', 'FollowUps', { state: fx('empty/state'), now: NOW })
  const reg = find(v, 'region', 'Follow-ups')
  assert.equal(reg.length, 1)
  assert.match(tidy(text(reg[0]!)), /Nothing sent yet\./)
  assert.equal(find(reg[0]!, 'list').length, 0)
})
test('FollowUps: rows run newest first, one chip each, sentence-case labels, full text in title', async () => {
  const s = fx('follow-up/state')
  const long = s.transcript.find((e: any) => e.id === 'msg-2').text as string
  const v = await mount('composer/FollowUps', 'FollowUps', { state: s, now: NOW })
  const reg = find(v, 'region', 'Follow-ups')[0]!
  const rows = find(reg, 'listitem')
  const body = rows.map((x) => tidy(text(x)))
  const iNew = body.findIndex((t) => t.includes('Also keep the quota error text short.'))
  const iOld = body.findIndex((t) => t.includes('Please also make the follow-up list'))
  assert.ok(iNew >= 0 && iOld >= 0, 'both rows are listed')
  assert.ok(iNew < iOld, 'newest first')
  assert.match(body[iNew]!, /Queued/)
  assert.match(body[iOld]!, atTime('Sent ', '2026-11-02T11:50:00.000Z'))
  assert.equal(all(reg, (n) => tidy(text(n)) === 'Queued').length > 0, true)
  assert.equal(tidy(text(reg)).match(/Queued/g)!.length, s.session.queue.length)
  assert.match(tidy(text(reg)), /New goal/)
  assert.match(tidy(text(reg)), /Add to current goal/)
  assert.equal(all(reg, (n) => cls(n, 'uppercase')).length, 0, 'labels are sentence case')
  assert.ok(all(reg, (n) => n.a.title === long).length >= 1, 'the 300-character row keeps its whole text in a title')
  const oneLine = all(reg, (n) => n.a.title === long)[0]!
  assert.ok(cls(oneLine, 'truncate') && cls(oneLine, 'whitespace-nowrap'), 'the row text is one line with an ellipsis')
  nothingBanned(v)
})

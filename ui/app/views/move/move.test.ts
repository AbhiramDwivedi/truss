// Spec-first checks for the move views: YourMove, Composer, FollowUps, Transcript.
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
for (const name of ['empty/state', 'crews-running/state']) {
  test(`YourMove: ${name} with nothing open renders nothing (no region, no article, no quiet card)`, async () => {
    const v = await mount('move/YourMove', 'YourMove', { state: fx(name), now: NOW })
    assert.equal(find(v, 'region', 'Your move').length, 0)
    assert.equal(find(v, 'article').length, 0)
    assert.equal(find(v, 'heading').length, 0)
    assert.doesNotMatch(tidy(text(v)), /Nothing needs you right now|Start a run/)
  })
}
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
  const rc = find(v, 'article', 'The PM replied')[0]!
  const pc = find(v, 'article', `Permission request: ${perm.toolName}`)[0]!
  assert.ok(rc && pc)
  assert.equal(articles[0], rc, 'the oldest card comes first')
  assert.ok(cls(rc, 'bg-move'))
  assert.ok(!cls(pc, 'bg-move'))
  assert.match(tidy(text(rc)), new RegExp(esc(reply.text.slice(0, 40))))
  for (const b of ['Approve', 'Deny']) { assert.equal(find(rc, 'button', b).length, 0, 'a non-approval reply has no ' + b); assert.equal(find(pc, 'button', b).length, 1) }
  assert.equal(find(rc, 'textbox', 'Your reply').length, 1)
  assert.equal(find(rc, 'button', 'Send reply').length, 1)
  assert.equal(find(rc, 'button', 'Read in thread').length, 1)
  assert.doesNotMatch(tidy(text(v)), /Reply needed/)
  for (const t of [perm.toolName, perm.title, perm.summary, perm.decisionReason, perm.blockedPath]) assert.ok(tidy(text(pc)).includes(t), `the permission card shows ${t}`)
  assert.match(tidy(text(v)), /1 more waiting on you/)
})
test('YourMove: an approval-ask reply is Approval needed with Approve and Deny each stating what it sends', async () => {
  const s = fx('approval/state')
  s.requests = [{ ...s.requests[0], approvalAsk: true }]
  const v = await mount('move/YourMove', 'YourMove', { state: s, now: NOW })
  const card = find(v, 'article', 'Approval needed')
  assert.equal(card.length, 1)
  const c = card[0]!
  assert.equal(find(c, 'button', /^Approve\b.*Sends: Approved\.$/).length, 1)
  assert.equal(find(c, 'button', /^Deny\b.*Sends: Not approved\.$/).length, 1)
  assert.equal(find(c, 'textbox', 'Your reply').length, 1)
  assert.equal(find(c, 'button', 'Send reply').length, 1)
  assert.doesNotMatch(tidy(text(v)), /Reply needed/)
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
const isChecked = (n: N) => n.a['aria-checked'] ?? (n.a.checked !== undefined ? 'true' : 'false')
test('Composer: no plan, nothing sent has a visible Your goal label, a disabled Start run, the hint and no radiogroup', async () => {
  const v = await mount('composer/Composer', 'Composer', { state: fx('empty/state'), now: NOW })
  const form = find(v, 'form', 'Message')
  assert.equal(form.length, 1)
  assert.equal(form[0]!.a.id, 'composer')
  const box = find(form[0]!, 'textbox', 'Your goal')
  assert.equal(box.length, 1)
  assert.ok(all(form[0]!, (n) => n.tag === 'label' && tidy(text(n)) === 'Your goal').length >= 1, 'the label is visible')
  assert.equal(find(form[0]!, 'radiogroup').length, 0)
  assert.equal(find(form[0]!, 'radio').length, 0)
  const send = find(form[0]!, 'button', 'Start run')
  assert.equal(send.length, 1)
  assert.notEqual(send[0]!.a.disabled, undefined, 'Start run is disabled while the box is empty')
  assert.match(tidy(text(form[0]!)), /Type a goal first\./)
  assert.doesNotMatch(tidy(text(form[0]!)), /Nothing sent yet|Goal or message/)
})
test('Composer: a plan or a sent goal shows Message to the PM, Send as radios and Send to PM', async () => {
  const v = await mount('composer/Composer', 'Composer', { state: fx('follow-up/state'), now: NOW })
  const form = find(v, 'form', 'Message')[0]!
  assert.equal(find(form, 'textbox', 'Message to the PM').length, 1)
  const group = find(form, 'radiogroup', 'Send as')
  assert.equal(group.length, 1)
  const msg = find(group[0]!, 'radio', 'Message')
  assert.equal(msg.length, 1)
  assert.equal(isChecked(msg[0]!), 'true', 'Message is the default')
  assert.equal(find(group[0]!, 'radio', 'New goal').length, 1)
  assert.equal(find(group[0]!, 'radio').length, 2)
  assert.equal(find(form, 'radio', 'Add to current goal').length, 0)
  assert.equal(find(form, 'radio', 'Answer the question').length, 0)
  assert.equal(find(form, 'radiogroup', 'What this message is').length, 0)
  assert.equal(find(form, 'button', 'Send to PM').length, 1)
  assert.match(tidy(text(form)), /Sends to the PM as a message\./)
  assert.doesNotMatch(tidy(text(form)), /Details for the approved goal|Send details/)
  assert.equal(find(form, 'region', 'Follow-ups').length, 1, 'the Follow-ups region sits inside the form')
})
test('Composer: an open question keeps the box enabled and says the PM is waiting on the card above', async () => {
  const v = await mount('composer/Composer', 'Composer', { state: fx('question/state'), now: NOW })
  const form = find(v, 'form', 'Message')[0]!
  assert.match(tidy(text(form)), /The PM is waiting on the card above; a message here is sent as well\./)
  assert.doesNotMatch(tidy(text(form)), /Anything you send now waits in the queue/)
  const box = all(form, (n) => n.tag === 'textarea')[0]!
  assert.equal(box.a.disabled, undefined, 'the box stays enabled')
  assert.equal(find(form, 'radio', 'Answer the question').length, 0)
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

// ---- Transcript ------------------------------------------------------------------------------------------
test('Transcript: a polite log named Conversation with the PM, an h2 Conversation and every entry in order', async () => {
  const s = fx('follow-up/state')
  const v = await mount('transcript/Transcript', 'Transcript', { state: s, now: NOW })
  const log = find(v, 'log', 'Conversation with the PM')
  assert.equal(log.length, 1)
  assert.equal(log[0]!.a['aria-live'], 'polite')
  assert.equal(find(v, 'heading', 'Conversation').filter((h) => h.tag === 'h2').length, 1)
  assert.equal(find(v, 'heading', 'Transcript').length, 0)
  assert.equal(find(v, 'log', 'Transcript').length, 0)
  assert.doesNotMatch(tidy(text(v)), /Claude said|Nothing said yet/)
  const body = tidy(text(log[0]!))
  let at = -1
  for (const e of s.transcript) {
    const i = body.indexOf(tidy(e.text), at + 1)
    assert.ok(i > at, `entry ${e.n} follows the one before it`)
    at = i
  }
  nothingBanned(v)
})
test('Transcript: an error entry uses fail-soft and the word Error', async () => {
  const s = fx('follow-up/state')
  s.transcript[1].role = 'error'
  s.transcript[1].text = 'The model call failed.'
  const v = await mount('transcript/Transcript', 'Transcript', { state: s, now: NOW })
  const hit = all(v, (n) => cls(n, 'bg-fail-soft') && tidy(text(n)).includes('The model call failed.'))
  assert.ok(hit.length > 0, 'the error entry sits on fail-soft')
  assert.match(tidy(text(hit[hit.length - 1]!)), /Error/)
})
test('Transcript: the PM is labelled PM, never Claude', async () => {
  const v = await mount('transcript/Transcript', 'Transcript', { state: fx('follow-up/state'), now: NOW })
  const log = find(v, 'log', 'Conversation with the PM')[0]!
  assert.ok(log, 'the log named Conversation with the PM exists')
  assert.ok(all(log, (n) => tidy(text(n)) === 'PM').length > 0, 'a PM sender label shows')
  assert.doesNotMatch(tidy(text(log)), /\bClaude\b/)
})
test('Transcript: no state still renders the log', async () => {
  const v = await mount('transcript/Transcript', 'Transcript', { state: null, now: NOW })
  assert.equal(find(v, 'log', 'Conversation with the PM').length, 1)
})
test('Transcript: no run and no transcript shows the PM-side first-use line, never Nothing said yet.', async () => {
  const v = await mount('transcript/Transcript', 'Transcript', { state: fx('empty/state'), now: NOW })
  const log = find(v, 'log', 'Conversation with the PM')[0]!
  assert.ok(log, 'the log named Conversation with the PM exists')
  assert.match(tidy(text(log)), /Tell the PM what to build\. Sending your goal starts a truss run\./)
  assert.doesNotMatch(tidy(text(v)), /Nothing said yet/)
})

// Spec-first checks for the shared status vocabulary (ADR-0028 section 9, R-44).
// Pins crewStatus, agentStatus, pmStatus, runStatus, STATUS_WORD, StatusBadge and RunStatusBadge.
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
  return n.k.map(text).join('')
}
const tidy = (s: string) => s.replace(/\s+/g, ' ').trim()

// ---- fixtures and mounting -------------------------------------------------------------------------------
const fixture = (name: string): any => JSON.parse(fs.readFileSync(path.join(uiDir, 'contract', 'fixtures', 'rework', name, 'state.json'), 'utf8'))
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
let r: Renderer
before(async () => { r = await createRenderer() })
after(async () => { await r?.close() })
const status = () => r.load('views/status/status.ts')
async function mount(file: string, name: string, props: Record<string, unknown>): Promise<N> {
  const mod = await r.load(`views/status/${file}.tsx`)
  assert.equal(typeof mod[name], 'function', `views/status/${file}.tsx exports a named function component ${name}`)
  return parse(r.render(React.createElement(mod[name], props)))
}
const crewOf = (state: any, slug: string) => state.run.crews.find((c: any) => c.slug === slug)

const member = (over: Record<string, unknown> = {}) => ({ name: 'a-builder', type: 'general-purpose', model: 'sonnet', effort: null, state: 'spawned', detail: null, ts: '2026-11-02T12:00:00.000Z', ...over })
const crew = (over: Record<string, unknown> = {}) => ({
  slug: 'c', stage: 1, verdict: null, status: 'running', goal: null, owns: [], foreman: member({ name: 'c-foreman', type: 'truss:project-manager' }),
  members: [member()], latest: null, qc: null, ...over,
})

// ---- STATUS_WORD -----------------------------------------------------------------------------------------
test('STATUS_WORD: the five statuses map to their words', async () => {
  const { STATUS_WORD } = await status()
  assert.equal(STATUS_WORD.active, 'Active')
  assert.equal(STATUS_WORD.done, 'Done')
  assert.equal(STATUS_WORD.waiting, 'Waiting on you')
  assert.equal(STATUS_WORD.stuck, 'Stuck')
  assert.equal(STATUS_WORD.planned, 'Planned')
})

// ---- crewStatus: table rows ------------------------------------------------------------------------------
test('crewStatus: merged is done', async () => {
  const { crewStatus } = await status()
  assert.equal(crewStatus(crew({ status: 'merged' })), 'done')
})
test('crewStatus: dropped is done', async () => {
  const { crewStatus } = await status()
  assert.equal(crewStatus(crew({ status: 'dropped' })), 'done')
})
test('crewStatus: stuck non-null is stuck', async () => {
  const { crewStatus } = await status()
  const stuck = { kind: 'stalled', since: '2026-11-02T11:46:00.000Z', minutes: 14, detail: 'x' }
  assert.equal(crewStatus(crew({ stuck })), 'stuck')
})
for (const marker of ['QUESTION', 'BLOCKED', 'PROPOSAL']) {
  test(`crewStatus: running with a foreman detail starting ${marker} is waiting`, async () => {
    const { crewStatus } = await status()
    assert.equal(crewStatus(crew({ foreman: member({ type: 'truss:project-manager', detail: `${marker}: need a decision` }) })), 'waiting')
  })
}
test('crewStatus: running with another foreman detail is active', async () => {
  const { crewStatus } = await status()
  assert.equal(crewStatus(crew({ foreman: member({ detail: 'Splitting the goal' }) })), 'active')
})
test('crewStatus: running with a null foreman detail is active', async () => {
  const { crewStatus } = await status()
  assert.equal(crewStatus(crew()), 'active')
})
test('crewStatus: running with no foreman at all is active', async () => {
  const { crewStatus } = await status()
  assert.equal(crewStatus(crew({ foreman: null })), 'active')
})
test('crewStatus: planned is planned', async () => {
  const { crewStatus } = await status()
  assert.equal(crewStatus(crew({ status: 'planned', foreman: null, members: [] })), 'planned')
})
test('crewStatus: a null status with no members is planned', async () => {
  const { crewStatus } = await status()
  assert.equal(crewStatus(crew({ status: null, foreman: null, members: [] })), 'planned')
})
test('crewStatus: a null status with members is not planned', async () => {
  const { crewStatus } = await status()
  assert.notEqual(crewStatus(crew({ status: null })), 'planned')
})

// ---- crewStatus: ordering traps --------------------------------------------------------------------------
test('crewStatus: merged with a BLOCKED foreman detail is done, not waiting', async () => {
  const { crewStatus } = await status()
  assert.equal(crewStatus(crew({ status: 'merged', foreman: member({ detail: 'BLOCKED: x' }) })), 'done')
})
test('crewStatus: dropped with a QUESTION foreman detail is done, not waiting', async () => {
  const { crewStatus } = await status()
  assert.equal(crewStatus(crew({ status: 'dropped', foreman: member({ detail: 'QUESTION: x' }) })), 'done')
})
test('crewStatus: stuck beats a QUESTION foreman detail', async () => {
  const { crewStatus } = await status()
  const stuck = { kind: 'idle-foreman', since: '2026-11-02T11:46:00.000Z', minutes: 14, detail: 'x' }
  assert.equal(crewStatus(crew({ stuck, foreman: member({ detail: 'QUESTION: x' }) })), 'stuck')
})
test('crewStatus: a null stuck on a running crew does not make it stuck', async () => {
  const { crewStatus } = await status()
  assert.equal(crewStatus(crew({ stuck: null })), 'active')
})

// ---- crewStatus: fixtures --------------------------------------------------------------------------------
test('crewStatus: live fixture reads done, active, waiting, stuck, planned', async () => {
  const { crewStatus } = await status()
  const s = fixture('live')
  const got = Object.fromEntries(s.run.crews.map((c: any) => [c.slug, crewStatus(c)]))
  assert.deepEqual(got, {
    'rework-server': 'done',
    'rework-network': 'active',
    'rework-chat': 'waiting',
    'rework-docs': 'stuck',
    'rework-page': 'planned',
  })
})
test('crewStatus: real-12 redesign-design (merged, BLOCKED) is done', async () => {
  const { crewStatus } = await status()
  assert.equal(crewStatus(crewOf(fixture('real-12'), 'redesign-design')), 'done')
})
test('crewStatus: real-12 web-app (dropped) is done', async () => {
  const { crewStatus } = await status()
  assert.equal(crewStatus(crewOf(fixture('real-12'), 'web-app')), 'done')
})
test('crewStatus: real-12 ui-fixes5 (running, QUESTION) is waiting and start-fixes4 (planned) is planned', async () => {
  const { crewStatus } = await status()
  const s = fixture('real-12')
  assert.equal(crewStatus(crewOf(s, 'ui-fixes5')), 'waiting')
  assert.equal(crewStatus(crewOf(s, 'start-fixes4')), 'planned')
})

// ---- agentStatus -----------------------------------------------------------------------------------------
// agentStatus(member, crew: Pick<Crew,'status'>): a merged or dropped crew reads done for every agent (ADR-0029 point 1).
const RUN = { status: 'running' }
for (const crewState of ['merged', 'dropped']) {
  test(`agentStatus: every agent of a ${crewState} crew is done, whatever its state or marker`, async () => {
    const { agentStatus } = await status()
    const C = { status: crewState }
    assert.equal(agentStatus(member({ state: 'tagged', detail: 'BLOCKED' }), C), 'done')
    assert.equal(agentStatus(member({ state: 'tagged', detail: 'QUESTION: x' }), C), 'done')
    assert.equal(agentStatus(member({ state: 'stalled', detail: '14 min' }), C), 'done')
    assert.equal(agentStatus(member({ state: 'allowance-spent' }), C), 'done')
    assert.equal(agentStatus(member({ state: 'spawned', detail: null }), C), 'done')
    assert.equal(agentStatus(member({ state: 'reported' }), C), 'done')
  })
}
test('agentStatus: a running crew with a BLOCKED foreman detail is waiting, not done', async () => {
  const { agentStatus } = await status()
  assert.equal(agentStatus(member({ type: 'workflow-crew', state: 'tagged', detail: 'BLOCKED' }), RUN), 'waiting')
})
test('agentStatus: a running crew with a stalled member is stuck', async () => {
  const { agentStatus } = await status()
  assert.equal(agentStatus(member({ state: 'stalled', detail: '14 min' }), RUN), 'stuck')
})
test('agentStatus: reported is done', async () => {
  const { agentStatus } = await status()
  assert.equal(agentStatus(member({ state: 'reported' }), RUN), 'done')
})
test('agentStatus: stalled is stuck', async () => {
  const { agentStatus } = await status()
  assert.equal(agentStatus(member({ state: 'stalled' }), RUN), 'stuck')
})
test('agentStatus: allowance-spent is stuck', async () => {
  const { agentStatus } = await status()
  assert.equal(agentStatus(member({ state: 'allowance-spent' }), RUN), 'stuck')
})
for (const marker of ['QUESTION', 'BLOCKED', 'PROPOSAL']) {
  test(`agentStatus: a ${marker} detail is waiting`, async () => {
    const { agentStatus } = await status()
    assert.equal(agentStatus(member({ state: 'tagged', detail: `${marker}: need input` }), RUN), 'waiting')
  })
}
for (const state of ['spawned', 'tagged', 'fetched']) {
  test(`agentStatus: state ${state} with no marker is active`, async () => {
    const { agentStatus } = await status()
    assert.equal(agentStatus(member({ state, detail: 'working' }), RUN), 'active')
  })
}
test('agentStatus: a null detail is active', async () => {
  const { agentStatus } = await status()
  assert.equal(agentStatus(member({ detail: null }), RUN), 'active')
})
test('agentStatus: a reported agent with a BLOCKED detail is still done', async () => {
  const { agentStatus } = await status()
  assert.equal(agentStatus(member({ state: 'reported', detail: 'BLOCKED: x' }), RUN), 'done')
})
test('agentStatus: a stalled agent with a QUESTION detail is stuck', async () => {
  const { agentStatus } = await status()
  assert.equal(agentStatus(member({ state: 'stalled', detail: 'QUESTION: x' }), RUN), 'stuck')
})
test('agentStatus: a planned status never comes back for a member', async () => {
  const { agentStatus } = await status()
  for (const state of ['spawned', 'stalled', 'tagged', 'reported', 'allowance-spent', 'fetched']) {
    assert.notEqual(agentStatus(member({ state }), RUN), 'planned', state)
  }
})

// ---- runStatus -------------------------------------------------------------------------------------------
test('runStatus: no transcript and no run is not-started (no-run fixture)', async () => {
  const { runStatus } = await status()
  assert.equal(runStatus(fixture('no-run')), 'not-started')
})
test('runStatus: planning fixture (transcript, running session, no run) is working', async () => {
  const { runStatus } = await status()
  assert.equal(runStatus(fixture('planning')), 'working')
})
test('runStatus: live fixture is working', async () => {
  const { runStatus } = await status()
  assert.equal(runStatus(fixture('live')), 'working')
})
test('runStatus: real-12 fixture is working', async () => {
  const { runStatus } = await status()
  assert.equal(runStatus(fixture('real-12')), 'working')
})
test('runStatus: session.status waiting is waiting', async () => {
  const { runStatus } = await status()
  const s = clone(fixture('live'))
  s.session.status = 'waiting'
  assert.equal(runStatus(s), 'waiting')
})
test('runStatus: waiting session with background tasks and no open request is working; pmStatus is active', async () => {
  const { runStatus, pmStatus } = await status()
  const s = clone(fixture('live'))
  s.session.status = 'waiting'
  s.session.backgroundTasks = [{ taskId: 't1', description: 'ls', subagentType: null }]
  s.requests = []
  assert.equal(runStatus(s), 'working')
  assert.equal(pmStatus(s), 'active')
  s.requests = [{ id: 'q1', status: 'open', createdAt: '2026-11-02T12:00:00.000Z', answeredAt: null, cancelReason: null }]
  assert.equal(runStatus(s), 'waiting')
  assert.equal(pmStatus(s), 'waiting')
})
test('runStatus: an open request is waiting even while the session runs', async () => {
  const { runStatus } = await status()
  const s = clone(fixture('live'))
  s.requests = [{ id: 'q1', status: 'open', createdAt: '2026-11-02T12:00:00.000Z', answeredAt: null, cancelReason: null }]
  assert.equal(runStatus(s), 'waiting')
})
test('runStatus: an answered request does not make the run waiting', async () => {
  const { runStatus } = await status()
  const s = clone(fixture('live'))
  s.requests = [{ id: 'q1', status: 'answered', createdAt: '2026-11-02T12:00:00.000Z', answeredAt: '2026-11-02T12:01:00.000Z', cancelReason: null }]
  assert.equal(runStatus(s), 'working')
})
test('runStatus: every crew merged or dropped and the session idle is finished', async () => {
  const { runStatus } = await status()
  const s = clone(fixture('live'))
  s.run.crews.forEach((c: any, i: number) => { c.status = i % 2 ? 'dropped' : 'merged'; c.stuck = null })
  s.session.status = 'idle'
  assert.equal(runStatus(s), 'finished')
})
test('runStatus: every crew merged but the session still running is working', async () => {
  const { runStatus } = await status()
  const s = clone(fixture('live'))
  s.run.crews.forEach((c: any) => { c.status = 'merged'; c.stuck = null })
  s.session.status = 'running'
  assert.equal(runStatus(s), 'working')
})
test('runStatus: one crew still planned keeps an idle session working', async () => {
  const { runStatus } = await status()
  const s = clone(fixture('live'))
  s.run.crews.forEach((c: any) => { c.status = 'merged'; c.stuck = null })
  s.run.crews[0].status = 'planned'
  s.session.status = 'idle'
  assert.equal(runStatus(s), 'working')
})
test('runStatus: a transcript with run null is not not-started', async () => {
  const { runStatus } = await status()
  const s = clone(fixture('no-run'))
  s.transcript = clone(fixture('planning')).transcript
  assert.notEqual(runStatus(s), 'not-started')
})

// ---- pmStatus --------------------------------------------------------------------------------------------
test('pmStatus: no run and no transcript is planned (no-run fixture)', async () => {
  const { pmStatus } = await status()
  assert.equal(pmStatus(fixture('no-run')), 'planned')
})
test('pmStatus: planning fixture is active', async () => {
  const { pmStatus } = await status()
  assert.equal(pmStatus(fixture('planning')), 'active')
})
test('pmStatus: live fixture is active', async () => {
  const { pmStatus } = await status()
  assert.equal(pmStatus(fixture('live')), 'active')
})
test('pmStatus: real-12 fixture is active', async () => {
  const { pmStatus } = await status()
  assert.equal(pmStatus(fixture('real-12')), 'active')
})
test('pmStatus: session.status waiting is waiting', async () => {
  const { pmStatus } = await status()
  const s = clone(fixture('live'))
  s.session.status = 'waiting'
  assert.equal(pmStatus(s), 'waiting')
})
test('pmStatus: an open request is waiting', async () => {
  const { pmStatus } = await status()
  const s = clone(fixture('live'))
  s.requests = [{ id: 'q1', status: 'open', createdAt: '2026-11-02T12:00:00.000Z', answeredAt: null, cancelReason: null }]
  assert.equal(pmStatus(s), 'waiting')
})
test('pmStatus: all crews merged or dropped and the session idle is done', async () => {
  const { pmStatus } = await status()
  const s = clone(fixture('live'))
  s.run.crews.forEach((c: any, i: number) => { c.status = i % 2 ? 'dropped' : 'merged'; c.stuck = null })
  s.session.status = 'idle'
  assert.equal(pmStatus(s), 'done')
})
test('pmStatus: all crews merged but the session running is active', async () => {
  const { pmStatus } = await status()
  const s = clone(fixture('live'))
  s.run.crews.forEach((c: any) => { c.status = 'merged'; c.stuck = null })
  s.session.status = 'running'
  assert.equal(pmStatus(s), 'active')
})
test('pmStatus: an idle session with a transcript and no crews is not planned and not done', async () => {
  const { pmStatus } = await status()
  const s = clone(fixture('planning'))
  s.session.status = 'idle'
  const got = pmStatus(s)
  assert.notEqual(got, 'planned')
  assert.notEqual(got, 'done')
})

// ---- StatusBadge -----------------------------------------------------------------------------------------
const WORDS: [string, string][] = [['active', 'Active'], ['done', 'Done'], ['waiting', 'Waiting on you'], ['stuck', 'Stuck'], ['planned', 'Planned']]
/** The elements whose own text is exactly `word` and which hold an svg: word and icon in one element. */
const withIcon = (root: N, word: string) => [...walk(root)].filter((n) => n.tag !== 'svg' && tidy(text(n)) === word && [...walk(n)].some((x) => x.tag === 'svg'))
for (const [key, word] of WORDS) {
  test(`StatusBadge: ${key} renders "${word}" and an svg inside one element`, async () => {
    const root = await mount('StatusBadge', 'StatusBadge', { status: key })
    assert.ok(withIcon(root, word).length > 0, `an element holding exactly "${word}" and an svg; got: ${tidy(text(root))}`)
  })
  test(`StatusBadge: ${key} at size sm still renders "${word}" with its svg`, async () => {
    const root = await mount('StatusBadge', 'StatusBadge', { status: key, size: 'sm' })
    assert.ok(withIcon(root, word).length > 0, `sm badge for ${key}`)
  })
}
test('StatusBadge: each badge shows only its own status word', async () => {
  for (const [key, word] of WORDS) {
    const root = await mount('StatusBadge', 'StatusBadge', { status: key })
    const t = tidy(text(root))
    for (const [, other] of WORDS) if (other !== word) assert.ok(!t.includes(other), `${key} badge must not contain "${other}": ${t}`)
  }
})
test('StatusBadge: the five icons are not all the same drawing', async () => {
  const shapes = new Set<string>()
  for (const [key] of WORDS) {
    const root = await mount('StatusBadge', 'StatusBadge', { status: key })
    const svg = [...walk(root)].find((n) => n.tag === 'svg')
    assert.ok(svg, `${key} has an svg`)
    shapes.add(JSON.stringify([...walk(svg!)].map((n) => [n.tag, n.a.d, n.a.cx, n.a.cy, n.a.r])))
  }
  assert.ok(shapes.size > 1, 'status icons differ by status')
})

// ---- RunStatusBadge --------------------------------------------------------------------------------------
const RUN_WORDS: [string, string][] = [['not-started', 'Not started'], ['waiting', 'Waiting on you'], ['finished', 'Finished'], ['working', 'Working']]
for (const [key, word] of RUN_WORDS) {
  test(`RunStatusBadge: ${key} renders "${word}" and an svg inside one element`, async () => {
    const root = await mount('RunStatusBadge', 'RunStatusBadge', { status: key })
    assert.ok(withIcon(root, word).length > 0, `an element holding exactly "${word}" and an svg; got: ${tidy(text(root))}`)
  })
}
test('RunStatusBadge: each badge shows only its own run word', async () => {
  for (const [key, word] of RUN_WORDS) {
    const root = await mount('RunStatusBadge', 'RunStatusBadge', { status: key })
    const t = tidy(text(root))
    for (const [, other] of RUN_WORDS) if (other !== word) assert.ok(!t.includes(other), `${key} badge must not contain "${other}": ${t}`)
  }
})

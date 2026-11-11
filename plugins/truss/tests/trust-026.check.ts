// @ts-nocheck
// truss 0.26.0, crew trust: the acceptance test, written from the spec before any builder starts (goal file: Approved scope, PM rulings, case table).
// Inbox self-approve gap (ADR-0037), long-term cost guard fail-closed and trigger gaps (ADR-0034), escalate code recovery, stale running queue
// items (ADR-0040) and `inbox --unapplied --session`.
//
// Seams the builders implement (names fixed):
//  - bin/store.ts: proofTranscriptRoot() (os.userInfo().homedir + .claude/projects, no env) and readProofFile(p, opts?), the one proof read.
//  - bin/inbox.ts: type Item and verifiedItems(repo), the one verified fold behind fold/blockingFor/budgetRaises and guard.ts longTermItems.
//  - `factory inbox` rows: a reopened item carries reopened {reason, by, ts, decision}; a resolved row with an unbound note carries noteUnbound.
//  - `factory inbox --recover-codes --repo R` (no --dir) prints {codes: [{id, code, session}]}; the sidecar is <session dir>/escalate-code-<E-id>.json, 0600.
//  - `factory inbox --unapplied --session <sid>` keeps rows whose open session is <sid> and judges applied against <sid>.
// Tests override the proof root through fixtures/inbox/proof-plugin.ts (a private plugin copy), never through env in shipped code. Proof reads are
// counted through the same stub's READ_LOG. Not run on a Windows or macOS host: the darwin/win32 branches are only argued, not exercised.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { ltcCrewGate, ltcPlanGate, ltcTriggers } from '../bin/guard.ts'
import { sharedDir } from '../bin/store.ts'
import { proofPlugin } from './fixtures/inbox/proof-plugin.ts'
import { CHEAP, COSTLY, cli as ltcCli, designerResult, mkWorld, planWrite } from './fixtures/ltc/harness.ts'
import { REAL_PLUGIN, flat, head, highSampleFile, mkEnv, mkRepo, mkTrussDir, pluginCopy, putFile, runCli } from './fixtures/workflow-run/harness.ts'

const FIX = `${REAL_PLUGIN}/tests/fixtures/inbox`
const SLEEPER = `${FIX}/spawn-sleeper.ts`
const CONFIG = { architecture: 'docs/architecture.md', adr: 'docs/adr' }
const OLD_TS = '2020-01-01T00:00:00.000Z'

const temps: string[] = []
process.on('exit', () => {
  for (const t of temps) {
    try {
      rmSync(t, { recursive: true, force: true, maxRetries: 3 })
    } catch {}
  }
})
/** A fresh temp dir with symlinks resolved (macOS /var), forward slashes, removed at exit. */
function mk(prefix: string): string {
  const d = flat(realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix))))
  temps.push(d)
  return d
}
const say = (r: any): string => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 700)}; stderr ${String(r.stderr).slice(0, 300)}`
const iso = (ms: number): string => new Date(ms).toISOString()
const wait = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const msgOf = (e: any): string => String(e?.body?.error ?? e?.message ?? e)
const notifyCmd = (script: string, ...args: string[]): string => [process.execPath, script, ...args].map((a) => `"${flat(a)}"`).join(' ')

// ---------------------------------------------------------------------------------------------------------------
// the world: a temp git repo, a session dir <repo>/.git/truss/<sid>, a transcripts root the proof stub reads, the stubbed plugin

type W = { repo: string; common: string; inboxFile: string; sid: string; dir: string; troot: string; readLog: string }

function session(w: W, sid: string): string {
  const dir = `${w.common}/truss/${sid}`
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/events.jsonl`, '')
  writeFileSync(`${dir}/decisions.md`, '')
  return dir
}

function world(config: Record<string, unknown> = {}, files: Record<string, string> = {}): W {
  const repo = flat(realpathSync(mkRepo({ config: { ...CONFIG, ...config }, files })))
  const common = `${repo}/.git`
  const sid = `sess-${randomUUID().slice(0, 8)}`
  const w: W = { repo, common, inboxFile: `${common}/truss/shared/inbox.jsonl`, sid, dir: '', troot: mk('t26-tr-'), readLog: `${mk('t26-log-')}/reads.log` }
  w.dir = session(w, sid)
  return w
}

const proofFactory = (): string => `${proofPlugin()}/bin/factory.ts`
const proofEnv = (w: W): Record<string, string> => ({ TRUSS_TEST_PROOF_ROOT: w.troot, TRUSS_TEST_READ_LOG: w.readLog })

/** `factory <command> --repo R --dir D ...args` as a real process on the stubbed plugin; positionals go first in args. */
const run = (w: W, command: string, args: string[] = [], extraEnv: Record<string, string> = {}, dir = w.dir) =>
  runCli(proofFactory(), command, ['--repo', w.repo, '--dir', dir, ...args], w.repo, { ...proofEnv(w), ...extraEnv })

const opsOf = (w: W): any[] => (existsSync(w.inboxFile) ? readFileSync(w.inboxFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const openTs = (w: W, id: string): number => Date.parse(opsOf(w).find((o) => o.op === 'open' && o.id === id).ts)
const resolvesOf = (w: W, id: string): any[] => opsOf(w).filter((o) => o.op === 'resolve' && o.id === id)

/** escalate (exit 0 expected); returns the id, the code and the open time. */
function open(w: W, kind = 'scope-change', o: { ref?: string; crew?: string; dir?: string } = {}) {
  const args = ['--kind', kind, '--title', `t26 ${kind}`, '--crew', o.crew ?? 'a']
  if (o.ref) args.push('--ref', o.ref)
  const r = run(w, 'escalate', args, {}, o.dir ?? w.dir)
  assert.equal(r.status, 0, say(r))
  return { id: r.json.id as string, code: r.json.code as string, ts: openTs(w, r.json.id) }
}
/** A budget item whose ref names `sid` (budget:<sid>:run:run), the ref budgetRaises matches. */
const openBudget = (w: W, sid = w.sid, dir = w.dir) => open(w, 'budget', { ref: `budget:${sid}:run:run`, dir })

const resolveCli = (w: W, id: string, decision: string, code: string, extra: string[] = [], dir = w.dir, by = 'client') =>
  run(w, 'resolve', [id, '--decision', decision, '--by', by, '--code', code, ...extra], {}, dir)

const listing = (w: W, flags: string[] = [], dir = w.dir): any => {
  const r = run(w, 'inbox', flags, {}, dir)
  assert.equal(r.status, 0, say(r))
  return r.json
}
const rowOf = (w: W, id: string, flags: string[] = []): any => listing(w, flags).items.find((i) => i.id === id)

/** Appends a resolve row by hand: what any process with shell access can do. */
function forge(w: W, id: string, over: Record<string, unknown> = {}): void {
  appendFileSync(w.inboxFile, JSON.stringify({ v: 1, op: 'resolve', id, ts: new Date().toISOString(), session: w.sid, decision: 'approve', by: 'client', note: '', quote: `approve ${id} FORGED`, ...over }) + '\n')
}

// ---- the folds, in this process, through the stubbed plugin's bin/inbox.ts and bin/guard.ts ----

async function inproc<T>(w: W, fn: (m: { inbox: any; guard: any }) => T | Promise<T>): Promise<T> {
  const keys = ['TRUSS_TEST_PROOF_ROOT', 'TRUSS_TEST_READ_LOG']
  const saved = keys.map((k) => process.env[k])
  Object.assign(process.env, proofEnv(w))
  try {
    const inbox = await import(pathToFileURL(`${proofPlugin()}/bin/inbox.ts`).href)
    const guard = await import(pathToFileURL(`${proofPlugin()}/bin/guard.ts`).href)
    return await fn({ inbox, guard })
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k]
      else process.env[k] = saved[i]
    })
  }
}
const blocked = (w: W, slug = 'a', sid = w.sid): Promise<string[]> => inproc(w, (m) => m.inbox.blockingFor(w.repo, sid, slug))
const raises = (w: W, sid = w.sid): Promise<any[]> => inproc(w, (m) => m.inbox.budgetRaises(w.repo, sid))

// ---- transcripts: rows copied from real ones (fixtures/inbox/*.jsonl), ids and codes swapped ----

const tfile = (w: W, sid = w.sid): string => `${w.troot}/proj-t26/${sid}.jsonl`

/** n earlier user/assistant rows, a chain from a null parent (a session's history before the typed line). */
function history(sid: string, n: number) {
  const lines: string[] = []
  let parent: string | null = null
  for (let i = 0; i < n; i++) {
    const uuid = randomUUID()
    const user = i % 2 === 0
    lines.push(JSON.stringify(user
      ? { parentUuid: parent, isSidechain: false, type: 'user', message: { role: 'user', content: `earlier prompt ${i}` }, uuid, timestamp: OLD_TS, origin: { kind: 'human' }, promptSource: 'typed', turnOrigin: 'human', userType: 'external', sessionId: sid }
      : { parentUuid: parent, isSidechain: false, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, uuid, timestamp: OLD_TS, userType: 'external', sessionId: sid }))
    parent = uuid
  }
  return { lines, last: parent }
}

/** The rows of a fixture with the placeholders filled; `text` (when not null) replaces the typed text. */
function fixObjs(file: string, s: { id: string; code: string; ts: string; sid: string; parent: string | null; text: string | null }): any[] {
  return readFileSync(`${FIX}/${file}`, 'utf8').split('\n').filter(Boolean).map((l) => {
    let t = l
    if (s.text !== null) t = t.replaceAll('approve E-ID CODE go ahead', JSON.stringify(s.text).slice(1, -1))
    t = t.replaceAll('E-ID', s.id).replaceAll('CODE', s.code).replaceAll('__TS__', s.ts).replaceAll('__SID__', s.sid).replaceAll('__PARENT__', String(s.parent)).replaceAll('__UUID__', randomUUID())
    return JSON.parse(t)
  })
}

const lastUuid = (p: string): string => JSON.parse(readFileSync(p, 'utf8').split('\n').filter(Boolean).pop()).uuid

/**
 * The client types a line in a session: history, then the fixture row (default a plain typed prompt `approve <id> <code>`), a second after the open.
 * o: file, text (null keeps the fixture's `approve E-ID CODE go ahead`), hist (earlier rows), plusMs, sid, append (add to the session's file), mutate(row).
 */
function put(w: W, id: string, code: string, o: any = {}): string {
  const sid = o.sid ?? w.sid
  const p = tfile(w, sid)
  let lines: string[] = []
  let parent: string | null
  if (o.append && existsSync(p)) parent = lastUuid(p)
  else {
    const h = history(sid, o.hist ?? 2)
    lines = h.lines
    parent = h.last
  }
  let rows = fixObjs(o.file ?? 'typed-prompt.jsonl', { id, code, ts: iso(openTs(w, id) + (o.plusMs ?? 1000)), sid, parent, text: 'text' in o ? o.text : `approve ${id} ${code}` })
  if (o.mutate) rows = rows.map((r) => (r.type === 'user' ? o.mutate(r) : r))
  mkdirSync(path.dirname(p), { recursive: true })
  const body = [...lines, ...rows.map((r) => JSON.stringify(r))].join('\n') + '\n'
  if (o.append && existsSync(p)) appendFileSync(p, body)
  else writeFileSync(p, body)
  return p
}

/** A main transcript of about `bytes` bytes (filler user and assistant rows, ~3 KB each, none holding an item id); returns the last uuid. */
function writeBig(file: string, sid: string, bytes: number): string {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, '')
  const pad = 'x'.repeat(3000)
  let parent: string | null = null
  let size = 0
  let buf: string[] = []
  for (let i = 0; size < bytes; i++) {
    const uuid = randomUUID()
    const row = i % 2 === 0
      ? { parentUuid: parent, isSidechain: false, type: 'user', message: { role: 'user', content: i === 0 ? 'hello' : [{ type: 'tool_result', tool_use_id: 'toolu_x', content: pad }] }, uuid, timestamp: OLD_TS, sessionId: sid, userType: 'external', ...(i === 0 ? { origin: { kind: 'human' }, promptSource: 'typed', turnOrigin: 'human' } : {}) }
      : { parentUuid: parent, isSidechain: false, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: pad }] }, uuid, timestamp: OLD_TS, sessionId: sid, userType: 'external' }
    const line = JSON.stringify(row) + '\n'
    buf.push(line)
    size += line.length
    parent = uuid
    if (buf.length >= 1000) {
      appendFileSync(file, buf.join(''))
      buf = []
    }
  }
  appendFileSync(file, buf.join(''))
  return parent as string
}
const appendTyped = (w: W, p: string, parent: string, sid: string, id: string, code: string, text: string, plusMs = 1000): void =>
  appendFileSync(p, fixObjs('typed-prompt.jsonl', { id, code, ts: iso(openTs(w, id) + plusMs), sid, parent, text }).map((r) => JSON.stringify(r)).join('\n') + '\n')

const readsOf = (w: W): string[] => (existsSync(w.readLog) ? readFileSync(w.readLog, 'utf8').split('\n').filter(Boolean) : [])

// ---------------------------------------------------------------------------------------------------------------
// item 1: a resolve row counts only with verified client proof

test('trust-026: a forged resolve row leaves the item blocking', async () => {
  const w = world()
  const a = open(w)
  assert.deepEqual(await blocked(w), [a.id], 'the open item blocks its crew')
  forge(w, a.id) // by client, an invented quote, no transcript at all
  assert.deepEqual(await blocked(w), [a.id], 'a client row with no transcript proof does not lift the block')
  assert.equal(rowOf(w, a.id).state, 'open', 'the listing keeps the item open')
  const b = open(w)
  forge(w, b.id, { by: 'pm' }) // scope-change is resolved by the client, not by pm
  assert.deepEqual((await blocked(w)).sort(), [a.id, b.id].sort())
  const c = open(w)
  put(w, c.id, c.code, { text: 'a different prompt that holds no decision' }) // a transcript exists but holds no such line
  forge(w, c.id, { quote: `approve ${c.id} ${c.code}` })
  assert.ok((await blocked(w)).includes(c.id), 'a quote that no transcript line backs does not count')
  assert.equal(rowOf(w, c.id).state, 'open')
})

test('trust-026: a forged resolve row does not stop the real client resolve', async () => {
  const w = world()
  const a = open(w)
  forge(w, a.id, { decision: 'reject' })
  put(w, a.id, a.code)
  const r = resolveCli(w, a.id, 'approve', a.code)
  assert.equal(r.status, 0, `the forged row must not make the item "already resolved": ${say(r)}`)
  assert.deepEqual(await blocked(w), [], 'the real resolve lifts the block')
  const row = rowOf(w, a.id)
  assert.equal(row.state, 'resolved')
  assert.equal(row.decision, 'approve', 'the first verified row wins, not the forged reject before it')
  assert.match(String(row.quote), new RegExp(`approve ${a.id}`))
})

test('trust-026: a budget raise from an unverified resolve row is not counted', async () => {
  const w = world()
  const a = openBudget(w)
  forge(w, a.id, { raiseUsd: 1000 })
  assert.deepEqual(await raises(w), [], 'a forged raise is not a raise')
  assert.deepEqual(await blocked(w), [a.id])
  put(w, a.id, a.code, { text: `approve ${a.id} ${a.code} raise 5` })
  const r = resolveCli(w, a.id, 'approve', a.code, ['--raise-usd', '5'])
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(await raises(w), [{ ref: `budget:${w.sid}:run:run`, raiseUsd: 5 }], 'only the typed 5 counts, not the forged 1000')
})

test('trust-026: a long-term cost item with a forged approve stays open in the guard', async () => {
  const w = world()
  const a = open(w, 'long-term-cost', { ref: 'ltc:t26:plan:1:abc' })
  writeFileSync(`${w.dir}/ltc-plan.json`, JSON.stringify({ rev: 'r1', ids: [a.id] }))
  forge(w, a.id)
  const gate = await inproc(w, (m) => m.guard.ltcPlanGate(w.repo, w.dir))
  assert.deepEqual(gate, [a.id], 'the plan gate still holds the item')
  // the crew gate: the item of the ref its QC line maps to carries a forged approve
  const what = 'x'
  const c = open(w, 'long-term-cost', { ref: `ltc:${w.sid}:a:${createHash('sha256').update(what).digest('hex').slice(0, 12)}` })
  forge(w, c.id)
  const crew = await inproc(w, (m) => m.guard.ltcCrewGate(w.repo, w.dir, 'a', { qcText: `LONG-TERM-COST: ${what} | later: y | reversal: costly`, base: 'HEAD', head: 'HEAD' }))
  assert.match(String(crew.refused), new RegExp(c.id), 'a crew gate with a forged approve stays refused')
})

test('trust-026: a pm resolve of a kind that allows any still lifts the block', async () => {
  // regression guard: green before the build too; the verified fold must keep the by:any kinds working
  const w = world()
  const a = open(w, 'blocked')
  assert.deepEqual(await blocked(w), [a.id])
  const r = resolveCli(w, a.id, 'dismiss', a.code, [], w.dir, 'pm')
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(await blocked(w), [])
})

test('trust-026: a proof replayed from another item is refused', async () => {
  const w = world()
  const a = open(w)
  const b = open(w)
  put(w, a.id, a.code)
  const wrong = resolveCli(w, b.id, 'approve', a.code)
  assert.equal(wrong.status, 1, say(wrong))
  const noLine = resolveCli(w, b.id, 'approve', b.code)
  assert.equal(noLine.status, 1, `the typed line names item A, not B: ${say(noLine)}`)
  assert.equal(resolvesOf(w, b.id).length, 0)
  forge(w, b.id, { quote: `approve ${a.id} ${a.code}` }) // A's genuine quote glued onto B's row
  assert.ok((await blocked(w)).includes(b.id), 'B stays blocking beside A\'s genuine proof')
  assert.equal(rowOf(w, b.id).state, 'open')
})

test('trust-026: a typed line from another repo does not prove a resolve here', async () => {
  const other = realpathSync(mkdtempSync(path.join(os.tmpdir(), 't26-other-')))
  assert.equal(spawnSync('git', ['init', '-q', other], { windowsHide: true }).status, 0, 'a real foreign repo')
  const w = world()
  const a = open(w)
  const p = put(w, a.id, a.code, { mutate: (r) => ({ ...r, cwd: other }) })
  const r = resolveCli(w, a.id, 'approve', a.code)
  assert.equal(r.status, 1, `the typed line ran in another repo: ${say(r)}`)
  forge(w, a.id, { quote: `approve ${a.id} ${a.code}` }) // the same row folded from inbox.jsonl
  assert.ok((await blocked(w)).includes(a.id), 'a foreign cwd leaves the item blocking')
  assert.equal(rowOf(w, a.id).state, 'open')
  // control: the same line with a cwd in a worktree under this repo proves it
  const b = open(w)
  put(w, b.id, b.code, { sid: w.sid, mutate: (r) => ({ ...r, cwd: `${w.repo}/.claude/worktrees/x` }) })
  const ok = resolveCli(w, b.id, 'approve', b.code)
  assert.equal(ok.status, 0, `a cwd under the repo is its own: ${say(ok)}`)
  assert.deepEqual(await blocked(w), [a.id])
  rmSync(other, { recursive: true, force: true })
})

test('trust-026: a row without raiseUsd cannot stand for a typed raise', async () => {
  const w = world()
  const a = openBudget(w)
  put(w, a.id, a.code, { text: `approve ${a.id} ${a.code} raise 5` })
  forge(w, a.id, { quote: `approve ${a.id} ${a.code}` }) // a prefix of the typed raise line, no raiseUsd
  assert.deepEqual(await blocked(w), [a.id], 'the typed raise is not dropped by a forged plain approve')
  assert.equal(rowOf(w, a.id).state, 'open')
  assert.deepEqual(await raises(w), [])
  const r = resolveCli(w, a.id, 'approve', a.code) // the agent resolves without the amount
  assert.equal(r.status, 1, `a typed raise needs --raise-usd: ${say(r)}`)
  assert.equal(resolveCli(w, a.id, 'approve', a.code, ['--raise-usd', '5']).status, 0)
  assert.deepEqual(await raises(w), [{ ref: `budget:${w.sid}:run:run`, raiseUsd: 5 }])
})

// note binding

/** One resolve attempt on a fresh item: the client typed `approve <id> <code>[ raise <usd>][ <tail>]`; the agent passes the note by --note or --note-file. */
function noteCase(o: { raise?: number; tail?: string; note?: string; noteFile?: boolean }) {
  const w = world()
  const a = o.raise === undefined ? open(w) : openBudget(w)
  put(w, a.id, a.code, { text: `approve ${a.id} ${a.code}${o.raise === undefined ? '' : ` raise ${o.raise}`}${o.tail ? ` ${o.tail}` : ''}` })
  const extra: string[] = o.raise === undefined ? [] : ['--raise-usd', String(o.raise)]
  if (o.note !== undefined) {
    if (o.noteFile) {
      const f = `${w.dir}/inbox-note-${a.id}.txt`
      writeFileSync(f, o.note + (o.note === '' ? '' : '\n'))
      extra.push('--note-file', f)
    } else extra.push('--note', o.note)
  }
  const r = resolveCli(w, a.id, 'approve', a.code, extra)
  return { w, a, r }
}
const refusedNote = (c: { w: W; a: any; r: any }): void => {
  assert.equal(c.r.status, 1, say(c.r))
  assert.match(String(c.r.json?.error), /note/i, say(c.r))
  assert.equal(resolvesOf(c.w, c.a.id).length, 0, 'a refused resolve appends no row')
}
const acceptedNote = (c: { w: W; a: any; r: any }): void => {
  assert.equal(c.r.status, 0, say(c.r))
  assert.equal(resolvesOf(c.w, c.a.id).length, 1)
}

test('trust-026: a note that differs from the typed text is refused', async () => {
  const bad = noteCase({ tail: 'go ahead', note: 'something else' })
  refusedNote(bad)
  assert.deepEqual(await blocked(bad.w), [bad.a.id], 'the item still blocks')
  acceptedNote(noteCase({ tail: 'go ahead', note: 'go ahead' }))
})

test('trust-026: a multi-word note differing from the typed text is refused through --note and --note-file', () => {
  const typed = 'ship it on friday after the freeze'
  refusedNote(noteCase({ tail: typed, note: 'ship it on monday after the freeze' }))
  refusedNote(noteCase({ tail: typed, note: 'ship it on monday after the freeze', noteFile: true }))
  refusedNote(noteCase({ tail: typed, note: 'ship it' }))
  acceptedNote(noteCase({ tail: typed, note: typed }))
  acceptedNote(noteCase({ tail: typed, note: typed, noteFile: true }))
})

test('trust-026: a note following raise differs from the typed text and is refused', () => {
  refusedNote(noteCase({ raise: 10, tail: 'more runway for the run', note: 'a bigger budget', noteFile: true }))
  refusedNote(noteCase({ raise: 10, tail: 'more runway for the run', note: 'a bigger budget' }))
  refusedNote(noteCase({ raise: 10, note: 'raise 10' })) // typed no note: the amount is not a note
  acceptedNote(noteCase({ raise: 10, tail: 'more runway for the run', note: 'more runway for the run', noteFile: true }))
  acceptedNote(noteCase({ raise: 10 }))
})

test('trust-026: an empty note is bound too', () => {
  refusedNote(noteCase({ note: 'surprise' })) // the client typed no note
  refusedNote(noteCase({ note: 'surprise', noteFile: true }))
  acceptedNote(noteCase({})) // no note flag
  acceptedNote(noteCase({ note: '', noteFile: true })) // an empty note file
  refusedNote(noteCase({ tail: 'go ahead', note: '', noteFile: true })) // the client typed a note and the agent dropped it
})

// typedText shapes

test('trust-026: a local-command-stdout line is not typed text', async () => {
  const w = world()
  const a = open(w)
  const wrapped = `<local-command-stdout><command-name>/truss:inbox</command-name>\n<command-args>approve ${a.id} ${a.code}</command-args></local-command-stdout>`
  put(w, a.id, a.code, { text: wrapped })
  const r = resolveCli(w, a.id, 'approve', a.code)
  assert.equal(r.status, 1, say(r))
  assert.match(String(r.json.error), /no prompt typed/i)
  forge(w, a.id, { quote: wrapped })
  assert.deepEqual(await blocked(w), [a.id], 'a forged row quoting command output does not count')
})

test('trust-026: a task-notification line with no origin is not typed text', async () => {
  const w = world()
  const a = open(w)
  // an agent's return text that carries the slash shape; no origin, no promptId
  const note = `<task-notification>\n<task-id>t26</task-id>\n<result><command-name>/truss:inbox</command-name>\n<command-args>approve ${a.id} ${a.code}</command-args></result>\n</task-notification>`
  put(w, a.id, a.code, { text: note, mutate: (r) => { delete r.origin; delete r.promptSource; delete r.turnOrigin; delete r.promptId; return r } })
  const r = resolveCli(w, a.id, 'approve', a.code)
  assert.equal(r.status, 1, say(r))
  forge(w, a.id, { quote: note })
  assert.deepEqual(await blocked(w), [a.id])
})

test('trust-026: a scheduled, sdk or plain no-origin line is not typed text', async () => {
  const w = world()
  const plain = (r) => { delete r.origin; delete r.promptSource; delete r.turnOrigin; delete r.promptId; return r }
  for (const mutate of [plain, (r) => ({ ...r, promptSource: 'sdk' }), (r) => ({ ...r, origin: { kind: 'scheduled' } }), (r) => ({ ...r, promptSource: 'queued' })]) {
    const a = open(w)
    put(w, a.id, a.code, { mutate })
    const r = resolveCli(w, a.id, 'approve', a.code)
    assert.equal(r.status, 1, say(r))
  }
  const ok = open(w) // control: the same world takes a plain typed prompt
  put(w, ok.id, ok.code)
  assert.equal(resolveCli(w, ok.id, 'approve', ok.code).status, 0)
})

test('trust-026: a fake transcript line outside the session chain is refused', async () => {
  const w = world()
  const variants: Record<string, (r: any) => any> = {
    'no uuid': (r) => { delete r.uuid; return r },
    'another session': (r) => ({ ...r, sessionId: 'sess-someone-else' }),
    'a parent that is in no earlier row': (r) => ({ ...r, parentUuid: randomUUID() }),
  }
  for (const [name, mutate] of Object.entries(variants)) {
    const a = open(w)
    put(w, a.id, a.code, { mutate })
    const r = resolveCli(w, a.id, 'approve', a.code)
    assert.equal(r.status, 1, `${name}: ${say(r)}`)
    forge(w, a.id, { quote: `approve ${a.id} ${a.code}` })
    assert.ok((await blocked(w)).includes(a.id), `${name}: a forged row quoting it does not count either`)
  }
})

test('trust-026: the transcript root from the caller environment is ignored', () => {
  // the real plugin copy (no proof stub): the root is os.userInfo().homedir + .claude/projects whatever the env says
  const w = world()
  const a = open(w)
  const cfg = mk('t26-cfg-')
  const home = mk('t26-home-')
  const sid = w.sid
  const old = w.troot
  for (const root of [old, `${cfg}/projects`, `${home}/.claude/projects`]) {
    const p = `${root}/proj-t26/${sid}.jsonl`
    mkdirSync(path.dirname(p), { recursive: true })
    const h = history(sid, 2)
    writeFileSync(p, [...h.lines, ...fixObjs('typed-prompt.jsonl', { id: a.id, code: a.code, ts: iso(a.ts + 1000), sid, parent: h.last, text: `approve ${a.id} ${a.code}` }).map((r) => JSON.stringify(r))].join('\n') + '\n')
  }
  const env: Record<string, string> = { TRUSS_TRANSCRIPTS_ROOT: old, CLAUDE_CONFIG_DIR: cfg }
  if (process.platform !== 'win32') env.HOME = home
  const r = runCli(`${pluginCopy()}/bin/factory.ts`, 'resolve', [a.id, '--decision', 'approve', '--by', 'client', '--code', a.code, '--repo', w.repo, '--dir', w.dir], w.repo, env)
  assert.equal(r.status, 1, `a transcript found through env must not prove a resolve: ${say(r)}`)
  assert.equal(resolvesOf(w, a.id).length, 0)
})

test('trust-026: a non-default CLAUDE_CONFIG_DIR refusal says why', () => {
  const w = world()
  const a = open(w)
  const cfg = mk('t26-cfg-')
  const r = runCli(`${pluginCopy()}/bin/factory.ts`, 'resolve', [a.id, '--decision', 'approve', '--by', 'client', '--code', a.code, '--repo', w.repo, '--dir', w.dir], w.repo, { CLAUDE_CONFIG_DIR: cfg })
  assert.equal(r.status, 1, say(r))
  const root = flat(path.join(os.userInfo().homedir, '.claude', 'projects'))
  assert.match(String(r.json.error), /CLAUDE_CONFIG_DIR/, 'the refusal names the setting')
  assert.ok(flat(String(r.json.error)).includes(root), `the refusal names the root it looked in (${root}): ${r.json.error}`)
})

test('trust-026: the no typed prompt refusal tells the client what to type as a plain prompt', () => {
  const w = world()
  const a = open(w)
  const r = resolveCli(w, a.id, 'approve', a.code)
  assert.equal(r.status, 1, say(r))
  assert.match(String(r.json.error), /plain prompt/i, say(r))
  assert.ok(String(r.json.error).includes(`approve ${a.id} <code>`), `the exact line to type: ${r.json.error}`)
  const b = openBudget(w)
  const rb = resolveCli(w, b.id, 'approve', b.code, ['--raise-usd', '10'])
  assert.equal(rb.status, 1, say(rb))
  assert.match(String(rb.json.error), /plain prompt/i)
  assert.ok(String(rb.json.error).includes(`approve ${b.id} <code> raise 10`), `a raise names the amount: ${rb.json.error}`)
})

// the three real shapes and the first prompt

async function liftCase(file: string, o: any = {}) {
  const w = world()
  const a = open(w)
  assert.deepEqual(await blocked(w), [a.id])
  put(w, a.id, a.code, { file, text: null, ...o })
  const r = resolveCli(w, a.id, 'approve', a.code, ['--note', 'go ahead'])
  assert.equal(r.status, 0, say(r))
  writeFileSync(w.readLog, '')
  assert.deepEqual(await blocked(w), [], 'the verified resolve lifts the block')
  assert.deepEqual(readsOf(w), [flat(tfile(w))], 'the fold re-proves the row against the transcript at read time, through readProofFile')
  const row = rowOf(w, a.id)
  assert.equal(row.state, 'resolved')
  assert.match(String(row.quote), new RegExp(`approve ${a.id}`))
  assert.notEqual(row.noteUnbound, true)
}

test('trust-026: a slash resolve with origin human and no promptSource lifts the block', () => liftCase('slash-origin-human.jsonl'))
test('trust-026: a slash resolve with no origin and no promptId lifts the block', () => liftCase('slash-no-origin.jsonl'))
test('trust-026: a plain typed resolve prompt lifts the block', () => liftCase('typed-prompt.jsonl'))
test('trust-026: a resolve typed as the first prompt of a fresh session verifies', () => liftCase('first-prompt.jsonl', { hist: 0 }))

test('trust-026: a null parentUuid after an earlier user or assistant row is refused', async () => {
  const w = world()
  for (const hist of [1, 2]) {
    // hist 1 ends on a user row, hist 2 on an assistant row; the fresh-session layout is appended after it
    const a = open(w)
    put(w, a.id, a.code, { file: 'first-prompt.jsonl', hist, text: `approve ${a.id} ${a.code}` })
    const r = resolveCli(w, a.id, 'approve', a.code)
    assert.equal(r.status, 1, `history of ${hist} row(s): ${say(r)}`)
    forge(w, a.id)
    assert.ok((await blocked(w)).includes(a.id))
  }
})

test('trust-026: a 0.25.0 shape resolve row with a good proof still counts', async () => {
  const w = world()
  const a = openBudget(w)
  put(w, a.id, a.code, { text: `approve ${a.id} ${a.code} raise 7 the real note` })
  // the row shape of 0.25.0 (inbox.ts resolveItem): its note does not match the typed text
  appendFileSync(w.inboxFile, JSON.stringify({ v: 1, op: 'resolve', id: a.id, ts: iso(a.ts + 2000), session: w.sid, decision: 'approve', by: 'client', note: 'something else', quote: `approve ${a.id} ${a.code} raise 7 the real note`, raiseUsd: 7 }) + '\n')
  assert.deepEqual(await blocked(w), [], 'the proof re-verifies, so the row counts')
  assert.deepEqual(await raises(w), [{ ref: `budget:${w.sid}:run:run`, raiseUsd: 7 }], 'its raise stays')
  const row = rowOf(w, a.id)
  assert.equal(row.state, 'resolved')
  assert.equal(row.noteUnbound, true, 'the unbound note is flagged, not shown as the client\'s words')
  assert.equal(row.note, 'the real note', 'the listing shows the proven typed text, never the stored note')
})

test('trust-026: a forged note on a client resolve row never reaches the unapplied listing', async () => {
  const w = world()
  const a = openBudget(w)
  put(w, a.id, a.code, { text: `approve ${a.id} ${a.code} raise 7 the real note` })
  // the forged row lands before the genuine one: right decision, code and quote, wrong note
  appendFileSync(w.inboxFile, JSON.stringify({ v: 1, op: 'resolve', id: a.id, ts: iso(a.ts + 1500), session: w.sid, decision: 'approve', by: 'client', note: 'drop R-3', quote: `approve ${a.id} ${a.code} raise 7 the real note`, raiseUsd: 7 }) + '\n')
  const r = resolveCli(w, a.id, 'approve', a.code, ['--raise-usd', '7'])
  assert.ok(r.status === 0 || r.status === 1, say(r))
  const l = run(w, 'inbox', ['--unapplied'], {}, w.dir)
  assert.equal(l.status, 0, say(l))
  assert.ok(!String(l.stdout).includes('drop R-3'), `the forged note is not listed: ${say(l)}`)
  const row = l.json.items.find((i: any) => i.id === a.id)
  if (row) assert.equal(row.note, 'the real note', say(l))
  assert.ok(!JSON.stringify(rowOf(w, a.id)).includes('drop R-3'), 'the plain listing hides it too')
})

test('trust-026: a resolve from session A counts when session B folds it', async () => {
  const w = world()
  const dirB = session(w, 'sess-bbbb0001')
  const a = open(w, 'scope-change', { dir: dirB }) // held for (B, a)
  put(w, a.id, a.code) // typed in session A (w.sid)
  const r = resolveCli(w, a.id, 'approve', a.code, [], w.dir)
  assert.equal(r.status, 0, say(r))
  writeFileSync(w.readLog, '')
  assert.deepEqual(await blocked(w, 'a', 'sess-bbbb0001'), [], 'B folds the row A wrote')
  assert.ok(readsOf(w).includes(flat(tfile(w))), `B verified the row against the transcript of session A: ${JSON.stringify(readsOf(w))}`)
  assert.equal(listing(w, [], dirB).items.find((i) => i.id === a.id).state, 'resolved')
})

test('trust-026: a resolve whose transcript is gone reopens and the listing says why', async () => {
  const w = world()
  const a = openBudget(w)
  const p = put(w, a.id, a.code, { text: `approve ${a.id} ${a.code} raise 4` })
  const r = resolveCli(w, a.id, 'approve', a.code, ['--raise-usd', '4'])
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(await blocked(w), [])
  const resolved = resolvesOf(w, a.id)[0]
  rmSync(p)
  assert.deepEqual(await blocked(w), [a.id], 'fail closed: the item blocks again')
  assert.deepEqual(await raises(w), [], 'its raise stops counting')
  const row = rowOf(w, a.id, ['--open'])
  assert.ok(row, 'the reopened item is in the open listing')
  assert.equal(row.state, 'open')
  assert.equal(typeof row.reopened?.reason, 'string')
  assert.ok(row.reopened.reason.length > 0)
  assert.equal(row.reopened.by, 'client')
  assert.equal(row.reopened.ts, resolved.ts)
  assert.equal(row.reopened.decision, 'approve')
})

// tampering beside a genuine typed row for the same id (PO 2)

async function tamper(typed: (a: any) => string, row: Record<string, unknown>, plusMs = 1000) {
  const w = world()
  const a = openBudget(w)
  put(w, a.id, a.code, { text: typed(a), plusMs })
  forge(w, a.id, { decision: 'approve', raiseUsd: 10, quote: typed(a), ...row })
  assert.deepEqual(await blocked(w), [a.id], 'blockingFor still holds the item')
  assert.deepEqual(await raises(w), [], 'no raise counts')
  assert.equal(rowOf(w, a.id).state, 'open')
}
test('trust-026: a row that says approve beside a genuine reject typed line stays blocking', () => tamper((a) => `reject ${a.id} ${a.code}`, { decision: 'approve' }))
test('trust-026: a row that raises 1000 beside a genuine raise 10 typed line stays blocking', () => tamper((a) => `approve ${a.id} ${a.code} raise 10`, { raiseUsd: 1000 }))
test('trust-026: a row beside a typed line older than the open stays blocking', () => tamper((a) => `approve ${a.id} ${a.code} raise 10`, {}, -5000))
test('trust-026: a row beside a typed line with a wrong code stays blocking', () => tamper((a) => `approve ${a.id} ZZZZZZ raise 10`, {}))

// cost of the fold

test('trust-026: an admit over a 100 MB transcript stays within 2000 ms and reads it once', async () => {
  const w = world()
  const a = open(w, 'long-term-cost', { ref: 'ltc:t26:plan:1:big' })
  const b = openBudget(w)
  const p = tfile(w)
  const last = writeBig(p, w.sid, 100 * 1024 * 1024)
  assert.ok(statSync(p).size >= 100 * 1024 * 1024)
  appendTyped(w, p, last, w.sid, a.id, a.code, `approve ${a.id} ${a.code}`)
  appendTyped(w, p, last, w.sid, b.id, b.code, `approve ${b.id} ${b.code} raise 3`, 1500)
  assert.equal(resolveCli(w, a.id, 'approve', a.code).status, 0)
  assert.equal(resolveCli(w, b.id, 'approve', b.code, ['--raise-usd', '3']).status, 0)
  writeFileSync(`${w.dir}/ltc-plan.json`, JSON.stringify({ rev: 'r1', ids: [a.id] }))
  writeFileSync(w.readLog, '')
  const t = await inproc(w, async (m) => {
    const t0 = performance.now()
    const held = m.inbox.blockingFor(w.repo, w.sid, 'a')
    const rs = m.inbox.budgetRaises(w.repo, w.sid)
    const gate = m.guard.ltcPlanGate(w.repo, w.dir) // longTermItems
    const ms = performance.now() - t0
    assert.deepEqual(held, [])
    assert.deepEqual(rs, [{ ref: `budget:${w.sid}:run:run`, raiseUsd: 3 }])
    assert.deepEqual(gate, [])
    return ms
  })
  const reads = readsOf(w).filter((x) => x === flat(p))
  assert.equal(reads.length, 1, `the 100 MB transcript is read once per process: ${JSON.stringify(readsOf(w))}`)
  assert.ok(t <= 2000, `one admit took ${Math.round(t)} ms, the limit is 2000 ms`)
})

test('trust-026: an admit over 20 resolved items in 5 session transcripts reads each file once within 2000 ms', async () => {
  const w = world()
  const SESSIONS = 5
  const PER = 4
  const sids: string[] = []
  const ltc: string[] = []
  for (let s = 0; s < SESSIONS; s++) {
    const sid = `sess-hist${s}`
    const dir = session(w, sid)
    sids.push(sid)
    const items = Array.from({ length: PER }, (_, k) => (s === 0 && k === 0 ? open(w, 'long-term-cost', { dir, ref: `ltc:t26:plan:1:h${k}` }) : open(w, 'scope-change', { dir })))
    if (s === 0) ltc.push(items[0].id)
    const p = tfile(w, sid)
    let parent = writeBig(p, sid, 4 * 1024 * 1024) // a session's history, 4 MB
    items.forEach((it, k) => {
      appendTyped(w, p, parent, sid, it.id, it.code, `approve ${it.id} ${it.code}`, 1000 + k)
      parent = lastUuid(p)
    })
    for (const it of items) assert.equal(resolveCli(w, it.id, 'approve', it.code, [], dir).status, 0)
  }
  assert.equal(opsOf(w).filter((o) => o.op === 'resolve').length, SESSIONS * PER)
  writeFileSync(`${w.dir}/ltc-plan.json`, JSON.stringify({ rev: 'r1', ids: ltc }))
  writeFileSync(w.readLog, '')
  const ms = await inproc(w, async (m) => {
    const t0 = performance.now()
    for (const sid of sids) {
      assert.deepEqual(m.inbox.blockingFor(w.repo, sid, 'a'), [])
      assert.deepEqual(m.inbox.budgetRaises(w.repo, sid), [])
    }
    assert.deepEqual(m.guard.ltcPlanGate(w.repo, w.dir), [])
    return performance.now() - t0
  })
  const counts = new Map<string, number>()
  for (const r of readsOf(w)) counts.set(r, (counts.get(r) ?? 0) + 1)
  assert.deepEqual([...counts.keys()].sort(), sids.map((s) => flat(tfile(w, s))).sort(), 'every session transcript is read, and only those')
  for (const [f, n] of counts) assert.equal(n, 1, `${f} was read ${n} times`)
  assert.ok(ms <= 2000, `the admit took ${Math.round(ms)} ms, the limit is 2000 ms`)
})

// ADR and skill text

test('trust-026: ADR-0037 carries the dated amendment with the residual risk', () => {
  const adr = readFileSync(`${REAL_PLUGIN}/docs/adr/0037-shared-store-and-inbox.md`, 'utf8')
  const m = /^#{2,4} [^\n]*amendment[^\n]*\b2026-\d{2}-\d{2}\b[^\n]*$/im.exec(adr)
  assert.ok(m, 'a heading "Amendment ... <date>"')
  const body = adr.slice(m.index)
  assert.match(body, /same OS user/i, 'the residual: a same-user process can write a transcript line that passes')
  assert.match(body, /(rotat|delet)[^.\n]*transcript|transcript[^.\n]*(rotat|delet)/i, 'the residual: a deleted or rotated transcript makes the item block again')
  assert.match(body, /fail(s)? closed|blocks again/i)
  assert.match(body, /0\.25\.0|pre-0\.26/i, 'the ruling on pre-0.26 rows')
  assert.match(body, /grandfather/i, 'rows are not grandfathered by a version or a date')
  assert.match(body, /CLAUDE_CONFIG_DIR/, 'a non-default config dir fails closed')
  assert.match(body, /proofTranscriptRoot/)
  assert.match(body, /(grows|growth|linear|per transcript|with (the )?history)/i, 'how the fold cost grows with history')
  assert.match(body, /100 MB/)
  assert.doesNotMatch(adr, /found by `transcriptsOf\(sid\)` under `\$TRUSS_TRANSCRIPTS_ROOT`/, 'the old transcript root sentence (:126) is corrected')
})

test('trust-026: the inbox skill limits --recover-codes to a lost code and keeps the typed-code rule', () => {
  const s = readFileSync(`${REAL_PLUGIN}/skills/inbox/SKILL.md`, 'utf8')
  assert.ok(s.includes('--recover-codes'), 'the skill names --recover-codes')
  const at = s.indexOf('--recover-codes')
  const near = s.slice(Math.max(0, at - 600), at + 600)
  assert.match(near, /lost/i, 'it applies to an item whose code was lost')
  assert.match(near, /(asks?|asked|asking)\b/i, 'only when the client asks about it')
  assert.match(s, /(never|do not|don't)[^.\n]*resolve[^.\n]*recovered[^.\n]*(typed|types)|(never|do not|don't)[^.\n]*recovered code[^.\n]*(typed|types)/i, 'still forbids resolving with a recovered code the client has not typed')
  assert.doesNotMatch(s, /Never run a command to find a code\./, 'the blanket ban is softened for that one case')
})

// ---------------------------------------------------------------------------------------------------------------
// item 2 and 3: the long-term cost guard

const gitIn = (cwd: string, args: string[], o: { input?: string; env?: Record<string, string> } = {}) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', input: o.input, env: { ...process.env, ...(o.env ?? {}) }, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
/** A commit on top of HEAD holding `paths` (each a one-line file), made from tree entries so a name may hold a tab or a quote on any OS; returns [base, head]. */
function commitEntries(repo: string, paths: string[]): [string, string] {
  const base = head(repo)
  const blob = gitIn(repo, ['hash-object', '-w', '--stdin'], { input: 'x\n' })
  const env = { GIT_INDEX_FILE: `${mk('t26-idx-')}/index` }
  gitIn(repo, ['read-tree', base], { env })
  gitIn(repo, ['update-index', '--add', '-z', '--index-info'], { env, input: paths.map((p) => `100644 ${blob}\t${p}\0`).join('') })
  const tree = gitIn(repo, ['write-tree'], { env })
  return [base, gitIn(repo, ['commit-tree', tree, '-p', base, '-m', 'entries'])]
}

test('trust-026: a failing git diff refuses the merge gate', () => {
  const w = world()
  let r: any
  assert.doesNotThrow(() => {
    r = ltcCrewGate(w.repo, w.dir, 'a', { qcText: null, base: 'refs/heads/no-such-base', head: 'refs/heads/main' })
  }, 'factory.ts calls the gate with no try: it must return a refusal, not throw')
  assert.equal(typeof r?.refused, 'string', `a failed git diff must not read as "no triggers": ${JSON.stringify(r)}`)
  assert.match(r.refused, /diff/i)
  assert.throws(() => ltcTriggers(w.repo, 'refs/heads/no-such-base', 'refs/heads/main'), (e) => /diff/i.test(msgOf(e)))
})

test('trust-026: a missing ltc-plan.json refusal names plan-write', () => {
  const w = mkWorld()
  const pw = planWrite(w, 'wf_t26plan1-aaa', designerResult([CHEAP]))
  assert.equal(pw.status, 0, say(pw))
  assert.ok(existsSync(`${w.dir}/ltc-plan.json`), 'plan-write wrote ltc-plan.json')
  rmSync(`${w.dir}/ltc-plan.json`)
  const r = ltcCli(w, 'approve', ['--by', 'client'])
  assert.equal(r.status, 1, `a missing ltc-plan.json must not open the gate: ${say(r)}`)
  assert.match(String(r.json?.error), /plan-write/)
  assert.throws(() => ltcPlanGate(w.repo, w.dir), (e) => /plan-write/.test(msgOf(e)))
})

test('trust-026: a corrupt ltc-plan.json refuses approve', () => {
  for (const text of ['{not json', '{"rev":"r","ids":"E-20261110-a1b2c3"}', 'null', '[]']) {
    const w = mkWorld()
    const pw = planWrite(w, 'wf_t26plan2-aaa', designerResult([COSTLY]))
    assert.equal(pw.status, 0, say(pw))
    writeFileSync(`${w.dir}/ltc-plan.json`, text)
    const r = ltcCli(w, 'approve', ['--by', 'client'])
    assert.equal(r.status, 1, `${text}: ${say(r)}`)
    assert.match(String(r.json?.error), /ltc-plan\.json|plan-write/, text)
    assert.throws(() => ltcPlanGate(w.repo, w.dir), (e) => /plan-write|ltc-plan/.test(msgOf(e)), text)
  }
})

test('trust-026: a devDependencies to dependencies move raises a trigger', () => {
  const pkg = (o: any) => JSON.stringify({ name: 'app', ...o }, null, 2) + '\n'
  const w = world({}, { 'package.json': pkg({ devDependencies: { left: '1.0.0', right: '1.0.0' } }) })
  const base = head(w.repo)
  putFile(w.repo, 'package.json', pkg({ dependencies: { left: '1.0.0' }, devDependencies: { right: '1.0.0' } }), 'move left')
  const moved = head(w.repo)
  const t = ltcTriggers(w.repo, base, moved)
  assert.equal(t.length, 1, JSON.stringify(t))
  assert.match(t[0].what, /left/)
  assert.match(t[0].what, /package\.json/)
  assert.doesNotMatch(t[0].what, /right/)
  putFile(w.repo, 'package.json', pkg({ dependencies: { left: '1.0.0' }, devDependencies: { right: '2.0.0' } }), 'bump right')
  assert.deepEqual(ltcTriggers(w.repo, moved, head(w.repo)), [], 'a version change inside devDependencies raises nothing')
})

test('trust-026: a git-quoted odd file name raises a trigger', () => {
  const w = world()
  const names = ['db/migrations/0001\tx"y".sql', 'schema.v1\t"x".json']
  let base: string
  let tip: string
  if (process.platform !== 'win32') {
    // real files with a tab and quotes in their names
    base = head(w.repo)
    for (const n of names) {
      mkdirSync(path.dirname(`${w.repo}/${n}`), { recursive: true })
      writeFileSync(`${w.repo}/${n}`, 'x\n')
    }
    gitIn(w.repo, ['add', '-A'])
    gitIn(w.repo, ['commit', '-q', '-m', 'odd names'])
    tip = head(w.repo)
  } else [base, tip] = commitEntries(w.repo, names) // no such file on Windows: the same names as tree entries
  const whats = ltcTriggers(w.repo, base, tip).map((x) => x.what)
  for (const n of names) assert.ok(whats.some((x) => x.includes(n)), `a trigger names ${JSON.stringify(n)}: ${JSON.stringify(whats)}`)
  assert.ok(whats.every((x) => !x.includes('\\t')), 'no C-quoted form leaks into a trigger')
})

test('trust-026: a diff over 1 MB refusal names the size limit', () => {
  const w = world()
  const paths = Array.from({ length: 16000 }, (_, i) => `bulk/dir-${String(i).padStart(6, '0')}/${'n'.repeat(60)}.txt`)
  const [base, tip] = commitEntries(w.repo, paths)
  const out = spawnSync('git', ['diff', '--no-renames', '--name-status', base, tip], { cwd: w.repo, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  assert.ok(out.stdout.length > 1024 * 1024, `the name-status output is over 1 MB (${out.stdout.length} bytes)`)
  const limit = /\b1 ?MB\b|1048576|1,048,576/i
  assert.throws(() => ltcTriggers(w.repo, base, tip), (e) => limit.test(msgOf(e)) && /size|limit|large|big/i.test(msgOf(e)), 'the refusal names the 1 MB limit')
  let r: any
  assert.doesNotThrow(() => {
    r = ltcCrewGate(w.repo, w.dir, 'a', { qcText: null, base, head: tip })
  })
  assert.match(String(r?.refused), limit)
})

// ---------------------------------------------------------------------------------------------------------------
// item 4a: an escalate that dies after its append keeps its code

function codesOf(w: W): any[] {
  const r = runCli(proofFactory(), 'inbox', ['--repo', w.repo, '--recover-codes'], w.repo, proofEnv(w))
  assert.equal(r.status, 0, say(r))
  assert.ok(Array.isArray(r.json.codes), `--recover-codes prints {codes: [...]}: ${say(r)}`)
  return r.json.codes
}
const hashOk = (w: W, id: string, code: string): boolean => createHash('sha256').update(id + code).digest('hex') === opsOf(w).find((o) => o.op === 'open' && o.id === id).codeHash

test('trust-026: a SIGKILLed escalate is recovered from another session and resolved, and the plain listing shows no code', async () => {
  const pidFile = `${mk('t26-slp-')}/pid`
  const w = world({ notify: notifyCmd(SLEEPER, pidFile) })
  const dirB = session(w, 'sess-bbbb0002')
  const env = { ...process.env, TRUSS_SAMPLE: highSampleFile(), ...proofEnv(w) }
  const child = spawn(process.execPath, [proofFactory(), 'escalate', '--repo', w.repo, '--dir', w.dir, '--kind', 'scope-change', '--title', 'killed', '--crew', 'a'], { env, stdio: 'ignore', windowsHide: true })
  let gpid = 0
  try {
    for (let i = 0; i < 150 && !existsSync(pidFile); i++) wait(100)
    assert.ok(existsSync(pidFile), 'escalate reached its notify window')
    gpid = Number(readFileSync(pidFile, 'utf8'))
    child.kill('SIGKILL') // the append is done, the code never reached stdout
    await new Promise((res) => child.once('exit', res))
  } finally {
    if (gpid > 0) {
      try {
        process.kill(gpid, 'SIGKILL')
      } catch {}
    }
  }
  const op = opsOf(w).find((o) => o.op === 'open')
  assert.ok(op, 'the item was appended before the kill')
  const sidecar = `${w.dir}/escalate-code-${op.id}.json`
  assert.ok(existsSync(sidecar), 'the sidecar is in the session dir')
  if (process.platform !== 'win32') assert.equal(statSync(sidecar).mode & 0o777, 0o600)
  const entry = codesOf(w).find((c) => c.id === op.id)
  assert.ok(entry, '--recover-codes (no --dir) prints the surviving code of the open item')
  assert.equal(entry.session, w.sid)
  assert.ok(hashOk(w, op.id, entry.code), 'it is the item\'s code')
  const plain = run(w, 'inbox', [], {}, dirB)
  assert.ok(!plain.stdout.includes(entry.code) && !/"code"/.test(plain.stdout), 'the plain listing holds no code')
  // a code alone lifts nothing; the client types the decision in the later session B and the item resolves
  assert.equal(resolveCli(w, op.id, 'approve', entry.code, [], dirB).status, 1)
  put(w, op.id, entry.code, { sid: 'sess-bbbb0002' })
  const r = resolveCli(w, op.id, 'approve', entry.code, [], dirB)
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(await blocked(w), [])
  assert.ok(!existsSync(sidecar), 'the sidecar entry is removed when the item resolves')
  assert.ok(!codesOf(w).some((c) => c.id === op.id || c.code === entry.code))
  assert.ok(!run(w, 'inbox', [], {}, dirB).stdout.includes(entry.code))
})

test('trust-026: after a resolve the sidecar entry is gone and recover-codes no longer prints the code', () => {
  const w = world()
  const a = open(w)
  const sidecar = `${w.dir}/escalate-code-${a.id}.json`
  assert.ok(existsSync(sidecar), 'escalate wrote the sidecar')
  if (process.platform !== 'win32') assert.equal(statSync(sidecar).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(readFileSync(sidecar, 'utf8')), { id: a.id, code: a.code })
  assert.ok(codesOf(w).some((c) => c.id === a.id && c.code === a.code))
  put(w, a.id, a.code)
  assert.equal(resolveCli(w, a.id, 'approve', a.code).status, 0)
  assert.ok(!existsSync(sidecar))
  const after = runCli(proofFactory(), 'inbox', ['--repo', w.repo, '--recover-codes'], w.repo, proofEnv(w))
  assert.ok(!after.stdout.includes(a.code), 'the code is not printed again')
})

// ---------------------------------------------------------------------------------------------------------------
// item 4b: a crashed --next session's running item

function qworld(intake: Record<string, unknown> = {}) {
  const env = mkEnv({ config: { ...CONFIG, intake } })
  const troot = mk('t26-q-')
  const dir2 = mkTrussDir() // the session that calls queue-next
  const items = `${sharedDir(env.repo)}/queue/items`
  const plant = (id: string, over: Record<string, unknown>) => {
    mkdirSync(items, { recursive: true })
    writeFileSync(`${items}/${id}.json`, JSON.stringify({ v: 1, id, key: `md:${id}`, source: 'md', title: `planted ${id}`, text: `planted ${id}`, url: null, author: null, addedAt: '2026-11-01T00:00:00.000Z', state: 'running', session: null, claimedAt: null, history: [], ...over }, null, 2) + '\n')
  }
  const read = (id: string) => JSON.parse(readFileSync(`${items}/${id}.json`, 'utf8'))
  const next = () => runCli(`${env.plugin}/bin/factory.ts`, 'queue-next', ['--dir', dir2, '--repo', env.repo], env.repo, { TRUSS_TRANSCRIPTS_ROOT: troot })
  const transcript = (sid: string, rel: string, ageMs: number) => {
    const p = `${troot}/proj-q/${rel}`
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify({ type: 'user', sessionId: sid }) + '\n')
    const t = new Date(Date.now() - ageMs)
    utimesSync(p, t, t)
  }
  return { env, plant, read, next, transcript, dir2 }
}
const HOUR = 3600_000
const staleRow = (h: any) => h.from === 'running' && h.to === 'new' && h.by === 'stale'

test('trust-026: a crashed next session running item is released after the stale window', () => {
  const q = qworld()
  q.plant('Q-aaaaaaaaaaaa', { session: 'sess-dead', claimedAt: iso(Date.now() - 48 * HOUR), addedAt: '2026-11-01T00:00:00.000Z' })
  q.plant('Q-bbbbbbbbbbbb', { session: 'sess-nolog', claimedAt: iso(Date.now() - 48 * HOUR), addedAt: '2026-11-02T00:00:00.000Z' })
  q.transcript('sess-dead', 'sess-dead.jsonl', 40 * HOUR) // the dead session's main transcript, idle for 40 h
  q.transcript('sess-dead', 'sess-dead/subagents/agent-a1.jsonl', 30 * HOUR)
  const r = q.next()
  assert.equal(r.status, 0, say(r))
  for (const id of ['Q-aaaaaaaaaaaa', 'Q-bbbbbbbbbbbb']) {
    const it = q.read(id)
    assert.ok((it.history ?? []).some(staleRow), `${id}: released with a history row {from: running, to: new, by: stale}: ${JSON.stringify(it)}`)
  }
  assert.equal(r.json.item.id, 'Q-aaaaaaaaaaaa', 'the released item is claimable by the asking session, oldest first')
})

test('trust-026: a live owner past the claim TTL with no queue-next call keeps its running item', () => {
  // regression guard in part: an item that is never released is green before the build; the build must keep it so
  const q = qworld()
  q.plant('Q-cccccccccccc', { session: 'sess-live', claimedAt: iso(Date.now() - 48 * HOUR) })
  q.plant('Q-dddddddddddd', { session: 'sess-agent', claimedAt: iso(Date.now() - 48 * HOUR) })
  q.plant('Q-eeeeeeeeeeee', { session: 'sess-young', claimedAt: iso(Date.now() - 1 * HOUR) })
  q.transcript('sess-live', 'sess-live.jsonl', 0) // main transcript written just now
  q.transcript('sess-agent', 'sess-agent.jsonl', 40 * HOUR) // main idle, but an agent is still writing
  q.transcript('sess-agent', 'sess-agent/subagents/agent-a1.jsonl', 0)
  q.transcript('sess-young', 'sess-young.jsonl', 40 * HOUR) // idle, but the claim is inside the TTL
  const r = q.next()
  assert.equal(r.status, 0, say(r))
  assert.equal(r.json.item, null, say(r))
  for (const [id, sid] of [['Q-cccccccccccc', 'sess-live'], ['Q-dddddddddddd', 'sess-agent'], ['Q-eeeeeeeeeeee', 'sess-young']]) {
    const it = q.read(id)
    assert.equal(it.state, 'running', id)
    assert.equal(it.session, sid, id)
    assert.ok(!(it.history ?? []).some(staleRow), id)
  }
})

// ---------------------------------------------------------------------------------------------------------------
// item 7

test('trust-026: inbox unapplied filters by session', () => {
  const w = world()
  const dirB = session(w, 'sess-bbbb0003')
  const a = open(w, 'blocked', { dir: w.dir })
  const b = open(w, 'blocked', { dir: dirB })
  for (const it of [a, b]) assert.equal(resolveCli(w, it.id, 'dismiss', it.code, [], w.dir, 'pm').status, 0)
  const unapplied = (sid: string): string[] => {
    const r = runCli(proofFactory(), 'inbox', ['--repo', w.repo, '--unapplied', '--session', sid], w.repo, proofEnv(w))
    assert.equal(r.status, 0, say(r))
    return r.json.items.map((i) => i.id)
  }
  assert.deepEqual(unapplied(w.sid), [a.id], 'only the items session A opened')
  assert.deepEqual(unapplied('sess-bbbb0003'), [b.id])
  assert.equal(run(w, 'mark-applied', [a.id], {}, dirB).status, 0) // B applies A's item
  assert.deepEqual(unapplied(w.sid), [a.id], 'applied is judged against A, so B\'s mark does not hide it')
  assert.equal(run(w, 'mark-applied', [a.id]).status, 0)
  assert.deepEqual(unapplied(w.sid), [])
  assert.deepEqual(unapplied('sess-bbbb0003'), [b.id])
})

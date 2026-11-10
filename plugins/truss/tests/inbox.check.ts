// @ts-nocheck
// truss 0.25.0 wave 2, A1: the inbox (contract-025 section 3), written from the contract before bin/inbox.ts and bin/notify-run.ts exist.
// The CLI runs as real processes (`factory.ts <command> --repo R --dir D`, D = <common>/truss/<sid>); `resolve` and `mark-applied` take the
// id positionally. Ops live in <common>/truss/shared/inbox.jsonl, events in D/events.jsonl. Transcripts are fixtures under a temp tree that
// TRUSS_TRANSCRIPTS_ROOT names. The slash-command shape in fixtures/inbox/slash-command.jsonl is the shape probed from a real transcript:
// a human slash command is a main-thread user line whose content is a string of <command-name> and <command-args> tags, followed by an
// isMeta line that holds the skill body and an ARGUMENTS: line.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { REAL_PLUGIN, assertOneLine, crew, flat, mkRepo, planObj, pluginCopy, runCli, validateEvent, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

const FIX = `${REAL_PLUGIN}/tests/fixtures/inbox`
const NOTIFY_RUN = `${REAL_PLUGIN}/bin/notify-run.ts`
const INBOX_TS = `${REAL_PLUGIN}/bin/inbox.ts`
const RECORDER = `${FIX}/recorder.ts`
const EXIT1 = `${FIX}/exit1.ts`
const SLEEPER = `${FIX}/spawn-sleeper.ts`
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/
const ID_RE = /^E-[0-9]{8}-[0-9a-f]{6}$/
const CONFIG = { architecture: 'docs/architecture.md', adr: 'docs/adr' }

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

/** The factory CLI of a private copy of the plugin (real bin/, so the real inbox.ts and notify-run.ts). */
const factory = (): string => `${pluginCopy()}/bin/factory.ts`

type Env = { repo: string; common: string; shared: string; inboxFile: string; sid: string; dir: string; troot: string }

/** A session dir <common>/truss/<sid> with an empty events.jsonl. */
function mkSession(common: string, sid: string): string {
  const dir = `${common}/truss/${sid}`
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/events.jsonl`, '')
  writeFileSync(`${dir}/decisions.md`, '')
  return dir
}

/** A temp git repo (config laid over CONFIG in .claude/truss.json), one session, an empty transcripts root. */
function mkInbox(config: Record<string, unknown> = {}): Env {
  const repo = flat(realpathSync(mkRepo({ config: { ...CONFIG, ...config } })))
  const common = `${repo}/.git`
  const sid = `sess-${randomUUID().slice(0, 8)}`
  return { repo, common, shared: `${common}/truss/shared`, inboxFile: `${common}/truss/shared/inbox.jsonl`, sid, dir: mkSession(common, sid), troot: mk('inbox-tr-') }
}

/** Runs `factory <command> --repo R --dir D <args>` as a real process; `dir` picks another session's dir. */
function fx(env: Env, command: string, args: string[] = [], extraEnv: Record<string, string> = {}, dir = env.dir) {
  return runCli(factory(), command, ['--repo', env.repo, '--dir', dir, ...args], env.repo, { TRUSS_TRANSCRIPTS_ROOT: env.troot, ...extraEnv })
}

/** escalate with exit 0 expected; returns the printed object. */
function raise(env: Env, kind: string, extra: string[] = [], title = `title of ${kind}`, dir = env.dir) {
  const r = fx(env, 'escalate', ['--kind', kind, '--title', title, ...extra], {}, dir)
  const j = assertOneLine(r)
  assert.equal(r.status, 0, `escalate ${kind}: ${r.stdout} ${r.stderr}`)
  return j
}

/** resolve <id> with the flags given; the id goes first so the positional parse cannot lose it. */
const resolveOf = (env: Env, id: string, decision: string, by: string, code: string, extra: string[] = [], dir = env.dir) =>
  fx(env, 'resolve', [id, '--decision', decision, '--by', by, '--code', code, ...extra], {}, dir)

const opsOf = (env: Env): any[] => (existsSync(env.inboxFile) ? readFileSync(env.inboxFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const eventsOf = (dir: string): any[] => readFileSync(`${dir}/events.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const listOf = (env: Env, flags: string[] = []): any => {
  const r = fx(env, 'inbox', flags)
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`)
  return assertOneLine(r)
}

/** One millisecond-ISO second after the open op of `id`: a prompt typed after the item was raised. */
const afterOpen = (env: Env, id: string, plusMs = 1000): string => new Date(Date.parse(opsOf(env).find((o) => o.op === 'open' && o.id === id).ts) + plusMs).toISOString()
/** One main-thread human prompt line. */
const human = (content: unknown, ts: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content }, uuid: randomUUID(), timestamp: ts, ...over })
const typed = (id: string, code: string, decision = 'approve', tail = 'go ahead'): string => `/truss:inbox ${decision} ${id} ${code} ${tail}`
const transcriptOf = (env: Env, sid = env.sid): string => `${env.troot}/proj-a1/${sid}.jsonl`
function putTranscript(env: Env, lines: string[], sid = env.sid): void {
  mkdirSync(path.dirname(transcriptOf(env, sid)), { recursive: true })
  writeFileSync(transcriptOf(env, sid), lines.join('\n') + '\n')
}
const addTranscript = (env: Env, lines: string[]): void => appendFileSync(transcriptOf(env), lines.join('\n') + '\n')
/** The fixture transcript with the placeholders filled. */
const fixtureLines = (id: string, code: string, ts: string, file = 'slash-command.jsonl'): string[] =>
  readFileSync(`${FIX}/${file}`, 'utf8').split('\n').filter(Boolean).map((l) => l.replaceAll('__ID__', id).replaceAll('__CODE__', code).replaceAll('__TS__', ts))

const notifyCmd = (script: string, ...args: string[]): string => [process.execPath, script, ...args].map((a) => `"${flat(a)}"`).join(' ')
const recordedRows = (file: string): any[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

const wait = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    return e.code === 'EPERM'
  }
}

const OPEN_ROW = { v: 1, op: 'open', id: 'E-20261110-a1b2c3', ts: '2026-11-10T10:00:00.000Z', kind: 'scope-change', session: 's1', crews: ['c1'], ref: null, blocking: true, title: 'a title with spaces', detail: 'some detail', codeHash: 'a'.repeat(64), code: 'ABCDEF' }

// ---------------------------------------------------------------------------------------------------------------
// escalate, dedupe, blocking

test('inbox: escalate appends an open op and prints the id and code', () => {
  const env = mkInbox()
  const r = fx(env, 'escalate', ['--kind', 'scope-change', '--title', 'Change the scope', '--detail', 'the detail text', '--crew', 'c1', '--ref', 'r1'])
  const j = assertOneLine(r)
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`)
  assert.match(j.id, ID_RE)
  assert.equal(j.kind, 'scope-change')
  assert.equal(j.deduped, false)
  assert.match(j.code, CODE_RE)
  assert.equal(j.notified, null, 'no notify key in truss.json')
  const ops = opsOf(env)
  assert.equal(ops.length, 1, JSON.stringify(ops))
  const o = ops[0]
  assert.equal(o.v, 1)
  assert.equal(o.op, 'open')
  assert.equal(o.id, j.id)
  assert.equal(o.kind, 'scope-change')
  assert.equal(o.session, env.sid)
  assert.deepEqual(o.crews, ['c1'])
  assert.equal(o.ref, 'r1')
  assert.equal(o.blocking, true, 'scope-change is always blocking')
  assert.equal(o.title, 'Change the scope')
  assert.equal(o.detail, 'the detail text')
  assert.equal(typeof o.ts, 'string')
  assert.equal(o.codeHash, createHash('sha256').update(j.id + j.code).digest('hex'))
  assert.ok(!readFileSync(env.inboxFile, 'utf8').includes(j.code), 'the code is stored only as a hash')
  // a non-blocking kind is blocking only when asked
  const soft = raise(env, 'push-pr')
  const hard = raise(env, 'push-pr', ['--blocking'])
  const byId = (id: string) => opsOf(env).find((x) => x.op === 'open' && x.id === id)
  assert.equal(byId(soft.id).blocking, false)
  assert.equal(byId(hard.id).blocking, true)
})

test('inbox: a second escalate with the same kind and ref dedupes into a link', () => {
  const env = mkInbox()
  const a = raise(env, 'scope-change', ['--crew', 'c1', '--ref', 'same'])
  const b = raise(env, 'scope-change', ['--crew', 'c2', '--ref', 'same'])
  assert.equal(b.deduped, true)
  assert.equal(b.id, a.id)
  assert.equal(b.code, null, 'a dedupe prints no code')
  const ops = opsOf(env)
  assert.deepEqual(ops.map((o) => o.op), ['open', 'link'])
  assert.equal(ops[1].id, a.id)
  assert.equal(ops[1].session, env.sid)
  assert.deepEqual(ops[1].crews, ['c2'])
  assert.equal(listOf(env, ['--open']).open, 1)
  // the same ref under another kind is another item
  const c = raise(env, 'client-trigger', ['--ref', 'same'])
  assert.equal(c.deduped, false)
  assert.notEqual(c.id, a.id)
  assert.equal(listOf(env, ['--open']).open, 2)
})

test('inbox: a blocking link holds only that session and slug', async () => {
  const inbox = await import(INBOX_TS)
  const env = mkInbox()
  const other = 'sess-other'
  mkSession(env.common, other)
  // a non-blocking item of session A, then a blocking link from session B naming c2
  const a = raise(env, 'intake-triage', ['--crew', 'c1', '--ref', 'triage-1'])
  assert.deepEqual(inbox.blockingFor(env.repo, env.sid, 'c1'), [], 'a non-blocking item holds nothing')
  const b = raise(env, 'intake-triage', ['--crew', 'c2', '--ref', 'triage-1', '--blocking'], 'title', `${env.common}/truss/${other}`)
  assert.equal(b.deduped, true)
  assert.equal(b.id, a.id)
  assert.deepEqual(inbox.blockingFor(env.repo, other, 'c2'), [a.id])
  assert.deepEqual(inbox.blockingFor(env.repo, other, 'c1'), [], 'another slug of the same session')
  assert.deepEqual(inbox.blockingFor(env.repo, env.sid, 'c2'), [], 'the same slug of another session')
  assert.deepEqual(inbox.blockingFor(env.repo, env.sid, 'c1'), [], 'the opening crew was not made blocking by the link')
  // a blocking kind holds its crew until it is resolved
  const k = raise(env, 'blocked', ['--crew', 'c3'])
  assert.deepEqual(inbox.blockingFor(env.repo, env.sid, 'c3'), [k.id])
  const done = resolveOf(env, k.id, 'done', 'pm', k.code)
  assert.equal(done.status, 0, `${done.stdout} ${done.stderr}`)
  assert.deepEqual(inbox.blockingFor(env.repo, env.sid, 'c3'), [])
})

test('inbox: a null ref never dedupes', () => {
  const env = mkInbox()
  const a = raise(env, 'scope-change', ['--crew', 'c1'])
  const b = raise(env, 'scope-change', ['--crew', 'c1'])
  assert.equal(a.deduped, false)
  assert.equal(b.deduped, false)
  assert.notEqual(a.id, b.id)
  assert.deepEqual(opsOf(env).map((o) => o.op), ['open', 'open'])
  assert.equal(opsOf(env)[0].ref, null)
})

test('inbox: events.jsonl carries ids and kinds only, never the quote, title, detail or note', () => {
  const env = mkInbox({ notify: notifyCmd(EXIT1) })
  const NEEDLES = { title: 'needle-title-7f3a', detail: 'needle-detail-7f3a', note: 'needle-note-7f3a', quote: 'needle-quote-7f3a' }
  const a = raise(env, 'scope-change', ['--crew', 'c1', '--detail', NEEDLES.detail, '--ref', 'ev-1'], NEEDLES.title)
  const b = raise(env, 'blocked', ['--crew', 'c2', '--detail', NEEDLES.detail], NEEDLES.title)
  const rb = resolveOf(env, b.id, 'done', 'pm', b.code, ['--note', NEEDLES.note])
  assert.equal(rb.status, 0, `${rb.stdout} ${rb.stderr}`)
  putTranscript(env, [human(typed(a.id, a.code, 'approve', NEEDLES.quote), afterOpen(env, a.id))])
  const ra = resolveOf(env, a.id, 'approve', 'client', a.code, ['--note', NEEDLES.note])
  assert.equal(ra.status, 0, `${ra.stdout} ${ra.stderr}`)
  const raw = readFileSync(`${env.dir}/events.jsonl`, 'utf8')
  for (const [name, needle] of Object.entries(NEEDLES)) assert.ok(!raw.includes(needle), `events.jsonl holds the ${name}`)
  for (const code of [a.code, b.code]) assert.ok(!raw.includes(code), 'events.jsonl holds a code')
  const events = eventsOf(env.dir)
  for (const e of events) assert.deepEqual(validateEvent(e), [], JSON.stringify(e))
  const ofKind = (k: string) => events.filter((e) => e.event === k)
  assert.deepEqual(ofKind('escalate').map((e) => e.id).sort(), [a.id, b.id].sort())
  assert.ok(ofKind('escalate').every((e) => typeof e.blocking === 'boolean' && typeof e.kind === 'string'))
  assert.deepEqual(ofKind('resolve').map((e) => [e.id, e.decision, e.by]), [[b.id, 'done', 'pm'], [a.id, 'approve', 'client']])
  const errs = ofKind('notify-error')
  assert.deepEqual(errs.map((e) => e.id).sort(), [a.id, b.id].sort(), 'one notify-error per failed notify')
  assert.ok(errs.every((e) => typeof e.error === 'string' && e.error.length <= 200))
  const allowed = new Set(['v', 'ts', 'event', 'crew', 'id', 'kind', 'blocking', 'decision', 'by', 'error'])
  for (const e of events) for (const k of Object.keys(e)) assert.ok(allowed.has(k), `event ${e.event} carries ${k}`)
})

// ---------------------------------------------------------------------------------------------------------------
// resolve

test('inbox: resolve refuses by pm on a client kind', () => {
  const env = mkInbox()
  const a = raise(env, 'scope-change', ['--crew', 'c1'])
  const r = resolveOf(env, a.id, 'approve', 'pm', a.code)
  assertOneLine(r)
  assert.equal(r.status, 1, `${r.stdout} ${r.stderr}`)
  assert.equal(listOf(env, ['--open']).open, 1, 'the item is still open')
  // control: a pm kind resolves by pm
  const b = raise(env, 'blocked', ['--crew', 'c1'])
  const ok = resolveOf(env, b.id, 'done', 'pm', b.code)
  assert.equal(ok.status, 0, `${ok.stdout} ${ok.stderr}`)
  assert.equal(assertOneLine(ok).state, 'resolved')
})

test('inbox: resolve refuses raise-usd on a kind other than budget', () => {
  const env = mkInbox()
  const a = raise(env, 'blocked', ['--crew', 'c1'])
  const r = resolveOf(env, a.id, 'done', 'pm', a.code, ['--raise-usd', '10'])
  assertOneLine(r)
  assert.equal(r.status, 1, `${r.stdout} ${r.stderr}`)
  assert.equal(listOf(env, ['--open']).open, 1)
  const ok = resolveOf(env, a.id, 'done', 'pm', a.code)
  assert.equal(ok.status, 0, `${ok.stdout} ${ok.stderr}`)
})

test('inbox: resolve refuses a wrong code', () => {
  const env = mkInbox()
  const a = raise(env, 'blocked', ['--crew', 'c1'])
  const wrong = a.code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA'
  const r = resolveOf(env, a.id, 'done', 'pm', wrong)
  assertOneLine(r)
  assert.equal(r.status, 1, `${r.stdout} ${r.stderr}`)
  assert.equal(listOf(env, ['--open']).open, 1)
  const ok = resolveOf(env, a.id, 'done', 'pm', a.code)
  assert.equal(ok.status, 0, `${ok.stdout} ${ok.stderr}`)
})

test('inbox: resolve refuses a resolved item', () => {
  const env = mkInbox()
  const a = raise(env, 'blocked', ['--crew', 'c1'])
  const first = resolveOf(env, a.id, 'done', 'pm', a.code)
  assert.equal(first.status, 0, `${first.stdout} ${first.stderr}`)
  const again = resolveOf(env, a.id, 'dismiss', 'pm', a.code)
  assertOneLine(again)
  assert.equal(again.status, 1, `${again.stdout} ${again.stderr}`)
  assert.equal(opsOf(env).filter((o) => o.op === 'resolve').length, 1)
})

test('inbox: resolve by client is refused with no typed prompt', () => {
  const env = mkInbox()
  const a = raise(env, 'scope-change', ['--crew', 'c1'])
  // no transcript at all
  const none = resolveOf(env, a.id, 'approve', 'client', a.code)
  assertOneLine(none)
  assert.equal(none.status, 1, `${none.stdout} ${none.stderr}`)
  // a transcript with an assistant line that carries the text
  putTranscript(env, [human(typed(a.id, a.code), afterOpen(env, a.id), { type: 'assistant', message: { role: 'assistant', content: typed(a.id, a.code) } })])
  const asst = resolveOf(env, a.id, 'approve', 'client', a.code)
  assert.equal(asst.status, 1, `${asst.stdout} ${asst.stderr}`)
  // an agent cannot type a quote: --quote is not a flag, so the call is still refused (or a usage error)
  const quoted = resolveOf(env, a.id, 'approve', 'client', a.code, ['--quote', typed(a.id, a.code)])
  assert.ok(quoted.status === 1 || quoted.status === 2, `${quoted.stdout} ${quoted.stderr}`)
  assert.equal(listOf(env, ['--open']).open, 1, 'the item is still open')
  assert.equal(opsOf(env).filter((o) => o.op === 'resolve').length, 0)
})

test('inbox: resolve by client is accepted with a fixture prompt and stores the quote', () => {
  const env = mkInbox()
  const a = raise(env, 'scope-change', ['--crew', 'c1'])
  const text = typed(a.id, a.code, 'approve', 'looks fine to me')
  putTranscript(env, [human(text, afterOpen(env, a.id))])
  const r = resolveOf(env, a.id, 'approve', 'client', a.code, ['--note', 'a note'])
  const j = assertOneLine(r)
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`)
  assert.equal(j.id, a.id)
  assert.equal(j.state, 'resolved')
  assert.equal(j.decision, 'approve')
  assert.equal(j.quote, text)
  const res = opsOf(env).find((o) => o.op === 'resolve')
  assert.equal(res.id, a.id)
  assert.equal(res.session, env.sid)
  assert.equal(res.by, 'client')
  assert.equal(res.decision, 'approve')
  assert.equal(res.quote, text)
  assert.equal(res.note, 'a note')
  const item = listOf(env).items.find((x) => x.id === a.id)
  assert.equal(item.state, 'resolved')
  assert.equal(item.by, 'client')
  assert.equal(item.quote, text)
  assert.equal(listOf(env, ['--open']).open, 0)
})

test('inbox: a tool_result line containing the code does not count', () => {
  const env = mkInbox()
  const a = raise(env, 'scope-change', ['--crew', 'c1'])
  const ts = afterOpen(env, a.id)
  const text = typed(a.id, a.code)
  putTranscript(env, [
    human([{ type: 'tool_result', tool_use_id: 'toolu_1', content: text }], ts),
    human([{ type: 'text', text }, { type: 'tool_result', tool_use_id: 'toolu_2', content: 'x' }], ts),
  ])
  const r = resolveOf(env, a.id, 'approve', 'client', a.code)
  assertOneLine(r)
  assert.equal(r.status, 1, `${r.stdout} ${r.stderr}`)
  assert.equal(listOf(env, ['--open']).open, 1)
  // control: the same text typed by the human counts
  addTranscript(env, [human(text, ts)])
  const ok = resolveOf(env, a.id, 'approve', 'client', a.code)
  assert.equal(ok.status, 0, `${ok.stdout} ${ok.stderr}`)
})

test('inbox: the probed slash-command shape qualifies as a typed prompt', () => {
  const env = mkInbox()
  const a = raise(env, 'scope-change', ['--crew', 'c1'])
  const ts = afterOpen(env, a.id)
  const lines = fixtureLines(a.id, a.code, ts)
  assert.equal(lines.length, 5, 'the fixture has the slash command, the skill body, a tool_result, a sidechain and a meta line')
  const parsed = lines.map((l) => JSON.parse(l))
  assert.ok(String(parsed[0].message.content).includes('<command-name>/truss:inbox</command-name>'), 'the first fixture line is the slash command')
  // the lines that must not count, alone, are refused
  putTranscript(env, lines.slice(1))
  const noSlash = resolveOf(env, a.id, 'approve', 'client', a.code)
  assertOneLine(noSlash)
  assert.equal(noSlash.status, 1, `skill body, tool_result, sidechain and meta lines alone: ${noSlash.stdout}`)
  // the slash-command line qualifies
  putTranscript(env, lines)
  const r = resolveOf(env, a.id, 'approve', 'client', a.code)
  const j = assertOneLine(r)
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`)
  assert.ok(String(j.quote).includes(a.id), 'the quote is the slash-command text')
  assert.ok(String(j.quote).length <= 1000)
})

test('inbox: the inbox skill sets disable-model-invocation', () => {
  const p = `${REAL_PLUGIN}/skills/inbox/SKILL.md`
  assert.ok(existsSync(p), 'skills/inbox/SKILL.md is missing')
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(p, 'utf8'))
  assert.ok(m, 'SKILL.md has no frontmatter')
  assert.match(m[1], /^disable-model-invocation:\s*true\s*$/m)
})

// ---------------------------------------------------------------------------------------------------------------
// notify

/** Runs bin/notify-run.ts as a process with `{repo, row}` on stdin. */
function runNotify(repo: string, row: unknown, timeout = 14000) {
  assert.ok(existsSync(NOTIFY_RUN), 'bin/notify-run.ts is missing')
  const r = spawnSync(process.execPath, [NOTIFY_RUN], { input: JSON.stringify({ repo, row }), encoding: 'utf8', timeout, windowsHide: true })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

test('inbox: notify gets the env and the row on stdin', () => {
  const out = `${mk('inbox-rec-')}/rec.jsonl`
  const repo = flat(realpathSync(mkRepo({ config: { notify: notifyCmd(RECORDER, out) } })))
  const r = runNotify(repo, OPEN_ROW)
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`)
  const rows = recordedRows(out)
  assert.equal(rows.length, 1)
  assert.deepEqual(JSON.parse(rows[0].stdin), OPEN_ROW, 'the row on stdin is the open op plus code')
  assert.equal(rows[0].env.TRUSS_INBOX_ID, OPEN_ROW.id)
  assert.equal(rows[0].env.TRUSS_INBOX_KIND, OPEN_ROW.kind)
  assert.equal(flat(rows[0].env.TRUSS_INBOX_REPO), repo)
  assert.equal(rows[0].env.TRUSS_INBOX_TITLE, process.platform === 'win32' ? undefined : OPEN_ROW.title)
})

test('inbox: a notify exit 1 is fail-open', () => {
  const repo = flat(realpathSync(mkRepo({ config: { notify: notifyCmd(EXIT1) } })))
  const r = runNotify(repo, OPEN_ROW)
  assert.equal(r.status, 1, `${r.stdout} ${r.stderr}`)
  const lines = r.stdout.split('\n').filter(Boolean)
  assert.equal(lines.length, 1, r.stdout)
  assert.equal(typeof JSON.parse(lines[0]).error, 'string')
  // through factory escalate: the escalation succeeds, notified is false, and one notify-error event is written
  const env = mkInbox({ notify: notifyCmd(EXIT1) })
  const rr = fx(env, 'escalate', ['--kind', 'scope-change', '--title', 'a title', '--crew', 'c1'])
  const j = assertOneLine(rr)
  assert.equal(rr.status, 0, `${rr.stdout} ${rr.stderr}`)
  assert.equal(j.notified, false)
  assert.equal(typeof j.notifyError, 'string')
  assert.match(j.id, ID_RE)
  assert.equal(opsOf(env).filter((o) => o.op === 'open').length, 1)
  const errs = eventsOf(env.dir).filter((e) => e.event === 'notify-error')
  assert.equal(errs.length, 1)
  assert.equal(errs[0].id, j.id)
})

test('inbox: a notify grandchild that sleeps is killed within 11 s', () => {
  const pidFile = `${mk('inbox-slp-')}/pid`
  const repo = flat(realpathSync(mkRepo({ config: { notify: notifyCmd(SLEEPER, pidFile) } })))
  let pid = 0
  try {
    const t0 = Date.now()
    const r = runNotify(repo, OPEN_ROW, 14000)
    const took = Date.now() - t0
    assert.ok(took < 11000, `notify-run took ${took} ms`)
    assert.equal(r.status, 1, `${r.stdout} ${r.stderr}`)
    assert.ok(existsSync(pidFile), 'the sleeper never wrote its grandchild pid')
    pid = Number(readFileSync(pidFile, 'utf8'))
    assert.ok(Number.isInteger(pid) && pid > 0, `bad pid ${pid}`)
    for (let i = 0; i < 30 && alive(pid); i++) wait(100)
    assert.equal(alive(pid), false, `the grandchild ${pid} is still alive`)
  } finally {
    if (pid > 0 && alive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }
})

test('inbox: no title variable is set on win32', async () => {
  assert.ok(existsSync(NOTIFY_RUN), 'bin/notify-run.ts is missing')
  const { notifyEnv } = await import(NOTIFY_RUN)
  const base = { PATH: 'p', KEEP: 'yes' }
  const win = notifyEnv({ ...OPEN_ROW, title: '%PATH% & more' }, 'C:/repo', 'win32', base)
  assert.equal(win.TRUSS_INBOX_ID, OPEN_ROW.id)
  assert.equal(win.TRUSS_INBOX_KIND, OPEN_ROW.kind)
  assert.equal(win.TRUSS_INBOX_REPO, 'C:/repo')
  assert.equal(win.TRUSS_INBOX_TITLE, undefined)
  assert.ok(!('TRUSS_INBOX_TITLE' in win))
  assert.equal(win.KEEP, 'yes', 'the base env is kept')
  assert.ok(!Object.values(win).some((v) => String(v).includes('%PATH%')), 'the title is nowhere in the win32 env')
  const posix = notifyEnv({ ...OPEN_ROW, title: 'a title' }, '/repo', 'darwin', base)
  assert.equal(posix.TRUSS_INBOX_TITLE, 'a title')
  assert.equal(posix.TRUSS_INBOX_ID, OPEN_ROW.id)
  assert.equal(posix.TRUSS_INBOX_REPO, '/repo')
})

test('inbox: the notify tree kill takes the platform as a parameter, taskkill on win32 and a group kill on darwin', async () => {
  assert.ok(existsSync(NOTIFY_RUN), 'bin/notify-run.ts is missing')
  const { killTree } = await import(NOTIFY_RUN)
  const fake = () => {
    const calls: any[] = []
    return { calls, ops: { spawnSync: (...a: any[]) => (calls.push(['spawnSync', ...a]), { status: 0 }), kill: (...a: any[]) => (calls.push(['kill', ...a]), true) } }
  }
  const w = fake()
  killTree(4321, 'win32', w.ops)
  assert.deepEqual(w.calls, [['spawnSync', 'taskkill', ['/T', '/F', '/PID', '4321'], { windowsHide: true }]])
  const d = fake()
  killTree(4321, 'darwin', d.ops)
  assert.deepEqual(d.calls, [['kill', -4321, 'SIGKILL']])
  const l = fake()
  killTree(4321, 'linux', l.ops)
  assert.deepEqual(l.calls, [['kill', -4321, 'SIGKILL']])
})

test('inbox: a real escalate of client-question with blocking on crew c1 fires notify once with the row, and start and admit refuse c1 with awaiting client while c2 starts and is admitted', () => {
  const out = `${mk('inbox-rec-')}/rec.jsonl`
  const env = mkInbox({ notify: notifyCmd(RECORDER, out) })
  writePlan(env.dir, planObj([crew('c1'), crew('c2')]))
  writeGoal(env.dir, 'c1')
  writeGoal(env.dir, 'c2')
  const e = fx(env, 'escalate', ['--kind', 'client-question', '--title', 'Which database?', '--crew', 'c1', '--blocking'])
  const j = assertOneLine(e)
  assert.equal(e.status, 0, `${e.stdout} ${e.stderr}`)
  assert.match(j.id, ID_RE)
  assert.equal(j.notified, true)
  const rows = recordedRows(out)
  assert.equal(rows.length, 1, 'notify ran once')
  const row = JSON.parse(rows[0].stdin)
  assert.equal(row.id, j.id)
  assert.equal(row.op, 'open')
  assert.equal(row.kind, 'client-question')
  assert.equal(row.code, j.code)
  assert.equal(rows[0].env.TRUSS_INBOX_ID, j.id)
  // c1 is held at admit and at start
  const a1 = fx(env, 'admit', ['--slug', 'c1'])
  const aj = assertOneLine(a1)
  assert.equal(a1.status, 1, `${a1.stdout} ${a1.stderr}`)
  assert.equal(aj.admitted, false)
  assert.ok(String(aj.why).includes(`awaiting client: ${j.id}`), a1.stdout)
  const s1 = fx(env, 'start', ['--slug', 'c1'])
  const sj = assertOneLine(s1)
  assert.equal(s1.status, 0, `${s1.stdout} ${s1.stderr}`)
  const held = (sj.held ?? []).find((h) => h.slug === 'c1')
  assert.ok(held, `start holds c1: ${s1.stdout}`)
  assert.ok(String(held.why).includes(`awaiting client: ${j.id}`), s1.stdout)
  assert.ok(!(sj.truss?.crews ?? []).some((c) => (c.slug ?? c) === 'c1'), 'c1 did not start')
  assert.equal(JSON.parse(readFileSync(`${env.dir}/plan.json`, 'utf8')).crews.find((c) => c.slug === 'c1').status, 'planned')
  // c2 is free
  const a2 = fx(env, 'admit', ['--slug', 'c2'])
  assert.equal(a2.status, 0, `${a2.stdout} ${a2.stderr}`)
  assert.equal(assertOneLine(a2).admitted, true)
  const s2 = fx(env, 'start', ['--slug', 'c2'])
  assertOneLine(s2)
  assert.equal(s2.status, 0, `${s2.stdout} ${s2.stderr}`)
  const plan = JSON.parse(readFileSync(`${env.dir}/plan.json`, 'utf8'))
  assert.equal(plan.crews.find((c) => c.slug === 'c1').status, 'planned')
  assert.equal(plan.crews.find((c) => c.slug === 'c2').status, 'running')
  assert.equal(recordedRows(out).length, 1, 'start and admit raised nothing more')
})

// ---------------------------------------------------------------------------------------------------------------
// unapplied, budgetRaises

test('inbox: unapplied lists resolved items until mark-applied', () => {
  const env = mkInbox()
  const a = raise(env, 'blocked', ['--crew', 'c1'])
  const open = raise(env, 'blocked', ['--crew', 'c2'])
  assert.equal(resolveOf(env, a.id, 'done', 'pm', a.code).status, 0)
  const before = listOf(env, ['--unapplied'])
  assert.deepEqual(before.items.map((x) => x.id), [a.id], 'only the resolved item, not the open one')
  assert.equal(before.items[0].state, 'resolved')
  assert.equal(before.items[0].applied, false)
  assert.notEqual(open.id, a.id)
  const m = fx(env, 'mark-applied', [a.id])
  const mj = assertOneLine(m)
  assert.equal(m.status, 0, `${m.stdout} ${m.stderr}`)
  assert.equal(mj.id, a.id)
  assert.deepEqual(listOf(env, ['--unapplied']).items, [])
  assert.equal(listOf(env).items.find((x) => x.id === a.id).applied, true)
  assert.equal(opsOf(env).filter((o) => o.op === 'applied').length, 1)
})

test('inbox: budgetRaises returns the approved budget raises', async () => {
  const inbox = await import(INBOX_TS)
  const env = mkInbox()
  const other = 'sess-other'
  mkSession(env.common, other)
  const grant = (kind: string, ref: string, decision: string, extra: string[], dir = env.dir, sid = env.sid) => {
    const a = raise(env, kind, ['--crew', 'c1', '--ref', ref], 'budget', dir)
    putTranscript(env, [human(typed(a.id, a.code, decision), afterOpen(env, a.id))], sid)
    const r = resolveOf(env, a.id, decision, 'client', a.code, extra, dir)
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`)
    return a
  }
  grant('budget', 'budget:run:1', 'approve', ['--raise-usd', '25'])
  grant('budget', 'budget:crew:c1', 'approve', ['--raise-usd', '7.5'])
  grant('budget', 'budget:rejected', 'reject', [])
  raise(env, 'budget', ['--crew', 'c1', '--ref', 'budget:still-open'])
  grant('budget', 'budget:other-session', 'approve', ['--raise-usd', '99'], `${env.common}/truss/${other}`, other)
  const got = inbox.budgetRaises(env.repo, env.sid)
  assert.deepEqual([...got].sort((x, y) => (x.ref < y.ref ? -1 : 1)), [{ ref: 'budget:crew:c1', raiseUsd: 7.5 }, { ref: 'budget:run:1', raiseUsd: 25 }])
  assert.deepEqual(inbox.budgetRaises(env.repo, other), [{ ref: 'budget:other-session', raiseUsd: 99 }])
})

// ---------------------------------------------------------------------------------------------------------------
// extra cases: the forgery attempts of the stress test, the race, and the notify results of escalate

test('inbox: resolve by client refuses an isSidechain line, an isMeta line and a prompt older than the open op', () => {
  const env = mkInbox()
  const a = raise(env, 'scope-change', ['--crew', 'c1'])
  const text = typed(a.id, a.code)
  const ts = afterOpen(env, a.id)
  const refused = (label: string) => {
    const r = resolveOf(env, a.id, 'approve', 'client', a.code)
    assertOneLine(r)
    assert.equal(r.status, 1, `${label}: ${r.stdout} ${r.stderr}`)
    assert.equal(listOf(env, ['--open']).open, 1, `${label}: the item is still open`)
  }
  putTranscript(env, [human(text, ts, { isSidechain: true })])
  refused('isSidechain')
  putTranscript(env, [human(text, ts, { isMeta: true })])
  refused('isMeta')
  putTranscript(env, [human(text, afterOpen(env, a.id, -3600000))])
  refused('older than the open op')
  // the id, the decision word and the code must all be in the line
  putTranscript(env, [human(`/truss:inbox reject ${a.id} ${a.code}`, ts), human(`/truss:inbox approve ${a.id} NOPE22`, ts), human(`/truss:inbox approve E-20200101-000000 ${a.code}`, ts)])
  refused('a line missing the decision, the code or the id')
  // control: a human line after the open op qualifies
  putTranscript(env, [human(text, ts)])
  const ok = resolveOf(env, a.id, 'approve', 'client', a.code)
  assert.equal(ok.status, 0, `${ok.stdout} ${ok.stderr}`)
})

test('inbox: resolve by client refuses a task-notification line and a compact summary (agent text is not a human prompt)', () => {
  const env = mkInbox()
  const a = raise(env, 'scope-change', ['--crew', 'c1'])
  const ts = afterOpen(env, a.id)
  const refused = (label: string) => {
    const r = resolveOf(env, a.id, 'approve', 'client', a.code)
    assertOneLine(r)
    assert.equal(r.status, 1, `${label}: ${r.stdout} ${r.stderr}`)
    assert.equal(listOf(env, ['--open']).open, 1, `${label}: the item is still open`)
  }
  const lines = fixtureLines(a.id, a.code, ts, 'non-human.jsonl')
  putTranscript(env, [lines[0]])
  refused('origin.kind task-notification')
  putTranscript(env, [lines[1]])
  refused('isCompactSummary')
  const body = typed(a.id, a.code)
  putTranscript(env, [human(body, ts, { isVisibleInTranscriptOnly: true })])
  refused('isVisibleInTranscriptOnly')
  putTranscript(env, [human(body, ts, { origin: { kind: 'task-notification' } })])
  refused('origin.kind other than human')
  // control: origin.kind human qualifies
  putTranscript(env, [human(body, ts, { origin: { kind: 'human' } })])
  const ok = resolveOf(env, a.id, 'approve', 'client', a.code)
  assert.equal(ok.status, 0, `${ok.stdout} ${ok.stderr}`)
})

test('inbox: a text-block prompt qualifies and a quote is cut to 1000 characters', () => {
  const env = mkInbox()
  const a = raise(env, 'scope-change', ['--crew', 'c1'])
  const text = typed(a.id, a.code, 'approve', 'y'.repeat(2000))
  putTranscript(env, [human([{ type: 'text', text }], afterOpen(env, a.id))])
  const r = resolveOf(env, a.id, 'approve', 'client', a.code)
  const j = assertOneLine(r)
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`)
  assert.ok(typeof j.quote === 'string' && j.quote.length <= 1000 && j.quote.length >= 900, `quote length ${String(j.quote).length}`)
  assert.ok(j.quote.startsWith(typed(a.id, a.code).slice(0, 40)))
})

test('inbox: escalate reads --title-file and --detail-file', () => {
  const env = mkInbox()
  const d = mk('inbox-txt-')
  writeFileSync(`${d}/title.txt`, 'A title "with quotes" and $(no shell)\n')
  writeFileSync(`${d}/detail.txt`, 'line one\nline two\n')
  const r = fx(env, 'escalate', ['--kind', 'scope-change', '--title-file', `${d}/title.txt`, '--detail-file', `${d}/detail.txt`])
  assertOneLine(r)
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`)
  const o = opsOf(env)[0]
  assert.ok(o.title.startsWith('A title "with quotes" and $(no shell)'), o.title)
  assert.ok(o.detail.includes('line one') && o.detail.includes('line two'), o.detail)
})

test('inbox: escalate reports notified true on success and does not notify on a dedupe', () => {
  const out = `${mk('inbox-rec-')}/rec.jsonl`
  const env = mkInbox({ notify: notifyCmd(RECORDER, out) })
  const a = raise(env, 'scope-change', ['--crew', 'c1', '--ref', 'n1'])
  assert.equal(a.notified, true)
  assert.equal(recordedRows(out).length, 1)
  const b = raise(env, 'scope-change', ['--crew', 'c2', '--ref', 'n1'])
  assert.equal(b.deduped, true)
  assert.ok(b.notified === null || b.notified === false || b.notified === undefined, 'a dedupe does not notify')
  assert.equal(recordedRows(out).length, 1, 'no second notify on a dedupe')
})

test('inbox: 8 concurrent escalates with one kind and ref leave one open op and 7 links', async () => {
  const env = mkInbox()
  const runs = Array.from({ length: 8 }, (_, i) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const p = spawn(process.execPath, [factory(), 'escalate', '--repo', env.repo, '--dir', env.dir, '--kind', 'scope-change', '--title', 'race', '--crew', `c${i}`, '--ref', 'race-ref'], {
        cwd: env.repo,
        windowsHide: true,
        env: { ...process.env, TRUSS_TRANSCRIPTS_ROOT: env.troot },
      })
      let out = ''
      p.stdout.on('data', (d) => (out += d))
      p.on('close', (code) => resolve({ code, out }))
    }))
  const results = await Promise.all(runs)
  for (const r of results) assert.equal(r.code, 0, r.out)
  const js = results.map((r) => JSON.parse(r.out.trim()))
  assert.equal(js.filter((j) => j.deduped === false).length, 1)
  assert.equal(js.filter((j) => j.deduped === true).length, 7)
  assert.equal(new Set(js.map((j) => j.id)).size, 1)
  const ops = opsOf(env)
  assert.equal(ops.filter((o) => o.op === 'open').length, 1)
  assert.equal(ops.filter((o) => o.op === 'link').length, 7)
  assert.equal(listOf(env, ['--open']).open, 1)
})

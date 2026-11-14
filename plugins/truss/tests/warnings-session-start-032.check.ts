// @ts-nocheck
// 0.32.0 deferred-fixes, rework round 2 (PM ruling 01:52, item 3): the session start the newer-than-session warnings measure from
// comes from a record written when the Claude Code process starts or resumes the session; the transcript is only a fallback.
// QC showed a fresh session's first timestamped transcript record can come later than the process start, so measuring from it
// hides an agent file changed in between; and a --continue session's transcript starts hours before the process that resumed it.
//
// The seam. The main session's `classic.SessionStart` handler in hooks/register.ts (no `agent_id`) writes
// `<truss dir>/session-start.json` when the hook input's `source` is `startup` or `resume`, and only then: `clear` and `compact`
// keep the process and its loaded agents, so they never move the start. The record is one JSON object,
// {"v":1,"ts":"<$.clock.now() as an ISO 8601 UTC string>","source":"startup"|"resume","session":"<the hook input's session_id>"},
// written whole (it replaces any earlier record). A write error fails open: the dir note still goes out. `factory start --dir D`
// measures from D's record when it parses with v 1 and a finite ts; else from `--transcript`'s first timestamped record; else
// from CLAUDE_PID. TRUSS_SESSION_START, the test override, still wins over all three.
//
// Why a hook and not `$.session.usage().startedAt`: the hook API documents startedAt as "for a resumed session its first launch",
// which is the transcript's error again. Why not `session.start`: it carries no source and no session id to check.

import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertOneLine, crew, mkEnv, mkRun, planObj, pluginCopy, runCli, tmp, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

const T0 = Date.now()
const MIN = 60_000
const HOUR = 60 * MIN
const iso = (ms: number): string => new Date(ms).toISOString()
const CHANGED = /changed after this session loaded its agents/
const RECORD = 'session-start.json'

// ---- the CLI: start measures from the record ----

/**
 * Runs `start --stage next --transcript <run dir>` on a plugin copy whose agent files all have mtime `fileMs`, a session transcript
 * whose first timestamped record is at `transcriptMs`, and a session-start record at `recordMs` in the truss dir. CLAUDE_PID is
 * empty, so a start that ignores both the record and the transcript says it can't tell, which these cases count as a failure too.
 */
function warningsOf(recordMs: number, transcriptMs: number, fileMs: number, source: string): string[] {
  const env = mkEnv()
  writePlan(env.dir, planObj([crew('s')]))
  writeGoal(env.dir, 's')
  writeFileSync(join(env.dir, RECORD), JSON.stringify({ v: 1, ts: iso(recordMs), source, session: 'sess-start-032' }) + '\n')
  const plugin = tmp('wstart-plugin-')
  cpSync(pluginCopy(), plugin, { recursive: true })
  for (const f of readdirSync(`${plugin}/agents`)) utimesSync(`${plugin}/agents/${f}`, fileMs / 1000, fileMs / 1000)
  const troot = tmp('wstart-tr-')
  const sid = 'sess-start-032'
  mkdirSync(`${troot}/proj/${sid}/workflows`, { recursive: true })
  // the first record carries no timestamp, as a fresh session's first records do; the first timestamped one is at transcriptMs
  const rows = [{ type: 'summary', summary: 'x' }, { type: 'user', timestamp: iso(transcriptMs), message: { role: 'user', content: 'hi' } }, { type: 'assistant', timestamp: iso(T0), message: { role: 'assistant', content: [] } }]
  writeFileSync(`${troot}/proj/${sid}.jsonl`, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const run = mkRun(`${troot}/proj/${sid}/workflows`, 'run1', [])
  const res = runCli(`${plugin}/bin/factory.ts`, 'start', ['--dir', env.dir, '--repo', env.repo, '--stage', 'next', '--transcript', run.dir], env.repo, { TRUSS_TRANSCRIPTS_ROOT: troot, CLAUDE_PID: '', TRUSS_SESSION_START: '' })
  assert.equal(res.status, 0, `exit ${res.status}; ${String(res.stdout).slice(0, 500)}; ${String(res.stderr).slice(0, 300)}`)
  return assertOneLine(res).warnings
}

test('start measures from the session-start record: a fresh session whose first transcript record is later than the process start still warns of an agent file changed in between', () => {
  // the process started 10 min ago and loaded its agents; the agent files changed 5 min ago; the first timestamped transcript record is now
  const w = warningsOf(T0 - 10 * MIN, T0, T0 - 5 * MIN, 'startup')
  assert.ok(w.some((x) => CHANGED.test(x) && x.includes('agents/qc-engineer.md')), `no warning for agents/qc-engineer.md: ${JSON.stringify(w)}`)
})

test('start measures from the session-start record: a resumed session whose transcript starts hours earlier measures from the resume, so an older change does not warn', () => {
  // the transcript began 5 h ago; the agent files changed 1 h ago; --continue started this process 10 min ago and loaded them again
  const w = warningsOf(T0 - 10 * MIN, T0 - 5 * HOUR, T0 - HOUR, 'resume')
  const bad = w.filter((x) => CHANGED.test(x) || /can't tell/.test(x))
  assert.deepEqual(bad, [], `false warnings: ${JSON.stringify(bad)}`)
})

// ---- the hook: classic.SessionStart writes the record ----

/** The real classic.SessionStart handler, driven through register() with a fake engine over a real temp truss dir. */
async function sessionStartHook(opts: { writeFails?: boolean } = {}) {
  const mod = await import('../hooks/register.ts')
  const root = tmp('wstart-hook-')
  const common = join(root, 'git')
  const sessionId = 's1'
  const truss = mod.trussDir(common, undefined, sessionId)
  mkdirSync(truss, { recursive: true })
  let now = T0
  const $: any = {
    process: { run: async () => ({ exitCode: 0, stdout: `${common}\n`, stderr: '' }) },
    session: { cwd: async () => root, id: async () => sessionId },
    env: { get: async () => undefined },
    clock: { now: async () => now, after: () => ({ cancel() {} }) },
    ui: { log: () => {} },
    fs: {
      exists: async (p: string) => existsSync(p),
      read: async (p: string) => readFileSync(p, 'utf8'),
      stat: async () => ({}),
      write: async (p: string, text: string) => {
        if (opts.writeFails) throw new Error('disk full')
        writeFileSync(p, text)
      },
    },
    state: { get: async () => ({ value: undefined, version: 0 }), set: async () => ({ isSet: true, version: 1 }) },
  }
  let handler: any
  const on: any = (...a: any[]) => {
    if (a[0] === 'classic.SessionStart') handler = a[a.length - 1]
    const chain: any = { catch: () => chain }
    return chain
  }
  mod.register(on)
  assert.ok(handler, 'the classic.SessionStart handler was not registered')
  const fire = (source: string, at: number, extra: Record<string, unknown> = {}) => {
    now = at
    return handler($, { hook_event_name: 'SessionStart', session_id: sessionId, source, ...extra }, async () => ({}))
  }
  const record = (): any => (existsSync(join(truss, RECORD)) ? JSON.parse(readFileSync(join(truss, RECORD), 'utf8')) : undefined)
  return { fire, record, truss, note: `${mod.DIR_NOTE} ${truss}` }
}

test('the session-start hook writes the record on startup and on resume, with the hook clock time', async () => {
  const h = await sessionStartHook()
  const r = await h.fire('startup', T0 - HOUR)
  assert.ok((r.additionalContext ?? []).includes(h.note), `the dir note still goes out: ${JSON.stringify(r)}`)
  assert.deepEqual(h.record(), { v: 1, ts: iso(T0 - HOUR), source: 'startup', session: 's1' })
  await h.fire('resume', T0)
  assert.deepEqual(h.record(), { v: 1, ts: iso(T0), source: 'resume', session: 's1' }, 'a resume replaces the record with the resume time')
})

test('the session-start hook leaves the record alone on clear and compact, and a subagent start writes nothing', async () => {
  const h = await sessionStartHook()
  await h.fire('startup', T0 - HOUR)
  await h.fire('clear', T0 - 30 * MIN)
  await h.fire('compact', T0)
  assert.deepEqual(h.record(), { v: 1, ts: iso(T0 - HOUR), source: 'startup', session: 's1' }, 'clear and compact keep the process and its agents, so the start does not move')
  const sub = await sessionStartHook()
  await sub.fire('startup', T0, { agent_id: 'A1', agent_type: 'kit:builder' })
  assert.equal(sub.record(), undefined, "a subagent's SessionStart writes no record")
})

test('the session-start hook fails open when the record cannot be written', async () => {
  const h = await sessionStartHook({ writeFails: true })
  const r = await h.fire('startup', T0)
  assert.ok((r.additionalContext ?? []).includes(h.note), `the dir note still goes out: ${JSON.stringify(r)}`)
})

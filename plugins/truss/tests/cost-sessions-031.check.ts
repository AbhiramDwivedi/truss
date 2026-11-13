// @ts-nocheck
// truss 0.31.0 item 9: the cost meter of a resumed run. A run dir D is named after the session that started it, and a second PM session
// can resume it (wave 4: pm4 started D, pm5 finished it). The sweep must read the transcripts of every session that ran the run, not only
// the one D is named after. A session that runs a state-changing factory command on D (admit here) is recorded in D/sessions/, and the
// sweep reads the union of the recorded sessions' transcripts, once per msgId. Written before the fix: the second session's rows are
// missing on the old code. Synthetic transcripts and a synthetic price table only (one rate unit per million tokens).

import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { REAL_PLUGIN, crew, mkRepo, mkTrussDir, planObj, runCli, tmp, writePlan } from './fixtures/workflow-run/harness.ts'

const FACTORY = `${REAL_PLUGIN}/bin/factory.ts`
const rp = (p: string): string => realpathSync(p).replace(/\\/g, '/')
const near = (a: unknown, b: number, what: string): void => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-6, `${what}: expected ${b}, got ${a}`)
const PRICE = { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0.1, cacheWrite5mPerMTok: 1.5, cacheWrite1hPerMTok: 2.5 }
const PROJ = '-work-proj'
const SID_B = 'b0000000-0000-4000-8000-00000000000b'
const SID_C = 'c0000000-0000-4000-8000-00000000000c'

// one assistant line with `mtok` million input tokens, so its cost is exactly mtok units
const line = (id: string, mtok: number, ts: string): string =>
  JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model: 'test-model', role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: mtok * 1_000_000, output_tokens: 0 } } }) + '\n'
const costState = (usd: number, ts: string): string => JSON.stringify({ type: 'cost-state', timestamp: ts, totalCostUSD: usd }) + '\n'

function world() {
  const repo = rp(mkRepo({ config: { architecture: 'docs/architecture.md', adr: 'docs/adr', pricing: { 'test-model': PRICE } } }))
  const dir = rp(mkTrussDir())
  const root = rp(tmp('cost-sess-tr-'))
  writePlan(dir, planObj([crew('bcrew')]))
  const sidA = path.basename(dir)
  mkdirSync(`${root}/${PROJ}`, { recursive: true })
  // session A started the run: one main-thread message and a cost-state estimate of 2
  writeFileSync(`${root}/${PROJ}/${sidA}.jsonl`, line('msg_a1', 1, '2026-11-12T10:00:00.000Z') + costState(2, '2026-11-12T10:00:02.000Z'))
  // session B resumed it: one main-thread message, a cost-state estimate of 3, and a Workflow agent of crew bcrew
  writeFileSync(`${root}/${PROJ}/${SID_B}.jsonl`, line('msg_b1', 2, '2026-11-12T11:00:00.000Z') + costState(3, '2026-11-12T11:00:02.000Z'))
  const wf = `${root}/${PROJ}/${SID_B}/subagents/workflows/wf_9`
  mkdirSync(wf, { recursive: true })
  writeFileSync(`${wf}/agent-wfb.jsonl`, line('msg_b2', 4, '2026-11-12T11:01:00.000Z'))
  writeFileSync(`${dir}/events.jsonl`, JSON.stringify({ v: 1, ts: '2026-11-12T11:00:30.000Z', event: 'spawn', crew: 'bcrew', agent: 'bcrew', agentId: 'wfb', type: 'workflow-crew', by: 'factory' }) + '\n')
  // session C only looks at the run (factory cost); its spend is its own, never the run's
  writeFileSync(`${root}/${PROJ}/${SID_C}.jsonl`, line('msg_c1', 8, '2026-11-12T12:00:00.000Z'))
  return { repo, dir, root, sidA, env: (sid: string) => ({ TRUSS_TRANSCRIPTS_ROOT: root, CLAUDE_CODE_SESSION_ID: sid }) }
}
type World = ReturnType<typeof world>
const cost = (w: World, sid: string) => runCli(FACTORY, 'cost', ['--dir', w.dir, '--repo', w.repo], w.repo, w.env(sid))
const admit = (w: World, sid: string) => runCli(FACTORY, 'admit', ['--dir', w.dir, '--repo', w.repo, '--slug', 'bcrew'], w.repo, w.env(sid))
const rows = (w: World): any[] => (existsSync(`${w.dir}/usage.jsonl`) ? readFileSync(`${w.dir}/usage.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const ids = (w: World): string[] => rows(w).map((r) => r.msgId).sort()

test('cost-sessions: a run resumed by a second session sweeps both sessions, once per msgId', () => {
  const w = world()
  // the starting session works on its own run dir: nothing to record
  const a = admit(w, w.sidA)
  assert.equal(a.status, 0, a.stdout + a.stderr)
  // the resuming session attaches by running a state-changing command on the run dir
  const b = admit(w, SID_B)
  assert.equal(b.status, 0, b.stdout + b.stderr)
  const r1 = cost(w, SID_B)
  assert.equal(r1.status, 0, r1.stdout + r1.stderr)
  assert.deepEqual(ids(w), ['msg_a1', 'msg_b1', 'msg_b2'], "the resuming session's main and Workflow rows are swept with the starting session's")
  const bySid = Object.fromEntries(rows(w).map((r) => [r.msgId, r.sid]))
  assert.deepEqual(bySid, { msg_a1: w.sidA, msg_b1: SID_B, msg_b2: SID_B }, 'each row carries the session whose transcript it came from')
  near(r1.json?.session?.usd, 7, 'session spend covers both sessions (1 + 2 + 4)')
  near(r1.json?.crews?.find((c: any) => c.crew === 'bcrew')?.usd, 4, "the resuming session's Workflow agent is attributed to its crew")
  near(r1.json?.claudeCodeEstimateUsd, 5, "the Claude Code estimate is each session's newest estimate, summed (2 + 3)")
  assert.equal(r1.json?.sweep?.found, 3, 'found counts the transcripts of both sessions')

  // a re-sweep adds nothing; a new line in the resuming session is picked up from its cursor
  const r2 = cost(w, SID_B)
  assert.equal(r2.status, 0, r2.stdout + r2.stderr)
  assert.equal(r2.json?.sweep?.rows, 0, 'a re-sweep finds no new rows')
  appendFileSync(`${w.root}/${PROJ}/${SID_B}.jsonl`, line('msg_b3', 1, '2026-11-12T11:30:00.000Z'))
  const r3 = cost(w, SID_B)
  assert.equal(r3.json?.sweep?.rows, 1, 'only the appended line is new')
  const all = rows(w).map((r) => r.msgId)
  assert.equal(new Set(all).size, all.length, 'no msgId is recorded twice')
  assert.deepEqual(ids(w), ['msg_a1', 'msg_b1', 'msg_b2', 'msg_b3'])
})

test('cost-sessions: a session that only reads the run is not recorded and its spend is not swept', () => {
  const w = world()
  const r = cost(w, SID_C)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(ids(w), ['msg_a1'], 'factory cost from another session does not attach it')
  assert.ok(!existsSync(`${w.dir}/sessions`) || readdirSync(`${w.dir}/sessions`).length === 0, 'no session is recorded')
})

test('cost-sessions: the attach record is one file per session, written once, and the starting session is never recorded', () => {
  const w = world()
  assert.equal(admit(w, w.sidA).status, 0)
  assert.ok(!existsSync(`${w.dir}/sessions/${w.sidA}.json`), 'the session the run dir is named after needs no record')
  assert.equal(admit(w, SID_B).status, 0)
  const first = readFileSync(`${w.dir}/sessions/${SID_B}.json`, 'utf8')
  const rec = JSON.parse(first)
  assert.equal(rec.sid, SID_B)
  assert.equal(rec.by, 'admit')
  assert.equal(admit(w, SID_B).status, 0)
  assert.equal(readFileSync(`${w.dir}/sessions/${SID_B}.json`, 'utf8'), first, 'a second attach leaves the first record as it is')
  // a session id that is not a safe file name is never recorded
  assert.equal(admit(w, '../evil').status, 0)
  assert.deepEqual(readdirSync(`${w.dir}/sessions`).sort(), [`${SID_B}.json`])
})

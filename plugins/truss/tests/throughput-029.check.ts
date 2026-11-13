// @ts-nocheck
// truss 0.29.0 factory throughput (goal wave5/goal-throughput.md), the factory.ts side: item 5 (a resume carries every unbuilt
// ruling forward), item 4 (heavy slot count) and the Claude 5.5 prices in `factory cost`. Each case failed on the code before
// its fix. The stage.js side (items 1, 6, 7) is in throughput-029-stage.check.ts.
//
// Run with: node --test plugins/truss/tests/throughput-029.check.ts

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  REAL_PLUGIN, addCrewWorktree, appendEvent, crew, factorySpawn, git, mkEnv, mkRepo, mkRun, mkTrussDir, planObj, putFile, runCli, tmp, writeGoal, writePlan,
} from './fixtures/workflow-run/harness.ts'

const HOUR = 3_600_000
const MIN = 60_000
const iso = (ms) => new Date(ms).toISOString()
const say = (r) => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 600)}; stderr ${String(r.stderr).slice(0, 300)}`

// ---------------------------------------------------------------- item 5: answers carry forward

function resumeWorld() {
  const env = mkEnv({ config: { merge: 'sequential', target: 'main' } })
  writePlan(env.dir, planObj([crew('x', { status: 'running' })], { approvedAt: iso(Date.now() - 3 * HOUR) }))
  writeGoal(env.dir, 'x')
  const wt = addCrewWorktree(env.repo, 'x')
  appendEvent(env.dir, factorySpawn('x', iso(Date.now() - 3 * HOUR)))
  mkdirSync(join(env.dir, 'checks'), { recursive: true })
  writeFileSync(join(env.dir, 'checks', 'x-1.json'), JSON.stringify({ command: 'false', exit: 1, head: 'abc', tail: '' }))
  return { env, wt }
}
function memberBranch(wt, name) {
  git(wt, ['checkout', '-q', '-b', name])
  putFile(wt, `members/${name}.txt`, `${name}\n`, `member ${name}`)
  git(wt, ['checkout', '-q', 'truss-x'])
  git(wt, ['merge', '-q', '--no-ff', '-m', `merge ${name}`, name])
}
const member = (task, branch) => ({ task, marker: 'DONE', branch, commit: 'c0ffee', proof: 'ran it', text: 'ok' })
const PLANNER = { tasks: [{ name: 't1', role: 'builder', effort: 'medium', persona: null, files: ['members/**'], reads: [], brief: 'b', after: [] }], stop: null }
function deadRun(env, runId, agents, agoMs) {
  const endMs = Date.now() - agoMs
  return mkRun(env.transcripts, runId, agents.map((a) => ({ startTs: iso(endMs - MIN), endTs: iso(endMs), agentType: 'general-purpose', metaModel: 'sonnet', model: 'claude-sonnet-5-5', effort: 'medium', ...a })), { journalMtimeMs: endMs })
}
const answersFile = (answers) => {
  const p = join(tmp('fcli-ans-'), 'answers.json')
  writeFileSync(p, JSON.stringify(answers))
  return p
}
const resume = (env, run, answers) => env.run('start', { slug: 'x', resume: 'answers', transcript: run.dir, answers: answersFile(answers) })
const entryOf = (r) => r.json.truss.crews[0]
const doneNames = (r) => entryOf(r).done.map((d) => (typeof d === 'string' ? d : d.name))

test('i5 1: a second answers resume keeps the first resume\'s step rulings; the new answers come first', () => {
  const { env, wt } = resumeWorld()
  memberBranch(wt, 'member-a')
  const run = deadRun(env, 'wf_a1', [{ label: 'x-planner', result: PLANNER }, { label: 'x-builder', result: member('t1', 'member-a') }], 10 * MIN)
  const one = resume(env, run, [{ at: 'qc', text: 'ruling A: the empty table is approved' }])
  assert.equal(one.status, 0, say(one))
  const two = resume(env, run, [{ at: 'green', text: 'ruling B: skip the flaky case' }])
  assert.equal(two.status, 0, say(two))
  assert.deepEqual(entryOf(two).answers, [{ at: 'green', text: 'ruling B: skip the flaky case' }, { at: 'qc', text: 'ruling A: the empty table is approved' }])
  // a repeated ruling is not doubled
  const three = resume(env, run, [{ at: 'qc', text: 'ruling A: the empty table is approved' }])
  assert.equal(three.status, 0, say(three))
  assert.deepEqual(entryOf(three).answers, [{ at: 'qc', text: 'ruling A: the empty table is approved' }, { at: 'green', text: 'ruling B: skip the flaky case' }])
})

test('i5 2: a ruling at a task rides along (and keeps the task out of done) until a later run builds that task, then it drops', () => {
  const { env, wt } = resumeWorld()
  memberBranch(wt, 'member-a')
  const run1 = deadRun(env, 'wf_b1', [{ label: 'x-planner', result: PLANNER }, { label: 'x-builder', result: member('t1', 'member-a') }], 20 * MIN)
  const one = resume(env, run1, [{ at: 't1', text: 'use option b' }])
  assert.equal(one.status, 0, say(one))
  assert.deepEqual(doneNames(one), [])
  // the resumed run stopped elsewhere before t1 re-ran: the PM's next answers file names only the new ruling
  const two = resume(env, run1, [{ at: 'qc', text: 'ruling C' }])
  assert.equal(two.status, 0, say(two))
  assert.deepEqual(entryOf(two).answers, [{ at: 'qc', text: 'ruling C' }, { at: 't1', text: 'use option b' }])
  assert.deepEqual(doneNames(two), [], 't1 still has an unbuilt ruling, so it is not done')
  // a later run re-builds t1: its ruling is built and drops; the step ruling stays
  memberBranch(wt, 'member-b')
  const run2 = deadRun(env, 'wf_b2', [{ label: 'x-builder-2', result: member('t1', 'member-b') }], 5 * MIN)
  const three = resume(env, run2, [])
  assert.equal(three.status, 0, say(three))
  assert.deepEqual(entryOf(three).answers, [{ at: 'qc', text: 'ruling C' }])
  assert.deepEqual(doneNames(three), ['t1'])
  const stored = JSON.parse(readFileSync(join(env.dir, 'crews', 'x', 'answers.json'), 'utf8'))
  assert.deepEqual(stored.map((a) => a.at), ['qc'])
})

test('i5 3: a merge-ready resume carries the stored rulings too', () => {
  const { env, wt } = resumeWorld()
  memberBranch(wt, 'member-a')
  const run = deadRun(env, 'wf_c1', [{ label: 'x-planner', result: PLANNER }, { label: 'x-builder', result: member('t1', 'member-a') }], 10 * MIN)
  assert.equal(resume(env, run, [{ at: 'qc', text: 'ruling D' }]).status, 0)
  const stale = env.run('start', { slug: 'x', resume: 'merge-ready' })
  assert.equal(stale.status, 0, say(stale))
  assert.deepEqual(entryOf(stale).answers, [{ at: 'qc', text: 'ruling D' }])
})

// ---------------------------------------------------------------- pricing: the Claude 5.5 family in `factory cost`

// The repo's own .claude/truss.json holds the client's price table (the plugin writes no price). Rates from the claude-api
// skill and platform.claude.com/docs/en/about-claude/pricing, read 2026-11-12.
const REPO_CONFIG = fileURLToPath(new URL('../../../.claude/truss.json', import.meta.url))
function priceWorld() {
  const config = JSON.parse(readFileSync(REPO_CONFIG, 'utf8'))
  const repo = mkRepo({ config: { architecture: 'docs/architecture.md', adr: 'docs/adr', pricing: config.pricing } })
  const dir = mkTrussDir()
  const root = tmp('t029-tr-')
  return { repo, dir, root, sid: basename(dir) }
}
const usageRow = (id, model, u, speed = 'standard') => JSON.stringify({ type: 'assistant', uuid: `u-${id}`, timestamp: '2026-11-12T06:30:00.000Z', message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'a' }], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, speed, ...u } } }) + '\n'
function costOf(w, rows) {
  mkdirSync(join(w.root, '-work-proj'), { recursive: true })
  writeFileSync(join(w.root, '-work-proj', `${w.sid}.jsonl`), rows.join(''))
  const r = runCli(`${REAL_PLUGIN}/bin/factory.ts`, 'cost', ['--dir', w.dir, '--repo', w.repo], w.repo, { TRUSS_TRANSCRIPTS_ROOT: w.root })
  assert.equal(r.status, 0, say(r))
  return r.json?.session?.usd
}
const near = (a, b, what) => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-9, `${what}: expected ${b}, got ${a}`)
const M = 1_000_000

test('pricing 1: factory cost prices Claude Opus 5.5 (standard and fast) and Sonnet 5.5 from the repo config', () => {
  // opus 5.5: 1M in $4 + 1M out $20 + 1M cache read $0.20 + 1M 5m write $5
  near(costOf(priceWorld(), [usageRow('m1', 'claude-opus-5-5', { input_tokens: M, output_tokens: M, cache_read_input_tokens: M, cache_creation_input_tokens: M })]), 29.2, 'opus 5.5')
  // opus 5.5 fast: 1M in $8 + 1M out $40 + 1M 1h write $16
  near(costOf(priceWorld(), [usageRow('m2', 'claude-opus-5-5', { input_tokens: M, output_tokens: M, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: M } }, 'fast')]), 64, 'opus 5.5 fast')
  // sonnet 5.5: 1M in $2 + 1M out $10 + 1M cache read $0.10 + 1M 1h write $4
  near(costOf(priceWorld(), [usageRow('m3', 'claude-sonnet-5-5', { input_tokens: M, output_tokens: M, cache_read_input_tokens: M, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: M } })]), 16.1, 'sonnet 5.5')
})

test('pricing 2: Claude Haiku 5.5 bills a request whose prompt is over 100,000 tokens at the long-context rates', () => {
  // a 100,000-token prompt (60K in + 40K cache read) is at the threshold, not over it: $0.10 and $0.01 rates, plus 1M out at $0.50
  near(costOf(priceWorld(), [usageRow('h1', 'claude-haiku-5-5', { input_tokens: 60_000, cache_read_input_tokens: 40_000, output_tokens: M })]), 0.006 + 0.0004 + 0.5, 'haiku 5.5 at 100K')
  // 100,001 tokens (60,001 in + 40K cache read): every token of the request at $0.50 / $0.05 / $2.50
  near(costOf(priceWorld(), [usageRow('h2', 'claude-haiku-5-5', { input_tokens: 60_001, cache_read_input_tokens: 40_000, output_tokens: M })]), 60_001 * 0.5 / M + 0.002 + 2.5, 'haiku 5.5 over 100K')
  // two requests in one session are priced each on its own
  near(costOf(priceWorld(), [usageRow('h3', 'claude-haiku-5-5', { input_tokens: 200_000 }), usageRow('h4', 'claude-haiku-5-5', { input_tokens: 50_000 })]), 0.1 + 0.005, 'haiku 5.5 per request')
})

test('i5 4: a first answers resume with no store passes its answers through unchanged and writes the store', () => {
  const { env, wt } = resumeWorld()
  memberBranch(wt, 'member-a')
  const run = deadRun(env, 'wf_d1', [{ label: 'x-builder', result: member('t1', 'member-a') }], 10 * MIN)
  const r = resume(env, run, [{ at: 'qc', text: 'only' }])
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(entryOf(r).answers, [{ at: 'qc', text: 'only' }])
  assert.ok(existsSync(join(env.dir, 'crews', 'x', 'answers.json')))
})

// ---------------------------------------------------------------- item 1: --reap-first folds a reap into any command

test('i1 3: --reap-first <slug> reaps before the command, leaves its output unchanged, and reports only a failed reap', async () => {
  const { takeReapFlag, reapFirst } = await import(`${REAL_PLUGIN}/bin/factory.ts`)
  assert.deepEqual(takeReapFlag(['decisions', '--reap-first', 'a', '--dir', 'D']), { slug: 'a', argv: ['decisions', '--dir', 'D'] })
  assert.deepEqual(takeReapFlag(['decisions', '--dir', 'D']), { slug: null, argv: ['decisions', '--dir', 'D'] })
  // heavy: taken before the `--` only; the inner command's argv is never touched
  assert.deepEqual(takeReapFlag(['heavy', '--slug', 'a', '--reap-first', 'a', '--', 'node', 'x']), { slug: 'a', argv: ['heavy', '--slug', 'a', '--', 'node', 'x'] })
  assert.equal(takeReapFlag(['heavy', '--slug', 'a', '--', 'node', 'x', '--reap-first', 'b']).slug, null)
  // a reap that cannot run returns {error}, never throws
  const bad = reapFirst(['decisions'], 'a')
  assert.equal(typeof bad.error, 'string', JSON.stringify(bad))

  const dir = mkTrussDir()
  const repo = mkRepo()
  const plain = runCli(`${REAL_PLUGIN}/bin/factory.ts`, 'decisions', ['--dir', dir, '--repo', repo])
  const folded = runCli(`${REAL_PLUGIN}/bin/factory.ts`, 'decisions', ['--reap-first', 'a', '--dir', dir, '--repo', repo, '--status-line'])
  assert.equal(folded.status, 0, say(folded))
  assert.equal(folded.stdout.split('\n')[0], plain.stdout.split('\n')[0], 'a clean reap leaves the output as it was')
  assert.ok(folded.stdout.trimEnd().split('\n').at(-1).startsWith('truss-status: '), 'the status line stays last')
})

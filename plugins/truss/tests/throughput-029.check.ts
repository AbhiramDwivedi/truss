// @ts-nocheck
// truss 0.29.0 factory throughput (goal wave5/goal-throughput.md), the factory.ts side: item 5 (a resume carries every unbuilt
// ruling forward), item 4 (heavy slot count) and the Claude 5.5 prices in `factory cost`. Each case failed on the code before
// its fix. The stage.js side (items 1, 6, 7) is in throughput-029-stage.check.ts.
//
// Run with: node --test plugins/truss/tests/throughput-029.check.ts

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
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

// ---------------------------------------------------------------- item 1: one gates command for the steps before QC

function gatesWorld() {
  const env = mkEnv({ config: { merge: 'sequential', target: 'main' }, useRealPlugin: true })
  writePlan(env.dir, planObj([crew('s', { owns: ['src/s/**'], status: 'running' })]))
  writeGoal(env.dir, 's')
  const wt = addCrewWorktree(env.repo, 's')
  putFile(wt, 'src/s/a.ts', 'a\n', 'work\n\nTruss-Crew: s\nTruss-Role: builder')
  return { env, wt }
}
const ALL = ['--steps', 'green,owns,tests,lint,admit', '--admit-label', 's-qc', '--admit-title', 'QC s', '--admit-wait-ms', '0']
const statusOf = (r) => JSON.parse(r.stdout.trimEnd().split('\n').at(-1).slice('truss-status: '.length))

test('i1 4: factory gates runs green, owns-check, tests-check, knowledge-lint and admit in one call, each body as its own command prints it', () => {
  const { env, wt } = gatesWorld()
  const r = env.run('gates', { slug: 's', cwd: wt, 'reap-first': 's', 'status-line': true }, ALL)
  assert.equal(r.status, 0, say(r))
  const j = JSON.parse(r.stdout.split('\n')[0])
  assert.equal(j.ok, true, say(r))
  assert.equal(j.stopped, null)
  assert.deepEqual(j.gates, { green: true, owns: true, tests: true, lint: true, admit: true })
  assert.deepEqual(Object.keys(j.steps), ['green', 'owns', 'tests', 'lint', 'admit'])
  const head = git(wt, ['rev-parse', 'HEAD'])
  assert.equal(j.steps.green.head, head)
  assert.equal(typeof j.steps.green.heavy.waitedMs, 'number', 'green runs through the heavy slot')
  assert.equal(j.head, head, 'green\'s head rides at the top, for the status line')
  // the other steps print what their own command prints
  for (const [step, cmd, flags] of [['owns', 'owns-check', {}], ['tests', 'tests-check', {}], ['lint', 'knowledge-lint', {}]]) {
    const one = env.run(cmd, { slug: 's', ...flags })
    assert.deepEqual(j.steps[step], JSON.parse(one.stdout.split('\n')[0]), step)
    assert.equal(j.codes[step], one.status, step)
  }
  assert.equal(j.steps.admit.admitted, true)
  assert.deepEqual(statusOf(r), { ok: true, head, gates: j.gates, stopped: null })
})

test('i1 5: factory gates stops at the first unmet step and exits with its code; a bad step is a usage error', () => {
  const { env, wt } = gatesWorld()
  putFile(wt, 'lib/out.ts', 'x\n', 'outside')
  const r = env.run('gates', { slug: 's', cwd: wt, 'status-line': true }, ALL)
  assert.equal(r.status, 1, say(r))
  const j = JSON.parse(r.stdout.split('\n')[0])
  assert.equal(j.ok, false)
  assert.equal(j.stopped, 'owns')
  assert.deepEqual(j.gates, { green: true, owns: false })
  assert.deepEqual(j.steps.owns.outside, ['lib/out.ts'])
  assert.ok(!('tests' in j.steps) && !('admit' in j.steps), 'nothing after the unmet step runs')
  assert.deepEqual(statusOf(r).gates, { green: true, owns: false })
  assert.equal(statusOf(r).stopped, 'owns')
  // the order given is the order run: tests first, then owns stops it
  const t = env.run('gates', { slug: 's', steps: 'tests,owns,admit' })
  assert.deepEqual(JSON.parse(t.stdout.split('\n')[0]).gates, { tests: true, owns: false })
  // a red green check stops it first
  const red = env.run('gates', { slug: 's', cwd: wt, steps: 'green,owns', expect: 'red' })
  assert.equal(JSON.parse(red.stdout.split('\n')[0]).stopped, 'green', say(red))
  for (const steps of ['owns,bogus', 'owns,owns', '']) assert.equal(env.run('gates', { slug: 's', steps }).status, 2, steps)
})

// ---------------------------------------------------------------- item 4: a configurable heavy slot count

test('i4 1: the host default is max(1, min(4, floor(cpus/4), floor(totalGB/8)))', async () => {
  const { defaultHeavySlots } = await import(`${REAL_PLUGIN}/resources/index.ts`)
  const GB = 2 ** 30
  assert.equal(defaultHeavySlots(4, 16 * GB), 1)
  assert.equal(defaultHeavySlots(2, 64 * GB), 1, 'never below 1')
  assert.equal(defaultHeavySlots(8, 32 * GB), 2)
  assert.equal(defaultHeavySlots(16, 24 * GB), 3, 'memory bounds it')
  assert.equal(defaultHeavySlots(64, 512 * GB), 4, 'never above 4')
  assert.ok(defaultHeavySlots() >= 1 && defaultHeavySlots() <= 4, 'the real host gives 1 to 4')
})

test('i4 2: truss.json heavySlots wins, then TRUSS_HEAVY_SLOTS, then the host; a bad value falls through; the schema declares the key', async () => {
  const { heavySlotsOf } = await import(`${REAL_PLUGIN}/bin/factory.ts`)
  const host = () => 3
  assert.equal(heavySlotsOf({ heavySlots: 2 }, { TRUSS_HEAVY_SLOTS: '5' }, host), 2)
  assert.equal(heavySlotsOf({}, { TRUSS_HEAVY_SLOTS: '5' }, host), 5)
  assert.equal(heavySlotsOf({}, {}, host), 3)
  for (const bad of [0, -1, 1.5, '2', 17, null]) assert.equal(heavySlotsOf({ heavySlots: bad }, {}, host), 3, `heavySlots ${JSON.stringify(bad)}`)
  assert.equal(heavySlotsOf({}, { TRUSS_HEAVY_SLOTS: '0' }, host), 3)
  const schema = JSON.parse(readFileSync(`${REAL_PLUGIN}/docs/truss-config.schema.json`, 'utf8'))
  assert.deepEqual({ type: schema.properties.heavySlots?.type, minimum: schema.properties.heavySlots?.minimum }, { type: 'integer', minimum: 1 })
})

test('i4 3: with two slots two takers hold heavy.lock and heavy-2.lock, a third gets null, and a release frees only its own slot', async () => {
  const { takeHeavySlot, releaseHeavySlot } = await import(`${REAL_PLUGIN}/resources/index.ts`)
  const dir = mkTrussDir()
  const a = takeHeavySlot(dir, { slug: 'a' }, process.platform, 2)
  const b = takeHeavySlot(dir, { slug: 'b' }, process.platform, 2)
  assert.equal(typeof a, 'string')
  assert.equal(typeof b, 'string')
  assert.ok(existsSync(join(dir, 'resources', 'heavy.lock')) && existsSync(join(dir, 'resources', 'heavy-2.lock')))
  assert.equal(takeHeavySlot(dir, { slug: 'c' }, process.platform, 2), null, 'the third waits')
  assert.equal(takeHeavySlot(dir, { slug: 'c' }), null, 'one slot by default')
  releaseHeavySlot(dir, b)
  assert.ok(existsSync(join(dir, 'resources', 'heavy.lock')), 'a\'s slot stays held')
  assert.ok(!existsSync(join(dir, 'resources', 'heavy-2.lock')), 'b\'s slot is freed')
  const c = takeHeavySlot(dir, { slug: 'c' }, process.platform, 2)
  assert.equal(typeof c, 'string', 'the third takes the freed slot')
  releaseHeavySlot(dir, 'not-a-token')
  assert.ok(existsSync(join(dir, 'resources', 'heavy.lock')) && existsSync(join(dir, 'resources', 'heavy-2.lock')), 'a stranger token frees nothing')
})

test('i4 4: through the CLI, two crews run heavy at once under heavySlots 2 and the third waits until its limit', async () => {
  const repo = mkRepo({ config: { heavySlots: 2 } })
  const dir = mkTrussDir()
  const scratch = tmp('i4-heavy-')
  const ok = join(scratch, 'ok.json')
  writeFileSync(ok, JSON.stringify({ freeMB: 9000, totalMB: 16000 }))
  const go = join(scratch, 'go')
  const env = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.TRUSS_HEAVY_SLOTS
  delete env.TRUSS_MIN_FREE_MB
  env.TRUSS_SAMPLE = ok
  // each command marks that it started, then holds its slot until the test writes `go`
  const hold = (n) => `const fs=require('fs');fs.writeFileSync(${JSON.stringify(join(scratch, `started-${n}`))},'');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(go)})){clearInterval(t);console.log(JSON.stringify({ok:true}))}},20)`
  const args = (slug, more = []) => [`${REAL_PLUGIN}/bin/factory.ts`, 'heavy', '--dir', dir, '--repo', repo, '--slug', slug, '--label', slug, '--cwd', repo, ...more, '--']
  const runs = ['a', 'b'].map((s) => new Promise((res) => {
    const c = spawn(process.execPath, [...args(s), process.execPath, '-e', hold(s)], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    c.stdout.on('data', (d) => { out += d })
    c.on('exit', (code) => res({ code, out }))
  }))
  try {
    const end = Date.now() + 20000
    while (!(existsSync(join(scratch, 'started-a')) && existsSync(join(scratch, 'started-b'))) && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
    assert.ok(existsSync(join(scratch, 'started-a')) && existsSync(join(scratch, 'started-b')), 'both crews hold a slot at once')
    const third = spawnSync(process.execPath, [...args('c', ['--wait-ms', '1200']), process.execPath, '-e', 'console.log(JSON.stringify({ok:true}))'], { cwd: repo, env, encoding: 'utf8', timeout: 30000 })
    assert.equal(third.status, 1, say(third))
    const j = JSON.parse(third.stdout.split('\n')[0])
    assert.equal(j.heavy.ran, false, 'the third crew waits while both slots are held')
  } finally {
    writeFileSync(go, '')
  }
  for (const r of await Promise.all(runs)) {
    assert.equal(r.code, 0, r.out)
    assert.equal(JSON.parse(r.out.split('\n')[0]).heavy.slots, 2)
  }
})

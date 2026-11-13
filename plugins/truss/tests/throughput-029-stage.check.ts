// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss 0.29.0 factory throughput (goal wave5/goal-throughput.md), the stage.js side: item 7 (the stress test runs before the
// knowledge step), item 6 (knowledge and its lint re-run after every fix round, the writer looping until the lint is clean) and
// item 1 (fewer runner spawns). Each case failed on the code before its fix.
//
// Run with: node --test plugins/truss/tests/throughput-029-stage.check.ts

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')
const STAGE = `${PLUGIN}/workflows/stage.js`
const t = (name, fn) => test(name, { timeout: 90000 }, fn)

const ROLES = {
  designer: { agentType: 'truss:design-engineer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  checker: { agentType: 'truss:checking-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  planner: { agentType: 'truss:planning-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  tester: { agentType: 'proj:tester', model: 'sonnet', effort: 'medium', isolation: 'worktree' },
  builder: { agentType: 'proj:builder', model: 'sonnet', effort: 'low', isolation: 'worktree' },
  resolver: { agentType: 'proj:resolver', model: 'sonnet', effort: 'medium', isolation: 'none' },
  writer: { agentType: 'truss:writer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  rca: { agentType: 'general-purpose', model: 'opus', effort: 'medium', isolation: 'none' },
  stress: { agentType: 'truss:stress-engineer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  qc: { agentType: 'truss:qc-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  runner: { agentType: 'general-purpose', model: 'sonnet', effort: 'low', isolation: 'none' },
  ux: { agentType: 'truss:ux-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  po: { agentType: 'general-purpose', model: 'opus', effort: 'medium', isolation: 'none' },
}

// ---------------------------------------------------------------- stage.js harness (as tests/crew-knowledge.check.ts)

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const tick = () => new Promise((r) => setImmediate(r))
const ticks = async (n) => {
  for (let i = 0; i < n; i++) await tick()
}
const rj = (obj, exit = 0) => ({ exit, stdout: JSON.stringify(obj) })
const HEAD = 'a1'.repeat(20)
const BASE = 'd4'.repeat(20)
const PATCH = 'e5'.repeat(20)

async function exec(args, o = {}) {
  const body = readFileSync(STAGE, 'utf8').replace(/^\s*export\s+const\s+meta\b/m, 'const meta')
  const calls = []
  const unscripted = []
  const counters = {}
  const logs = []
  const agent = async (prompt, opts = {}) => {
    const call = { prompt, opts, label: opts.label, i: calls.length }
    calls.push(call)
    await tick()
    if (/-runner(-\d+)?$/.test(String(opts.label))) {
      const m = prompt.match(/factory\.ts\s+(admit|reap|check|integrate|owns-check|tests-check|sync|crew-decision|decision-replies|decision-ack|decision-checkpoint|crew-learned|knowledge-commit|knowledge-lint|decisions)\b([^\n]*)/)
      if (!m) {
        unscripted.push(`${opts.label} (no factory.ts command in prompt)`)
        throw new Error(`unparsable runner prompt for label ${opts.label}`)
      }
      const cmd = m[1]
      const flag = (name) => (m[2].match(new RegExp(`--${name}(?:\\s+|=)([^\\s\`]+)`)) || [])[1]
      const slug = flag('slug') ?? flag('crew')
      const expect = flag('expect')
      const branch = flag('branch')
      const key = cmd === 'check' ? `check:${expect}` : cmd === 'integrate' ? `integrate:${branch}` : cmd
      const name = `runner:${slug}:${key}`
      call.runner = { cmd, slug, expect, branch, key, name, rest: m[2] }
      const n = (counters[name] = (counters[name] ?? -1) + 1)
      let out = o.runner ? await o.runner({ cmd, key, slug, expect, branch, n, prompt, call }) : undefined
      if (out === undefined) {
        const plain = expect === 'red' ? { ok: true } : { ok: true, head: HEAD }
        out =
          cmd === 'admit' ? rj({ admitted: true, parallelism: 4, running: 0, freeMB: 8000, minFreeMB: 2048 }) : cmd === 'reap' ? rj({ reaped: [], skipped: [] }) : cmd === 'check' ? rj(plain) : cmd === 'integrate' ? rj({ merged: true }) : cmd === 'owns-check' ? rj({ ok: true, outside: [] }) : cmd === 'tests-check' ? rj({ ok: true, tests: [] }) : cmd === 'crew-decision' ? rj({ id: `d${n + 1}` }) : cmd === 'decision-replies' ? rj([]) : cmd === 'decision-ack' ? rj({ acked: [], already: [] }) : cmd === 'decision-checkpoint' || cmd === 'crew-learned' || cmd === 'knowledge-commit' ? rj({ ok: true }) : cmd === 'decisions' ? rj({ decisions: [] }) : rj({ merged: true })
      }
      await ticks(1)
      return out
    }
    const labels = o.labels ?? {}
    if (!Object.hasOwn(labels, opts.label)) {
      unscripted.push(String(opts.label))
      throw new Error(`unscripted label: ${opts.label}`)
    }
    const h = labels[opts.label]
    const v = typeof h === 'function' ? await h(call, calls) : h
    await ticks(2)
    return v === null || v === undefined ? v : structuredClone(v)
  }
  const parallel = async (thunks) => Promise.all(thunks.map(async (th) => { try { return await (typeof th === 'function' ? th() : th) } catch { return null } }))
  const pipeline = async (items, ...stages) => Promise.all(items.map(async (item, i) => { try { let prev = item; for (const st of stages) prev = await st(prev, item, i); return prev } catch { return null } }))
  let result
  let error
  try {
    result = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'allowance', body)(agent, parallel, pipeline, () => {}, (m) => logs.push(m), structuredClone(args), {})
  } catch (e) {
    error = e
  }
  return { result, error, calls, unscripted, logs, labels: calls.map((c) => c.label) }
}

const PASS = `VERDICT: PASS\n\n## Proof checked\nHead: ${HEAD}\nPatch: ${PATCH}\n`
const FAIL = 'VERDICT: FAIL\n\n## Findings\n- src/ui/a.ts: the export button is wrong\n'
const done = (branch, extra = {}) => ({ task: 'whatever', marker: 'DONE', branch, commit: 'c0'.repeat(20), proof: 'PROOF-' + branch, text: 'finished ' + branch, ...extra })
const TT = { name: 'write-tests', role: 'tester', effort: 'medium', persona: null, files: ['tests/a.check.ts'], reads: [], brief: 'BRIEF-TT', after: [] }
const TB = { name: 'build-ui', role: 'builder', effort: 'low', persona: null, files: ['src/ui/a.ts'], reads: [], brief: 'BRIEF-TB', after: ['write-tests'] }
const PLAN = { tasks: [TT, TB], stop: null }
const ITEM = { kind: 'feature', text: 'export button lives in ExportMenu', source: 'src/ui/a.ts:10' }
const FIX_ITEM = { kind: 'persona', text: 'the export fix needs the menu reset', source: 'src/ui/a.ts:40' }

const OLD = (o = {}) => ({
  slug: 'a', stage: 1, goalFile: '/proj/.truss/goals/a.md', goal: 'GOAL-TEXT', owns: ['src/**', 'tests/*.ts'],
  acceptanceTest: 'node --test tests/a.check.ts', highImpact: [], stressTest: false, scope: 'SCOPE: build a',
  worktree: '/wt/a', branch: 'truss/a', base: BASE, architecture: '/proj/docs/ARCH.md', adrs: [],
  resume: null, tasks: [], done: [], answers: [], spent: 0, labelFrom: {}, ...o,
})
async function runStage(crews, o = {}) {
  const args = { truss: { kind: 'stage', dir: '/proj/.truss', repo: '/proj', plugin: PLUGIN, target: 'main', reworkAllowance: 3, roles: ROLES, scriptPath: STAGE, crews } }
  const r = await exec(args, o)
  if (r.error) throw r.error
  return r
}
const labelsFor = (o = {}) => ({ 'a-planner': PLAN, 'a-tester': done('feat/t'), 'a-builder': done('feat/b', { learned: [ITEM] }), 'a-writer': done('feat/k'), 'a-qc': PASS, ...o })
const why = (r) => `result ${JSON.stringify(r.result).slice(0, 600)}; labels ${r.labels.join(',')}; unscripted ${r.unscripted.join(',')}`
const resultOf = (r) => r.result.find((x) => x.slug === 'a')
const passed = (r) => assert.equal(resultOf(r).state, 'passed', why(r))
const indexOf = (r, label) => r.calls.findIndex((c) => c.label === label)
const callOf = (r, label) => r.calls.find((c) => c.label === label)
const writers = (r) => r.labels.filter((l) => /^a-writer(-\d+)?$/.test(l))
const lints = (r) => r.calls.filter((c) => c.runner && c.runner.cmd === 'knowledge-lint')
// green moves the head each time, so a lint after a writer run is a fresh lint, not the cached one
const movingGreen = ({ cmd, expect, n }) => (cmd === 'check' && expect === 'green' ? rj({ ok: true, head: `${String(n).padStart(2, '0')}`.repeat(20) }) : undefined)
const LINT_FAIL = { ok: false, failures: [{ check: 'verified', path: 'docs/knowledge/x.md', message: 'sources changed since verified', new: true }], warnings: [] }
const LINT_OK = { ok: true, failures: [], warnings: [] }

// ---------------------------------------------------------------- item 7: the stress test before the knowledge step

t('i7 1: the stress test and its fix run before the knowledge writer, which records the stress fixer\'s learned item', async () => {
  const labels = labelsFor({ 'a-stress': 'STRESSTEST: 1 findings\n\n## Findings\n- src/ui/a.ts: crashes on an empty list\n', 'a-builder-2': done('feat/sfix', { learned: [FIX_ITEM] }) })
  const r = await runStage([OLD({ stressTest: true })], { labels })
  passed(r)
  assert.ok(indexOf(r, 'a-stress') < indexOf(r, 'a-writer'), r.labels.join(','))
  assert.ok(indexOf(r, 'a-builder-2') < indexOf(r, 'a-writer'), 'the stress fix lands before the docs are written')
  assert.ok(callOf(r, 'a-writer').prompt.includes(FIX_ITEM.text), 'the stress fixer\'s item reaches the knowledge writer')
  assert.equal(resultOf(r).unrecorded, undefined)
  assert.deepEqual(writers(r), ['a-writer'])
})

// ---------------------------------------------------------------- item 6: knowledge and lint after every fix round

t('i6 1: after a QC fix round the knowledge writer runs again on the fix diff, before the next QC, and records the fixer\'s item', async () => {
  const labels = labelsFor({ 'a-qc': FAIL, 'a-builder-2': done('feat/fix', { learned: [FIX_ITEM] }), 'a-writer-2': done('feat/k2'), 'a-qc-2': PASS })
  const r = await runStage([OLD()], { labels, runner: movingGreen })
  passed(r)
  assert.deepEqual(writers(r), ['a-writer', 'a-writer-2'])
  assert.ok(indexOf(r, 'a-builder-2') < indexOf(r, 'a-writer-2') && indexOf(r, 'a-writer-2') < indexOf(r, 'a-qc-2'), r.labels.join(','))
  const p = callOf(r, 'a-writer-2').prompt
  assert.ok(p.includes('Why this run: a fix round (QC findings)'), p.slice(0, 2000))
  assert.ok(p.includes(FIX_ITEM.text))
  assert.ok(!p.includes(ITEM.text), 'the re-run lists only the items not yet recorded')
  assert.equal(resultOf(r).unrecorded, undefined)
  assert.deepEqual(resultOf(r).knowledge, { items: 2, ran: true, sourceChanges: 0 })
  // the lint runs again before the second QC (the knowledge writer moved the head)
  const lintAfterFix = r.calls.findIndex((c, i) => i > indexOf(r, 'a-writer-2') && c.runner && c.runner.cmd === 'knowledge-lint')
  assert.ok(lintAfterFix > 0 && lintAfterFix < indexOf(r, 'a-qc-2'), 'a lint between the re-run and QC 2')
})

t('i6 2: a QC fix round with no learned item still re-runs the knowledge writer when the step ran before', async () => {
  const labels = labelsFor({ 'a-qc': FAIL, 'a-builder-2': done('feat/fix'), 'a-writer-2': done('feat/k2'), 'a-qc-2': PASS })
  const r = await runStage([OLD()], { labels, runner: movingGreen })
  passed(r)
  assert.deepEqual(writers(r), ['a-writer', 'a-writer-2'])
  // a crew whose knowledge step never applied (nothing learned, nothing moved) gets no writer on a fix round either
  const plain = await runStage([OLD()], { labels: labelsFor({ 'a-builder': done('feat/b'), 'a-qc': FAIL, 'a-builder-2': done('feat/fix'), 'a-qc-2': PASS }) })
  passed(plain)
  assert.deepEqual(writers(plain), [])
})

t('i6 3: a lint with new failures sends the writer back with them, and QC runs once the lint is clean', async () => {
  const runner = (c) => (c.cmd === 'knowledge-lint' ? rj(c.n === 0 ? LINT_FAIL : LINT_OK) : movingGreen(c))
  const r = await runStage([OLD()], { labels: labelsFor({ 'a-writer-2': done('feat/lint') }), runner })
  passed(r)
  assert.deepEqual(writers(r), ['a-writer', 'a-writer-2'])
  const p = callOf(r, 'a-writer-2').prompt
  assert.ok(p.includes('the knowledge lint failed'), p.slice(0, 2000))
  assert.ok(p.includes('docs/knowledge/x.md: sources changed since verified'))
  assert.equal(lints(r).length, 2)
  assert.ok(indexOf(r, 'a-writer-2') < indexOf(r, 'a-qc'))
  assert.ok(callOf(r, 'a-qc').prompt.includes('Knowledge lint (factory knowledge-lint): no failures and no warnings.'))
})

t('i6 4: the lint loop is bounded: after two writer runs QC gets the failures that remain', async () => {
  const runner = (c) => (c.cmd === 'knowledge-lint' ? rj(LINT_FAIL) : movingGreen(c))
  const r = await runStage([OLD()], { labels: labelsFor({ 'a-writer-2': done('feat/l2'), 'a-writer-3': done('feat/l3') }), runner })
  passed(r)
  assert.deepEqual(writers(r), ['a-writer', 'a-writer-2', 'a-writer-3'])
  assert.equal(lints(r).length, 3)
  assert.ok(callOf(r, 'a-qc').prompt.includes("New failures (this crew's diff caused them; FAIL on each, quoting it):"))
})

// ---------------------------------------------------------------- item 1: fewer runner spawns

const runners = (r) => r.calls.filter((c) => c.runner)
const isMember = (c) => !c.runner

t('i1 1: the reap after each member rides on the crew\'s next factory call; only the crew\'s end reaps alone (32 runner spawns down to 24)', async () => {
  const labels = labelsFor({ 'a-stress': 'STRESSTEST: 1 findings\n\n## Findings\n- src/ui/a.ts: crashes on an empty list\n', 'a-builder-2': done('feat/sfix', { learned: [FIX_ITEM] }) })
  const r = await runStage([OLD({ stressTest: true })], { labels })
  passed(r)
  const reaps = runners(r).filter((c) => c.runner.cmd === 'reap')
  assert.equal(reaps.length, 1, `one standalone reap, got ${reaps.length}`)
  assert.equal(reaps[0], r.calls.at(-1), 'the standalone reap is the crew-end one')
  // every member spawn is followed by a call carrying --reap-first a before the next member, or by the crew-end reap
  r.calls.forEach((c, k) => {
    if (!isMember(c)) return
    let next = r.calls.findIndex((x, j) => j > k && isMember(x))
    if (next < 0) next = r.calls.length
    const tail = r.calls.slice(k + 1, next)
    assert.ok(tail.some((x) => x.runner && (/ --reap-first a\b/.test(x.prompt) || x.runner.cmd === 'reap')), `${c.label} is not followed by a reap`)
  })
  // ADR-0046 item 1, measured: this crew cost 32 runner spawns before the change (31 before items 6 and 7)
  assert.ok(runners(r).length <= 24, `runner spawns: ${runners(r).length}`)
})

t('i1 2: green and the tests check are skipped while the crew head has not moved', async () => {
  // the QC fixer commits nothing: integrate reports the same head, so the green check and the scope checks are not re-run
  const runner = ({ cmd }) => (cmd === 'integrate' ? rj({ merged: true, head: HEAD }) : undefined)
  const labels = labelsFor({ 'a-builder': done('feat/b'), 'a-qc': FAIL, 'a-builder-2': done('feat/fix'), 'a-qc-2': PASS })
  const r = await runStage([OLD()], { labels, runner })
  passed(r)
  const between = r.calls.slice(indexOf(r, 'a-builder-2'), indexOf(r, 'a-qc-2')).filter((c) => c.runner).map((c) => c.runner.key)
  for (const k of ['check:green', 'owns-check', 'tests-check']) assert.ok(!between.includes(k), `${k} re-ran on an unmoved head: ${between.join(',')}`)
  assert.ok(r.logs.some((m) => /green check skipped/.test(m)), r.logs.join('\n'))
  // a fixer that moves the head gets the checks again
  const moving = await runStage([OLD()], { labels, runner: ({ cmd, branch }) => (cmd === 'integrate' ? rj({ merged: true, head: branch === 'feat/fix' ? 'f9'.repeat(20) : HEAD }) : undefined) })
  passed(moving)
  const again = moving.calls.slice(indexOf(moving, 'a-builder-2'), indexOf(moving, 'a-qc-2')).filter((c) => c.runner).map((c) => c.runner.key)
  // (owns-check runs only in the chain, before the first QC)
  for (const k of ['check:green', 'tests-check']) assert.ok(again.includes(k), `${k} did not re-run on a moved head: ${again.join(',')}`)
})

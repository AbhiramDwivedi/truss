// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0021 "Seams to pin" (cs): the contract compose-runtime turns green. Written from the spec before the build.
//
// Run with: node --test tests/compose-runtime-contract.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs.
//
// Case prefixes: `cs N:` pins stage.js; `cf N:` pins factory.ts (added by a later task, below the cf marker).
// `control:` cases pass on today's code and prove the harness loaded and ran the script.
// stage.js runs as an AsyncFunction with a stubbed Workflow runtime. A case never matches the script's source text.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')
const STAGE = `${PLUGIN}/workflows/stage.js`
const t = (name, fn) => test(name, { timeout: 20000 }, fn)

const ROLES = {
  planner: { agentType: 'truss:planning-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  tester: { agentType: 'proj:tester', model: 'sonnet', effort: 'medium', isolation: 'worktree' },
  builder: { agentType: 'proj:builder', model: 'sonnet', effort: 'low', isolation: 'worktree' },
  resolver: { agentType: 'proj:resolver', model: 'sonnet', effort: 'medium', isolation: 'none' },
  writer: { agentType: 'truss:writer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  rca: { agentType: 'general-purpose', model: 'opus', effort: 'medium', isolation: 'none' },
  stress: { agentType: 'truss:qc-engineer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  qc: { agentType: 'truss:qc-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  runner: { agentType: 'general-purpose', model: 'sonnet', effort: 'low', isolation: 'none' },
}

// ---------------------------------------------------------------- shared stage harness (cs and cf cases reuse it)

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const tick = () => new Promise((r) => setImmediate(r))
const rj = (obj, exit = 0) => ({ exit, stdout: JSON.stringify(obj) })

// Runs stage.js with scripted members. o.labels maps an agent label to a report (or a function of the call); null is "no report".
// o.runner(ctx) may return a runner reply, or undefined for the default. Returns result, error, calls, logs, labels.
async function exec(args, o = {}) {
  if (!existsSync(STAGE)) throw new Error(`script missing: ${STAGE}`)
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
      const mh = prompt.match(/factory\.ts\s+heavy\b([^\n`]*)/)
      let m
      if (mh) {
        const cut = mh[1].indexOf(' -- ')
        m = cut >= 0 ? mh[1].slice(cut + 4).match(/factory\.ts\s+(check|integrate|owns-check|tests-check|sync)\b([^\n`]*)/) : null
      } else {
        m = prompt.match(/factory\.ts\s+(admit|reap|check|integrate|owns-check|tests-check|sync)\b([^\n`]*)/)
      }
      if (!m) {
        unscripted.push(`${opts.label} (no factory.ts command in prompt)`)
        throw new Error(`unparsable runner prompt for label ${opts.label}`)
      }
      const cmd = m[1]
      const flag = (name) => (m[2].match(new RegExp(`--${name}\\s+([^\\s\`]+)`)) || [])[1]
      const slug = flag('slug')
      const expect = flag('expect')
      const branch = flag('branch')
      const key = cmd === 'check' ? `check:${expect}` : cmd === 'integrate' ? `integrate:${branch}` : cmd
      const name = `runner:${slug}:${key}`
      const n = (counters[name] = (counters[name] ?? -1) + 1)
      let out = o.runner ? await o.runner({ cmd, key, slug, expect, branch, n, prompt, call }) : undefined
      if (out === undefined) {
        const plain = expect === 'red' ? { ok: true } : { ok: true, head: HEAD }
        out =
          cmd === 'admit' ? rj({ admitted: true, parallelism: 4, running: 0, freeMB: 8000, minFreeMB: 2048 }) : cmd === 'reap' ? rj({ reaped: [], skipped: [] }) : cmd === 'check' ? rj(mh ? { ...plain, heavy: { label: `${slug}-check`, waitedMs: 0, exit: 0 } } : plain) : cmd === 'integrate' ? rj({ merged: true }) : cmd === 'owns-check' ? rj({ ok: true, outside: [] }) : cmd === 'tests-check' ? rj({ ok: true, tests: [] }) : rj({ merged: true })
      }
      await tick()
      return out
    }
    const labels = o.labels ?? {}
    if (!Object.hasOwn(labels, opts.label)) {
      unscripted.push(String(opts.label))
      throw new Error(`unscripted label: ${opts.label}`)
    }
    const h = labels[opts.label]
    const v = typeof h === 'function' ? await h(call, calls) : h
    await tick()
    return v === null || v === undefined ? v : structuredClone(v)
  }
  const parallel = async (thunks) => Promise.all(thunks.map(async (th) => { try { return await (typeof th === 'function' ? th() : th) } catch { return null } }))
  const pipeline = async (items, ...stages) =>
    Promise.all(items.map(async (item, i) => {
      try {
        let prev = item
        for (const st of stages) prev = await st(prev, item, i)
        return prev
      } catch {
        return null
      }
    }))
  const log = (m) => logs.push(String(m))
  let result
  let error
  try {
    result = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'allowance', body)(agent, parallel, pipeline, () => {}, log, structuredClone(args), {})
  } catch (e) {
    error = e
  }
  return { result, error, calls, unscripted, logs, labels: calls.map((c) => c.label).filter((l) => !/-runner(-\d+)?$/.test(String(l))) }
}

const HEAD = 'a1'.repeat(20)
const BASE = 'd4'.repeat(20)
const PASS = `VERDICT: PASS\n\n## Proof checked\nHead: ${HEAD}\nPatch: ${'e5'.repeat(20)}\n`
const T1 = { name: 'write-tests', role: 'tester', effort: 'medium', files: ['tests/a.check.ts'], reads: ['src/a.ts'], brief: 'BRIEF-T1: write the tests for a', after: [] }
const B1 = { name: 'build-it', role: 'builder', effort: 'medium', files: ['src/a.ts'], reads: ['tests/a.check.ts'], brief: 'BRIEF-B1: build a', after: ['write-tests'] }
const PLAN = (...tasks) => ({ tasks: tasks.length ? tasks : [T1, B1], stop: null })
const done = (branch, proof = 'PROOF-' + branch) => ({ task: 'whatever', marker: 'DONE', branch, commit: 'c0'.repeat(20), proof, text: 'finished ' + branch })
const marked = (marker, text, branch = 'feat/x') => ({ task: 'whatever', marker, branch, commit: 'c0'.repeat(20), proof: '', text })

const entry = (slug = 'a', o = {}) => ({
  slug, stage: 1, goalFile: `/proj/.truss/goals/${slug}.md`, goal: 'GOAL-TEXT', owns: ['src/**', 'tests/*.ts'],
  acceptanceTest: 'node --test tests/a.check.ts', highImpact: ['src/core/**'], stressTest: false, scope: 'SCOPE-VERBATIM: build a, nothing else',
  worktree: `/wt/${slug}`, branch: `truss/${slug}`, base: BASE, architecture: '/proj/docs/ARCH.md', adrs: ['/proj/docs/adr/0001-x.md'],
  resume: null, tasks: [], done: [], answers: [], spent: 0, labelFrom: {}, ...o,
})
const base = (slug = 'a', over = {}) => ({
  [`${slug}-planner`]: PLAN(), [`${slug}-tester`]: done('feat/t', 'PROOF-T'), [`${slug}-builder`]: done('feat/b', 'PROOF-B'), [`${slug}-qc`]: PASS, ...over,
})
const stageArgs = (crews, o = {}) => ({
  truss: { kind: 'stage', dir: '/proj/.truss', repo: '/proj', plugin: PLUGIN, target: 'main', reworkAllowance: o.reworkAllowance ?? 2, roles: o.roles ?? ROLES, scriptPath: STAGE, crews },
})
async function runStage(crews, o = {}) {
  const r = await exec(stageArgs(crews, o), o)
  assert.deepEqual(r.unscripted, [], `unscripted label(s): ${r.unscripted.join(', ')}`)
  if (r.error) throw r.error
  r.res = r.result
  return r
}
const call = (r, label) => r.calls.find((c) => c.label === label)
const had = (r, label) => r.calls.some((c) => c.label === label)
const has = (s, sub) => assert.ok(s.includes(sub), `missing ${JSON.stringify(sub)} in:\n${s.slice(0, 2500)}`)
const READ_COMMITS = "Read the branch's commits before you start."
const NO_REPORT = 'A member before you returned no report.'

// ---------------------------------------------------------------- control: today's code, proves the harness ran stage.js

t('control: a CHECKPOINT then DONE passes the crew with one restart member, and the planner and QC ran', async () => {
  const r = await runStage([entry('a')], { labels: base('a', { 'a-tester': marked('CHECKPOINT', 'CHECKPOINT-NOTE: halfway', 'feat/t'), 'a-tester-2': done('feat/t2') }) })
  assert.equal(r.res[0].state, 'passed', JSON.stringify(r.res[0]))
  has(call(r, 'a-tester-2').prompt, 'CHECKPOINT-NOTE: halfway')
  assert.ok(had(r, 'a-planner') && had(r, 'a-qc'))
})
t('control: reworkAllowance 1 and two CHECKPOINTs stop BLOCKED at the task with no builder', async () => {
  const r = await runStage([entry('a')], { reworkAllowance: 1, labels: base('a', { 'a-tester': marked('CHECKPOINT', 'one'), 'a-tester-2': marked('CHECKPOINT', 'two') }) })
  assert.equal(r.res[0].state, 'stopped', JSON.stringify(r.res[0]))
  assert.equal(r.res[0].tag, 'BLOCKED')
  assert.equal(r.res[0].at, 'write-tests')
  assert.ok(!had(r, 'a-builder'))
})

// ---------------------------------------------------------------- cs: stage.js restarts (ADR-0021 Seams to pin, cs)

t('cs 1: reworkAllowance 2 allows two restarts after CHECKPOINTs, each successor carrying the previous note', async () => {
  const r = await runStage([entry('a')], { reworkAllowance: 2, labels: base('a', { 'a-tester': marked('CHECKPOINT', 'NOTE-ONE', 'feat/t'), 'a-tester-2': marked('CHECKPOINT', 'NOTE-TWO', 'feat/t'), 'a-tester-3': done('feat/t3') }) })
  assert.equal(r.res[0].state, 'passed', `a third member should have run after two CHECKPOINTs: ${JSON.stringify(r.res[0])}`)
  has(call(r, 'a-tester-2').prompt, 'NOTE-ONE')
  has(call(r, 'a-tester-3').prompt, 'NOTE-TWO')
})
t('cs 2: every restart successor is told to read the branch commits and names the predecessor branch', async () => {
  const r = await runStage([entry('a')], { reworkAllowance: 2, labels: base('a', { 'a-tester': marked('CHECKPOINT', 'NOTE-ONE', 'feat/pred'), 'a-tester-2': done('feat/t2') }) })
  const p = call(r, 'a-tester-2').prompt
  has(p, READ_COMMITS)
  has(p, 'feat/pred')
})
t('cs 3: a member with no report restarts a successor that is told no report came and to read the commits', async () => {
  const r = await runStage([entry('a')], { reworkAllowance: 2, labels: base('a', { 'a-tester': null, 'a-tester-2': done('feat/t2') }) })
  assert.equal(r.res[0].state, 'passed', `a missing report should restart, not stop: ${JSON.stringify(r.res[0])}`)
  const p = call(r, 'a-tester-2').prompt
  has(p, NO_REPORT)
  has(p, READ_COMMITS)
})
t('cs 4: running out of restarts is BLOCKED at the task name with text "restarts spent:" naming the last label and reason', async () => {
  const r = await runStage([entry('a')], { reworkAllowance: 0, labels: base('a', { 'a-tester': marked('CHECKPOINT', 'one'), 'a-tester-2': marked('CHECKPOINT', 'two') }) })
  const s = r.res[0]
  assert.equal(s.state, 'stopped', JSON.stringify(s))
  assert.equal(s.tag, 'BLOCKED')
  assert.equal(s.at, 'write-tests')
  assert.ok(s.text.startsWith('restarts spent:'), `text should start with "restarts spent:", got ${JSON.stringify(s.text)}`)
  has(s.text, 'a-tester-2')
  has(s.text, 'CHECKPOINT')
  assert.ok(!had(r, 'a-tester-3'), 'max(1, 0) = 1 restart, so no third member')
})
t('cs 5: reworkAllowance 1 and a missing report twice is BLOCKED with "restarts spent:" naming the last label and "no report"', async () => {
  const r = await runStage([entry('a')], { reworkAllowance: 1, labels: base('a', { 'a-tester': null, 'a-tester-2': null }) })
  const s = r.res[0]
  assert.equal(s.state, 'stopped', JSON.stringify(s))
  assert.equal(s.tag, 'BLOCKED')
  assert.ok(s.text.startsWith('restarts spent:'), `text should start with "restarts spent:", got ${JSON.stringify(s.text)}`)
  has(s.text, 'a-tester-2')
  has(s.text, 'no report')
  assert.ok(!had(r, 'a-tester-3'))
})
t('cs 6: each restart is logged as "restart: crew <slug>, label <label>, n <n>, reason <reason>" counting n from 1', async () => {
  const r = await runStage([entry('a')], { reworkAllowance: 2, labels: base('a', { 'a-tester': marked('CHECKPOINT', 'one'), 'a-tester-2': null, 'a-tester-3': done('feat/t3') }) })
  const lines = r.logs.filter((l) => l.startsWith('restart:'))
  assert.deepEqual(lines, ['restart: crew a, label a-tester, n 1, reason CHECKPOINT', 'restart: crew a, label a-tester-2, n 2, reason no report'])
})
t('cs 7: restarts add no rework spend, so an integrate failure after two restarts still gets its one rework', async () => {
  const r = await runStage([entry('a')], {
    reworkAllowance: 1,
    labels: base('a', { 'a-tester': marked('CHECKPOINT', 'one'), 'a-tester-2': marked('CHECKPOINT', 'two'), 'a-tester-3': done('feat/t3'), 'a-resolver': done('feat/r') }),
    runner: ({ key, n }) => (key === 'integrate:feat/t3' && n === 0 ? rj({ merged: false, conflicts: ['x'] }) : undefined),
  })
  assert.equal(r.res[0].state, 'passed', `two restarts then one rework should pass: ${JSON.stringify(r.res[0])}`)
  assert.ok(had(r, 'a-resolver'))
})
t('cs 8: the planner prompt loads the split-work skill before splitting work', async () => {
  const r = await runStage([entry('a')], { labels: base('a') })
  has(call(r, 'a-planner').prompt, 'Load the `subagent-limits:split-work` skill before splitting work.')
})

// ---------------------------------------------------------------- cf: factory.ts cases are added below by contract-runtime-cf

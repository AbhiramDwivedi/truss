// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss 0.31.0, speed goal items 1 and 2, the stage side: green keeps the tests factory check ran and hands QC the record, so QC
// reads it instead of re-running a green suite; the full suite runs once before merge, after a QC PASS, unless green already ran it
// on that head; a failing full suite gets a green-fix round and a new QC; a heavy run still going in the background (pending) is
// collected by running the same line again, a bounded number of times. The stage harness is copied from stage-resources.check.ts.


import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { gatesAware } from './fixtures/gates-stub.ts'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')
const ROOT = (process.env.TRUSS_CONTRACT_ROOT || REPO).replace(/\\/g, '/')
const STAGE_PATH = `${ROOT}/workflows/stage.js`
const st = (name, fn) => test(name, { timeout: 30000 }, fn)
const stageText = readFileSync(STAGE_PATH, 'utf8')

const ROLES = {
  designer: { agentType: 'truss:design-engineer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  checker: { agentType: 'truss:checking-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
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

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const tick = () => new Promise((r) => setImmediate(r))
const rj = (obj, exit = 0) => ({ exit, stdout: JSON.stringify(obj) })

const HEAD = 'a1'.repeat(20)
const BASE = 'd4'.repeat(20)
const PASS = `VERDICT: PASS\n\n## Proof checked\nHead: ${HEAD}\nPatch: ${'e5'.repeat(20)}\n`
const FAIL = 'VERDICT: FAIL\n\n## Findings\n- FINDING-1: broken\n'
const T1 = { name: 'write-tests', role: 'tester', effort: 'medium', files: ['tests/a.check.ts'], reads: ['src/a.ts'], brief: 'BRIEF-T1: write the tests for a', after: [] }
const B1 = { name: 'build-it', role: 'builder', effort: 'medium', files: ['src/a.ts'], reads: ['tests/a.check.ts'], brief: 'BRIEF-B1: build a', after: ['write-tests'] }
const done = (branch, proof = 'PROOF-' + branch) => ({ task: 'whatever', marker: 'DONE', branch, commit: 'c0'.repeat(20), proof, text: 'finished ' + branch })
const marked = (marker, text) => ({ task: 'whatever', marker, branch: 'feat/x', commit: 'c0'.repeat(20), proof: '', text })
const entry = (slug = 'a', o = {}) => ({
  slug, stage: 1, goalFile: `/proj/.truss/goals/${slug}.md`, goal: 'GOAL-TEXT', owns: ['src/**', 'tests/*.ts'],
  acceptanceTest: 'node --test tests/a.check.ts', highImpact: ['src/core/**'], stressTest: false, scope: 'SCOPE-VERBATIM: build a, nothing else',
  worktree: `/wt/${slug}`, branch: `truss/${slug}`, base: BASE, architecture: '/proj/docs/ARCH.md', adrs: ['/proj/docs/adr/0001-x.md'],
  resume: null, tasks: [], done: [], answers: [], spent: 0, labelFrom: {}, ...o,
})
const base = (slug = 'a', over = {}) => ({
  [`${slug}-planner`]: { tasks: [T1, B1], stop: null }, [`${slug}-tester`]: done('feat/t', 'PROOF-T'), [`${slug}-builder`]: done('feat/b', 'PROOF-B'), [`${slug}-qc`]: PASS, ...over,
})

// ---------------------------------------------------------------- the runner prompt parser

// The first factory.ts command in a runner prompt decides what the call is. A heavy line holds a second one after ` -- `.
function parseRunner(prompt) {
  const line = String(prompt).split('\n').find((l) => /factory\.ts\s/.test(l))
  if (!line) return null
  const m = line.match(/factory\.ts\s+([\w-]+)(.*)$/)
  if (!m) return null
  const cmd = m[1]
  let outer = m[2]
  let inner = null
  if (cmd === 'heavy') {
    const cut = outer.indexOf(' -- ')
    if (cut >= 0) {
      inner = outer.slice(cut + 4)
      outer = outer.slice(0, cut)
    }
  }
  const flag = (text, name) => (text.match(new RegExp(`--${name}\\s+([^\\s\`]+)`)) || [])[1]
  const innerCmd = inner ? (inner.match(/factory\.ts\s+([\w-]+)/) || [])[1] : undefined
  const innerArgs = inner ? (inner.match(/factory\.ts\s+[\w-]+(.*)$/) || [])[1] || '' : ''
  return {
    line,
    cmd,
    slug: flag(outer, 'slug'),
    label: flag(outer, 'label'),
    expect: cmd === 'check' ? flag(outer, 'expect') : flag(innerArgs, 'expect'),
    innerCmd,
  }
}

// the expect of a check call, plain or through heavy; null for any other call
const checkExpect = (p) => (p.cmd === 'check' || p.innerCmd === 'check' ? p.expect : null)

// ---------------------------------------------------------------- run stage.js under a fake agent

async function exec(args, o = {}) {
  const body = stageText.replace(/^\s*export\s+const\s+meta\b/m, 'const meta')
  const calls = []
  const unscripted = []
  const agent = gatesAware(async (prompt, opts = {}) => {
    const call = { prompt, opts, label: opts.label, i: calls.length }
    calls.push(call)
    await tick()
    if (/-runner(-\d+)?$/.test(String(opts.label))) {
      const p = parseRunner(prompt)
      if (!p) {
        unscripted.push(`${opts.label} (no factory.ts command in prompt)`)
        throw new Error(`unparsable runner prompt for label ${opts.label}`)
      }
      call.runner = p
      call.crew = String(opts.label).replace(/-runner(-\d+)?$/, '')
      const real = p.cmd === 'heavy' ? p.innerCmd : p.cmd
      let out = o.runner ? await o.runner(p, call, calls) : undefined
      if (out === undefined) {
        if (p.cmd === 'admit') out = rj({ admitted: true, parallelism: 4, running: 0, freeMB: 8000, minFreeMB: 2048 })
        else if (p.cmd === 'reap') out = rj({ reaped: [], skipped: [] })
        else if (real === 'check') {
          const plain = p.expect === 'red' ? { ok: true } : { ok: true, head: HEAD }
          out = p.cmd === 'heavy' ? rj({ ...plain, heavy: { label: p.label, waitedMs: 0, exit: 0 } }) : rj(plain)
        } else if (p.cmd === 'integrate') out = rj({ merged: true })
        else if (p.cmd === 'owns-check') out = rj({ ok: true, outside: [] })
        else if (p.cmd === 'tests-check') out = rj({ ok: true, tests: [] })
        else if (p.cmd === 'sync') out = rj({ merged: true })
        else if (p.cmd === 'knowledge-lint' && /knowledge-lint --slug=\S/.test(p.line)) out = rj({ ok: true, failures: [], warnings: [] })
        else if (['decision-checkpoint', 'crew-learned', 'knowledge-commit', 'decision-ack', 'decisions'].includes(p.cmd)) out = rj({ ok: true, decisions: [] })
        else {
          unscripted.push(`${opts.label} (${p.cmd})`)
          throw new Error(`unscripted runner command ${p.cmd}`)
        }
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
  })
  const parallel = async (thunks) => Promise.all(thunks.map(async (th) => { try { return await (typeof th === 'function' ? th() : th) } catch { return null } }))
  const pipeline = async (items, ...stages) =>
    Promise.all(items.map(async (item, i) => {
      try {
        let prev = item
        for (const s of stages) prev = await s(prev, item, i)
        return prev
      } catch {
        return null
      }
    }))
  let result
  let error
  try {
    result = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'allowance', body)(agent, parallel, pipeline, () => {}, () => {}, structuredClone(args), {})
  } catch (e) {
    error = e
  }
  return { result, error, calls, unscripted }
}

async function runStage(crews, o = {}) {
  const args = { truss: { kind: 'stage', dir: '/proj/.truss', repo: '/proj', plugin: REPO, target: 'main', reworkAllowance: 2, roles: ROLES, scriptPath: STAGE_PATH, crews } }
  const r = await exec(args, o)
  assert.deepEqual(r.unscripted, [], `unscripted label(s): ${r.unscripted.join(', ')}`)
  if (r.error) throw r.error
  r.res = r.result
  return r
}

const spawned = (calls, label) => calls.some((c) => c.label === label)

// ---------------------------------------------------------------- 0.31.0 cases

const RECORD = '/proj/.truss/checks/a-1.json'
const TARGETED = { mode: 'targeted', why: ['src/a.ts: reached by tests/a.check.ts'], files: ['tests/a.check.ts'], commands: ["node --test 'tests/a.check.ts'"] }
const isFull = (p) => checkExpect(p) === 'green' && /\s--full(\s|$)/.test(p.line)
const greens = (calls) => calls.filter((c) => c.runner && checkExpect(c.runner) === 'green')
const fulls = (calls) => calls.filter((c) => c.runner && isFull(c.runner))
const greenOk = (p, tests = TARGETED) => rj({ ok: true, head: HEAD, record: RECORD, tests, heavy: { label: p.label, waitedMs: 0, exit: 0 } })

st('QC gets the green result and is told to read it, not re-run the suite', async () => {
  const r = await runStage([entry('a')], { labels: base('a'), runner: (p) => (checkExpect(p) === 'green' && !isFull(p) ? greenOk(p) : undefined) })
  assert.equal(r.res[0].state, 'passed', JSON.stringify(r.res[0]))
  const q = r.calls.find((c) => c.label === 'a-qc').prompt
  assert.match(q, /Green result: the green check passed on head a1a1/)
  assert.ok(q.includes('tests/a.check.ts'), q)
  assert.ok(q.includes(RECORD), q)
  assert.match(q, /Do not re-run a test suite that is green on this head/)
})

st('the full suite runs once before merge, after the QC PASS', async () => {
  const r = await runStage([entry('a')], { labels: base('a'), runner: (p) => (checkExpect(p) === 'green' && !isFull(p) ? greenOk(p) : undefined) })
  assert.equal(r.res[0].state, 'passed', JSON.stringify(r.res[0]))
  const f = fulls(r.calls)
  assert.equal(f.length, 1, 'one full-suite run')
  assert.equal(f[0].runner.cmd, 'heavy', 'the full suite runs through heavy')
  const qcAt = r.calls.findIndex((c) => c.label === 'a-qc')
  assert.ok(f[0].i > qcAt, 'after the QC')
})

st('no second full suite when the green check already ran it on this head', async () => {
  const full = { mode: 'full', why: ['package.json is a config file or dependency manifest'], files: [], commands: ['npm test'] }
  const r = await runStage([entry('a')], { labels: base('a'), runner: (p) => (checkExpect(p) === 'green' ? greenOk(p, full) : undefined) })
  assert.equal(r.res[0].state, 'passed', JSON.stringify(r.res[0]))
  assert.equal(fulls(r.calls).length, 0)
  assert.match(r.calls.find((c) => c.label === 'a-qc').prompt, /running the acceptance test and the full test suite/)
})

st('a failing full suite gets a green-fix round, the targeted green again and a new QC', async () => {
  let fullRuns = 0
  const runner = (p) => {
    if (isFull(p)) return ++fullRuns === 1 ? rj({ ok: false, exit: 1, head: HEAD, tail: 'FULL-SUITE-TAIL not ok 3 - b', heavy: { label: p.label, waitedMs: 0, exit: 1 } }, 1) : undefined
    return checkExpect(p) === 'green' ? greenOk(p) : undefined
  }
  const r = await runStage([entry('a')], { labels: base('a', { 'a-qc-2': PASS, 'a-builder-2': done('feat/f1') }), runner })
  assert.equal(r.res[0].state, 'passed', JSON.stringify(r.res[0]))
  assert.equal(fullRuns, 2, 'the full suite runs again after the fix')
  assert.ok(spawned(r.calls, 'a-builder-2'), 'a fix builder')
  assert.ok(r.calls.find((c) => c.label === 'a-builder-2').prompt.includes('FULL-SUITE-TAIL'))
  assert.ok(spawned(r.calls, 'a-qc-2'), 'a new QC after the fix')
})

st('a pending heavy run is collected by running the same line again', async () => {
  let n = 0
  const runner = (p) => {
    if (checkExpect(p) !== 'green' || isFull(p)) return undefined
    if (++n <= 2) return rj({ heavy: { label: p.label, pending: true, job: 'k', waitedMs: 540000, ageMs: n * 540000, budgetMs: 7200000, why: 'still running' } }, 1)
    return greenOk(p)
  }
  const r = await runStage([entry('a')], { labels: base('a'), runner })
  assert.equal(r.res[0].state, 'passed', JSON.stringify(r.res[0]))
  const g = greens(r.calls).filter((c) => !isFull(c.runner))
  assert.equal(g.length, 3, 'two pending polls, then the result')
  assert.equal(new Set(g.map((c) => c.runner.line)).size, 1, 'the same line each time')
})

st('a pending heavy run is polled until the factory budget runs out, not a fixed number of polls, then blocks the crew', async () => {
  let n = 0
  // the factory budget (slot wait plus a run) is 12 polls of 540 s; the job's age grows by one attach per poll
  const runner = (p) => (checkExpect(p) === 'green' ? rj({ heavy: { label: p.label, pending: true, job: 'k', waitedMs: 540000, ageMs: ++n * 540000, budgetMs: 12 * 540000, why: 'PENDING-WHY' } }, 1) : undefined)
  const r = await runStage([entry('a')], { labels: base('a'), runner })
  assert.equal(r.res[0].state, 'stopped')
  assert.equal(r.res[0].tag, 'BLOCKED')
  assert.match(r.res[0].text, /heavy run still going after 6480 s \(budget 6480 s\): PENDING-WHY/)
  assert.equal(greens(r.calls).length, 12)
})

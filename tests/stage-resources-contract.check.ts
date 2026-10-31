// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0015 Decision 6 and Seams to pin, section 4: the contract between stage-resources (workflows/stage.js) and factory.
// Written from the spec before any producer exists.
//
// Run with: node --test tests/stage-resources-contract.check.ts
// The producer is read from $TRUSS_CONTRACT_ROOT/workflows/stage.js; with the variable unset the root is the repo root.
// With no producer it prints `producer missing: stage.js resources` and every case fails.
//
// The real stage.js is loaded as text and run under a fake agent(), as tests/workflows.check.ts does. The cases read the
// runner prompts the script issues, in the order it issues them. They check behaviour, not text: a word in a comment
// changes no prompt.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')
const ROOT = (process.env.TRUSS_CONTRACT_ROOT || REPO).replace(/\\/g, '/')
const STAGE_PATH = `${ROOT}/workflows/stage.js`
const MISSING = 'producer missing: stage.js resources'
const st = (name, fn) => test(name, { timeout: 30000 }, fn)

// today's stage.js has none of the three words; a producer has at least one
const stageText = existsSync(STAGE_PATH) ? readFileSync(STAGE_PATH, 'utf8') : ''
const producerMissing = !/\b(admit|heavy|reap)\b/.test(stageText)
if (producerMissing) console.log(MISSING)
const needProducer = () => {
  if (producerMissing) assert.fail(MISSING)
}

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
    cwd: flag(outer, 'cwd'),
    dir: flag(outer, 'dir'),
    repo: flag(outer, 'repo'),
    expect: cmd === 'check' ? flag(outer, 'expect') : flag(innerArgs, 'expect'),
    branch: flag(outer, 'branch'),
    inner,
    innerCmd,
    innerSlug: flag(innerArgs, 'slug'),
    innerCwd: flag(innerArgs, 'cwd'),
    innerDir: flag(innerArgs, 'dir'),
    innerRepo: flag(innerArgs, 'repo'),
  }
}

// ---------------------------------------------------------------- run stage.js under a fake agent

async function exec(args, o = {}) {
  const body = stageText.replace(/^\s*export\s+const\s+meta\b/m, 'const meta')
  const calls = []
  const unscripted = []
  const agent = async (prompt, opts = {}) => {
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
      const real = p.cmd === 'heavy' ? p.innerCmd : p.cmd
      let out = o.runner ? await o.runner(p, call) : undefined
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
  }
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

// the scenarios that exercise every kind of member spawn
const SCENARIOS = {
  'a clean pass (planner, tester, builder, QC)': () => ({ crews: [entry('a')], o: { labels: base('a') } }),
  'a QC FAIL, then a fix builder and a second QC': () => ({
    crews: [entry('a')],
    o: { labels: base('a', { 'a-qc': FAIL, 'a-qc-2': PASS, 'a-builder-2': done('feat/f1') }) },
  }),
  'a tester checkpoint and its successor': () => ({
    crews: [entry('a')],
    o: { labels: base('a', { 'a-tester': marked('CHECKPOINT', 'NOTE-HANDOFF'), 'a-tester-2': done('feat/t2', 'PROOF-T2') }) },
  }),
  'a stress test': () => ({
    crews: [entry('a', { stressTest: true })],
    o: { labels: base('a', { 'a-stress': 'STRESSTEST: 0 findings' }) },
  }),
  'a member that stops BLOCKED': () => ({
    crews: [entry('a')],
    o: { labels: base('a', { 'a-tester': marked('BLOCKED', 'cannot go on') }) },
  }),
}

// the calls in the order the script issued them, each as a member spawn or a runner call
const sequence = (calls) =>
  calls.map((c) => (c.runner ? { kind: 'runner', ...c.runner, i: c.i } : { kind: 'member', label: c.label, slug: String(c.label).replace(/-[a-z]+(-\d+)?$/, ''), i: c.i }))

// ---------------------------------------------------------------- the three cases

st('case: check runs through factory heavy', async () => {
  needProducer()
  const ran = []
  for (const [name, make] of Object.entries(SCENARIOS)) {
    const { crews, o } = make()
    const r = await runStage(crews, o)
    const runners = sequence(r.calls).filter((s) => s.kind === 'runner')
    const checks = runners.filter((s) => s.cmd === 'check' || s.innerCmd === 'check')
    ran.push(...checks.map((c) => c.expect))
    const hasRed = checks.some((c) => c.expect === 'red')
    assert.ok(hasRed, `${name}: the red check never ran`)
    for (const c of checks) {
      assert.equal(c.cmd, 'heavy', `${name}: the ${c.expect} check is not queued through factory heavy:\n${c.line}`)
      assert.equal(c.innerCmd, 'check', `${name}: heavy must run the factory.ts check command after --:\n${c.line}`)
      assert.match(c.line, /factory\.ts\s+heavy\s/, `${name}: ${c.line}`)
      assert.match(c.inner, /^node\s+\S*factory\.ts\s+check\s/, `${name}: the command after -- is not node ... factory.ts check:\n${c.line}`)
      assert.equal(c.slug, 'a', `${name}: heavy --slug`)
      assert.equal(c.label, 'a-check', `${name}: heavy --label is <slug>-check`)
      assert.equal(c.cwd, '/wt/a', `${name}: heavy --cwd is the crew worktree`)
      assert.equal(c.innerSlug, 'a', `${name}: check --slug`)
      assert.equal(c.innerCwd, '/wt/a', `${name}: check --cwd`)
      for (const [side, d, rp] of [['heavy', c.dir, c.repo], ['check', c.innerDir, c.innerRepo]]) {
        assert.equal(d, '/proj/.truss', `${name}: --dir is on the ${side} side of --`)
        assert.equal(rp, '/proj', `${name}: --repo is on the ${side} side of --`)
      }
      const call = r.calls[c.i]
      assert.ok(call.prompt.includes('600000'), `${name}: the runner prompt for a heavy check names a Bash timeout of 600000`)
    }
    // only the checks are queued: the other runner commands run as before
    for (const s of runners.filter((x) => x.cmd !== 'check' && x.cmd !== 'heavy')) {
      assert.ok(!/\sheavy\s/.test(s.line), `${name}: ${s.cmd} must not go through heavy:\n${s.line}`)
    }
  }
  assert.ok(ran.includes('red') && ran.includes('green'), 'no check ran at all')

  // a heavy queue timeout is a stop, never a red or a failing green, and it never gets a fix builder
  const red = await runStage([entry('a')], {
    labels: base('a'),
    runner: (p) => (p.innerCmd === 'check' && p.expect === 'red' ? rj({ heavy: { label: 'a-check', ran: false, why: 'WHY-SLOT-BUSY' } }, 1) : undefined),
  })
  assert.equal(red.res[0].state, 'stopped', JSON.stringify(red.res[0]))
  assert.equal(red.res[0].tag, 'BLOCKED')
  assert.ok(red.res[0].text.includes('heavy slot busy: WHY-SLOT-BUSY'), red.res[0].text)
  assert.ok(!red.calls.some((c) => c.label === 'a-builder' || c.label === 'a-builder-2'), 'a busy slot is never a failing check, so no fix builder runs')
  const green = await runStage([entry('a')], {
    labels: base('a'),
    runner: (p) => (p.innerCmd === 'check' && p.expect === 'green' ? rj({ heavy: { label: 'a-check', ran: false, why: 'WHY-SLOT-BUSY' } }, 1) : undefined),
  })
  assert.equal(green.res[0].state, 'stopped', JSON.stringify(green.res[0]))
  assert.ok(green.res[0].text.includes('heavy slot busy: WHY-SLOT-BUSY'), green.res[0].text)
  assert.ok(!green.calls.some((c) => c.label === 'a-builder-2'), 'a busy slot gets no fix builder')
})

st('case: admit before each member', async () => {
  needProducer()
  let members = 0
  for (const [name, make] of Object.entries(SCENARIOS)) {
    const { crews, o } = make()
    const r = await runStage(crews, o)
    const seq = sequence(r.calls)
    let prevMember = -1
    for (let k = 0; k < seq.length; k++) {
      const s = seq[k]
      if (s.kind !== 'member') continue
      members++
      const between = seq.slice(prevMember + 1, k)
      const admit = between.find((x) => x.kind === 'runner' && x.cmd === 'admit' && x.slug === 'a')
      assert.ok(admit, `${name}: ${s.label} was spawned with no admit --slug a runner call since the member before it`)
      assert.match(admit.line, /factory\.ts\s+admit\s/, admit.line)
      assert.equal(admit.dir, '/proj/.truss', 'admit --dir')
      assert.equal(admit.repo, '/proj', 'admit --repo')
      prevMember = k
    }
  }
  assert.ok(members >= 8, `only ${members} member spawns were checked`)

  // held: the crew stops BLOCKED and no member is spawned
  const held = await runStage([entry('a')], {
    labels: base('a'),
    runner: (p) => (p.cmd === 'admit' ? rj({ admitted: false, parallelism: 2, running: 2, freeMB: 100, minFreeMB: 2048, why: 'WHY-HELD-123' }, 1) : undefined),
  })
  assert.equal(held.res[0].state, 'stopped', JSON.stringify(held.res[0]))
  assert.equal(held.res[0].tag, 'BLOCKED')
  assert.ok(held.res[0].text.includes('held by admission: WHY-HELD-123'), held.res[0].text)
  assert.deepEqual(held.calls.filter((c) => !c.runner).map((c) => c.label), [], 'a held crew spawns no member')

  // fail open: an admit result that is not JSON admits
  const open = await runStage([entry('a')], {
    labels: base('a'),
    runner: (p) => (p.cmd === 'admit' ? { exit: 0, stdout: 'not json at all' } : undefined),
  })
  assert.equal(open.res[0].state, 'passed', JSON.stringify(open.res[0]))
})

st('case: reap after each member', async () => {
  needProducer()
  let members = 0
  for (const [name, make] of Object.entries(SCENARIOS)) {
    const { crews, o } = make()
    const r = await runStage(crews, o)
    const seq = sequence(r.calls)
    for (let k = 0; k < seq.length; k++) {
      const s = seq[k]
      if (s.kind !== 'member') continue
      members++
      let next = seq.findIndex((x, j) => j > k && x.kind === 'member')
      if (next < 0) next = seq.length
      const reap = seq.slice(k + 1, next).find((x) => x.kind === 'runner' && x.cmd === 'reap' && x.slug === 'a' && x.label === 'a-check')
      assert.ok(reap, `${name}: ${s.label} is not followed by a reap --slug a --label a-check runner call before the next member or the crew's result`)
      assert.match(reap.line, /factory\.ts\s+reap\s/, reap.line)
      assert.equal(reap.dir, '/proj/.truss', 'reap --dir')
      assert.equal(reap.repo, '/proj', 'reap --repo')
    }
  }
  assert.ok(members >= 8, `only ${members} member spawns were checked`)

  // a failed reap call does not stop the crew
  const bad = await runStage([entry('a')], {
    labels: base('a'),
    runner: (p) => (p.cmd === 'reap' ? { exit: 1, stdout: 'boom' } : undefined),
  })
  assert.equal(bad.res[0].state, 'passed', JSON.stringify(bad.res[0]))
})

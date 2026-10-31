// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0015 Decision 6: the details of the stage chain that tests/stage-resources-contract.check.ts does not pin.
// Written from the spec before stage.js changed. It does not repeat that file's three cases.
//
// Run with: node --test tests/stage-resources.check.ts
// stage.js is read from $TRUSS_CONTRACT_ROOT/workflows/stage.js; with the variable unset the root is the repo root.
//
// The real stage.js is loaded as text and run under a fake agent(). Each case asserts its own behaviour; there is no
// producer-missing guard, so on a stage.js with no admit, heavy or reap each case fails on its own assertion.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
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

const members = (calls) => calls.filter((c) => !c.runner)
const runnersOf = (calls, cmd, crew) => calls.filter((c) => c.runner && c.runner.cmd === cmd && (crew === undefined || c.crew === crew))
const spawned = (calls, label) => calls.some((c) => c.label === label)
const HELD = (why) => rj({ admitted: false, parallelism: 2, running: 2, freeMB: 100, minFreeMB: 2048, why }, 1)

// ---------------------------------------------------------------- cases

st('case: held at', async () => {
  // before the builder spawn: at is the task name
  const b = await runStage([entry('a')], {
    labels: base('a'),
    runner: (p, call, calls) => (p.cmd === 'admit' && spawned(calls, 'a-tester') && !spawned(calls, 'a-builder') ? HELD('WHY-B') : undefined),
  })
  assert.equal(b.res[0].state, 'stopped', `held before the builder must stop the crew: ${JSON.stringify(b.res[0])}`)
  assert.equal(b.res[0].tag, 'BLOCKED')
  assert.ok(b.res[0].text.includes('held by admission: WHY-B'), b.res[0].text)
  assert.equal(b.res[0].at, 'build-it', 'held before the builder: at is the task name')
  assert.ok(!spawned(b.calls, 'a-builder'), 'a held builder is never spawned')

  // before the QC spawn: at is qc
  const q = await runStage([entry('a')], {
    labels: base('a'),
    runner: (p, call, calls) => (p.cmd === 'admit' && spawned(calls, 'a-builder') && !spawned(calls, 'a-qc') ? HELD('WHY-Q') : undefined),
  })
  assert.equal(q.res[0].state, 'stopped', `held before the QC must stop the crew: ${JSON.stringify(q.res[0])}`)
  assert.ok(q.res[0].text.includes('held by admission: WHY-Q'), q.res[0].text)
  assert.equal(q.res[0].at, 'qc', 'held before the QC: at is qc')
  assert.ok(!spawned(q.calls, 'a-qc'), 'a held QC is never spawned')

  // before the planner: at is the crew's step then (split)
  const p = await runStage([entry('a')], {
    labels: base('a'),
    runner: (pp) => (pp.cmd === 'admit' ? HELD('WHY-P') : undefined),
  })
  assert.equal(p.res[0].state, 'stopped', `held before the planner must stop the crew: ${JSON.stringify(p.res[0])}`)
  assert.ok(p.res[0].text.includes('held by admission: WHY-P'), p.res[0].text)
  assert.equal(p.res[0].at, 'split', 'held before the planner: at is the crew step, split')
  assert.ok(!spawned(p.calls, 'a-planner'), 'a held planner is never spawned')
})

st('case: no retry', async () => {
  for (const [name, hold] of [
    ['builder', (calls) => spawned(calls, 'a-tester') && !spawned(calls, 'a-builder')],
    ['planner', () => true],
  ]) {
    let heldAt = -1
    const r = await runStage([entry('a')], {
      labels: base('a'),
      runner: (p, call, calls) => {
        if (p.cmd !== 'admit' || !hold(calls)) return undefined
        if (heldAt < 0) heldAt = call.i
        return HELD('WHY-NR')
      },
    })
    assert.ok(heldAt >= 0, `${name}: no admit runner call was ever made, so nothing was held`)
    const admits = runnersOf(r.calls, 'admit', 'a')
    assert.ok(admits.some((c) => c.i === heldAt), `${name}: the held admit is a runner call of crew a`)
    const after = admits.filter((c) => c.i > heldAt)
    assert.equal(after.length, 0, `${name}: a held crew must not retry admit; ${after.length} admit call(s) came after the held one`)
    assert.equal(r.res[0].state, 'stopped', `${name}: ${JSON.stringify(r.res[0])}`)
  }
})

st('case: env through heavy', async () => {
  const meta = { label: 'a-check', waitedMs: 0, exit: 1 }
  const red = await runStage([entry('a')], {
    labels: base('a'),
    runner: (p) => (checkExpect(p) === 'red' ? rj({ ok: false, env: 'ENV-TEXT-77 toolchain missing', catalog: [{ id: 'K1', fix: 'FIX-K1' }], heavy: meta }, 1) : undefined),
  })
  const redCalls = red.calls.filter((c) => c.runner && checkExpect(c.runner) === 'red')
  assert.equal(redCalls.length, 1, 'one red check call')
  assert.equal(redCalls[0].runner.cmd, 'heavy', `the red check must run through heavy:\n${redCalls[0].runner.line}`)
  assert.equal(red.res[0].state, 'stopped', JSON.stringify(red.res[0]))
  assert.equal(red.res[0].tag, 'BLOCKED')
  assert.equal(red.res[0].at, 'red')
  assert.ok(red.res[0].text.includes('ENV-TEXT-77 toolchain missing'), `envOf must read env from the heavy output:\n${red.res[0].text}`)
  assert.match(red.res[0].text, /environment/i)
  assert.ok(red.res[0].text.includes('known problem K1: FIX-K1'), `knownOf must read catalog from the heavy output:\n${red.res[0].text}`)
  assert.ok(!spawned(red.calls, 'a-planner'), 'an environment stop spawns no member')

  const green = await runStage([entry('a')], {
    labels: base('a'),
    runner: (p) => (checkExpect(p) === 'green' ? rj({ ok: true, head: HEAD, heavy: { label: 'a-check', waitedMs: 5, exit: 0 } }) : undefined),
  })
  const greenCalls = green.calls.filter((c) => c.runner && checkExpect(c.runner) === 'green')
  assert.ok(greenCalls.length >= 1, 'a green check ran')
  assert.ok(greenCalls.every((c) => c.runner.cmd === 'heavy'), `every green check must run through heavy:\n${greenCalls.map((c) => c.runner.line).join('\n')}`)
  assert.equal(green.res[0].state, 'passed', `a green heavy check with {ok, head, heavy} passes the crew: ${JSON.stringify(green.res[0])}`)
  assert.equal(green.res[0].head, HEAD)
})

st('case: heavy ran false at red', async () => {
  const r = await runStage([entry('a')], {
    labels: base('a'),
    runner: (p) => (checkExpect(p) === 'red' ? rj({ heavy: { label: 'a-check', ran: false, why: 'WHY-BUSY-RED' } }, 1) : undefined),
  })
  assert.equal(r.res[0].state, 'stopped', JSON.stringify(r.res[0]))
  assert.equal(r.res[0].tag, 'BLOCKED')
  assert.ok(r.res[0].text.includes('heavy slot busy: WHY-BUSY-RED'), `a ran:false result at red is a busy-slot stop:\n${r.res[0].text}`)
  assert.equal(r.res[0].at, 'red', 'the busy-slot stop at the red check carries at red')
  assert.equal(members(r.calls).length, 0, 'a busy slot at red spawns no member')
})

st('case: crew-end reap', async () => {
  // a crew that stops at red spawns no member, and still reaps once when its chain ends
  const red = await runStage([entry('a')], {
    labels: base('a'),
    runner: (p) => (checkExpect(p) === 'red' ? rj({ ok: false }, 1) : undefined),
  })
  assert.equal(red.res[0].state, 'stopped', JSON.stringify(red.res[0]))
  assert.equal(red.res[0].at, 'red')
  assert.equal(members(red.calls).length, 0, 'the crew stopped before any member')
  const reaps = runnersOf(red.calls, 'reap')
  assert.equal(reaps.length, 1, `a crew that stops at red issues exactly one reap, got ${reaps.length}`)
  assert.equal(reaps[0].runner.slug, 'a')
  assert.equal(reaps[0].runner.label, 'a-check')
  assert.match(reaps[0].runner.line, /factory\.ts\s+reap\s+--slug a --label a-check\b/)

  // two crews: every admit and reap carries its own crew's slug
  const two = await runStage([entry('a'), entry('b')], { labels: { ...base('a'), ...base('b') } })
  assert.deepEqual(two.res.map((x) => x.state), ['passed', 'passed'], JSON.stringify(two.res))
  for (const slug of ['a', 'b']) {
    const mine = members(two.calls).filter((c) => c.label.startsWith(`${slug}-`))
    const admits = runnersOf(two.calls, 'admit', slug)
    const reapsOf = runnersOf(two.calls, 'reap', slug)
    assert.equal(admits.length, mine.length, `crew ${slug}: one admit per member spawn`)
    assert.equal(reapsOf.length, mine.length + 1, `crew ${slug}: one reap after each member spawn and one at the chain's end`)
    for (const c of [...admits, ...reapsOf]) {
      assert.equal(c.runner.slug, slug, `crew ${slug}'s ${c.runner.cmd} call carries slug ${c.runner.slug}: ${c.runner.line}`)
    }
    for (const c of reapsOf) assert.equal(c.runner.label, `${slug}-check`, `crew ${slug}'s reap label`)
  }
  for (const c of two.calls.filter((x) => x.runner && (x.runner.cmd === 'admit' || x.runner.cmd === 'reap'))) {
    assert.ok(c.runner.slug === c.crew, `${c.runner.cmd} sent from crew ${c.crew}'s runner names slug ${c.runner.slug}`)
  }
})

st('case: failed reap logged', async () => {
  for (const [name, fail] of [
    ['non-JSON output', { exit: 0, stdout: 'REAP-BOOM-XYZ not json' }],
    ['exit 1', { exit: 1, stdout: JSON.stringify({ error: 'REAP-ERR-XYZ' }) }],
  ]) {
    const r = await runStage([entry('a')], {
      labels: base('a'),
      runner: (p) => (p.cmd === 'reap' ? fail : undefined),
    })
    assert.ok(runnersOf(r.calls, 'reap', 'a').length >= 1, `${name}: reap never ran`)
    assert.equal(r.res[0].state, 'passed', `${name}: a failed reap does not stop the crew: ${JSON.stringify(r.res[0])}`)
    const qc = r.calls.find((c) => c.label === 'a-qc')
    assert.ok(qc, `${name}: QC ran`)
    const after = qc.prompt.split('Member proofs:')[1] || ''
    const proofs = after.split('Last stress-test report:')[0]
    const needle = name === 'exit 1' ? 'REAP-ERR-XYZ' : 'REAP-BOOM-XYZ'
    assert.ok(proofs.includes(needle), `${name}: the failed reap's text is in the QC prompt under Member proofs:\n${proofs}`)
  }
})

st('case: runner calls get no admit', async () => {
  const SCEN = {
    'a clean pass': () => ({ labels: base('a') }),
    'a QC FAIL, then a fix builder': () => ({ labels: base('a', { 'a-qc': FAIL, 'a-qc-2': PASS, 'a-builder-2': done('feat/f1') }) }),
    'a checkpoint and its successor': () => ({ labels: base('a', { 'a-tester': marked('CHECKPOINT', 'NOTE'), 'a-tester-2': done('feat/t2') }) }),
    'a merge conflict and its resolver': () => {
      let n = 0
      return {
        labels: base('a', { 'a-resolver': done('feat/r') }),
        runner: (p) => (p.cmd === 'integrate' && n++ === 0 ? rj({ merged: false, conflicts: ['src/a.ts'] }, 1) : undefined),
      }
    },
  }
  for (const [name, make] of Object.entries(SCEN)) {
    const r = await runStage([entry('a')], make())
    const seq = r.calls
    const memberCount = members(seq).length
    assert.ok(memberCount >= 4, `${name}: only ${memberCount} member spawns`)
    const admits = runnersOf(seq, 'admit')
    assert.equal(admits.length, memberCount, `${name}: ${admits.length} admit runner calls for ${memberCount} member spawns; only member spawns are admitted`)
    for (const a of admits) {
      const next = seq[a.i + 1]
      assert.ok(next && !next.runner, `${name}: the admit at call ${a.i} is followed by ${next && next.runner ? `a runner call (${next.runner.line})` : 'nothing'}, not a member spawn`)
    }
    for (const c of seq.filter((x) => x.runner && x.runner.cmd !== 'admit')) {
      const prev = seq[c.i - 1]
      assert.ok(!(prev && prev.runner && prev.runner.cmd === 'admit'), `${name}: a ${c.runner.cmd} runner call sits directly after an admit`)
    }
  }
})

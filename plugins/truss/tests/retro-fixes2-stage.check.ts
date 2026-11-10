// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0027 (retro-fixes2), the stage.js and qc-engineer.md seams: F-67 (runFactory resolves a relative --dir, admit fails
// closed), F-70 (a green fix builder that stops naming a tester file is re-routed to a tester; testsBackstop after each green
// fix) and F-72 (the QC prompt and agents/qc-engineer.md carry the foreground rule). Written from the spec before the change.
//
// Titles: `F6x N:` cases fail on the base code; `control N:` cases pass on it (the old forms keep working).
// Every case drives the real workflows/stage.js through a stub agent and runner harness (copied from tests/stage-fixes3.check.ts).
// The plugin root comes from this file's own module path, never process.cwd(), so a copy of the base tree loads the base code.
//
// Run with: node --test tests/retro-fixes2-stage.check.ts

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')
const PATHS = { 'stage.js': `${PLUGIN}/workflows/stage.js` }
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
  stress: { agentType: 'truss:qc-engineer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  qc: { agentType: 'truss:qc-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  runner: { agentType: 'general-purpose', model: 'sonnet', effort: 'low', isolation: 'none' },
  ux: { agentType: 'truss:ux-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
}

// ---------------------------------------------------------------- harness (copied from tests/stage-fixes3.check.ts)

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const tick = () => new Promise((r) => setImmediate(r))
const ticks = async (n) => {
  for (let i = 0; i < n; i++) await tick()
}
const rj = (obj, exit = 0) => ({ exit, stdout: JSON.stringify(obj) })

async function exec(file, args, o = {}) {
  const p = PATHS[file]
  if (!existsSync(p)) throw new Error(`script missing: ${p}`)
  const body = readFileSync(p, 'utf8').replace(/^\s*export\s+const\s+meta\b/m, 'const meta')
  const calls = []
  const unscripted = []
  const timeline = []
  const counters = {}
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
        m = prompt.match(/factory\.ts\s+(admit|reap|check|integrate|owns-check|tests-check|sync|decision-checkpoint|crew-learned|knowledge-commit|knowledge-lint|decision-ack|decisions)\b([^\n`]*)/)
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
      const heavy = !!mh
      call.runner = { cmd, slug, expect, branch, key, name, heavy }
      const n = (counters[name] = (counters[name] ?? -1) + 1)
      timeline.push(`start:${name}`)
      let out = o.runner ? await o.runner({ cmd, key, slug, expect, branch, n, prompt, call, heavy }) : undefined
      if (out === undefined) {
        const plain = expect === 'red' ? { ok: true } : { ok: true, head: HEAD }
        out =
          cmd === 'admit' ? rj({ admitted: true, parallelism: 4, running: 0, freeMB: 8000, minFreeMB: 2048 }) : cmd === 'reap' ? rj({ reaped: [], skipped: [] }) : cmd === 'check' ? rj(heavy ? { ...plain, heavy: { label: `${slug}-check`, waitedMs: 0, exit: 0 } } : plain) : cmd === 'integrate' ? rj({ merged: true }) : cmd === 'owns-check' ? rj({ ok: true, outside: [] }) : cmd === 'tests-check' ? rj({ ok: true, tests: [] }) : rj({ merged: true })
      }
      await ticks(cmd === 'integrate' ? 3 : 1)
      timeline.push(`end:${name}`)
      return out
    }
    const labels = o.labels ?? {}
    if (!Object.hasOwn(labels, opts.label)) {
      unscripted.push(String(opts.label))
      throw new Error(`unscripted label: ${opts.label}`)
    }
    timeline.push(`start:${opts.label}`)
    const h = labels[opts.label]
    let v
    try {
      v = typeof h === 'function' ? await h(call, calls) : h
    } finally {
      await ticks(2)
      timeline.push(`end:${opts.label}`)
    }
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
  const phase = () => {}
  const log = () => {}
  let result
  let error
  try {
    result = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'allowance', body)(agent, parallel, pipeline, phase, log, structuredClone(args), {})
  } catch (e) {
    error = e
  }
  const isAR = (c) => c.runner?.cmd === 'admit' || c.runner?.cmd === 'reap'
  const arNames = new Set(calls.filter(isAR).map((c) => c.runner.name))
  const notAR = (e) => !arNames.has(e.replace(/^(start|end):/, ''))
  return { result, error, calls, unscripted, timeline: timeline.filter(notAR), labels: calls.filter((c) => !isAR(c)).map((c) => c.label) }
}

const HEAD = 'a1'.repeat(20)
const BASE = 'd4'.repeat(20)
const PATCH = 'e5'.repeat(20)
const PASS = `VERDICT: PASS\n\n## Proof checked\nHead: ${HEAD}\nPatch: ${PATCH}\n`

const T1 = { name: 'write-tests', role: 'tester', effort: 'medium', files: ['tests/a.check.ts'], reads: ['src/a.ts'], brief: 'BRIEF-T1: write the tests for a', after: [] }
const B1 = { name: 'build-it', role: 'builder', effort: 'medium', files: ['src/a.ts'], reads: ['tests/a.check.ts'], brief: 'BRIEF-B1: build a', after: ['write-tests'] }
const PLAN = (...tasks) => ({ tasks: tasks.length ? tasks : [T1, B1], stop: null })
const done = (branch, proof = 'PROOF-' + branch) => ({ task: 'whatever', marker: 'DONE', branch, commit: 'c0'.repeat(20), proof, text: 'finished ' + branch })
const stopped = (marker, text) => ({ task: 'whatever', marker, branch: '', commit: '', proof: 'none', text })

const OLD = (slug = 'a', o = {}) => ({
  slug, stage: 1, goalFile: `/proj/.truss/goals/${slug}.md`, goal: 'GOAL-TEXT', owns: ['src/**', 'tests/*.ts'],
  acceptanceTest: 'node --test tests/a.check.ts', highImpact: ['src/core/**'], stressTest: false, scope: 'SCOPE-VERBATIM: build a, nothing else',
  worktree: `/wt/${slug}`, branch: `truss/${slug}`, base: BASE, architecture: '/proj/docs/ARCH.md', adrs: ['/proj/docs/adr/0001-x.md'],
  resume: null, tasks: [], done: [], answers: [], spent: 0, labelFrom: {}, ...o,
})
const base = (slug = 'a', over = {}) => ({
  [`${slug}-planner`]: PLAN(), [`${slug}-tester`]: done('feat/t', 'PROOF-T'), [`${slug}-builder`]: done('feat/b', 'PROOF-B'), [`${slug}-qc`]: PASS, ...over,
})
const stageArgs = (crews, o = {}) => ({
  truss: { kind: 'stage', dir: o.dir ?? '/proj/.truss', repo: '/proj', plugin: PLUGIN, target: 'main', reworkAllowance: 2, roles: o.roles ?? ROLES, scriptPath: PATHS['stage.js'], crews },
})
// does not fail on an unscripted label: on the base code a missing route surfaces as a stopped crew or a missing call, and each
// case asserts that with a message naming the behaviour
async function runStage(crews, o = {}) {
  const r = await exec('stage.js', stageArgs(crews, o), o)
  if (r.error) throw r.error
  r.res = r.result
  return r
}
const call = (r, label) => r.calls.find((c) => c.label === label)
const had = (r, label) => r.calls.some((c) => c.label === label)
const why = (r) => `result ${JSON.stringify(r.res).slice(0, 600)}; labels ${r.labels.join(',')}; unscripted ${r.unscripted.join(',')}`
const has = (s, sub) => assert.ok(s.includes(sub), `missing ${JSON.stringify(sub)} in:\n${s.slice(0, 2500)}`)
const hasnt = (s, sub) => assert.ok(!s.includes(sub), `unexpected ${JSON.stringify(sub)} in:\n${s.slice(0, 2500)}`)
const passed = (r, slug = 'a') => {
  const res = r.res.find((x) => x.slug === slug)
  assert.equal(res.state, 'passed', `crew ${slug} did not pass: ${why(r)}`)
}
const stopOf = (r, slug = 'a') => {
  const res = r.res.find((x) => x.slug === slug)
  assert.equal(res.state, 'stopped', `crew ${slug} did not stop: ${why(r)}`)
  return res
}
const mergeReady = (o = {}) => OLD('a', { resume: 'merge-ready', ...o })
const fixLabels = { 'a-tester': done('feat/ft'), 'a-builder': done('feat/fb') }
const mrLabels = (qc, extra = {}) => ({ 'a-qc': qc, 'a-qc-2': PASS, ...fixLabels, ...extra })
const greenFails = (record, times) => ({ key, n }) => (key === 'check:green' && n < times ? rj(record, 1) : undefined)

// ---------------------------------------------------------------- F-67: relative --dir, admit fails closed

t('F67 1: with a relative F.dir, every command line runFactory sends to the runner carries --dir resolved against F.repo', async () => {
  const r = await runStage([OLD('a')], { dir: '.git/truss/abc', labels: base('a') })
  const runners = r.calls.filter((c) => c.runner)
  const admit = runners.find((c) => c.runner.cmd === 'admit')
  assert.ok(admit, `no admit runner call: ${why(r)}`)
  assert.equal((admit.prompt.match(/--dir (\S+)/) || [])[1], '/proj/.git/truss/abc', `admit --dir in:\n${admit.prompt}`)
  const kinds = new Set()
  for (const c of runners) {
    kinds.add(c.runner.cmd)
    const dirs = [...c.prompt.matchAll(/--dir (\S+)/g)].map((m) => m[1])
    assert.ok(dirs.length >= 1, `${c.label} (${c.runner.cmd}) carries no --dir:\n${c.prompt}`)
    for (const d of dirs) assert.equal(d, '/proj/.git/truss/abc', `${c.label} (${c.runner.cmd}) --dir ${d}`)
  }
  for (const k of ['admit', 'reap', 'tests-check', 'check']) assert.ok(kinds.has(k), `no ${k} runner call was checked: ${[...kinds].join(',')}`)
})

const admitRunner = (out) => ({ cmd, slug }) => (cmd === 'admit' ? (typeof out === 'function' ? out(slug) : out) : undefined)

t('F67 2: an admit result that is not JSON, or has no boolean admitted, stops the crew BLOCKED with the output', async () => {
  const shapes = [
    ['not JSON', { exit: 0, stdout: 'NOT-JSON-OUT-1 and nothing else' }, 'NOT-JSON-OUT-1'],
    ['JSON with no admitted', { exit: 0, stdout: JSON.stringify({ parallelism: 4, running: 0, tag: 'NO-ADMITTED-2' }) }, 'NO-ADMITTED-2'],
    ['admitted not a boolean', { exit: 0, stdout: JSON.stringify({ admitted: 'yes', tag: 'STRING-ADMITTED-3' }) }, 'STRING-ADMITTED-3'],
    ['empty stdout', { exit: 1, stdout: '' }, 'exit 1'],
  ]
  for (const [name, out, mark] of shapes) {
    const r = await runStage([OLD('a')], { labels: base('a'), runner: admitRunner(out) })
    const res = stopOf(r)
    assert.equal(res.tag, 'BLOCKED', `${name}: ${why(r)}`)
    assert.ok(res.text.startsWith('admission check failed:'), `${name}: stop text ${JSON.stringify(res.text)}`)
    assert.ok(!res.text.startsWith('held by admission:'), `${name}: a held-by-admission prefix would start the resource monitor`)
    has(res.text, mark)
    assert.deepEqual(r.calls.filter((c) => !c.runner).map((c) => c.label), [], `${name}: a member was spawned`)
  }
  // the runner exits 2 on every crew of a stage: every crew stops BLOCKED, each with its own runner output
  const r = await runStage([OLD('a'), OLD('b')], {
    labels: { ...base('a'), ...base('b') },
    runner: admitRunner((slug) => ({ exit: 2, stdout: `usage: --dir must be absolute (crew ${slug})` })),
  })
  assert.equal(r.res.length, 2, why(r))
  for (const slug of ['a', 'b']) {
    const res = stopOf(r, slug)
    assert.equal(res.tag, 'BLOCKED', `crew ${slug}: ${why(r)}`)
    assert.ok(res.text.startsWith('admission check failed:'), `crew ${slug}: ${JSON.stringify(res.text)}`)
    has(res.text, `(crew ${slug})`)
    has(res.text, 'exit 2')
  }
  assert.deepEqual(r.calls.filter((c) => !c.runner).map((c) => c.label), [], 'a member was spawned')
})

t('control 1: F67 a sampler-error admit result {admitted: true, freeMB: null} admits', async () => {
  const r = await runStage([OLD('a')], { labels: base('a'), runner: admitRunner(rj({ admitted: true, parallelism: 4, running: 0, freeMB: null, minFreeMB: 2048 })) })
  passed(r)
  assert.ok(had(r, 'a-planner'), `no member was spawned: ${why(r)}`)
})
t('control 2: F67 an admit result {admitted: false, why} still stops BLOCKED with "held by admission: <why>"', async () => {
  const r = await runStage([OLD('a')], { labels: base('a'), runner: admitRunner(rj({ admitted: false, why: 'WHY-HELD-67' }, 1)) })
  const res = stopOf(r)
  assert.equal(res.tag, 'BLOCKED')
  assert.ok(res.text.startsWith('held by admission: WHY-HELD-67'), res.text)
  assert.deepEqual(r.calls.filter((c) => !c.runner).map((c) => c.label), [])
})
t('control 3: F67 an absolute F.dir reaches the runner unchanged', async () => {
  const r = await runStage([OLD('a')], { labels: base('a') })
  const admit = r.calls.find((c) => c.runner?.cmd === 'admit')
  assert.equal((admit.prompt.match(/--dir (\S+)/) || [])[1], '/proj/.truss')
  passed(r)
})

// ---------------------------------------------------------------- F-70: a green fix builder that stops on a tester file

const TF = 'tests/a.check.ts'
// the crew's tester files are exactly its guarded file, so a text names a tester file only by naming that one
const greenCrew = () => mergeReady({ guarded: [TF], ownTests: [] })
const GREEN_FAIL = { ok: false, tail: 'FAIL: GREEN-TAIL-70' }
const TOUCH = { commit: 'b0'.repeat(20), role: 'builder', files: [TF] }
const backstopSeen = (seen) => ({ cmd, key, n, prompt }) => {
  if (cmd !== 'tests-check') return undefined
  const m = prompt.match(/Backstop: (\S+)/)
  if (m) seen.push({ k: m[1] })
  return undefined
}
const withGreen = (record, times, seen) => {
  const g = greenFails(record, times)
  const b = backstopSeen(seen)
  return (x) => b(x) ?? g(x)
}
const backstopCalls = (r) => r.calls.filter((c) => c.runner?.cmd === 'tests-check' && /Backstop: /.test(c.prompt))
const greenChecks = (r) => r.calls.filter((c) => c.runner?.key === 'check:green')

t('F70 1: a green fix builder that ends BLOCKED or QUESTION naming a tester file is re-routed to a tester fix member, and the crew does not stop', async () => {
  for (const marker of ['BLOCKED', 'QUESTION']) {
    const text = `${marker}-TEXT-70: the case in ${TF} asserts the wrong value and I may not edit it`
    const r = await runStage([greenCrew()], {
      labels: mrLabels(PASS, { 'a-builder': stopped(marker, text) }),
      runner: greenFails(GREEN_FAIL, 1),
    })
    assert.ok(had(r, 'a-builder'), `${marker}: no fix builder ran: ${why(r)}`)
    const tester = call(r, 'a-tester')
    assert.ok(tester, `${marker}: no tester fix member ran: ${why(r)}`)
    assert.ok(tester.i > call(r, 'a-builder').i, `${marker}: the tester ran before the builder`)
    has(tester.prompt, text)
    has(tester.prompt, `Files you may change: ${TF}`)
    hasnt(tester.prompt, 'Files a tester owns, which you must not change')
    assert.equal(greenChecks(r).length, 2, `${marker}: green was not re-checked after the tester fix`)
    passed(r)
  }
})

t('F70 2: testsBackstop runs after each green fix', async () => {
  const seen = []
  const r = await runStage([greenCrew()], { labels: mrLabels(PASS, { 'a-resolver': done('truss/a', 'PROOF-RESOLVER') }), runner: withGreen(GREEN_FAIL, 1, seen) })
  passed(r)
  const builder = call(r, 'a-builder')
  assert.ok(builder, `no fix builder ran: ${why(r)}`)
  const bs = backstopCalls(r)
  assert.ok(bs.length >= 1, `no tests-check backstop ran after the green fix: ${why(r)}`)
  assert.ok(bs[0].i > builder.i, 'the backstop ran before the green fix builder')
  assert.ok(greenChecks(r)[1].i > bs[0].i, 'the green check was re-run before the backstop')
  // a backstop that finds a builder commit on a tester file runs the resolver role, as it does after a QC fix
  const touched = []
  const r2 = await runStage([greenCrew()], {
    labels: mrLabels(PASS, { 'a-resolver': done('truss/a', 'PROOF-RESOLVER') }),
    runner: (x) => {
      if (x.cmd === 'tests-check' && /Backstop: 1\.1/.test(x.prompt)) {
        touched.push(1)
        return rj({ ok: false, touched: [TOUCH], tests: [TF] }, 1)
      }
      return greenFails(GREEN_FAIL, 1)(x)
    },
  })
  assert.ok(touched.length, 'the backstop never ran')
  assert.ok(had(r2, 'a-resolver'), `a touched tester file after a green fix ran no resolver: ${why(r2)}`)
  passed(r2)
})
t('F70 2: testsBackstop also runs after the tester fix of a re-route', async () => {
  const r = await runStage([greenCrew()], {
    labels: mrLabels(PASS, { 'a-builder': stopped('BLOCKED', `the case in ${TF} is wrong`) }),
    runner: greenFails(GREEN_FAIL, 1),
  })
  const tester = call(r, 'a-tester')
  assert.ok(tester, `no tester fix member ran: ${why(r)}`)
  const after = backstopCalls(r).filter((c) => c.i > tester.i)
  assert.ok(after.length >= 1, `no backstop ran after the tester fix: ${why(r)}`)
  assert.ok(greenChecks(r)[1].i > after[0].i, 'the green check was re-run before the backstop')
})

t('F70 3: when the builder report names a tester file and a code file, the tester fix runs first, then a builder fix for the code half', async () => {
  const text = `NAMES-BOTH-70: the case in ${TF} is wrong, and src/a.ts returns the wrong value`
  const seen = []
  const r = await runStage([greenCrew()], {
    labels: mrLabels(PASS, { 'a-builder': stopped('BLOCKED', text), 'a-builder-2': done('feat/fb2') }),
    runner: withGreen(GREEN_FAIL, 1, seen),
  })
  const tester = call(r, 'a-tester')
  const builder2 = call(r, 'a-builder-2')
  assert.ok(tester, `no tester fix member ran: ${why(r)}`)
  assert.ok(builder2, `no builder fix for the code half ran: ${why(r)}`)
  assert.ok(tester.i > call(r, 'a-builder').i && builder2.i > tester.i, `order was wrong: tester ${tester.i}, builder fix ${builder2.i}`)
  has(builder2.prompt, 'src/a.ts')
  has(builder2.prompt, 'Never edit a file in the tester list above')
  assert.ok(backstopCalls(r).some((c) => c.i > builder2.i), 'no backstop ran after the builder fix of the code half')
  passed(r)
})

t('control 4: F70 a green failure whose output names the acceptance test file and a code assertion goes to the builder', async () => {
  const record = { ok: false, tail: `FAIL ${TF}: expected 1, got 2 in src/a.ts (the code under test)` }
  const r = await runStage([greenCrew()], { labels: mrLabels(PASS), runner: greenFails(record, 1) })
  passed(r)
  const builder = call(r, 'a-builder')
  assert.ok(builder, `no fix builder ran: ${why(r)}`)
  has(builder.prompt, `FAIL ${TF}: expected 1, got 2 in src/a.ts`)
  assert.ok(!had(r, 'a-tester'), 'a tester ran for a failure the builder can fix')
})
t('control 5: F70 a green fix builder that ends BLOCKED naming only a code file still stops the crew', async () => {
  const text = 'CODE-ONLY-70: src/a.ts needs a decision I cannot make'
  const r = await runStage([greenCrew()], { labels: mrLabels(PASS, { 'a-builder': stopped('BLOCKED', text) }), runner: greenFails(GREEN_FAIL, 1) })
  const res = stopOf(r)
  assert.equal(res.tag, 'BLOCKED')
  has(res.text, text)
  assert.ok(!had(r, 'a-tester'), 'a tester ran for a code-only stop')
})
t('control 6: F70 a green fix builder that ends QUESTION naming no file still stops the crew', async () => {
  const text = 'NO-FILE-70: which behaviour do you want?'
  const r = await runStage([greenCrew()], { labels: mrLabels(PASS, { 'a-builder': stopped('QUESTION', text) }), runner: greenFails(GREEN_FAIL, 1) })
  const res = stopOf(r)
  assert.equal(res.tag, 'QUESTION')
  has(res.text, text)
  assert.ok(!had(r, 'a-tester'), 'a tester ran for a stop naming no tester file')
})
t('control 7: F70 a green fix builder that finishes DONE runs no tester', async () => {
  const r = await runStage([greenCrew()], { labels: mrLabels(PASS), runner: greenFails(GREEN_FAIL, 1) })
  passed(r)
  assert.ok(!had(r, 'a-tester'), 'a tester ran after a DONE builder')
})

// ---------------------------------------------------------------- F-72: the foreground rule in the QC prompt and qc-engineer.md

const lineWith = (p, s) => p.split('\n').find((l) => l.includes(s)) ?? ''

t('F72 1: the prompt of the QC call, captured from a stubbed runStage run, carries the foreground rule', async () => {
  const r = await runStage([OLD('a')], { labels: base('a') })
  const member = call(r, 'a-builder')
  const qc = call(r, 'a-qc')
  assert.ok(member && qc, `no builder or QC call: ${why(r)}`)
  // the rule is the line memberPrompt gives a member, word for word (ADR-0027 F-72)
  const rule = lineWith(member.prompt, 'Run every command in the foreground')
  assert.ok(rule.includes('600000'), `the member prompt has no foreground line: ${rule}`)
  has(qc.prompt, rule)
  has(qc.prompt, 'foreground')
  has(qc.prompt, '600000')
  has(qc.prompt, 'run_in_background')
  has(qc.prompt, 'Monitor')
  has(qc.prompt, 'no polling loops, no sleep')
})
t('F72 2: the body of qc-engineer.md after the frontmatter carries the foreground rule key terms', () => {
  // CRLF dropped, so a Windows (core.autocrlf) checkout's frontmatter matches too
  const src = readFileSync(`${PLUGIN}/agents/qc-engineer.md`, 'utf8').replace(/\r\n/g, '\n')
  const m = src.match(/^---\n[\s\S]*?\n---\n/)
  assert.ok(m, 'qc-engineer.md has no frontmatter')
  const body = src.slice(m[0].length)
  for (const term of ['foreground', '600000', 'run_in_background', 'Monitor', 'sleep']) has(body, term)
})
t('control 8: F72 the QC prompt still opens with the verdict line and states the head and patch lines', async () => {
  const r = await runStage([OLD('a')], { labels: base('a') })
  const p = call(r, 'a-qc').prompt
  assert.ok(p.startsWith('Rule on crew a. Start your report with VERDICT: PASS or VERDICT: FAIL.'), p.slice(0, 200))
  has(p, 'Head: <sha>')
})

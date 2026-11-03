// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0024 (factory-fixes3), the stage.js items: 25 (answers at a UX step), 28 (the tests backstop is a resolver),
// 29 (args.truss missing), 30 (review mode), 31 (Head: line), 33 (the review takes its own screenshots), 34 (envSeen).
// Written from the spec before the change.
//
// Titles: `iN M:` cases fail on the base code; `control N:` cases pass on it (the old forms keep working).
// Every case drives the real workflows/stage.js through a stub agent and runner harness (copied from tests/stage-fixes2.check.ts).
// The plugin root comes from this file's own module path, never process.cwd(), so a copy of the base tree loads the base code.
//
// Run with: node --test tests/stage-fixes3.check.ts

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

// ---------------------------------------------------------------- harness (copied from tests/stage-fixes2.check.ts)

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
const qcFail = (...bullets) => `VERDICT: FAIL\n\n## Findings\n${bullets.map((b) => `- ${b}`).join('\n')}\n`

const T1 = { name: 'write-tests', role: 'tester', effort: 'medium', files: ['tests/a.check.ts'], reads: ['src/a.ts'], brief: 'BRIEF-T1: write the tests for a', after: [] }
const B1 = { name: 'build-it', role: 'builder', effort: 'medium', files: ['src/a.ts'], reads: ['tests/a.check.ts'], brief: 'BRIEF-B1: build a', after: ['write-tests'] }
const PLAN = (...tasks) => ({ tasks: tasks.length ? tasks : [T1, B1], stop: null })
const done = (branch, proof = 'PROOF-' + branch) => ({ task: 'whatever', marker: 'DONE', branch, commit: 'c0'.repeat(20), proof, text: 'finished ' + branch })

// the old entry form: no head, ownTests, guarded or livePage
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
  truss: { kind: 'stage', dir: '/proj/.truss', repo: '/proj', plugin: PLUGIN, target: 'main', reworkAllowance: 2, roles: o.roles ?? ROLES, scriptPath: PATHS['stage.js'], crews },
})
// Unlike stage-fixes2's runStage this does not fail on an unscripted label: on the base code a missing route surfaces as a
// stopped crew or a missing call, and each case asserts that with a message naming the behaviour.
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
const lineOf = (p, start) => p.split('\n').find((l) => l.startsWith(start)) ?? ''
const runnerPrompts = (r, cmd) => r.calls.filter((c) => c.runner?.cmd === cmd).map((c) => c.prompt)
const passed = (r, slug = 'a') => {
  const res = r.res.find((x) => x.slug === slug)
  assert.equal(res.state, 'passed', `crew ${slug} did not pass: ${why(r)}`)
}
const stoppedAt = (r, tag, at, slug = 'a') => {
  const res = r.res.find((x) => x.slug === slug)
  assert.equal(res.state, 'stopped', why(r))
  assert.equal(res.tag, tag, why(r))
  assert.equal(res.at, at, why(r))
  return res
}

// ---------------------------------------------------------------- fixtures

const DIR = 'UX: DIRECTION\nScreens: list view and detail view\nEmpty state: show a hint and one action\nMotion: none'
const REWORK = 'UX: REWORK\n1. Home: no empty state is drawn. Fix: draw the empty state from the direction.'
// an owns override keeps src/** so the stub plan's files (src/a.ts, tests/a.check.ts) stay inside it
const uxEntry = (o = {}) => OLD('a', { ux: true, direction: null, members: {}, ownTests: ['tests/*.ts'], ...o, ...(o.owns ? { owns: ['src/**', ...o.owns] } : {}) })
const uxBase = (over = {}) => base('a', { 'a-ux': DIR, 'a-ux-2': 'UX: PASS\n', ...over })
const answersEntry = (answers, o = {}) => OLD('a', { resume: 'answers', tasks: [T1, B1], answers, ...o })
const mergeReady = (o = {}) => OLD('a', { resume: 'merge-ready', ...o })
const fixLabels = { 'a-tester': done('feat/ft'), 'a-builder': done('feat/fb') }
const mrLabels = (qc, extra = {}) => ({ 'a-qc': qc, 'a-qc-2': PASS, ...fixLabels, ...extra })
const rolesJson = () => JSON.parse(readFileSync(`${PLUGIN}/workflows/roles.json`, 'utf8'))
void rolesJson

// ---------------------------------------------------------------- i25: an answer at a UX step reaches that step, not the members

const UXD = 'ANSWER-AT-UXD'
const UXR = 'ANSWER-AT-UXR'

t('i25 1: an answer at ux-direction reaches the ux-direction step and the planner, and no task member', async () => {
  const e = uxEntry({ resume: 'answers', tasks: [T1, B1], answers: [{ at: 'ux-direction', text: UXD }] })
  const r = await runStage([e], { labels: uxBase() })
  passed(r)
  has(call(r, 'a-ux').prompt, UXD)
  for (const label of ['a-tester', 'a-builder']) hasnt(call(r, label).prompt, UXD)
})
t('i25 2: an answer at ux-review reaches the review step and no task member and no fix member', async () => {
  const e = uxEntry({ resume: 'answers', tasks: [T1, B1], answers: [{ at: 'ux-review', text: UXR }] })
  const labels = uxBase({ 'a-ux-2': REWORK, 'a-ux-3': 'UX: PASS\n', 'a-builder-2': done('feat/fb') })
  const r = await runStage([e], { labels })
  passed(r)
  assert.ok(had(r, 'a-builder-2'), `the rework fix member did not run: ${why(r)}`)
  has(call(r, 'a-ux-2').prompt, UXR)
  for (const label of ['a-tester', 'a-builder', 'a-builder-2']) hasnt(call(r, label).prompt, UXR)
})
t('i25 3: QC gets the answers at ux-direction and ux-review under "Answers to earlier stops of this crew:", and no others', async () => {
  const answers = [
    { at: 'ux-direction', text: UXD },
    { at: 'ux-review', text: UXR },
    { at: 'green', text: 'ANSWER-AT-GREEN' },
    { at: 'write-tests', text: 'ANSWER-AT-TASK' },
  ]
  const r = await runStage([uxEntry({ resume: 'answers', tasks: [T1, B1], answers })], { labels: uxBase() })
  passed(r)
  const p = call(r, 'a-qc').prompt
  const lines = p.split('\n')
  const h = lines.indexOf('Answers to earlier stops of this crew:')
  assert.ok(h >= 0, `no "Answers to earlier stops of this crew:" block in the QC prompt:\n${p.slice(0, 2500)}`)
  const block = []
  for (let i = h + 1; i < lines.length && lines[i].trim() !== ''; i++) block.push(lines[i])
  assert.ok(block.some((l) => l.includes(UXD)), `the block lacks the ux-direction answer: ${block.join(' | ')}`)
  assert.ok(block.some((l) => l.includes(UXR)), `the block lacks the ux-review answer: ${block.join(' | ')}`)
  hasnt(p, 'ANSWER-AT-GREEN')
  hasnt(p, 'ANSWER-AT-TASK')
})
t('i25 4: a stale-name answer still reaches every member while an answer at ux-direction beside it reaches none', async () => {
  const answers = [{ at: 'gone-task', text: 'ANSWER-AT-GONE' }, { at: 'ux-direction', text: UXD }]
  const r = await runStage([uxEntry({ resume: 'answers', tasks: [T1, B1], answers })], { labels: uxBase() })
  passed(r)
  for (const label of ['a-tester', 'a-builder']) {
    has(call(r, label).prompt, 'ANSWER-AT-GONE')
    hasnt(call(r, label).prompt, UXD)
  }
})

t('control 20: answers at a crew-level stop reach every member and the planner; one at a task reaches that task only', async () => {
  const stops = ['red', 'split', 'green', 'R1', 'tests', 'scope', 'stress', 'qc', 'gone-task']
  const answers = [...stops.map((s) => ({ at: s, text: `ANS-${s}` })), { at: 'write-tests', text: 'ANS-TASK' }]
  const r = await runStage([answersEntry(answers)], { labels: base('a') })
  passed(r)
  for (const label of ['a-tester', 'a-builder']) for (const s of stops) has(call(r, label).prompt, `ANS-${s}`)
  has(call(r, 'a-tester').prompt, 'ANS-TASK')
  hasnt(call(r, 'a-builder').prompt, 'ANS-TASK')
  const pr = (await runStage([answersEntry(answers, { tasks: [] })], { labels: base('a') })).calls.find((c) => c.label === 'a-planner').prompt
  for (const s of stops) has(pr, `ANS-${s}`)
  has(pr, 'ANS-TASK')
})
t('control 21: the planner carries an answer at ux-direction and one at ux-review, and the step carries its own', async () => {
  const answers = [{ at: 'ux-direction', text: UXD }, { at: 'ux-review', text: UXR }]
  const r = await runStage([uxEntry({ resume: 'answers', tasks: [], answers })], { labels: uxBase() })
  passed(r)
  has(call(r, 'a-planner').prompt, UXD)
  has(call(r, 'a-planner').prompt, UXR)
  has(call(r, 'a-ux').prompt, UXD)
  hasnt(call(r, 'a-ux').prompt, UXR)
})
t('control 22: an answer at a crew-level stop reaches a fix member', async () => {
  const e = mergeReady({ answers: [{ at: 'green', text: 'ANS-FIX-GREEN' }] })
  const r = await runStage([e], { labels: mrLabels(qcFail('BFIND in src/a.ts')) })
  passed(r)
  has(call(r, 'a-builder').prompt, 'ANS-FIX-GREEN')
})

// ---------------------------------------------------------------- i28: the tests backstop is a resolver in the crew worktree

const TOUCH = { commit: 'b0'.repeat(20), role: 'builder', files: ['tests/a.check.ts'] }
const backstopRunner = (seen = []) => ({ cmd, prompt }) => {
  if (cmd !== 'tests-check') return undefined
  const m = prompt.match(/Backstop: (\S+)/)
  seen.push(m ? m[1] : 'guard')
  if (m && m[1] === '1.1') return rj({ ok: false, touched: [TOUCH], tests: ['tests/a.check.ts'] }, 1)
  return undefined
}
const backstopCrew = () => mergeReady({ guarded: ['tests/a.check.ts'], ownTests: [] })
const backstopLabels = () => mrLabels(qcFail('BFIND in src/a.ts'), { 'a-resolver': done('truss/a', 'PROOF-RESOLVER') })

t('i28 1: touched commits after a builder fix run the resolver role, not a tester or a second builder', async () => {
  const seen = []
  const r = await runStage([backstopCrew()], { labels: backstopLabels(), runner: backstopRunner(seen) })
  assert.ok(had(r, 'a-resolver'), `no a-resolver call for the tests backstop: ${why(r)}`)
  assert.ok(!had(r, 'a-tester'), `a tester ran the backstop: ${why(r)}`)
  assert.ok(call(r, 'a-builder').i < call(r, 'a-resolver').i, 'the resolver ran before the builder fix')
  passed(r)
  assert.deepEqual(seen.filter((s) => s !== 'guard'), ['1.1', '1.2'])
})
t('i28 2: the backstop prompt opens "Task: tests backstop, ", names the crew worktree, keeps the split and identical-tree rules, and has no git merge first step', async () => {
  const r = await runStage([backstopCrew()], { labels: backstopLabels(), runner: backstopRunner() })
  const c = call(r, 'a-resolver')
  assert.ok(c, `no a-resolver call: ${why(r)}`)
  const p = c.prompt
  assert.ok(lineOf(p, 'Task: tests backstop, ') !== '', `no line starting "Task: tests backstop, " in:\n${p.slice(0, 2500)}`)
  has(p, '/wt/a')
  has(p, 'b0'.repeat(20))
  has(p, 'Truss-Crew: a')
  has(p, 'Truss-Role: test-writer')
  has(p, 'tests/a.check.ts')
  has(p, 'identical')
  has(p, 'truss/a')
  hasnt(p, 'git merge')
  hasnt(p, 'Work in your own worktree')
  hasnt(p, 'Your first step, before anything else')
})
t('i28 3: the backstop integrates nothing: only the builder fix branch is integrated', async () => {
  const r = await runStage([backstopCrew()], { labels: backstopLabels(), runner: backstopRunner() })
  assert.ok(had(r, 'a-resolver'), `no a-resolver call: ${why(r)}`)
  const branches = r.calls.filter((c) => c.runner?.cmd === 'integrate').map((c) => c.runner.branch)
  assert.deepEqual(branches, ['feat/fb'])
})
t('i28 4: a resolver that does not finish the backstop stops the crew BLOCKED at the step it ran in', async () => {
  const labels = backstopLabels()
  labels['a-resolver'] = { task: 'x', marker: 'BLOCKED', branch: '', commit: '', proof: 'none', text: 'RESOLVER-CANNOT-SPLIT' }
  const r = await runStage([backstopCrew()], { labels, runner: backstopRunner() })
  assert.ok(had(r, 'a-resolver'), `no a-resolver call: ${why(r)}`)
  const res = r.res.find((x) => x.slug === 'a')
  assert.equal(res.state, 'stopped', why(r))
  assert.equal(res.tag, 'BLOCKED')
})

t('control 23: a tests-check with no touched commits after a builder fix runs no resolver and no tester', async () => {
  const seen = []
  const r = await runStage([backstopCrew()], { labels: backstopLabels(), runner: ({ cmd, prompt }) => {
    if (cmd === 'tests-check') seen.push((prompt.match(/Backstop: (\S+)/) || [])[1] || 'guard')
    return undefined
  } })
  passed(r)
  assert.ok(!had(r, 'a-resolver'), 'a resolver ran with nothing touched')
  assert.ok(!had(r, 'a-tester'), 'a tester ran with nothing touched')
  assert.deepEqual(seen.filter((s) => s !== 'guard'), ['1.1'])
})

// ---------------------------------------------------------------- i29: args.truss missing

const MISSING = 'args.truss is missing: the Workflow gate expands args.trussFile into args.truss; pass args.truss inline when the gate did not run'
for (const [n, a] of [[1, {}], [2, { trussFile: '/x' }], [3, { truss: null, trussFile: '/x' }], [4, { truss: 'inline text' }]]) {
  t(`i29 ${n}: stage.js run with args ${JSON.stringify(a)} throws the args.truss message before any agent call`, async () => {
    const r = await exec('stage.js', a, { labels: {} })
    assert.ok(r.error, `no throw; result ${JSON.stringify(r.result)}`)
    assert.equal(r.error.message, MISSING)
    assert.equal(r.calls.length, 0, `agent calls before the throw: ${r.labels.join(', ')}`)
  })
}
t('control 24: stage.js run with an object args.truss runs the crew', async () => {
  const r = await runStage([OLD('a')], { labels: base('a') })
  passed(r)
})

// ---------------------------------------------------------------- i30: Review mode

const reviewPrompt = async (o = {}) => {
  const r = await runStage([uxEntry(o)], { labels: uxBase() })
  const c = call(r, 'a-ux-2')
  assert.ok(c, `no review call: ${why(r)}`)
  return c.prompt
}
const modeOf = (p) => (lineOf(p, 'Review mode:').match(/^Review mode:\s*(\w+)/) || [])[1]
const LIVE = 'Live page (how review takes its own screenshots): start `npm --prefix ui run dev -- --port 5173` in the background, open http://localhost:5173/ and capture each screen with playwright'

t('i30 1: a crew that owns no page, component or style and has no Live page line gets "Review mode: files" and the files-only brief', async () => {
  const p = await reviewPrompt({ owns: ['docs/**', 'plugins/x/*.md', 'tests/*.ts'] })
  assert.equal(modeOf(p), 'files', `Review mode line: ${JSON.stringify(lineOf(p, 'Review mode:'))}`)
  has(p, 'from the files and diff alone')
})
for (const [n, ext] of [[2, 'tsx'], [3, 'jsx'], [4, 'vue'], [5, 'svelte'], [6, 'css'], [7, 'html']]) {
  t(`i30 ${n}: an owned .${ext} file makes it "Review mode: live"`, async () => {
    const p = await reviewPrompt({ owns: ['docs/**', `ui/src/page.${ext}`, 'tests/*.ts'] })
    assert.equal(modeOf(p), 'live', `Review mode line: ${JSON.stringify(lineOf(p, 'Review mode:'))}`)
  })
}
t('i30 8: a glob such as ui/e2e/** is not a page, component or style: "Review mode: files"', async () => {
  const p = await reviewPrompt({ owns: ['ui/e2e/**', 'tests/*.ts'] })
  assert.equal(modeOf(p), 'files', `Review mode line: ${JSON.stringify(lineOf(p, 'Review mode:'))}`)
})
t('i30 9: a livePage string makes the review live even when the crew owns no UI file', async () => {
  const p = await reviewPrompt({ owns: ['docs/**', 'tests/*.ts'], livePage: LIVE })
  assert.equal(modeOf(p), 'live', `Review mode line: ${JSON.stringify(lineOf(p, 'Review mode:'))}`)
})
t('i30 10: a null or empty livePage leaves the mode to owns alone', async () => {
  for (const livePage of [null, '']) {
    const p = await reviewPrompt({ owns: ['docs/**', 'tests/*.ts'], livePage })
    assert.equal(modeOf(p), 'files', `livePage ${JSON.stringify(livePage)}: ${JSON.stringify(lineOf(p, 'Review mode:'))}`)
  }
})
t('i30 11: the second review of a crew carries the same Review mode line as the first', async () => {
  const e = uxEntry({ owns: ['docs/**', 'tests/*.ts'] })
  const r = await runStage([e], { labels: uxBase({ 'a-ux-2': REWORK, 'a-ux-3': 'UX: PASS\n', 'a-builder-2': done('feat/fb') }) })
  for (const label of ['a-ux-2', 'a-ux-3']) assert.equal(modeOf(call(r, label).prompt), 'files', `${label}: ${why(r)}`)
})
t('i30 12: ux-engineer.md no longer stops BLOCKED for no screenshots, and no longer stops with a QUESTION for no port', () => {
  const md = readFileSync(`${PLUGIN}/agents/ux-engineer.md`, 'utf8')
  hasnt(md, 'BLOCKED: no screenshots in the green check output and no dev server in the goal file; nothing to review.')
  hasnt(md, 'QUESTION: the review needs the live page but the resource slice gives no port')
})

// ---------------------------------------------------------------- i33: the review takes its own screenshots

t('i33 1: a livePage line is quoted word for word in the review brief, and the default steps are not added', async () => {
  const p = await reviewPrompt({ owns: ['ui/**', 'ui/src/App.tsx', 'tests/*.ts'], livePage: LIVE })
  has(p, LIVE)
  hasnt(p, 'node ui/server/main.ts')
})
t('i33 2: with no livePage, a live review of a crew that owns ui/** gets the default steps', async () => {
  const p = await reviewPrompt({ owns: ['ui/**', 'ui/src/App.tsx', 'tests/*.ts'] })
  assert.equal(modeOf(p), 'live')
  has(p, 'npm --prefix ui run build')
  has(p, 'node ui/server/main.ts')
  has(p, 'background')
  has(p, 'listening')
  has(p, '@playwright/test')
  has(p, 'chromium')
  has(p, 'ui/node_modules')
  has(p, 'pid')
})
t('i33 3: the brief says never to stop BLOCKED for missing screenshots, and to review from the files after two failed starts', async () => {
  const p = await reviewPrompt({ owns: ['ui/**', 'ui/src/App.tsx', 'tests/*.ts'] })
  assert.ok(/never stop BLOCKED for missing screenshots/i.test(p), `no "never stop BLOCKED for missing screenshots" in:\n${p.slice(0, 2500)}`)
  assert.ok(/two failed starts/i.test(p), 'no "two failed starts"')
  assert.ok(/review from the files/i.test(p), 'no "review from the files"')
})
t('i33 4: with no livePage the brief tells the UX engineer to read the goal file\'s ## UX section for its Live page line', async () => {
  const p = await reviewPrompt({ owns: ['docs/**', 'tests/*.ts'] })
  has(p, '## UX')
  has(p, 'Live page')
  hasnt(p, 'node ui/server/main.ts')
  hasnt(p, 'npm --prefix ui run build')
})
t('i33 5: ux-engineer.md tells the reviewer to take its own screenshots with playwright', () => {
  const md = readFileSync(`${PLUGIN}/agents/ux-engineer.md`, 'utf8')
  assert.ok(/playwright/i.test(md), 'ux-engineer.md does not mention playwright')
})

t('control 25: a ux crew with an old-form entry (no livePage) still runs both UX steps to PASS', async () => {
  const r = await runStage([uxEntry()], { labels: uxBase() })
  passed(r)
  assert.ok(had(r, 'a-ux') && had(r, 'a-ux-2'))
})

// ---------------------------------------------------------------- i31: the Head line of the tests guard and the backstop

const H = 'f0'.repeat(20)
const headLines = (p) => p.split('\n').filter((l) => l.startsWith('Head: '))

t('i31 1: the tests guard prompt carries "Head: <entry.head>" and no other runner prompt does', async () => {
  const r = await runStage([OLD('a', { head: HEAD })], { labels: base('a') })
  passed(r)
  const guards = runnerPrompts(r, 'tests-check')
  assert.ok(guards.length > 0, 'no tests-check ran')
  for (const p of guards) assert.deepEqual(headLines(p), [`Head: ${HEAD}`])
  for (const cmd of ['owns-check', 'integrate', 'sync']) for (const p of runnerPrompts(r, cmd)) hasnt(p, `Head: ${HEAD}`)
})
t('i31 2: the Head line follows the Attempt line when the crew has an answer at tests', async () => {
  const r = await runStage([answersEntry([{ at: 'tests', text: 'BRANCH-REWRITTEN' }], { head: HEAD })], { labels: base('a') })
  passed(r)
  const lines = runnerPrompts(r, 'tests-check')[0].split('\n')
  const a = lines.indexOf('Attempt: 1')
  const h = lines.indexOf(`Head: ${HEAD}`)
  assert.ok(a >= 0, 'no Attempt: 1 line')
  assert.ok(h > a, `Head line at ${h}, Attempt line at ${a}`)
})
t('i31 3: both backstop runs carry the Head line, and a changed head changes the prompt', async () => {
  const seen = []
  const r = await runStage([{ ...backstopCrew(), head: HEAD }], { labels: backstopLabels(), runner: ({ cmd, prompt }) => {
    if (cmd === 'tests-check' && /Backstop: /.test(prompt)) seen.push(prompt)
    return backstopRunner()({ cmd, prompt })
  } })
  assert.equal(seen.length, 2, `backstop runs: ${seen.length}`)
  for (const p of seen) assert.deepEqual(headLines(p), [`Head: ${HEAD}`])
  // the green record's head equals entry.head in both runs, so the title holds on the entry head and on the run's head alike
  const E0 = 'e0'.repeat(20)
  const greenE0 = ({ key }) => (key === 'check:green' ? rj({ ok: true, head: E0 }) : undefined)
  const r2 = await runStage([{ ...backstopCrew(), head: E0 }], { labels: mrLabels(qcFail('BFIND in src/a.ts'), { 'a-qc-2': PASS.replace(HEAD, E0), 'a-resolver': done('truss/a', 'PROOF-RESOLVER') }), runner: (x) => backstopRunner()(x) ?? greenE0(x) })
  const first = (x) => runnerPrompts(x, 'tests-check').find((p) => p.includes('Backstop: 1.1'))
  assert.notEqual(first(r), first(r2))
})

t('control 26: an entry without head gives no Head line, and an old-form entry (no head, ownTests, guarded) runs to PASS', async () => {
  const r = await runStage([OLD('a')], { labels: base('a') })
  passed(r)
  for (const p of runnerPrompts(r, 'tests-check')) assert.deepEqual(headLines(p), [])
  const r2 = await runStage([backstopCrew()], { labels: backstopLabels(), runner: backstopRunner() })
  for (const p of runnerPrompts(r2, 'tests-check')) assert.deepEqual(headLines(p), [])
})

// ---------------------------------------------------------------- i34: envSeen

const SEEN = 'browserType.launch: WebKit lacks libicudata.so.74'
const greenFails = (record, times) => ({ key, n }) => (key === 'check:green' && n < times ? rj(record, 1) : undefined)

t('i34 1: a failing green record with envSeen and no env sends a fix builder whose detail names the line and says the cases belong to the host', async () => {
  const r = await runStage([mergeReady()], { labels: mrLabels(PASS), runner: greenFails({ ok: false, envSeen: SEEN }, 1) })
  passed(r)
  const c = call(r, 'a-builder')
  assert.ok(c, `no fix builder ran: ${why(r)}`)
  // the raw record sits in the output tail once; the detail's own naming of the line is the second
  assert.ok(c.prompt.split(SEEN).length - 1 >= 2, `the detail does not name the envSeen line apart from the output tail:\n${c.prompt.slice(0, 2500)}`)
  assert.ok(/belong to the host/.test(c.prompt), `no "belong to the host" in:\n${c.prompt.slice(0, 2500)}`)
})
t('i34 2: the second green fix builder names the envSeen line too', async () => {
  const labels = mrLabels(PASS, { 'a-builder-2': done('feat/fb2') })
  const r = await runStage([mergeReady()], { labels, runner: greenFails({ ok: false, envSeen: SEEN }, 2) })
  passed(r)
  for (const label of ['a-builder', 'a-builder-2']) {
    const c = call(r, label)
    assert.ok(c, `no ${label}: ${why(r)}`)
    assert.ok(c.prompt.split(SEEN).length - 1 >= 2, `${label}: the detail does not name the envSeen line apart from the output tail`)
    assert.ok(/belong to the host/.test(c.prompt), `${label}: no "belong to the host"`)
  }
})

t('control 27: a green record with env stops BLOCKED at green and runs no fix builder', async () => {
  const r = await runStage([mergeReady()], { labels: mrLabels(PASS), runner: greenFails({ ok: false, env: 'libicudata.so.74 missing' }, 9) })
  const res = stoppedAt(r, 'BLOCKED', 'green')
  has(res.text, 'libicudata.so.74 missing')
  assert.ok(!had(r, 'a-builder'), 'a fix builder ran for an env failure')
})
t('control 28: a green record with both env and envSeen stops BLOCKED at green as with env alone', async () => {
  const r = await runStage([mergeReady()], { labels: mrLabels(PASS), runner: greenFails({ ok: false, env: 'libicudata.so.74 missing', envSeen: 'libicudata.so.74 missing' }, 9) })
  const res = stoppedAt(r, 'BLOCKED', 'green')
  has(res.text, 'libicudata.so.74 missing')
  assert.ok(!had(r, 'a-builder'), 'a fix builder ran for an env failure')
})
t('control 29: a green record with neither env nor envSeen sends a fix builder with no host line', async () => {
  const r = await runStage([mergeReady()], { labels: mrLabels(PASS), runner: greenFails({ ok: false }, 1) })
  passed(r)
  hasnt(call(r, 'a-builder').prompt, 'belong to the host')
})

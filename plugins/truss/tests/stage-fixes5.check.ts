// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0026 (factory-fixes5), the stage.js items: 48 (an answer at a done task re-runs it, the tester's
// Truss-Role: test-writer commit passes the tests guard) and 51 (UX review mode for ui/**, the backstop prompt,
// the backstop resolver's tag, the Head line on crew.head, JSON-string args).
// Written from the spec before the change.
//
// Titles: `iN M:` cases fail on the base code; `control N:` cases pass on it (the old forms keep working).
// Every case drives the real workflows/stage.js through a stub agent and runner harness (copied from tests/stage-fixes3.check.ts).
// The plugin root comes from this file's own module path, never process.cwd(), so a copy of the base tree loads the base code.
//
// Run with: node --test tests/stage-fixes5.check.ts

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { gatesAware } from './fixtures/gates-stub.ts'
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
  const agent = gatesAware(async (prompt, opts = {}) => {
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
  })
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
    result = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'allowance', body)(agent, parallel, pipeline, phase, log, typeof args === 'string' ? args : structuredClone(args), {})
  } catch (e) {
    error = e
  }
  const isAR = (c) => c.runner?.cmd === 'admit' || c.runner?.cmd === 'reap'
  const arNames = new Set(calls.filter(isAR).map((c) => c.runner.name))
  const notAR = (e) => !arNames.has(e.replace(/^(start|end):/, ''))
  return { result, error, calls, unscripted, timeline: timeline.filter(notAR), labels: calls.filter((c) => !isAR(c)).map((c) => c.label) }
}

const HEAD = 'a1'.repeat(20)
const GREEN = 'c7'.repeat(20)
const BASE = 'd4'.repeat(20)
const PATCH = 'e5'.repeat(20)
const passFor = (head) => `VERDICT: PASS\n\n## Proof checked\nHead: ${head}\nPatch: ${PATCH}\n`
const PASS = passFor(HEAD)
const qcFail = (...bullets) => `VERDICT: FAIL\n\n## Findings\n${bullets.map((b) => `- ${b}`).join('\n')}\n`

const T1 = { name: 'write-tests', role: 'tester', effort: 'medium', files: ['tests/a.check.ts'], reads: ['src/a.ts'], brief: 'BRIEF-T1: write the tests for a', after: [] }
const B1 = { name: 'build-it', role: 'builder', effort: 'medium', files: ['src/a.ts'], reads: ['tests/a.check.ts'], brief: 'BRIEF-B1: build a', after: ['write-tests'] }
const PLAN = (...tasks) => ({ tasks: tasks.length ? tasks : [T1, B1], stop: null })
const done = (branch, proof = 'PROOF-' + branch) => ({ task: 'whatever', marker: 'DONE', branch, commit: 'c0'.repeat(20), proof, text: 'finished ' + branch })

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
async function runStage(crews, o = {}) {
  const r = await exec('stage.js', o.args ?? stageArgs(crews, o), o)
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
const stoppedTag = (r, tag, slug = 'a') => {
  const res = r.res.find((x) => x.slug === slug)
  assert.equal(res.state, 'stopped', why(r))
  assert.equal(res.tag, tag, why(r))
  return res
}

// ---------------------------------------------------------------- fixtures

const answersEntry = (answers, o = {}) => OLD('a', { resume: 'answers', tasks: [T1, B1], done: ['write-tests', 'build-it'], answers, ...o })
const mergeReady = (o = {}) => OLD('a', { resume: 'merge-ready', ...o })
const fixLabels = { 'a-tester': done('feat/ft'), 'a-builder': done('feat/fb') }
const mrLabels = (qc, extra = {}) => ({ 'a-qc': qc, 'a-qc-2': PASS, ...fixLabels, ...extra })
const TRAILER = 'Truss-Role: test-writer'

// ---------------------------------------------------------------- i48: an answer at a done task re-runs it

const ANS_T = 'ANSWER-FOR-THE-TESTER-TASK'
const ANS_B = 'ANSWER-FOR-THE-BUILDER-TASK'

t('i48 1: a done tester task with an answer at its name is spawned once with the answer and the test-writer trailer, and the done builder is not spawned', async () => {
  const r = await runStage([answersEntry([{ at: 'write-tests', text: ANS_T }])], { labels: base('a') })
  const testers = r.calls.filter((c) => /^a-tester(-\d+)?$/.test(c.label))
  assert.equal(testers.length, 1, `tester spawns: ${testers.length}; ${why(r)}`)
  has(testers[0].prompt, ANS_T)
  has(testers[0].prompt, TRAILER)
  has(testers[0].prompt, 'Task: write-tests')
  assert.ok(!had(r, 'a-builder'), `the done builder was spawned: ${why(r)}`)
  passed(r)
})

t('i48 2: a done builder task named by an answer re-runs the same way, and the done tester is not spawned', async () => {
  const r = await runStage([answersEntry([{ at: 'build-it', text: ANS_B }])], { labels: base('a') })
  const builders = r.calls.filter((c) => /^a-builder(-\d+)?$/.test(c.label))
  assert.equal(builders.length, 1, `builder spawns: ${builders.length}; ${why(r)}`)
  has(builders[0].prompt, ANS_B)
  has(builders[0].prompt, 'Task: build-it')
  assert.ok(!had(r, 'a-tester'), `the done tester was spawned: ${why(r)}`)
  passed(r)
})

t('i48 3: after an answer re-runs the tester, its test-writer commit passes the tests guard and the crew reaches green, not BLOCKED', async () => {
  let rewritten = false
  const labels = base('a', {
    'a-tester': (c) => {
      if (c.prompt.includes(TRAILER)) rewritten = true
      return done('feat/t', 'PROOF-T')
    },
  })
  const touched = { ok: false, touched: [{ commit: 'b0'.repeat(20), role: 'builder', files: ['tests/a.check.ts'] }], tests: ['tests/a.check.ts'] }
  const runner = ({ cmd }) => (cmd === 'tests-check' && !rewritten ? rj(touched, 1) : undefined)
  const r = await runStage([answersEntry([{ at: 'write-tests', text: ANS_T }])], { labels, runner })
  assert.ok(rewritten, `no test-writer tester ran: ${why(r)}`)
  assert.ok(runnerPrompts(r, 'tests-check').length > 0, 'the tests guard never ran')
  passed(r)
  assert.ok(r.calls.some((c) => c.runner?.key === 'check:green'), 'the green check never ran')
})

t('control 30: i48 an answer at green with every task done spawns no member and the crew passes', async () => {
  const r = await runStage([answersEntry([{ at: 'green', text: 'ANSWER-AT-GREEN' }])], { labels: base('a') })
  assert.ok(!had(r, 'a-tester') && !had(r, 'a-builder'), `a member ran: ${why(r)}`)
  passed(r)
})

// ---------------------------------------------------------------- i51 1: owns ui/** is a UI crew

const DIR = 'UX: DIRECTION\nScreens: list view and detail view\nEmpty state: show a hint and one action\nMotion: none'
const uxEntry = (o = {}) => OLD('a', { ux: true, direction: null, members: {}, ownTests: ['tests/*.ts'], ...o, ...(o.owns ? { owns: ['src/**', ...o.owns] } : {}) })
const uxBase = (over = {}) => base('a', { 'a-ux': DIR, 'a-ux-2': 'UX: PASS\n', ...over })
const reviewPrompt = async (o = {}) => {
  const r = await runStage([uxEntry(o)], { labels: uxBase() })
  const c = call(r, 'a-ux-2')
  assert.ok(c, `no review call: ${why(r)}`)
  return c.prompt
}
const modeOf = (p) => (lineOf(p, 'Review mode:').match(/^Review mode:\s*(\w+)/) || [])[1]

t('i51 1: an owns of ui/** alone, with no livePage, gets "Review mode: live" and the ui/** default steps', async () => {
  const p = await reviewPrompt({ owns: ['ui/**', 'tests/*.ts'] })
  assert.equal(modeOf(p), 'live', `Review mode line: ${JSON.stringify(lineOf(p, 'Review mode:'))}`)
  has(p, 'npm --prefix ui run build')
  has(p, 'node ui/server/main.ts')
})

t('control 31: i51 an owns of docs only, with no livePage, still gets "Review mode: files"', async () => {
  const p = await reviewPrompt({ owns: ['docs/**', 'tests/*.ts'] })
  assert.equal(modeOf(p), 'files', `Review mode line: ${JSON.stringify(lineOf(p, 'Review mode:'))}`)
  hasnt(p, 'node ui/server/main.ts')
})

// ---------------------------------------------------------------- i51 2, 3: the tests backstop

const TOUCH = { commit: 'b0'.repeat(20), role: 'builder', files: ['tests/a.check.ts'] }
const backstopRunner = (extra) => (x) => {
  const { cmd, prompt } = x
  if (cmd !== 'tests-check') return extra ? extra(x) : undefined
  const m = prompt.match(/Backstop: (\S+)/)
  if (m && m[1] === '1.1') return rj({ ok: false, touched: [TOUCH], tests: ['tests/a.check.ts'] }, 1)
  return extra ? extra(x) : undefined
}
const backstopCrew = (o = {}) => mergeReady({ guarded: ['tests/a.check.ts'], ownTests: [], ...o })
const backstopLabels = (resolver = done('truss/a', 'PROOF-RESOLVER'), qc = PASS) => mrLabels(qcFail('BFIND in src/a.ts'), { 'a-qc-2': qc, 'a-resolver': resolver })
const REPORT = (marker, text) => ({ task: 'x', marker, branch: '', commit: '', proof: 'none', text })

t('i51 2: the backstop prompt tells the resolver to work and commit on the crew branch in the crew worktree, with no own-worktree line and no "Commit on your branch"', async () => {
  const r = await runStage([backstopCrew()], { labels: backstopLabels(), runner: backstopRunner() })
  const c = call(r, 'a-resolver')
  assert.ok(c, `no a-resolver call: ${why(r)}`)
  const p = c.prompt
  assert.ok(/work and commit on the crew branch truss\/a in the crew worktree \/wt\/a/i.test(p), `no "work and commit on the crew branch truss/a in the crew worktree /wt/a" in:\n${p.slice(0, 2500)}`)
  hasnt(p, 'Prove your own change with a plain node --test in your own worktree')
  hasnt(p, 'Commit on your branch')
  has(p, 'Task: tests backstop, ')
  has(p, 'Truss-Role: test-writer')
})

for (const marker of ['QUESTION', 'PROPOSAL', 'CHECKPOINT']) {
  t(`i51 3: a backstop resolver that reports ${marker} stops the crew with that tag`, async () => {
    const r = await runStage([backstopCrew()], { labels: backstopLabels(REPORT(marker, `RESOLVER-SAYS-${marker}`)), runner: backstopRunner() })
    assert.ok(had(r, 'a-resolver'), `no a-resolver call: ${why(r)}`)
    const res = stoppedTag(r, marker)
    has(String(res.text), `RESOLVER-SAYS-${marker}`)
  })
}

t('control 32: i51 a task member prompt still carries the own-worktree proof line and "Commit on your branch"', async () => {
  const r = await runStage([OLD('a')], { labels: base('a') })
  passed(r)
  const p = call(r, 'a-builder').prompt
  has(p, 'Prove your own change with a plain node --test in your own worktree')
  has(p, 'Commit on your branch')
})

t('control 33: i51 a backstop resolver that reports BLOCKED stays BLOCKED', async () => {
  const r = await runStage([backstopCrew()], { labels: backstopLabels(REPORT('BLOCKED', 'RESOLVER-CANNOT-SPLIT')), runner: backstopRunner() })
  assert.ok(had(r, 'a-resolver'), `no a-resolver call: ${why(r)}`)
  stoppedTag(r, 'BLOCKED')
})

t('control 34: i51 a backstop resolver with no report stays BLOCKED', async () => {
  const r = await runStage([backstopCrew()], { labels: backstopLabels(null), runner: backstopRunner() })
  assert.ok(had(r, 'a-resolver'), `no a-resolver call: ${why(r)}`)
  stoppedTag(r, 'BLOCKED')
})

// ---------------------------------------------------------------- i51 4: the Head line follows crew.head

const headLines = (p) => p.split('\n').filter((l) => l.startsWith('Head: '))
const H = 'f0'.repeat(20)

t('i51 4: the tests guard Head line names the green record head once the run has moved it off entry.head', async () => {
  const runner = ({ key }) => (key === 'check:green' ? rj({ ok: true, head: GREEN }) : undefined)
  const r = await runStage([OLD('a', { head: H })], { labels: base('a', { 'a-qc': passFor(GREEN) }), runner })
  passed(r)
  const guards = runnerPrompts(r, 'tests-check')
  assert.ok(guards.length > 0, 'no tests-check ran')
  for (const p of guards) assert.deepEqual(headLines(p), [`Head: ${GREEN}`])
})

t('i51 4: a backstop run after a green that moved the head carries the green head, not entry.head', async () => {
  const runner = backstopRunner(({ key }) => (key === 'check:green' ? rj({ ok: true, head: GREEN }) : undefined))
  const r = await runStage([backstopCrew({ head: H })], { labels: backstopLabels(undefined, passFor(GREEN)), runner })
  const bs = runnerPrompts(r, 'tests-check').filter((p) => /Backstop: /.test(p))
  assert.equal(bs.length, 2, `backstop runs: ${bs.length}; ${why(r)}`)
  for (const p of bs) assert.deepEqual(headLines(p), [`Head: ${GREEN}`])
})

// ---------------------------------------------------------------- i51 5: args as a JSON string

const MISSING = 'args.truss is missing: the Workflow gate expands args.trussFile into args.truss; pass args.truss inline when the gate did not run'

t('i51 5: args as a JSON string holding {truss} runs the same crew as the object form', async () => {
  const crews = [OLD('a')]
  const viaObject = await runStage(crews, { labels: base('a') })
  const viaString = await runStage(crews, { labels: base('a'), args: JSON.stringify(stageArgs(crews)) })
  passed(viaString)
  assert.deepEqual(viaString.res, viaObject.res)
  assert.deepEqual(viaString.labels, viaObject.labels)
})

t('control 35: i51 an object args.truss still runs the crew', async () => {
  const r = await runStage([OLD('a')], { labels: base('a') })
  passed(r)
})

t('control 36: i51 a non-JSON string, and a JSON string of a non-object, throw the args.truss message before any agent call', async () => {
  for (const a of ['not json at all', '"just text"', '[1,2]', '5', 'null', JSON.stringify({ trussFile: '/x' })]) {
    const r = await exec('stage.js', a, { labels: {} })
    assert.ok(r.error, `no throw for ${JSON.stringify(a)}; result ${JSON.stringify(r.result)}`)
    assert.equal(r.error.message, MISSING)
    assert.equal(r.calls.length, 0)
  }
})

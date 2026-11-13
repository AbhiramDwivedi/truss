// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0022 (the UX engineer): U2 the roles row, U3 which crews get a UX engineer, U4 the direction and review steps in
// chain(), U5 (item 22) met without a retyped stdout, U6 (item 23) ## Members sets the model and effort, R4 the ux audit.
//
// Written from the ADR before the code exists. Every case drives the real workflows/stage.js through the same stub harness
// tests/stage-briefs.check.ts uses (AsyncFunction over the stage.js body, stubbed agent replies) or the real factory CLI through
// runCli / mkEnv / writeGoal / mkRun in fixtures/workflow-run/harness.ts; none greps a source. Titles are `<prefix> <n>: <words>`.
// `control` cases pass on the base code and after; every other case fails on the base code by an assertion.
//
// Run with: node --test tests/ux-runtime.check.ts

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { gatesAware } from './fixtures/gates-stub.ts'
import { fileURLToPath } from 'node:url'
import { addCrewWorktree, appendEvent, crew, factorySpawn, git, mkEnv, mkRun, planObj, qcReport, readPlan, writeGoal, writePlan, writeReport } from './fixtures/workflow-run/harness.ts'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')
const PATHS = { 'stage.js': `${PLUGIN}/workflows/stage.js` }
const t = (name, fn) => test(name, { timeout: 30000 }, fn)

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

// ---------------------------------------------------------------- stage.js stub harness (copied from tests/stage-briefs.check.ts)

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
    result = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'allowance', body)(agent, parallel, pipeline, phase, log, structuredClone(args), {})
  } catch (e) {
    error = e
  }
  const isAR = (c) => c.runner?.cmd === 'admit' || c.runner?.cmd === 'reap'
  const arNames = new Set(calls.filter(isAR).map((c) => c.runner.name))
  const notAR = (e) => !arNames.has(e.replace(/^(start|end):/, ''))
  return { result, error, calls, unscripted, timeline: timeline.filter(notAR), allTimeline: timeline, labels: calls.filter((c) => !isAR(c)).map((c) => c.label), allLabels: calls.map((c) => c.label) }
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

const entry = (slug = 'a', o = {}) => ({
  slug, stage: 1, goalFile: `/proj/.truss/goals/${slug}.md`, goal: 'GOAL-TEXT', owns: ['src/**', 'tests/*.ts'],
  acceptanceTest: 'node --test tests/a.check.ts', highImpact: ['src/core/**'], stressTest: false, scope: 'SCOPE-VERBATIM: build a, nothing else',
  worktree: `/wt/${slug}`, branch: `truss/${slug}`, base: BASE, architecture: '/proj/docs/ARCH.md', adrs: ['/proj/docs/adr/0001-x.md'],
  ownTests: ['tests/*.ts'], resume: null, tasks: [], done: [], answers: [], spent: 0, labelFrom: {}, ...o,
})
const base = (slug = 'a', over = {}) => ({
  [`${slug}-planner`]: PLAN(), [`${slug}-tester`]: done('feat/t', 'PROOF-T'), [`${slug}-builder`]: done('feat/b', 'PROOF-B'), [`${slug}-qc`]: PASS, ...over,
})
const stageArgs = (crews, roles = ROLES) => ({
  truss: { kind: 'stage', dir: '/proj/.truss', repo: '/proj', plugin: PLUGIN, target: 'main', reworkAllowance: 2, roles, scriptPath: PATHS['stage.js'], crews },
})
// Unlike stage-briefs' runStage this does not fail on an unscripted label: on the base code a missing route surfaces as a
// stopped crew or a missing call, and each case asserts that with a message naming the behaviour.
async function runStage(crews, o = {}) {
  const r = await exec('stage.js', stageArgs(crews, o.roles), o)
  if (r.error) throw r.error
  r.res = r.result
  return r
}
const call = (r, label) => r.calls.find((c) => c.label === label)
const had = (r, label) => r.calls.some((c) => c.label === label)
const idx = (r, ev) => r.timeline.indexOf(ev)
const why = (r) => `result ${JSON.stringify(r.res).slice(0, 600)}; labels ${r.labels.join(',')}; unscripted ${r.unscripted.join(',')}`

// ---------------------------------------------------------------- ux fixtures

const DIR = 'UX: DIRECTION\nScreens: list view and detail view\nEmpty state: show a hint and one action\nMotion: none'
const DIR_LINES = DIR.split('\n').slice(1)
const REWORK = 'UX: REWORK\n1. Home: no empty state is drawn. Fix: draw the empty state from the direction.'
const uxCrew = (o = {}) => entry('a', { ux: true, direction: null, members: {}, ...o })
const uxBase = (over = {}) => base('a', { 'a-ux': DIR, 'a-ux-2': 'UX: PASS\n', ...over })
const heading = (label) => `The crew's UX direction (report ${label}), quoted:`

function assertQuoted(r, label, dirLines = DIR_LINES, heads = heading('a-ux')) {
  const c = call(r, label)
  assert.ok(c, `no ${label} call: ${why(r)}`)
  const lines = c.prompt.split('\n')
  const h = lines.indexOf(heads)
  assert.ok(h >= 0, `${label}: no heading line ${JSON.stringify(heads)} in:\n${c.prompt.slice(0, 1500)}`)
  for (const l of dirLines) {
    const i = lines.indexOf(`> ${l}`)
    assert.ok(i > h, `${label}: the direction line ${JSON.stringify(l)} is not quoted with "> " after the heading`)
  }
}

// ---------------------------------------------------------------- u2: the ux role

const rolesJson = () => JSON.parse(readFileSync(`${PLUGIN}/workflows/roles.json`, 'utf8'))

t('u2 roles-row 1: roles.json has the ux row truss:ux-engineer, opus, medium, none, with no typeFromProject', () => {
  const r = rolesJson().ux
  assert.ok(r, 'roles.json has no ux row (U2)')
  assert.deepEqual(r, { agentType: 'truss:ux-engineer', model: 'opus', effort: 'medium', isolation: 'none' })
  assert.ok(!('typeFromProject' in r), 'the ux role has no typeFromProject (R6)')
})

t('u2 roles-row 2: truss-config.schema.json roles.ux is an agentType $ref', () => {
  const s = JSON.parse(readFileSync(`${PLUGIN}/docs/truss-config.schema.json`, 'utf8'))
  assert.deepEqual(s.properties.roles.properties.ux, { $ref: '#/$defs/agentType' })
})

t('u2 roles-row 3: factory start lays truss.json roles.ux on the ux row agentType, and --type ux=... still says the role takes no project type', () => {
  const env = mkEnv({ config: { merge: 'sequential', target: 'main', roles: { ux: 'kit:ux' } } })
  writePlan(env.dir, planObj([crew('x')]))
  writeGoal(env.dir, 'x')
  const r = env.run('start', { stage: 'next' })
  assert.equal(r.status, 0, `start failed: ${r.stdout.slice(0, 400)} ${r.stderr.slice(0, 300)}`)
  const roles = JSON.parse(r.stdout.split('\n')[0]).truss.roles
  assert.ok(roles.ux, 'the roles in args have no ux row')
  assert.equal(roles.ux.agentType, 'kit:ux', 'roles.ux maps the ux agentType')
  assert.equal(roles.ux.model, 'opus')
  assert.equal(roles.ux.effort, 'medium')
  const env2 = mkEnv({ config: { merge: 'sequential', target: 'main' } })
  writePlan(env2.dir, planObj([crew('x')]))
  writeGoal(env2.dir, 'x')
  const bad = env2.run('start', { stage: 'next', type: 'ux=kit:ux' })
  assert.equal(bad.status, 2)
  assert.match(bad.stdout, /role ux does not take a project agent type/, 'R6: ux keeps being refused by --type')
})

// ---------------------------------------------------------------- u3: which crews get a UX engineer

const startWorld = (planCrew, goal = {}) => {
  const env = mkEnv({ config: { merge: 'sequential', target: 'main' } })
  writePlan(env.dir, planObj([planCrew]))
  writeGoal(env.dir, planCrew.slug, goal)
  return env
}
const startEntry = (env) => {
  const r = env.run('start', { stage: 'next' })
  assert.equal(r.status, 0, `start failed: ${r.stdout.slice(0, 500)} ${r.stderr.slice(0, 300)}`)
  return JSON.parse(r.stdout.split('\n')[0]).truss.crews[0]
}

t('u3 entry-ux 1: plan.json ux true gives entry.ux true, and a crew with neither source gets ux false, direction null, members {}', () => {
  const e = startEntry(startWorld(crew('x', { ux: true })))
  assert.equal(e.ux, true, 'ux:true in plan.json sets entry.ux')
  const plain = startEntry(startWorld(crew('x')))
  assert.equal(plain.ux, false)
  assert.equal(plain.direction, null)
  assert.deepEqual(plain.members, {})
})

t('u3 entry-ux 2: a non-empty ## UX section sets entry.ux, unless plan.json says ux false (F-12: false wins)', () => {
  assert.equal(startEntry(startWorld(crew('x'), { ux: 'Follow ui/DESIGN.md. Screens: list and detail.' })).ux, true)
  assert.equal(startEntry(startWorld(crew('x', { ux: false }), { ux: 'Follow ui/DESIGN.md.' })).ux, false)
})

t('u3 entry-ux 3: an empty ## UX section or one that starts with none does not set entry.ux', () => {
  assert.equal(startEntry(startWorld(crew('x', { ux: false }), { ux: 'none' })).ux, false)
  assert.equal(startEntry(startWorld(crew('x', { ux: false }), { ux: 'None. This crew builds no screens.' })).ux, false)
  assert.equal(startEntry(startWorld(crew('x', { ux: false }), { ux: '' })).ux, false)
})

const planCheck = (c) => {
  const env = mkEnv()
  writePlan(env.dir, planObj([c]))
  const res = env.run('plan-check', { repo: null })
  return { res, text: res.stdout + res.stderr }
}

t('u3 entry-ux 4: plan-check accepts a crew with ux true and refuses a non-boolean ux with "x: ux must be a boolean"', () => {
  const ok = planCheck(crew('x', { ux: true }))
  assert.equal(ok.res.status, 0, `plan-check refused ux true: ${ok.text.slice(0, 400)}`)
  for (const v of ['yes', 1, null]) {
    const bad = planCheck(crew('x', { ux: v }))
    assert.notEqual(bad.res.status, 0, `plan-check passed ux ${JSON.stringify(v)}`)
    assert.match(bad.text, /x: ux must be a boolean/, `error for ux ${JSON.stringify(v)}: ${bad.text.slice(0, 300)}`)
  }
})

t('u3 entry-ux 5: plan.schema.json crew gets a boolean ux property, default false', () => {
  const s = JSON.parse(readFileSync(`${PLUGIN}/docs/plan.schema.json`, 'utf8'))
  assert.deepEqual(s.$defs.crew.properties.ux, { type: 'boolean', default: false })
})

// ---------------------------------------------------------------- u4: the direction and review steps

t('u4 direction-first 1: a ux crew asks the ux role first (label a-ux, "UX direction: crew a"), after red and before the planner; the review follows green and precedes QC', async () => {
  const r = await runStage([uxCrew()], { labels: uxBase() })
  const c = call(r, 'a-ux')
  assert.ok(c, `no a-ux call (U4): ${why(r)}`)
  assert.equal(c.prompt.split('\n')[0], 'UX direction: crew a')
  assert.equal(c.opts.agentType, 'truss:ux-engineer')
  assert.equal(c.opts.model, 'opus')
  assert.equal(c.opts.effort, 'medium')
  assert.ok(idx(r, 'end:runner:a:check:red') < idx(r, 'start:a-ux'), 'the direction comes after the red check')
  assert.ok(idx(r, 'end:a-ux') < idx(r, 'start:a-planner'), 'the direction comes before the planner')
  const review = call(r, 'a-ux-2')
  assert.ok(review, `no a-ux-2 review: ${why(r)}`)
  assert.equal(review.prompt.split('\n')[0], 'UX review: crew a')
  assert.ok(idx(r, 'end:runner:a:check:green') < idx(r, 'start:a-ux-2'), 'the review comes after green')
  assert.ok(idx(r, 'end:a-ux-2') < idx(r, 'start:a-qc'), 'the review comes before QC')
  assert.equal(r.res[0].state, 'passed', why(r))
  assert.deepEqual(r.res[0].ux, { direction: 'a-ux', review: 'a-ux-2', verdict: 'PASS', findings: [] })
})

t('u4 direction-first 2: a QUESTION: from the direction stops the crew at ux-direction with no planner; a reply with no tag gets one fresh ux agent, then BLOCKED', async () => {
  const q = await runStage([uxCrew()], { labels: uxBase({ 'a-ux': 'QUESTION: which design reference?' }) })
  assert.ok(had(q, 'a-ux'), `no a-ux call: ${why(q)}`)
  assert.equal(q.res[0].state, 'stopped')
  assert.equal(q.res[0].tag, 'QUESTION')
  assert.equal(q.res[0].at, 'ux-direction')
  assert.ok(!had(q, 'a-planner'), 'a stopped direction runs no planner')
  const retry = await runStage([uxCrew()], { labels: uxBase({ 'a-ux': 'I would pick blue', 'a-ux-2': DIR, 'a-ux-3': 'UX: PASS\n' }) })
  assert.ok(had(retry, 'a-ux-2') && had(retry, 'a-planner'), `a reply with no tag gets one fresh ux agent, then the chain goes on: ${why(retry)}`)
  assert.equal(retry.res[0].state, 'passed', why(retry))
  assert.ok(call(retry, 'a-planner').prompt.includes(heading('a-ux-2')), 'the direction is the second agent\'s report')
  const twice = await runStage([uxCrew()], { labels: uxBase({ 'a-ux': 'no tag', 'a-ux-2': 'still no tag' }) })
  assert.equal(twice.res[0].state, 'stopped')
  assert.equal(twice.res[0].tag, 'BLOCKED')
  assert.equal(twice.res[0].at, 'ux-direction')
  assert.match(twice.res[0].text, /no direction from two UX engineers/)
})

t('u4 direction-first 3: a resume with saved tasks and no direction runs the direction before the members, with no planner', async () => {
  const r = await runStage([uxCrew({ resume: 'stale', tasks: [T1, B1] })], { labels: uxBase() })
  assert.ok(had(r, 'a-ux'), `a resume with saved tasks but no direction asks the ux role: ${why(r)}`)
  assert.ok(!had(r, 'a-planner'), 'saved tasks need no planner')
  assert.ok(idx(r, 'end:a-ux') < idx(r, 'start:a-tester'), 'the direction comes before the first member')
  assert.ok(call(r, 'a-tester').prompt.includes(heading('a-ux')))
})

t('u4 direction-briefs 1: the planner, every member and the QC brief carry the direction under the heading line, each line prefixed "> "', async () => {
  const r = await runStage([uxCrew()], { labels: uxBase() })
  assert.equal(r.res[0].state, 'passed', why(r))
  for (const l of ['a-planner', 'a-tester', 'a-builder', 'a-qc']) assertQuoted(r, l)
})

t('u4 direction-briefs 2: the review brief opens "UX review: crew a" and holds the goal file, checkout, head, branch, the quoted direction and the green output tail', async () => {
  const runner = ({ key }) => (key === 'check:green' ? rj({ ok: true, head: HEAD, tail: 'SHOTS: /wt/a/shots/home.png' }) : undefined)
  const r = await runStage([uxCrew()], { labels: uxBase(), runner })
  const c = call(r, 'a-ux-2')
  assert.ok(c, `no review: ${why(r)}`)
  for (const s of ['/proj/.truss/goals/a.md', '/wt/a', HEAD, 'truss/a', 'SHOTS: /wt/a/shots/home.png']) assert.ok(c.prompt.includes(s), `review brief lacks ${s}`)
  assertQuoted(r, 'a-ux-2')
})

t('u4 direction-briefs 3: the direction brief opens "UX direction: crew a" and names the goal file, worktree, scope and architecture', async () => {
  const r = await runStage([uxCrew()], { labels: uxBase() })
  const c = call(r, 'a-ux')
  assert.ok(c, `no a-ux: ${why(r)}`)
  for (const s of ['/proj/.truss/goals/a.md', '/wt/a', 'SCOPE-VERBATIM', '/proj/docs/ARCH.md', '/proj/docs/adr/0001-x.md']) assert.ok(c.prompt.includes(s), `direction brief lacks ${s}`)
})

t('u4 rework 1: UX: REWORK sends the findings to a fix builder, runs green again, then a fresh review; QC sees the last review', async () => {
  const r = await runStage([uxCrew()], { labels: uxBase({ 'a-ux-2': REWORK, 'a-ux-3': 'UX: PASS\n', 'a-builder-2': done('feat/fix') }) })
  assert.ok(had(r, 'a-builder-2'), `no fix builder after UX: REWORK: ${why(r)}`)
  assert.ok(call(r, 'a-builder-2').prompt.includes('Home: no empty state is drawn'), 'the fix builder brief holds the finding')
  assert.equal(r.calls.filter((c) => c.runner?.key === 'check:green').length, 2, 'green runs again after the fix')
  assert.ok(call(r, 'a-ux-3').prompt.includes('Home: no empty state is drawn'), 'the next review sees the previous review')
  assert.equal(r.res[0].state, 'passed', why(r))
  assert.deepEqual(r.res[0].ux, { direction: 'a-ux', review: 'a-ux-3', verdict: 'PASS', findings: [] })
  assert.ok(call(r, 'a-qc').prompt.includes('a-ux-3'), 'QC gets the last review label')
})

t('u4 rework 2: UX: REWORK on the last allowance unit (spend would pass reworkAllowance) stops BLOCKED at ux-review with the allowance stop and no fix builder', async () => {
  const r = await runStage([uxCrew({ spent: 2 })], { labels: uxBase({ 'a-ux-2': REWORK, 'a-builder-2': done('feat/fix') }) })
  assert.ok(had(r, 'a-ux-2'), `the review never ran: ${why(r)}`)
  assert.equal(r.res[0].state, 'stopped')
  assert.equal(r.res[0].tag, 'BLOCKED')
  assert.equal(r.res[0].at, 'ux-review')
  assert.match(r.res[0].text, /rework allowance spent: a, spend 3, reworkAllowance 2/)
  assert.ok(r.res[0].text.includes('Home: no empty state is drawn'), 'the allowance stop carries the findings')
  assert.ok(!had(r, 'a-builder-2'), 'a spent allowance runs no fix builder')
  assert.ok(!had(r, 'a-qc'))
})

t('u4 rework 3: a REWORK that leaves spend within the allowance costs one unit, so the next QC FAIL stops the crew at qc', async () => {
  const labels = uxBase({ 'a-ux-2': REWORK, 'a-ux-3': 'UX: PASS\n', 'a-builder-2': done('feat/fix'), 'a-qc': qcFail('something else is wrong') })
  const r = await runStage([uxCrew({ spent: 1 })], { labels })
  assert.ok(had(r, 'a-builder-2'), `spend 2 is within reworkAllowance 2, so the fix builder runs: ${why(r)}`)
  assert.equal(r.res[0].state, 'stopped')
  assert.equal(r.res[0].at, 'qc')
  assert.match(r.res[0].text, /rework allowance spent: a, spend 3/)
})

t('u4 rework 4: a review with no verdict gets one fresh reviewer, then BLOCKED; a QUESTION: from a review stops at ux-review', async () => {
  const none = await runStage([uxCrew()], { labels: uxBase({ 'a-ux-2': 'looks fine', 'a-ux-3': 'still no verdict' }) })
  assert.equal(none.res[0].state, 'stopped')
  assert.equal(none.res[0].at, 'ux-review')
  assert.match(none.res[0].text, /no verdict from two UX reviews/)
  const q = await runStage([uxCrew()], { labels: uxBase({ 'a-ux-2': 'QUESTION: no screenshots to read' }) })
  assert.equal(q.res[0].tag, 'QUESTION')
  assert.equal(q.res[0].at, 'ux-review')
})

t('u4 spent-restart 1: factory start --resume counts UX: REWORK ux reports in entry.spent and takes entry.direction from the newest UX: DIRECTION report', () => {
  const env = mkEnv({ config: { merge: 'sequential', target: 'main' } })
  writePlan(env.dir, planObj([crew('x', { status: 'running', ux: true })], { approvedAt: new Date(Date.now() - 3_600_000).toISOString() }))
  writeGoal(env.dir, 'x')
  addCrewWorktree(env.repo, 'x')
  appendEvent(env.dir, factorySpawn('x', new Date(Date.now() - 3_600_000).toISOString()))
  writeReport(env.dir, 'x', 'x-qc', qcReport({ verdict: 'FAIL' }))
  writeReport(env.dir, 'x', 'x-ux', 'UX: DIRECTION\nOLD direction line\n')
  writeReport(env.dir, 'x', 'x-ux-2', 'UX: REWORK\n1. Home: no empty state. Fix: draw it.\n')
  writeReport(env.dir, 'x', 'x-ux-3', 'UX: REWORK\n1. Detail: no loading state. Fix: draw it.\n')
  writeReport(env.dir, 'x', 'x-ux-4', 'UX: DIRECTION\nNEW direction line\n')
  writeReport(env.dir, 'x', 'x-ux-5', 'UX: PASS\nMentions UX: REWORK only in its body.\n')
  writeReport(env.dir, 'x', 'x-ux-6.run1', 'UX: REWORK\n1. interim file, not counted\n')
  const r = env.run('start', { slug: 'x', resume: 'merge-ready' })
  assert.equal(r.status, 0, `resume failed: ${r.stdout.slice(0, 500)} ${r.stderr.slice(0, 300)}`)
  const e = JSON.parse(r.stdout.split('\n')[0]).truss.crews[0]
  assert.equal(e.spent, 3, 'one QC FAIL plus two UX: REWORK reports (the PASS body, the direction reports and the .run1 file do not count)')
  assert.ok(e.direction && typeof e.direction === 'object', `entry.direction is ${JSON.stringify(e.direction)}`)
  assert.equal(e.direction.label, 'x-ux-4')
  assert.ok(String(e.direction.text).includes('NEW direction line'))
  assert.ok(!String(e.direction.text).includes('OLD direction line'))
})

t('u4 spent-restart 2: a restart with entry.spent 3 and a saved direction runs no second direction and stops at ux-review before any review', async () => {
  const direction = { label: 'a-ux', text: DIR }
  const r = await runStage([uxCrew({ spent: 3, direction, labelFrom: { ux: 2 } })], { labels: uxBase({ 'a-ux-2': 'UX: PASS\n' }) })
  assert.ok(!had(r, 'a-ux'), 'a saved direction runs no second direction pass')
  assert.ok(call(r, 'a-planner').prompt.includes(heading('a-ux')), 'the saved direction reaches the planner')
  assert.equal(r.res[0].state, 'stopped')
  assert.equal(r.res[0].at, 'ux-review')
  assert.match(r.res[0].text, /rework allowance spent: a, spend 3/)
  assert.ok(!had(r, 'a-ux-2'), 'guardAllowance stops the crew before the review spawns')
})

t('control no-ux 1: a crew without ux runs exactly as today: no ux spawn, no ux field, no direction or UX text in any brief', async () => {
  const r = await runStage([entry('a')], { labels: base() })
  assert.equal(r.res[0].state, 'passed', why(r))
  assert.deepEqual(r.labels.filter((l) => /-ux(-\d+)?$/.test(l)), [])
  assert.ok(!('ux' in r.res[0]), 'the result of a crew without ux has no ux field')
  for (const l of ['a-planner', 'a-tester', 'a-builder', 'a-qc']) {
    const p = call(r, l).prompt
    assert.ok(!/UX|quoted:/.test(p), `${l} brief mentions UX:\n${p.slice(0, 500)}`)
  }
})

t('control no-ux 2: an entry with ux false, direction null and members {} runs the same, and one with none of those keys still runs', async () => {
  const a = await runStage([entry('a', { ux: false, direction: null, members: {} })], { labels: base() })
  const b = await runStage([entry('a')], { labels: base() })
  assert.equal(a.res[0].state, 'passed', why(a))
  assert.deepEqual(a.labels, b.labels)
  for (const l of ['a-planner', 'a-tester', 'a-builder', 'a-qc']) assert.equal(call(a, l).prompt, call(b, l).prompt, `${l} prompt differs`)
  assert.ok(!('ux' in a.res[0]))
})

t('control status-empty 1: a runner reply with an empty status falls back to today\'s rule', async () => {
  const runner = ({ key }) => (key === 'check:green' ? { ...rj({ ok: true, head: HEAD }), status: '' } : undefined)
  const r = await runStage([entry('a')], { labels: base(), runner })
  assert.equal(r.res[0].state, 'passed', why(r))
})

// ---------------------------------------------------------------- i22: met without a retyped stdout

// 25 KB of output wrapped in chatter, cut off mid-object, so no line of it parses as JSON
const brokenStdout = () => `npm warn something\n{"ok":true,"head":"${HEAD}","tail":"${'x'.repeat(25000)}\nmore chatter after the cut\n`

t('i22 long-reply 1: a broken 25 KB stdout with a truss-status line gives the right met and head, for red and green', async () => {
  const runner = ({ key }) =>
    key === 'check:green'
      ? { exit: 0, stdout: brokenStdout(), status: `truss-status: {"ok":true,"head":"${HEAD}"}` }
      : key === 'check:red'
        ? { exit: 0, stdout: brokenStdout(), status: 'truss-status: {"ok":true}' }
        : undefined
  const r = await runStage([entry('a')], { labels: base(), runner })
  assert.equal(r.res[0].state, 'passed', `met must come from the status line, not the long stdout: ${why(r)}`)
  assert.equal(r.res[0].head, HEAD)
})

t('i22 long-reply 2: a status that says ok false makes the check not met even when stdout parses as ok true', async () => {
  const runner = ({ key }) => (key === 'check:red' ? { exit: 1, stdout: JSON.stringify({ ok: true, tail: 'x'.repeat(25000) }), status: 'truss-status: {"ok":false}' } : undefined)
  const r = await runStage([entry('a')], { labels: base(), runner })
  assert.equal(r.res[0].state, 'stopped', why(r))
  assert.equal(r.res[0].at, 'red')
  assert.ok(!had(r, 'a-planner'))
})

t('i22 long-reply 3: every factory.ts runner command carries --status-line, and the runner prompt says to copy the truss-status line', async () => {
  const r = await runStage([entry('a')], { labels: base() })
  const runners = r.calls.filter((c) => c.runner)
  assert.ok(runners.length > 0)
  for (const c of runners) {
    assert.ok(c.prompt.includes('--status-line'), `${c.runner.name} command has no --status-line:\n${c.prompt}`)
    assert.ok(c.prompt.includes('truss-status: '), `${c.runner.name} prompt does not tell the runner to copy the truss-status line`)
  }
  const heavy = r.calls.find((c) => c.runner?.heavy)
  assert.ok(heavy.prompt.indexOf('--status-line') < heavy.prompt.indexOf(' -- '), 'heavyParts puts --status-line before the --')
})

t('i22 long-reply 4: factory.ts --status-line prints truss-status: <short JSON> as the last stdout line, after the unchanged JSON result', () => {
  const env = mkEnv()
  writePlan(env.dir, planObj([crew('x')]))
  const plain = env.run('plan-check', { repo: null })
  assert.equal(plain.status, 0, plain.stdout + plain.stderr)
  const withFlag = env.run('plan-check', { repo: null }, ['--status-line'])
  assert.equal(withFlag.status, 0, withFlag.stdout + withFlag.stderr)
  const lines = withFlag.stdout.split('\n').filter((l) => l.length > 0)
  assert.equal(lines.length, 2, `two stdout lines, got: ${withFlag.stdout.slice(0, 300)}`)
  assert.equal(lines[0], plain.stdout.trim(), 'the JSON result line is unchanged')
  assert.ok(lines[1].startsWith('truss-status: '), `last line: ${lines[1]}`)
  const s = JSON.parse(lines[1].slice('truss-status: '.length))
  assert.equal(s.ok, true)
  assert.ok(lines[1].length < 400)
})

// ---------------------------------------------------------------- i23: ## Members sets the model and effort

const membersStart = (members, extra = {}) => {
  const env = mkEnv({ config: { merge: 'sequential', target: 'main' } })
  writePlan(env.dir, planObj([crew('x')]))
  writeGoal(env.dir, 'x', { members, ...extra })
  const r = env.run('start', { stage: 'next' })
  return { env, r, j: r.json ?? JSON.parse(r.stdout.split('\n')[0]) }
}

t('i23 opus-builder 1: a ## Members builder line on Opus gives entry.members; a tester line, bullets and any case work; prose is ignored', () => {
  const { r, j } = membersStart('- 1 builder on opus at effort medium\n* 2 Testers on Sonnet at effort LOW\nThe stress engineer and QC engineer run on Opus at effort medium.\nPlanner effort medium.')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(j.truss.crews[0].members, { builder: { model: 'opus', effort: 'medium' }, tester: { model: 'sonnet', effort: 'low' } })
})

t('i23 opus-builder 2: a goal file with no ## Members, or only prose in it, gives members {}', () => {
  const none = startEntry(startWorld(crew('x')))
  assert.deepEqual(none.members, {})
  const prose = membersStart('One agent does the work, whatever it takes.')
  assert.deepEqual(prose.j.truss.crews[0].members, {})
})

t('i23 opus-builder 3: stage.js spawns the builder on the members model, and members effort wins over the planner task effort', async () => {
  const members = { builder: { model: 'opus', effort: 'low' }, tester: { model: 'sonnet', effort: 'low' } }
  const r = await runStage([entry('a', { members })], { labels: base() })
  assert.equal(r.res[0].state, 'passed', why(r))
  const b = call(r, 'a-builder')
  assert.equal(b.opts.model, 'opus', 'an Opus builder line spawns an Opus builder')
  assert.equal(b.opts.effort, 'low', 'B1 asks for medium; the goal file is above the planner')
  const tt = call(r, 'a-tester')
  assert.equal(tt.opts.model, 'sonnet')
  assert.equal(tt.opts.effort, 'low', 'T1 asks for medium; the tester line says low')
})

t('i23 opus-builder 4: fix members follow the builder value', async () => {
  const members = { builder: { model: 'opus', effort: 'medium' } }
  const labels = base('a', { 'a-qc': qcFail('something else is wrong'), 'a-qc-2': PASS, 'a-builder-2': done('feat/fix') })
  const r = await runStage([entry('a', { members })], { labels })
  assert.ok(had(r, 'a-builder-2'), why(r))
  assert.equal(call(r, 'a-builder-2').opts.model, 'opus')
  assert.equal(call(r, 'a-builder-2').opts.effort, 'medium')
})

const refusedOf = (m) => {
  const { env, r, j } = membersStart(m)
  return { env, r, j, refused: j.refused ?? [] }
}

t('i23 high-refused 1: effort high or xhigh refuses the crew with the ADR reason naming ## Engine project-manager; the crew stays planned and gets no worktree', () => {
  for (const effort of ['high', 'xhigh']) {
    const { env, j, refused } = refusedOf(`- 1 builder on opus at effort ${effort}`)
    assert.equal(refused.length, 1, `effort ${effort} must refuse the crew: ${JSON.stringify(j).slice(0, 400)}`)
    assert.equal(refused[0].slug, 'x')
    const reason = refused[0].reason
    assert.ok(reason.startsWith(`## Members asks for 1 builder at effort ${effort}; a workflow crew runs members at effort low or medium only (ADR-0009), and factory start never lowers an effort silently. Set ## Engine to project-manager in `), reason)
    assert.ok(reason.endsWith('goals/x.md to run this crew on the project manager path.'), reason)
    assert.deepEqual(j.truss.crews, [])
    assert.equal(readPlan(env.dir).crews[0].status, 'planned')
    assert.ok(!existsSync(`${env.repo}/.claude/worktrees/truss-x`), 'the refusal comes before ensureWorktree')
  }
})

t('i23 high-refused 2: an unknown model, an unknown effort, or two lines for one role that disagree refuse the crew naming the value', () => {
  const model = refusedOf('- 1 builder on haiku at effort low')
  assert.equal(model.refused.length, 1, JSON.stringify(model.j).slice(0, 300))
  assert.ok(model.refused[0].reason.includes('haiku'), model.refused[0].reason)
  assert.ok(model.refused[0].reason.includes('## Engine'))
  const eff = refusedOf('- 1 tester on sonnet at effort max')
  assert.equal(eff.refused.length, 1, JSON.stringify(eff.j).slice(0, 300))
  assert.ok(eff.refused[0].reason.includes('max'))
  const clash = refusedOf('- 1 builder on opus at effort low\n- 1 builder on sonnet at effort medium')
  assert.equal(clash.refused.length, 1, JSON.stringify(clash.j).slice(0, 300))
  assert.ok(clash.refused[0].reason.includes('builder'))
})

t('control members-project-manager 1: ## Engine project-manager reads first, so the same high line sends the crew to the project manager path instead of refusing it', () => {
  const { j } = membersStart('- 1 builder on opus at effort high', { engine: 'project-manager' })
  assert.deepEqual(j.refused ?? [], [], 'a project manager crew never reaches the Members parse')
  assert.equal((j.projectManagers ?? []).length, 1)
})

// ---------------------------------------------------------------- r4: the ux audit

const MIN = 60_000
function auditWorld(agents) {
  const env = mkEnv({ config: { merge: 'sequential', target: 'main', roles: { ux: 'kit:ux' } } })
  writePlan(env.dir, planObj([crew('x', { status: 'running' })], { approvedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() }))
  writeGoal(env.dir, 'x')
  addCrewWorktree(env.repo, 'x')
  appendEvent(env.dir, factorySpawn('x', new Date(Date.now() - 3 * 3_600_000).toISOString()))
  const endMs = Date.now() - 10 * MIN
  const run = mkRun(env.transcripts, 'wf_r4', agents.map((a) => ({ startTs: new Date(endMs - MIN).toISOString(), endTs: new Date(endMs).toISOString(), ...a })), { journalMtimeMs: endMs })
  const resFile = `${env.dir}/result-x.json`
  writeFileSync(resFile, JSON.stringify([{ slug: 'x', state: 'passed', head: 'a'.repeat(40), base: 'b'.repeat(40), qc: 'x-qc' }]))
  const r = env.run('finish', { transcript: run.dir, result: resFile })
  let audit = []
  try {
    audit = JSON.parse(r.stdout.split('\n').filter(Boolean).pop()).audit ?? []
  } catch {}
  return { env, r, audit: audit.filter((a) => a.label.startsWith('x-ux')) }
}
const uxAgent = (label, over = {}) => ({ label, agentType: 'kit:ux', metaModel: 'opus', model: 'claude-opus-5-5', effort: 'medium', result: 'UX: DIRECTION\nScreens: list', ...over })

t('r4 ux-audit 1: finish flags a ux agent that wrote with Write or Edit', () => {
  const { audit, r } = auditWorld([uxAgent('x-ux', { tools: [{ name: 'Read', file_path: '/a' }, { name: 'Write', file_path: '/wt/x/DIRECTION.md' }] })])
  assert.ok(audit.some((a) => a.why === 'a UX engineer used Write or Edit'), `audit: ${JSON.stringify(audit)}; ${r.stdout.slice(0, 300)}`)
  const edit = auditWorld([uxAgent('x-ux-2', { tools: [{ name: 'Edit', file_path: '/wt/x/a.ts' }] })])
  assert.ok(edit.audit.some((a) => a.why === 'a UX engineer used Write or Edit'), `audit: ${JSON.stringify(edit.audit)}`)
})

t('r4 ux-audit 2: finish flags a ux agent of the wrong type, naming the ux row agentType (truss.json roles.ux maps it)', () => {
  const { audit } = auditWorld([uxAgent('x-ux', { agentType: 'general-purpose' })])
  assert.ok(audit.some((a) => a.why === 'ux ran as general-purpose, not kit:ux'), `audit: ${JSON.stringify(audit)}`)
})

t('r4 ux-audit 3: a read-only ux agent of the mapped type, direction and review labels alike, is audit-clean and its reports are filed under reports/x/', () => {
  const { env, audit } = auditWorld([uxAgent('x-ux', { tools: [{ name: 'Read', file_path: '/a' }] }), uxAgent('x-ux-2', { result: 'UX: PASS\n' })])
  assert.deepEqual(audit, [], `a clean ux agent has no audit line: ${JSON.stringify(audit)}`)
  assert.ok(existsSync(`${env.dir}/reports/x/x-ux.md`), 'finish files the direction report')
  assert.ok(existsSync(`${env.dir}/reports/x/x-ux-2.md`), 'finish files the review report')
})

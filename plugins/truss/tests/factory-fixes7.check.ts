// @ts-nocheck
// Factory fixes from the F-12 run: ux off wins, spawn events carry model and effort, plan-check ignores merged crews,
// start on a running crew is a no-op, admit waits on a hold, the heavy slot wait is configurable, old wf_ worktrees are cleaned.

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { OLD_WF_BRANCH, OLD_WF_PATH, heavyWaitMs, HEAVY_WAIT_MS, roleDefaults, uxOn, uxSaysOff } from '../bin/factory.ts'
import { crew, mkEnv, planObj, runCli, tmp, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

const CFG = { merge: 'sequential', target: 'main' }
function runEnv(env: any, command: string, flags: Record<string, unknown> = {}, extraEnv: Record<string, string> = {}) {
  const args: string[] = []
  for (const [k, v] of Object.entries({ dir: env.dir, repo: env.repo, ...flags })) {
    if (v === null || v === undefined || v === false) continue
    args.push(`--${k}`, ...(v === true ? [] : [String(v)]))
  }
  return runCli(env.factory, command, args, env.repo, extraEnv)
}
const say = (r: any): string => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 600)}; stderr ${String(r.stderr).slice(0, 300)}`

test('f12 1: plan.json ux false wins; a ## UX section reading none, no, off or "ux: false." is off', () => {
  assert.equal(uxOn(false, 'Build a dashboard with a live page'), false)
  assert.equal(uxOn(true, 'none'), true)
  for (const t of ['none', 'None.', 'no', 'off', 'ux: false.', 'UX: false', 'ux = no']) assert.equal(uxSaysOff(t), true, t)
  assert.equal(uxOn(undefined, 'ux: false.'), false)
  assert.equal(uxOn(undefined, 'Notes on the screens'), true)
  assert.equal(uxOn(undefined, ''), false)
})

test('f12 1b: plan-check flags a ## UX section that contradicts plan.json ux', () => {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew('a', { ux: false }), crew('b', { ux: true, stage: 2 })]))
  writeGoal(env.dir, 'a', { ux: 'Screens: a dashboard with a live page.' })
  writeGoal(env.dir, 'b', { ux: 'none' })
  const r = runEnv(env, 'plan-check', { repo: null })
  assert.equal(r.status, 1, say(r))
  const errs = r.json.errors.join('\n')
  assert.match(errs, /a: plan\.json ux is false/)
  assert.match(errs, /b: plan\.json ux is true/)
  writeGoal(env.dir, 'a', { ux: 'ux: false.' })
  writeGoal(env.dir, 'b', { ux: 'Screens.' })
  assert.equal(runEnv(env, 'plan-check', { repo: null }).status, 0)
})

test('f12 2: roleDefaults gives model and effort from the roles table, never null', () => {
  assert.deepEqual(roleDefaults({ planner: { model: 'opus', effort: 'medium' } }, 'planner'), { model: 'opus', effort: 'medium' })
  assert.deepEqual(roleDefaults({}, 'x'), { model: 'sonnet', effort: 'medium' })
})

test('f12 2b: start records the workflow-crew spawn with a model and an effort', () => {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew('s')]))
  writeGoal(env.dir, 's')
  const r = runEnv(env, 'start', { stage: 'next' })
  assert.equal(r.status, 0, say(r))
  const ev = readFileSync(`${env.dir}/events.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.event === 'spawn' && e.type === 'workflow-crew')
  assert.ok(ev, 'a spawn event')
  assert.equal(typeof ev.model, 'string')
  assert.equal(typeof ev.effort, 'string')
})

test('f12 3: plan-check ignores overlap with a merged or dropped crew of the same goal and stage', () => {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew('old', { owns: ['bin/x.ts'], status: 'merged' }), crew('new', { owns: ['bin/x.ts'] })]))
  const r = runEnv(env, 'plan-check', { repo: null })
  assert.equal(r.status, 0, say(r))
  writePlan(env.dir, planObj([crew('old', { owns: ['bin/x.ts'] }), crew('new', { owns: ['bin/x.ts'] })]))
  assert.equal(runEnv(env, 'plan-check', { repo: null }).status, 1)
})

test('f12 4: start --slug on a running crew is a no-op that says so, exit 0', () => {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew('s', { status: 'running' })]))
  writeGoal(env.dir, 's')
  const r = runEnv(env, 'start', { slug: 's', stage: 'next' })
  assert.equal(r.status, 0, say(r))
  assert.equal(r.json.noop, true, say(r))
  assert.match(r.json.note, /already running/)
})

test('f12 5: admit --wait-ms re-checks a hold for a bounded time before it refuses', () => {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew('s')]))
  writeGoal(env.dir, 's')
  const p = `${tmp('f7-sample-')}/s.json`
  writeFileSync(p, JSON.stringify({ freeMB: 10, totalMB: 64000 }))
  const quick = runEnv(env, 'admit', { slug: 's' }, { TRUSS_SAMPLE: p })
  assert.equal(quick.status, 1, say(quick))
  assert.equal(quick.json.waitedMs, undefined)
  const waited = runEnv(env, 'admit', { slug: 's', 'wait-ms': 2500 }, { TRUSS_SAMPLE: p })
  assert.equal(waited.status, 1, say(waited))
  assert.ok(waited.json.waitedMs >= 2400 && waited.json.waitedMs < 9000, say(waited))
  writeFileSync(p, JSON.stringify({ freeMB: 64000, totalMB: 64000 }))
  assert.equal(runEnv(env, 'admit', { slug: 's', 'wait-ms': 2500 }, { TRUSS_SAMPLE: p }).json.admitted, true)
})

test('f12 6: the heavy slot wait defaults to 540 s and --wait-ms or TRUSS_HEAVY_WAIT_MS sets it', () => {
  assert.equal(HEAVY_WAIT_MS, 540000)
  assert.equal(heavyWaitMs({}, {}), 540000)
  assert.equal(heavyWaitMs({}, { TRUSS_HEAVY_WAIT_MS: '5000' }), 5000)
  assert.equal(heavyWaitMs({ 'wait-ms': '100' }, { TRUSS_HEAVY_WAIT_MS: '5000' }), 100)
  assert.equal(heavyWaitMs({ 'wait-ms': 'x' }, { TRUSS_HEAVY_WAIT_MS: 'y' }), 540000)
})

test('f12 7: the old-run member worktree patterns match wf_ branches and paths and nothing else', () => {
  assert.ok(OLD_WF_BRANCH.test('worktree-wf_ab12-3'))
  assert.ok(OLD_WF_PATH.test('/r/.claude/worktrees/wf_ab12-3'))
  assert.ok(!OLD_WF_BRANCH.test('truss-alpha'))
  assert.ok(!OLD_WF_PATH.test('/r/.claude/worktrees/truss-alpha'))
})

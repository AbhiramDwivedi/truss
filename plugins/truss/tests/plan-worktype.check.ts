// @ts-nocheck
// truss 0.25.0 wave 2, A0: the optional crew workType on a plan (contract-025 section 2, "The plan: no version bump", and
// section 3 call site 2), and amendPlan keeping a version 4 plan at version 4. Written from the contract before the code.
// Each case drives `factory plan-check` as a child process, or imports hooks/intake.ts inside the case.

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { crew, mkEnv, planObj, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

const INTAKE = new URL('../hooks/intake.ts', import.meta.url).href

/** A world holding a plan of `crews` at `version`; goal files are written so plan-check has no other complaint. */
function world(crews: any[], version: number) {
  const env = mkEnv()
  writePlan(env.dir, planObj(crews, { version }))
  for (const c of crews) writeGoal(env.dir, c.slug)
  return env
}

const errorsOf = (r: any): string[] => (Array.isArray(r.json?.errors) ? r.json.errors : [])

test('plan worktype: workType on a v3 plan is refused', () => {
  const env = world([crew('alpha', { workType: 'feature' })], 3)
  const r = env.run('plan-check')
  assert.equal(r.status, 1, `exit 1 expected: ${r.stdout} ${r.stderr}`)
  assert.equal(r.json.ok, false)
  assert.ok(errorsOf(r).includes('alpha: workType is version 4 only'), JSON.stringify(r.json))
})

test('plan worktype: a v4 plan with workType passes', () => {
  const env = world([crew('alpha', { workType: 'feature' }), crew('beta', { stage: 2, workType: 'migration', process: 'full' })], 4)
  const ok = env.run('plan-check')
  assert.equal(ok.status, 0, `exit 0 expected: ${ok.stdout} ${ok.stderr}`)
  assert.equal(ok.json.ok, true)
  // all six work types are accepted; anything else is refused with the workType rule, not silently ignored
  for (const wt of ['feature', 'bugfix', 'migration', 'dependency', 'docs', 'refactor']) {
    const e = world([crew('alpha', { workType: wt, process: 'full' })], 4)
    const r = e.run('plan-check')
    assert.ok(!errorsOf(r).some((x: string) => /workType must be one of/.test(x)), `${wt}: ${JSON.stringify(r.json)}`)
  }
  const bad = world([crew('alpha', { workType: 'chore' })], 4).run('plan-check')
  assert.equal(bad.status, 1, `an unknown workType is refused: ${bad.stdout}`)
  assert.ok(errorsOf(bad).some((x: string) => x.startsWith('alpha: workType must be one of')), JSON.stringify(bad.json))
})

test('plan worktype: a v4 plan without workType passes outside an unattended run', () => {
  const env = world([crew('alpha'), crew('beta', { stage: 2 })], 4)
  const r = env.run('plan-check')
  assert.equal(r.status, 0, `exit 0 expected: ${r.stdout} ${r.stderr}`)
  assert.equal(r.json.ok, true)
  // a version 3 plan without workType is untouched too
  const v3 = world([crew('alpha')], 3).run('plan-check')
  assert.equal(v3.status, 0, `${v3.stdout}`)
})

test('plan worktype: an unattended plan without workType fails', () => {
  const env = world([crew('alpha'), crew('beta', { stage: 2, workType: 'docs' })], 4)
  writeFileSync(`${env.dir}/unattended.json`, JSON.stringify({ since: new Date().toISOString(), item: null }) + '\n')
  const r = env.run('plan-check')
  assert.equal(r.status, 1, `exit 1 expected: ${r.stdout} ${r.stderr}`)
  assert.equal(r.json.ok, false)
  assert.ok(errorsOf(r).includes('alpha: workType is required in an unattended run'), JSON.stringify(r.json))
  assert.ok(!errorsOf(r).some((x: string) => x.startsWith('beta: workType is required')), 'a crew with a workType is not named')
  // with a workType on every crew the same unattended plan passes
  const fixed = world([crew('alpha', { workType: 'feature' }), crew('beta', { stage: 2, workType: 'docs' })], 4)
  writeFileSync(`${fixed.dir}/unattended.json`, JSON.stringify({ since: new Date().toISOString(), item: null }) + '\n')
  const ok = fixed.run('plan-check')
  assert.equal(ok.status, 0, `${ok.stdout} ${ok.stderr}`)
})

test('plan worktype: an unattended run refuses a v3 plan, naming every crew without workType', () => {
  const env = world([crew('alpha'), crew('beta', { stage: 2 })], 3)
  writeFileSync(`${env.dir}/unattended.json`, JSON.stringify({ since: new Date().toISOString(), item: null }) + '\n')
  const r = env.run('plan-check')
  assert.equal(r.status, 1, `exit 1 expected: ${r.stdout} ${r.stderr}`)
  assert.equal(r.json.ok, false)
  for (const s of ['alpha', 'beta']) {
    assert.ok(errorsOf(r).includes(`${s}: workType is required in an unattended run; unattended runs need a version 4 plan with workType`), JSON.stringify(r.json))
  }
})

test('plan worktype: amendPlan keeps version 4', async () => {
  const { amendPlan } = await import(INTAKE)
  const now = '2026-11-10T10:00:00.000Z'
  const amend = { goal: { id: 'extra', goal: 'one more goal', approval: 'auto' }, crews: [{ slug: 'extra-crew', stage: 1, verdict: 'change', modules: ['x'], owns: ['src/extra/**'], acceptanceTest: 'true', acceptanceTestProved: true, estAgents: 1 }] }
  const existing = (version: number) => planObj([crew('alpha', { status: 'merged' })], { version })
  const v4 = amendPlan(existing(4), amend, now)
  assert.ok('plan' in v4, `amend refused: ${JSON.stringify(v4)}`)
  assert.equal(v4.plan.version, 4)
  assert.ok(v4.plan.crews.some((c: any) => c.slug === 'extra-crew'))
  // a version 3 plan stays 3, and a version 2 plan is raised to 3 as before
  assert.equal(amendPlan(existing(3), amend, now).plan.version, 3)
  assert.equal(amendPlan(existing(2), amend, now).plan.version, 3)
})

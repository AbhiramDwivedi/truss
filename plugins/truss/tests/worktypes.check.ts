// @ts-nocheck
// truss 0.25.0 wave 2, b-cost: work types (contract-025 section 5, ADR-0041). Written from the contract before the code.
// Pure rules are driven through bin/worktypes.ts; plan-check and `factory worktypes` run as child processes.

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { profilesOf, workTypeErrors } from '../bin/worktypes.ts'
import { crew, mkEnv, planObj, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

/** A world holding a v4 plan of `crews`; goal files are written so plan-check has no other complaint. */
function world(crews: any[], config?: unknown, unattended = false) {
  const env = mkEnv(config === undefined ? {} : { config })
  writePlan(env.dir, planObj(crews, { version: 4 }))
  for (const c of crews) writeGoal(env.dir, c.slug)
  if (unattended) writeFileSync(`${env.dir}/unattended.json`, JSON.stringify({ since: new Date().toISOString(), item: null }) + '\n')
  return env
}
const errorsOf = (r: any): string[] => (Array.isArray(r.json?.errors) ? r.json.errors : [])
const BUILT = profilesOf({}).profiles
const errs = (c: any, over: { unattended?: boolean; cfg?: any } = {}): string[] => workTypeErrors({ version: 4, crews: [c] }, c, over.cfg === undefined ? BUILT : profilesOf(over.cfg).profiles, { unattended: over.unattended ?? false })

test('worktypes: an unknown workType is refused', () => {
  assert.ok(errs({ slug: 'a', workType: 'chore' }).some((e: string) => e.startsWith('a: workType must be one of')), JSON.stringify(errs({ slug: 'a', workType: 'chore' })))
  const r = world([crew('alpha', { workType: 'chore' })]).run('plan-check')
  assert.equal(r.status, 1, `${r.stdout} ${r.stderr}`)
  assert.ok(errorsOf(r).some((e: string) => e.startsWith('alpha: workType must be one of')), JSON.stringify(r.json))
  // a known one is not named
  assert.ok(!errs({ slug: 'a', workType: 'docs' }).some((e: string) => e.includes('workType must be one of')))
})

test('worktypes: workType is required in an unattended run', () => {
  assert.ok(errs({ slug: 'a' }, { unattended: true }).includes('a: workType is required in an unattended run'), JSON.stringify(errs({ slug: 'a' }, { unattended: true })))
  assert.deepEqual(errs({ slug: 'a' }, { unattended: false }), [])
  assert.ok(!errs({ slug: 'a', workType: 'docs' }, { unattended: true }).some((e: string) => e.includes('is required')))
  const r = world([crew('alpha'), crew('beta', { stage: 2, workType: 'docs' })], undefined, true).run('plan-check')
  assert.equal(r.status, 1, `${r.stdout} ${r.stderr}`)
  assert.ok(errorsOf(r).includes('alpha: workType is required in an unattended run'), JSON.stringify(r.json))
  assert.ok(!errorsOf(r).some((e: string) => e.startsWith('beta: workType is required')))
})

test('worktypes: a process below the work type minimum is refused', () => {
  assert.ok(errs({ slug: 'a', workType: 'bugfix', process: 'solo', red: true }).includes('a: process solo is below the bugfix minimum lean'))
  assert.ok(errs({ slug: 'a', workType: 'dependency', process: 'solo' }).includes('a: process solo is below the dependency minimum lean'))
  assert.ok(errs({ slug: 'a', workType: 'migration', process: 'lean' }).includes('a: process lean is below the migration minimum full'))
  // at or above the minimum, and a work type with a solo minimum, are clean
  assert.ok(!errs({ slug: 'a', workType: 'bugfix', process: 'lean', red: true }).some((e: string) => e.includes('below')))
  assert.ok(!errs({ slug: 'a', workType: 'migration', process: 'full' }).some((e: string) => e.includes('below')))
  for (const wt of ['feature', 'docs', 'refactor']) assert.deepEqual(errs({ slug: 'a', workType: wt, process: 'solo' }), [], wt)
  // an absent process counts as full: it never falls below any minimum
  for (const wt of ['feature', 'docs', 'refactor', 'bugfix', 'dependency', 'migration']) assert.ok(!errs({ slug: 'a', workType: wt, red: true }).some((e: string) => e.includes('below')), wt)
  // the minimum a config raises is the one enforced
  assert.ok(errs({ slug: 'a', workType: 'feature', process: 'lean' }, { cfg: { workTypes: { feature: { minProcess: 'full' } } } }).includes('a: process lean is below the feature minimum full'))
})

test('worktypes: bugfix requires red', () => {
  assert.ok(errs({ slug: 'a', workType: 'bugfix', process: 'lean' }).includes('a: bugfix requires red'), JSON.stringify(errs({ slug: 'a', workType: 'bugfix', process: 'lean' })))
  assert.ok(errs({ slug: 'a', workType: 'bugfix', process: 'lean', red: false }).includes('a: bugfix requires red'))
  assert.ok(!errs({ slug: 'a', workType: 'bugfix', process: 'lean', red: true }).some((e: string) => e.includes('requires red')))
  // a full process runs the red step itself, and an absent process counts as full: neither needs red: true
  assert.deepEqual(errs({ slug: 'a', workType: 'bugfix', process: 'full' }), [])
  assert.deepEqual(errs({ slug: 'a', workType: 'bugfix' }), [])
  assert.deepEqual(errs({ slug: 'a', workType: 'bugfix', process: 'full', red: false }), [])
  assert.ok(errs({ slug: 'a', workType: 'bugfix', process: 'bogus' }).every((e: string) => !e.includes('requires red')))
  // a config can make another work type require red
  assert.ok(errs({ slug: 'a', workType: 'feature', process: 'lean' }, { cfg: { workTypes: { feature: { red: true } } } }).includes('a: feature requires red'))
  assert.ok(!errs({ slug: 'a', workType: 'feature', process: 'lean' }).some((e: string) => e.includes('requires red')))
})

test('worktypes: the migration profile sets stressTest', () => {
  assert.equal(BUILT.migration.stressTest, true)
  assert.equal(BUILT.migration.minProcess, 'full')
  assert.equal(BUILT.bugfix.red, true)
  assert.notEqual(BUILT.feature.stressTest, true)
  // the config can switch the stress test on for another work type, and the profile says so
  const p = profilesOf({ workTypes: { dependency: { stressTest: true } } })
  assert.deepEqual(p.errors, [])
  assert.equal(p.profiles.dependency.stressTest, true)
  assert.equal(p.profiles.dependency.minProcess, 'lean')
})

test('worktypes: a config loosening is refused', () => {
  // each tightening is applied
  const up = profilesOf({ workTypes: { bugfix: { minProcess: 'full' }, feature: { red: true, stressTest: true } } })
  assert.deepEqual(up.errors, [])
  assert.equal(up.profiles.bugfix.minProcess, 'full')
  assert.equal(up.profiles.feature.red, true)
  assert.equal(up.profiles.feature.stressTest, true)
  // minProcess may only rise
  const a = profilesOf({ workTypes: { bugfix: { minProcess: 'solo' } } })
  assert.ok(a.errors.some((e: string) => e.startsWith('config: workTypes.bugfix.minProcess')), JSON.stringify(a.errors))
  assert.equal(a.profiles.bugfix.minProcess, 'lean', 'a loosening is not applied')
  const b = profilesOf({ workTypes: { migration: { minProcess: 'lean' } } })
  assert.ok(b.errors.some((e: string) => e.startsWith('config: workTypes.migration.minProcess')), JSON.stringify(b.errors))
  assert.equal(b.profiles.migration.minProcess, 'full')
  // red and stressTest only become true
  const c = profilesOf({ workTypes: { bugfix: { red: false }, migration: { stressTest: false } } })
  assert.ok(c.errors.some((e: string) => e.startsWith('config: workTypes.bugfix.red')), JSON.stringify(c.errors))
  assert.ok(c.errors.some((e: string) => e.startsWith('config: workTypes.migration.stressTest')), JSON.stringify(c.errors))
  assert.equal(c.profiles.bugfix.red, true)
  assert.equal(c.profiles.migration.stressTest, true)
  // plan-check reports the same errors
  const r = world([crew('alpha', { workType: 'feature' })], { workTypes: { bugfix: { minProcess: 'solo' } } }).run('plan-check')
  assert.ok(errorsOf(r).some((e: string) => e.startsWith('config: workTypes.bugfix.minProcess')), JSON.stringify(r.json))
})

test('worktypes: an unknown config key or work type is refused', () => {
  const k = profilesOf({ workTypes: { feature: { colour: 'red' } } })
  assert.ok(k.errors.some((e: string) => e.startsWith('config: workTypes.feature.colour')), JSON.stringify(k.errors))
  const w = profilesOf({ workTypes: { chore: { minProcess: 'full' } } })
  assert.ok(w.errors.some((e: string) => /^config: workTypes\.chore\b/.test(e)), JSON.stringify(w.errors))
  assert.equal(w.profiles.chore, undefined, 'an unknown work type adds no profile')
  assert.deepEqual(Object.keys(w.profiles).sort(), Object.keys(BUILT).sort())
})

test('worktypes: a v4 plan without workType passes outside an unattended run', () => {
  const env = world([crew('alpha'), crew('beta', { stage: 2 })])
  const r = env.run('plan-check')
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`)
  assert.equal(r.json.ok, true)
  assert.deepEqual(errs({ slug: 'alpha' }), [])
  // and a tightened config does not touch a crew that names no work type
  const t = world([crew('alpha')], { workTypes: { bugfix: { minProcess: 'full' } } }).run('plan-check')
  assert.equal(t.status, 0, `${t.stdout} ${t.stderr}`)
})

test('worktypes: factory worktypes prints profiles and errors', () => {
  const env = mkEnv({ config: { workTypes: { bugfix: { minProcess: 'full' }, migration: { stressTest: false } } } })
  const r = env.run('worktypes')
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`)
  assert.ok(r.json, `one JSON line expected: ${r.stdout}`)
  assert.deepEqual(Object.keys(r.json).sort(), ['errors', 'profiles'])
  assert.equal(r.json.profiles.bugfix.minProcess, 'full', JSON.stringify(r.json.profiles.bugfix))
  assert.equal(r.json.profiles.migration.stressTest, true)
  assert.ok(r.json.errors.some((e: string) => e.startsWith('config: workTypes.migration.stressTest')), JSON.stringify(r.json.errors))
  const plain = mkEnv({}).run('worktypes')
  assert.deepEqual(plain.json.errors, [])
  assert.equal(plain.json.profiles.dependency.minProcess, 'lean')
})

test('worktypes: R-62 example is refused with the bugfix minimum message', () => {
  const r = world([crew('alpha', { workType: 'bugfix', process: 'solo' })]).run('plan-check')
  assert.equal(r.status, 1, `${r.stdout} ${r.stderr}`)
  assert.equal(r.json.ok, false)
  assert.ok(errorsOf(r).includes('alpha: process solo is below the bugfix minimum lean'), JSON.stringify(r.json))
})

test('worktypes: the same plan without workType fails inside an unattended run with workType is required in an unattended run', () => {
  const plain = world([crew('alpha', { process: 'solo' })]).run('plan-check')
  assert.equal(plain.status, 0, `outside an unattended run it passes: ${plain.stdout}`)
  const r = world([crew('alpha', { process: 'solo' })], undefined, true).run('plan-check')
  assert.equal(r.status, 1, `${r.stdout} ${r.stderr}`)
  assert.ok(errorsOf(r).includes('alpha: workType is required in an unattended run'), JSON.stringify(r.json))
  // the rule lives in workTypeErrors too, not only in plan-check
  assert.ok(errs({ slug: 'alpha', process: 'solo' }, { unattended: true }).includes('alpha: workType is required in an unattended run'))
})

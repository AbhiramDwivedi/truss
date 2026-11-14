// @ts-nocheck
// R-140: a single-step test. It loads one workflows-src/stage/ step module with stubbed agent() and runner-side calls and drives
// rulingStep and rulingOrdersChange alone. Node built-ins only.

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

const STEP = path.join(import.meta.dirname, '../workflows-src/stage/ruling.js')

/** Stubs for every free name rulingStep calls; each call is recorded. */
function stubs(answers: unknown[] = []) {
  const calls: { name: string; args: unknown[] }[] = []
  const rec = (name: string, ret?: unknown) => async (...a: unknown[]) => (calls.push({ name, args: a }), ret)
  return {
    calls,
    stubs: {
      agent: rec('agent'),
      args: {},
      log: () => {},
      freshAnswers: (e: unknown) => (calls.push({ name: 'freshAnswers', args: [e] }), answers),
      integrate: rec('integrate'),
      fixBuilder: rec('fixBuilder'),
    },
  }
}

async function load(answers: unknown[] = []) {
  const { loadStageStep } = await import('../bin/build-stage.ts')
  const s = stubs(answers)
  const m = await loadStageStep(STEP, s.stubs)
  return { m, calls: s.calls }
}

test('single step ruling: rulingOrdersChange orders a change for an edit and none for a waiver', async () => {
  const { m } = await load()
  assert.equal(m.scope.rulingOrdersChange('Cherry-pick the fix commit and update the doc line'), true)
  assert.equal(m.scope.rulingOrdersChange('Waive and proceed; no change is needed'), false)
  assert.equal(m.scope.rulingOrdersChange('nothing to fix here'), false)
})

test('single step ruling: a stopped fix branch is integrated and recorded, with no builder', async () => {
  const { m, calls } = await load()
  const crew = { e: { prior: [{ at: 'fix, a', branch: 'b1' }, { at: 'green', branch: 'x' }] }, proofs: [] }
  await m.scope.rulingStep(crew, false)
  assert.deepEqual(calls.filter((c) => c.name === 'integrate').map((c) => c.args[1]), ['b1'])
  assert.deepEqual(crew.priorMerged, ['b1'])
  assert.equal(crew.step, 'qc')
  assert.equal(crew.proofs.length, 1)
  assert.equal(calls.some((c) => c.name === 'fixBuilder'), false)
})

test('single step ruling: an answers resume with a change-ordering ruling at qc spawns one fix builder', async () => {
  const { m, calls } = await load([{ at: 'qc', text: 'Add the missing doc line' }, { at: 'qc', text: 'Waive and proceed' }])
  const crew = { e: { resume: 'answers', prior: [] }, proofs: [] }
  await m.scope.rulingStep(crew, false)
  const fb = calls.filter((c) => c.name === 'fixBuilder')
  assert.equal(fb.length, 1)
  assert.match(String(fb[0].args[2]), /Add the missing doc line/)
  assert.doesNotMatch(String(fb[0].args[2]), /Waive and proceed/)
})

test('single step ruling: a waiver ruling, or a run where a member ran, returns before any runner call', async () => {
  const waive = await load([{ at: 'qc', text: 'Waive and proceed' }])
  const c1 = { e: { resume: 'answers' }, proofs: [] }
  assert.equal(await waive.m.scope.rulingStep(c1, false), undefined)
  assert.equal(c1.step, undefined)
  assert.equal(waive.calls.some((c) => c.name === 'integrate' || c.name === 'fixBuilder'), false)
  const ran = await load([{ at: 'qc', text: 'Add a line' }])
  assert.equal(await ran.m.scope.rulingStep({ e: { resume: 'answers' }, proofs: [] }, true), undefined)
  assert.equal(ran.calls.some((c) => c.name === 'fixBuilder'), false)
})

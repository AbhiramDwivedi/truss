// @ts-nocheck
// plan-write prefers the designer's structured result fields planJson / planMd over the fenced blocks in its report.
// Run with: node --test tests/plan-write-result-fields.check.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { crew, mkEnv, mkRun, planObj } from './fixtures/workflow-run/harness.ts'

const plan = (goal) => ({ ...planObj([crew('arch', { stage: 0, verdict: 'design' })], { approval: 'client', approvedAt: null }), goal })
const fenced = (json, md) => `Report.\n\n\`\`\`\`json plan.json\n${json}\n\`\`\`\`\n\n\`\`\`\`markdown plan.md\n${md}\n\`\`\`\`\n`
const PLACEHOLDER = fenced('{ ... }', '(the plan markdown)')

function write(result) {
  const env = mkEnv({ useRealPlugin: true })
  const { dir } = mkRun(env.transcripts, 'wf_plan', [{ id: 'aarch', label: 'truss-designer', agentType: 'truss:design-engineer', metaModel: 'opus', result, startTs: '2026-10-29T10:00:00.000Z' }])
  const res = env.run('plan-write', { transcript: dir, label: 'truss-designer' })
  const read = (f) => { try { return readFileSync(`${env.dir}/${f}`, 'utf8') } catch { return undefined } }
  return { res, plan: read('plan.json') && JSON.parse(read('plan.json')), md: read('plan.md') }
}

test('result fields win over valid fenced blocks (planJson as a string)', () => {
  const out = write({ report: fenced(JSON.stringify(plan('from report')), 'report md'), planJson: JSON.stringify(plan('from field')), planMd: 'field md' })
  assert.equal(out.res.status, 0, out.res.stderr)
  assert.equal(out.plan.goal, 'from field')
  assert.equal(out.plan.approvedAt, null)
  assert.equal(out.md, 'field md')
})

test('planJson may be the plan object itself', () => {
  const out = write({ report: PLACEHOLDER, planJson: plan('object'), planMd: '# md' })
  assert.equal(out.res.status, 0, out.res.stderr)
  assert.equal(out.plan.goal, 'object')
})

test('placeholder fenced blocks plus valid fields writes the plan', () => {
  const out = write({ report: PLACEHOLDER, planJson: JSON.stringify(plan('real')), planMd: '# real md' })
  assert.equal(out.res.status, 0, out.res.stderr)
  assert.equal(out.plan.goal, 'real')
  assert.equal(out.md, '# real md')
})

test('fenced blocks still work when the result has no plan fields (object and string results)', () => {
  const msg = fenced(JSON.stringify(plan('fenced')), 'fenced md')
  for (const result of [{ report: msg }, msg]) {
    const out = write(result)
    assert.equal(out.res.status, 0, out.res.stderr)
    assert.equal(out.plan.goal, 'fenced')
    assert.equal(out.md, 'fenced md')
  }
})

test('an invalid planJson field falls back to the fenced block; with neither valid it refuses', () => {
  const ok = write({ report: fenced(JSON.stringify(plan('fallback')), 'm'), planJson: 'not json', planMd: 'x' })
  assert.equal(ok.res.status, 0, ok.res.stderr)
  assert.equal(ok.plan.goal, 'fallback')
  const bad = write({ report: PLACEHOLDER, planJson: 'not json', planMd: 'x' })
  assert.equal(bad.res.status, 1)
  assert.equal(bad.plan, undefined)
})

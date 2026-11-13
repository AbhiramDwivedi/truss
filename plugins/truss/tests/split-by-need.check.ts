// @ts-nocheck
// ADR-0044 (split by need), R-82 and R-83: plan-check no longer ties approval or a full process to stage 0, accepts and checks the
// optional goalCheck, and warns (never refuses) on a later stage with no `Why stage <n>:` line. Real factory CLI on temp truss dirs.

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { amendPlan } from '../hooks/intake.ts'
import { REAL_PLUGIN, crew, mkEnv, planObj, writePlan } from './fixtures/workflow-run/harness.ts'

const P = 'split by need: '
const say = (r: any): string => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 700)}; stderr ${String(r.stderr).slice(0, 300)}`
const NOW = '2026-11-11T22:05:00Z'

function planCheck(plan: unknown, planMd?: string, extra: Record<string, string> = {}) {
  const env = mkEnv()
  writePlan(env.dir, plan)
  for (const [name, text] of Object.entries(planMd === undefined ? extra : { 'plan.md': planMd, ...extra })) writeFileSync(`${env.dir}/${name}`, text)
  return env.run('plan-check', { repo: null })
}
function accepted(r: any) {
  assert.equal(r.status, 0, say(r))
  assert.equal(r.json?.ok, true, say(r))
}

test(P + 'plan-check accepts a stage-0-free change plan with approval auto, a goalCheck and no warnings', () => {
  // the rename example of R-83: one stage of change crews, the build crew writes the ADR, the zero-match test is the goal check
  const plan = planObj([crew('rename-bin', { stage: 1 }), crew('rename-docs', { stage: 1 })], { approval: 'auto', goalCheck: 'node --test tests/zero-match.check.ts' })
  const r = planCheck(plan, '# Plan\n')
  accepted(r)
  assert.deepEqual(r.json.warnings, [], say(r))
  // the same plan with its change crews in stage 0 and no design crew is accepted too
  accepted(planCheck(planObj([crew('rename-bin', { stage: 0 })], { approval: 'auto' })))
})

test(P + 'plan-check accepts a lean design crew, and a client plan with no stage-0 crew', () => {
  const lean = planObj(
    [crew('seam', { stage: 0, verdict: 'design', process: 'lean', qc: true, red: false, estAgents: 2 }), crew('build', { stage: 1, process: 'full' })],
    { version: 4, approval: 'auto' },
  )
  const r = planCheck(lean, '# Plan\n\nWhy stage 1: build needs seam\'s merged ADR and contract test\n')
  accepted(r)
  assert.deepEqual(r.json.warnings, [], say(r))
  accepted(planCheck(planObj([crew('alpha')], { approval: 'client', approvedAt: null })))
})

test(P + 'plan-check checks goalCheck: a non-empty string when present, top-level and on a goals entry', () => {
  for (const bad of ['', '   ', 7, null, ['npm test']]) {
    const r = planCheck(planObj([crew('alpha')], { goalCheck: bad }))
    assert.equal(r.status, 1, `goalCheck ${JSON.stringify(bad)}: ${say(r)}`)
    assert.ok(r.json.errors.includes('plan: goalCheck must be a non-empty string'), JSON.stringify(r.json.errors))
  }
  const goal = (over: Record<string, unknown>) => ({ id: 'gtwo', goal: 'another goal', addedAt: NOW, approval: 'auto', approvedAt: NOW, ...over })
  const bad = planCheck(planObj([crew('alpha'), crew('beta', { goal: 'gtwo' })], { version: 3, goals: [goal({ goalCheck: '' })] }))
  assert.equal(bad.status, 1, say(bad))
  assert.ok(bad.json.errors.some((e: string) => e.startsWith('plan: goals[0] (gtwo) goalCheck')), JSON.stringify(bad.json.errors))
  accepted(planCheck(planObj([crew('alpha'), crew('beta', { goal: 'gtwo' })], { version: 3, goalCheck: 'npm test', goals: [goal({ goalCheck: 'npm test' })] })))
  // the schema declares it, optional, at both levels, with additionalProperties still false
  const schema = JSON.parse(readFileSync(`${REAL_PLUGIN}/docs/plan.schema.json`, 'utf8'))
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.properties.goalCheck.type, 'string')
  assert.equal(schema.properties.goalCheck.minLength, 1)
  assert.ok(!schema.required.includes('goalCheck'))
  assert.equal(schema.properties.goals.items.properties.goalCheck.minLength, 1)
  assert.ok(!schema.properties.goals.items.required.includes('goalCheck'))
})

test(P + 'plan-check warns, never refuses, on a later stage with no Why stage line', () => {
  // stage 2 has no Why line: the warning asks for one or says to merge it into stage 1
  const loose = planCheck(planObj([crew('alpha', { stage: 1 }), crew('gamma', { stage: 2 })]), '# Plan\n')
  accepted(loose)
  assert.equal(loose.json.warnings.length, 1, say(loose))
  assert.match(loose.json.warnings[0], /^stage 2: no "Why stage 2:" line in plan\.md; say which crew needs which earlier crew's merged work, or merge it into stage 1$/)
  // no plan.md at all: the same warning, still not a refusal
  const none = planCheck(planObj([crew('alpha', { stage: 1, owns: ['src/x/**'] }), crew('gamma', { stage: 2, owns: ['src/x/y.ts'] })]))
  accepted(none)
  assert.equal(none.json.warnings.length, 1, say(none))
  // the Why line clears it
  const why = planCheck(planObj([crew('alpha', { stage: 1 }), crew('gamma', { stage: 2 })]), '# Plan\n\n- Why stage 2: gamma needs alpha\'s merged parser\n')
  accepted(why)
  assert.deepEqual(why.json.warnings, [], say(why))
  // a bold Why line, with the colon inside or outside the bold, and a table cell clear it too
  for (const md of ['**Why stage 2:** gamma needs alpha\'s merged parser\n', '- **Why stage 2**: gamma needs alpha\'s parser\n', '| Stage | Why |\n| --- | --- |\n| 2 | Why stage 2: gamma needs alpha |\n', '| **Why stage 2:** gamma needs alpha |\n']) {
    const r = planCheck(planObj([crew('alpha', { stage: 1 }), crew('gamma', { stage: 2 })]), '# Plan\n\n' + md)
    accepted(r)
    assert.deepEqual(r.json.warnings, [], `${JSON.stringify(md)}: ${say(r)}`)
  }
  // a Why line for another stage, or one buried mid-sentence, does not
  for (const md of ['Why stage 12: gamma needs alpha\n', 'We say Why stage 2: inline only\n']) {
    const r = planCheck(planObj([crew('alpha', { stage: 1 }), crew('gamma', { stage: 2 })]), '# Plan\n\n' + md)
    accepted(r)
    assert.equal(r.json.warnings?.length, 1, `${JSON.stringify(md)}: ${say(r)}`)
  }
  // an added goal's stages read its own plan-<id>.md
  const goal = { id: 'gtwo', goal: 'another goal', addedAt: NOW, approval: 'auto', approvedAt: NOW }
  const added = planObj([crew('alpha'), crew('ga', { goal: 'gtwo', stage: 0 }), crew('gb', { goal: 'gtwo', stage: 1 })], { version: 3, goals: [goal] })
  const noLine = planCheck(added, '# Plan\n\nWhy stage 1: not this goal\n')
  accepted(noLine)
  assert.deepEqual(noLine.json.warnings.map((w: string) => w.split(':')[0]), ['stage 1 of goal gtwo'], say(noLine))
  const withLine = planCheck(added, '# Plan\n', { 'plan-gtwo.md': 'Why stage 1: gb needs ga\'s merged table\n' })
  accepted(withLine)
  assert.deepEqual(withLine.json.warnings, [], say(withLine))
})

test(P + 'approve --by auto approves an auto plan with a stage-0 crew and refuses a client plan', () => {
  const env = mkEnv()
  writePlan(env.dir, planObj([crew('d', { stage: 0, verdict: 'design' })], { approval: 'auto', approvedAt: null }))
  const ok = env.run('approve', { by: 'auto' })
  assert.equal(ok.status, 0, say(ok))
  const client = mkEnv()
  writePlan(client.dir, planObj([crew('alpha')], { approval: 'client', approvedAt: null }))
  const no = client.run('approve', { by: 'auto' })
  assert.equal(no.status, 1, say(no))
  assert.deepEqual(no.json.goals, ['run'])
})

test(P + 'a change crew\'s ADR records who actually decided, never client for an auto-approved plan', () => {
  const read = (p: string) => readFileSync(`${REAL_PLUGIN}/${p}`, 'utf8').replace(/\r/g, '')
  for (const [name, text] of [['design-engineer.md', read('agents/design-engineer.md')], ['ADR-0044', read('docs/adr/0044-split-by-need.md')]]) {
    assert.doesNotMatch(text, /writes the ADR \(`Decided by: client`\)/, `${name} still has every change-crew ADR say client`)
    assert.match(text, /`client` only when the client ruled on the design or approve[sd] the plan/, `${name}: client only when the client ruled or approved`)
    assert.match(text, /`program manager \(auto\)`/, `${name}: no program manager (auto) case`)
  }
  assert.match(read('agents/design-engineer.md'), /^Decided by: client \| default \| program manager \(auto\) \|/m, 'the ADR format line lacks program manager (auto)')
})

test(P + 'an amend carries goal.goalCheck into its goals entry and refuses an empty one', () => {
  const existing = planObj([crew('alpha')], { version: 3, approvedAt: NOW })
  const amend = (g: Record<string, unknown>) => ({ goal: { id: 'gtwo', goal: 'another goal', approval: 'auto', ...g }, crews: [crew('beta')] })
  const r = amendPlan(existing, amend({ goalCheck: 'npm test' }), NOW)
  assert.equal(r.reason, undefined, JSON.stringify(r))
  assert.equal(r.plan.goals[0].goalCheck, 'npm test')
  const none = amendPlan(existing, amend({}), NOW)
  assert.equal(Object.hasOwn(none.plan.goals[0], 'goalCheck'), false)
  const empty = amendPlan(existing, amend({ goalCheck: '' }), NOW)
  assert.match(empty.reason, /goalCheck/)
  // a replace drops an old goalCheck the new amend leaves out
  const first = amendPlan(existing, amend({ goalCheck: 'npm test' }), NOW).plan
  first.goals[0].approvedAt = null
  const replaced = amendPlan(first, amend({}), NOW)
  assert.equal(Object.hasOwn(replaced.plan.goals[0], 'goalCheck'), false, JSON.stringify(replaced))
})

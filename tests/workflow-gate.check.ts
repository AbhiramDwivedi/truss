// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0009 Decision 6 (the Workflow gate) and Decision 2 (roles table). Written from the ADR before the code.
//
// Run with: node --test tests/workflow-gate.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs.
//
// Assumption (the ADR fixes it in the `start --stage` output): args.truss.crews is an array of crew entries,
// each an object with a `slug`. Stage tests pass crews in that form.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as reg from '../hooks/register.ts'

const { workflowRoleVerdict, workflowCallVerdict, fencedBlock } = reg

const ROLES = {
  designer: { agentType: 'truss:design-engineer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  checker: { agentType: 'truss:checking-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  planner: { agentType: 'truss:planning-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  tester: { agentType: 'general-purpose', model: 'sonnet', effort: 'medium', isolation: 'worktree' },
  builder: { agentType: 'general-purpose', model: 'sonnet', effort: 'low', isolation: 'worktree' },
  resolver: { agentType: 'general-purpose', model: 'sonnet', effort: 'medium', isolation: 'none' },
  writer: { agentType: 'truss:writer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  rca: { agentType: 'general-purpose', model: 'opus', effort: 'medium', isolation: 'none' },
  stress: { agentType: 'truss:qc-engineer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  qc: { agentType: 'truss:qc-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  runner: { agentType: 'general-purpose', model: 'sonnet', effort: 'low', isolation: 'none' },
}
const withRole = (key: string, role: unknown) => ({ ...ROLES, [key]: role })

const isDeny = (v: unknown) => {
  assert.ok(v && typeof v === 'object', `expected a deny, got ${JSON.stringify(v)}`)
  assert.equal(typeof (v as { deny: unknown }).deny, 'string')
  return (v as { deny: string }).deny
}
const refused = (v: unknown) => {
  const d = isDeny(v)
  assert.ok(d.startsWith('[truss] Refused:'), d)
  return d
}

test('register.ts exports the three functions', () => {
  assert.equal(typeof reg.workflowCallVerdict, 'function')
  assert.equal(typeof reg.workflowRoleVerdict, 'function')
  assert.equal(typeof reg.fencedBlock, 'function')
})

// ---- workflowRoleVerdict ----

test('roles: the Decision 2 table is accepted', () => {
  assert.equal(workflowRoleVerdict(ROLES), undefined)
})

for (const model of ['fable', 'haiku', 'claude-opus-4-5', 'Opus', '']) {
  test(`roles: model ${JSON.stringify(model)} is refused`, () => {
    isDeny(workflowRoleVerdict(withRole('builder', { ...ROLES.builder, model })))
  })
}
for (const effort of ['high', 'xhigh', 'max']) {
  test(`roles: effort ${effort} is refused`, () => {
    isDeny(workflowRoleVerdict(withRole('qc', { ...ROLES.qc, effort })))
  })
}
test('roles: a missing model is refused', () => {
  const { model: _m, ...rest } = ROLES.checker
  isDeny(workflowRoleVerdict(withRole('checker', rest)))
})
test('roles: a missing effort is refused', () => {
  const { effort: _e, ...rest } = ROLES.checker
  isDeny(workflowRoleVerdict(withRole('checker', rest)))
})
test('roles: a foreman role is refused even on opus/medium', () => {
  isDeny(workflowRoleVerdict(withRole('foreman', { agentType: 'truss:foreman', model: 'opus', effort: 'medium', isolation: 'worktree' })))
})
test('roles: a commissioning role is refused even on sonnet/low', () => {
  isDeny(workflowRoleVerdict(withRole('commissioning', { agentType: 'truss:commissioning-engineer', model: 'sonnet', effort: 'low', isolation: 'none' })))
})
test('roles: an integrator role is refused even on opus/medium', () => {
  refused(workflowRoleVerdict(withRole('integrator', { agentType: 'general-purpose', model: 'opus', effort: 'medium', isolation: 'worktree' })))
})
test('roles: an integrator role is refused even on sonnet/low', () => {
  refused(workflowRoleVerdict(withRole('integrator', { agentType: 'general-purpose', model: 'sonnet', effort: 'low', isolation: 'none' })))
})
for (const key of ['builder', 'qc']) {
  for (const agentType of ['truss:foreman', 'truss:commissioning-engineer', 'truss:integrator']) {
    test(`roles: key ${key} with agentType ${agentType} is refused even with an allowed model and effort`, () => {
      refused(workflowRoleVerdict(withRole(key, { ...ROLES[key], agentType, model: 'sonnet', effort: 'low' })))
    })
  }
}
for (const key of ['stress test', 'qc2', 'Qc', 'QC', 'red_team', '']) {
  test(`roles: role key ${JSON.stringify(key)} is refused`, () => {
    isDeny(workflowRoleVerdict(withRole(key, ROLES.qc)))
  })
}
for (const [name, v] of [['undefined', undefined], ['null', null], ['array', []], ['array of roles', [ROLES.qc]], ['string', 'roles'], ['number', 3]] as const) {
  test(`roles: non-object input (${name}) is refused`, () => {
    isDeny(workflowRoleVerdict(v))
  })
}

// ---- workflowCallVerdict ----

const PLUGIN = 'C:/p'
const PLAN_JS = '// plan.js\nexport default async function () { await agent({ type: "truss:design-engineer" }) }\n'
const STAGE_JS = '// stage.js\nexport default async function () { await agent({ type: "truss:qc-engineer" }) }\n'
const TEXTS = [PLAN_JS, STAGE_JS]
const APPROVED = '2026-10-29T00:00:00Z'

const plan = (extra: Record<string, unknown> = {}) =>
  ({ version: 2, goal: 'g', approval: 'auto', approvedAt: null, maxParallelCrews: 4, reworkAllowance: 2, crews: [], ...extra }) as never
const crew = (slug: string, stage: number, status: string) => ({ slug, stage, status, verdict: 'extend' })

const call = (over: Record<string, unknown> = {}) => ({
  scriptPath: `${PLUGIN}/workflows/plan.js`,
  scriptText: PLAN_JS,
  args: { truss: { kind: 'plan', roles: ROLES } },
  pluginDir: PLUGIN,
  pluginScriptTexts: TEXTS,
  ...over,
})
const FOREIGN = 'export default async function () { await agent({ type: "truss:foreman" }) }\n'
const NOT_TRUSS = 'export default async function () { await agent({ type: "general-purpose" }) }\n'
const ONLY_FROM = "truss agents run in a Workflow only from the plugin's plan.js and stage.js"
const stageArgs = (crews: unknown[] = []) => ({ truss: { kind: 'stage', roles: ROLES, crews } })

test('call: no plan is undefined, even for a foreign script naming truss:', () => {
  assert.equal(workflowCallVerdict(undefined, call({ scriptPath: '/x/evil.js', scriptText: FOREIGN })), undefined)
})
test('call: a version 1 plan is undefined, even for a foreign script naming truss:', () => {
  assert.equal(workflowCallVerdict(plan({ version: 1 }), call({ scriptPath: '/x/evil.js', scriptText: FOREIGN })), undefined)
})

test('call: plan.js by path passes', () => {
  assert.equal(workflowCallVerdict(plan(), call()), undefined)
})
test('call: stage.js by path passes', () => {
  const input = call({ scriptPath: `${PLUGIN}/workflows/stage.js`, scriptText: STAGE_JS, args: stageArgs() })
  assert.equal(workflowCallVerdict(plan(), input), undefined)
})
test('call: a backslash scriptPath matches the plugin dir', () => {
  const input = call({ scriptPath: 'C:\\p\\workflows\\stage.js', scriptText: STAGE_JS, args: stageArgs() })
  assert.equal(workflowCallVerdict(plan(), input), undefined)
})
test('call: truss-by-path with a bad roles table is refused', () => {
  refused(workflowCallVerdict(plan(), call({ args: { truss: { kind: 'plan', roles: withRole('x', { ...ROLES.qc, model: 'fable' }) } } })))
})

test("call: a byte-identical copy of stage.js at another path is truss's", () => {
  const input = call({ scriptPath: '/home/u/.claude/projects/p/s/workflows/scripts/truss-stage.js', scriptText: STAGE_JS, args: stageArgs() })
  assert.equal(workflowCallVerdict(plan(), input), undefined)
})
test('call: a copy at another path is held to the args checks (missing args.truss refused)', () => {
  refused(workflowCallVerdict(plan(), call({ scriptPath: '/elsewhere/truss-plan.js', scriptText: PLAN_JS, args: {} })))
})
test("call: an inline script with identical text is truss's", () => {
  const input = call({ script: STAGE_JS, scriptPath: undefined, scriptText: STAGE_JS, args: stageArgs() })
  assert.equal(workflowCallVerdict(plan(), input), undefined)
})
test('call: an edited copy (one byte changed) naming truss: is refused with the plan.js/stage.js text', () => {
  const edited = STAGE_JS.replace('qc', 'judgf')
  assert.notEqual(edited, STAGE_JS)
  const d = refused(workflowCallVerdict(plan(), call({ scriptPath: '/x/truss-stage.js', scriptText: edited, args: stageArgs() })))
  assert.ok(d.includes(ONLY_FROM), d)
})
test('call: an edited copy (trailing newline added) naming truss: is refused', () => {
  const d = refused(workflowCallVerdict(plan(), call({ scriptPath: '/x/truss-plan.js', scriptText: PLAN_JS + '\n' })))
  assert.ok(d.includes(ONLY_FROM), d)
})
test('call: an edited inline script naming truss: is refused', () => {
  const d = refused(workflowCallVerdict(plan(), call({ script: PLAN_JS + ' ', scriptPath: undefined, scriptText: PLAN_JS + ' ' })))
  assert.ok(d.includes(ONLY_FROM), d)
})
test('call: a foreign script whose text contains truss: is refused with the plan.js/stage.js text', () => {
  const d = refused(workflowCallVerdict(plan(), call({ scriptPath: '/x/other.js', scriptText: FOREIGN, args: undefined })))
  assert.ok(d.includes(ONLY_FROM), d)
})
test('call: a foreign scriptPath that could not be read is refused with that text', () => {
  const d = refused(workflowCallVerdict(plan(), call({ scriptPath: '/x/missing.js', scriptText: undefined, args: undefined })))
  assert.ok(d.includes(ONLY_FROM), d)
})
test('call: a foreign script without truss: is undefined', () => {
  assert.equal(workflowCallVerdict(plan(), call({ scriptPath: '/x/other.js', scriptText: NOT_TRUSS, args: undefined })), undefined)
})

// ---- script and scriptPath together (ADR-0009 Decision 6) ----

test('call: script identical to plan.js plus scriptPath plan.js, valid args, is refused', () => {
  refused(workflowCallVerdict(plan(), call({ script: PLAN_JS, scriptPath: `${PLUGIN}/workflows/plan.js`, scriptText: PLAN_JS })))
})
test('call: script identical to plan.js plus a foreign scriptPath is refused', () => {
  refused(workflowCallVerdict(plan(), call({ script: PLAN_JS, scriptPath: '/x/other.js', scriptText: PLAN_JS })))
})
test('call: foreign script plus the plugin stage.js scriptPath is refused', () => {
  refused(workflowCallVerdict(plan(), call({ script: FOREIGN, scriptPath: `${PLUGIN}/workflows/stage.js`, scriptText: FOREIGN, args: stageArgs() })))
})
test('call: a script without truss: plus a foreign scriptPath is refused', () => {
  refused(workflowCallVerdict(plan(), call({ script: NOT_TRUSS, scriptPath: '/x/other.js', scriptText: NOT_TRUSS, args: undefined })))
})
test('call: script and scriptPath together, no plan, is undefined', () => {
  assert.equal(workflowCallVerdict(undefined, call({ script: FOREIGN, scriptPath: `${PLUGIN}/workflows/stage.js`, scriptText: FOREIGN })), undefined)
})
test('call: script and scriptPath together, version 1 plan, is undefined', () => {
  assert.equal(workflowCallVerdict(plan({ version: 1 }), call({ script: FOREIGN, scriptPath: `${PLUGIN}/workflows/stage.js`, scriptText: FOREIGN })), undefined)
})
test('call: script alone (scriptPath undefined) with a foreign truss: text is still refused', () => {
  refused(workflowCallVerdict(plan(), call({ script: FOREIGN, scriptPath: undefined, scriptText: FOREIGN })))
})

test('call: a plugin plan.js call whose roles hold builder as truss:foreman is refused', () => {
  const roles = withRole('builder', { ...ROLES.builder, agentType: 'truss:foreman' })
  refused(workflowCallVerdict(plan(), call({ args: { truss: { kind: 'plan', roles } } })))
})

test('call: args absent is refused for a truss script', () => {
  refused(workflowCallVerdict(plan(), call({ args: undefined })))
})
test('call: args.truss absent is refused', () => {
  refused(workflowCallVerdict(plan(), call({ args: {} })))
})
test('call: args.truss a string is refused', () => {
  refused(workflowCallVerdict(plan(), call({ args: { truss: 'plan' } })))
})
test('call: args.truss null is refused', () => {
  refused(workflowCallVerdict(plan(), call({ args: { truss: null } })))
})
test('call: a role on fable is refused', () => {
  refused(workflowCallVerdict(plan(), call({ args: { truss: { kind: 'plan', roles: withRole('qc', { ...ROLES.qc, model: 'fable' }) } } })))
})
test('call: a foreman role is refused', () => {
  refused(workflowCallVerdict(plan(), call({ args: { truss: { kind: 'plan', roles: withRole('foreman', ROLES.qc) } } })))
})
test('call: missing roles is refused', () => {
  refused(workflowCallVerdict(plan(), call({ args: { truss: { kind: 'plan' } } })))
})

test('call: kind plan on an approved plan is refused', () => {
  refused(workflowCallVerdict(plan({ approvedAt: APPROVED }), call()))
})
test('call: kind plan with approvedAt null is undefined', () => {
  assert.equal(workflowCallVerdict(plan({ approvedAt: null }), call()), undefined)
})

const stageCall = (crews: unknown[]) => call({ scriptPath: `${PLUGIN}/workflows/stage.js`, scriptText: STAGE_JS, args: stageArgs(crews) })

test('call: kind stage with every crew running and allowed is undefined', () => {
  const p = plan({ approvedAt: APPROVED, crews: [crew('a', 1, 'running'), crew('b', 1, 'running')] })
  assert.equal(workflowCallVerdict(p, stageCall([{ slug: 'a' }, { slug: 'b' }])), undefined)
})
test('call: kind stage refuses a crew whose status is planned', () => {
  const p = plan({ approvedAt: APPROVED, crews: [crew('a', 1, 'running'), crew('b', 1, 'planned')] })
  refused(workflowCallVerdict(p, stageCall([{ slug: 'a' }, { slug: 'b' }])))
})
test('call: kind stage refuses a crew whose status is merged', () => {
  const p = plan({ approvedAt: APPROVED, crews: [crew('a', 1, 'merged')] })
  refused(workflowCallVerdict(p, stageCall([{ slug: 'a' }])))
})
test('call: kind stage refuses when planVerdict refuses (an earlier stage is not merged)', () => {
  const p = plan({ approvedAt: APPROVED, crews: [crew('a', 1, 'planned'), crew('b', 2, 'running')] })
  refused(workflowCallVerdict(p, stageCall([{ slug: 'b' }])))
})
test('call: kind stage refuses when planVerdict refuses (the client has not approved the design)', () => {
  const p = plan({ approval: 'client', approvedAt: null, crews: [crew('a', 1, 'running')] })
  refused(workflowCallVerdict(p, stageCall([{ slug: 'a' }])))
})
test('call: kind stage refuses when planVerdict refuses (the cap is reached)', () => {
  const p = plan({ approvedAt: APPROVED, maxParallelCrews: 1, crews: [crew('a', 1, 'running'), crew('b', 1, 'running')] })
  refused(workflowCallVerdict(p, stageCall([{ slug: 'a' }])))
})

// ---- script and kind must pair: stage.js with "stage", plan.js with "plan" ----

const planKindArgs = (crews: unknown[] = []) => ({ truss: { kind: 'plan', roles: ROLES, crews } })
const runningPlan = () => plan({ approvedAt: APPROVED, crews: [crew('a', 1, 'running')] })
const mismatch = (d: string, script: string, kind: string) => {
  assert.ok(d.includes(script), d)
  assert.ok(d.includes(kind), d)
}

test('call: stage.js by path with kind plan is refused, naming stage.js and plan', () => {
  const input = call({ scriptPath: `${PLUGIN}/workflows/stage.js`, scriptText: STAGE_JS, args: planKindArgs() })
  mismatch(refused(workflowCallVerdict(plan(), input)), 'stage.js', 'plan')
})
test('call: stage.js with kind plan is refused for the stress test case (client approval, approvedAt null, planned crew)', () => {
  const p = plan({ approval: 'client', crews: [crew('auth', 1, 'planned')] })
  const args = { truss: { kind: 'plan', roles: ROLES, crews: [{ slug: 'auth' }] } }
  const input = call({ scriptPath: `${PLUGIN}/workflows/stage.js`, scriptText: STAGE_JS, args })
  mismatch(refused(workflowCallVerdict(p, input)), 'stage.js', 'plan')
})
test('call: plan.js by path with kind stage (running allowed crews) is refused, naming plan.js and stage', () => {
  const input = call({ scriptPath: `${PLUGIN}/workflows/plan.js`, scriptText: PLAN_JS, args: stageArgs([{ slug: 'a' }]) })
  mismatch(refused(workflowCallVerdict(runningPlan(), input)), 'plan.js', 'stage')
})
test('call: an inline script identical to stage.js with kind plan is refused', () => {
  const input = call({ script: STAGE_JS, scriptPath: undefined, scriptText: STAGE_JS, args: planKindArgs() })
  mismatch(refused(workflowCallVerdict(plan(), input)), 'stage.js', 'plan')
})
test('call: an inline script identical to plan.js with kind stage is refused', () => {
  const input = call({ script: PLAN_JS, scriptPath: undefined, scriptText: PLAN_JS, args: stageArgs([{ slug: 'a' }]) })
  mismatch(refused(workflowCallVerdict(runningPlan(), input)), 'plan.js', 'stage')
})
test('call: a byte-identical copy of stage.js at a foreign path with kind plan is refused', () => {
  const input = call({ scriptPath: '/elsewhere/truss-stage.js', scriptText: STAGE_JS, args: planKindArgs() })
  mismatch(refused(workflowCallVerdict(plan(), input)), 'stage.js', 'plan')
})

// ---- fencedBlock ----

// Contract (register.ts comment): the inner lines of the first block that opens with a line exactly equal to `open`
// (the opening fence itself, e.g. '````json plan.json') and ends at the next line that is exactly four backticks.

test('fencedBlock: returns the inner lines of the block opened by the given line', () => {
  const msg = 'intro\n````json plan.json\n{"a":1}\nx\n````\ntrailer'
  assert.equal(fencedBlock(msg, '````json plan.json'), '{"a":1}\nx')
})
test('fencedBlock: strips CRLF', () => {
  const msg = 'intro\r\n````markdown plan.md\r\na\r\nb\r\n````\r\ntrailer'
  assert.equal(fencedBlock(msg, '````markdown plan.md'), 'a\nb')
})
test('fencedBlock: undefined without a closing fence', () => {
  assert.equal(fencedBlock('````json plan.json\na\nb\n', '````json plan.json'), undefined)
})
test('fencedBlock: undefined when the opening line is absent', () => {
  assert.equal(fencedBlock('nothing here\n````\na\n````', '````json plan.json'), undefined)
})
test('fencedBlock: the first matching block wins', () => {
  const msg = '````json plan.json\nfirst\n````\n````json plan.json\nsecond\n````'
  assert.equal(fencedBlock(msg, '````json plan.json'), 'first')
})

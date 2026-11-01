// @ts-nocheck
// truss ADR-0016 (plugin fixes) hooks seams: designerResumeVerdict (item 1), MAIN_MODEL_REFUSAL (item 2) and the
// JSON-string `args` of workflowCallVerdict (item 13), all in hooks/register.ts. Written from the ADR before the code.
// Cases named `pf <n>:` must fail on today's producers; cases named `control:` hold today. Imports only node built-ins and
// the producer, loaded dynamically: a missing export makes the case fail with `producer missing: hooks <name>`, never a
// module-load crash.
//
// Run with: node --test tests/plugin-fixes-hooks-contract.check.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'

async function reg(): Promise<Record<string, unknown>> {
  try {
    return await import('../hooks/register.ts')
  } catch {
    throw new Error('producer missing: hooks register.ts')
  }
}
async function need(name: string): Promise<any> {
  const mod = await reg()
  if (mod[name] === undefined) throw new Error(`producer missing: hooks ${name}`)
  return mod[name]
}

const ROLES = {
  designer: { agentType: 'truss:design-engineer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  checker: { agentType: 'truss:checking-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  tester: { agentType: 'general-purpose', model: 'sonnet', effort: 'medium', isolation: 'worktree' },
  builder: { agentType: 'general-purpose', model: 'sonnet', effort: 'low', isolation: 'worktree' },
  qc: { agentType: 'truss:qc-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
}

const plan = (extra: Record<string, unknown> = {}) =>
  ({ version: 2, goal: 'g', approval: 'auto', approvedAt: null, maxParallelCrews: 4, reworkAllowance: 2, crews: [], ...extra }) as never

// ---- designerResumeVerdict ----

const agent = (id: string, name: string, type = 'truss:design-engineer') => ({ id, name, type, status: 'running', description: name, live: true, seq: 1 })
const AMEND = agent('a1b2c3d4e5f60718', 'designer-amend-widgets')
const PLAN = agent('0f9e8d7c6b5a4321', 'designer-plan-widgets')
const OTHER = agent('1122334455667788', 'builder-widgets', 'general-purpose')
const AGENTS = [AMEND, PLAN, OTHER]
const DESIGNERS = new Map<string, 'plan' | 'amend'>([
  [AMEND.id, 'amend'],
  [PLAN.id, 'plan'],
])

test('pf 1: designerResumeVerdict denies a SendMessage to an amend designer by name', async () => {
  const f = await need('designerResumeVerdict')
  const v = f(AMEND.name, AGENTS, DESIGNERS)
  assert.ok(v && typeof v.deny === 'string', `expected a deny, got ${JSON.stringify(v)}`)
  assert.ok(v.deny.startsWith('[truss] Refused:'), v.deny)
  assert.match(v.deny, /amend/)
  assert.match(v.deny, /fresh/)
})

test('pf 2: designerResumeVerdict denies a SendMessage to an amend designer by id', async () => {
  const f = await need('designerResumeVerdict')
  const v = f(AMEND.id, AGENTS, DESIGNERS)
  assert.ok(v && typeof v.deny === 'string', `expected a deny, got ${JSON.stringify(v)}`)
  assert.ok(v.deny.startsWith('[truss] Refused:'), v.deny)
  assert.match(v.deny, /amend/)
  assert.match(v.deny, /fresh/)
})

test('pf 3: designerResumeVerdict denies a plan designer and names the plan mode', async () => {
  const f = await need('designerResumeVerdict')
  for (const to of [PLAN.name, PLAN.id]) {
    const v = f(to, AGENTS, DESIGNERS)
    assert.ok(v && typeof v.deny === 'string', `expected a deny for ${to}, got ${JSON.stringify(v)}`)
    assert.ok(v.deny.startsWith('[truss] Refused:'), v.deny)
    assert.match(v.deny, /plan/)
    assert.match(v.deny, /fresh/)
    assert.doesNotMatch(v.deny, /amend/)
  }
})

test('pf 4: designerResumeVerdict gives undefined for a non-designer and for a non-string to', async () => {
  const f = await need('designerResumeVerdict')
  assert.equal(f(OTHER.name, AGENTS, DESIGNERS), undefined)
  assert.equal(f(OTHER.id, AGENTS, DESIGNERS), undefined)
  assert.equal(f('nobody-by-that-name', AGENTS, DESIGNERS), undefined)
  for (const to of [undefined, null, 7, { to: AMEND.name }, [AMEND.name]]) assert.equal(f(to, AGENTS, DESIGNERS), undefined)
  assert.equal(f(AMEND.name, AGENTS, new Map()), undefined)
})

// ---- MAIN_MODEL_REFUSAL ----

test('pf 5: MAIN_MODEL_REFUSAL names no model and says model must be set', async () => {
  const text = await need('MAIN_MODEL_REFUSAL')
  assert.equal(typeof text, 'string')
  assert.doesNotMatch(text, /opus|sonnet/i)
  assert.match(text, /model/)
  assert.ok(text.includes('[truss]'), text)
})

test('control: mainCallVerdict accepts a non-empty model other than opus or sonnet on a v2 plan', async () => {
  const f = await need('mainCallVerdict')
  assert.equal(f(plan(), undefined, 'truss:foreman', 'fable', 'medium'), undefined)
})

test('control: mainCallVerdict refuses an empty model with the MAIN_MODEL_REFUSAL text', async () => {
  const f = await need('mainCallVerdict')
  const text = await need('MAIN_MODEL_REFUSAL')
  assert.deepEqual(f(plan(), undefined, 'truss:foreman', '', 'medium'), { deny: text })
})

// ---- workflowCallVerdict, JSON-string args ----

const PLUGIN = '/p'
const PLAN_JS = '// plan.js\nexport default async function () { await agent({ type: "truss:design-engineer" }) }\n'
const STAGE_JS = '// stage.js\nexport default async function () { await agent({ type: "truss:qc-engineer" }) }\n'
const call = (over: Record<string, unknown> = {}) => ({
  scriptPath: `${PLUGIN}/workflows/stage.js`,
  scriptText: STAGE_JS,
  args: { truss: { kind: 'stage', roles: ROLES, crews: [] } },
  pluginDir: PLUGIN,
  pluginScriptTexts: [PLAN_JS, STAGE_JS],
  ...over,
})
const badRoles = { ...ROLES, builder: { ...ROLES.builder, model: 'fable' } }

test('control: workflowCallVerdict allows an object args on stage.js', async () => {
  const f = await need('workflowCallVerdict')
  assert.equal(f(plan(), call()), undefined)
})

test('control: workflowCallVerdict refuses an object args with a bad roles table', async () => {
  const f = await need('workflowCallVerdict')
  const v = f(plan(), call({ args: { truss: { kind: 'stage', roles: badRoles, crews: [] } } }))
  assert.ok(v && v.deny.startsWith('[truss] Refused:'), JSON.stringify(v))
})

test('control: workflowCallVerdict refuses an unparsable string args', async () => {
  const f = await need('workflowCallVerdict')
  const v = f(plan(), call({ args: '{"truss": {kind: stage' }))
  assert.ok(v && v.deny.startsWith('[truss] Refused:'), JSON.stringify(v))
})

test('pf 6: workflowCallVerdict gives a JSON-string args the same verdict as the parsed object (allowed)', async () => {
  const f = await need('workflowCallVerdict')
  const args = { truss: { kind: 'stage', roles: ROLES, crews: [] } }
  assert.equal(f(plan(), call({ args })), undefined)
  assert.equal(f(plan(), call({ args: JSON.stringify(args) })), undefined)
})

test('pf 7: workflowCallVerdict gives a JSON-string args the same verdict as the parsed object (refused)', async () => {
  const f = await need('workflowCallVerdict')
  const args = { truss: { kind: 'stage', roles: badRoles, crews: [] } }
  const want = f(plan(), call({ args }))
  assert.ok(want && want.deny.startsWith('[truss] Refused:'), JSON.stringify(want))
  assert.deepEqual(f(plan(), call({ args: JSON.stringify(args) })), want)
})

test('pf 8: workflowCallVerdict reads a JSON-string args on plan.js too', async () => {
  const f = await need('workflowCallVerdict')
  const args = JSON.stringify({ truss: { kind: 'plan', roles: ROLES } })
  assert.equal(f(plan(), call({ scriptPath: `${PLUGIN}/workflows/plan.js`, scriptText: PLAN_JS, args })), undefined)
})

test('pf 9: workflowCallVerdict gives a JSON-string args with the wrong kind the same verdict as the object', async () => {
  const f = await need('workflowCallVerdict')
  const args = { truss: { kind: 'plan', roles: ROLES } }
  const want = f(plan(), call({ args }))
  assert.ok(want && want.deny.includes('stage.js runs only with kind "stage"'), JSON.stringify(want))
  assert.deepEqual(f(plan(), call({ args: JSON.stringify(args) })), want)
})

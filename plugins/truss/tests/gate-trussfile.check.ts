// @ts-nocheck
// truss ADR-0024 Item 29, gate half and SKILL.md: expandTrussFile(args, trussDir, read) in hooks/register.ts, and the
// Workflow handler calling it before workflowCallVerdict. Written before the code. Runs under plain node (no
// `claude-code/testing`), like main-edit-gate.check.ts.
//
// Run with: node --test tests/gate-trussfile.check.ts
//
// Contract these cases assume:
//  - `read(path)` is called with the trussFile path and returns the file text (a string) or throws.
//  - Each case `await`s the result, so a sync or an async implementation both pass.
//  - `args` is an object or a JSON string. A pass returns `{args}` whose `truss` deep-equals the file's `.truss` and
//    which holds no `trussFile` key (when args is a string the returned args may be an object or a JSON string).
//  - A refusal returns `{deny}` starting `[truss] Refused:`.
//  - Without `trussFile` it returns `{args}` deep-equal to the input and never calls `read`.
//  - The file holds the `start` output; its `.truss` is the object that becomes `args.truss`.
// Cases titled `i29 M:` fail on the base code; `control N:` cases pass on it.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { codeOnly } from './hooks-load.check.ts'

const REGISTER = new URL('../hooks/register.ts', import.meta.url)
const SKILL = new URL('../skills/run/SKILL.md', import.meta.url)

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
const PLUGIN = 'C:/p'
const PLAN_JS = '// plan.js\nexport default async function () { await agent({ type: "truss:design-engineer" }) }\n'
const STAGE_JS = '// stage.js\nexport default async function () { await agent({ type: "truss:qc-engineer" }) }\n'
const APPROVED = '2026-10-29T00:00:00Z'
const runningPlan = () => ({
  version: 2, goal: 'g', approval: 'auto', approvedAt: APPROVED, maxParallelCrews: 4, reworkAllowance: 2,
  crews: [{ slug: 'a', stage: 1, status: 'running', verdict: 'extend' }],
})
const stageTruss = () => ({ kind: 'stage', roles: ROLES, crews: [{ slug: 'a' }] })
const planTruss = () => ({ kind: 'plan', roles: ROLES })
const gate = (workflowCallVerdict: any, args: unknown) =>
  workflowCallVerdict(runningPlan(), {
    scriptPath: `${PLUGIN}/workflows/stage.js`,
    scriptText: STAGE_JS,
    args,
    pluginDir: PLUGIN,
    pluginScriptTexts: [PLAN_JS, STAGE_JS],
  })

async function load() {
  const mod = await import('../hooks/register.ts')
  return { expandTrussFile: mod.expandTrussFile, workflowCallVerdict: mod.workflowCallVerdict }
}

// A real truss dir (and a sibling dir outside it), removed in finally.
async function withDirs(fn: (d: { root: string; truss: string; outside: string }) => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gate-trussfile-')))
  try {
    const truss = join(root, 'truss')
    const outside = join(root, 'outside')
    mkdirSync(truss)
    mkdirSync(outside)
    await fn({ root, truss, outside })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const readFs = (p: string) => readFileSync(p, 'utf8')
const asObj = (a: unknown) => (typeof a === 'string' ? JSON.parse(a) : a)
const denied = (r: any) => {
  assert.ok(r && typeof r.deny === 'string', `expected {deny}, got ${JSON.stringify(r)}`)
  assert.ok(r.deny.startsWith('[truss] Refused:'), r.deny)
}

// ---- controls: pass on the base code ----

test('control 1: inline args.truss for stage.js is accepted by workflowCallVerdict', async () => {
  const { workflowCallVerdict } = await load()
  assert.equal(gate(workflowCallVerdict, { truss: stageTruss() }), undefined)
})

test('control 2: args without trussFile and without truss are refused as today', async () => {
  const { workflowCallVerdict } = await load()
  const v = gate(workflowCallVerdict, {})
  assert.ok(v.deny.startsWith('[truss] Refused:'), v.deny)
  assert.ok(v.deny.includes('a truss Workflow needs args.truss'), v.deny)
})

test('control 3: the Workflow handler still ends .catch(failOpen)', () => {
  const src = readFileSync(REGISTER, 'utf8')
  const start = src.indexOf("on('tool.call', { tool: 'Workflow' }")
  assert.ok(start > 0, 'Workflow handler not found')
  const end = src.indexOf('\n  }).catch(failOpen)', start)
  assert.ok(end > start, 'Workflow handler does not end with .catch(failOpen)')
  assert.ok(!src.slice(start, end).includes("on('tool.call'", 10), 'handler end found in a later handler')
})

// ---- i29: expandTrussFile ----

test('i29 1: object args with trussFile expand to args.truss and the gate accepts them', async () => {
  const { expandTrussFile, workflowCallVerdict } = await load()
  await withDirs(async ({ truss }) => {
    const file = join(truss, 'stage-args.json')
    writeFileSync(file, JSON.stringify({ scriptPath: 'x', truss: stageTruss() }))
    const r = await expandTrussFile({ trussFile: file }, truss, readFs)
    assert.equal(r.deny, undefined, r.deny)
    assert.deepEqual(r.args.truss, stageTruss())
    assert.ok(!('trussFile' in r.args))
    assert.equal(gate(workflowCallVerdict, r.args), undefined)
  })
})

test('i29 2: JSON-string args with trussFile expand and the gate accepts them', async () => {
  const { expandTrussFile, workflowCallVerdict } = await load()
  await withDirs(async ({ truss }) => {
    const file = join(truss, 'stage-args.json')
    writeFileSync(file, JSON.stringify({ truss: stageTruss() }))
    const r = await expandTrussFile(JSON.stringify({ trussFile: file }), truss, readFs)
    assert.equal(r.deny, undefined, r.deny)
    const out = asObj(r.args)
    assert.deepEqual(out.truss, stageTruss())
    assert.ok(!('trussFile' in out))
    assert.equal(gate(workflowCallVerdict, r.args), undefined)
  })
})

test('i29 3: both truss and trussFile are refused', async () => {
  const { expandTrussFile } = await load()
  await withDirs(async ({ truss }) => {
    const file = join(truss, 'stage-args.json')
    writeFileSync(file, JSON.stringify({ truss: stageTruss() }))
    denied(await expandTrussFile({ truss: stageTruss(), trussFile: file }, truss, readFs))
  })
})

test('i29 4: a relative trussFile is refused', async () => {
  const { expandTrussFile } = await load()
  await withDirs(async ({ truss }) => {
    writeFileSync(join(truss, 'stage-args.json'), JSON.stringify({ truss: stageTruss() }))
    denied(await expandTrussFile({ trussFile: 'stage-args.json' }, truss, readFs))
  })
})

test('i29 5: a .. path that leaves the truss dir is refused', async () => {
  const { expandTrussFile } = await load()
  await withDirs(async ({ truss, outside }) => {
    writeFileSync(join(outside, 'a.json'), JSON.stringify({ truss: stageTruss() }))
    denied(await expandTrussFile({ trussFile: `${truss}/../outside/a.json` }, truss, readFs))
  })
})

test('i29 6: an absolute path outside the truss dir is refused', async () => {
  const { expandTrussFile } = await load()
  await withDirs(async ({ truss, outside }) => {
    const file = join(outside, 'a.json')
    writeFileSync(file, JSON.stringify({ truss: stageTruss() }))
    denied(await expandTrussFile({ trussFile: file }, truss, readFs))
  })
})

test('i29 7: a missing file is refused', async () => {
  const { expandTrussFile } = await load()
  await withDirs(async ({ truss }) => {
    denied(await expandTrussFile({ trussFile: join(truss, 'nope.json') }, truss, readFs))
  })
})

test('i29 8: a read that throws is refused', async () => {
  const { expandTrussFile } = await load()
  await withDirs(async ({ truss }) => {
    const read = () => {
      throw new Error('EACCES')
    }
    denied(await expandTrussFile({ trussFile: join(truss, 'a.json') }, truss, read))
  })
})

test('i29 9: a file that is not JSON is refused', async () => {
  const { expandTrussFile } = await load()
  await withDirs(async ({ truss }) => {
    const file = join(truss, 'a.json')
    writeFileSync(file, 'not json {')
    denied(await expandTrussFile({ trussFile: file }, truss, readFs))
  })
})

test('i29 10: a file with no object .truss is refused', async () => {
  const { expandTrussFile } = await load()
  await withDirs(async ({ truss }) => {
    for (const [i, body] of [{}, { truss: 'x' }, { truss: null }, { truss: [] }, [], 'str'].entries()) {
      const file = join(truss, `a${i}.json`)
      writeFileSync(file, JSON.stringify(body))
      denied(await expandTrussFile({ trussFile: file }, truss, readFs))
    }
  })
})

test('i29 11: a file holding a plan-kind truss is refused by the gate for stage.js', async () => {
  const { expandTrussFile, workflowCallVerdict } = await load()
  await withDirs(async ({ truss }) => {
    const file = join(truss, 'plan-args.json')
    writeFileSync(file, JSON.stringify({ truss: planTruss() }))
    const r = await expandTrussFile({ trussFile: file }, truss, readFs)
    assert.equal(r.deny, undefined, r.deny)
    denied(gate(workflowCallVerdict, r.args))
  })
})

test('i29 12: without trussFile it returns the args unchanged and never reads', async () => {
  const { expandTrussFile } = await load()
  let reads = 0
  const read = () => {
    reads++
    return ''
  }
  const obj = { truss: stageTruss() }
  const r1 = await expandTrussFile(obj, '/t', read)
  assert.deepEqual(r1, { args: obj })
  const str = JSON.stringify(obj)
  const r2 = await expandTrussFile(str, '/t', read)
  assert.deepEqual(r2, { args: str })
  assert.equal(reads, 0)
})

test('i29 13: the Workflow handler calls expandTrussFile before workflowCallVerdict, passes rewritten args to next, and fails open', () => {
  const raw = readFileSync(REGISTER, 'utf8')
  const code = codeOnly(raw)
  const start = raw.indexOf("on('tool.call', { tool: 'Workflow' }")
  assert.ok(start > 0, 'Workflow handler not found')
  const end = code.indexOf('}).catch(failOpen)', start)
  assert.ok(end > start, 'handler does not end with .catch(failOpen)')
  const h = code.slice(start, end + '}).catch(failOpen)'.length)
  const exp = h.indexOf('expandTrussFile(')
  const ver = h.indexOf('workflowCallVerdict(')
  assert.ok(exp >= 0, 'the handler never calls expandTrussFile')
  assert.ok(ver > exp, 'expandTrussFile must be called before workflowCallVerdict')
  assert.match(h, /next\(\s*\{\s*\.\.\.e\s*,\s*args\b/, 'next is not called with { ...e, args: <expanded> }')
  assert.ok(h.endsWith('.catch(failOpen)'))
})

// ---- skill ----

test('skill 1: the run SKILL.md stage-launch step names workflowArgs, the inline fallback and the live-run risk', () => {
  const text = readFileSync(SKILL, 'utf8')
  const step = text.split('\n').find((l) => l.startsWith('2. Run `Workflow({ scriptPath'))
  assert.ok(step, 'stage-launch step 2 not found')
  assert.ok(step.includes('workflowArgs'), 'step 2 does not name workflowArgs')
  assert.ok(step.includes('args.truss'), 'step 2 does not name the inline args.truss fallback')
  assert.match(step, /ignore/i, 'step 2 does not state the risk that the runtime may ignore the rewritten args')
})

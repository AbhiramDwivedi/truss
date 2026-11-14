// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss 0.32.0, heavy-slots goal item 9 (fold admit and standalone reaps into earlier calls): a member start needs no separate
// admit or reap runner call. The factory call just before the start carries `--admit-first <slug> --admit-label <label> ...`
// and answers with `admittedFirst`; the reap a member leaves due rides on the next call and the crew-end reap on the crew's last
// factory call. The file ends in `.cases.ts` so the default suite does not run it twice: heavy-slots-032.check.ts imports it.
// It drives the whole bundle through loadStageBundle (the bundle-driving exception of the stage-harness rule).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gatesAware } from './fixtures/gates-stub.ts'

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
}

const tick = () => new Promise((r) => setImmediate(r))
const rj = (obj, exit = 0) => ({ exit, stdout: JSON.stringify(obj) })
const HEAD = 'a1'.repeat(20)
const BASE = 'd4'.repeat(20)
const PASS = `VERDICT: PASS\n\n## Proof checked\nHead: ${HEAD}\nPatch: ${'e5'.repeat(20)}\n`
const T1 = { name: 'write-tests', role: 'tester', effort: 'medium', files: ['tests/a.check.ts'], reads: ['src/a.ts'], brief: 'BRIEF-T1: write the tests for a', after: [] }
const B1 = { name: 'build-it', role: 'builder', effort: 'medium', files: ['src/a.ts'], reads: ['tests/a.check.ts'], brief: 'BRIEF-B1: build a', after: ['write-tests'] }
const done = (branch, proof = 'PROOF-' + branch) => ({ task: 'whatever', marker: 'DONE', branch, commit: 'c0'.repeat(20), proof, text: 'finished ' + branch })
const entry = (slug = 'a') => ({
  slug, stage: 1, goalFile: `/proj/.truss/goals/${slug}.md`, goal: 'GOAL-TEXT', owns: ['src/**', 'tests/*.ts'],
  acceptanceTest: 'node --test tests/a.check.ts', highImpact: ['src/core/**'], stressTest: false, scope: 'SCOPE-VERBATIM: build a, nothing else',
  worktree: `/wt/${slug}`, branch: `truss/${slug}`, base: BASE, architecture: '/proj/docs/ARCH.md', adrs: ['/proj/docs/adr/0001-x.md'],
  resume: null, tasks: [], done: [], answers: [], spent: 0, labelFrom: {},
})
const crewLabels = (slug = 'a') => ({
  [`${slug}-planner`]: { tasks: [T1, B1], stop: null }, [`${slug}-tester`]: done('feat/t', 'PROOF-T'), [`${slug}-builder`]: done('feat/b', 'PROOF-B'), [`${slug}-qc`]: PASS,
})

// The first factory.ts command of a runner prompt; a heavy line holds the real command after ` -- `.
function parseRunner(prompt) {
  const line = String(prompt).split('\n').find((l) => /factory\.ts\s/.test(l))
  if (!line) return null
  const m = line.match(/factory\.ts\s+([\w-]+)(.*)$/)
  if (!m) return null
  const cmd = m[1]
  const cut = cmd === 'heavy' ? m[2].indexOf(' -- ') : -1
  const inner = cut >= 0 ? m[2].slice(cut + 4) : null
  const innerCmd = inner ? (inner.match(/factory\.ts\s+([\w-]+)/) || [])[1] : undefined
  const flagsText = cut >= 0 ? m[2].slice(0, cut) : m[2]
  const expectText = inner ? (inner.match(/factory\.ts\s+[\w-]+(.*)$/) || [])[1] || '' : m[2]
  const flag = (text, name) => (text.match(new RegExp(`--${name}[\\s=]+([^\\s\`]+)`)) || [])[1]
  return { line, cmd, innerCmd, real: cmd === 'heavy' ? innerCmd : cmd, label: flag(flagsText, 'label'), expect: flag(expectText, 'expect') }
}

// A runner answer for every factory command: the generic keys the steps read, plus what the command itself needs.
const generic = { ok: true, head: HEAD, admitted: true, reaped: [], merged: true, admittedFirst: { admitted: true } }
function answer(p, over) {
  const body = { ...generic }
  if (p.real === 'check' && p.expect === 'red') delete body.head
  const extra = { tests: [], failures: [], warnings: [], decisions: [], outside: [], parallelism: 4, running: 0, freeMB: 8000, minFreeMB: 2048 }
  const reply = { ...extra, ...body, ...(p.cmd === 'heavy' ? { heavy: { label: p.label, waitedMs: 0, exit: 0 } } : {}), ...over }
  return rj(reply)
}

// Runs the crew through the loaded bundle with a stubbed agent; `onRunner(p, call, calls)` may return a replacement answer.
async function drive(onRunner) {
  const { loadStageBundle } = await import('../bin/build-stage.ts')
  const calls = []
  const unscripted = []
  const labels = crewLabels('a')
  const agent = gatesAware(async (prompt, opts = {}) => {
    const call = { prompt, opts, label: opts.label, i: calls.length }
    calls.push(call)
    await tick()
    if (/-runner(-\d+)?$/.test(String(opts.label))) {
      const p = parseRunner(prompt)
      if (!p) throw new Error(`unparsable runner prompt for label ${opts.label}`)
      call.runner = p
      const out = onRunner ? await onRunner(p, call, calls) : undefined
      await tick()
      return out === undefined ? answer(p) : out
    }
    if (!Object.hasOwn(labels, opts.label)) {
      unscripted.push(String(opts.label))
      throw new Error(`unscripted label: ${opts.label}`)
    }
    await tick()
    return structuredClone(labels[opts.label])
  })
  const parallel = async (thunks) => Promise.all(thunks.map(async (th) => { try { return await (typeof th === 'function' ? th() : th) } catch { return null } }))
  const pipeline = async (items, ...stages) => Promise.all(items.map(async (item, i) => {
    try {
      let prev = item
      for (const s of stages) prev = await s(prev, item, i)
      return prev
    } catch {
      return null
    }
  }))
  const truss = { kind: 'stage', dir: '/proj/.truss', repo: '/proj', plugin: '/plugin', target: 'main', reworkAllowance: 2, roles: ROLES, crews: [entry('a')] }
  const bundle = await loadStageBundle({ agent, parallel, pipeline, phase: () => {}, log: () => {}, args: { truss }, allowance: {} })
  const result = await bundle.scope.runCrew(entry('a'))
  return { result, calls, unscripted }
}

const runnersOf = (calls) => calls.filter((c) => c.runner)

test("a stage crew's member start needs no separate admit or reap runner call", { timeout: 60000 }, async () => {
  const r = await drive()
  assert.deepEqual(r.unscripted, [])
  assert.equal(r.result.state, 'passed', JSON.stringify(r.result))
  const plannerAt = r.calls.findIndex((c) => c.label === 'a-planner')
  assert.ok(plannerAt > 0, 'the planner spawned')
  const red = runnersOf(r.calls).find((c) => c.runner.real === 'check' && c.runner.expect === 'red')
  assert.ok(red, 'a red check ran')
  assert.ok(red.i < plannerAt, 'the red check ran before the planner')
  // the red check is the factory call just before the planner start: it carries the admission
  assert.match(red.runner.line, /--admit-first a(\s|$)/, `the red check carries --admit-first: ${red.runner.line}`)
  assert.match(red.runner.line, /--admit-label a-planner(\s|$)/, red.runner.line)
  assert.ok(red.runner.line.indexOf('--admit-first') < (red.runner.line.indexOf(' -- ') < 0 ? Infinity : red.runner.line.indexOf(' -- ')), 'the flag sits before heavy\'s --')
  // no runner prompt between the red check and the planner spawn is an admit or a reap
  const between = runnersOf(r.calls).filter((c) => c.i > red.i && c.i < plannerAt)
  assert.deepEqual(between.map((c) => c.runner.real), [], 'no runner call between the red check and the planner')
  assert.deepEqual(runnersOf(r.calls).filter((c) => c.i < plannerAt && /^(admit|reap)$/.test(c.runner.cmd)).map((c) => c.runner.line), [], 'no admit or reap before the planner')
  // the crew run makes no standalone reap call: the reap rides on a later factory call
  const reaps = runnersOf(r.calls).filter((c) => c.runner.cmd === 'reap')
  assert.deepEqual(reaps.map((c) => c.runner.line), [], 'no standalone reap call')

  // an admittedFirst held answer on the red check stops the crew before the planner spawns
  const held = await drive((p) => (p.real === 'check' && p.expect === 'red' ? rj({ ok: true, admittedFirst: { admitted: false, why: 'x' } }) : undefined))
  assert.equal(held.result.state, 'stopped', JSON.stringify(held.result))
  assert.equal(held.result.tag, 'BLOCKED')
  assert.match(held.result.text, /^held by admission:/, held.result.text)
  assert.ok(!held.calls.some((c) => c.label === 'a-planner'), 'the planner did not spawn')
})

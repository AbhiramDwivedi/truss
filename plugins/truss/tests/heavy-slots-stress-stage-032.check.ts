// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// 0.32.0 heavy-slots stress finding, defect 3: a memory hold on the folded admit (`--admit-first` on the red check) must get its own
// `admit --wait-ms 90000` re-check (ADR-0046 item 1), not stop the crew at once. It drives the bundle through loadStageBundle.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gatesAware } from './fixtures/gates-stub.ts'
import { loadStageBundle } from '../bin/build-stage.ts'

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
const T1 = { name: 'write-tests', role: 'tester', effort: 'medium', files: ['tests/a.check.ts'], reads: ['src/a.ts'], brief: 'BRIEF-T1', after: [] }
const B1 = { name: 'build-it', role: 'builder', effort: 'medium', files: ['src/a.ts'], reads: ['tests/a.check.ts'], brief: 'BRIEF-B1', after: ['write-tests'] }
const done = (branch) => ({ task: 'whatever', marker: 'DONE', branch, commit: 'c0'.repeat(20), proof: 'PROOF-' + branch, text: 'finished ' + branch })
const entry = (slug = 'a') => ({
  slug, stage: 1, goalFile: `/proj/.truss/goals/${slug}.md`, goal: 'GOAL-TEXT', owns: ['src/**', 'tests/*.ts'],
  acceptanceTest: 'node --test tests/a.check.ts', highImpact: ['src/core/**'], stressTest: false, scope: 'SCOPE-VERBATIM',
  worktree: `/wt/${slug}`, branch: `truss/${slug}`, base: BASE, architecture: '/proj/docs/ARCH.md', adrs: ['/proj/docs/adr/0001-x.md'],
  resume: null, tasks: [], done: [], answers: [], spent: 0, labelFrom: {},
})
const labels = { 'a-planner': { tasks: [T1, B1], stop: null }, 'a-tester': done('feat/t'), 'a-builder': done('feat/b'), 'a-qc': PASS }

function parseRunner(prompt) {
  const line = String(prompt).split('\n').find((l) => /factory\.ts\s/.test(l))
  if (!line) return null
  const m = line.match(/factory\.ts\s+([\w-]+)(.*)$/)
  if (!m) return null
  const cut = m[1] === 'heavy' ? m[2].indexOf(' -- ') : -1
  const inner = cut >= 0 ? m[2].slice(cut + 4) : null
  const innerCmd = inner ? (inner.match(/factory\.ts\s+([\w-]+)/) || [])[1] : undefined
  const expectText = inner ? (inner.match(/factory\.ts\s+[\w-]+(.*)$/) || [])[1] || '' : m[2]
  const expect = (expectText.match(/--expect[\s=]+([^\s`]+)/) || [])[1]
  return { line, cmd: m[1], real: m[1] === 'heavy' ? innerCmd : m[1], expect }
}
const generic = { ok: true, head: HEAD, admitted: true, reaped: [], merged: true, admittedFirst: { admitted: true } }

async function drive(onRunner) {
  const calls = []
  const agent = gatesAware(async (prompt, opts = {}) => {
    const call = { prompt, opts, label: opts.label, i: calls.length }
    calls.push(call)
    await tick()
    if (/-runner(-\d+)?$/.test(String(opts.label))) {
      const p = parseRunner(prompt)
      if (!p) throw new Error(`unparsable runner prompt for label ${opts.label}`)
      call.runner = p
      const out = onRunner ? onRunner(p) : undefined
      if (out !== undefined) return out
      const body = { ...generic }
      if (p.real === 'check' && p.expect === 'red') delete body.head
      return rj({ tests: [], failures: [], warnings: [], decisions: [], outside: [], parallelism: 4, running: 0, freeMB: 8000, minFreeMB: 2048, ...body })
    }
    if (!Object.hasOwn(labels, opts.label)) throw new Error(`unscripted label: ${opts.label}`)
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
  return { result, calls }
}

test('heavy stress 3: a memory hold on the folded admit gets its own admit --wait-ms 90000 re-check', { timeout: 60000 }, async () => {
  let admitCalls = 0
  const r = await drive((p) => {
    if (p.real === 'check' && p.expect === 'red') {
      return rj({ ok: true, admittedFirst: { admitted: false, parallelism: 4, running: 0, freeMB: 1500, minFreeMB: 2048, why: 'free memory 1500 MB is below 2048 MB' } })
    }
    if (p.cmd === 'admit') {
      admitCalls++
      return rj({ admitted: true, reaped: [], parallelism: 4, running: 0, freeMB: 8000, minFreeMB: 2048 })
    }
    return undefined
  })
  const admits = r.calls.filter((c) => c.runner && c.runner.cmd === 'admit').map((c) => c.runner.line)
  assert.ok(admitCalls > 0 && admits.some((l) => /--wait-ms\s+90000/.test(l)), `a memory hold re-checks with admit --wait-ms 90000, got ${JSON.stringify(admits)}; crew ${r.result.state} ${r.result.text}`)
  assert.ok(r.calls.some((c) => c.label === 'a-planner'), `the planner spawned once the re-check admitted: ${r.result.state} ${r.result.text}`)
})

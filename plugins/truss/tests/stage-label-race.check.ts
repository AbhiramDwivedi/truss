// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// Race in stage.js ask(): parallel members of one role peeked the same label before either advanced the counter, so the
// admission title event (label, --persona, --high) landed on one label while the member ran under another (run wf_4edc7165-fb0).
// Run with: node --test tests/stage-label-race.check.ts

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { gatesAware } from './fixtures/gates-stub.ts'
import { fileURLToPath } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')
const PATHS = { 'stage.js': `${PLUGIN}/workflows/stage.js` }
const t = (name, fn) => test(name, { timeout: 90000 }, fn)

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
  ux: { agentType: 'truss:ux-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
}

// ---------------------------------------------------------------- stage.js harness (from tests/personas-routing.check.ts)

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const tick = () => new Promise((r) => setImmediate(r))
const ticks = async (n) => {
  for (let i = 0; i < n; i++) await tick()
}
const rj = (obj, exit = 0) => ({ exit, stdout: JSON.stringify(obj) })

async function exec(file, args, o = {}) {
  const body = readFileSync(PATHS[file], 'utf8').replace(/^\s*export\s+const\s+meta\b/m, 'const meta')
  const calls = []
  const unscripted = []
  const counters = {}
  const agent = gatesAware(async (prompt, opts = {}) => {
    const call = { prompt, opts, label: opts.label, i: calls.length }
    calls.push(call)
    await tick()
    if (/-runner(-\d+)?$/.test(String(opts.label))) {
      const m = prompt.match(/factory\.ts\s+(admit|reap|check|integrate|owns-check|tests-check|sync|decision-checkpoint|crew-learned|knowledge-commit|knowledge-lint|decision-ack|decisions)\b([^\n`]*)/)
      if (!m) {
        unscripted.push(`${opts.label} (no factory.ts command in prompt)`)
        throw new Error(`unparsable runner prompt for label ${opts.label}`)
      }
      const cmd = m[1]
      const flag = (name) => (m[2].match(new RegExp(`--${name}\\s+([^\\s\`]+)`)) || [])[1]
      const slug = flag('slug')
      const expect = flag('expect')
      const branch = flag('branch')
      const key = cmd === 'check' ? `check:${expect}` : cmd === 'integrate' ? `integrate:${branch}` : cmd
      const name = `runner:${slug}:${key}`
      call.runner = { cmd, slug, expect, branch, key, name }
      const n = (counters[name] = (counters[name] ?? -1) + 1)
      let out = o.runner ? await o.runner({ cmd, key, slug, expect, branch, n, prompt, call }) : undefined
      if (out === undefined) {
        const plain = expect === 'red' ? { ok: true } : { ok: true, head: HEAD }
        out =
          cmd === 'admit' ? rj({ admitted: true, parallelism: 4, running: 0, freeMB: 8000, minFreeMB: 2048 }) : cmd === 'reap' ? rj({ reaped: [], skipped: [] }) : cmd === 'check' ? rj(plain) : cmd === 'integrate' ? rj({ merged: true }) : cmd === 'owns-check' ? rj({ ok: true, outside: [] }) : cmd === 'tests-check' ? rj({ ok: true, tests: [] }) : rj({ merged: true })
      }
      await ticks(cmd === 'integrate' ? 3 : 1)
      return out
    }
    const labels = o.labels ?? {}
    if (!Object.hasOwn(labels, opts.label)) {
      unscripted.push(String(opts.label))
      throw new Error(`unscripted label: ${opts.label}`)
    }
    const h = labels[opts.label]
    const v = typeof h === 'function' ? await h(call, calls) : h
    await ticks(2)
    return v === null || v === undefined ? v : structuredClone(v)
  })
  const parallel = async (thunks) => Promise.all(thunks.map(async (th) => { try { return await (typeof th === 'function' ? th() : th) } catch { return null } }))
  const pipeline = async (items, ...stages) =>
    Promise.all(items.map(async (item, i) => {
      try {
        let prev = item
        for (const st of stages) prev = await st(prev, item, i)
        return prev
      } catch {
        return null
      }
    }))
  let result
  let error
  try {
    result = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'allowance', body)(agent, parallel, pipeline, () => {}, () => {}, structuredClone(args), {})
  } catch (e) {
    error = e
  }
  return { result, error, calls, unscripted, labels: calls.map((c) => c.label) }
}

const HEAD = 'a1'.repeat(20)
const BASE = 'd4'.repeat(20)
const PATCH = 'e5'.repeat(20)
const PASS = `VERDICT: PASS\n\n## Proof checked\nHead: ${HEAD}\nPatch: ${PATCH}\n`
const done = (branch) => ({ task: 'whatever', marker: 'DONE', branch, commit: 'c0'.repeat(20), proof: 'PROOF-' + branch, text: 'finished ' + branch })
const T1 = { name: 'acceptance-tests', role: 'builder', effort: 'high', persona: null, files: ['tests/a.check.ts'], reads: [], brief: 'BRIEF-1', after: [] }
const T2 = { name: 'other-work', role: 'builder', effort: 'low', persona: null, files: ['src/b.ts'], reads: [], brief: 'BRIEF-2', after: [] }
const OLD = {
  slug: 'a', stage: 1, goalFile: '/proj/.truss/goals/a.md', goal: 'GOAL-TEXT', owns: ['src/**', 'tests/*.ts'],
  acceptanceTest: 'node --test tests/a.check.ts', highImpact: ['src/core/**'], stressTest: false, scope: 'SCOPE-VERBATIM: build a, nothing else',
  worktree: '/wt/a', branch: 'truss/a', base: BASE, architecture: '/proj/docs/ARCH.md', adrs: [],
  resume: null, tasks: [], done: [], answers: [], spent: 0, labelFrom: {},
}

t('label race: parallel same-role members are admitted and spawned under the same labels, and --high rides the high member', async () => {
  // the admit takes a few ticks, so both members reach it before either spawns
  const runner = async ({ cmd }) => {
    if (cmd === 'admit') await ticks(5)
    return undefined
  }
  const labels = { 'a-planner': { tasks: [T1, T2], stop: null }, 'a-builder': done('feat/1'), 'a-builder-2': done('feat/2'), 'a-builder-3': done('feat/3'), 'a-qc': PASS }
  const args = { truss: { kind: 'stage', dir: '/proj/.truss', repo: '/proj', plugin: PLUGIN, target: 'main', reworkAllowance: 2, roles: ROLES, scriptPath: PATHS['stage.js'], crews: [OLD] } }
  const r = await exec('stage.js', args, { runner, labels })
  if (r.error) throw r.error
  const admits = r.calls
    .filter((c) => c.runner?.cmd === 'admit' && c.prompt.includes('--label'))
    .map((c) => ({ label: (c.prompt.match(/--label\s+(\S+)/) || [])[1].replace(/['"`]/g, ''), high: /\s--high\b/.test(c.prompt) }))
    .filter((x) => /-builder/.test(x.label))
  const spawns = r.calls.filter((c) => !c.runner && /^a-builder/.test(c.label))
  assert.deepEqual(admits.map((x) => x.label).sort(), spawns.map((c) => c.label).sort(), `admit labels vs spawn labels; ${JSON.stringify(admits)}`)
  const highSpawn = spawns.find((c) => c.prompt.includes('Task: acceptance-tests\n'))
  assert.equal(highSpawn.opts.effort, 'high')
  const highAdmits = admits.filter((x) => x.high)
  assert.equal(highAdmits.length, 1, JSON.stringify(admits))
  assert.equal(highAdmits[0].label, highSpawn.label, 'the --high title is on the label of the member spawned at effort high')
})

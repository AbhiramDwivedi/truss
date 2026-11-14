// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss 0.32.0 bug K: a PM ruling at qc with "role": "tester" orders a test change a builder may not make. rulingStep sends it to a
// tester fix member first (its branch integrated), then sends the other rulings to the fix builder. Same stubbed crew as ruling-031.check.ts.
//
// Run with: node --test plugins/truss/tests/ruling-tester-qc-032.check.ts

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { gatesAware } from './fixtures/gates-stub.ts'
import { REAL_PLUGIN } from './fixtures/workflow-run/harness.ts'

const t = (name, fn) => test(name, { timeout: 60000 }, fn)

const STAGE = `${REAL_PLUGIN}/workflows/stage.js`
const ROLES = {
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
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const tick = () => new Promise((r) => setImmediate(r))
const rj = (obj) => ({ exit: 0, stdout: JSON.stringify(obj) })
const HEAD0 = 'a0'.repeat(20)
const HEAD1 = 'b1'.repeat(20)
const PATCH = 'e5'.repeat(20)
const pass = (head) => `VERDICT: PASS\n\n## Proof checked\nHead: ${head}\nPatch: ${PATCH}\n`
const done = (branch) => ({ task: 'whatever', marker: 'DONE', branch, commit: 'c0'.repeat(20), proof: 'PROOF-' + branch, text: 'finished ' + branch })
const TT = { name: 'write-tests', role: 'tester', effort: 'medium', files: ['tests/a.check.ts'], after: [] }
const TB = { name: 'build-it', role: 'builder', effort: 'low', files: ['src/a.ts'], after: ['write-tests'] }
const TESTER_RULING = 'PM ruling: update the test cases in tests/a.check.ts to expect the new shape.'
const BUILDER_RULING = 'PM ruling: add the Amended line to docs/adr/0009.md.'
const entryOf = (o = {}) => ({
  slug: 'a', stage: 1, goalFile: '/proj/.truss/goals/a.md', goal: 'GOAL', owns: ['src/**', 'tests/*.ts', 'docs/**'], acceptanceTest: 'node --test tests/a.check.ts',
  highImpact: [], stressTest: false, scope: 'SCOPE', worktree: '/wt/a', branch: 'truss-a', base: 'd4'.repeat(20), architecture: '/proj/docs/ARCH.md', adrs: [],
  resume: 'answers', tasks: [TT, TB], done: ['write-tests', 'build-it'], answers: [], prior: [], spent: 0, labelFrom: {}, ...o,
})

async function runCrew(e, labels) {
  const body = readFileSync(STAGE, 'utf8').replace(/^\s*export\s+const\s+meta\b/m, 'const meta')
  const calls = []
  const unscripted = []
  let head = HEAD0
  const agent = gatesAware(async (prompt, opts = {}) => {
    const call = { prompt, opts, label: opts.label }
    calls.push(call)
    await tick()
    if (/-runner(-\d+)?$/.test(String(opts.label))) {
      const m = prompt.match(/factory\.ts\s+(admit|reap|check|integrate|owns-check|tests-check|sync|crew-decision|decision-replies|decision-ack|decision-checkpoint|crew-learned|knowledge-commit|knowledge-lint|decisions|escalate|inbox|resolve)\b([^\n]*)/)
      if (!m) throw new Error(`unparsable runner prompt for label ${opts.label}`)
      const cmd = m[1]
      const flag = (name) => (m[2].match(new RegExp(`--${name}(?:\\s+|=)'?([^\\s\`']+)`)) || [])[1]
      const expect = flag('expect')
      const branch = flag('branch')
      call.key = cmd === 'check' ? `check:${expect}` : cmd === 'integrate' ? `integrate:${branch}` : cmd
      if (cmd === 'integrate') {
        head = HEAD1
        return rj({ merged: true, head })
      }
      if (cmd === 'check') return rj(expect === 'red' ? { ok: true } : { ok: true, head })
      if (cmd === 'admit') return rj({ admitted: true, parallelism: 4, running: 0, freeMB: 8000, minFreeMB: 2048 })
      if (cmd === 'reap') return rj({ reaped: [], skipped: [] })
      if (cmd === 'owns-check') return rj({ ok: true, outside: [] })
      if (cmd === 'tests-check') return rj({ ok: true, tests: [] })
      if (cmd === 'decision-replies') return rj([])
      if (cmd === 'decision-ack') return rj({ acked: [], already: [] })
      if (cmd === 'decisions') return rj({ decisions: [] })
      if (cmd === 'inbox') return rj({ items: [], open: 0 })
      if (cmd === 'sync') return rj({ merged: true, head })
      return rj({ ok: true, merged: true })
    }
    if (!Object.hasOwn(labels, opts.label)) {
      unscripted.push(String(opts.label))
      throw new Error(`unscripted label: ${opts.label}`)
    }
    const h = labels[opts.label]
    const v = typeof h === 'function' ? h(call, head) : h
    return v === null || v === undefined ? v : structuredClone(v)
  })
  const parallel = async (thunks) => Promise.all(thunks.map(async (th) => { try { return await (typeof th === 'function' ? th() : th) } catch { return null } }))
  const pipeline = async (items, ...stages) => Promise.all(items.map(async (item, i) => { try { let p = item; for (const st of stages) p = await st(p, item, i); return p } catch { return null } }))
  const args = { truss: { kind: 'stage', dir: '/proj/.truss', repo: '/proj', plugin: REAL_PLUGIN, target: 'main', reworkAllowance: 2, roles: ROLES, scriptPath: STAGE, crews: [e] } }
  const result = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'allowance', body)(agent, parallel, pipeline, () => {}, () => {}, structuredClone(args), {})
  assert.deepEqual(unscripted, [], `unscripted: ${unscripted.join(', ')}`)
  return { result: result[0], calls }
}
const at = (r, pred) => r.calls.findIndex(pred)
const keyIs = (k) => (c) => c.key === k
const labelIs = (l) => (c) => c.label === l
const trail = (r) => r.calls.map((c) => c.key ?? c.label).filter((k) => !['admit', 'reap', 'decisions', 'inbox'].includes(k)).join(' > ')
const tail = { 'a-writer': done('feat/k'), 'a-qc': (call) => pass(/^Head: (\S+)/m.exec(call.prompt)[1]) }

t('a tester ruling at qc goes to a tester fix member, not the builder', async () => {
  const r = await runCrew(entryOf({ answers: [{ at: 'qc', text: TESTER_RULING, role: 'tester' }], freshAnswers: 1 }), { 'a-tester': done('feat/t'), ...tail })
  const tester = at(r, labelIs('a-tester'))
  assert.ok(tester >= 0, `a tester fix member ran; trail ${trail(r)}`)
  assert.equal(r.calls.filter(labelIs('a-builder')).length, 0, 'no builder ran')
  const p = r.calls[tester].prompt
  assert.ok(p.includes(TESTER_RULING), 'the tester is given the ruling')
  assert.match(p, /Task: fix, the program manager ruling at qc/, 'it is a fix member for the qc ruling')
  const merged = at(r, keyIs('integrate:feat/t'))
  const green = at(r, keyIs('check:green'))
  assert.ok(merged > tester, `its branch is integrated; trail ${trail(r)}`)
  assert.ok(green > merged, `green runs after the merge; trail ${trail(r)}`)
  assert.equal(r.result.state, 'passed', JSON.stringify(r.result).slice(0, 400))
})

t('a builder ruling at qc still goes to the fix builder', async () => {
  const r = await runCrew(entryOf({ answers: [{ at: 'qc', text: BUILDER_RULING }], freshAnswers: 1 }), { 'a-builder': done('feat/b'), ...tail })
  const builder = at(r, labelIs('a-builder'))
  assert.ok(builder >= 0, `a fix builder ran; trail ${trail(r)}`)
  assert.equal(r.calls.filter(labelIs('a-tester')).length, 0, 'no tester ran')
  assert.ok(r.calls[builder].prompt.includes(BUILDER_RULING), 'the builder is given the ruling')
  assert.ok(at(r, keyIs('integrate:feat/b')) > builder, 'its branch is integrated')
  assert.equal(r.result.state, 'passed', JSON.stringify(r.result).slice(0, 400))
})

t('a tester and a builder ruling at qc spawn the tester first, then the builder', async () => {
  const answers = [{ at: 'qc', text: BUILDER_RULING }, { at: 'qc', text: TESTER_RULING, role: 'tester' }]
  const r = await runCrew(entryOf({ answers, freshAnswers: 2 }), { 'a-tester': done('feat/t'), 'a-builder': done('feat/b'), ...tail })
  const tester = at(r, labelIs('a-tester'))
  const mergedT = at(r, keyIs('integrate:feat/t'))
  const builder = at(r, labelIs('a-builder'))
  assert.ok(tester >= 0 && builder >= 0, `both ran; trail ${trail(r)}`)
  assert.ok(tester < mergedT && mergedT < builder, `tester, its merge, then builder; trail ${trail(r)}`)
  const fixPart = (p) => p.split('Fix this, and only this:')[1].split('\n\n')[0]
  const tp = fixPart(r.calls[tester].prompt)
  const bp = fixPart(r.calls[builder].prompt)
  assert.ok(tp.includes(TESTER_RULING) && !tp.includes(BUILDER_RULING), 'the tester fix section carries only the tester ruling')
  assert.ok(bp.includes(BUILDER_RULING) && !bp.includes(TESTER_RULING), 'the builder fix section carries only the builder ruling')
  assert.equal(r.result.state, 'passed', JSON.stringify(r.result).slice(0, 400))
})

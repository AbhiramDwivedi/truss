// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss 0.32.0: a resume ruling that changes tests routes to a test-writer before the stopped task reruns. An answer entry may carry
// "role": "tester"; stage.js then runs a tester member with the answer, integrates it, and only then reruns the stopped task.
// The stage.js cases run stage.js on a stubbed crew (the ruling-031.check.ts harness); the factory cases run the real CLI.
//
// Run with: node --test plugins/truss/tests/ruling-tester-032.check.ts

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { gatesAware } from './fixtures/gates-stub.ts'
import { REAL_PLUGIN, addCrewWorktree, appendEvent, crew, factorySpawn, git, mkEnv, mkRun, planObj, putFile, tmp, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

const t = (name, fn) => test(name, { timeout: 60000 }, fn)

// ---------------------------------------------------------------- stubbed stage.js crew

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
const TB = { name: 'cli-findings', role: 'builder', effort: 'low', files: ['src/a.ts'], after: ['write-tests'] }
const RULING = 'PM ruling: the test-writer updates six test cases in tests/a.check.ts to expect the new shape.'
const entryOf = (o = {}) => ({
  slug: 'a', stage: 1, goalFile: '/proj/.truss/goals/a.md', goal: 'GOAL', owns: ['src/**', 'tests/*.ts', 'docs/**'], acceptanceTest: 'node --test tests/a.check.ts',
  highImpact: [], stressTest: false, scope: 'SCOPE', worktree: '/wt/a', branch: 'truss-a', base: 'd4'.repeat(20), architecture: '/proj/docs/ARCH.md', adrs: [],
  resume: 'answers', tasks: [TT, TB], done: ['write-tests'], answers: [], prior: [], spent: 0, labelFrom: {}, ...o,
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

t('a role-tester answer at a builder task runs a test-writer with the answer, integrates it, then reruns the builder with the answer and a tests-updated note', async () => {
  const r = await runCrew(entryOf({ answers: [{ at: 'cli-findings', text: RULING, role: 'tester' }], freshAnswers: 1 }), { 'a-tester': done('feat/t'), 'a-builder': done('feat/b'), ...tail })
  const tester = at(r, labelIs('a-tester'))
  const builder = at(r, labelIs('a-builder'))
  assert.ok(tester >= 0, `a tester member ran; trail ${trail(r)}`)
  assert.ok(builder > tester, `the builder reruns after the tester; trail ${trail(r)}`)
  const tp = r.calls[tester].prompt
  assert.ok(tp.includes(RULING), 'the tester brief carries the answer text')
  assert.ok(tp.includes('tests/a.check.ts'), 'the tester brief names the crew\'s test files')
  assert.match(tp, /Truss-Role: test-writer/, 'it commits as the test-writer')
  const merged = at(r, keyIs('integrate:feat/t'))
  assert.ok(merged > tester && merged < builder, `the tester branch is integrated before the builder starts; trail ${trail(r)}`)
  const bp = r.calls[builder].prompt
  assert.ok(bp.includes(RULING), 'the rerun builder still gets the answer')
  assert.match(bp, /tests (?:are|have been) updated/i, 'the rerun builder is told the tests are updated')
  assert.equal(r.calls.filter(labelIs('a-tester')).length, 1, 'one tester member only')
  assert.equal(r.result.state, 'passed', JSON.stringify(r.result).slice(0, 400))
})

t('an answer without a role spawns no tester and the builder reruns as before', async () => {
  const r = await runCrew(entryOf({ answers: [{ at: 'cli-findings', text: RULING }], freshAnswers: 1 }), { 'a-builder': done('feat/b'), ...tail })
  assert.equal(r.calls.filter(labelIs('a-tester')).length, 0, `no tester; trail ${trail(r)}`)
  const bp = r.calls[at(r, labelIs('a-builder'))].prompt
  assert.ok(bp.includes(RULING))
  assert.doesNotMatch(bp, /tests (?:are|have been) updated/i)
  assert.equal(r.result.state, 'passed')
})

t('a role-tester answer carried from the store (not fresh) spawns no second tester', async () => {
  const r = await runCrew(entryOf({ answers: [{ at: 'green', text: 'retry' }, { at: 'cli-findings', text: RULING, role: 'tester' }], freshAnswers: 1 }), { 'a-builder': done('feat/b'), ...tail })
  assert.equal(r.calls.filter(labelIs('a-tester')).length, 0, `no tester; trail ${trail(r)}`)
})

// ---------------------------------------------------------------- factory start: role

const HOUR = 3_600_000
const MIN = 60_000
const iso = (ms) => new Date(ms).toISOString()
const say = (r) => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 600)}; stderr ${String(r.stderr).slice(0, 300)}`
const PLANNER = { tasks: [{ name: 't1', role: 'builder', effort: 'medium', persona: null, files: ['members/**'], reads: [], brief: 'b', after: [] }], stop: null }

function resumeEnv() {
  const env = mkEnv({ config: { merge: 'sequential', target: 'main' } })
  writePlan(env.dir, planObj([crew('x', { status: 'running' })], { approvedAt: iso(Date.now() - 3 * HOUR) }))
  writeGoal(env.dir, 'x')
  const wt = addCrewWorktree(env.repo, 'x')
  appendEvent(env.dir, factorySpawn('x', iso(Date.now() - 3 * HOUR)))
  mkdirSync(join(env.dir, 'checks'), { recursive: true })
  writeFileSync(join(env.dir, 'checks', 'x-1.json'), JSON.stringify({ command: 'false', exit: 1, head: 'abc', tail: '' }))
  git(wt, ['checkout', '-q', '-b', 'member-a'])
  putFile(wt, 'members/member-a.txt', 'member-a\n', 'member member-a')
  git(wt, ['checkout', '-q', 'truss-x'])
  git(wt, ['merge', '-q', '--no-ff', '-m', 'merge member-a', 'member-a'])
  const endMs = Date.now() - 10 * MIN
  const agents = [{ label: 'x-planner', result: PLANNER }, { label: 'x-builder', result: { task: 't1', marker: 'DONE', branch: 'member-a', commit: 'c0ffee', proof: 'ran it', text: 'ok' } }]
  const run = mkRun(env.transcripts, 'wf_r1', agents.map((a) => ({ startTs: iso(endMs - MIN), endTs: iso(endMs), agentType: 'general-purpose', metaModel: 'sonnet', model: 'claude-sonnet-5-5', effort: 'medium', ...a })), { journalMtimeMs: endMs })
  const resume = (answers) => {
    const p = join(tmp('r032-ans-'), 'answers.json')
    writeFileSync(p, JSON.stringify(answers))
    return env.run('start', { slug: 'x', resume: 'answers', transcript: run.dir, answers: p })
  }
  return { resume, dir: env.dir }
}

t('start --resume answers keeps an answer\'s role tester in the entry and in answers.json', () => {
  const { resume, dir } = resumeEnv()
  const r = resume([{ at: 't1', text: 'update the tests', role: 'tester' }, { at: 'qc', text: 'plain' }])
  assert.equal(r.status, 0, say(r))
  const e = r.json.truss.crews[0]
  assert.equal(e.answers[0].role, 'tester')
  assert.equal(e.answers[1].role, undefined)
  const store = JSON.parse(readFileSync(join(dir, 'crews', 'x', 'answers.json'), 'utf8'))
  assert.equal(store.find((a) => a.at === 't1').role, 'tester')
  assert.equal(store.find((a) => a.at === 'qc').role, undefined)
})

t('start --resume answers refuses a role other than tester', () => {
  const { resume } = resumeEnv()
  const r = resume([{ at: 't1', text: 'x', role: 'builder' }])
  assert.notEqual(r.status, 0, say(r))
  assert.match(`${r.stdout}${r.stderr}`, /role/)
  assert.match(`${r.stdout}${r.stderr}`, /tester/)
})

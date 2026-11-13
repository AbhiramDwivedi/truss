// @ts-nocheck
// truss 0.31.0 item 6 (goals/0.31.0-speed.md): a PM ruling at QC is built on resume, and an earlier fix member's stopped branch is
// never dropped. Before the fix, an answers resume whose saved tasks were all done ran no member before green: the ruling reached
// no builder until the next QC FAILed, and a fix member's commits from before a PROPOSAL stop stayed unmerged.
// The stage.js cases run stage.js on a stubbed crew (the pm-calls-029.check.ts harness); the factory case runs the real CLI.
//
// Run with: node --test plugins/truss/tests/ruling-031.check.ts

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
const TB = { name: 'build-it', role: 'builder', effort: 'low', files: ['src/a.ts'], after: ['write-tests'] }
const RULING = 'PM ruling (decisions.md 07:57): PROPOSAL approved. Add the Amended line to docs/adr/0009.md and cherry-pick 1ecf397.'
const entryOf = (o = {}) => ({
  slug: 'a', stage: 1, goalFile: '/proj/.truss/goals/a.md', goal: 'GOAL', owns: ['src/**', 'tests/*.ts', 'docs/**'], acceptanceTest: 'node --test tests/a.check.ts',
  highImpact: [], stressTest: false, scope: 'SCOPE', worktree: '/wt/a', branch: 'truss-a', base: 'd4'.repeat(20), architecture: '/proj/docs/ARCH.md', adrs: [],
  resume: 'answers', tasks: [TT, TB], done: ['write-tests', 'build-it'], answers: [], prior: [], spent: 0, labelFrom: {}, ...o,
})

/** Runs stage.js for one crew. The head moves once anything is integrated; the green check reports the current head.
 *  `integrateOut(branch)` may override the integrate reply. Returns the calls in order (runner calls carry `key`). */
async function runCrew(e, labels, o = {}) {
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
        const out = o.integrateOut ? o.integrateOut(branch) : undefined
        if (out) return rj(out)
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
// the knowledge writer and QC: QC rules PASS on whatever head its prompt names
const tail = { 'a-writer': done('feat/k'), 'a-qc': (call) => pass(/^Head: (\S+)/m.exec(call.prompt)[1]) }

t('a new ruling at qc on an answers resume with every task done spawns a fix builder before green, and QC sees its merge', async () => {
  const r = await runCrew(entryOf({ answers: [{ at: 'qc', text: RULING }], freshAnswers: 1 }), { 'a-builder': done('feat/ruling'), ...tail })
  const fix = at(r, labelIs('a-builder'))
  assert.ok(fix >= 0, `a fix builder ran for the ruling; trail ${trail(r)}`)
  const p = r.calls[fix].prompt
  assert.ok(p.includes(RULING), 'the fix builder is given the ruling')
  assert.match(p, /Task: fix, /, 'it is a fix member (its Task line names the fix)')
  const merged = at(r, keyIs('integrate:feat/ruling'))
  const green = at(r, keyIs('check:green'))
  const qc = at(r, labelIs('a-qc'))
  assert.ok(merged > fix, `its branch is integrated; trail ${trail(r)}`)
  assert.ok(green > merged, `green runs after the merge; trail ${trail(r)}`)
  assert.ok(qc > green, `QC runs after green; trail ${trail(r)}`)
  assert.match(r.calls[qc].prompt, new RegExp(`^Head: ${HEAD1}$`, 'm'), 'QC rules on the head that holds the fix')
  assert.equal(r.result.state, 'passed', JSON.stringify(r.result).slice(0, 400))
})

t('a ruling at qc on a resume that re-runs a task goes to that member, not to an extra fix builder', async () => {
  const r = await runCrew(entryOf({ answers: [{ at: 'qc', text: RULING }], freshAnswers: 1, done: ['write-tests'] }), { 'a-builder': done('feat/b'), ...tail })
  assert.equal(r.calls.filter(labelIs('a-builder')).length, 1, `one builder: the task's; trail ${trail(r)}`)
  assert.ok(r.calls[at(r, labelIs('a-builder'))].prompt.includes(RULING), 'the task member gets the ruling')
  assert.equal(r.result.state, 'passed')
})

t('a carried ruling at qc (built by an earlier run) spawns no fix builder; a new ruling at green alone spawns none either', async () => {
  // freshAnswers 1: only the green retry is new; the qc ruling rides along from the store. No a-builder label is scripted.
  const r = await runCrew(entryOf({ answers: [{ at: 'green', text: 'retry the green check unchanged' }, { at: 'qc', text: RULING }], freshAnswers: 1 }), tail)
  assert.equal(r.result.state, 'passed', JSON.stringify(r.result).slice(0, 400))
  assert.equal(at(r, labelIs('a-builder')), -1)
})

t('a new waive-and-proceed ruling at qc orders no change and spawns no fix builder', async () => {
  for (const text of ['PM ruling: waive the doc-line finding and proceed to merge.', 'Retry QC; no changes are needed.']) {
    const r = await runCrew(entryOf({ answers: [{ at: 'qc', text }], freshAnswers: 1 }), tail)
    assert.equal(at(r, labelIs('a-builder')), -1, `${text}: ${trail(r)}`)
    assert.equal(r.result.state, 'passed', JSON.stringify(r.result).slice(0, 400))
  }
})

t('an earlier fix member\'s stopped branch (entry.prior) is merged before green, even when no fix member runs', async () => {
  const e = entryOf({ answers: [{ at: 'green', text: 'retry the green check unchanged' }], freshAnswers: 1, prior: [{ at: 'fix, QC findings', branch: 'feat/builder-12' }] })
  const r = await runCrew(e, tail)
  const merged = at(r, keyIs('integrate:feat/builder-12'))
  assert.ok(merged >= 0, `the stopped fix member's branch is integrated; trail ${trail(r)}`)
  assert.ok(merged < at(r, keyIs('check:green')), `before green; trail ${trail(r)}`)
  assert.match(r.calls[at(r, labelIs('a-qc'))].prompt, new RegExp(`^Head: ${HEAD1}$`, 'm'), 'QC sees the head with those commits')
  assert.equal(r.result.state, 'passed')
})

t('with a ruling at qc too, the stopped fix branch is merged first and the ruling builder forks from a crew branch that has it', async () => {
  const e = entryOf({ answers: [{ at: 'qc', text: RULING }], freshAnswers: 1, prior: [{ at: 'fix, QC findings', branch: 'feat/builder-12' }] })
  const r = await runCrew(e, { 'a-builder': done('feat/ruling'), ...tail })
  const old = at(r, keyIs('integrate:feat/builder-12'))
  const fix = at(r, labelIs('a-builder'))
  assert.ok(old >= 0 && fix > old, `prior branch merged before the ruling builder; trail ${trail(r)}`)
  assert.ok(at(r, keyIs('integrate:feat/ruling')) > fix)
  assert.equal(r.result.state, 'passed')
})

t('a stopped fix branch that does not merge stops the crew and names the branch', async () => {
  const e = entryOf({ answers: [{ at: 'green', text: 'retry' }], freshAnswers: 1, prior: [{ at: 'fix, QC findings', branch: 'feat/builder-12' }] })
  const r = await runCrew(e, tail, { integrateOut: (b) => (b === 'feat/builder-12' ? { merged: false, conflicts: [], why: 'unreadable commit range' } : undefined) })
  assert.equal(r.result.state, 'stopped', JSON.stringify(r.result).slice(0, 400))
  assert.ok(r.result.text.includes('feat/builder-12'), r.result.text)
  assert.equal(at(r, labelIs('a-qc')), -1, 'no QC on a head that lacks the commits')
})

// ---------------------------------------------------------------- factory start: freshAnswers

const HOUR = 3_600_000
const MIN = 60_000
const iso = (ms) => new Date(ms).toISOString()
const say = (r) => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 600)}; stderr ${String(r.stderr).slice(0, 300)}`
const PLANNER = { tasks: [{ name: 't1', role: 'builder', effort: 'medium', persona: null, files: ['members/**'], reads: [], brief: 'b', after: [] }], stop: null }

t('start --resume answers counts the new answers in freshAnswers; carried rulings follow them', () => {
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
    const p = join(tmp('r031-ans-'), 'answers.json')
    writeFileSync(p, JSON.stringify(answers))
    return env.run('start', { slug: 'x', resume: 'answers', transcript: run.dir, answers: p })
  }
  const one = resume([{ at: 'qc', text: 'ruling A' }])
  assert.equal(one.status, 0, say(one))
  assert.equal(one.json.truss.crews[0].freshAnswers, 1)
  const two = resume([{ at: 'green', text: 'ruling B' }])
  assert.equal(two.status, 0, say(two))
  const e = two.json.truss.crews[0]
  assert.deepEqual(e.answers.map((a) => a.text), ['ruling B', 'ruling A'])
  assert.equal(e.freshAnswers, 1, 'only ruling B is new; ruling A is carried')
})

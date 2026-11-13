// @ts-nocheck
// truss 0.29.0 factory throughput (goal wave5/goal-throughput.md), the factory.ts side: item 5 (a resume carries every unbuilt
// ruling forward), item 4 (heavy slot count) and the Claude 5.5 prices in `factory cost`. Each case failed on the code before
// its fix. The stage.js side (items 1, 6, 7) is in throughput-029-stage.check.ts.
//
// Run with: node --test plugins/truss/tests/throughput-029.check.ts

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  addCrewWorktree, appendEvent, crew, factorySpawn, git, mkEnv, mkRun, planObj, putFile, tmp, writeGoal, writePlan,
} from './fixtures/workflow-run/harness.ts'

const HOUR = 3_600_000
const MIN = 60_000
const iso = (ms) => new Date(ms).toISOString()
const say = (r) => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 600)}; stderr ${String(r.stderr).slice(0, 300)}`

// ---------------------------------------------------------------- item 5: answers carry forward

function resumeWorld() {
  const env = mkEnv({ config: { merge: 'sequential', target: 'main' } })
  writePlan(env.dir, planObj([crew('x', { status: 'running' })], { approvedAt: iso(Date.now() - 3 * HOUR) }))
  writeGoal(env.dir, 'x')
  const wt = addCrewWorktree(env.repo, 'x')
  appendEvent(env.dir, factorySpawn('x', iso(Date.now() - 3 * HOUR)))
  mkdirSync(join(env.dir, 'checks'), { recursive: true })
  writeFileSync(join(env.dir, 'checks', 'x-1.json'), JSON.stringify({ command: 'false', exit: 1, head: 'abc', tail: '' }))
  return { env, wt }
}
function memberBranch(wt, name) {
  git(wt, ['checkout', '-q', '-b', name])
  putFile(wt, `members/${name}.txt`, `${name}\n`, `member ${name}`)
  git(wt, ['checkout', '-q', 'truss-x'])
  git(wt, ['merge', '-q', '--no-ff', '-m', `merge ${name}`, name])
}
const member = (task, branch) => ({ task, marker: 'DONE', branch, commit: 'c0ffee', proof: 'ran it', text: 'ok' })
const PLANNER = { tasks: [{ name: 't1', role: 'builder', effort: 'medium', persona: null, files: ['members/**'], reads: [], brief: 'b', after: [] }], stop: null }
function deadRun(env, runId, agents, agoMs) {
  const endMs = Date.now() - agoMs
  return mkRun(env.transcripts, runId, agents.map((a) => ({ startTs: iso(endMs - MIN), endTs: iso(endMs), agentType: 'general-purpose', metaModel: 'sonnet', model: 'claude-sonnet-5-5', effort: 'medium', ...a })), { journalMtimeMs: endMs })
}
const answersFile = (answers) => {
  const p = join(tmp('fcli-ans-'), 'answers.json')
  writeFileSync(p, JSON.stringify(answers))
  return p
}
const resume = (env, run, answers) => env.run('start', { slug: 'x', resume: 'answers', transcript: run.dir, answers: answersFile(answers) })
const entryOf = (r) => r.json.truss.crews[0]
const doneNames = (r) => entryOf(r).done.map((d) => (typeof d === 'string' ? d : d.name))

test('i5 1: a second answers resume keeps the first resume\'s step rulings; the new answers come first', () => {
  const { env, wt } = resumeWorld()
  memberBranch(wt, 'member-a')
  const run = deadRun(env, 'wf_a1', [{ label: 'x-planner', result: PLANNER }, { label: 'x-builder', result: member('t1', 'member-a') }], 10 * MIN)
  const one = resume(env, run, [{ at: 'qc', text: 'ruling A: the empty table is approved' }])
  assert.equal(one.status, 0, say(one))
  const two = resume(env, run, [{ at: 'green', text: 'ruling B: skip the flaky case' }])
  assert.equal(two.status, 0, say(two))
  assert.deepEqual(entryOf(two).answers, [{ at: 'green', text: 'ruling B: skip the flaky case' }, { at: 'qc', text: 'ruling A: the empty table is approved' }])
  // a repeated ruling is not doubled
  const three = resume(env, run, [{ at: 'qc', text: 'ruling A: the empty table is approved' }])
  assert.equal(three.status, 0, say(three))
  assert.deepEqual(entryOf(three).answers, [{ at: 'qc', text: 'ruling A: the empty table is approved' }, { at: 'green', text: 'ruling B: skip the flaky case' }])
})

test('i5 2: a ruling at a task rides along (and keeps the task out of done) until a later run builds that task, then it drops', () => {
  const { env, wt } = resumeWorld()
  memberBranch(wt, 'member-a')
  const run1 = deadRun(env, 'wf_b1', [{ label: 'x-planner', result: PLANNER }, { label: 'x-builder', result: member('t1', 'member-a') }], 20 * MIN)
  const one = resume(env, run1, [{ at: 't1', text: 'use option b' }])
  assert.equal(one.status, 0, say(one))
  assert.deepEqual(doneNames(one), [])
  // the resumed run stopped elsewhere before t1 re-ran: the PM's next answers file names only the new ruling
  const two = resume(env, run1, [{ at: 'qc', text: 'ruling C' }])
  assert.equal(two.status, 0, say(two))
  assert.deepEqual(entryOf(two).answers, [{ at: 'qc', text: 'ruling C' }, { at: 't1', text: 'use option b' }])
  assert.deepEqual(doneNames(two), [], 't1 still has an unbuilt ruling, so it is not done')
  // a later run re-builds t1: its ruling is built and drops; the step ruling stays
  memberBranch(wt, 'member-b')
  const run2 = deadRun(env, 'wf_b2', [{ label: 'x-builder-2', result: member('t1', 'member-b') }], 5 * MIN)
  const three = resume(env, run2, [])
  assert.equal(three.status, 0, say(three))
  assert.deepEqual(entryOf(three).answers, [{ at: 'qc', text: 'ruling C' }])
  assert.deepEqual(doneNames(three), ['t1'])
  const stored = JSON.parse(readFileSync(join(env.dir, 'crews', 'x', 'answers.json'), 'utf8'))
  assert.deepEqual(stored.map((a) => a.at), ['qc'])
})

test('i5 3: a merge-ready resume carries the stored rulings too', () => {
  const { env, wt } = resumeWorld()
  memberBranch(wt, 'member-a')
  const run = deadRun(env, 'wf_c1', [{ label: 'x-planner', result: PLANNER }, { label: 'x-builder', result: member('t1', 'member-a') }], 10 * MIN)
  assert.equal(resume(env, run, [{ at: 'qc', text: 'ruling D' }]).status, 0)
  const stale = env.run('start', { slug: 'x', resume: 'merge-ready' })
  assert.equal(stale.status, 0, say(stale))
  assert.deepEqual(entryOf(stale).answers, [{ at: 'qc', text: 'ruling D' }])
})

test('i5 4: a first answers resume with no store passes its answers through unchanged and writes the store', () => {
  const { env, wt } = resumeWorld()
  memberBranch(wt, 'member-a')
  const run = deadRun(env, 'wf_d1', [{ label: 'x-builder', result: member('t1', 'member-a') }], 10 * MIN)
  const r = resume(env, run, [{ at: 'qc', text: 'only' }])
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(entryOf(r).answers, [{ at: 'qc', text: 'only' }])
  assert.ok(existsSync(join(env.dir, 'crews', 'x', 'answers.json')))
})

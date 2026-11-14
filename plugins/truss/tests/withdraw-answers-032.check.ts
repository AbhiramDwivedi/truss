// Bug J: start --withdraw-answers drops the stored rulings the PM withdrew.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { REAL_PLUGIN, addCrewWorktree, appendEvent, crew, factorySpawn, git, mkEnv, mkRun, planObj, putFile, tmp, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

void REAL_PLUGIN
const t = (name, fn) => test(name, { timeout: 60000 }, fn)
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
  const resume = (answers, extra = {}) => {
    const p = join(tmp('r032-wd-'), 'answers.json')
    writeFileSync(p, JSON.stringify(answers))
    return env.run('start', { slug: 'x', resume: 'answers', transcript: run.dir, answers: p, ...extra })
  }
  const store = () => JSON.parse(readFileSync(join(env.dir, 'crews', 'x', 'answers.json'), 'utf8'))
  return { resume, store, env, run }
}

t('start --withdraw-answers carries no stored ruling and stores only the fresh answers', () => {
  const { resume, store } = resumeEnv()
  assert.equal(resume([{ at: 'qc', text: 'old qc ruling' }, { at: 'scope', text: 'old scope ruling' }]).status, 0)
  const r = resume([{ at: 'qc', text: 'new qc ruling' }], { 'withdraw-answers': true })
  assert.equal(r.status, 0, say(r))
  const e = r.json.truss.crews[0]
  assert.deepEqual(e.answers.map((a) => a.text), ['new qc ruling'])
  assert.equal(e.freshAnswers, 1)
  assert.deepEqual(store().map((a) => a.text), ['new qc ruling'])
})

t('start without --withdraw-answers still carries a stored qc ruling', () => {
  const { resume, store } = resumeEnv()
  assert.equal(resume([{ at: 'qc', text: 'old qc ruling' }]).status, 0)
  const r = resume([{ at: 'scope', text: 'new scope ruling' }])
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(r.json.truss.crews[0].answers.map((a) => a.text), ['new scope ruling', 'old qc ruling'])
  assert.deepEqual(store().map((a) => a.text).sort(), ['new scope ruling', 'old qc ruling'])
})

t('start --withdraw-answers without --answers is a usage error', () => {
  const { env, run } = resumeEnv()
  const r = env.run('start', { slug: 'x', resume: 'stale', transcript: run.dir, 'withdraw-answers': true })
  assert.equal(r.status, 2, say(r))
  assert.match(`${r.stdout}${r.stderr}`, /withdraw-answers/)
})

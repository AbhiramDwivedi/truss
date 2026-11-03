// @ts-nocheck
// ADR-0019 (factory-fixes2), the runtime-factory items: 1 owns-check and dot segments, 2 doneTasks reads the prompt's Task line,
// 3 answers resume at a step after red needs a red record, 4 mark-merged, 8 cross-goal owns overlap in plan-check, 9 (start side)
// guarded and ownTests, 13a a result-less agentId before a resumed one, 17 doneTasks counts a patch-id match, 18 start resolves
// --dir and --repo to absolute paths, 19 recordRestarts links by task name, 21 an answered task leaves `done`.
//
// Written from the ADR before the fix exists. Every case is titled `i<item> <n>:` (fails on the code before the fix) or
// `control <n>:` (passes before and after). The file only drives bin/factory.ts through the CLI (harness runCli / mkEnv resolve
// the plugin from the harness path, never process.cwd()), so it loads and runs against the base code too.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, relative } from 'node:path'
import { realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import {
  addCrewWorktree, appendEvent, crew, factorySpawn, flat, git, gitStatus, head, mkEnv, mkRun, planObj, putFile, qcReport, readEvents, readPlan,
  runCli, tmp, writeGoal, writePlan,
} from './fixtures/workflow-run/harness.ts'

const CFG = { merge: 'sequential', target: 'main' }
const HOUR = 3_600_000
const MIN = 60_000
const iso = (ms: number): string => new Date(ms).toISOString()
const norm = (p: string): string => {
  try {
    return flat(realpathSync.native(p)).toLowerCase()
  } catch {
    return flat(p).toLowerCase()
  }
}
const say = (r: any): string => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 600)}; stderr ${String(r.stderr).slice(0, 300)}`
const statusOf = (env: any, slug: string): string => readPlan(env.dir).crews.find((c: any) => c.slug === slug).status
const names = (done: any[]): string[] => done.map((d: any) => (typeof d === 'string' ? d : d.name))

// ---------------------------------------------------------------------------------------------------------------
// shared worlds

/** A world with crew `slug` running (worktree, factory spawn line, approved plan) and a goal file. */
function runningWorld(slug = 'x', o: { owns?: string[]; acceptanceTest?: string; files?: Record<string, string> } = {}) {
  const env = mkEnv({ config: CFG, files: o.files })
  writePlan(env.dir, planObj([crew(slug, { status: 'running', ...(o.owns ? { owns: o.owns } : {}), ...(o.acceptanceTest ? { acceptanceTest: o.acceptanceTest } : {}) })], { approvedAt: iso(Date.now() - 3 * HOUR) }))
  writeGoal(env.dir, slug)
  const wt = addCrewWorktree(env.repo, slug)
  appendEvent(env.dir, factorySpawn(slug, iso(Date.now() - 3 * HOUR)))
  return { env, wt }
}

/** A Workflow run dir whose last write was `agoMs` ago. */
function deadRun(env: any, runId: string, agents: any[], agoMs = 10 * MIN) {
  const endMs = Date.now() - agoMs
  return mkRun(env.transcripts, runId, agents.map((a) => ({ startTs: iso(endMs - MIN), endTs: iso(endMs), ...a })), { journalMtimeMs: endMs })
}

/** In the crew worktree: a member branch `name` with one commit from the crew branch head, merged into the crew branch when `merge`. */
function memberBranch(wt: string, crewBranch: string, name: string, merge: boolean): void {
  git(wt, ['checkout', '-q', '-b', name])
  putFile(wt, `members/${name}.txt`, `${name}\n`, `member ${name}`)
  git(wt, ['checkout', '-q', crewBranch])
  if (merge) git(wt, ['merge', '-q', '--no-ff', '-m', `merge ${name}`, name])
}

const member = (task: string, branch: string, marker = 'DONE') => ({ task, marker, branch, commit: 'c0ffee', proof: 'ran it', text: 'ok' })
/** What a real member transcript holds as its first user record: the stage.js prompt, indented by the harness. */
const promptFor = (task: string): string => `  Your first step, before anything else: git merge truss-x\n  Work in your own worktree. The crew branch is truss-x.\n\n  Task: ${task}\n  Files you may change: members/${task}.txt\n  Files to read: none\n`

/** A well-formed audit-clean agent spec for mkRun (sonnet, medium effort). */
const mk = (label: string, over: Record<string, unknown> = {}) => ({ label, agentType: 'general-purpose', metaModel: 'sonnet', model: 'claude-sonnet-5-5', effort: 'medium', result: 'built it', ...over })

/** finish for crew x with a stage.js result that has no qc report: it records the run (reports, spawn, restart lines) and merges nothing. */
const finishX = (env: any, run: any) => {
  const resFile = `${env.dir}/result-x.json`
  writeFileSync(resFile, JSON.stringify([{ slug: 'x', state: 'passed', head: 'a'.repeat(40), base: 'b'.repeat(40), qc: 'x-qc' }]))
  return env.run('finish', { transcript: run.dir, result: resFile })
}

const answersFile = (answers: unknown): string => {
  const p = `${tmp('fcli-ans-')}/answers.json`
  writeFileSync(p, JSON.stringify(answers))
  return p
}
const writeRed = (env: any, slug: string, rec: Record<string, unknown>, n = 1): void => {
  mkdirSync(`${env.dir}/checks`, { recursive: true })
  writeFileSync(`${env.dir}/checks/${slug}-${n}.json`, JSON.stringify({ command: 'false', exit: 1, head: 'abc', tail: '', ...rec }))
}
const resumeAnswers = (env: any, run: any, answers: unknown[]) => env.run('start', { slug: 'x', resume: 'answers', transcript: run.dir, answers: answersFile(answers) })
const taskDone = (r: any): string[] => names(r.json.truss.crews[0].done)

// ---------------------------------------------------------------------------------------------------------------
// item 1: owns-check and dot segments

function ownsWorld(owns: string[], files: string[]) {
  const { env, wt } = runningWorld('mk', { owns })
  for (const f of files) putFile(wt, f, 'x\n', `add ${f}`)
  return env
}

test('i1 1: owns-check accepts marketplace/.claude-plugin/marketplace.json, and other dot segments, under an owned marketplace/**', () => {
  const env = ownsWorld(['marketplace/**'], ['marketplace/.claude-plugin/marketplace.json', 'marketplace/a/.hidden/c.json', 'marketplace/.top'])
  const r = env.run('owns-check', { slug: 'mk' })
  assert.equal(r.status, 0, `a dot segment under an owned ** is owned: ${say(r)}`)
  assert.equal(r.json.ok, true, say(r))
})

test('control 1: owns-check still refuses a file outside owns, dot segment or not', () => {
  const env = ownsWorld(['marketplace/**'], ['marketplace/plugins/a.json', 'elsewhere/.claude-plugin/x.json', 'src/y.ts'])
  const r = env.run('owns-check', { slug: 'mk' })
  assert.equal(r.status, 1, say(r))
  assert.deepEqual([...r.json.outside].sort(), ['elsewhere/.claude-plugin/x.json', 'src/y.ts'])
})

test('control 2: owns-check accepts plain files under marketplace/**', () => {
  const env = ownsWorld(['marketplace/**'], ['marketplace/plugins/a.json', 'marketplace/README.md'])
  const r = env.run('owns-check', { slug: 'mk' })
  assert.equal(r.status, 0, say(r))
})

// ---------------------------------------------------------------------------------------------------------------
// item 2: doneTasks reads the task name from the prompt's Task line

test('i2 1: done takes the task name from the prompt\'s Task line, whatever result.task says', () => {
  const { env, wt } = runningWorld()
  memberBranch(wt, 'truss-x', 'member-a', true)
  const run = deadRun(env, 'wf_i2', [{ label: 'x-builder', prompt: promptFor('build-core'), result: member('x: unrelated words', 'member-a') }])
  const r = resumeAnswers(env, run, [])
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(taskDone(r), ['build-core'])
})

test('i2 2: with no Task line, done is result.task with a leading "<slug>: " stripped', () => {
  const { env, wt } = runningWorld()
  memberBranch(wt, 'truss-x', 'member-a', true)
  memberBranch(wt, 'truss-x', 'member-b', true)
  const run = deadRun(env, 'wf_i2b', [
    { label: 'x-tester', result: member('x: write-tests', 'member-a') },
    { label: 'x-builder', result: member('plain-name', 'member-b') },
  ])
  const r = resumeAnswers(env, run, [])
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(taskDone(r).sort(), ['plain-name', 'write-tests'])
})

test('control 3: a member with no Task line (the default prompt) keeps result.task as its name', () => {
  const { env, wt } = runningWorld()
  memberBranch(wt, 'truss-x', 'member-a', true)
  const run = deadRun(env, 'wf_c3', [{ label: 'x-builder', result: member('whatever', 'member-a') }])
  const r = resumeAnswers(env, run, [])
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(taskDone(r), ['whatever'])
})

// ---------------------------------------------------------------------------------------------------------------
// item 3: answers at a step after red need a red record

function redWorld() {
  const { env, wt } = runningWorld()
  memberBranch(wt, 'truss-x', 'member-a', true)
  const run = deadRun(env, 'wf_i3', [{ label: 'x-builder', result: member('t1', 'member-a') }])
  return { env, run }
}

test('i3 1: an answer at a task is refused (exit 1, slug and a why naming the red record) when no red record exists', () => {
  const { env, run } = redWorld()
  const r = resumeAnswers(env, run, [{ at: 't1', text: 'use option b' }])
  assert.equal(r.status, 1, say(r))
  assert.equal(r.json?.slug, 'x', say(r))
  assert.match(String(r.json?.why), /red/i, say(r))
  assert.equal(statusOf(env, 'x'), 'running')
})

test('i3 2: an answer at a task is refused when the red record has exit 0', () => {
  const { env, run } = redWorld()
  writeRed(env, 'x', { exit: 0 })
  const r = resumeAnswers(env, run, [{ at: 'green', text: 'try again' }])
  assert.equal(r.status, 1, say(r))
  assert.equal(r.json?.slug, 'x', say(r))
  assert.match(String(r.json?.why), /red/i, say(r))
})

test('i3 3: a checks file with an env key is no red record, so an answer at a task is refused', () => {
  const { env, run } = redWorld()
  writeRed(env, 'x', { exit: 1, env: 'no memory' })
  const r = resumeAnswers(env, run, [{ at: 't1', text: 'go' }])
  assert.equal(r.status, 1, say(r))
  assert.match(String(r.json?.why), /red/i, say(r))
})

test('control 4: an answers resume with an answer at red and no red record is not refused', () => {
  const { env, run } = redWorld()
  const r = resumeAnswers(env, run, [{ at: 'red', text: 'the command is right now' }])
  assert.equal(r.status, 0, say(r))
  assert.equal(r.json.truss.crews[0].resume, 'answers')
})

test('control 5: an answer at a task is not refused when the red record has a nonzero exit; no answers is not refused either', () => {
  const { env, run } = redWorld()
  const none = resumeAnswers(env, run, [])
  assert.equal(none.status, 0, say(none))
  writeRed(env, 'x', { exit: 1 })
  const r = resumeAnswers(env, run, [{ at: 't1', text: 'use option b' }])
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(r.json.truss.crews[0].answers, [{ at: 't1', text: 'use option b' }])
})

// ---------------------------------------------------------------------------------------------------------------
// item 4: factory mark-merged

function mergedWorld() {
  const { env, wt } = runningWorld('x')
  // a second running crew, untouched by the command
  const plan = readPlan(env.dir)
  plan.crews.push(crew('y', { status: 'running' }))
  writePlan(env.dir, plan)
  putFile(wt, 'src/x/a.ts', 'x\n', 'work')
  return { env, wt }
}

test('i4 1: mark-merged sets the status merged when truss-<slug> is an ancestor of the target, and logs a line', () => {
  const { env } = mergedWorld()
  git(env.repo, ['merge', '-q', '--no-ff', '-m', 'merge x outside finish', 'truss-x'])
  const r = env.run('mark-merged', { slug: 'x' })
  assert.equal(r.status, 0, say(r))
  assert.equal(statusOf(env, 'x'), 'merged', say(r))
  assert.equal(statusOf(env, 'y'), 'running', 'another crew is left alone')
  const log = readFileSync(`${env.dir}/decisions.md`, 'utf8')
  assert.match(log, /\bx\b.*merged|merged.*\bx\b/i, `a decision line names the crew: ${JSON.stringify(log)}`)
})

test('i4 2: mark-merged writes one line per call and changes nothing else in the plan', () => {
  const { env } = mergedWorld()
  git(env.repo, ['merge', '-q', '--no-ff', '-m', 'merge x outside finish', 'truss-x'])
  const before = readPlan(env.dir)
  const r = env.run('mark-merged', { slug: 'x' })
  assert.equal(r.status, 0, say(r))
  const after = readPlan(env.dir)
  before.crews.find((c: any) => c.slug === 'x').status = 'merged'
  assert.deepEqual(after, before)
  assert.equal(readFileSync(`${env.dir}/decisions.md`, 'utf8').split('\n').filter(Boolean).length, 1)
})

test('control 6: mark-merged with a truss-<slug> branch that is not an ancestor of the target leaves the status alone', () => {
  const { env } = mergedWorld()
  const r = env.run('mark-merged', { slug: 'x' })
  assert.notEqual(r.status, 0, say(r))
  assert.equal(statusOf(env, 'x'), 'running')
  assert.equal(readFileSync(`${env.dir}/decisions.md`, 'utf8'), '')
})

// ---------------------------------------------------------------------------------------------------------------
// item 8: plan-check and an owns overlap between crews of different goals

const goalRow = (id: string) => ({ id, goal: id, addedAt: '2026-11-02T00:00:00Z', approval: 'auto', approvedAt: '2026-11-02T00:00:00Z' })
const c3 = (slug: string, goal: string, stage: number, owns: string[], status: string) => ({ slug, goal, stage, verdict: 'extend', modules: ['m'], owns, acceptanceTest: 'false', acceptanceTestProved: true, estAgents: 1, status })
function planCheck(crews: any[], goals = ['ga', 'gb']) {
  const env = mkEnv({ config: CFG })
  writeFileSync(`${env.dir}/plan.json`, JSON.stringify({ version: 3, goal: 'g', architecture: 'docs/architecture.md', approval: 'auto', approvedAt: '2026-11-02T00:00:00Z', maxParallelCrews: 4, reworkAllowance: 2, goals: goals.map(goalRow), crews }))
  return env.run('plan-check')
}
const word = (text: string, w: string): boolean => new RegExp(`(^|[^A-Za-z0-9_])${w}($|[^A-Za-z0-9_])`).test(text)

test('i8 1: plan-check refuses unmerged crews of two goals that own the same path, names both, and never a merged crew', () => {
  const r = planCheck([
    c3('crewalpha', 'ga', 1, ['x/**'], 'planned'),
    c3('crewbeta', 'gb', 1, ['x/y.ts'], 'running'),
    c3('crewgamma', 'gb', 2, ['x/z.ts'], 'merged'),
  ])
  const out = `${r.stdout} ${r.stderr}`
  assert.notEqual(r.status, 0, `plan-check must refuse a cross-goal overlap: ${say(r)}`)
  assert.ok(word(out, 'crewalpha') && word(out, 'crewbeta'), `the error names both crews: ${say(r)}`)
  assert.ok(!word(out, 'crewgamma'), `the merged crew is not named: ${say(r)}`)
})

test('i8 2: different stages of different goals still overlap (no later-stage exemption)', () => {
  const r = planCheck([c3('crewalpha', 'ga', 1, ['x/**'], 'planned'), c3('crewbeta', 'gb', 2, ['x/y.ts'], 'planned')])
  assert.notEqual(r.status, 0, say(r))
  assert.ok(word(`${r.stdout} ${r.stderr}`, 'crewalpha') && word(`${r.stdout} ${r.stderr}`, 'crewbeta'), say(r))
})

test('i8 3: a goal that is not running yet is no exemption either (two planned crews of two goals)', () => {
  const r = planCheck([c3('crewalpha', 'ga', 1, ['docs/**'], 'planned'), c3('crewbeta', 'gb', 1, ['docs/a.md'], 'planned')])
  assert.notEqual(r.status, 0, say(r))
})

test('control 7: plan-check passes once the overlapping crew of the other goal is merged, or dropped', () => {
  const merged = planCheck([c3('crewalpha', 'ga', 1, ['x/**'], 'planned'), c3('crewbeta', 'gb', 1, ['x/y.ts'], 'merged'), c3('crewgamma', 'gb', 2, ['x/z.ts'], 'merged')])
  assert.equal(merged.status, 0, say(merged))
  const dropped = planCheck([c3('crewalpha', 'ga', 1, ['x/**'], 'planned'), c3('crewbeta', 'gb', 1, ['x/y.ts'], 'dropped')])
  assert.equal(dropped.status, 0, say(dropped))
})

test('control 8: plan-check still refuses an overlap between two crews of one goal in one stage, and allows it across stages', () => {
  const same = planCheck([c3('crewalpha', 'ga', 1, ['x/**'], 'planned'), c3('crewbeta', 'ga', 1, ['x/y.ts'], 'planned')])
  assert.notEqual(same.status, 0, say(same))
  assert.ok(word(`${same.stdout} ${same.stderr}`, 'crewalpha') && word(`${same.stdout} ${same.stderr}`, 'crewbeta'), say(same))
  const later = planCheck([c3('crewalpha', 'ga', 1, ['x/**'], 'planned'), c3('crewbeta', 'ga', 2, ['x/y.ts'], 'planned')])
  assert.equal(later.status, 0, say(later))
})

// ---------------------------------------------------------------------------------------------------------------
// item 9 (start side): guarded and ownTests

const TEST_WORLD_FILES = { 'tests/x.check.ts': '// the acceptance test\n', 'src/x/a.ts': 'a\n' }
function nineWorld() {
  const env = mkEnv({ config: CFG, files: TEST_WORLD_FILES })
  const owns = ['src/x/**', 'tests/x.check.ts', 'tests/fixtures/x/**', 'docs/x.md']
  writePlan(env.dir, planObj([crew('x', { owns, acceptanceTest: 'node --test tests/x.check.ts' })]))
  writeGoal(env.dir, 'x', { scope: 'Build only the x thing.' })
  return { env, owns }
}

test('i9 1: a start entry carries guarded (the acceptance test file it names) and ownTests (the owns entries that are test paths), and keeps goal, scope and acceptanceTest', () => {
  const { env, owns } = nineWorld()
  const r = env.run('start', { stage: 'next' })
  assert.equal(r.status, 0, say(r))
  const e = r.json.truss.crews[0]
  assert.deepEqual(e.guarded, ['tests/x.check.ts'], `guarded: ${JSON.stringify(e.guarded)}`)
  assert.deepEqual([...e.ownTests].sort(), ['tests/fixtures/x/**', 'tests/x.check.ts'])
  assert.deepEqual(e.owns, owns)
  assert.equal(e.acceptanceTest, 'node --test tests/x.check.ts')
})

test('i9 2: guarded also holds every file a test-writer commit touched, sorted, and a resume entry carries both keys', () => {
  const { env } = nineWorld()
  const first = env.run('start', { stage: 'next' })
  assert.equal(first.status, 0, say(first))
  const wt = `${env.repo}/.claude/worktrees/truss-x`
  putFile(wt, 'src/x/odd-name.txt', 'fixture\n', 'tests\n\nTruss-Crew: x\nTruss-Role: test-writer')
  putFile(wt, 'src/x/a.ts', 'builder edit\n', 'build\n\nTruss-Crew: x\nTruss-Role: builder')
  const r = env.run('start', { slug: 'x', resume: 'merge-ready' })
  assert.equal(r.status, 0, say(r))
  const e = r.json.truss.crews[0]
  assert.deepEqual(e.guarded, ['src/x/odd-name.txt', 'tests/x.check.ts'])
  assert.deepEqual([...e.ownTests].sort(), ['tests/fixtures/x/**', 'tests/x.check.ts'])
})

test('i9 3: guarded and ownTests are what tests-check says, so the two cannot disagree', () => {
  const { env } = nineWorld()
  env.run('start', { stage: 'next' })
  const wt = `${env.repo}/.claude/worktrees/truss-x`
  putFile(wt, 'src/x/odd-name.txt', 'fixture\n', 'tests\n\nTruss-Crew: x\nTruss-Role: test-writer')
  const tc = env.run('tests-check', { slug: 'x' })
  assert.equal(tc.status, 0, say(tc))
  const r = env.run('start', { slug: 'x', resume: 'merge-ready' })
  assert.deepEqual(r.json.truss.crews[0].guarded, tc.json.tests)
})

// ---------------------------------------------------------------------------------------------------------------
// item 13 (a): an agentId with no result before a resumed one under the same label

test('i13 1: a result-less agentId before a resumed one under one label: the resumed one counts for done, and finish files <label>.md', () => {
  const { env, wt } = runningWorld('x')
  memberBranch(wt, 'truss-x', 'member-a', true)
  // default (old) run times, so finish sees a run that is over
  const run = mkRun(env.transcripts, 'wf_i13', [
    mk('x-builder', { id: 'abortedbuilder', noResult: true, prompt: promptFor('build-core') }),
    mk('x-builder', { id: 'resumedbuilder', prompt: promptFor('build-core'), result: member('x: build-core', 'member-a') }),
  ])
  const r = resumeAnswers(env, run, [])
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(taskDone(r), ['build-core'], 'the resumed member counts, under the name its prompt gives')
  const f = finishX(env, run)
  const reports = `${env.dir}/reports/x`
  assert.ok(existsSync(`${reports}/x-builder.md`), `the resumed agentId is rank 1 and files <label>.md: ${say(f)}`)
  assert.ok(!existsSync(`${reports}/x-builder.run2.md`), 'no .run2 file')
  assert.ok(readFileSync(`${reports}/x-builder.md`, 'utf8').length > 0, 'the report has the resumed agent\'s text')
})

// ---------------------------------------------------------------------------------------------------------------
// item 17: doneTasks counts a patch-id match

test('i17 1: a member branch cherry-picked onto the crew branch is done; one with a commit not picked is not', () => {
  const { env, wt } = runningWorld('x')
  git(wt, ['checkout', '-q', '-b', 'member-c'])
  putFile(wt, 'members/c.txt', 'c\n', 'member c')
  git(wt, ['checkout', '-q', '-b', 'member-d', 'truss-x'])
  putFile(wt, 'members/d1.txt', 'd1\n', 'member d1')
  const d1 = head(wt)
  putFile(wt, 'members/d2.txt', 'd2\n', 'member d2')
  git(wt, ['checkout', '-q', 'truss-x'])
  putFile(wt, 'members/pre.txt', 'pre\n', 'crew work, so a pick gets another hash')
  git(wt, ['cherry-pick', 'member-c'])
  git(wt, ['cherry-pick', d1])
  assert.equal(gitStatus(wt, ['merge-base', '--is-ancestor', 'member-c', 'truss-x']), 1, 'precondition: the picked branch is not an ancestor')
  const run = deadRun(env, 'wf_i17', [
    { label: 'x-builder', result: member('tc', 'member-c') },
    { label: 'x-builder-2', result: member('td', 'member-d') },
  ])
  const r = resumeAnswers(env, run, [])
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(taskDone(r), ['tc'], 'td has a commit (d2) that never reached the crew branch')
})

test('control 9: a member branch merged into the crew branch is done, one never merged is not', () => {
  const { env, wt } = runningWorld('x')
  memberBranch(wt, 'truss-x', 'member-m', true)
  memberBranch(wt, 'truss-x', 'member-n', false)
  const run = deadRun(env, 'wf_c9', [{ label: 'x-builder', result: member('tm', 'member-m') }, { label: 'x-builder-2', result: member('tn', 'member-n') }])
  const r = resumeAnswers(env, run, [])
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(taskDone(r), ['tm'])
})

// ---------------------------------------------------------------------------------------------------------------
// item 18: start and start --resume resolve --dir and --repo to absolute paths

const relFrom = (cwd: string, p: string): string => relative(cwd, p)

test('i18 1: start with relative --dir and --repo run from a parent cwd emits absolute paths and builds the worktree there', () => {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew('x')]))
  writeGoal(env.dir, 'x')
  const cwd = tmpdir()
  const r = runCli(env.factory, 'start', ['--dir', relFrom(cwd, env.dir), '--repo', relFrom(cwd, env.repo), '--stage', 'next'], cwd)
  assert.equal(r.status, 0, say(r))
  const e = r.json.truss.crews[0]
  for (const [k, v] of [['goalFile', e.goalFile], ['worktree', e.worktree], ['architecture', e.architecture], ['truss.dir', r.json.truss.dir], ['truss.repo', r.json.truss.repo]]) {
    assert.ok(isAbsolute(String(v)), `${k} must be absolute, got ${v}`)
  }
  assert.equal(norm(e.goalFile), norm(`${env.dir}/goals/x.md`))
  assert.equal(norm(e.worktree), norm(`${env.repo}/.claude/worktrees/truss-x`))
  assert.ok(existsSync(`${env.repo}/.claude/worktrees/truss-x`), 'the worktree is where the absolute repo says')
})

test('i18 2: start --resume with relative --dir and --repo emits absolute paths too', () => {
  const { env, wt } = runningWorld('x')
  memberBranch(wt, 'truss-x', 'member-a', true)
  const run = deadRun(env, 'wf_i18', [{ label: 'x-builder', result: member('t1', 'member-a') }])
  const cwd = tmpdir()
  const r = runCli(env.factory, 'start', ['--dir', relFrom(cwd, env.dir), '--repo', relFrom(cwd, env.repo), '--slug', 'x', '--resume', 'merge-ready', '--transcript', run.dir], cwd)
  assert.equal(r.status, 0, say(r))
  const e = r.json.truss.crews[0]
  for (const [k, v] of [['goalFile', e.goalFile], ['worktree', e.worktree], ['architecture', e.architecture]]) {
    assert.ok(isAbsolute(String(v)), `${k} must be absolute, got ${v}`)
  }
  assert.equal(norm(e.worktree), norm(wt))
  assert.equal(norm(e.goalFile), norm(`${env.dir}/goals/x.md`))
})

test('control 10: start with absolute --dir and --repo emits the same absolute paths', () => {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew('x')]))
  writeGoal(env.dir, 'x')
  const r = env.run('start', { stage: 'next' })
  assert.equal(r.status, 0, say(r))
  const e = r.json.truss.crews[0]
  assert.equal(norm(e.goalFile), norm(`${env.dir}/goals/x.md`))
  assert.equal(norm(e.worktree), norm(`${env.repo}/.claude/worktrees/truss-x`))
})

// ---------------------------------------------------------------------------------------------------------------
// item 19: recordRestarts links a successor by task name

/** Rewrites journal.jsonl so each agent's `started` line is followed by its `result` line, in agent order (the order a real run writes). */
function interleave(runDir: string): void {
  const lines = readFileSync(`${runDir}/journal.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const out = [lines.find((l) => l.type === 'launched')]
  for (const s of lines.filter((l) => l.type === 'started')) {
    out.push(s)
    for (const r of lines.filter((l) => l.type === 'result' && l.agentId === s.agentId)) out.push(r)
  }
  writeFileSync(`${runDir}/journal.jsonl`, out.map((l) => JSON.stringify(l)).join('\n') + '\n')
}
const checkpoint = (task: string) => ({ task, marker: 'CHECKPOINT', branch: 'feat/x', commit: 'c0'.repeat(20), proof: '', text: 'halfway' })
const finished = (task: string) => ({ task, marker: 'DONE', branch: 'feat/y', commit: 'c0'.repeat(20), proof: 'ran it', text: 'done' })
const restarts = (env: any) => readEvents(env.dir).filter((e) => e.event === 'restart')

function restartWorld(agents: any[]) {
  const { env } = runningWorld('x')
  const run = mkRun(env.transcripts, 'wf_i19', agents)
  interleave(run.dir)
  return { env, run }
}

test('i19 1: two parallel builders: b1 stops at CHECKPOINT, b2 starts later and is DONE, no b1 successor: no restart event', () => {
  const { env, run } = restartWorld([
    mk('x-builder', { prompt: promptFor('b1'), result: checkpoint('b1') }),
    mk('x-builder-2', { prompt: promptFor('b2'), result: finished('b2') }),
  ])
  const f = finishX(env, run)
  assert.deepEqual(restarts(env), [], `b2 is not b1's successor: ${say(f)}`)
})

test('i19 2: the builder that redoes b1 later is its successor, so the chain counts through it (n 1, then n 2)', () => {
  const { env, run } = restartWorld([
    mk('x-builder', { prompt: promptFor('b1'), result: checkpoint('b1') }),
    mk('x-builder-2', { prompt: promptFor('b2'), result: finished('b2') }),
    mk('x-builder-3', { prompt: promptFor('b1'), result: checkpoint('b1') }),
    mk('x-builder-4', { prompt: promptFor('b1'), result: finished('b1') }),
  ])
  const f = finishX(env, run)
  const ev = restarts(env)
  const byLabel = Object.fromEntries(ev.map((e) => [e.label, e]))
  assert.deepEqual(Object.keys(byLabel).sort(), ['x-builder', 'x-builder-3'], `${JSON.stringify(ev)} ${say(f)}`)
  assert.equal(byLabel['x-builder'].n, 1, JSON.stringify(ev))
  assert.equal(byLabel['x-builder-3'].n, 2, `x-builder-3 is itself the first restart's successor, so its own restart is n 2: ${JSON.stringify(ev)}`)
  assert.equal(byLabel['x-builder'].reason, 'CHECKPOINT')
})

test('control 11: a plain CHECKPOINT then a later builder of the same task is one restart event with n 1', () => {
  const { env, run } = restartWorld([
    mk('x-builder', { prompt: promptFor('b1'), result: checkpoint('b1') }),
    mk('x-builder-2', { prompt: promptFor('b1'), result: finished('b1') }),
  ])
  const f = finishX(env, run)
  const ev = restarts(env)
  assert.equal(ev.length, 1, `${JSON.stringify(ev)} ${say(f)}`)
  assert.equal(ev[0].label, 'x-builder')
  assert.equal(ev[0].n, 1)
})

// A two-crew finish: both crews merge, a dirty wf_<run> worktree is left, and it is reported once.
const RUN = 'wf_twocrew'
function twoCrewWorld() {
  const env = mkEnv({ config: CFG })
  const slugs = ['s', 't']
  writePlan(env.dir, planObj(slugs.map((s) => crew(s, { status: 'running' })), { approvedAt: '2026-10-01T00:00:00.000Z' }))
  const agents: any[] = []
  const results: any[] = []
  for (const s of slugs) {
    appendEvent(env.dir, factorySpawn(s, iso(Date.now() - 3 * HOUR)))
    const wt = addCrewWorktree(env.repo, s)
    putFile(wt, `src/${s}/a.ts`, `${s}\n`, `work ${s}`)
    const base = git(wt, ['merge-base', 'main', 'HEAD'])
    const hd = head(wt)
    const diff = spawnSync('git', ['diff', `${base}...${hd}`], { cwd: wt, encoding: 'utf8' }).stdout
    const pid = spawnSync('git', ['patch-id', '--stable'], { cwd: wt, input: diff, encoding: 'utf8' }).stdout.split(' ')[0]
    mkdirSync(`${env.dir}/checks`, { recursive: true })
    writeFileSync(`${env.dir}/checks/${s}-1.json`, JSON.stringify({ command: 'true', exit: 1, head: hd, tail: '' }))
    agents.push(mk(`${s}-builder`), { label: `${s}-qc`, agentType: 'truss:qc-engineer', metaModel: 'opus', model: 'claude-opus-5-5', effort: 'medium', result: qcReport({ head: hd, patch: pid }) })
    results.push({ slug: s, state: 'passed', head: hd, base, qc: `${s}-qc` })
  }
  const run = mkRun(env.transcripts, RUN, agents)
  const wfPath = `${env.repo}/.claude/worktrees/${RUN}-1`
  git(env.repo, ['worktree', 'add', '-q', '-b', `worktree-${RUN}-1`, wfPath, 'main'])
  writeFileSync(`${wfPath}/scratch.txt`, 'uncommitted\n')
  const resFile = `${env.dir}/result.json`
  writeFileSync(resFile, JSON.stringify(results))
  return { env, run, resFile, wfPath }
}

test('control 12: a two-crew finish merges both and lists a dirty wf_<run> worktree once in leftWorktrees', () => {
  const { env, run, resFile, wfPath } = twoCrewWorld()
  const r = env.run('finish', { transcript: run.dir, result: resFile })
  assert.deepEqual([...(r.json?.merged ?? [])].sort(), ['s', 't'], say(r))
  const left = r.json.leftWorktrees ?? []
  assert.equal(left.length, 1, say(r))
  assert.equal(norm(left[0].path), norm(wfPath))
  assert.equal(left[0].why, 'dirty')
})

// ---------------------------------------------------------------------------------------------------------------
// item 21: an answered task leaves `done`

function allDoneWorld() {
  const { env, wt } = runningWorld('x')
  for (const t of ['t1', 't2', 't3']) memberBranch(wt, 'truss-x', `member-${t}`, true)
  writeRed(env, 'x', { exit: 1 })
  const plannerTasks = ['t1', 't2', 't3'].map((name) => ({ name, role: 'builder', effort: 'medium', files: [`members/${name}.txt`], reads: [], brief: `do ${name}`, after: [] }))
  const run = deadRun(env, 'wf_i21', [
    { label: 'x-planner', result: { tasks: plannerTasks, stop: null } },
    ...['t1', 't2', 't3'].map((t, i) => ({ label: i === 0 ? 'x-builder' : `x-builder-${i + 1}`, prompt: promptFor(t), result: member(t, `member-${t}`) })),
  ])
  return { env, run }
}

test('i21 1: a run stopped at green with every task done and an answer at task t2: done lacks t2 and keeps the others', () => {
  const { env, run } = allDoneWorld()
  const r = resumeAnswers(env, run, [{ at: 't2', text: 'use the second option' }])
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(taskDone(r).sort(), ['t1', 't3'])
  assert.equal(r.json.truss.crews[0].tasks.length, 3, 'the tasks themselves stay')
  assert.deepEqual(r.json.truss.crews[0].answers, [{ at: 't2', text: 'use the second option' }])
})

test('i21 2: every task an answer names leaves done', () => {
  const { env, run } = allDoneWorld()
  const r = resumeAnswers(env, run, [{ at: 't1', text: 'a' }, { at: 't3', text: 'b' }, { at: 't3', text: 'c' }])
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(taskDone(r), ['t2'])
})

test('control 13: an answer whose at names no task (a step) drops nothing from done; no answers drops nothing', () => {
  const { env, run } = allDoneWorld()
  const step = resumeAnswers(env, run, [{ at: 'green', text: 'the fix is in the config' }])
  assert.equal(step.status, 0, say(step))
  assert.deepEqual(taskDone(step).sort(), ['t1', 't2', 't3'])
  const none = resumeAnswers(env, run, [])
  assert.deepEqual(taskDone(none).sort(), ['t1', 't2', 't3'])
})

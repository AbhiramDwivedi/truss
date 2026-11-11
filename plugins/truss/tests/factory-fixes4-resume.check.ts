// @ts-nocheck
// ADR-0025 (factory-fixes4), the resume-fixes4 items: 42 (ADR-0024 item 27) doneTasks counts a BLOCKED branch's own commits by the
// reflog when the crew branch was rewritten after the member forked, 43 the check env rule ends a TAP failure block at its YAML `...`
// or at a plan/summary line, 44 (ADR-0024 item 32) integrate takes the `contained` shortcut only with no merge in progress, and the
// item 34 control for project-less Playwright headers.
//
// Every case drives bin/factory.ts through the CLI (harness runCli / mkEnv) and imports nothing from it, so the file loads and runs
// against the base code too. Titles are `i<item> <n>:` (fails before the fix) or `control <n>:` (passes before and after).

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  addCrewWorktree, appendEvent, crew, factorySpawn, git, gitStatus, head, mkEnv, mkRun, planObj, putFile, tmp, writeGoal, writePlan,
} from './fixtures/workflow-run/harness.ts'

const HOUR = 3_600_000
const MIN = 60_000
const CFG = { merge: 'sequential', target: 'main' }
const iso = (ms: number): string => new Date(ms).toISOString()
const say = (r: any): string => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 700)}; stderr ${String(r.stderr).slice(0, 300)}`

// ---------------------------------------------------------------------------------------------------------------
// item 42: ownCommits after the crew branch was rewritten

function runningWorld(slug = 'x') {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew(slug, { status: 'running' })], { approvedAt: iso(Date.now() - 4 * HOUR) }))
  writeGoal(env.dir, slug, {})
  const wt = addCrewWorktree(env.repo, slug)
  appendEvent(env.dir, factorySpawn(slug, iso(Date.now() - 3 * HOUR)))
  return { env, wt }
}
function deadRun(env: any, runId: string, agents: any[], agoMs = 2 * HOUR) {
  const endMs = Date.now() - agoMs
  return mkRun(env.transcripts, runId, agents.map((a) => ({ startTs: iso(endMs - MIN), endTs: iso(endMs), ...a })), { journalMtimeMs: endMs })
}
const member = (task: string, branch: string, marker = 'BLOCKED') => ({ task, marker, branch, commit: 'c0ffee', proof: 'ran it', text: 'ok' })
const names = (done: any[]): string[] => done.map((d: any) => (typeof d === 'string' ? d : d.name))
const answersFile = (answers: unknown): string => {
  const p = `${tmp('f4-ans-')}/answers.json`
  writeFileSync(p, JSON.stringify(answers))
  return p
}
const entryOf = (r: any): any => r.json.truss.crews[0]

/**
 * Crew branch truss-x holds two commits (a, b). A fresh BLOCKED branch is left on that old head, and a BLOCKED branch forks from it
 * and gets a hand-made commit. Then truss-x is rebuilt from main (`extra` commits first, then a and b again with other messages, so
 * the patches stay and no old commit is an ancestor of it), and the hand-made commit is cherry-picked onto it.
 */
function rewritten(extra: string[]) {
  const { env, wt } = runningWorld('x')
  putFile(wt, 'crew/a.txt', 'a\n', 'crew a')
  putFile(wt, 'crew/b.txt', 'b\n', 'crew b')
  const old = head(wt)
  git(wt, ['branch', 'member-fresh', old])
  git(wt, ['checkout', '-q', '-b', 'member-hand', old])
  const hand = putFile(wt, 'members/hand.txt', 'hand\n', 'member hand work')
  git(wt, ['checkout', '-q', '--detach', 'main'])
  for (const e of extra) putFile(wt, `crew/${e}.txt`, `${e}\n`, `rebuilt ${e}`)
  putFile(wt, 'crew/a.txt', 'a\n', 'rebuilt a')
  putFile(wt, 'crew/b.txt', 'b\n', 'rebuilt b')
  git(wt, ['branch', '-f', 'truss-x', 'HEAD'])
  git(wt, ['checkout', '-q', 'truss-x'])
  git(wt, ['cherry-pick', hand])
  assert.equal(gitStatus(wt, ['merge-base', '--is-ancestor', old, 'truss-x']), 1, 'precondition: the old head is not an ancestor of the rewritten crew branch')
  assert.equal(gitStatus(wt, ['merge-base', '--is-ancestor', 'member-hand', 'truss-x']), 1, 'precondition: the hand branch is not an ancestor either')
  const run = deadRun(env, 'wf_i42', [
    { label: 'x-builder', result: member('t-fresh', 'member-fresh') },
    { label: 'x-builder-2', result: member('t-hand', 'member-hand') },
  ])
  return env.run('start', { slug: 'x', resume: 'answers', transcript: run.dir, answers: answersFile([]) })
}

test('i42 1: after a reword rewrite of the crew branch, a fresh BLOCKED branch on the old head is not done and its task re-runs; a hand-made commit held by the crew branch is done', () => {
  const r = rewritten([])
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(names(entryOf(r).done), ['t-hand'], say(r))
})

test('i42 2: after a split rewrite (the crew branch rebuilt as more, smaller commits), a fresh BLOCKED branch on the old head is not done; a hand-made commit held by the crew branch is done', () => {
  const r = rewritten(['split1', 'split2'])
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(names(entryOf(r).done), ['t-hand'], say(r))
})

// ---------------------------------------------------------------------------------------------------------------
// item 43: a TAP failure block ends at its YAML `...` or at the plan/summary line

const ENV_LINE = 'Error: browserType.launch: Host system is missing dependencies to run browsers.'
const CODE_YAML = ['not ok 1 - code case', '  ---', '  duration_ms: 1.5', "  error: 'expected 1 to equal 2'", '  code: ERR_ASSERTION', '  ...']

function checkOf(text: string, expect = 'red', exit = 1) {
  const env = mkEnv({ config: CFG })
  const f = `${tmp('f4-out-')}/out.txt`
  writeFileSync(f, text)
  writePlan(env.dir, planObj([crew('s', { acceptanceTest: `cat '${f}'; exit ${exit}`, status: 'running' })]))
  const res = env.run('check', { slug: 's', cwd: env.repo, expect })
  const rec = JSON.parse(readFileSync(`${env.dir}/checks/s-1.json`, 'utf8'))
  return { res, rec }
}

test('i43 1: a code failure followed by an env line after the YAML `...` gives envSeen and no env', () => {
  const text = ['TAP version 13', ...CODE_YAML, ENV_LINE, '1..1', '# tests 1', '# fail 1'].join('\n') + '\n'
  const { res, rec } = checkOf(text)
  assert.equal(res.status, 0, say(res))
  assert.ok(!Object.hasOwn(rec, 'env'), JSON.stringify(rec))
  assert.equal(rec.envSeen, ENV_LINE)
})

test('i43 2: a code failure followed by an env line after the `1..N` plan and `# tests` summary gives envSeen and no env', () => {
  const text = ['TAP version 13', 'not ok 1 - code case', '1..1', '# tests 1', '# fail 1', ENV_LINE].join('\n') + '\n'
  const { res, rec } = checkOf(text)
  assert.equal(res.status, 0, say(res))
  assert.ok(!Object.hasOwn(rec, 'env'), JSON.stringify(rec))
  assert.equal(rec.envSeen, ENV_LINE)
})

test('i43 3: with a passing case first, an env line after the last failure\'s `# tests` line still gives envSeen and no env', () => {
  const text = ['TAP version 13', 'ok 1 - fine', ...CODE_YAML.map((l) => l.replace('not ok 1', 'not ok 2')), '1..2', '# tests 2', '# pass 1', '# fail 1', ENV_LINE].join('\n') + '\n'
  const { res, rec } = checkOf(text)
  assert.equal(res.status, 0, say(res))
  assert.ok(!Object.hasOwn(rec, 'env'), JSON.stringify(rec))
  assert.equal(rec.envSeen, ENV_LINE)
})

test('control 13: a real env failure inside the YAML `error:` still gives env, with a plan and summary after it', () => {
  const text = ['TAP version 13', 'not ok 1 - env case', '  ---', '  duration_ms: 1.5', `  error: '${ENV_LINE}'`, '  code: ERR_X', '  ...', '1..1', '# tests 1', '# fail 1'].join('\n') + '\n'
  const { res, rec } = checkOf(text)
  assert.equal(res.status, 1, say(res))
  assert.match(String(rec.env), /Host system is missing dependencies/)
  assert.ok(!Object.hasOwn(rec, 'envSeen'), JSON.stringify(rec))
})

test('control 14: i34 Playwright headers with no project, one code failure and one browser-launch env failure, give envSeen and no env', () => {
  const out = [
    'Running 5 tests using 2 workers', '',
    '  1) a.spec.ts:3:5 › api ──────────────────────────', '', '    Error: expect(received).toBe(expected) // Object.is equality', '', '    Expected: 1', '    Received: 2', '',
    '  2) b.spec.ts:7:5 › launch ──────────────────────────', '', `    ${ENV_LINE}`, '    Call log:', '      - <launching> /x/webkit/pw_run.sh', '',
    '  2 failed', '  3 passed (4.0s)',
  ].join('\n') + '\n'
  const { res, rec } = checkOf(out)
  assert.equal(res.status, 0, say(res))
  assert.ok(!Object.hasOwn(rec, 'env'), JSON.stringify(rec))
  assert.equal(rec.envSeen, ENV_LINE)
})

// ---------------------------------------------------------------------------------------------------------------
// item 44: integrate's `contained` shortcut needs no merge in progress

function crewEnv() {
  const env = mkEnv({ config: CFG, files: { 'a.txt': 'base\n' } })
  writePlan(env.dir, planObj([crew('s', { owns: ['src/s/**'], status: 'running' })]))
  const wt = addCrewWorktree(env.repo, 's')
  return { env, wt }
}
function memberWt(env: any, name: string): string {
  git(env.repo, ['branch', name, 'truss-s'])
  const mw = `${tmp('f4-member-')}/m`
  git(env.repo, ['worktree', 'add', '-q', mw, name])
  git(mw, ['config', 'user.name', 'T'])
  git(mw, ['config', 'user.email', 't@example.invalid'])
  return mw
}
/** A branch of one commit (a.ts, b.ts) and a crew head holding the same files as two split commits, so the head's tree already holds it. */
function heldBranch(env: any, wt: string): void {
  const mw = memberWt(env, 'member-old')
  putFile(mw, 'src/s/a.ts', 'a\n')
  putFile(mw, 'src/s/b.ts', 'b\n')
  git(mw, ['add', '--', 'src/s/a.ts', 'src/s/b.ts'])
  git(mw, ['commit', '-q', '-m', 'member both\n\nTruss-Crew: s\nTruss-Role: builder'])
  putFile(wt, 'src/s/a.ts', 'a\n', 'split a')
  putFile(wt, 'src/s/b.ts', 'b\n', 'split b')
}
const mergeHead = (wt: string): number => gitStatus(wt, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])

test('i44 1: while a conflicted merge is in progress in the crew worktree, integrate of a branch the head already holds never answers contained: true', () => {
  const { env, wt } = crewEnv()
  const mc = memberWt(env, 'member-conf')
  putFile(mc, 'a.txt', 'member side\n', 'member edit\n\nTruss-Crew: s\nTruss-Role: builder')
  putFile(wt, 'a.txt', 'crew side\n', 'crew edit')
  heldBranch(env, wt)
  const first = env.run('integrate', { slug: 's', branch: 'member-conf' })
  assert.equal(first.status, 1, say(first))
  assert.equal(mergeHead(wt), 0, 'precondition: the merge is in progress')
  const tip = head(wt)
  const res = env.run('integrate', { slug: 's', branch: 'member-old' })
  assert.notEqual(res.json?.contained, true, say(res))
  assert.equal(mergeHead(wt), 0, 'the merge is still in progress')
  assert.equal(head(wt), tip, 'no commit was made')
})

test('control 15: with no merge in progress, integrate of a branch the head already holds still answers contained and leaves the head alone', () => {
  const { env, wt } = crewEnv()
  heldBranch(env, wt)
  const tip = head(wt)
  const res = env.run('integrate', { slug: 's', branch: 'member-old' })
  assert.equal(res.status, 0, say(res))
  assert.deepEqual(res.json, { merged: true, contained: true, head: tip }, say(res))
  assert.equal(head(wt), tip)
  assert.notEqual(mergeHead(wt), 0, 'no merge in progress')
})

// ---------------------------------------------------------------------------------------------------------------
// prior: a stopped member's own commits reach its resumed successor

test('prior 1: start --resume answers lists in entry.prior the branch of a QUESTION member with commits the crew branch lacks, and not one whose commits the crew branch already holds', () => {
  const { env, wt } = runningWorld('x')
  putFile(wt, 'crew/a.txt', 'a\n', 'crew a')
  const crewHead = head(wt)
  git(wt, ['checkout', '-q', '-b', 'member-q', crewHead])
  putFile(wt, 'members/q.txt', 'q\n', 'member q work')
  git(wt, ['checkout', '-q', '-b', 'member-held', crewHead])
  const held = putFile(wt, 'members/held.txt', 'held\n', 'member held work')
  git(wt, ['checkout', '-q', 'truss-x'])
  git(wt, ['cherry-pick', held])
  const run = deadRun(env, 'wf_prior', [
    { label: 'x-builder', result: member('t-q', 'member-q', 'QUESTION') },
    // CHECKPOINT never makes a task done, so only the prior rule itself keeps this cherry-picked branch out
    { label: 'x-builder-2', result: member('t-held', 'member-held', 'CHECKPOINT') },
  ])
  const r = env.run('start', { slug: 'x', resume: 'answers', transcript: run.dir, answers: answersFile([]) })
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(entryOf(r).prior, [{ at: 't-q', branch: 'member-q' }], say(r))
})

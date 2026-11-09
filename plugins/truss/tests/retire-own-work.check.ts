// @ts-nocheck
// truss retires every worktree and branch it creates, so /tidy never judges truss's own leftovers (ADR-0030 retirement reused):
// 1 a merged crew's own branch truss-<slug> and worktree go after finish and after land; 2 plan-write retires its plan run's
// worktrees; 3 the known scratch dirs .truss-scratch/ (and legacy .plan-scratch/) are excluded and never keep a worktree;
// 4 finish retires a terminal crew's members from an earlier run of that crew that no finish recorded (a stopped run the crew
// resumed from); 5 the run skill keeps a tip by an archive ref, never a backup branch.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import * as reg from '../hooks/register.ts'
import { ARCHIVE_PREFIX, worktreeChanges } from '../bin/factory.ts'
import { REAL_PLUGIN, addCrewWorktree, appendEvent, crew, factorySpawn, git, gitStatus, head, mkEnv, mkRun, planObj, putFile, qcReport, readEvents, tmp, validateEvent, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

const CFG = { merge: 'sequential', target: 'main' }
const RUN = 'wf_r0new000-aaa'
const OLD = 'wf_r0old000-bbb'
const PLAN = 'wf_r0plan00-ccc'
const say = (r) => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 900)}; stderr ${String(r.stderr).slice(0, 300)}`
const branchExists = (repo, b) => gitStatus(repo, ['rev-parse', '--verify', '-q', `refs/heads/${b}`]) === 0
const refSha = (repo, ref) => git(repo, ['rev-parse', '--verify', '-q', ref], true)
const retires = (env) => readEvents(env.dir).filter((e) => e.event === 'retire')
const wfPath = (env, name) => `${env.repo}/.claude/worktrees/${name}`

function patchId(cwd, base, hd) {
  const [diffCmd, idCmd] = reg.PATCH_COMMAND.split(' | ').map((s) => s.replace('<base>', base).replace('<head>', hd).split(' '))
  const d = spawnSync(diffCmd[0], diffCmd.slice(1), { cwd, encoding: 'utf8' })
  const p = spawnSync(idCmd[0], idCmd.slice(1), { cwd, input: d.stdout, encoding: 'utf8' })
  return reg.patchIdOf(p.stdout)
}
// A worktree <name> on branch worktree-<name>, forked from `from`, with one commit of its own when `commit` is set.
function member(env, name, from, commit) {
  const p = wfPath(env, name)
  git(env.repo, ['worktree', 'add', '-q', '-b', `worktree-${name}`, p, from])
  git(p, ['config', 'user.name', 'T'])
  git(p, ['config', 'user.email', 't@e.invalid'])
  if (commit !== undefined) putFile(p, `src/s/${commit}.ts`, `${commit}\n`, commit)
  return p
}
const agent = (label, cwd, over = {}) => ({ label, agentType: 'general-purpose', metaModel: 'sonnet', model: 'claude-sonnet-5-5', effort: 'medium', result: 'built it', ...(cwd === undefined ? {} : { cwd }), ...over })

// Crew s (running, red record, QC PASS) merged by finish of run RUN. `members(env)` adds worktrees and returns the agents of RUN
// besides s-qc; `old(env)` may write an earlier run of the crew (no spawn events: no finish ever recorded it).
function world(o = {}) {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew('s', { status: 'running' })], { approvedAt: '2026-10-01T00:00:00.000Z' }))
  appendEvent(env.dir, factorySpawn('s', new Date(Date.now() - 3 * 3600_000).toISOString()))
  const wt = addCrewWorktree(env.repo, 's')
  putFile(wt, 'src/s/a.ts', 's\n', 'work')
  const runAgents = o.members?.(env) ?? []
  o.old?.(env)
  putFile(wt, 'src/s/final.ts', 'final\n', 'final')
  const base = git(wt, ['merge-base', 'main', 'HEAD'])
  const hd = head(wt)
  mkdirSync(`${env.dir}/checks`, { recursive: true })
  writeFileSync(`${env.dir}/checks/s-1.json`, JSON.stringify({ command: 'true', exit: 1, head: hd, tail: '' }))
  const qc = agent('s-qc', undefined, { agentType: 'truss:qc-engineer', metaModel: 'opus', model: 'claude-opus-5-5', result: qcReport({ head: hd, patch: patchId(wt, base, hd) }) })
  const run = mkRun(env.transcripts, RUN, [...runAgents, qc])
  const resFile = `${env.dir}/result.json`
  writeFileSync(resFile, JSON.stringify([{ slug: 's', state: 'passed', head: hd, base, qc: 's-qc' }]))
  return { env, wt, finish: () => env.run('finish', { transcript: run.dir, result: resFile }) }
}

test('fix 1: finish retires the merged crew\'s own branch truss-<slug> and its worktree', () => {
  const w = world()
  const r = w.finish()
  assert.deepEqual(r.json?.merged, ['s'], say(r))
  assert.ok(!existsSync(w.wt), 'the crew worktree is gone')
  assert.ok(!branchExists(w.env.repo, 'truss-s'), `truss-s must be deleted: ${say(r)}`)
  const ev = retires(w.env).find((e) => e.branch === 'truss-s')
  assert.equal(ev?.reason, 'merged', JSON.stringify(retires(w.env)))
  assert.equal(ev.archive, null, 'the target holds the tip: no archive')
  assert.deepEqual(validateEvent(ev), [])
})

test('fix 1: land retires a solo crew\'s own branch truss-<slug> and its worktree', () => {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew('a', { status: 'running', process: 'solo' })], { version: 4 }))
  writeGoal(env.dir, 'a')
  const wt = addCrewWorktree(env.repo, 'a')
  putFile(wt, 'src/a/a.ts', 'a\n', 'work a')
  const r = env.run('land', { slug: 'a' })
  assert.equal(r.json?.merged, true, say(r))
  assert.ok(!existsSync(wt), 'the crew worktree is gone')
  assert.ok(!branchExists(env.repo, 'truss-a'), `truss-a must be deleted: ${say(r)}`)
  assert.equal(retires(env).find((e) => e.branch === 'truss-a')?.reason, 'merged', JSON.stringify(retires(env)))
})

const PLAN_JSON = JSON.stringify(planObj([crew('arch', { stage: 0, verdict: 'design' })], { approval: 'client', approvedAt: null }), null, 2)
const planMessage = `Here is the plan.\n\n\`\`\`\`json plan.json\n${PLAN_JSON}\n\`\`\`\`\n\n\`\`\`\`markdown plan.md\n# The plan\n\`\`\`\`\n`

test('fix 2 and 3: plan-write retires its plan run\'s worktrees, archiving a tip the target lacks; scratch never keeps one', () => {
  const env = mkEnv({ config: CFG })
  const committed = member(env, `${PLAN}-1`, 'main', 'p1')
  const tip = head(committed)
  const scratch = member(env, `${PLAN}-2`, 'main')
  mkdirSync(`${scratch}/.plan-scratch`, { recursive: true })
  writeFileSync(`${scratch}/.plan-scratch/plan.json`, '{}\n')
  mkdirSync(`${scratch}/.truss-scratch`, { recursive: true })
  writeFileSync(`${scratch}/.truss-scratch/plan.md`, '# draft\n')
  const other = member(env, 'wf_r0else00-ddd-1', 'main', 'e1')
  const { dir } = mkRun(env.transcripts, PLAN, [{ id: 'aarch', label: 'truss-designer', agentType: 'truss:design-engineer', metaModel: 'opus', result: planMessage, cwd: committed }])
  const r = env.run('plan-write', { transcript: dir, label: 'truss-designer' })
  assert.equal(r.json?.written, true, say(r))
  for (const n of [1, 2]) {
    assert.ok(!existsSync(wfPath(env, `${PLAN}-${n}`)), `${PLAN}-${n} must be removed: ${say(r)}`)
    assert.ok(!branchExists(env.repo, `worktree-${PLAN}-${n}`), `worktree-${PLAN}-${n} must be deleted`)
  }
  assert.equal(refSha(env.repo, `${ARCHIVE_PREFIX}/${PLAN}/worktree-${PLAN}-1`), tip, 'the designer\'s commit is archived')
  assert.ok(existsSync(other) && branchExists(env.repo, 'worktree-wf_r0else00-ddd-1'), 'another run\'s worktree stays')
  for (const e of retires(env)) assert.deepEqual(validateEvent(e), [], JSON.stringify(e))
})

test('fix 3: scratch dirs are excluded in the git common dir, idempotently, and are not real work', () => {
  const env = mkEnv({ config: CFG })
  const brief = `${tmp('r0-brief-')}/brief.md`
  writeFileSync(brief, 'goal\n')
  for (let i = 0; i < 2; i++) assert.equal(env.run('plan-args', { 'brief-file': brief }).status, 0)
  const common = path.resolve(env.repo, git(env.repo, ['rev-parse', '--git-common-dir']))
  const lines = readFileSync(`${common}/info/exclude`, 'utf8').split('\n')
  assert.equal(lines.filter((l) => l === '.truss-scratch/').length, 1, lines.join('|'))
  assert.equal(lines.filter((l) => l === '.plan-scratch/').length, 1, lines.join('|'))
  const fresh = mkEnv({ config: CFG })
  const p = member(fresh, 'wf_r0scr000-eee-1', 'main')
  mkdirSync(`${p}/.plan-scratch`, { recursive: true })
  writeFileSync(`${p}/.plan-scratch/plan.json`, '{}\n')
  mkdirSync(`${p}/.truss-scratch/deep`, { recursive: true })
  writeFileSync(`${p}/.truss-scratch/deep/out.txt`, 'x\n')
  assert.deepEqual(worktreeChanges(p, fresh.repo).real, [])
  writeFileSync(`${p}/notes.txt`, 'unsaved\n')
  assert.deepEqual(worktreeChanges(p, fresh.repo).real, ['notes.txt'], 'any other untracked file is still real')
})

test('fix 4: finish retires the members of an earlier, never-finished run the merged crew resumed from, archiving unmerged tips', () => {
  let tip = ''
  const w = world({
    old: (env) => {
      const p = member(env, `${OLD}-18`, 'truss-s', 'o18')
      putFile(p, 'src/s/o18b.ts', 'b\n', 'o18b')
      tip = head(p)
      mkRun(env.transcripts, OLD, [agent('s-builder', p), agent('s-planner', undefined, { result: 'PROPOSAL: x' })])
    },
  })
  const r = w.finish()
  assert.deepEqual(r.json?.merged, ['s'], say(r))
  assert.ok(!existsSync(wfPath(w.env, `${OLD}-18`)), `the stopped run's member must be removed: ${say(r)}`)
  assert.ok(!branchExists(w.env.repo, `worktree-${OLD}-18`))
  assert.equal(refSha(w.env.repo, `${ARCHIVE_PREFIX}/${OLD}/worktree-${OLD}-18`), tip)
  assert.equal(retires(w.env).find((e) => e.branch === `worktree-${OLD}-18`)?.reason, 'superseded')
})

test('fix 5: the run skill keeps a tip by an archive ref, never a backup branch', () => {
  const text = readFileSync(`${REAL_PLUGIN}/skills/run/SKILL.md`, 'utf8')
  assert.match(text, /[Nn]ever keep a backup branch/)
  assert.match(text, /git update-ref refs\/truss\/archive\/<run>\/<name> <sha>/)
})

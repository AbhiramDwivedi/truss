// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0021 "Seams to pin" (cs): the contract compose-runtime turns green. Written from the spec before the build.
//
// Run with: node --test tests/compose-runtime-contract.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs.
//
// Case prefixes: `cs N:` pins stage.js; `cf N:` pins factory.ts (added by a later task, below the cf marker).
// `control:` cases pass on today's code and prove the harness loaded and ran the script.
// stage.js runs as an AsyncFunction with a stubbed Workflow runtime. A case never matches the script's source text.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { gatesAware } from './fixtures/gates-stub.ts'
import { fileURLToPath } from 'node:url'
import * as reg from '../hooks/register.ts'
import { addCrewWorktree, appendEvent, crew, factorySpawn, git, gitStatus, head, mkEnv, mkRun, planObj, putFile, qcReport, readEvents, runCli, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')
const STAGE = `${PLUGIN}/workflows/stage.js`
const t = (name, fn) => test(name, { timeout: 20000 }, fn)

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

// ---------------------------------------------------------------- shared stage harness (cs and cf cases reuse it)

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const tick = () => new Promise((r) => setImmediate(r))
const rj = (obj, exit = 0) => ({ exit, stdout: JSON.stringify(obj) })

// Runs stage.js with scripted members. o.labels maps an agent label to a report (or a function of the call); null is "no report".
// o.runner(ctx) may return a runner reply, or undefined for the default. Returns result, error, calls, logs, labels.
async function exec(args, o = {}) {
  if (!existsSync(STAGE)) throw new Error(`script missing: ${STAGE}`)
  const body = readFileSync(STAGE, 'utf8').replace(/^\s*export\s+const\s+meta\b/m, 'const meta')
  const calls = []
  const unscripted = []
  const counters = {}
  const logs = []
  const agent = gatesAware(async (prompt, opts = {}) => {
    const call = { prompt, opts, label: opts.label, i: calls.length }
    calls.push(call)
    await tick()
    if (/-runner(-\d+)?$/.test(String(opts.label))) {
      const mh = prompt.match(/factory\.ts\s+heavy\b([^\n`]*)/)
      let m
      if (mh) {
        const cut = mh[1].indexOf(' -- ')
        m = cut >= 0 ? mh[1].slice(cut + 4).match(/factory\.ts\s+(check|integrate|owns-check|tests-check|sync)\b([^\n`]*)/) : null
      } else {
        m = prompt.match(/factory\.ts\s+(admit|reap|check|integrate|owns-check|tests-check|sync|decision-checkpoint|crew-learned|knowledge-commit|knowledge-lint|decision-ack|decisions)\b([^\n`]*)/)
      }
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
      const n = (counters[name] = (counters[name] ?? -1) + 1)
      let out = o.runner ? await o.runner({ cmd, key, slug, expect, branch, n, prompt, call }) : undefined
      if (out === undefined) {
        const plain = expect === 'red' ? { ok: true } : { ok: true, head: HEAD }
        out =
          cmd === 'admit' ? rj({ admitted: true, parallelism: 4, running: 0, freeMB: 8000, minFreeMB: 2048 }) : cmd === 'reap' ? rj({ reaped: [], skipped: [] }) : cmd === 'check' ? rj(mh ? { ...plain, heavy: { label: `${slug}-check`, waitedMs: 0, exit: 0 } } : plain) : cmd === 'integrate' ? rj({ merged: true }) : cmd === 'owns-check' ? rj({ ok: true, outside: [] }) : cmd === 'tests-check' ? rj({ ok: true, tests: [] }) : rj({ merged: true })
      }
      await tick()
      return out
    }
    const labels = o.labels ?? {}
    if (!Object.hasOwn(labels, opts.label)) {
      unscripted.push(String(opts.label))
      throw new Error(`unscripted label: ${opts.label}`)
    }
    const h = labels[opts.label]
    const v = typeof h === 'function' ? await h(call, calls) : h
    await tick()
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
  const log = (m) => logs.push(String(m))
  let result
  let error
  try {
    result = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'allowance', body)(agent, parallel, pipeline, () => {}, log, structuredClone(args), {})
  } catch (e) {
    error = e
  }
  return { result, error, calls, unscripted, logs, labels: calls.map((c) => c.label).filter((l) => !/-runner(-\d+)?$/.test(String(l))) }
}

const HEAD = 'a1'.repeat(20)
const BASE = 'd4'.repeat(20)
const PASS = `VERDICT: PASS\n\n## Proof checked\nHead: ${HEAD}\nPatch: ${'e5'.repeat(20)}\n`
const T1 = { name: 'write-tests', role: 'tester', effort: 'medium', files: ['tests/a.check.ts'], reads: ['src/a.ts'], brief: 'BRIEF-T1: write the tests for a', after: [] }
const B1 = { name: 'build-it', role: 'builder', effort: 'medium', files: ['src/a.ts'], reads: ['tests/a.check.ts'], brief: 'BRIEF-B1: build a', after: ['write-tests'] }
const PLAN = (...tasks) => ({ tasks: tasks.length ? tasks : [T1, B1], stop: null })
const done = (branch, proof = 'PROOF-' + branch) => ({ task: 'whatever', marker: 'DONE', branch, commit: 'c0'.repeat(20), proof, text: 'finished ' + branch })
const marked = (marker, text, branch = 'feat/x') => ({ task: 'whatever', marker, branch, commit: 'c0'.repeat(20), proof: '', text })

const entry = (slug = 'a', o = {}) => ({
  slug, stage: 1, goalFile: `/proj/.truss/goals/${slug}.md`, goal: 'GOAL-TEXT', owns: ['src/**', 'tests/*.ts'],
  acceptanceTest: 'node --test tests/a.check.ts', highImpact: ['src/core/**'], stressTest: false, scope: 'SCOPE-VERBATIM: build a, nothing else',
  worktree: `/wt/${slug}`, branch: `truss/${slug}`, base: BASE, architecture: '/proj/docs/ARCH.md', adrs: ['/proj/docs/adr/0001-x.md'],
  resume: null, tasks: [], done: [], answers: [], spent: 0, labelFrom: {}, ...o,
})
const base = (slug = 'a', over = {}) => ({
  [`${slug}-planner`]: PLAN(), [`${slug}-tester`]: done('feat/t', 'PROOF-T'), [`${slug}-builder`]: done('feat/b', 'PROOF-B'), [`${slug}-qc`]: PASS, ...over,
})
const stageArgs = (crews, o = {}) => ({
  truss: { kind: 'stage', dir: '/proj/.truss', repo: '/proj', plugin: PLUGIN, target: 'main', reworkAllowance: o.reworkAllowance ?? 2, roles: o.roles ?? ROLES, scriptPath: STAGE, crews },
})
async function runStage(crews, o = {}) {
  const r = await exec(stageArgs(crews, o), o)
  assert.deepEqual(r.unscripted, [], `unscripted label(s): ${r.unscripted.join(', ')}`)
  if (r.error) throw r.error
  r.res = r.result
  return r
}
const call = (r, label) => r.calls.find((c) => c.label === label)
const had = (r, label) => r.calls.some((c) => c.label === label)
const has = (s, sub) => assert.ok(s.includes(sub), `missing ${JSON.stringify(sub)} in:\n${s.slice(0, 2500)}`)
const READ_COMMITS = "Read the branch's commits before you start."
const NO_REPORT = 'A member before you returned no report.'

// ---------------------------------------------------------------- control: today's code, proves the harness ran stage.js

t('control: a CHECKPOINT then DONE passes the crew with one restart member, and the planner and QC ran', async () => {
  const r = await runStage([entry('a')], { labels: base('a', { 'a-tester': marked('CHECKPOINT', 'CHECKPOINT-NOTE: halfway', 'feat/t'), 'a-tester-2': done('feat/t2') }) })
  assert.equal(r.res[0].state, 'passed', JSON.stringify(r.res[0]))
  has(call(r, 'a-tester-2').prompt, 'CHECKPOINT-NOTE: halfway')
  assert.ok(had(r, 'a-planner') && had(r, 'a-qc'))
})
t('control: reworkAllowance 1 and two CHECKPOINTs stop BLOCKED at the task with no builder', async () => {
  const r = await runStage([entry('a')], { reworkAllowance: 1, labels: base('a', { 'a-tester': marked('CHECKPOINT', 'one'), 'a-tester-2': marked('CHECKPOINT', 'two') }) })
  assert.equal(r.res[0].state, 'stopped', JSON.stringify(r.res[0]))
  assert.equal(r.res[0].tag, 'BLOCKED')
  assert.equal(r.res[0].at, 'write-tests')
  assert.ok(!had(r, 'a-builder'))
})

// ---------------------------------------------------------------- cs: stage.js restarts (ADR-0021 Seams to pin, cs)

t('cs 1: reworkAllowance 2 allows two restarts after CHECKPOINTs, each successor carrying the previous note', async () => {
  const r = await runStage([entry('a')], { reworkAllowance: 2, labels: base('a', { 'a-tester': marked('CHECKPOINT', 'NOTE-ONE', 'feat/t'), 'a-tester-2': marked('CHECKPOINT', 'NOTE-TWO', 'feat/t'), 'a-tester-3': done('feat/t3') }) })
  assert.equal(r.res[0].state, 'passed', `a third member should have run after two CHECKPOINTs: ${JSON.stringify(r.res[0])}`)
  has(call(r, 'a-tester-2').prompt, 'NOTE-ONE')
  has(call(r, 'a-tester-3').prompt, 'NOTE-TWO')
})
t('cs 2: every restart successor is told to read the branch commits and names the predecessor branch', async () => {
  const r = await runStage([entry('a')], { reworkAllowance: 2, labels: base('a', { 'a-tester': marked('CHECKPOINT', 'NOTE-ONE', 'feat/pred'), 'a-tester-2': done('feat/t2') }) })
  const p = call(r, 'a-tester-2').prompt
  has(p, READ_COMMITS)
  has(p, 'feat/pred')
})
t('cs 3: a member with no report restarts a successor that is told no report came and to read the commits', async () => {
  const r = await runStage([entry('a')], { reworkAllowance: 2, labels: base('a', { 'a-tester': null, 'a-tester-2': done('feat/t2') }) })
  assert.equal(r.res[0].state, 'passed', `a missing report should restart, not stop: ${JSON.stringify(r.res[0])}`)
  const p = call(r, 'a-tester-2').prompt
  has(p, NO_REPORT)
  has(p, READ_COMMITS)
})
t('cs 4: running out of restarts is BLOCKED at the task name with text "restarts spent:" naming the last label and reason', async () => {
  const r = await runStage([entry('a')], { reworkAllowance: 0, labels: base('a', { 'a-tester': marked('CHECKPOINT', 'one'), 'a-tester-2': marked('CHECKPOINT', 'two') }) })
  const s = r.res[0]
  assert.equal(s.state, 'stopped', JSON.stringify(s))
  assert.equal(s.tag, 'BLOCKED')
  assert.equal(s.at, 'write-tests')
  assert.ok(s.text.startsWith('restarts spent:'), `text should start with "restarts spent:", got ${JSON.stringify(s.text)}`)
  has(s.text, 'a-tester-2')
  has(s.text, 'CHECKPOINT')
  assert.ok(!had(r, 'a-tester-3'), 'max(1, 0) = 1 restart, so no third member')
})
t('cs 5: reworkAllowance 1 and a missing report twice is BLOCKED with "restarts spent:" naming the last label and "no report"', async () => {
  const r = await runStage([entry('a')], { reworkAllowance: 1, labels: base('a', { 'a-tester': null, 'a-tester-2': null }) })
  const s = r.res[0]
  assert.equal(s.state, 'stopped', JSON.stringify(s))
  assert.equal(s.tag, 'BLOCKED')
  assert.ok(s.text.startsWith('restarts spent:'), `text should start with "restarts spent:", got ${JSON.stringify(s.text)}`)
  has(s.text, 'a-tester-2')
  has(s.text, 'no report')
  assert.ok(!had(r, 'a-tester-3'))
})
t('cs 6: each restart is logged as "restart: crew <slug>, label <label>, n <n>, reason <reason>" counting n from 1', async () => {
  const r = await runStage([entry('a')], { reworkAllowance: 2, labels: base('a', { 'a-tester': marked('CHECKPOINT', 'one'), 'a-tester-2': null, 'a-tester-3': done('feat/t3') }) })
  const lines = r.logs.filter((l) => l.startsWith('restart:'))
  assert.deepEqual(lines, ['restart: crew a, label a-tester, n 1, reason CHECKPOINT', 'restart: crew a, label a-tester-2, n 2, reason no report'])
})
t('cs 7: restarts add no rework spend, so an integrate failure after two restarts still gets its one rework', async () => {
  const r = await runStage([entry('a')], {
    reworkAllowance: 2,
    labels: base('a', { 'a-tester': marked('CHECKPOINT', 'one'), 'a-tester-2': marked('CHECKPOINT', 'two'), 'a-tester-3': done('feat/t3'), 'a-resolver': done('feat/r') }),
    runner: ({ key, n }) => (key === 'integrate:feat/t3' && n === 0 ? rj({ merged: false, conflicts: ['x'] }) : undefined),
  })
  assert.equal(r.res[0].state, 'passed', `two restarts then one rework should pass: ${JSON.stringify(r.res[0])}`)
  assert.ok(had(r, 'a-resolver'))
})
t('cs 8: the planner prompt loads the split-work skill before splitting work', async () => {
  const r = await runStage([entry('a')], { labels: base('a') })
  has(call(r, 'a-planner').prompt, 'Load the `subagent-limits:split-work` skill before splitting work.')
})

// ---------------------------------------------------------------- cf: factory.ts (ADR-0021 Seams to pin, cf)
// Runs bin/factory.ts through its CLI against temp git repos and temp truss dirs (harness mkEnv). The live truss dir is never touched.

const APPROVED = '2026-10-01T00:00:00.000Z'
const CFG = { merge: 'sequential', target: 'main' }
const RUN = 'wf_e804087f-eaa'
const OTHER = 'wf_0dff946d-af1'
const say = (r) => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 700)}; stderr ${String(r.stderr).slice(0, 300)}`
const gitOut = (cwd, args) => git(cwd, args, true)

function patchId(cwd, base, hd) {
  const [diffCmd, idCmd] = reg.PATCH_COMMAND.split(' | ').map((s) => s.replace('<base>', base).replace('<head>', hd).split(' '))
  const d = spawnSync(diffCmd[0], diffCmd.slice(1), { cwd, encoding: 'utf8' })
  const p = spawnSync(idCmd[0], idCmd.slice(1), { cwd, input: d.stdout, encoding: 'utf8' })
  return reg.patchIdOf(p.stdout)
}

/** Rewrites journal.jsonl so each agent's `started` line is followed by its `result` line (the order a real run writes), in agent order. */
function interleave(runDir) {
  const lines = readFileSync(`${runDir}/journal.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const out = [lines.find((l) => l.type === 'launched')]
  for (const s of lines.filter((l) => l.type === 'started')) {
    out.push(s)
    for (const r of lines.filter((l) => l.type === 'result' && l.agentId === s.agentId)) out.push(r)
  }
  writeFileSync(`${runDir}/journal.jsonl`, out.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

/** One finish world: crew `s` running with a commit and a red record, run `runId` holding `extra` agents plus a builder and a passing qc. */
function finishWorld(o = {}) {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew('s', { status: 'running' })], { approvedAt: APPROVED }))
  appendEvent(env.dir, factorySpawn('s', new Date(Date.now() - 3 * 3600_000).toISOString()))
  const wt = addCrewWorktree(env.repo, 's')
  putFile(wt, 'src/s/a.ts', 's\n', 'work')
  const base = git(wt, ['merge-base', 'main', 'HEAD'])
  const hd = head(wt)
  const patch = patchId(wt, base, hd)
  mkdirSync(`${env.dir}/checks`, { recursive: true })
  writeFileSync(`${env.dir}/checks/s-1.json`, JSON.stringify({ command: 'true', exit: 1, head: hd, tail: '' }))
  const mk = (label, over = {}) => ({ label, agentType: 'general-purpose', metaModel: 'sonnet', model: 'claude-sonnet-5-5', effort: 'medium', result: 'built it', ...over })
  const qc = { label: 's-qc', agentType: 'truss:qc-engineer', metaModel: 'opus', model: 'claude-opus-5-5', effort: 'medium', result: qcReport({ head: hd, patch }) }
  const agents = [...(o.agents ?? [mk('s-builder')]), qc]
  const run = mkRun(env.transcripts, o.runId ?? RUN, agents)
  if (o.interleave) interleave(run.dir)
  const resFile = `${env.dir}/result.json`
  writeFileSync(resFile, JSON.stringify([{ slug: 's', state: 'passed', head: hd, base, qc: 's-qc' }]))
  return { env, wt, run, finish: () => env.run('finish', { transcript: run.dir, result: resFile }) }
}

/** A real `git worktree add -b <branch> <repo>/.claude/worktrees/<name>` on main; returns its path. */
function addWf(w, name, branch = `worktree-${name}`, from = 'main') {
  const p = `${w.env.repo}/.claude/worktrees/${name}`
  git(w.env.repo, ['worktree', 'add', '-q', '-b', branch, p, from])
  git(p, ['config', 'user.name', 'T'])
  git(p, ['config', 'user.email', 't@e.invalid'])
  return p
}
const branchExists = (w, b) => gitStatus(w.env.repo, ['rev-parse', '--verify', '-q', `refs/heads/${b}`]) === 0
const left = (j) => (Array.isArray(j.leftWorktrees) ? j.leftWorktrees : [])
const leftOf = (j, name) => left(j).find((x) => String(x.path).endsWith(`/${name}`))

// ---- control: today's code, proves the harness ran bin/factory.ts

t('control: finish merges a clean crew and exits 0 with an empty audit, and start keeps the roles.json types with no truss.json roles', () => {
  const w = finishWorld()
  const r = w.finish()
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(r.json.merged, ['s'], say(r))
  assert.deepEqual(r.json.audit, [], say(r))
  const e = mkEnv({ config: CFG })
  writePlan(e.dir, planObj([crew('c')], { approvedAt: APPROVED }))
  writeGoal(e.dir, 'c')
  const s = runCli(e.factory, 'start', ['--stage', 'next', '--dir', e.dir, '--repo', e.repo], e.repo, { TRUSS_SESSION_START: '1' })
  assert.equal(s.status, 0, say(s))
  const roles = s.json.truss.roles
  assert.equal(roles.builder.agentType, 'general-purpose', JSON.stringify(roles.builder))
  assert.equal(roles.resolver.agentType, 'general-purpose')
  assert.equal(roles.tester.agentType, 'general-purpose')
})

// ---- cf: finish removes only its own run's merged wf_* worktrees

t('cf 1: finish removes wf_<run>-<n> worktrees and branches; another run, wf_<run>-1x and wf_<run>x-1 stay; no refusal, no audit', () => {
  const w = finishWorld()
  const a = addWf(w, `${RUN}-1`)
  const b = addWf(w, `${RUN}-2`)
  const near1 = addWf(w, `${RUN}-1x`)
  const near2 = addWf(w, 'wf_e804087f-eaax-1')
  const other = addWf(w, `${OTHER}-1`)
  const r = w.finish()
  assert.equal(r.status, 0, `finish must not refuse because of worktrees: ${say(r)}`)
  assert.deepEqual(r.json.audit, [], `nothing goes into audit: ${say(r)}`)
  assert.deepEqual(r.json.merged, ['s'], say(r))
  assert.ok(!existsSync(a) && !existsSync(b), `merged clean worktrees of run ${RUN} must be removed: ${a} exists ${existsSync(a)}, ${b} exists ${existsSync(b)}`)
  assert.ok(!branchExists(w, `worktree-${RUN}-1`) && !branchExists(w, `worktree-${RUN}-2`), 'their merged branches must be deleted')
  for (const p of [near1, near2, other]) assert.ok(existsSync(p), `${p} must stay`)
  for (const bn of [`worktree-${RUN}-1x`, 'worktree-wf_e804087f-eaax-1', `worktree-${OTHER}-1`]) assert.ok(branchExists(w, bn), `branch ${bn} must stay`)
})

// From 0.20.0 (ADR-0030) an unmerged member of the merged crew is retired too, its tip archived first.
t('cf 2: a dirty and a locked wf_<run> worktree stay and are reported in leftWorktrees with why dirty, locked; an unmerged one is archived and retired', () => {
  const w = finishWorld()
  const clean = addWf(w, `${RUN}-1`)
  const dirty = addWf(w, `${RUN}-2`)
  writeFileSync(`${dirty}/scratch.txt`, 'uncommitted\n')
  const locked = addWf(w, `${RUN}-3`)
  git(w.env.repo, ['worktree', 'lock', locked])
  const unmerged = addWf(w, `${RUN}-4`)
  putFile(unmerged, 'unmerged.txt', 'x\n', 'unmerged work')
  const tip = git(unmerged, ['rev-parse', 'HEAD'])
  const r = w.finish()
  assert.equal(r.status, 0, `finish must not refuse because of left worktrees: ${say(r)}`)
  assert.deepEqual(r.json.audit, [], `left worktrees are never in audit: ${say(r)}`)
  assert.ok(!existsSync(clean), `the clean merged worktree must be removed: ${say(r)}`)
  assert.ok(!existsSync(unmerged) && !branchExists(w, `worktree-${RUN}-4`), `the unmerged member of the merged crew is retired: ${say(r)}`)
  assert.equal(git(w.env.repo, ['rev-parse', `refs/truss/archive/${RUN}/worktree-${RUN}-4`]), tip, 'its tip is archived first')
  for (const [p, bn, why, name] of [[dirty, `worktree-${RUN}-2`, 'dirty', `${RUN}-2`], [locked, `worktree-${RUN}-3`, 'locked', `${RUN}-3`]]) {
    assert.ok(existsSync(p), `${p} must stay (no --force, no locked removal)`)
    assert.ok(branchExists(w, bn), `branch ${bn} must stay`)
    const e = leftOf(r.json, name)
    assert.ok(e, `leftWorktrees must name ${name}: ${JSON.stringify(r.json.leftWorktrees)}`)
    assert.equal(e.branch, bn)
    assert.equal(e.why, why, JSON.stringify(e))
  }
  assert.equal(left(r.json).length, 2, `only the two left worktrees are listed: ${JSON.stringify(r.json.leftWorktrees)}`)
})

// ---- cf: recordRun writes one restart event per restarted member

const ck = (text) => ({ task: 'x', marker: 'CHECKPOINT', branch: 'feat/x', commit: 'c0'.repeat(20), proof: '', text })
const restarts = (w) => readEvents(w.env.dir).filter((e) => e.event === 'restart')

t('cf 3: finish appends one restart event per restarted member, with crew, label, n and reason, and a second finish adds none', () => {
  const mk = (label, over = {}) => ({ label, agentType: 'general-purpose', metaModel: 'sonnet', model: 'claude-sonnet-5-5', effort: 'medium', result: 'built it', ...over })
  const w = finishWorld({
    interleave: true,
    agents: [
      mk('s-tester', { result: ck('halfway') }),
      mk('s-tester-2', { result: 'not an object' }),
      mk('s-tester-3', { result: 'done' }),
      mk('s-builder', { noResult: true }),
      mk('s-builder-2', { result: 'built it' }),
    ],
  })
  const r = w.finish()
  const ev = restarts(w)
  const msg = `${say(r)}; events ${JSON.stringify(readEvents(w.env.dir).map((e) => e.event))}`
  assert.equal(ev.length, 2, `one restart event per restarted member (tester CHECKPOINT, tester-2 no report; the interrupted builder is not one): ${msg}`)
  const one = ev.find((e) => e.label === 's-tester')
  const two = ev.find((e) => e.label === 's-tester-2')
  assert.ok(one && two, `events for s-tester and s-tester-2: ${JSON.stringify(ev)}`)
  assert.equal(one.crew, 's')
  assert.equal(one.n, 1)
  assert.equal(one.reason, 'CHECKPOINT')
  assert.equal(two.crew, 's')
  assert.equal(two.n, 2)
  assert.equal(two.reason, 'no report')
  assert.equal(one.v, 1)
  assert.equal(typeof one.ts, 'string')
  assert.equal(one.agent, 's-tester')
  w.finish()
  assert.equal(restarts(w).length, 2, 'a second finish adds nothing')
})

// ---- cf: truss.json roles map onto the role types

const rolesCfg = (roles) => ({ ...CFG, roles })
function startWith(roles, typeArgs = []) {
  const e = mkEnv({ config: rolesCfg(roles) })
  writePlan(e.dir, planObj([crew('c')], { approvedAt: APPROVED }))
  writeGoal(e.dir, 'c')
  const s = runCli(e.factory, 'start', ['--stage', 'next', '--dir', e.dir, '--repo', e.repo, ...typeArgs], e.repo, { TRUSS_SESSION_START: '1' })
  assert.equal(s.status, 0, say(s))
  return s.json.truss.roles
}

t('cf 4: start maps roles.build onto builder and resolver and roles.test onto tester', () => {
  const roles = startWith({ build: 'kit:builder', test: 'kit:test-writer' })
  assert.equal(roles.builder.agentType, 'kit:builder', JSON.stringify(roles.builder))
  assert.equal(roles.resolver.agentType, 'kit:builder', JSON.stringify(roles.resolver))
  assert.equal(roles.tester.agentType, 'kit:test-writer', JSON.stringify(roles.tester))
})

t('cf 5: --type wins over roles: --type builder=proj:b sets builder and resolver, roles.test still sets tester', () => {
  const roles = startWith({ build: 'kit:builder', test: 'kit:test-writer' }, ['--type', 'builder=proj:b'])
  assert.equal(roles.builder.agentType, 'proj:b', JSON.stringify(roles.builder))
  assert.equal(roles.resolver.agentType, 'proj:b', JSON.stringify(roles.resolver))
  assert.equal(roles.tester.agentType, 'kit:test-writer', `roles.test must still map: ${JSON.stringify(roles.tester)}`)
})

t('cf 6: plan-args maps the same roles, and without --type', () => {
  const e = mkEnv({ config: rolesCfg({ build: 'kit:builder', test: 'kit:test-writer' }) })
  const brief = `${e.dir}/brief.md`
  writeFileSync(brief, 'brief\n')
  writeFileSync(`${e.dir}/decisions.md`, '- 05:10 | checker-1 WORTH worth: the goal item | followed\n')
  const r = runCli(e.factory, 'plan-args', ['--dir', e.dir, '--repo', e.repo, '--brief-file', brief], e.repo, {})
  assert.equal(r.status, 0, say(r))
  const roles = r.json.truss.roles
  assert.equal(roles.builder.agentType, 'kit:builder', JSON.stringify(roles.builder))
  assert.equal(roles.tester.agentType, 'kit:test-writer', JSON.stringify(roles.tester))
})

// Regression tests for the 0.26.0 gates fixes that shipped without one (R-71): the rule-file exemption and cross-goal refusal of
// `owns-extend`, the plan lock of `plan-write`, the fail-closed trailer check of `integrate`, and the stage.js stop on a
// refusal that carries a `why` and no conflicts. Each case failed on the code before its fix.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  REAL_PLUGIN, addCrewWorktree, assertOneLine, crew, git, head, mkEnv, mkRepo, mkRun, mkTrussDir, planObj, putFile, readPlan, runCli, writePlan,
} from './fixtures/workflow-run/harness.ts'
import { ltcTriggers } from '../bin/guard.ts'

const CHECKOUT = path.resolve(REAL_PLUGIN, '..', '..').replace(/\\/g, '/')
const RULE = '.claude/rules/plugin-tests.md'
const say = (r: any): string => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 700)}; stderr ${String(r.stderr).slice(0, 300)}`
const st = (name: string, fn: () => unknown) => test(name, { timeout: 120000 }, fn)

// ---------------------------------------------------------------- owns-extend: rule-file exemption and cross-goal refusal

function goalsWorld(plan: Record<string, unknown>[]) {
  const text = readFileSync(`${CHECKOUT}/${RULE}`, 'utf8')
  const env = mkEnv({ config: { merge: 'sequential', target: 'main' }, files: { [RULE]: text } })
  assert.ok(git(env.repo, ['ls-files', RULE]) !== '', 'precondition: the rule file is tracked')
  writePlan(env.dir, planObj(plan))
  return env
}

st('gates-026-regress: owns-extend lets a crew of another goal and stage own a rule file', () => {
  const env = goalsWorld([
    crew('p', { goal: 'g1', stage: 1, owns: [RULE], status: 'running' }),
    crew('q', { goal: 'g2', stage: 2, owns: ['src/q/**'], status: 'running', after: ['p'] }),
  ])
  const r = env.run('owns-extend', { slug: 'q', glob: RULE, reason: 'REASON-RULE-FILE' })
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(readPlan(env.dir).crews.find((c) => c.slug === 'q').owns, ['src/q/**', RULE])
})

st('gates-026-regress: owns-extend refuses a rule file for a later-stage crew not ordered after the owner', () => {
  const env = goalsWorld([
    crew('p', { goal: 'g1', stage: 1, owns: [RULE], status: 'running' }),
    crew('q', { goal: 'g2', stage: 2, owns: ['src/q/**'], status: 'running' }),
  ])
  const r = env.run('owns-extend', { slug: 'q', glob: RULE, reason: 'REASON-NO-AFTER' })
  assert.equal(r.status, 1, say(r))
  assert.equal(assertOneLine(r).ok, false)
})

st('gates-026-regress: owns-extend refuses another goal\'s crew for a plain file, and a rule file in the same stage', () => {
  const env = goalsWorld([
    crew('p', { goal: 'g1', stage: 1, owns: [RULE, 'docs/z.md'], status: 'running' }),
    crew('q', { goal: 'g2', stage: 2, owns: ['src/q/**'], status: 'running' }),
    crew('r', { goal: 'g2', stage: 1, owns: ['src/r/**'], status: 'running' }),
  ])
  const before = readFileSync(`${env.dir}/plan.json`, 'utf8')
  const plain = env.run('owns-extend', { slug: 'q', glob: 'docs/z.md', reason: 'REASON-PLAIN' })
  assert.equal(plain.status, 1, `another goal's crew owns a plain file: ${say(plain)}`)
  assert.equal(assertOneLine(plain).ok, false)
  // r is in stage 1 beside p: the same stage never gets the exemption
  const sameStage = env.run('owns-extend', { slug: 'r', glob: RULE, reason: 'REASON-SAME-STAGE' })
  assert.equal(sameStage.status, 1, `a rule file in the same stage is refused: ${say(sameStage)}`)
  assert.equal(readFileSync(`${env.dir}/plan.json`, 'utf8'), before, 'a refusal changes nothing')
})

// ---------------------------------------------------------------- plan-write: the plan lock re-checks the existing plan

const PLAN_JSON = JSON.stringify(planObj([crew('arch', { stage: 0, verdict: 'design' })], { approval: 'client', approvedAt: null }), null, 2)
const MESSAGE = `Plan.\n\n\`\`\`\`json plan.json\n${PLAN_JSON}\n\`\`\`\`\n\n\`\`\`\`markdown plan.md\n# The plan\n\`\`\`\`\n`

st('gates-026-regress: plan-write does not overwrite a plan approved while it waited for the plan lock', async () => {
  const env = mkEnv()
  const { dir: run } = mkRun(env.transcripts, 'wf_plan', [{ id: 'aarch', label: 'truss-designer', agentType: 'truss:design-engineer', metaModel: 'opus', result: MESSAGE }])
  const existing = planObj([crew('kept', { stage: 0, verdict: 'design' })], { approval: 'client', approvedAt: null })
  writePlan(env.dir, existing)
  // a live owner holds the plan lock: plan-write passes its first check (the plan is unapproved), then waits
  const lock = `${env.dir}/locks/plan.lock`
  mkdirSync(lock, { recursive: true })
  writeFileSync(`${lock}/owner.json`, JSON.stringify({ pid: process.pid, host: hostname(), token: 'test', since: Date.now() }))
  const c = spawn(process.execPath, [env.factory, 'plan-write', '--dir', env.dir, '--repo', env.repo, '--transcript', run, '--label', 'truss-designer'], { windowsHide: true })
  let out = ''
  c.stdout.on('data', (d) => (out += d))
  c.stderr.on('data', (d) => (out += d))
  const closed = new Promise<number | null>((resolve) => c.on('close', resolve))
  await new Promise((r) => setTimeout(r, 1500))
  // the approval lands, then the lock is released
  writePlan(env.dir, { ...existing, approvedAt: '2026-10-01T00:00:00.000Z' })
  rmSync(lock, { recursive: true, force: true })
  const status = await closed
  assert.equal(status, 1, `plan-write must refuse: ${out}`)
  assert.match(out, /kept the existing plan: it is approved/, out)
  assert.equal(readPlan(env.dir).crews[0].slug, 'kept', 'the approved plan is untouched')
  assert.equal(existsSync(`${env.dir}/plan.md`), false, 'no plan.md was written')
})

// ---------------------------------------------------------------- integrate: an unreadable range is no proof of trailers

st('gates-026-regress: integrate refuses, with a reason and no conflicts, when the target cannot be read', () => {
  const env = mkEnv({ config: { merge: 'sequential', target: 'gone-target' }, files: { 'a.txt': 'base\n' } })
  writePlan(env.dir, planObj([crew('s', { owns: ['src/s/**'], status: 'running' })]))
  const wt = addCrewWorktree(env.repo, 's')
  git(env.repo, ['branch', 'member', 'truss-s'])
  const mw = path.join(path.dirname(wt), 'member-wt')
  git(env.repo, ['worktree', 'add', '-q', mw, 'member'])
  git(mw, ['config', 'user.name', 'T'])
  git(mw, ['config', 'user.email', 't@example.invalid'])
  putFile(mw, 'src/s/a.ts', 'a\n', 'bare work with no trailers')
  const res = env.run('integrate', { slug: 's', branch: 'member' })
  assert.equal(res.status, 1, say(res))
  const j = assertOneLine(res)
  assert.equal(j.merged, false)
  assert.deepEqual(j.conflicts, [])
  assert.deepEqual(j.missingTrailers, [])
  assert.match(String(j.why), /trailers are unchecked/, say(res))
})

// ---------------------------------------------------------------- stage.js: a refusal with a why and no conflicts is a stop, never a resolver

const STAGE_PATH = `${REAL_PLUGIN}/workflows/stage.js`
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const tick = () => new Promise((r) => setImmediate(r))
const rj = (obj: unknown, exit = 0) => ({ exit, stdout: JSON.stringify(obj) })
const HEAD = 'a1'.repeat(20)
const BASE = 'd4'.repeat(20)
const ROLE = (agentType: string, isolation: string, model = 'sonnet') => ({ agentType, model, effort: 'medium', isolation })
const ROLES = {
  designer: ROLE('truss:design-engineer', 'worktree', 'opus'), checker: ROLE('truss:checking-engineer', 'none', 'opus'), planner: ROLE('truss:planning-engineer', 'none', 'opus'),
  tester: ROLE('proj:tester', 'worktree'), builder: ROLE('proj:builder', 'worktree'), resolver: ROLE('proj:resolver', 'none'), writer: ROLE('truss:writer', 'worktree', 'opus'),
  rca: ROLE('general-purpose', 'none', 'opus'), stress: ROLE('truss:qc-engineer', 'worktree', 'opus'), qc: ROLE('truss:qc-engineer', 'none', 'opus'), runner: ROLE('general-purpose', 'none'),
}
const B1 = { name: 'build-it', role: 'builder', effort: 'medium', files: ['src/a.ts'], reads: [], brief: 'BRIEF-B1', after: [] }
const entry = {
  slug: 'a', stage: 1, goalFile: '/proj/.truss/goals/a.md', goal: 'GOAL-TEXT', owns: ['src/**'], acceptanceTest: 'node --test tests/a.check.ts', highImpact: [], stressTest: false,
  scope: 'SCOPE', worktree: '/wt/a', branch: 'truss/a', base: BASE, architecture: '/proj/docs/ARCH.md', adrs: [], resume: null, tasks: [], done: [], answers: [], spent: 0, labelFrom: {},
}

async function runStage(integrate: unknown, logs: string[] = []) {
  const body = readFileSync(STAGE_PATH, 'utf8').replace(/^\s*export\s+const\s+meta\b/m, 'const meta')
  const calls: { label: string }[] = []
  const labels: Record<string, unknown> = {
    'a-planner': { tasks: [B1], stop: null },
    'a-builder': { task: 'x', marker: 'DONE', branch: 'feat/b', commit: 'c0'.repeat(20), proof: 'PROOF-B', text: 'done' },
    'a-resolver': { task: 'x', marker: 'DONE', branch: 'feat/r', commit: 'c1'.repeat(20), proof: 'PROOF-R', text: 'resolved' },
    'a-qc': `VERDICT: PASS\n\n## Proof checked\nHead: ${HEAD}\nPatch: ${'e5'.repeat(20)}\n`,
  }
  const agent = async (prompt: string, opts: { label?: string } = {}) => {
    calls.push({ label: String(opts.label) })
    await tick()
    if (/-runner(-\d+)?$/.test(String(opts.label))) {
      const m = String(prompt).split('\n').find((l) => /factory\.ts\s/.test(l))?.match(/factory\.ts\s+([\w-]+)/)
      const cmd = m?.[1]
      const inner = cmd === 'heavy' ? String(prompt).match(/ -- .*factory\.ts\s+([\w-]+)(.*)$/m) : null
      const real = inner ? inner[1] : cmd
      if (cmd === 'integrate') return typeof integrate === 'function' ? integrate() : integrate
      if (cmd === 'admit') return rj({ admitted: true, parallelism: 4, running: 0, freeMB: 8000, minFreeMB: 2048 })
      if (cmd === 'reap') return rj({ reaped: [], skipped: [] })
      if (real === 'check') {
        const red = /--expect\s+red/.test(String(prompt))
        const plain = red ? { ok: true } : { ok: true, head: HEAD }
        return cmd === 'heavy' ? rj({ ...plain, heavy: { label: 'x', waitedMs: 0, exit: 0 } }) : rj(plain)
      }
      if (cmd === 'owns-check') return rj({ ok: true, outside: [] })
      if (cmd === 'tests-check') return rj({ ok: true, tests: [] })
      if (cmd === 'sync') return rj({ merged: true })
      if (cmd === 'decision-checkpoint') logs.push('RAN decision-checkpoint')
      if (cmd === 'decision-checkpoint') return { exit: 0, stdout: JSON.stringify({ crew: 'a', checkpoint: true }), status: 'truss-status: {}' }
      if (cmd === 'knowledge-lint') return rj({ ok: true, failures: [], warnings: [] })
      return rj({ ok: true, decisions: [] })
    }
    if (!Object.hasOwn(labels, String(opts.label))) throw new Error(`unscripted label: ${opts.label}`)
    return structuredClone(labels[String(opts.label)])
  }
  const parallel = async (thunks: any[]) => Promise.all(thunks.map(async (th) => { try { return await (typeof th === 'function' ? th() : th) } catch { return null } }))
  const pipeline = async (items: any[], ...stages: any[]) => Promise.all(items.map(async (item, i) => { try { let prev = item; for (const s of stages) prev = await s(prev, item, i); return prev } catch { return null } }))
  const args = { truss: { kind: 'stage', dir: '/proj/.truss', repo: '/proj', plugin: REAL_PLUGIN, target: 'main', reworkAllowance: 2, roles: ROLES, scriptPath: STAGE_PATH, crews: [entry] } }
  const result = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'allowance', body)(agent, parallel, pipeline, () => {}, (m: unknown) => { logs.push(String(m)) },structuredClone(args), {})
  return { res: result as any[], calls }
}

st('gates-026-regress: an integrate refusal with a why and no conflicts stops the crew with that why, with no resolver', async () => {
  const r = await runStage(rj({ merged: false, conflicts: [], missingTrailers: [], why: 'WHY-UNREADABLE-RANGE' }, 1))
  assert.equal(r.res[0].state, 'stopped', JSON.stringify(r.res[0]))
  assert.equal(r.res[0].tag, 'BLOCKED')
  assert.ok(r.res[0].text.includes('WHY-UNREADABLE-RANGE'), r.res[0].text)
  assert.ok(!r.calls.some((c) => /-resolver/.test(c.label)), 'no resolver is spawned')
})

// The real shape of factory.ts's operation-in-progress refusal (cmdIntegrate): conflicts [], inProgress, a why. The resolver is the one
// that can conclude the operation, so it must be reached; a plain why with no conflicts and no inProgress still stops the crew.
st('gates-026-regress: an operation-in-progress refusal reaches the resolver while another why-only refusal still stops BLOCKED', async () => {
  let n = 0
  const refusal = rj({ merged: false, conflicts: [], inProgress: 'rebase', why: 'a rebase is in progress in /wt/a; conclude or abort it before integrating feat/b' }, 1)
  const r = await runStage(() => (n++ === 0 ? refusal : rj({ merged: true, head: HEAD })))
  assert.ok(r.calls.some((c) => /-resolver/.test(c.label)), `the resolver is spawned for an operation in progress: ${JSON.stringify(r.calls.map((c) => c.label))}`)
  assert.notEqual(r.res[0].state, 'stopped', `the crew is not stopped BLOCKED: ${JSON.stringify(r.res[0])}`)
  const other = await runStage(rj({ merged: false, conflicts: [], why: 'WHY-OTHER-REFUSAL' }, 1))
  assert.equal(other.res[0].state, 'stopped', JSON.stringify(other.res[0]))
  assert.equal(other.res[0].tag, 'BLOCKED')
  assert.ok(other.res[0].text.includes('WHY-OTHER-REFUSAL'), other.res[0].text)
  assert.ok(!other.calls.some((c) => /-resolver/.test(c.label)), 'no resolver for a plain refusal')
})

// An empty `truss-status: {}` carries no field, so met falls back to the stdout JSON, as the stage.js comment says.
st('gates-026-regress: a decision-checkpoint with truss-status: {} counts as confirmed from its stdout JSON', async () => {
  const logs: string[] = []
  const r = await runStage(rj({ merged: true, head: HEAD }), logs)
  assert.ok(logs.includes('RAN decision-checkpoint'), `precondition: the crew ran decision-checkpoint: ${JSON.stringify(logs)}`)
  assert.ok(!logs.some((l) => /not confirmed/.test(l) && /decision-checkpoint/.test(l)), JSON.stringify(logs))
})

// ---------------------------------------------------------------- long-term-cost: a package.json that does not parse

st('gates-026-regress: a dependency added in a BOM-prefixed package.json raises a trigger', () => {
  const repo = mkRepo({ files: { 'package.json': JSON.stringify({ name: 'app', dependencies: { left: '1.0.0' } }) + '\n' } })
  const base = head(repo)
  const next = '﻿' + JSON.stringify({ name: 'app', dependencies: { left: '1.0.0', 'new-dep': '2.0.0' } }) + '\n'
  putFile(repo, 'package.json', next, 'add new-dep behind a BOM')
  const t = ltcTriggers(repo, base, head(repo))
  assert.equal(t.length, 1, JSON.stringify(t))
  assert.match(t[0].what, /new-dep/)
  assert.match(t[0].what, /package\.json/)
})

st('gates-026-regress: a package.json that is not JSON raises one could-not-be-read trigger', () => {
  const repo = mkRepo({ files: { 'package.json': JSON.stringify({ name: 'app' }) + '\n' } })
  const base = head(repo)
  putFile(repo, 'package.json', '{ not json at all', 'break package.json')
  const t = ltcTriggers(repo, base, head(repo))
  assert.equal(t.length, 1, JSON.stringify(t))
  assert.match(`${t[0].what} ${t[0].later}`, /could not be read/)
})

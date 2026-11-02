// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0021 behaviour that compose-runtime-contract.check.ts does not pin. Written from the spec before the build.
//
// Run with: node --test tests/compose-runtime.check.ts
// Case prefixes: `rs N:` drives stage.js through the stubbed Workflow runtime; `rf N:` drives bin/factory.ts through runCli in temp repos.
// A case never matches the source text of stage.js or factory.ts.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as reg from '../hooks/register.ts'
import { addCrewWorktree, appendEvent, crew, factorySpawn, git, gitStatus, head, mkEnv, mkRun, planObj, putFile, qcReport, readEvents, validateEvent, writePlan } from './fixtures/workflow-run/harness.ts'

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

// ---------------------------------------------------------------- stage harness (same shape as the contract's)

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const tick = () => new Promise((r) => setImmediate(r))
const rj = (obj, exit = 0) => ({ exit, stdout: JSON.stringify(obj) })

async function exec(args, o = {}) {
  if (!existsSync(STAGE)) throw new Error(`script missing: ${STAGE}`)
  const body = readFileSync(STAGE, 'utf8').replace(/^\s*export\s+const\s+meta\b/m, 'const meta')
  const calls = []
  const unscripted = []
  const counters = {}
  const logs = []
  const agent = async (prompt, opts = {}) => {
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
        m = prompt.match(/factory\.ts\s+(admit|reap|check|integrate|owns-check|tests-check|sync)\b([^\n`]*)/)
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
  }
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
const FAIL = (n = 1) => `VERDICT: FAIL\n\n## Findings\n- FINDING-${n}: broken\n`
const T1 = { name: 'write-tests', role: 'tester', effort: 'medium', files: ['tests/a.check.ts'], reads: ['src/a.ts'], brief: 'BRIEF-T1: write the tests for a', after: [] }
const B1 = { name: 'build-it', role: 'builder', effort: 'medium', files: ['src/a.ts'], reads: ['tests/a.check.ts'], brief: 'BRIEF-B1: build a', after: ['write-tests'] }
const W1 = { name: 'write-docs', role: 'writer', effort: 'medium', files: ['src/a.ts'], reads: [], brief: 'BRIEF-W', after: ['build-it'] }
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
const stoppedAs = (s, tag, at) => {
  assert.equal(s.state, 'stopped', JSON.stringify(s))
  assert.equal(s.tag, tag, JSON.stringify(s))
  assert.equal(s.at, at, JSON.stringify(s))
}

// ---------------------------------------------------------------- rs: stage.js (ADR-0021 Decision 5)

t('rs 1: a fix builder that returns CHECKPOINT twice is restarted twice, each successor carrying the note, and the crew passes', async () => {
  const r = await runStage([entry('a')], {
    reworkAllowance: 2,
    labels: base('a', {
      'a-qc': FAIL(),
      'a-qc-2': PASS,
      'a-builder-2': marked('CHECKPOINT', 'FIX-NOTE-ONE', 'feat/f1'),
      'a-builder-3': marked('CHECKPOINT', 'FIX-NOTE-TWO', 'feat/f1'),
      'a-builder-4': done('feat/f2'),
    }),
  })
  assert.equal(r.res[0].state, 'passed', `a fix builder chain should restart twice and carry on: ${JSON.stringify(r.res[0])}`)
  has(call(r, 'a-builder-3').prompt, 'FIX-NOTE-ONE')
  has(call(r, 'a-builder-3').prompt, READ_COMMITS)
  has(call(r, 'a-builder-4').prompt, 'FIX-NOTE-TWO')
  has(call(r, 'a-builder-4').prompt, READ_COMMITS)
})
t('rs 2: restarts of a fix builder add no rework spend, so two QC FAILs still get their two fixes with reworkAllowance 2', async () => {
  const r = await runStage([entry('a')], {
    reworkAllowance: 2,
    labels: base('a', {
      'a-qc': FAIL(1),
      'a-qc-2': FAIL(2),
      'a-qc-3': PASS,
      'a-builder-2': marked('CHECKPOINT', 'one', 'feat/f1'),
      'a-builder-3': marked('CHECKPOINT', 'two', 'feat/f1'),
      'a-builder-4': done('feat/f1'),
      'a-builder-5': done('feat/f2'),
    }),
  })
  assert.equal(r.res[0].state, 'passed', `two restarts must not count as rework spend: ${JSON.stringify(r.res[0])}`)
  assert.ok(had(r, 'a-builder-5') && had(r, 'a-qc-3'))
})
t('rs 3: a writer task that returns CHECKPOINT twice is restarted twice with the notes, and the crew passes', async () => {
  const r = await runStage([entry('a')], {
    reworkAllowance: 2,
    labels: base('a', {
      'a-planner': PLAN(T1, B1, W1),
      'a-writer': marked('CHECKPOINT', 'WRITER-NOTE-ONE', 'feat/w'),
      'a-writer-2': marked('CHECKPOINT', 'WRITER-NOTE-TWO', 'feat/w'),
      'a-writer-3': done('feat/w3'),
    }),
  })
  assert.equal(r.res[0].state, 'passed', `a writer chain should restart twice and carry on: ${JSON.stringify(r.res[0])}`)
  has(call(r, 'a-writer-2').prompt, 'WRITER-NOTE-ONE')
  has(call(r, 'a-writer-3').prompt, 'WRITER-NOTE-TWO')
  has(call(r, 'a-writer-3').prompt, READ_COMMITS)
})
for (const tag of ['QUESTION', 'PROPOSAL', 'BLOCKED']) {
  t(`rs 4 ${tag}: a restart successor that returns ${tag} stops the crew with that tag and its text at the task`, async () => {
    const r = await runStage([entry('a')], {
      reworkAllowance: 2,
      labels: base('a', { 'a-tester': marked('CHECKPOINT', 'note', 'feat/t'), 'a-tester-2': marked(tag, `SUCCESSOR-${tag}-TEXT`) }),
    })
    stoppedAs(r.res[0], tag, 'write-tests')
    assert.equal(r.res[0].text, `SUCCESSOR-${tag}-TEXT`, 'the text is the successor\'s own, not wrapped')
    assert.ok(!had(r, 'a-tester-3'), 'a QUESTION, PROPOSAL or BLOCKED is not restarted')
    assert.ok(!had(r, 'a-builder'))
  })
}
t('rs 5: reworkAllowance 0 still allows exactly one restart: a missing report is restarted and its successor can finish', async () => {
  const r = await runStage([entry('a')], { reworkAllowance: 0, labels: base('a', { 'a-tester': null, 'a-tester-2': done('feat/t2') }) })
  assert.equal(r.res[0].state, 'passed', `max(1, 0) = 1 restart: ${JSON.stringify(r.res[0])}`)
  assert.ok(had(r, 'a-tester-2'))
  assert.ok(!had(r, 'a-tester-3'))
})

// ---------------------------------------------------------------- rf: factory.ts finish (ADR-0021 Decisions 6, 7; Seams cf)

const APPROVED = '2026-10-01T00:00:00.000Z'
const CFG = { merge: 'sequential', target: 'main' }
const RUN = 'wf_e804087f-eaa'
const say = (r) => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 700)}; stderr ${String(r.stderr).slice(0, 300)}`

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

/** One finish world: crew `s` (and any o.also crews) running with a spawn event; crew s has a commit and a red record; run RUN holds `agents` plus a passing s-qc. */
function finishWorld(o = {}) {
  const env = mkEnv({ config: CFG })
  const also = o.also ?? []
  writePlan(env.dir, planObj([crew('s', { status: 'running' }), ...also.map((x) => crew(x, { status: 'running' }))], { approvedAt: APPROVED }))
  const when = new Date(Date.now() - 3 * 3600_000).toISOString()
  appendEvent(env.dir, factorySpawn('s', when))
  for (const x of also) appendEvent(env.dir, factorySpawn(x, when))
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
  const run = mkRun(env.transcripts, RUN, agents)
  if (o.interleave) interleave(run.dir)
  const resFile = `${env.dir}/result.json`
  writeFileSync(resFile, JSON.stringify([{ slug: 's', state: 'passed', head: hd, base, qc: 's-qc' }]))
  return { env, wt, run, finish: () => env.run('finish', { transcript: run.dir, result: resFile }) }
}

function addWf(w, name, branch = `worktree-${name}`, from = 'main') {
  const p = `${w.env.repo}/.claude/worktrees/${name}`
  git(w.env.repo, ['worktree', 'add', '-q', '-b', branch, p, from])
  git(p, ['config', 'user.name', 'T'])
  git(p, ['config', 'user.email', 't@e.invalid'])
  return p
}
const branchExists = (w, b) => gitStatus(w.env.repo, ['rev-parse', '--verify', '-q', `refs/heads/${b}`]) === 0
const left = (j) => (Array.isArray(j.leftWorktrees) ? j.leftWorktrees : [])
const mkAgent = (label, over = {}) => ({ label, agentType: 'general-purpose', metaModel: 'sonnet', model: 'claude-sonnet-5-5', effort: 'medium', result: 'built it', ...over })
const ck = (text) => ({ task: 'x', marker: 'CHECKPOINT', branch: 'feat/x', commit: 'c0'.repeat(20), proof: '', text })
const restarts = (w) => readEvents(w.env.dir).filter((e) => e.event === 'restart')

t('rf 1: removal needs both names: a matching branch with a foreign path, and a matching path with a foreign branch, stay; the exact one goes', () => {
  const w = finishWorld()
  const exact = addWf(w, `${RUN}-1`)
  const branchOnly = addWf(w, 'scratch-dir', `worktree-${RUN}-2`)
  const pathOnly = addWf(w, `${RUN}-3`, 'feature/unrelated')
  const r = w.finish()
  assert.equal(r.status, 0, `finish must not refuse because of worktrees: ${say(r)}`)
  assert.deepEqual(r.json.audit, [], say(r))
  assert.ok(!existsSync(exact), `the worktree whose branch and path both match must be removed: ${say(r)}`)
  assert.ok(!branchExists(w, `worktree-${RUN}-1`), 'its merged branch must be deleted')
  assert.ok(existsSync(branchOnly), 'a worktree with branch worktree-<run>-<n> but a path not ending <run>-<n> must stay')
  assert.ok(branchExists(w, `worktree-${RUN}-2`))
  assert.ok(existsSync(pathOnly), 'a worktree whose path ends <run>-<n> but whose branch is not worktree-<run>-<n> must stay')
  assert.ok(branchExists(w, 'feature/unrelated'))
  assert.ok(!left(r.json).some((x) => String(x.path).endsWith('/scratch-dir') || String(x.path).endsWith(`/${RUN}-3`)), `a non-matching worktree is not a matching one that was left: ${JSON.stringify(r.json.leftWorktrees)}`)
})
t('rf 2: restarts are never linked across crews or across roles', () => {
  const w = finishWorld({
    interleave: true,
    also: ['t'],
    agents: [
      mkAgent('s-tester', { result: ck('halfway') }),
      mkAgent('s-builder', { result: 'built it' }),
      mkAgent('t-tester', { result: ck('halfway') }),
      mkAgent('t-tester-2', { result: 'done' }),
    ],
  })
  const r = w.finish()
  const ev = restarts(w)
  const msg = `${say(r)}; restart events ${JSON.stringify(ev)}`
  assert.equal(ev.length, 1, `only t-tester (CHECKPOINT, then a t-tester-2 of its own crew and role) was restarted; s-tester has a later builder and another crew's tester after it, which are not successors: ${msg}`)
  assert.equal(ev[0].crew, 't', msg)
  assert.equal(ev[0].label, 't-tester', msg)
  assert.equal(ev[0].n, 1, msg)
  assert.equal(ev[0].reason, 'CHECKPOINT', msg)
})
t('rf 3: the restart event finish writes validates against events.schema.json, and one missing n or reason does not', () => {
  const w = finishWorld({ interleave: true, agents: [mkAgent('s-tester', { result: ck('halfway') }), mkAgent('s-tester-2', { result: 'done' })] })
  const r = w.finish()
  const lines = readFileSync(`${w.env.dir}/events.jsonl`, 'utf8').split('\n').filter((l) => l.includes('"restart"'))
  assert.equal(lines.length, 1, `one restart line in events.jsonl: ${say(r)}`)
  assert.deepEqual(validateEvent(lines[0]), [], `the restart line must validate: ${lines[0]}`)
  const ev = JSON.parse(lines[0])
  for (const key of ['n', 'reason']) {
    const { [key]: _gone, ...rest } = ev
    assert.notDeepEqual(validateEvent(rest), [], `a restart line without ${key} must not validate`)
  }
})

// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0019 (factory-fixes2), the runtime-stage items: 5 (member heavy line), 7 (lean entries, both halves), 9 (reader side),
// 11 (last JSON line), 12 (an answer at a step), 16 (read-only test files). Written from the spec before the change.
//
// Titles: `iN M:` cases fail on the base code; `control N:` cases pass on it (the old forms keep working).
// Every case drives the real workflows/stage.js through the stub harness of tests/stage-briefs.check.ts, or the real
// bin/factory.ts start through tests/fixtures/workflow-run/harness.ts. The plugin root comes from this file's own module
// path, never process.cwd(), so a copy of the base tree loads the base code.
//
// Run with: node --test tests/stage-fixes2.check.ts

import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { gatesAware } from './fixtures/gates-stub.ts'
import { fileURLToPath } from 'node:url'
import { addCrewWorktree, appendEvent, assertOneLine, crew, factorySpawn, git, head, mkEnv, mkRun, planObj, putFile, tmp, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')
const PATHS = { 'stage.js': `${PLUGIN}/workflows/stage.js` }
const t = (name, fn) => test(name, { timeout: 90000 }, fn)

const ROLES = {
  designer: { agentType: 'truss:design-engineer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  checker: { agentType: 'truss:checking-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
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

// ---------------------------------------------------------------- harness (copied from tests/stage-briefs.check.ts)

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const tick = () => new Promise((r) => setImmediate(r))
const ticks = async (n) => {
  for (let i = 0; i < n; i++) await tick()
}
const rj = (obj, exit = 0) => ({ exit, stdout: JSON.stringify(obj) })

async function exec(file, args, o = {}) {
  const p = PATHS[file]
  if (!existsSync(p)) throw new Error(`script missing: ${p}`)
  const body = readFileSync(p, 'utf8').replace(/^\s*export\s+const\s+meta\b/m, 'const meta')
  const calls = []
  const unscripted = []
  const timeline = []
  const counters = {}
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
        m = prompt.match(/factory\.ts\s+(admit|reap|check|integrate|owns-check|tests-check|sync|decision-checkpoint|crew-learned|knowledge-commit|knowledge-lint|decision-ack|decisions|inbox|escalate)\b([^\n`]*)/)
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
      const heavy = !!mh
      call.runner = { cmd, slug, expect, branch, key, name, heavy }
      const n = (counters[name] = (counters[name] ?? -1) + 1)
      timeline.push(`start:${name}`)
      let out = o.runner ? await o.runner({ cmd, key, slug, expect, branch, n, prompt, call, heavy }) : undefined
      if (out === undefined) {
        const plain = expect === 'red' ? { ok: true } : { ok: true, head: HEAD }
        out =
          cmd === 'admit' ? rj({ admitted: true, parallelism: 4, running: 0, freeMB: 8000, minFreeMB: 2048 }) : cmd === 'reap' ? rj({ reaped: [], skipped: [] }) : cmd === 'check' ? rj(heavy ? { ...plain, heavy: { label: `${slug}-check`, waitedMs: 0, exit: 0 } } : plain) : cmd === 'integrate' ? rj({ merged: true }) : cmd === 'owns-check' ? rj({ ok: true, outside: [] }) : cmd === 'tests-check' ? rj({ ok: true, tests: [] }) : rj({ merged: true })
      }
      await ticks(cmd === 'integrate' ? 3 : 1)
      timeline.push(`end:${name}`)
      return out
    }
    const labels = o.labels ?? {}
    if (!Object.hasOwn(labels, opts.label)) {
      unscripted.push(String(opts.label))
      throw new Error(`unscripted label: ${opts.label}`)
    }
    timeline.push(`start:${opts.label}`)
    const h = labels[opts.label]
    let v
    try {
      v = typeof h === 'function' ? await h(call, calls) : h
    } finally {
      await ticks(2)
      timeline.push(`end:${opts.label}`)
    }
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
  const phase = () => {}
  const log = () => {}
  let result
  let error
  try {
    result = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'allowance', body)(agent, parallel, pipeline, phase, log, structuredClone(args), {})
  } catch (e) {
    error = e
  }
  const isAR = (c) => c.runner?.cmd === 'admit' || c.runner?.cmd === 'reap'
  const arNames = new Set(calls.filter(isAR).map((c) => c.runner.name))
  const notAR = (e) => !arNames.has(e.replace(/^(start|end):/, ''))
  return { result, error, calls, unscripted, timeline: timeline.filter(notAR), labels: calls.filter((c) => !isAR(c)).map((c) => c.label) }
}

const HEAD = 'a1'.repeat(20)
const BASE = 'd4'.repeat(20)
const PATCH = 'e5'.repeat(20)
const PASS = `VERDICT: PASS\n\n## Proof checked\nHead: ${HEAD}\nPatch: ${PATCH}\n`
const qcFail = (...bullets) => `VERDICT: FAIL\n\n## Findings\n${bullets.map((b) => `- ${b}`).join('\n')}\n`

const T1 = { name: 'write-tests', role: 'tester', effort: 'medium', files: ['tests/a.check.ts'], reads: ['src/a.ts'], brief: 'BRIEF-T1: write the tests for a', after: [] }
const B1 = { name: 'build-it', role: 'builder', effort: 'medium', files: ['src/a.ts'], reads: ['tests/a.check.ts'], brief: 'BRIEF-B1: build a', after: ['write-tests'] }
const PLAN = (...tasks) => ({ tasks: tasks.length ? tasks : [T1, B1], stop: null })
const done = (branch, proof = 'PROOF-' + branch) => ({ task: 'whatever', marker: 'DONE', branch, commit: 'c0'.repeat(20), proof, text: 'finished ' + branch })

// the old entry form: goal, scope and acceptanceTest in, no guarded or ownTests
const OLD = (slug = 'a', o = {}) => ({
  slug, stage: 1, goalFile: `/proj/.truss/goals/${slug}.md`, goal: 'GOAL-TEXT', owns: ['src/**', 'tests/*.ts'],
  acceptanceTest: 'node --test tests/a.check.ts', highImpact: ['src/core/**'], stressTest: false, scope: 'SCOPE-VERBATIM: build a, nothing else',
  worktree: `/wt/${slug}`, branch: `truss/${slug}`, base: BASE, architecture: '/proj/docs/ARCH.md', adrs: ['/proj/docs/adr/0001-x.md'],
  resume: null, tasks: [], done: [], answers: [], spent: 0, labelFrom: {}, ...o,
})
// the lean entry form: no goal, scope or acceptanceTest (the goal file holds them), with guarded and ownTests
const LEAN = (slug = 'a', o = {}) => {
  const { goal, scope, acceptanceTest, ...rest } = OLD(slug)
  return { ...rest, guarded: [], ownTests: ['tests/*.ts'], ...o }
}
const base = (slug = 'a', over = {}) => ({
  [`${slug}-planner`]: PLAN(), [`${slug}-tester`]: done('feat/t', 'PROOF-T'), [`${slug}-builder`]: done('feat/b', 'PROOF-B'), [`${slug}-qc`]: PASS, ...over,
})
const stageArgs = (crews, o = {}) => ({
  truss: { kind: 'stage', dir: o.dir ?? '/proj/.truss', repo: o.repo ?? '/proj', plugin: PLUGIN, target: 'main', reworkAllowance: 2, roles: ROLES, scriptPath: PATHS['stage.js'], crews },
})
async function runStage(crews, o = {}) {
  const r = await exec('stage.js', stageArgs(crews, o), o)
  assert.deepEqual(r.unscripted, [], `unscripted label(s): ${r.unscripted.join(', ')}`)
  if (r.error) throw r.error
  r.res = r.result
  return r
}
const call = (r, label) => r.calls.find((c) => c.label === label)
const had = (r, label) => r.calls.some((c) => c.label === label)
const has = (s, sub) => assert.ok(s.includes(sub), `missing ${JSON.stringify(sub)} in:\n${s.slice(0, 2500)}`)
const hasnt = (s, sub) => assert.ok(!s.includes(sub), `unexpected ${JSON.stringify(sub)} in:\n${s.slice(0, 2500)}`)
const lineOf = (p, start) => p.split('\n').find((l) => l.startsWith(start)) ?? ''
const count = (s, sub) => s.split(sub).length - 1
const passed = (r, slug = 'a') => {
  const res = r.res.find((x) => x.slug === slug)
  assert.equal(res.state, 'passed', `crew ${slug} did not pass: ${JSON.stringify(res).slice(0, 1500)}`)
}

// ---------------------------------------------------------------- item 5: the member heavy line (ADR-0017 Decisions 1-2)

// the flags of a `factory.ts heavy` line, up to the ` -- ` that ends the prefix; null when the line has none
const HEAVY_RE = /factory\.ts\s+heavy\b(.*?)\s--(?:\s|`|$)/
const FLAG_RE = (name) => new RegExp(`--${name}\\s+('(?:[^']|'\\\\'')*'|\\S+)`)
const heavyOf = (text) => {
  const line = text.split('\n').find((l) => HEAVY_RE.test(l))
  if (!line) return null
  const flags = HEAVY_RE.exec(line)[1]
  const out = { line, flags }
  for (const n of ['dir', 'repo', 'slug', 'label', 'cwd']) out[n] = (FLAG_RE(n).exec(flags) || [])[1]
  return out
}
const runnerHeavy = (r, slug) => {
  const c = r.calls.find((x) => x.runner?.heavy && x.runner.slug === slug)
  assert.ok(c, `no heavy runner call for ${slug}`)
  return heavyOf(c.prompt)
}
function assertMemberHeavy(r, label, slug) {
  const want = runnerHeavy(r, slug)
  const got = heavyOf(call(r, label).prompt)
  assert.ok(got, `${label}: no factory.ts heavy line in:\n${call(r, label).prompt.slice(0, 2500)}`)
  for (const n of ['dir', 'repo', 'slug', 'label', 'cwd']) {
    assert.ok(got[n], `${label}: no --${n} in ${got.line}`)
    assert.equal(got[n], want[n], `${label}: --${n} differs from the runner's heavyLine`)
  }
  assert.equal(got.label, `${slug}-check`)
  const prefix = got.line.slice(got.line.indexOf('node'), got.line.indexOf(got.flags) + got.flags.length)
  assert.ok(!/[$;]|&&/.test(prefix), `the heavy prefix holds $, ; or &&: ${prefix}`)
  assert.ok(!/(^|\s)cd(\s|$)/.test(prefix), `the heavy prefix holds cd: ${prefix}`)
}

t('i5 1: every member prompt (tester, builder) holds a factory.ts heavy line equal to the runner heavyLine, with --label <slug>-check', async () => {
  const r = await runStage([OLD('a')], { labels: base('a') })
  passed(r)
  assertMemberHeavy(r, 'a-tester', 'a')
  assertMemberHeavy(r, 'a-builder', 'a')
})
t('i5 2: a relative truss dir is resolved against the repo and a repo path with a space is quoted, the same in the member line as in the runner line', async () => {
  const r = await runStage([OLD('a')], { dir: '.git/truss/xyz', repo: '/proj space/repo', labels: base('a') })
  passed(r)
  assertMemberHeavy(r, 'a-tester', 'a')
  const got = heavyOf(call(r, 'a-tester').prompt)
  has(got.dir.replace(/'/g, ''), '/proj space/repo/.git/truss/xyz')
})
t('i5 3: a fix member (a builder fix after a QC FAIL) holds the same heavy line', async () => {
  const r = await runStage([OLD('a')], { labels: { ...base('a', { 'a-qc': qcFail('BFIND in src/a.ts'), 'a-qc-2': PASS }), 'a-builder-2': done('feat/fb') } })
  passed(r)
  assert.ok(had(r, 'a-builder-2'), `labels: ${r.labels.join(', ')}`)
  assertMemberHeavy(r, 'a-builder-2', 'a')
})
t('i5 4: two crews each get their own slug, label and cwd in the member heavy line', async () => {
  const r = await runStage([OLD('a'), OLD('b')], { labels: { ...base('a'), ...base('b') } })
  passed(r, 'a')
  passed(r, 'b')
  assertMemberHeavy(r, 'a-tester', 'a')
  assertMemberHeavy(r, 'b-builder', 'b')
  assert.notEqual(heavyOf(call(r, 'a-tester').prompt).cwd, heavyOf(call(r, 'b-tester').prompt).cwd)
})
t('control 1: the runner heavy line itself carries the five flags the member line must match', async () => {
  const r = await runStage([OLD('a')], { labels: base('a') })
  const h = runnerHeavy(r, 'a')
  for (const n of ['dir', 'repo', 'slug', 'label', 'cwd']) assert.ok(h[n], `runner heavy line lacks --${n}: ${h.line}`)
  assert.equal(h.label, 'a-check')
})

// ---------------------------------------------------------------- item 7, start half: the lean entry

const MIN = 60_000
const HOUR = 3_600_000
const iso = (ms) => new Date(ms).toISOString()
const startWorld = (acceptance = 'node --test t.ts') => {
  const env = mkEnv()
  writePlan(env.dir, planObj([crew('x', { acceptanceTest: acceptance })]))
  writeGoal(env.dir, 'x')
  return env
}
const startEntry = (env) => {
  const res = env.run('start', { stage: 'next' })
  const j = assertOneLine(res)
  assert.equal(res.status, 0, `${res.stdout} ${res.stderr}`)
  assert.equal(j.truss.crews.length, 1, res.stdout)
  return j.truss.crews[0]
}

t('i7 1: a fresh start entry has no goal key', () => {
  const e = startEntry(startWorld())
  assert.ok(!('goal' in e), `goal is still in the entry: ${JSON.stringify(e.goal)}`)
})
t('i7 2: scope is left out of the entry when the goal file has ## Approved scope', () => {
  const env = startWorld()
  assert.ok(readFileSync(`${env.dir}/goals/x.md`, 'utf8').includes('## Approved scope'))
  const e = startEntry(env)
  assert.ok(!('scope' in e), `scope is still in the entry: ${JSON.stringify(e.scope)}`)
})
t('i7 3: acceptanceTest is left out of the entry when the goal file has ## Acceptance test', () => {
  const env = startWorld()
  const goal = `${env.dir}/goals/x.md`
  writeFileSync(goal, `${readFileSync(goal, 'utf8')}\n## Acceptance test\n\nnode --test t.ts\n`)
  const e = startEntry(env)
  assert.ok(!('acceptanceTest' in e), `acceptanceTest is still in the entry: ${JSON.stringify(e.acceptanceTest)}`)
})
t('control 2: the entry still names its goalFile and owns; acceptanceTest stays when the goal file has no ## Acceptance test', () => {
  const env = startWorld()
  assert.ok(!readFileSync(`${env.dir}/goals/x.md`, 'utf8').includes('## Acceptance test'))
  const e = startEntry(env)
  assert.equal(typeof e.goalFile, 'string')
  assert.ok(existsSync(e.goalFile))
  assert.deepEqual(e.owns, ['src/x/**'])
  assert.equal(e.acceptanceTest, 'node --test t.ts')
})

// ---------------------------------------------------------------- item 7, resume: done tasks are stubbed

const fullTask = (name) => ({ name, role: 'builder', effort: 'medium', files: [`src/x/${name}.ts`], reads: [`docs/read-${name}.md`], brief: `BRIEF-FULL-${name}: a long brief`, after: [], ...(name === 't1' ? { persona: 'frontend-dev' } : {}) })
function memberBranch(wt, crewBranch, name, merge) {
  git(wt, ['checkout', '-q', '-b', name])
  putFile(wt, `members/${name}.txt`, `${name}\n`, `member ${name}`)
  git(wt, ['checkout', '-q', crewBranch])
  if (merge) git(wt, ['merge', '-q', '--no-ff', '-m', `merge ${name}`, name])
}
function stoppedWorld() {
  const env = mkEnv()
  writePlan(env.dir, planObj([crew('x', { status: 'running' })], { approvedAt: iso(Date.now() - 3 * HOUR) }))
  writeGoal(env.dir, 'x')
  const wt = addCrewWorktree(env.repo, 'x')
  appendEvent(env.dir, factorySpawn('x', iso(Date.now() - 5 * MIN)))
  memberBranch(wt, 'truss-x', 'member-t1', true)
  memberBranch(wt, 'truss-x', 'member-t2', false)
  putFile(env.dir, 'checks/x-1.json', JSON.stringify({ command: 'false', exit: 1, head: head(wt), tail: '' }))
  const tasks = [fullTask('t1'), fullTask('t2')]
  const member = (n, branch) => ({ task: n, marker: 'DONE', branch, commit: 'c0ffee', proof: 'ran it', text: 'ok' })
  const endMs = Date.now() - 10 * MIN
  const at = { startTs: iso(endMs - MIN), endTs: iso(endMs) }
  const run = mkRun(env.transcripts, 'wf_stopped', [
    { label: 'x-planner', result: { tasks, stop: null }, ...at },
    { label: 'x-builder', result: member('t1', 'member-t1'), ...at },
    { label: 'x-builder-2', result: member('t2', 'member-t2'), ...at },
  ], { journalMtimeMs: endMs })
  return { env, run, tasks }
}
const resumeAnswers = (w, answers) => {
  const p = `${tmp('fixes2-ans-')}/answers.json`
  writeFileSync(p, JSON.stringify(answers))
  const res = w.env.run('start', { slug: 'x', resume: 'answers', transcript: w.run.dir, answers: p })
  const j = assertOneLine(res)
  assert.equal(res.status, 0, `${res.stdout} ${res.stderr}`)
  return j.truss.crews[0]
}

t('i7 4 (review 3): start --resume answers shrinks the done task to name, role, effort, files, after, brief and persona (a rerun needs the brief and persona); the reads go', () => {
  const w = stoppedWorld()
  const e = resumeAnswers(w, [{ at: 'green', text: 'go on' }])
  assert.deepEqual(e.done, ['t1'])
  const stub = e.tasks.find((x) => x.name === 't1')
  assert.ok(stub, `no t1 in tasks: ${JSON.stringify(e.tasks)}`)
  for (const k of ['role', 'effort', 'files', 'after', 'brief', 'persona']) assert.deepEqual(stub[k], w.tasks[0][k], `the stub of t1 lost ${k}`)
  assert.equal(w.tasks[0].persona, 'frontend-dev', 'the fixture task carries a persona')
  assert.ok(!JSON.stringify(stub).includes('docs/read-t1.md'), `the stub still holds the reads: ${JSON.stringify(stub)}`)
  const bare = e.tasks.find((x) => x.name === 't2')
  assert.ok(!Object.hasOwn(bare, 'persona'), 'a task with no persona gets none added')
})
t('control 3: start --resume answers keeps the task that is not done in full, and lists the done one', () => {
  const w = stoppedWorld()
  const e = resumeAnswers(w, [{ at: 'green', text: 'go on' }])
  assert.deepEqual(e.done, ['t1'])
  assert.deepEqual(e.tasks.map((x) => x.name), ['t1', 't2'])
  assert.deepEqual(e.tasks.find((x) => x.name === 't2'), w.tasks[1])
})

// ---------------------------------------------------------------- item 7, stage half: stage.js reads the goal file

const NO_UNDEFINED = (p) => hasnt(p, 'undefined')

t('i7 5: with a lean entry, the tester and builder prompts point to goalFile and never print undefined', async () => {
  const r = await runStage([LEAN('a')], { labels: base('a') })
  passed(r)
  for (const label of ['a-tester', 'a-builder']) {
    const p = call(r, label).prompt
    has(p, '/proj/.truss/goals/a.md')
    NO_UNDEFINED(p)
  }
})
t('i7 6: with a lean entry, the planner prompt prints no undefined', async () => {
  const r = await runStage([LEAN('a')], { labels: base('a') })
  const p = call(r, 'a-planner').prompt
  has(p, '/proj/.truss/goals/a.md')
  NO_UNDEFINED(p)
})
t('i7 7: with a lean entry, the QC prompt prints no undefined', async () => {
  const r = await runStage([LEAN('a')], { labels: base('a') })
  const p = call(r, 'a-qc').prompt
  has(p, '/proj/.truss/goals/a.md')
  NO_UNDEFINED(p)
})
t('control 4: an old-form entry (goal, scope, acceptanceTest; no guarded, no ownTests) still runs and its prompts print the scope and the acceptance test', async () => {
  const r = await runStage([OLD('a')], { labels: base('a') })
  passed(r)
  for (const label of ['a-tester', 'a-builder']) {
    const p = call(r, label).prompt
    has(p, 'Approved scope: SCOPE-VERBATIM: build a, nothing else')
    has(p, 'Acceptance test: node --test tests/a.check.ts')
    NO_UNDEFINED(p)
  }
  has(call(r, 'a-planner').prompt, 'SCOPE-VERBATIM')
  has(call(r, 'a-qc').prompt, 'node --test tests/a.check.ts')
})
t('control 5: a resume whose done task is a stub (no brief, no reads) skips it and runs only the other task', async () => {
  const stub = { name: 'write-tests', role: 'tester', effort: 'medium', files: ['tests/a.check.ts'], after: [] }
  const r = await runStage([LEAN('a', { resume: 'answers', tasks: [stub, B1], done: ['write-tests'] })], { labels: base('a') })
  passed(r)
  assert.ok(!had(r, 'a-tester'), 'the done task ran again')
  assert.ok(had(r, 'a-builder'))
})

// ---------------------------------------------------------------- item 9, reader side: tester files come from ownTests

const mergeReady = (o = {}) => OLD('a', { resume: 'merge-ready', ...o })
// a merge-ready resume has no earlier members, so the fix members are the first of their role
const fixLabels = { 'a-tester': done('feat/ft'), 'a-builder': done('feat/fb') }
const mrLabels = (qc) => ({ 'a-qc': qc, 'a-qc-2': PASS, ...fixLabels })

t('i9 1: on a merge-ready resume the tester files are the ownTests globs, so a finding in a path the old regex rejects goes to a tester fix', async () => {
  const entry = mergeReady({ owns: ['src/**', 'tests/*.ts', 'checks/*.mjs'], ownTests: ['checks/*.mjs'] })
  const r = await runStage([entry], { labels: mrLabels(qcFail('TFIND checks/a.mjs misses the empty case')) })
  assert.ok(had(r, 'a-tester'), `no a-tester; labels: ${r.labels.join(', ')}`)
  assert.equal(lineOf(call(r, 'a-tester').prompt, 'Files you may change:'), 'Files you may change: checks/*.mjs')
  assert.ok(!had(r, 'a-builder'), 'a builder fix ran for a tester-only finding')
})
t('i9 2: on a merge-ready resume, an owned tests/ path that is not in ownTests is not a tester file', async () => {
  const entry = mergeReady({ ownTests: [] })
  const r = await runStage([entry], { labels: mrLabels(qcFail('FIND in tests/a.check.ts')) })
  assert.ok(had(r, 'a-builder'), `no a-builder; labels: ${r.labels.join(', ')}`)
  assert.ok(!had(r, 'a-tester'), 'a tester fix ran for a path ownTests does not list')
  has(lineOf(call(r, 'a-builder').prompt, 'Files you may change:'), 'tests/*.ts')
})
t('i9 3: the builder fix prompt lists the ownTests globs as files a tester owns, which it must not change', async () => {
  const entry = mergeReady({ owns: ['src/**', 'tests/*.ts', 'checks/*.mjs'], ownTests: ['checks/*.mjs'] })
  const r = await runStage([entry], { labels: mrLabels(qcFail('BFIND in src/a.ts')) })
  assert.ok(had(r, 'a-builder'), `labels: ${r.labels.join(', ')}`)
  const p = call(r, 'a-builder').prompt
  assert.equal(lineOf(p, 'Files a tester owns, which you must not change:'), 'Files a tester owns, which you must not change: checks/*.mjs')
  hasnt(lineOf(p, 'Files you may change:'), 'checks/*.mjs')
})
t('control 6: a merge-ready resume with ownTests equal to the old regex answer sends a tests/ finding to a tester fix', async () => {
  const entry = mergeReady({ ownTests: ['tests/*.ts'] })
  const r = await runStage([entry], { labels: mrLabels(qcFail('TFIND tests/a.check.ts misses the empty case')) })
  assert.ok(had(r, 'a-tester'), `labels: ${r.labels.join(', ')}`)
  assert.equal(lineOf(call(r, 'a-tester').prompt, 'Files you may change:'), 'Files you may change: tests/*.ts')
})
t('control 7: a merge-ready resume of an old-form entry (no ownTests) still runs to a QC verdict', async () => {
  const r = await runStage([mergeReady()], { labels: { 'a-qc': PASS } })
  passed(r)
})

// ---------------------------------------------------------------- item 11: runFactory reads the last JSON-object line

const HV = { label: 'a-check', waitedMs: 0, exit: 0 }
const chatter = (...lines) => (lines.length ? `${lines.join('\n')}\n` : '')
const reply = (obj, before = [], after = []) => ({ exit: 0, stdout: `${chatter(...before)}${JSON.stringify(obj)}\n${chatter(...after)}` })

t('i11 1: a red check reply with chatter lines before the JSON line is read (the crew goes on)', async () => {
  const runner = ({ key }) => (key === 'check:red' ? reply({ ok: true, heavy: HV }, ['npm warn deprecated thing', 'warn: {oops not json', '']) : undefined)
  const r = await runStage([OLD('a')], { labels: base('a'), runner })
  passed(r)
})
t('i11 2: a green check reply with chatter before and after the JSON line is read', async () => {
  const runner = ({ key }) => (key === 'check:green' ? reply({ ok: true, head: HEAD, heavy: HV }, ['pretest noise'], ['done in 3s', '']) : undefined)
  const r = await runStage([OLD('a')], { labels: base('a'), runner })
  passed(r)
})
t('i11 3: a sync reply with chatter around the JSON line is read', async () => {
  const runner = ({ key }) => (key === 'sync' ? reply({ merged: true }, ['Already up to date.'], ['bye']) : undefined)
  const r = await runStage([mergeReady()], { labels: { 'a-qc': PASS }, runner })
  passed(r)
})
t('i11 4: the last JSON object wins over an earlier one, and a later JSON line that is no object is ignored', async () => {
  const runner = ({ key }) => (key === 'check:red' ? { exit: 0, stdout: `${JSON.stringify({ ok: false })}\n${JSON.stringify({ ok: true, heavy: HV })}\n42\n"done"\n[1,2]\n` } : undefined)
  const r = await runStage([OLD('a')], { labels: base('a'), runner })
  passed(r)
})
t('control 8: a reply that is one JSON line is read', async () => {
  const runner = ({ key }) => (key === 'check:red' ? reply({ ok: true, heavy: HV }) : undefined)
  const r = await runStage([OLD('a')], { labels: base('a'), runner })
  passed(r)
})
t('control 9: a reply with no JSON object at all stops the crew at red', async () => {
  const runner = ({ key }) => (key === 'check:red' ? { exit: 0, stdout: 'just chatter\n42\n' } : undefined)
  const r = await runStage([OLD('a')], { labels: base('a'), runner })
  const res = r.res[0]
  assert.equal(res.state, 'stopped')
  assert.equal(res.at, 'red')
})

// ---------------------------------------------------------------- item 12: an answer at no task name goes to every member

const answersEntry = (answers, o = {}) => OLD('a', { resume: 'answers', tasks: [T1, B1], answers, ...o })

t('i12 1: an answer at a step (green) reaches the tester and the builder prompt, once each', async () => {
  const r = await runStage([answersEntry([{ at: 'green', text: 'ANSWER-AT-GREEN-1' }])], { labels: base('a') })
  passed(r)
  for (const label of ['a-tester', 'a-builder']) {
    const p = call(r, label).prompt
    has(p, 'ANSWER-AT-GREEN-1')
    assert.equal(count(p, 'ANSWER-AT-GREEN-1'), 1, `${label} holds the answer ${count(p, 'ANSWER-AT-GREEN-1')} times`)
  }
})
t('i12 2: an answer at red and an answer at qc both reach every member', async () => {
  const r = await runStage([answersEntry([{ at: 'red', text: 'ANSWER-AT-RED' }, { at: 'qc', text: 'ANSWER-AT-QC' }])], { labels: base('a') })
  passed(r)
  for (const label of ['a-tester', 'a-builder']) {
    has(call(r, label).prompt, 'ANSWER-AT-RED')
    has(call(r, label).prompt, 'ANSWER-AT-QC')
  }
})
t('i12 3: an answer at split on a crew with no saved tasks reaches every member of the new plan', async () => {
  const r = await runStage([answersEntry([{ at: 'split', text: 'ANSWER-AT-SPLIT' }], { tasks: [] })], { labels: base('a') })
  passed(r)
  has(call(r, 'a-planner').prompt, 'ANSWER-AT-SPLIT')
  for (const label of ['a-tester', 'a-builder']) has(call(r, label).prompt, 'ANSWER-AT-SPLIT')
})
t('i12 4: an answer at a name that is no task of this plan reaches every member', async () => {
  const r = await runStage([answersEntry([{ at: 'gone-task', text: 'ANSWER-AT-GONE' }])], { labels: base('a') })
  passed(r)
  for (const label of ['a-tester', 'a-builder']) has(call(r, label).prompt, 'ANSWER-AT-GONE')
})
t('control 10: an answer at a task name reaches that task only', async () => {
  const r = await runStage([answersEntry([{ at: 'write-tests', text: 'ANSWER-AT-TESTER' }])], { labels: base('a') })
  passed(r)
  has(call(r, 'a-tester').prompt, 'ANSWER-AT-TESTER')
  hasnt(call(r, 'a-builder').prompt, 'ANSWER-AT-TESTER')
})

// ---------------------------------------------------------------- item 16: test files are read-only for builders

// pinned condition: validateTasks sends a plan back when a builder task lists a file that matches an ownTests glob of the entry
const BAD_B = { ...B1, files: ['src/a.ts', 'tests/a.check.ts'] }
const badPlan = () => PLAN(T1, BAD_B)

t('i16 1: the builder task prompt carries a read-only list naming the tester files', async () => {
  const r = await runStage([LEAN('a')], { labels: base('a') })
  passed(r)
  const line = call(r, 'a-builder').prompt.split('\n').find((l) => /read-only/i.test(l))
  assert.ok(line, `no read-only line in the builder prompt:\n${call(r, 'a-builder').prompt.slice(0, 2500)}`)
  has(line, 'tests/a.check.ts')
})
t('i16 2: a plan whose builder task lists a test file is sent back to the planner with an error naming the task and the file', async () => {
  let n = 0
  const planner = () => (n++ === 0 ? badPlan() : PLAN())
  const r = await runStage([LEAN('a')], { labels: base('a', { 'a-planner': planner, 'a-planner-2': planner }) })
  passed(r)
  assert.ok(had(r, 'a-planner-2'), `the plan was not sent back; labels: ${r.labels.join(', ')}`)
  const p = call(r, 'a-planner-2').prompt
  has(p, 'Your last plan failed these checks')
  has(p, 'build-it')
  has(p, 'tests/a.check.ts')
})
t('i16 3: a plan that breaks the rule twice stops the crew BLOCKED at split, naming the file', async () => {
  const r = await runStage([LEAN('a')], { labels: base('a', { 'a-planner': badPlan(), 'a-planner-2': badPlan() }) })
  const res = r.res[0]
  assert.equal(res.state, 'stopped', JSON.stringify(res).slice(0, 800))
  assert.equal(res.tag, 'BLOCKED')
  assert.equal(res.at, 'split')
  has(res.text, 'tests/a.check.ts')
  assert.ok(!had(r, 'a-builder'), 'a builder ran on a plan that was refused')
})
t('control 11: a plan whose builder lists only source files, and whose tester lists the test file, is accepted without a second ask', async () => {
  const r = await runStage([LEAN('a')], { labels: base('a') })
  passed(r)
  assert.ok(!had(r, 'a-planner-2'))
})
t('control 12: an old-form entry without ownTests does not send a plan back for listing a test path', async () => {
  const r = await runStage([OLD('a')], { labels: base('a', { 'a-planner': badPlan() }) })
  passed(r)
  assert.ok(!had(r, 'a-planner-2'))
})

// ---------------------------------------------------------------- the tests guard gets a new cache key per resume that answers at tests

const runnerPrompts = (r, cmd) => r.calls.filter((c) => c.runner?.cmd === cmd).map((c) => c.prompt)

t('tests-attempt 1: with no answer at tests the tests-check prompt has no Attempt line, and one at tests adds "Attempt: 1"', async () => {
  const r0 = await runStage([answersEntry([{ at: 'green', text: 'ANSWER-AT-GREEN' }])], { labels: base('a') })
  const r1 = await runStage([answersEntry([{ at: 'green', text: 'ANSWER-AT-GREEN' }, { at: 'tests', text: 'BRANCH-REWRITTEN' }])], { labels: base('a') })
  passed(r0)
  passed(r1)
  const [p0] = runnerPrompts(r0, 'tests-check')
  const [p1] = runnerPrompts(r1, 'tests-check')
  assert.ok(p0 && p1, 'the tests guard ran in both runs')
  assert.ok(!/^Attempt:/m.test(p0), `unexpected Attempt line in:\n${p0}`)
  assert.ok(p0.endsWith('--status-line'), 'with no answer at tests the prompt still ends at the command line')
  assert.notEqual(p1, p0)
  assert.equal(p1, `${p0}\nAttempt: 1`)
})
t('tests-attempt 2: two answers at tests give "Attempt: 2", and every other runner prompt is unchanged', async () => {
  const r0 = await runStage([answersEntry([])], { labels: base('a') })
  const r2 = await runStage([answersEntry([{ at: 'tests', text: 'FIX-1' }, { at: 'tests', text: 'FIX-2' }])], { labels: base('a') })
  passed(r0)
  passed(r2)
  assert.ok(runnerPrompts(r2, 'tests-check')[0].endsWith('\nAttempt: 2'))
  for (const cmd of ['admit', 'reap', 'check', 'owns-check', 'sync', 'integrate']) {
    const a = runnerPrompts(r0, cmd)
    const b = runnerPrompts(r2, cmd)
    assert.deepEqual(b, a, `${cmd} prompts changed`)
    for (const p of b) assert.ok(!/^Attempt:/m.test(p), `${cmd} prompt carries an Attempt line`)
  }
  assert.ok(runnerPrompts(r0, 'owns-check').length > 0, 'the owns guard ran')
})

// ---------------------------------------------------------------- bug 28: rework findings on tester files, and the backstop

t('bug28 1: a finding that names only a guarded file\'s basename goes to a tester fix, not a builder', async () => {
  const entry = mergeReady({ guarded: ['tests/support.ts'], ownTests: [] })
  const r = await runStage([entry], { labels: mrLabels(qcFail('TFIND the support.ts helper misses the empty case')) })
  assert.ok(had(r, 'a-tester'), `no a-tester; labels: ${r.labels.join(', ')}`)
  has(lineOf(call(r, 'a-tester').prompt, 'Files you may change:'), 'tests/support.ts')
  assert.ok(!had(r, 'a-builder'), 'a builder fix ran for a finding on a guarded file')
})
t('bug28 2: a finding that names a guarded file\'s basename without its extension goes to a tester fix', async () => {
  const entry = mergeReady({ guarded: ['tests/support.ts'], ownTests: [] })
  const r = await runStage([entry], { labels: mrLabels(qcFail('TFIND the support helper misses the empty case')) })
  assert.ok(had(r, 'a-tester'), `no a-tester; labels: ${r.labels.join(', ')}`)
  assert.ok(!had(r, 'a-builder'), 'a builder fix ran for a finding on a guarded file')
})
t('bug28 3: the builder fix prompt says never to edit a tester file', async () => {
  const entry = mergeReady({ guarded: ['tests/support.ts'], ownTests: [] })
  const r = await runStage([entry], { labels: mrLabels(qcFail('BFIND in src/a.ts')) })
  has(call(r, 'a-builder').prompt, 'Never edit a file in the tester list above')
})
t('bug28 4: when tests-check reports touched files after a builder fix, a tester fix rewrites them and the crew passes', async () => {
  const entry = mergeReady({ guarded: ['tests/a.check.ts'], ownTests: [] })
  const seen = []
  const runner = ({ cmd, prompt }) => {
    if (cmd !== 'tests-check') return undefined
    const m = prompt.match(/Backstop: (\S+)/)
    seen.push(m ? m[1] : 'guard')
    if (m && m[1] === '1.1') return rj({ ok: false, touched: [{ commit: 'b0'.repeat(20), role: 'builder', files: ['tests/a.check.ts'] }], tests: ['tests/a.check.ts'] }, 1)
    return undefined
  }
  // ADR-0024 i28 moves the backstop from a tester fix member to the resolver role (pinned in stage-fixes3.check.ts); this case
  // keeps its title and its split, identical-tree and two-check assertions, and accepts the backstop member under either label
  const r = await runStage([entry], { labels: { ...mrLabels(qcFail('BFIND in src/a.ts')), 'a-resolver': done('truss/a') }, runner })
  passed(r)
  assert.ok(had(r, 'a-builder'), `labels: ${r.labels.join(', ')}`)
  const member = had(r, 'a-resolver') ? 'a-resolver' : 'a-tester'
  assert.ok(had(r, member), `no backstop member; labels: ${r.labels.join(', ')}`)
  assert.ok(call(r, 'a-builder').i < call(r, member).i, 'the backstop member ran before the builder fix')
  const p = call(r, member).prompt
  has(p, 'b0'.repeat(20))
  has(p, 'Truss-Role: test-writer')
  has(p, 'Keep the tree identical')
  assert.deepEqual(seen.filter((s) => s !== 'guard'), ['1.1', '1.2'])
})
t('bug28 5: a clean tests-check after a builder fix sends no tester fix', async () => {
  const entry = mergeReady({ guarded: ['tests/a.check.ts'], ownTests: [] })
  const r = await runStage([entry], { labels: mrLabels(qcFail('BFIND in src/a.ts')) })
  passed(r)
  assert.ok(!had(r, 'a-tester'), `labels: ${r.labels.join(', ')}`)
})

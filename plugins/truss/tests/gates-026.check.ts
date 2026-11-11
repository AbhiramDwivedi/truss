// @ts-nocheck
// truss 0.26.0, crew gates (items 8, 9, 10): the heavy slot re-wait and its Windows retry, owns-extend and the knowledge-owns rule of
// plan-check, the merge gate (trailers, non-local branch) and the product-answer resume path. Written before the code.
// The leak cases of item 14 live in the same file and are added by the task tests-leak, not here.
//
// Run with: node --test plugins/truss/tests/gates-026.check.ts
// Cross-platform (R-71): no real macOS or Windows host ran the platform-injected cases here; the injected branches run on the
// host's own OS with fixture paths and a fixture rm.
//
// Expected state when written: every case is red for its missing behaviour except "a commit already in the target is not refused
// for missing trailers" and "the product-answer resume path restarts the crew with the answer", which pin behaviour that exists.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, cpSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  REAL_FACTORY, REAL_PLUGIN, addCrewWorktree, appendEvent, assertOneLine, crew, factorySpawn, git, head, mkEnv, mkRepo, mkRun, mkTrussDir, planObj, pluginCopy, putFile, readPlan, runCli, tmp, writeGoal, writePlan,
} from './fixtures/workflow-run/harness.ts'

const CHECKOUT = path.resolve(REAL_PLUGIN, '..', '..').replace(/\\/g, '/')
const STAGE_PATH = `${REAL_PLUGIN}/workflows/stage.js`
const RESOURCES = `${REAL_PLUGIN}/resources/index.ts`
const CFG = { merge: 'sequential', target: 'main' }
const TRAILERS = 'Truss-Crew: s\nTruss-Role: builder'
const say = (r: any): string => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 700)}; stderr ${String(r.stderr).slice(0, 300)}`
const st = (name: string, fn: () => unknown) => test(name, { timeout: 120000 }, fn)

// ---------------------------------------------------------------- stage.js under a fake agent (the stubbed-agent runStage technique of stage-resources.check.ts)

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
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const tick = () => new Promise((r) => setImmediate(r))
const rj = (obj, exit = 0) => ({ exit, stdout: JSON.stringify(obj) })
const HEAD = 'a1'.repeat(20)
const BASE = 'd4'.repeat(20)
const PASS = `VERDICT: PASS\n\n## Proof checked\nHead: ${HEAD}\nPatch: ${'e5'.repeat(20)}\n`
const T1 = { name: 'write-tests', role: 'tester', effort: 'medium', files: ['tests/a.check.ts'], reads: ['src/a.ts'], brief: 'BRIEF-T1: write the tests for a', after: [] }
const B1 = { name: 'build-it', role: 'builder', effort: 'medium', files: ['src/a.ts'], reads: ['tests/a.check.ts'], brief: 'BRIEF-B1: build a', after: ['write-tests'] }
const done = (branch, proof = 'PROOF-' + branch) => ({ task: 'whatever', marker: 'DONE', branch, commit: 'c0'.repeat(20), proof, text: 'finished ' + branch })
const entry = (slug = 'a', o = {}) => ({
  slug, stage: 1, goalFile: `/proj/.truss/goals/${slug}.md`, goal: 'GOAL-TEXT', owns: ['src/**', 'tests/*.ts'],
  acceptanceTest: 'node --test tests/a.check.ts', highImpact: ['src/core/**'], stressTest: false, scope: 'SCOPE-VERBATIM: build a, nothing else',
  worktree: `/wt/${slug}`, branch: `truss/${slug}`, base: BASE, architecture: '/proj/docs/ARCH.md', adrs: ['/proj/docs/adr/0001-x.md'],
  resume: null, tasks: [], done: [], answers: [], spent: 0, labelFrom: {}, ...o,
})
const base = (slug = 'a', over = {}) => ({
  [`${slug}-planner`]: { tasks: [T1, B1], stop: null }, [`${slug}-tester`]: done('feat/t', 'PROOF-T'), [`${slug}-builder`]: done('feat/b', 'PROOF-B'), [`${slug}-qc`]: PASS, ...over,
})

// The first factory.ts command in a runner prompt decides what the call is. A heavy line holds a second one after ` -- `.
function parseRunner(prompt) {
  const line = String(prompt).split('\n').find((l) => /factory\.ts\s/.test(l))
  if (!line) return null
  const m = line.match(/factory\.ts\s+([\w-]+)(.*)$/)
  if (!m) return null
  const cmd = m[1]
  let outer = m[2]
  let inner = null
  if (cmd === 'heavy') {
    const cut = outer.indexOf(' -- ')
    if (cut >= 0) {
      inner = outer.slice(cut + 4)
      outer = outer.slice(0, cut)
    }
  }
  const flag = (text, name) => (text.match(new RegExp(`--${name}\\s+([^\\s\`]+)`)) || [])[1]
  const innerCmd = inner ? (inner.match(/factory\.ts\s+([\w-]+)/) || [])[1] : undefined
  const innerArgs = inner ? (inner.match(/factory\.ts\s+[\w-]+(.*)$/) || [])[1] || '' : ''
  return { line, cmd, slug: flag(outer, 'slug'), label: flag(outer, 'label'), expect: cmd === 'check' ? flag(outer, 'expect') : flag(innerArgs, 'expect'), innerCmd }
}
const isHeavyRed = (p) => p.cmd === 'heavy' && p.innerCmd === 'check' && p.expect === 'red'

async function exec(args, o = {}) {
  const body = readFileSync(STAGE_PATH, 'utf8').replace(/^\s*export\s+const\s+meta\b/m, 'const meta')
  const calls = []
  const unscripted = []
  const agent = async (prompt, opts = {}) => {
    const call = { prompt, opts, label: opts.label, i: calls.length }
    calls.push(call)
    await tick()
    if (/-runner(-\d+)?$/.test(String(opts.label))) {
      const p = parseRunner(prompt)
      if (!p) {
        unscripted.push(`${opts.label} (no factory.ts command in prompt)`)
        throw new Error(`unparsable runner prompt for label ${opts.label}`)
      }
      call.runner = p
      const real = p.cmd === 'heavy' ? p.innerCmd : p.cmd
      let out = o.runner ? await o.runner(p, call, calls) : undefined
      if (out === undefined) {
        if (p.cmd === 'admit') out = rj({ admitted: true, parallelism: 4, running: 0, freeMB: 8000, minFreeMB: 2048 })
        else if (p.cmd === 'reap') out = rj({ reaped: [], skipped: [] })
        else if (real === 'check') {
          const plain = p.expect === 'red' ? { ok: true } : { ok: true, head: HEAD }
          out = p.cmd === 'heavy' ? rj({ ...plain, heavy: { label: p.label, waitedMs: 0, exit: 0 } }) : rj(plain)
        } else if (p.cmd === 'integrate') out = rj({ merged: true })
        else if (p.cmd === 'owns-check') out = rj({ ok: true, outside: [] })
        else if (p.cmd === 'tests-check') out = rj({ ok: true, tests: [] })
        else if (p.cmd === 'sync') out = rj({ merged: true })
        else if (p.cmd === 'knowledge-lint' && /knowledge-lint --slug=\S/.test(p.line)) out = rj({ ok: true, failures: [], warnings: [] })
        else if (['decision-checkpoint', 'crew-learned', 'knowledge-commit', 'decision-ack', 'decisions'].includes(p.cmd)) out = rj({ ok: true, decisions: [] })
        else {
          unscripted.push(`${opts.label} (${p.cmd})`)
          throw new Error(`unscripted runner command ${p.cmd}`)
        }
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
        for (const s of stages) prev = await s(prev, item, i)
        return prev
      } catch {
        return null
      }
    }))
  let result
  let error
  try {
    result = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'allowance', body)(agent, parallel, pipeline, () => {}, () => {}, structuredClone(args), {})
  } catch (e) {
    error = e
  }
  return { result, error, calls, unscripted }
}

async function runStage(crews, o = {}) {
  const args = { truss: { kind: 'stage', dir: '/proj/.truss', repo: '/proj', plugin: REAL_PLUGIN, target: 'main', reworkAllowance: 2, roles: ROLES, scriptPath: STAGE_PATH, crews, ...(o.truss ?? {}) } }
  const r = await exec(args, o)
  assert.deepEqual(r.unscripted, [], `unscripted label(s): ${r.unscripted.join(', ')}`)
  if (r.error) throw r.error
  r.res = r.result
  return r
}

// ---------------------------------------------------------------- item 8: the heavy slot

st('gates-026: a busy heavy slot is re-waited before the crew is blocked', async () => {
  let heavy = 0
  const r = await runStage([entry('a')], {
    labels: base('a'),
    runner: (p) => {
      if (!isHeavyRed(p)) return undefined
      heavy++
      return heavy === 1 ? rj({ heavy: { label: 'a-check', ran: false, why: 'WHY-BUSY-ONCE' } }, 1) : undefined
    },
  })
  assert.equal(heavy, 2, `a busy then free slot is two heavy runs of the red check, got ${heavy}`)
  assert.equal(r.res[0].state, 'passed', `a slot that frees up on the second run lets the crew go on: ${JSON.stringify(r.res[0])}`)
})

st('gates-026: the heavy re-wait stops at its bound and blocks the crew', async () => {
  let heavy = 0
  const r = await runStage([entry('a')], {
    labels: base('a'),
    runner: (p) => {
      if (!isHeavyRed(p)) return undefined
      heavy++
      return rj({ heavy: { label: 'a-check', ran: false, why: 'WHY-BUSY-ALWAYS' } }, 1)
    },
  })
  assert.equal(heavy, 3, `an always busy slot is exactly 3 heavy runs per check (HEAVY_WAIT_ROUNDS), got ${heavy}`)
  assert.equal(r.res[0].state, 'stopped', JSON.stringify(r.res[0]))
  assert.equal(r.res[0].tag, 'BLOCKED')
  assert.ok(String(r.res[0].text).startsWith('heavy slot busy:'), `the stop text starts with the busy-slot reason:\n${r.res[0].text}`)
  assert.ok(r.res[0].text.includes('WHY-BUSY-ALWAYS'), r.res[0].text)
  assert.equal(r.calls.filter((c) => !c.runner).length, 0, 'a crew blocked at red spawns no member')
})

const EBUSY = () => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })

st('gates-026: releaseHeavySlot retries a locked directory on win32', async () => {
  const { takeHeavySlot, releaseHeavySlot } = await import(pathToFileURL(RESOURCES).href)
  const mk = () => {
    const dir = tmp('g026-rel-')
    const token = takeHeavySlot(dir, { pid: process.pid })
    assert.equal(typeof token, 'string', 'precondition: the slot was taken')
    return { dir, token }
  }
  // a fixture rm that behaves like a scanner holding the directory: EBUSY unless asked to retry
  const calls = []
  const rm = (p, opts = {}) => {
    calls.push(opts)
    if (!(typeof opts.maxRetries === 'number' && opts.maxRetries > 0)) throw EBUSY()
    rmSync(p, { recursive: true, force: true })
  }
  const w = mk()
  releaseHeavySlot(w.dir, w.token, 'win32', rm)
  assert.equal(calls.length, 1, 'win32 removes the lock through the injected rm')
  assert.ok(Number.isInteger(calls[0].maxRetries) && calls[0].maxRetries > 0, `win32 passes maxRetries > 0: ${JSON.stringify(calls[0])}`)
  assert.ok(typeof calls[0].retryDelay === 'number' && calls[0].retryDelay > 0, `win32 passes retryDelay > 0: ${JSON.stringify(calls[0])}`)
  assert.ok(!existsSync(`${w.dir}/resources/heavy.lock`), 'the lock is gone')
  for (const platform of ['darwin', 'linux']) {
    const seen = []
    const w2 = mk()
    releaseHeavySlot(w2.dir, w2.token, platform, (p, opts = {}) => { seen.push(opts); rmSync(p, { recursive: true, force: true }) })
    assert.equal(seen.length, 1, `${platform} removes the lock through the injected rm`)
    assert.ok(!('maxRetries' in seen[0]) && !('retryDelay' in seen[0]), `${platform} passes neither maxRetries nor retryDelay: ${JSON.stringify(seen[0])}`)
  }
  // a foreign token leaves the lock alone, on win32 too
  const w3 = mk()
  const none = []
  releaseHeavySlot(w3.dir, 'not-the-token', 'win32', (p, o) => none.push(o))
  assert.equal(none.length, 0)
  assert.ok(existsSync(`${w3.dir}/resources/heavy.lock`))
})

// the racers: each one imports resources/index.ts, waits for a common start time and takes the slot with the platform injected
const RACER = `import { takeHeavySlot } from ${JSON.stringify(pathToFileURL(RESOURCES).href)}
const [dir, platform, ownerPid, startAt, label] = process.argv.slice(2)
while (Date.now() < Number(startAt)) {}
let token
try {
  token = takeHeavySlot(dir, { label, slug: 'race', pid: Number(ownerPid) }, platform)
} catch (e) {
  token = 'THROW:' + (e && e.code)
}
process.stdout.write(JSON.stringify({ label, token }) + '\\n')
`

function runRacer(script, dir, platform, ownerPid, startAt, label) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [script, dir, platform, String(ownerPid), String(startAt), label], { windowsHide: true })
    let out = ''
    let err = ''
    c.stdout.on('data', (d) => (out += d))
    c.stderr.on('data', (d) => (err += d))
    c.on('close', (code) => resolve({ code, out, err, label }))
  })
}

st('gates-026: competing processes with darwin and win32 platforms leave exactly one heavy holder', async () => {
  const work = tmp('g026-race-')
  const script = `${work}/racer.mjs`
  writeFileSync(script, RACER)
  // a dead pid for the stale lock the racers fight over
  const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true })
  assert.ok(Number.isInteger(dead.pid) && dead.pid > 0, 'a finished child gives a dead pid')
  const RACERS = 8
  for (const platform of ['darwin', 'win32']) {
    for (let round = 0; round < 3; round++) {
      const dir = `${work}/${platform}-${round}`
      mkdirSync(`${dir}/resources/heavy.lock`, { recursive: true })
      writeFileSync(`${dir}/resources/heavy.lock/owner.json`, JSON.stringify({ pid: dead.pid, token: 'dead-owner-token', label: 'old', slug: 'old', since: 1 }))
      const startAt = Date.now() + 1500
      // owner.pid is this process: a winner that exits would leave a dead pid, and a later racer could legitimately take over
      const rs = await Promise.all(Array.from({ length: RACERS }, (_, i) => runRacer(script, dir, platform, process.pid, startAt, `r${i}`)))
      for (const r of rs) assert.equal(r.code, 0, `racer ${r.label} (${platform}) exited ${r.code}: ${r.err.slice(0, 300)}`)
      const tokens = rs.map((r) => JSON.parse(r.out.trim()).token)
      const winners = tokens.filter((t) => t !== null)
      assert.equal(winners.length, 1, `${platform} round ${round}: exactly one racer holds the slot, got ${JSON.stringify(tokens)}`)
      assert.match(winners[0], /^[0-9a-f-]{36}$/, 'the winner holds a real token')
      const owner = JSON.parse(readFileSync(`${dir}/resources/heavy.lock/owner.json`, 'utf8'))
      assert.equal(owner.token, winners[0], 'the lock on disk is the winner\'s')
    }
  }
  // The platform argument must reach the code. Without it every branch above runs the host's own, so the race would pass on a
  // build that ignores the argument. Here mkdirSync(lock) throws EACCES (a read-only <dir>/resources): win32 treats that as contention
  // (null), darwin lets it through. Skipped on win32 (chmod does not deny there) and for root (it ignores the mode).
  if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) return
  const { takeHeavySlot } = await import(pathToFileURL(RESOURCES).href)
  const dir = `${work}/readonly`
  mkdirSync(`${dir}/resources`, { recursive: true })
  chmodSync(`${dir}/resources`, 0o555)
  try {
    const take = (platform) => {
      try {
        return takeHeavySlot(dir, { pid: process.pid }, platform)
      } catch (e) {
        return `THROW:${e.code}`
      }
    }
    assert.equal(take('win32'), null, 'an injected win32 reads EACCES on mkdir as contention')
    assert.equal(take('darwin'), 'THROW:EACCES', 'an injected darwin lets EACCES through')
  } finally {
    chmodSync(`${dir}/resources`, 0o755)
  }
})

// ---------------------------------------------------------------- item 9: owns-extend, and the knowledge-owns rule of plan-check

function ownsWorld() {
  const env = mkEnv({ config: CFG, files: { 'a.txt': 'base\n' } })
  writePlan(env.dir, planObj([crew('s', { owns: ['src/s/**'], status: 'running' }), crew('t', { owns: ['src/t/**'], status: 'running' })]))
  const wt = addCrewWorktree(env.repo, 's')
  return { env, wt }
}

st('gates-026: owns-check refuses a file then passes it after owns-extend with no hand edit', () => {
  const { env, wt } = ownsWorld()
  putFile(wt, 'src/s/a.ts', 'a\n', 'inside')
  putFile(wt, 'docs/extra.md', 'x\n', 'outside the owns')
  const refused = env.run('owns-check', { slug: 's' })
  assert.equal(refused.status, 1, say(refused))
  assert.deepEqual(refused.json?.outside, ['docs/extra.md'], say(refused))
  const before = readFileSync(`${env.dir}/plan.json`, 'utf8')
  const ext = env.run('owns-extend', { slug: 's', glob: 'docs/extra.md', reason: 'REASON-KNOWLEDGE-FILE' })
  assert.equal(ext.status, 0, say(ext))
  const j = assertOneLine(ext)
  assert.equal(j.ok, true)
  assert.equal(j.slug, 's')
  assert.equal(j.glob, 'docs/extra.md')
  assert.deepEqual(j.owns, ['src/s/**', 'docs/extra.md'])
  // the only change to plan.json is the command's: crew s gained the glob, nothing else moved
  const planBefore = JSON.parse(before)
  const planAfter = readPlan(env.dir)
  planBefore.crews.find((c) => c.slug === 's').owns.push('docs/extra.md')
  assert.deepEqual(planAfter, planBefore, 'owns-extend changes the one crew\'s owns and nothing else')
  const ok = env.run('owns-check', { slug: 's' })
  assert.equal(ok.status, 0, say(ok))
  assert.equal(ok.json?.ok, true)
  const decisions = readFileSync(`${env.dir}/decisions.md`, 'utf8')
  const line = decisions.split('\n').find((l) => l.includes('docs/extra.md') && l.includes('REASON-KNOWLEDGE-FILE'))
  assert.ok(line, `a decisions.md line holds the glob and the reason:\n${decisions}`)
})

st('gates-026: owns-extend refuses a glob that overlaps another crew in the stage', () => {
  const { env } = ownsWorld()
  const before = readFileSync(`${env.dir}/plan.json`, 'utf8')
  const r = env.run('owns-extend', { slug: 's', glob: 'src/t/x.ts', reason: 'REASON-OVERLAP' })
  assert.equal(r.status, 1, say(r))
  const j = assertOneLine(r)
  assert.equal(j.ok, false)
  assert.equal(j.slug, 's')
  assert.equal(j.glob, 'src/t/x.ts')
  assert.ok(Array.isArray(j.overlaps) && j.overlaps.length > 0, say(r))
  const named = JSON.stringify(j.overlaps)
  assert.ok(named.includes('src/t/**'), `the overlap names the other crew's glob: ${named}`)
  assert.ok(/"t"|\bt:|\bt\b/.test(named), `the overlap names crew t: ${named}`)
  assert.equal(typeof j.why, 'string')
  assert.ok(j.why.length > 0)
  assert.equal(readFileSync(`${env.dir}/plan.json`, 'utf8'), before, 'a refused extension changes nothing')
  assert.ok(!readFileSync(`${env.dir}/decisions.md`, 'utf8').includes('REASON-OVERLAP'), 'a refused extension logs no decision')
})

const RULE = '.claude/rules/plugin-tests.md'

/** A temp git repo holding the real rule file (rulesIndex reads tracked files only) and a plan of this run's shape: stage 1 has one crew
 * owning the rule file and a test file; stage 2 has two crews owning test files under the rule's paths and no rule-file owner. */
function ruleWorld() {
  const text = readFileSync(`${CHECKOUT}/${RULE}`, 'utf8')
  const repo = mkRepo({ config: { architecture: 'docs/architecture.md', adr: 'docs/adr' }, files: { [RULE]: text } })
  assert.ok(git(repo, ['ls-files', RULE]) !== '', 'precondition: the rule file is tracked')
  const dir = mkTrussDir()
  const crews = [
    crew('rules-one', { stage: 1, owns: [RULE, 'plugins/truss/tests/one.check.ts'] }),
    crew('tests-a', { stage: 2, owns: ['plugins/truss/tests/a.check.ts'] }),
    crew('tests-b', { stage: 2, owns: ['plugins/truss/tests/b.check.ts'] }),
  ]
  writePlan(dir, planObj(crews))
  return { repo, dir, crews }
}
const planCheck = (w) => runCli(REAL_FACTORY, 'plan-check', ['--dir', w.dir, '--repo', w.repo], w.repo)

st('gates-026: plan-check refuses a stage whose crews match a rule file no crew owns', () => {
  const w = ruleWorld()
  const r = planCheck(w)
  assert.equal(r.status, 1, `plan-check must refuse: ${say(r)}`)
  const j = assertOneLine(r)
  assert.equal(j.ok, false)
  const hits = j.errors.filter((e) => e.includes(RULE))
  assert.equal(hits.length, 1, `one error names the rule file: ${JSON.stringify(j.errors)}`)
  const e = hits[0]
  assert.ok(e.includes('stage 2'), `it names the stage: ${e}`)
  assert.ok(!e.includes('stage 1'), `stage 1 owns the rule file and is not named: ${e}`)
  assert.ok(e.includes('tests-a') && e.includes('tests-b'), `it names both crews: ${e}`)
  assert.ok(e.includes(`add ${RULE} to the owns of one crew of stage 2`), `it states the one-line fix: ${e}`)
})

st('gates-026: plan-check accepts that stage once one crew owns the rule file', () => {
  const w = ruleWorld()
  // the refusal comes first, so this case fails on a plan-check without the rule
  const before = planCheck(w)
  assert.equal(before.status, 1, `precondition: the stage is refused before the fix: ${say(before)}`)
  w.crews[1].owns.push(RULE)
  writePlan(w.dir, planObj(w.crews))
  const after = planCheck(w)
  assert.equal(after.status, 0, say(after))
  assert.equal(assertOneLine(after).ok, true)
})

// ---------------------------------------------------------------- item 10: the merge gate

function crewEnv() {
  const env = mkEnv({ config: CFG, files: { 'a.txt': 'base\n' } })
  writePlan(env.dir, planObj([crew('s', { owns: ['src/s/**'], status: 'running' })]))
  const wt = addCrewWorktree(env.repo, 's')
  return { env, wt }
}
function memberWt(env, name, from = 'truss-s') {
  git(env.repo, ['branch', name, from])
  const mw = `${tmp('g026-member-')}/m`
  git(env.repo, ['worktree', 'add', '-q', mw, name])
  git(mw, ['config', 'user.name', 'T'])
  git(mw, ['config', 'user.email', 't@example.invalid'])
  return mw
}

st('gates-026: a member commit with no Truss trailers is refused by integrate', () => {
  const { env, wt } = crewEnv()
  const start = head(wt)
  const mw = memberWt(env, 'member')
  const bare = putFile(mw, 'src/s/a.ts', 'a\n', 'bare work with no trailers')
  putFile(mw, 'src/s/b.ts', 'b\n', 'one trailer only\n\nTruss-Crew: s')
  putFile(mw, 'src/s/c.ts', 'c\n', `both trailers\n\n${TRAILERS}`)
  const res = env.run('integrate', { slug: 's', branch: 'member' })
  assert.equal(res.status, 1, say(res))
  const j = assertOneLine(res)
  assert.equal(j.merged, false)
  assert.deepEqual(j.conflicts, [])
  assert.deepEqual(j.missingTrailers, [`${bare} bare work with no trailers`], 'only the commit with neither trailer is named')
  assert.equal(head(wt), start, 'nothing merged')
  // with the trailers added the same branch merges
  git(mw, ['reset', '-q', '--hard', 'truss-s'])
  putFile(mw, 'src/s/a.ts', 'a\n', `fixed\n\n${TRAILERS}`)
  const ok = env.run('integrate', { slug: 's', branch: 'member' })
  assert.equal(ok.status, 0, say(ok))
  assert.equal(ok.json?.merged, true)
})

// Expected green when written: a commit already in the target never counted, and no rule exists yet that could refuse it.
st('gates-026: a commit already in the target is not refused for missing trailers', () => {
  const { env, wt } = crewEnv()
  // a main commit with no trailers, which reaches the member branch through a merge
  putFile(env.repo, 'main-only.txt', 'm\n', 'main work with no trailers')
  const mainCommit = head(env.repo)
  const mw = memberWt(env, 'member')
  git(mw, ['merge', '--no-ff', '-q', '-m', 'merge main', 'main'])
  putFile(mw, 'src/s/new.ts', 'n\n', `member work\n\n${TRAILERS}`)
  assert.equal(git(mw, ['log', '--format=%H', `${head(wt)}..member`]).split('\n').includes(mainCommit), true, 'precondition: the main commit is in HEAD..member')
  const res = env.run('integrate', { slug: 's', branch: 'member' })
  assert.equal(res.status, 0, say(res))
  assert.equal(res.json?.merged, true, say(res))
  assert.ok(!('missingTrailers' in (res.json ?? {})), say(res))
})

st('gates-026: the merge gate refuses a non-local branch and says why', () => {
  const env = mkEnv({ config: { merge: 'sequential', target: 'origin/main' } })
  writePlan(env.dir, planObj([crew('a', { status: 'running', owns: ['**'], process: 'solo', workType: 'docs' })], { version: 4, approvedAt: '2026-10-01T00:00:00.000Z' }))
  writeGoal(env.dir, 'a')
  // origin/main exists only as refs/remotes/origin/main; there is no local branch of that name
  git(env.repo, ['update-ref', 'refs/remotes/origin/main', 'refs/heads/main'])
  const wt = addCrewWorktree(env.repo, 'a')
  putFile(wt, 'src/a/a.ts', 'a\n', `work a\n\n${TRAILERS.replace(': s', ': a')}`)
  const r = runCli(env.factory, 'land', ['--dir', env.dir, '--repo', env.repo, '--slug', 'a'], env.repo)
  assert.equal(r.status, 1, say(r))
  const j = assertOneLine(r)
  assert.equal(j.merged, false)
  const why = String(j.why)
  assert.ok(why.includes('origin/main'), `it names the target: ${why}`)
  assert.ok(why.includes('not a local branch'), `it says why: ${why}`)
  assert.ok(/git branch/.test(why) || /\btarget\b/.test(why) && why.includes('.claude/truss.json'), `it gives an actionable fix: ${why}`)
  assert.equal(git(env.repo, ['rev-parse', 'main']), head(env.repo), 'nothing was merged')
})

// ---------------------------------------------------------------- item 10: the bug-2 resume path

// Expected green when written: the path exists and has no direct test. Factory half: start --resume answers puts the earlier member
// branch in entry.prior and the answer in entry.answers; stage.js half: the restarted member's prompt carries both.
st('gates-026: the product-answer resume path restarts the crew with the answer', async () => {
  const slug = 'x'
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew(slug, { status: 'running', owns: ['src/x/**', 'crew/**', 'members/**'] })], { approvedAt: new Date(Date.now() - 4 * 3600_000).toISOString() }))
  writeGoal(env.dir, slug, {})
  const wt = addCrewWorktree(env.repo, slug)
  appendEvent(env.dir, factorySpawn(slug, new Date(Date.now() - 3 * 3600_000).toISOString()))
  mkdirSync(`${env.dir}/checks`, { recursive: true })
  writeFileSync(`${env.dir}/checks/${slug}-1.json`, JSON.stringify({ command: 'true', exit: 1, head: head(wt), tail: '' }))
  putFile(wt, 'crew/a.txt', 'a\n', 'crew a')
  git(wt, ['checkout', '-q', '-b', 'member-q', head(wt)])
  putFile(wt, 'members/q.txt', 'q\n', `member q work\n\n${TRAILERS.replace(': s', `: ${slug}`)}`)
  git(wt, ['checkout', '-q', `truss-${slug}`])
  const task = { name: 't-q', role: 'builder', effort: 'medium', files: ['members/q.txt'], reads: [], brief: 'BRIEF-TQ: build q', after: [] }
  const iso = (ms) => new Date(ms).toISOString()
  const endMs = Date.now() - 2 * 3600_000
  const run = mkRun(env.transcripts, 'wf_g026', [
    { label: `${slug}-planner`, startTs: iso(endMs - 120_000), endTs: iso(endMs - 100_000), result: { tasks: [task], stop: null } },
    { label: `${slug}-builder`, startTs: iso(endMs - 60_000), endTs: iso(endMs), result: { task: 't-q', marker: 'QUESTION', branch: 'member-q', commit: 'c0ffee', proof: 'ran it', text: 'which shape?' } },
  ], { journalMtimeMs: endMs })
  const answers = `${tmp('g026-ans-')}/answers.json`
  writeFileSync(answers, JSON.stringify([{ at: 't-q', text: 'ANSWER-USE-THE-FLAT-SHAPE' }]))
  const started = env.run('start', { slug, resume: 'answers', transcript: run.dir, answers })
  assert.equal(started.status, 0, say(started))
  const e = started.json.truss.crews[0]
  assert.deepEqual(e.prior, [{ at: 't-q', branch: 'member-q' }], 'the earlier member branch is listed for the successor')
  assert.deepEqual(e.answers, [{ at: 't-q', text: 'ANSWER-USE-THE-FLAT-SHAPE' }])
  // stage.js half: the restarted builder is spawned with the answer and told to merge the earlier branch after the crew branch
  const r = await runStage([e], {
    truss: { dir: env.dir, repo: env.repo },
    // the entry's runLabels hold x-planner and x-builder from the dead run, so the restarted member is x-builder-2
    labels: { [`${slug}-builder`]: done('feat/q', 'PROOF-Q'), [`${slug}-builder-2`]: done('feat/q', 'PROOF-Q'), [`${slug}-qc`]: PASS },
  })
  const builder = r.calls.find((c) => !c.runner && /-builder(-\d+)?$/.test(String(c.label)))
  assert.ok(builder, `the crew restarts the asking member: ${r.calls.map((c) => c.label).join(', ')}`)
  assert.ok(builder.prompt.includes('ANSWER-USE-THE-FLAT-SHAPE'), 'the restarted member\'s prompt carries the answer text')
  assert.ok(builder.prompt.includes('BRIEF-TQ: build q'), 'and the task brief')
  assert.ok(builder.prompt.includes(`git merge --no-ff -m "merge ${e.branch}" ${e.branch}`), 'it merges the crew branch first')
  assert.ok(builder.prompt.includes('git merge --no-ff -m "merge member-q" member-q'), 'then the earlier member branch')
})

// ---------------------------------------------------------------- seam for stage 2: holdOf

/** A private plugin copy whose inbox.escalate logs the item it gets and whose cost.budgetVerdict holds, with a `ref` when G026_REF is set. */
function budgetPlugin() {
  const d = tmp('g026-plugin-')
  cpSync(pluginCopy(), d, { recursive: true })
  const lay = (name, override) => {
    const p = `${d}/bin/${name}.ts`
    renameSync(p, `${d}/bin/${name}-real.ts`)
    writeFileSync(p, `export * from './${name}-real.ts'\n${override}`)
  }
  lay('inbox', [
    `import { appendFileSync } from 'node:fs'`,
    `export function blockingFor() { return [] }`,
    `export function escalate(repo, dir, item) { appendFileSync(process.env.G026_ESC_LOG, JSON.stringify(item) + '\\n'); return { id: 'E-20261110-aaaaaa', code: '', deduped: false, notified: true } }`,
    '',
  ].join('\n'))
  lay('cost', [
    `export function budgetVerdict() { return { held: true, scope: 'run', spentUsd: null, limitUsd: 1, why: 'the run budget of 1 USD is spent', ...(process.env.G026_REF ? { ref: process.env.G026_REF } : {}) } }`,
    '',
  ].join('\n'))
  return d
}

function admitWith(extraEnv) {
  const plugin = budgetPlugin()
  const env = mkEnv({ config: { architecture: 'docs/architecture.md', adr: 'docs/adr', budget: { runUsd: 1 } } })
  writePlan(env.dir, planObj([crew('alpha')]))
  writeGoal(env.dir, 'alpha')
  const log = `${tmp('g026-esc-')}/escalate.log`
  const r = runCli(`${plugin}/bin/factory.ts`, 'admit', ['--dir', env.dir, '--repo', env.repo, '--slug', 'alpha'], env.repo, { G026_ESC_LOG: log, ...extraEnv })
  const items = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  return { r, items, sid: path.basename(env.dir) }
}

st('gates-026: holdOf escalates on the ref the budget verdict carries', () => {
  const carried = admitWith({ G026_REF: 'budget:SESSION-REF:session:all' })
  assert.equal(carried.r.status, 1, say(carried.r))
  assert.equal(carried.r.json?.budget, true, say(carried.r))
  assert.equal(carried.items.length, 1, 'one escalation')
  assert.equal(carried.items[0].ref, 'budget:SESSION-REF:session:all', 'the escalation uses v.ref')
  // a verdict with no ref still gets today's composed ref
  const plain = admitWith({})
  assert.equal(plain.items.length, 1)
  assert.equal(plain.items[0].ref, `budget:${plain.sid}:run:run`, 'no ref on the verdict: the composed ref')
})

// ---------------------------------------------------------------- the design engineer's rule (PO 9)

// Residual: no graded eval covers the knowledge-owns rule in design-engineer.md. evals/case.schema.json:20 limits role to qc and
// checker and evals/run-model.ts:13-18 has tools only for those, so the runner cannot exercise the design engineer; this prose pin is
// the fallback, and plan-check (the plan-check cases above) enforces the rule in code.
st('gates-026: design-engineer tells the planner to put each crew\'s knowledge files in owns', () => {
  const text = readFileSync(`${REAL_PLUGIN}/agents/design-engineer.md`, 'utf8')
  const at = text.indexOf('4. **Crews.**')
  assert.ok(at >= 0, 'step 4 Crews exists')
  const next = text.indexOf('5. **Stages.**', at)
  const step = text.slice(at, next > at ? next : at + 3000)
  for (const needle of ['knowledge files', 'owns', 'one crew per file per stage']) assert.ok(step.includes(needle), `step 4 Crews contains "${needle}":\n${step}`)
})

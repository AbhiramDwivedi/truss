// @ts-nocheck
// truss ADR-0016 (plugin fixes), Decision 1: cases the stage-0 contract (plugin-fixes-factory-contract.check.ts) does not
// pin. Written from the ADR and plan revision 2 before the producer has the behaviour. The `start` warnings, the missing goal
// file refusal, envFailure's quote rule and tests-check's acceptance-file guard.
//
// Run with: node --test tests/factory-fixes.check.ts
//
// Naming: a case that must fail on today's bin/factory.ts is `ff <n>: ...`; a case that holds today is `control: ...`.
//
// Every run uses temp dirs made with mkdtemp (a repo, a truss dir, a plugin copy); the live truss dir is never touched.
// Every factory child env first drops any inherited TRUSS_SESSION_START and CLAUDE_PID (runCli does), then sets only what a
// case needs.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { addCrewWorktree, crew, flat, mkRepo, mkTrussDir, planObj, putFile, readEvents, readPlan, runCli, tmp, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const LONG_AGO = 1_700_000_000_000 // 2023-11: before this host's boot and before the test process
const say = (r) => `exit ${r.status}; stdout ${r.stdout.slice(0, 300)}; stderr ${r.stderr.slice(0, 300)}`

/** A private copy of the plugin tree with the stress agent file's mtime set; `withAgent: false` leaves the file out. */
function pluginWith(o: { mtime?: number; withAgent?: boolean } = {}): string {
  const d = tmp('ff-plugin-')
  for (const sub of ['bin', 'hooks', 'docs', 'workflows', 'resources', 'retro', 'agents']) if (existsSync(`${ROOT}/${sub}`)) cpSync(`${ROOT}/${sub}`, `${d}/${sub}`, { recursive: true })
  if (o.withAgent === false) rmSync(`${d}/agents/stress-engineer.md`, { force: true })
  else {
    assert.ok(existsSync(`${d}/agents/stress-engineer.md`), 'the checkout has agents/stress-engineer.md')
    const ms = o.mtime ?? LONG_AGO
    utimesSync(`${d}/agents/stress-engineer.md`, ms / 1000, ms / 1000)
  }
  return `${d}/bin/factory.ts`
}

function world(crews, goals: Record<string, { stressTest?: string }> = {}, noGoal: string[] = [], plan = {}) {
  const repo = mkRepo({ config: { merge: 'sequential', target: 'main' } })
  const dir = mkTrussDir()
  writePlan(dir, planObj(crews, plan))
  for (const c of crews) if (!noGoal.includes(String(c.slug))) writeGoal(dir, String(c.slug), goals[String(c.slug)] ?? {})
  return { repo, dir }
}

const start = (w, factory, env = {}) => runCli(factory, 'start', ['--stage', 'next', '--dir', w.dir, '--repo', w.repo], w.repo, env)

// ---------- start: warnings ----------

test('ff 1: a crew with Stress test no gets no warning, and a stage with no stress crew prints warnings: []', () => {
  const factory = pluginWith()
  const w = world([crew('plain'), crew('other')], { plain: { stressTest: 'no' }, other: { stressTest: 'no' } })
  const r = start(w, factory, { TRUSS_SESSION_START: '1' })
  assert.equal(r.status, 0, say(r))
  assert.ok(Array.isArray(r.json?.warnings), `start prints a warnings array; ${say(r)}`)
  assert.deepEqual(r.json.warnings, [])
  assert.equal(r.json.truss.crews.length, 2)
})

test('ff 2: with two stress crews starting, each gets one warning naming its slug and truss:stress-engineer; the no crew gets none', () => {
  const factory = pluginWith()
  const w = world([crew('alpha'), crew('beta'), crew('plain')], { alpha: { stressTest: 'yes' }, beta: { stressTest: 'yes' }, plain: { stressTest: 'no' } })
  const r = start(w, factory, { TRUSS_SESSION_START: '1' })
  assert.equal(r.status, 0, say(r))
  assert.ok(Array.isArray(r.json?.warnings), `start prints a warnings array; ${say(r)}`)
  assert.equal(r.json.warnings.length, 2, JSON.stringify(r.json.warnings))
  for (const slug of ['alpha', 'beta']) {
    const mine = r.json.warnings.filter((x) => String(x).includes(slug))
    assert.equal(mine.length, 1, `one warning names ${slug}: ${JSON.stringify(r.json.warnings)}`)
    assert.ok(String(mine[0]).includes('truss:stress-engineer'), String(mine[0]))
  }
  assert.ok(!r.json.warnings.some((x) => String(x).includes('plain')), 'the stress-no crew is not named')
  assert.equal(r.json.truss.crews.length, 3, 'warnings hold no crew')
})

test('ff 3: CLAUDE_PID naming a pid with no /proc entry gives a "can\'t tell" warning, never silence', () => {
  const factory = pluginWith()
  const w = world([crew('str')], { str: { stressTest: 'yes' } })
  const pid = '2147483000'
  assert.ok(!existsSync(`/proc/${pid}`), 'precondition: no such pid')
  const r = start(w, factory, { CLAUDE_PID: pid })
  assert.equal(r.status, 0, say(r))
  assert.ok(Array.isArray(r.json?.warnings), `start prints a warnings array; ${say(r)}`)
  assert.equal(r.json.warnings.length, 1, JSON.stringify(r.json.warnings))
  assert.ok(String(r.json.warnings[0]).includes("can't tell"), String(r.json.warnings[0]))
  assert.ok(String(r.json.warnings[0]).includes('str'))
})

test('ff 4: when the stress agent file cannot be stat\'d, the stress-yes crew still gets a "can\'t tell" warning', () => {
  const factory = pluginWith({ withAgent: false })
  const w = world([crew('str')], { str: { stressTest: 'yes' } })
  const r = start(w, factory, { TRUSS_SESSION_START: '1' })
  assert.equal(r.status, 0, say(r))
  assert.ok(Array.isArray(r.json?.warnings), `start prints a warnings array; ${say(r)}`)
  assert.equal(r.json.warnings.length, 1, JSON.stringify(r.json.warnings))
  assert.ok(String(r.json.warnings[0]).includes("can't tell") && String(r.json.warnings[0]).includes('str'), String(r.json.warnings[0]))
  assert.equal(r.json.truss.crews.length, 1)
})

test('ff 5: the /proc stat parse survives a comm holding spaces and parentheses', async () => {
  // A copy of sleep named ") x (" gives /proc/<pid>/comm = ") x (", so field 22 sits after the LAST ")" and a split on spaces
  // from the start of the line picks the wrong field. (A copy of node would not do: node renames its main thread.) The child
  // started just now, the agent file is from 2023: no warning.
  // (Case "CLAUDE_PID=1" in the stage-0 contract assumes pid 1 started before this checkout; fine on this host.)
  const sleepBin = ['/usr/bin/sleep', '/bin/sleep'].find((p) => existsSync(p))
  assert.ok(sleepBin, 'precondition: a sleep binary')
  const bin = `${tmp('ff-comm-')}/) x (`
  copyFileSync(sleepBin, bin)
  chmodSync(bin, 0o755)
  const child = spawn(bin, ['60'], { stdio: 'ignore' })
  try {
    await new Promise((res) => setTimeout(res, 300))
    assert.ok(child.pid, 'the child started')
    const stat = readFileSync(`/proc/${child.pid}/stat`, 'utf8')
    assert.ok(stat.includes(') x ('), `precondition: comm holds the awkward name: ${stat.slice(0, 80)}`)
    const factory = pluginWith({ mtime: LONG_AGO })
    const w = world([crew('str')], { str: { stressTest: 'yes' } })
    const r = start(w, factory, { CLAUDE_PID: String(child.pid) })
    assert.equal(r.status, 0, say(r))
    assert.ok(Array.isArray(r.json?.warnings), `start prints a warnings array; ${say(r)}`)
    assert.deepEqual(r.json.warnings, [])
  } finally {
    child.kill()
  }
})

// ---------- start: missing goal file ----------

test('ff 6: a refused missing-goal crew takes no slot and writes no spawn line', () => {
  const factory = `${ROOT}/bin/factory.ts`
  const w = world([crew('gone'), crew('has')], {}, ['gone'], { maxParallelCrews: 1 })
  const r = start(w, factory)
  assert.equal(r.status, 0, say(r))
  const refused = (r.json?.refused ?? []).find((x) => x.slug === 'gone')
  assert.ok(refused, `gone is refused: ${say(r)}`)
  assert.ok(flat(String(refused.reason)).includes(`${flat(w.dir)}/goals/gone.md`), String(refused.reason))
  assert.match(String(refused.reason), /missing/i)
  assert.deepEqual((r.json.truss?.crews ?? []).map((x) => x.slug), ['has'], 'the crew with a goal still starts under maxParallelCrews 1')
  assert.deepEqual(r.json.held, [])
  assert.ok(!(readEvents(w.dir)).some((e) => e.event === 'spawn' && e.crew === 'gone'), 'no spawn line for the refused crew')
  assert.equal(readPlan(w.dir).crews.find((c) => c.slug === 'gone').status, 'planned')
})

// ---------- envFailure ----------

async function envFailure(text: string): Promise<string | undefined> {
  const mod = await import(pathToFileURL(`${ROOT}/bin/factory.ts`).href)
  return mod.envFailure(text)
}

test('ff 7: a quoted "Cannot find package" echo inside JSON does not count, the bare node line for a declared package does', async () => {
  const d = tmp('ff-pkg-')
  writeFileSync(`${d}/package.json`, JSON.stringify({ dependencies: { declaredpkg: '1.0.0' } }))
  mkdirSync(`${d}/tests`)
  const bare = `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'declaredpkg' imported from ${d}/tests/a.check.ts`
  assert.ok((await envFailure(bare)) !== undefined, 'control: the bare node line for a declared package counts')
  const echoed = JSON.stringify({ out: bare })
  assert.equal(await envFailure(echoed), undefined, 'the same text echoed inside JSON is a code failure')
  assert.equal(await envFailure(`expected "${bare}" to equal 1`), undefined)
})

test('ff 8: a single-quoted TAP error: \'browserType.launch: ...\' still counts, a quote before the match on any other key does not', async () => {
  const tap = ['not ok 1 - launches', '  ---', "  error: 'browserType.launch: Executable doesn\\'t exist at /x'", '  ...'].join('\n')
  const got = await envFailure(tap)
  assert.ok(got !== undefined && got.includes('browserType.launch: '), String(got))
  // a quote that is not the one opening the YAML value still disqualifies the line
  assert.equal(await envFailure("  actual: 'x' + 'browserType.launch: boom'"), undefined)
})

// ---------- tests-check ----------

const msg = (role: string) => `work\n\nTruss-Crew: s\nTruss-Role: ${role}`

/** A crew worktree whose acceptanceTest is `at`; tests/acc.check.ts exists on main. Returns the worktree and a runner for tests-check. */
function checkWorld(at: string) {
  const repo = mkRepo({ config: { merge: 'sequential', target: 'main' }, files: { 'tests/acc.check.ts': 'base\n' } })
  const dir = mkTrussDir()
  writePlan(dir, planObj([crew('s', { owns: ['src/s/**', 'tests/**'], status: 'running', acceptanceTest: at })]))
  const wt = addCrewWorktree(repo, 's')
  const run = () => runCli(`${ROOT}/bin/factory.ts`, 'tests-check', ['--dir', dir, '--repo', repo, '--slug', 's'], repo)
  return { wt, run }
}

test('control: tests-check passes a test-writer commit that touches the acceptance file', () => {
  const { wt, run } = checkWorld('node --test tests/acc.check.ts')
  putFile(wt, 'tests/acc.check.ts', 'strengthened\n', msg('test-writer'))
  const r = run()
  assert.equal(r.status, 0, say(r))
  assert.equal(r.json?.ok, true)
})

test('ff 9: tests-check refuses a resolver commit to a file the acceptanceTest names', () => {
  const { wt, run } = checkWorld('node --test tests/acc.check.ts')
  putFile(wt, 'tests/other.check.ts', 'tw\n', msg('test-writer'))
  const bad = putFile(wt, 'tests/acc.check.ts', 'resolved\n', msg('resolver'))
  const r = run()
  assert.equal(r.status, 1, say(r))
  assert.equal(r.json?.ok, false, say(r))
  assert.deepEqual((r.json?.touched ?? []).map((t) => [t.commit, t.role, t.files]), [[bad, 'resolver', ['tests/acc.check.ts']]])
})

test('ff 10: the tests output lists the acceptance-named files with the test-writer files', () => {
  const { wt, run } = checkWorld('node --test tests/acc.check.ts')
  putFile(wt, 'tests/other.check.ts', 'tw\n', msg('test-writer'))
  putFile(wt, 'src/s/a.ts', 'code\n', msg('builder'))
  const r = run()
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(r.json?.tests, ['tests/acc.check.ts', 'tests/other.check.ts'])
})

test('control: an acceptanceTest token that names no existing file guards nothing and is not listed', () => {
  const { wt, run } = checkWorld('node --test tests/missing.check.ts')
  putFile(wt, 'tests/other.check.ts', 'tw\n', msg('test-writer'))
  putFile(wt, 'src/s/a.ts', 'code\n', msg('builder'))
  const r = run()
  assert.equal(r.status, 0, say(r))
  assert.equal(r.json?.ok, true)
  assert.deepEqual(r.json?.tests, ['tests/other.check.ts'])
})

// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0016 (plugin fixes), Decision 1 and Seams to pin: the four bin/factory.ts seams. Written from the ADR before
// the producer has them: `start` gains `warnings`, a crew with no goal file is refused, `envFailure` skips quoted echoes,
// and `tests-check` guards the files the acceptance test names.
//
// Run with: node --test tests/plugin-fixes-factory-contract.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs.
//
// The producer is read from $TRUSS_CONTRACT_ROOT/bin/factory.ts (default: the repo root). The root is only a place to
// read the producer from; nothing here branches on its value.
//
// Naming: a case that must fail on today's producer is `pf <n>: ...`; a case that holds today is `control: ...`.
//
// Every run uses temp dirs made with mkdtemp (a repo, a truss dir, a plugin copy); the live truss dir is never touched.
// Every factory child env first drops any inherited TRUSS_SESSION_START and CLAUDE_PID, then sets only what the case needs.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { crew, flat, git, highSampleFile, mkRepo, mkTrussDir, planObj, putFile, readPlan, tmp, writeGoal, writePlan, addCrewWorktree, head } from './fixtures/workflow-run/harness.ts'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const ROOT = (process.env.TRUSS_CONTRACT_ROOT || REPO_ROOT).replace(/\\/g, '/').replace(/\/$/, '')

// ---------- running the CLI ----------

type Res = { status: number | null; json: any; stdout: string; stderr: string }

/** The env a factory child gets: the caller's, minus TRUSS_SESSION_START and CLAUDE_PID, plus `extra`. */
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const e: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) e[k] = v
  delete e.TRUSS_SESSION_START
  delete e.CLAUDE_PID
  delete e.TRUSS_SAMPLE
  delete e.TRUSS_MIN_FREE_MB
  e.TRUSS_SAMPLE = highSampleFile()
  return Object.assign(e, extra)
}

function fac(factory: string, args: string[], cwd: string, extra: Record<string, string> = {}): Res {
  const r = spawnSync(process.execPath, [factory, ...args], { cwd, encoding: 'utf8', timeout: 120_000, env: childEnv(extra) })
  const stdout = r.stdout ?? ''
  const lines = stdout.split('\n').filter((l) => l.length > 0)
  let json: any
  if (lines.length === 1) {
    try {
      json = JSON.parse(lines[0])
    } catch {}
  }
  return { status: r.status, json, stdout, stderr: r.stderr ?? '' }
}

const say = (r: Res): string => `exit ${r.status}; stdout ${r.stdout.slice(0, 300)}; stderr ${r.stderr.slice(0, 300)}`

// ---------- a plugin copy with a stress agent file whose mtime a case sets ----------

let copy: string | undefined
/** A temp copy of the producer's plugin tree (bin, hooks, docs, workflows, resources, retro, agents). Built once; only the stress agent file's mtime changes. */
function pluginCopy(): string {
  if (copy) return copy
  const d = tmp('pf-plugin-')
  for (const sub of ['bin', 'hooks', 'docs', 'workflows', 'resources', 'retro', 'agents']) if (existsSync(`${ROOT}/${sub}`)) cpSync(`${ROOT}/${sub}`, `${d}/${sub}`, { recursive: true })
  copy = d
  return d
}

/** Sets the stress agent file's mtime (ms since the epoch) in the plugin copy and returns the copy's factory path. */
function factoryWithAgentMtime(ms: number): string {
  const d = pluginCopy()
  assert.ok(existsSync(`${d}/agents/stress-engineer.md`), 'the producer root has agents/stress-engineer.md')
  utimesSync(`${d}/agents/stress-engineer.md`, ms / 1000, ms / 1000)
  assert.ok(Math.abs(statSync(`${d}/agents/stress-engineer.md`).mtimeMs - ms) < 5, 'the agent file mtime was set')
  return `${d}/bin/factory.ts`
}

const LONG_AGO = 1_700_000_000_000 // 2023-11: before this test process and before this host's boot

/** A world for `start`: a repo, a truss dir with a plan of the given crews, and goal files for every slug except those in `noGoal`. */
function startWorld(crews: any[], goals: Record<string, { stressTest?: string }>, noGoal: string[] = []) {
  const repo = mkRepo({ config: { merge: 'sequential', target: 'main' } })
  const dir = mkTrussDir()
  writePlan(dir, planObj(crews))
  for (const c of crews) if (!noGoal.includes(String(c.slug))) writeGoal(dir, String(c.slug), goals[String(c.slug)] ?? {})
  return { repo, dir }
}

function start(w: { repo: string; dir: string }, factory: string, extra: Record<string, string>, more: string[] = []): Res {
  return fac(factory, ['start', '--stage', 'next', '--dir', w.dir, '--repo', w.repo, ...more], w.repo, extra)
}

const stressWorld = () => startWorld([crew('str'), crew('plain')], { str: { stressTest: 'yes' }, plain: { stressTest: 'no' } })

// ---------- start: warnings ----------

test('pf 1: start with TRUSS_SESSION_START after the stress agent file mtime gives warnings: []', () => {
  const factory = factoryWithAgentMtime(LONG_AGO)
  const w = stressWorld()
  const r = start(w, factory, { TRUSS_SESSION_START: String(LONG_AGO + 100_000) })
  assert.equal(r.status, 0, say(r))
  assert.ok(Array.isArray(r.json?.warnings), `start prints a warnings array; ${say(r)}`)
  assert.deepEqual(r.json.warnings, [])
})

test('pf 2: TRUSS_SESSION_START=1 with a stress-yes crew gives one warning naming the crew and truss:stress-engineer', () => {
  const factory = factoryWithAgentMtime(LONG_AGO)
  const w = stressWorld()
  const r = start(w, factory, { TRUSS_SESSION_START: '1' })
  assert.equal(r.status, 0, say(r))
  assert.ok(Array.isArray(r.json?.warnings), `start prints a warnings array; ${say(r)}`)
  assert.equal(r.json.warnings.length, 1, `one warning, for the one stress crew; ${JSON.stringify(r.json.warnings)}`)
  const text = String(r.json.warnings[0])
  assert.ok(text.includes('str'), `the warning names the crew: ${text}`)
  assert.ok(!text.includes('plain'), `the warning does not name the crew with no stress test: ${text}`)
  assert.ok(text.includes('truss:stress-engineer'), `the warning names the role: ${text}`)
  assert.equal(r.json.truss.crews.length, 2, 'a warning never holds or refuses a crew')
  assert.deepEqual(r.json.refused, [])
})

test('pf 3: a start with no TRUSS_SESSION_START and CLAUDE_PID=1 gives a definite warning, not "can\'t tell"', () => {
  // pid 1 started at boot, so an agent file written now is later than the session start.
  const factory = factoryWithAgentMtime(Date.now())
  const w = stressWorld()
  const r = start(w, factory, { CLAUDE_PID: '1' })
  assert.equal(r.status, 0, say(r))
  assert.ok(Array.isArray(r.json?.warnings), `start prints a warnings array; ${say(r)}`)
  assert.equal(r.json.warnings.length, 1, JSON.stringify(r.json.warnings))
  const text = String(r.json.warnings[0])
  assert.ok(text.includes('str') && text.includes('truss:stress-engineer'), text)
  assert.ok(!text.includes("can't tell"), `a readable CLAUDE_PID gives a definite warning: ${text}`)
})

test('pf 4: no TRUSS_SESSION_START and CLAUDE_PID set to the test pid gives no warning', () => {
  // this process started before now, and the agent file is from 2023, so the file is older than the session.
  const factory = factoryWithAgentMtime(LONG_AGO)
  const w = stressWorld()
  const r = start(w, factory, { CLAUDE_PID: String(process.pid) })
  assert.equal(r.status, 0, say(r))
  assert.ok(Array.isArray(r.json?.warnings), `start prints a warnings array; ${say(r)}`)
  assert.deepEqual(r.json.warnings, [])
})

test('pf 5: neither TRUSS_SESSION_START nor CLAUDE_PID gives a "can\'t tell" warning for the stress crew', () => {
  const factory = factoryWithAgentMtime(LONG_AGO)
  const w = stressWorld()
  const r = start(w, factory, {})
  assert.equal(r.status, 0, say(r))
  assert.ok(Array.isArray(r.json?.warnings), `start prints a warnings array; ${say(r)}`)
  assert.equal(r.json.warnings.length, 1, JSON.stringify(r.json.warnings))
  const text = String(r.json.warnings[0])
  assert.ok(text.includes("can't tell"), text)
  assert.ok(text.includes('str'), `names the crew: ${text}`)
  assert.equal(r.json.truss.crews.length, 2, 'a warning never holds a crew')
})

test('pf 6: the --args-file pointer carries warnings after unfinished', () => {
  const factory = factoryWithAgentMtime(LONG_AGO)
  const w = stressWorld()
  const file = `${tmp('pf-args-')}/args.json`
  const r = start(w, factory, { TRUSS_SESSION_START: '1' }, ['--args-file', file])
  assert.equal(r.status, 0, say(r))
  const keys = Object.keys(r.json ?? {})
  assert.ok(keys.includes('unfinished'), `the pointer keeps unfinished: ${keys.join(',')}`)
  assert.ok(keys.includes('warnings'), `the pointer carries warnings: ${keys.join(',')}`)
  assert.equal(keys.indexOf('warnings'), keys.indexOf('unfinished') + 1, `warnings comes right after unfinished: ${keys.join(',')}`)
  assert.equal(r.json.warnings.length, 1, JSON.stringify(r.json.warnings))
  assert.ok(Array.isArray(JSON.parse(readFileSync(file, 'utf8')).warnings), 'the file holds warnings too')
})

// ---------- start: missing goal file ----------

test('pf 7: a crew with no goal file is refused with a reason naming the path and "missing", gets no worktree and stays planned', () => {
  const factory = `${ROOT}/bin/factory.ts`
  const w = startWorld([crew('has'), crew('gone')], {}, ['gone'])
  const r = start(w, factory, {})
  assert.equal(r.status, 0, say(r))
  const refused = (r.json?.refused ?? []).find((x: any) => x.slug === 'gone')
  assert.ok(refused, `gone is in refused: ${say(r)}`)
  const path = `${w.dir}/goals/gone.md`
  assert.ok(flat(String(refused.reason)).includes(path), `the reason names ${path}: ${refused.reason}`)
  assert.match(String(refused.reason), /missing/i)
  assert.ok(!existsSync(`${w.repo}/.claude/worktrees/truss-gone`), 'no worktree for the refused crew')
  assert.ok(!(r.json.foremen ?? []).some((x: any) => x.slug === 'gone'), 'not under foremen')
  assert.ok(!(r.json.truss?.crews ?? []).some((x: any) => x.slug === 'gone'), 'not a workflow crew either')
  assert.equal(readPlan(w.dir).crews.find((c: any) => c.slug === 'gone').status, 'planned')
})

test('control: a crew with a goal file still starts as a workflow crew in its own worktree', () => {
  const factory = `${ROOT}/bin/factory.ts`
  const w = startWorld([crew('has')], {})
  const r = start(w, factory, {})
  assert.equal(r.status, 0, say(r))
  assert.deepEqual((r.json.truss.crews ?? []).map((x: any) => x.slug), ['has'])
  assert.deepEqual(r.json.refused, [])
  assert.ok(existsSync(`${w.repo}/.claude/worktrees/truss-has`), 'the crew has a worktree')
  assert.equal(readPlan(w.dir).crews[0].status, 'running')
})

// ---------- envFailure ----------

async function envFailure(text: string): Promise<string | undefined> {
  const mod = await import(pathToFileURL(`${ROOT}/bin/factory.ts`).href)
  assert.equal(typeof mod.envFailure, 'function', 'bin/factory.ts exports envFailure')
  return mod.envFailure(text)
}

test('pf 8: envFailure returns undefined for an env string echoed inside JSON, single quotes or backticks', async () => {
  const json = '{"message":"browserType.launch: Executable doesn\'t exist at /x"}'
  const single = "AssertionError: expected 'browserType.launch: failed' to be ok"
  const tick = 'expected `error while loading shared libraries: libnss3.so` to equal the fixture'
  const found = [json, single, tick].map((t) => [t, undefined as string | undefined])
  for (const f of found) f[1] = await envFailure(f[0] as string)
  assert.deepEqual(found.filter((f) => f[1] !== undefined), [], 'a quoted echo is a code failure, not an env failure')
})

test('control: a TAP error: |- block whose message line is unquoted still counts', async () => {
  const tap = ['not ok 1 - launches', '  ---', '  error: |-', '    browserType.launch: Executable doesn\'t exist at /x', '    Looks like Playwright was just installed', '  ...'].join('\n')
  const got = await envFailure(tap)
  assert.ok(got !== undefined && got.includes('browserType.launch: '), String(got))
})

test('control: a TAP single-line error: "browserType.launch: Executable doesn\'t exist at /x" still counts', async () => {
  const tap = ['not ok 1 - launches', '  ---', '  error: "browserType.launch: Executable doesn\'t exist at /x"', '  ...'].join('\n')
  const got = await envFailure(tap)
  assert.ok(got !== undefined && got.includes('browserType.launch: '), String(got))
})

test('control: a real loader line counts', async () => {
  const got = await envFailure('node: error while loading shared libraries: libnss3.so: cannot open shared object file')
  assert.ok(got !== undefined && got.includes('error while loading shared libraries: '), String(got))
})

test('control: a real Playwright line counts', async () => {
  const got = await envFailure('Error: browserType.launch: Host system is missing dependencies to run browsers.')
  assert.ok(got !== undefined && got.includes('browserType.launch: '), String(got))
})

// ---------- tests-check ----------

const roleMsg = (role: string) => `work\n\nTruss-Crew: s\nTruss-Role: ${role}`

/** A crew worktree whose acceptanceTest names tests/acc.check.ts, which exists on main, plus a test-writer commit touching only tests/other.check.ts. */
function checkWorld() {
  const repo = mkRepo({ config: { merge: 'sequential', target: 'main' }, files: { 'tests/acc.check.ts': 'base\n' } })
  const dir = mkTrussDir()
  writePlan(dir, planObj([crew('s', { owns: ['src/s/**', 'tests/**'], status: 'running', acceptanceTest: 'node --test tests/acc.check.ts' })]))
  const wt = addCrewWorktree(repo, 's')
  putFile(wt, 'tests/other.check.ts', 'test\n', roleMsg('test-writer'))
  const run = () => fac(`${ROOT}/bin/factory.ts`, ['tests-check', '--dir', dir, '--repo', repo, '--slug', 's'], repo)
  return { wt, run }
}

test('pf 9: tests-check refuses a builder commit to a file the acceptanceTest names that no test-writer touched', () => {
  const { wt, run } = checkWorld()
  const bad = putFile(wt, 'tests/acc.check.ts', 'weakened\n', roleMsg('builder'))
  const r = run()
  assert.equal(r.status, 1, say(r))
  assert.equal(r.json?.ok, false, say(r))
  assert.deepEqual((r.json?.touched ?? []).map((t: any) => [t.commit, t.role, t.files]), [[bad, 'builder', ['tests/acc.check.ts']]])
})

test('control: tests-check passes a builder commit that touches no acceptance file', () => {
  const { wt, run } = checkWorld()
  putFile(wt, 'src/s/a.ts', 'code\n', roleMsg('builder'))
  const r = run()
  assert.equal(r.status, 0, say(r))
  assert.equal(r.json?.ok, true)
})

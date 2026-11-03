// @ts-nocheck
// ADR-0027 (retro-fixes2), crew factory-decide: F-67 item 2 (factory.ts refuses a relative --dir except for start), F-73
// (`factory.ts decide` and the SKILL.md route) and F-74 item 4 (SKILL.md "Scrub before merge" joins with && and never pipes).
//
// Written from the ADR before the fix exists. Every case titled `F.. n:` fails on the base code; every `control n:` passes before and
// after. The file drives bin/factory.ts through the CLI (harness runCli / mkEnv), and reads SKILL.md and scripts/retro.py relative to
// this file's own location, so a copy of tests/ placed in a base copy of the plugin exercises that copy's code.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { addCrewWorktree, appendEvent, crew, factorySpawn, git, mkEnv, planObj, putFile, readPlan, runCli, tmp, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKILL = join(PLUGIN, 'skills', 'run', 'SKILL.md')
const RETRO_PY = join(PLUGIN, 'scripts', 'retro.py')
const CFG = { merge: 'sequential', target: 'main' }
const HOUR = 3_600_000
const say = (r: any): string => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 600)}; stderr ${String(r.stderr).slice(0, 300)}`
const logOf = (env: any): string => (existsSync(`${env.dir}/decisions.md`) ? readFileSync(`${env.dir}/decisions.md`, 'utf8') : '')
const decide = (env: any, flags: Record<string, unknown>, extra: string[] = []) => env.run('decide', { repo: null, ...flags }, extra)

/** A refusal: exit 2 with a non-empty error message, and decisions.md exactly as it was. */
function assertRefused(env: any, r: any, before: string, what: string): void {
  assert.equal(r.status, 2, `${what}: expected exit 2; ${say(r)}`)
  assert.equal(typeof r.json?.error, 'string', `${what}: expected a {"error": ...} line; ${say(r)}`)
  assert.ok(r.json.error.length > 0, `${what}: empty error`)
  assert.equal(logOf(env), before, `${what}: wrote to decisions.md`)
}

/** A world with an approved plan and crew x running, as the mark-merged cases build it. */
function runningWorld() {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew('x', { status: 'running' })], { approvedAt: new Date(Date.now() - 3 * HOUR).toISOString() }))
  writeGoal(env.dir, 'x')
  const wt = addCrewWorktree(env.repo, 'x')
  appendEvent(env.dir, factorySpawn('x', new Date(Date.now() - 3 * HOUR).toISOString()))
  putFile(wt, 'src/x/a.ts', 'x\n', 'work')
  return env
}

/** scripts/retro.py read_decisions on `file`, as the fields a retro reads, from a python child that loads retro.py by path. */
function readDecisions(file: string): any {
  const d = tmp('retro-driver-')
  const driver = join(d, 'driver.py')
  writeFileSync(
    driver,
    [
      'import importlib.util, json, sys',
      'spec = importlib.util.spec_from_file_location("retro_under_test", sys.argv[1])',
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'runs, pre, used = m.read_decisions(sys.argv[2])',
      'keep = lambda r: {k: r[k] for k in ("started", "goal", "decisions", "freeform", "recommendations")}',
      'print(json.dumps({"runs": [keep(r) for r in runs], "pre": keep(pre), "preUsed": used}))',
      '',
    ].join('\n'),
  )
  const r = spawnSync('python3', ['-I', driver, RETRO_PY, file], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, `python3 read_decisions failed: ${r.stderr}`)
  return JSON.parse(r.stdout)
}

const body = (p: string): string => readFileSync(p, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')

// ---------------------------------------------------------------------------------------------------------------
// F-67 item 2: a relative --dir

test('F67 3: a non-start command given a relative --dir exits 2 with a usage error; start given a relative --dir still resolves it', () => {
  const env = runningWorld()
  const cwd = tmpdir()
  const rel = relative(cwd, env.dir)
  assert.ok(!isAbsolute(rel), 'the test needs a relative path')
  for (const cmd of ['admit', 'sync']) {
    const abs = env.run(cmd, { slug: 'x' })
    assert.notEqual(abs.status, 2, `${cmd} with the absolute --dir is not a usage error (setup check); ${say(abs)}`)
    const r = runCli(env.factory, cmd, ['--dir', rel, '--repo', env.repo, '--slug', 'x'], cwd)
    assert.equal(r.status, 2, `${cmd} with a relative --dir must exit 2; ${say(r)}`)
    assert.equal(typeof r.json?.error, 'string', `${cmd}: a usage error body; ${say(r)}`)
    assert.match(r.json.error, /dir/i, `${cmd}: the error names --dir; ${say(r)}`)
  }
  // start resolves it, as ADR-0019 item 18 left it
  const env2 = mkEnv({ config: CFG })
  writePlan(env2.dir, planObj([crew('y')]))
  writeGoal(env2.dir, 'y')
  const s = runCli(env2.factory, 'start', ['--dir', relative(cwd, env2.dir), '--repo', relative(cwd, env2.repo), '--stage', 'next'], cwd)
  assert.equal(s.status, 0, `start with a relative --dir still works; ${say(s)}`)
  assert.ok(isAbsolute(String(s.json.truss.dir)), `start emits an absolute dir; ${say(s)}`)
})

test('control 1: F67 an absolute --dir works', () => {
  const env = runningWorld()
  const r = env.run('admit', { slug: 'x' })
  assert.equal(r.status, 0, say(r))
  assert.equal(typeof r.json?.admitted, 'boolean', say(r))
})

// ---------------------------------------------------------------------------------------------------------------
// F-73: decide

test('F73 1: decide appends one four-field decision line, - HH:MM | a | b | c | d', () => {
  const env = mkEnv({ config: CFG })
  const r = decide(env, { line: 'a | b | c | d' })
  assert.equal(r.status, 0, say(r))
  assert.ok(r.json && typeof r.json === 'object', `one JSON line on stdout; ${say(r)}`)
  assert.match(logOf(env), /^- \d{2}:\d{2} \| a \| b \| c \| d\n$/, JSON.stringify(logOf(env)))
  const r2 = decide(env, { line: 'e | f | g | followed' })
  assert.equal(r2.status, 0, say(r2))
  const lines = logOf(env).split('\n').filter(Boolean)
  assert.equal(lines.length, 2, 'one line per call')
  assert.match(lines[1], /^- \d{2}:\d{2} \| e \| f \| g \| followed$/)
})

test('F73 2: the decision form refuses fewer or more than four fields, and a newline in any form, and writes nothing', () => {
  const env = mkEnv({ config: CFG })
  // the valid call works first, so a refusal below is the field rule and not an unknown command
  const ok = decide(env, { line: 'a | b | c | d' })
  assert.equal(ok.status, 0, `a four-field line is accepted; ${say(ok)}`)
  const before = logOf(env)
  assert.match(before, /^- \d{2}:\d{2} \| a \| b \| c \| d\n$/)
  for (const [what, line] of [['three fields', 'a | b | c'], ['two fields', 'a | b'], ['one field', 'a'], ['five fields', 'a | b | c | d | e'], ['six fields', 'a | b | c | d | e | f']]) {
    const r = decide(env, { line })
    assertRefused(env, r, before, what)
    assert.match(r.json.error, /field|\|/i, `${what}: the error names the field count; ${say(r)}`)
  }
  for (const nl of ['\n', '\r', '\r\n']) {
    assertRefused(env, decide(env, { line: `a | b | c\n| d`.replace('\n', nl) }), before, `newline ${JSON.stringify(nl)} in the decision form`)
    assertRefused(env, decide(env, { checker: 3, recommend: 'answer', text: `x${nl}y`, outcome: 'followed' }), before, `newline ${JSON.stringify(nl)} in the checker text`)
    assertRefused(env, decide(env, { checker: 3, recommend: 'answer', text: 'x', outcome: `fol${nl}lowed` }), before, `newline ${JSON.stringify(nl)} in the checker outcome`)
    assertRefused(env, decide(env, { run: `goal${nl}more` }), before, `newline ${JSON.stringify(nl)} in the run heading`)
  }
  // the checker form is not held to four fields; a valid call still writes
  const after = decide(env, { checker: 2, recommend: 'pass', text: 'a | b | c | d | e', outcome: 'followed' })
  assert.equal(after.status, 0, `the field-count rule is the decision form's only; ${say(after)}`)
})

test('F73 3: SKILL.md names factory.ts decide as the only route to decisions.md and drops "with Edit or Write"', () => {
  const b = body(SKILL).replace(/[`*]/g, '').replace(/\s+/g, ' ')
  assert.match(b, /factory\.ts decide/, 'the body names factory.ts decide')
  assert.match(b, /decide[^.]*\b(only|never)\b|\b(only|never)\b[^.]*decide/i, 'decide is called the only route')
  assert.doesNotMatch(b, /with Edit or Write/i, 'the Edit or Write route is gone')
  assert.doesNotMatch(b, /decisions\.md[^.]*\bwith (an )?Edit\b/i, 'no sentence sends a decisions.md write through Edit')
})

test('F73 4: decide writes the "Run <start> | <goal>" heading', () => {
  const env = mkEnv({ config: CFG })
  const t0 = Date.now()
  const r = decide(env, { run: 'fix the plugin bugs' })
  assert.equal(r.status, 0, say(r))
  const m = /^## Run (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) \| fix the plugin bugs\n$/.exec(logOf(env))
  assert.ok(m, JSON.stringify(logOf(env)))
  assert.ok(Math.abs(Date.parse(m[1]) - t0) < 120_000, `<start> is the clock's UTC time, got ${m[1]}`)
  const bad = decide(env, { run: '' })
  assert.equal(bad.status, 2, `an empty goal is refused; ${say(bad)}`)
  assert.equal(logOf(env).split('\n').filter(Boolean).length, 1, 'a refused heading writes nothing')
})

test('F73 5: decide writes the checker form - HH:MM | checker-<n> RECOMMEND <answer|defer|pass>: <text> | <outcome>', () => {
  const env = mkEnv({ config: CFG })
  for (const [n, rec] of [[1, 'answer'], [12, 'defer'], [3, 'pass']]) {
    const r = decide(env, { checker: n, recommend: rec, text: `item ${n} reason`, outcome: 'followed' })
    assert.equal(r.status, 0, say(r))
  }
  const lines = logOf(env).split('\n').filter(Boolean)
  assert.equal(lines.length, 3)
  assert.match(lines[0], /^- \d{2}:\d{2} \| checker-1 RECOMMEND answer: item 1 reason \| followed$/)
  assert.match(lines[1], /^- \d{2}:\d{2} \| checker-12 RECOMMEND defer: item 12 reason \| followed$/)
  assert.match(lines[2], /^- \d{2}:\d{2} \| checker-3 RECOMMEND pass: item 3 reason \| followed$/)
  const before = logOf(env)
  for (const [what, flags] of [
    ['an unknown answer', { checker: 1, recommend: 'maybe', text: 't', outcome: 'followed' }],
    ['a zero checker number', { checker: 0, recommend: 'answer', text: 't', outcome: 'followed' }],
    ['a non-numeric checker number', { checker: 'x', recommend: 'answer', text: 't', outcome: 'followed' }],
  ] as const) {
    const r = decide(env, { ...flags })
    assert.equal(r.status, 2, `${what}: exit 2; ${say(r)}`)
    assert.equal(logOf(env), before, `${what}: writes nothing`)
  }
})

test('F73 6: a decision line and a Run heading that decide writes are read by retro.py read_decisions like the hand-written equivalents', () => {
  const env = mkEnv({ config: CFG })
  for (const flags of [
    { run: 'first goal' },
    { line: '[g] a decision | because | checker-1 answer | followed' },
    { checker: 1, recommend: 'answer', text: 'an item', outcome: 'followed' },
    { run: 'second goal' },
    { line: 'another | why | none | overruled: reason' },
  ]) {
    const r = decide(env, { ...flags })
    assert.equal(r.status, 0, say(r))
  }
  const written = readFileSync(`${env.dir}/decisions.md`, 'utf8')
  const heads = written.split('\n').filter((l) => l.startsWith('## Run '))
  assert.equal(heads.length, 2, JSON.stringify(written))
  const startOf = (h: string): string => h.slice('## Run '.length).split(' | ')[0]
  const hand =
    `## Run ${startOf(heads[0])} | first goal\n- 09:30 | [g] a decision | because | checker-1 answer | followed\n- 09:31 | checker-1 RECOMMEND answer: an item | followed\n` +
    `## Run ${startOf(heads[1])} | second goal\n- 09:32 | another | why | none | overruled: reason\n`
  const dFile = join(tmp('retro-written-'), 'decisions.md')
  const hFile = join(tmp('retro-hand-'), 'decisions.md')
  writeFileSync(dFile, written)
  writeFileSync(hFile, hand)
  const got = readDecisions(dFile)
  const want = readDecisions(hFile)
  assert.deepEqual(got, want, 'the same fields and the same run split')
  assert.equal(got.runs.length, 2, 'the two headings split two runs')
  assert.deepEqual(got.runs.map((r: any) => r.goal), ['first goal', 'second goal'])
  assert.notEqual(got.runs[0].started, 'not recorded', 'the start parses as a time')
  assert.equal(got.runs[0].decisions.total, 1)
  assert.equal(got.runs[0].decisions.followed, 1)
  assert.equal(got.runs[0].recommendations.answer >= 1, true)
  assert.equal(got.runs[1].decisions.overruled, 1)
  assert.equal(got.runs[0].freeform + got.runs[1].freeform, 0, 'no line reads as freeform')
  assert.equal(got.preUsed, false, 'nothing falls before the first heading')
})

test('control 2: F73 an existing appendDecision caller (mark-merged, absolute --dir) still appends - HH:MM | <text> | none | followed, and retro.py reads it', () => {
  const env = runningWorld()
  git(env.repo, ['merge', '-q', '--no-ff', '-m', 'merge x outside finish', 'truss-x'])
  const r = env.run('mark-merged', { slug: 'x' })
  assert.equal(r.status, 0, say(r))
  assert.equal(readPlan(env.dir).crews.find((c: any) => c.slug === 'x').status, 'merged')
  const lines = logOf(env).split('\n').filter(Boolean)
  assert.equal(lines.length, 1, JSON.stringify(logOf(env)))
  assert.match(lines[0], /^- \d{2}:\d{2} \| .*\bx\b.* \| none \| followed$/)
  const f = join(tmp('retro-ctl-'), 'decisions.md')
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, `## Run 2026-11-03T10:00:00Z | some goal\n${lines[0]}\n`)
  const got = readDecisions(f)
  assert.equal(got.runs.length, 1)
  assert.equal(got.runs[0].goal, 'some goal')
  assert.equal(got.runs[0].decisions.total, 1)
  assert.equal(got.runs[0].decisions.clock, 1)
  assert.equal(got.runs[0].decisions.followed, 1)
  assert.equal(got.runs[0].freeform, 0)
})

// ---------------------------------------------------------------------------------------------------------------
// F-74 item 4: SKILL.md "Scrub before merge"

test('F74 4: SKILL.md "Scrub before merge" joins scrub and push or merge with && and never pipes scrub output', () => {
  const b = body(SKILL).replace(/[`*]/g, '')
  const at = b.indexOf('Scrub before merge')
  assert.ok(at >= 0, 'the body has a "Scrub before merge" paragraph')
  const para = b.slice(at).split(/\n\s*\n/)[0].replace(/\s+/g, ' ')
  assert.match(para, /scrub/i)
  assert.match(para, /\b(push|merge)\b/i)
  assert.match(para, /&&/, 'scrub and the push or merge are joined with &&')
  assert.match(para, /\bpip(e|es|ed|ing)\b/i, 'the paragraph speaks of a pipe')
  assert.match(para, /\b(never|not|no)\b[^.]*\bpip(e|es|ed|ing)\b|\bpip(e|es|ed|ing)\b[^.]*\b(never|not)\b/i, 'and forbids piping scrub output')
})

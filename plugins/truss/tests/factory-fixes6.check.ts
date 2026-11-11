// @ts-nocheck
// ADR-0026 (the factory items, built by factory-fixes6-build): 46 start --slug S without --resume, 49 the planner-stale warning
// (empty numstat, once per hash), 50 start --model, 53 the deferred start-fixes4 gaps, 56 finish warns for a merged agents/*.md,
// 57 admit holds a new crew at memory pressure or swap use, and 58 the resume-fixes4 GAPs (rebased member, YAML block, integrate
// under a merge, cherry-pick, revert or rebase in progress).
//
// Every case drives bin/factory.ts through the CLI (harness runCli / mkEnv) and imports nothing from it, so the file loads and runs
// against the base code too. Titles are `i<item> <n>:` (fails before the fix) or `control <n>:` (passes before and after).
// memPressure and swapUsedPct appear only in TRUSS_SAMPLE fixtures. Every dir is a mkdtemp; the live truss dir is never touched.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, accessSync, constants, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as reg from '../hooks/register.ts'
import {
  addCrewWorktree, appendEvent, crew, factorySpawn, git, gitStatus, head, mkEnv, mkRepo, mkRun, mkTrussDir, planObj, putFile, qcReport, readPlan, runCli, tmp, writeGoal, writePlan,
} from './fixtures/workflow-run/harness.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const LONG_AGO = 1_700_000_000_000 // 2023-11
const HOUR = 3_600_000
const MIN = 60_000
const CFG = { merge: 'sequential', target: 'main' }
const iso = (ms: number): string => new Date(ms).toISOString()
const say = (r: any): string => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 700)}; stderr ${String(r.stderr).slice(0, 300)}`

/** Runs a command of env's CLI with extra child env (the harness env.run takes none). */
function runEnv(env: any, command: string, flags: Record<string, unknown> = {}, extraEnv: Record<string, string> = {}, factory: string = env.factory) {
  const all: Record<string, unknown> = { dir: env.dir, repo: env.repo, ...flags }
  const args: string[] = []
  for (const [k, v] of Object.entries(all)) {
    if (v === null || v === undefined || v === false) continue
    for (const x of Array.isArray(v) ? v : [v]) args.push(`--${k}`, ...(x === true ? [] : [String(x)]))
  }
  return runCli(factory, command, args, env.repo, extraEnv)
}
const sampleFile = (o: Record<string, unknown>): string => {
  const p = `${tmp('f6-sample-')}/s.json`
  writeFileSync(p, JSON.stringify(o))
  return p
}
const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v !== null && typeof v === 'object' ? Object.values(v).flatMap(strings) : [])

// ---------------------------------------------------------------------------------------------------------------
// item 46: start --slug S without --resume admits that one crew

const goalRow = (id: string, over: Record<string, unknown> = {}) => ({ id, goal: `goal ${id}`, addedAt: iso(Date.now() - 5 * HOUR), approval: 'auto', approvedAt: iso(Date.now() - 4 * HOUR), ...over })
const OK_GOAL = 'goal-approved'
const NO_GOAL = 'goal-unapproved'
function goalsWorld(crews: any[], goals: any[], over: Record<string, unknown> = {}) {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj(crews, { version: 3, goals, ...over }))
  for (const c of crews) writeGoal(env.dir, String(c.slug))
  return env
}
const slugsOf = (j: any): string[] => (j?.truss?.crews ?? []).map((c: any) => c.slug)
const statusOf = (env: any, slug: string): string => readPlan(env.dir).crews.find((c: any) => c.slug === slug).status
const noBranch = (env: any, slug: string): boolean => git(env.repo, ['branch', '--list', `truss-${slug}`]) === ''

test('i46 1: start --slug S without --resume starts crew S alone, not the other crews of the stage, and still holds it at the parallelism', () => {
  const env = goalsWorld([crew('apc1', { goal: OK_GOAL }), crew('apc2', { goal: OK_GOAL }), crew('runc')], [goalRow(OK_GOAL)])
  const r = env.run('start', { slug: 'apc2' })
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(slugsOf(r.json), ['apc2'], say(r))
  assert.equal(statusOf(env, 'apc2'), 'running')
  for (const s of ['apc1', 'runc']) {
    assert.equal(statusOf(env, s), 'planned', `${s} did not start`)
    assert.ok(noBranch(env, s), `no branch for ${s}`)
  }
  // still under parallelism: with the cap full, S is held, not started
  const busy = mkEnv({ config: CFG })
  writePlan(busy.dir, planObj([crew('busy', { status: 'running' }), crew('nxt')], { maxParallelCrews: 1 }))
  writeGoal(busy.dir, 'busy')
  writeGoal(busy.dir, 'nxt')
  addCrewWorktree(busy.repo, 'busy')
  appendEvent(busy.dir, factorySpawn('busy', iso(Date.now() - 3 * HOUR)))
  const h = busy.run('start', { slug: 'nxt' })
  assert.equal(h.status, 0, say(h))
  assert.deepEqual(slugsOf(h.json), [], say(h))
  assert.ok((h.json.held ?? []).some((x: any) => x.slug === 'nxt'), `nxt is held: ${say(h)}`)
  assert.equal(statusOf(busy, 'nxt'), 'planned')
  assert.ok(noBranch(busy, 'nxt'))
})

test('control 31: i46 start --slug alone is refused for a crew outside its goal\'s next stage, and for a planned crew of an unapproved goal', () => {
  const env = goalsWorld([crew('first', { goal: OK_GOAL }), crew('later', { goal: OK_GOAL, stage: 2 })], [goalRow(OK_GOAL)])
  const a = env.run('start', { slug: 'later' })
  assert.notEqual(a.status, 0, say(a))
  assert.deepEqual(slugsOf(a.json), [], say(a))
  assert.equal(statusOf(env, 'later'), 'planned')
  assert.ok(noBranch(env, 'later'))
  const un = goalsWorld([crew('apc', { goal: OK_GOAL }), crew('unc', { goal: NO_GOAL })], [goalRow(OK_GOAL), goalRow(NO_GOAL, { approval: 'client', approvedAt: null })])
  const b = un.run('start', { slug: 'unc' })
  assert.notEqual(b.status, 0, say(b))
  assert.deepEqual(slugsOf(b.json), [], say(b))
  assert.equal(statusOf(un, 'unc'), 'planned')
  assert.ok(noBranch(un, 'unc'))
})

// ---------------------------------------------------------------------------------------------------------------
// items 49 and 53 (reverted file): the newer-than-session agent warning

const WRITER_FILE = 'agents/writer.md'
const PLANNER_FILE = 'agents/planning-engineer.md'

/** A private git plugin copy, every agents/*.md back-dated to LONG_AGO, its first commit dated LONG_AGO. Returns the plugin dir. */
function gitPlugin(): string {
  const d = tmp('f6-plugin-')
  for (const sub of ['bin', 'hooks', 'docs', 'workflows', 'resources', 'retro', 'agents']) if (existsSync(`${ROOT}/${sub}`)) cpSync(`${ROOT}/${sub}`, `${d}/${sub}`, { recursive: true })
  for (const n of readdirSync(`${d}/agents`)) utimesSync(`${d}/agents/${n}`, LONG_AGO / 1000, LONG_AGO / 1000)
  git(d, ['init', '-q', '-b', 'main'])
  git(d, ['config', 'user.name', 'Test Writer'])
  git(d, ['config', 'user.email', 'tw@example.invalid'])
  git(d, ['add', '-A'])
  commitAt(d, 'plugin at the session start era', iso(LONG_AGO))
  return d
}
function commitAt(d: string, msg: string, when?: string): void {
  const env = { ...process.env, ...(when === undefined ? {} : { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }) }
  const r = spawnSync('git', ['commit', '-q', '-m', msg], { cwd: d, encoding: 'utf8', env })
  assert.equal(r.status, 0, `git commit failed: ${r.stderr}`)
}
function appendLines(d: string, file: string, add: string[]): void {
  const t = readFileSync(`${d}/${file}`, 'utf8')
  writeFileSync(`${d}/${file}`, t + (t.endsWith('\n') ? '' : '\n') + add.join('\n') + '\n')
}
function stressWorld() {
  const repo = mkRepo({ config: CFG })
  const dir = mkTrussDir()
  writePlan(dir, planObj([crew('s')]))
  writeGoal(dir, 's', { stressTest: 'yes' })
  return { repo, dir }
}
const startAs = (d: string, w: any, S: number) => runCli(`${d}/bin/factory.ts`, 'start', ['--stage', 'next', '--dir', w.dir, '--repo', w.repo], w.repo, { TRUSS_SESSION_START: String(S) })
const resumeAs = (d: string, w: any, S: number) => runCli(`${d}/bin/factory.ts`, 'start', ['--slug', 's', '--resume', 'merge-ready', '--dir', w.dir, '--repo', w.repo], w.repo, { TRUSS_SESSION_START: String(S) })
const warningsOf = (r: any): string[] => {
  assert.equal(r.status, 0, say(r))
  assert.ok(Array.isArray(r.json?.warnings), say(r))
  return r.json.warnings.map(String)
}
const about = (ws: string[], type: string): string[] => ws.filter((w) => w.includes(type))

test('i49 1: a file restored to its session-start content (an empty numstat) gives no newer-than-session warning, while a really changed file still warns', () => {
  const S = Date.now() - HOUR
  const d = gitPlugin()
  const orig = readFileSync(`${d}/${WRITER_FILE}`, 'utf8')
  appendLines(d, WRITER_FILE, ['temporary line'])
  writeFileSync(`${d}/${WRITER_FILE}`, orig) // same content again, mtime now
  assert.ok(statSync(`${d}/${WRITER_FILE}`).mtimeMs > S, 'precondition: the restored file is newer than the session')
  assert.equal(git(d, ['diff', '--numstat', 'HEAD', '--', WRITER_FILE]), '', 'precondition: an empty numstat')
  appendLines(d, PLANNER_FILE, ['planner note'])
  const ws = warningsOf(startAs(d, stressWorld(), S))
  assert.deepEqual(about(ws, 'truss:writer'), [], JSON.stringify(ws))
  assert.equal(about(ws, 'truss:planning-engineer').length, 1, `the changed planner file still warns: ${JSON.stringify(ws)}`)
  assert.match(about(ws, 'truss:planning-engineer')[0], /1 added, 0 removed/)
})

test('i49 2: start writes agent-warnings.json mapping each warned file to the sha256 of its content, and a second start with the same hash gives no warning', () => {
  const S = Date.now() - HOUR
  const d = gitPlugin()
  appendLines(d, WRITER_FILE, ['writer note'])
  const w = stressWorld()
  const first = warningsOf(startAs(d, w, S))
  assert.equal(about(first, 'truss:writer').length, 1, `the first start warns about the writer file: ${JSON.stringify(first)}`)
  const second = warningsOf(resumeAs(d, w, S))
  assert.deepEqual(about(second, 'truss:writer'), [], `the same hash warns no more: ${JSON.stringify(second)}`)
  const rec = JSON.parse(readFileSync(`${w.dir}/agent-warnings.json`, 'utf8'))
  const key = Object.keys(rec).find((k) => k.endsWith('writer.md'))
  assert.ok(key !== undefined, `a key for the writer file: ${JSON.stringify(rec)}`)
  assert.equal(rec[key as string], createHash('sha256').update(readFileSync(`${d}/${WRITER_FILE}`)).digest('hex'))
})

test('control 32: i49 after the agent file\'s content changes to a new hash, start warns again', () => {
  const S = Date.now() - HOUR
  const d = gitPlugin()
  appendLines(d, WRITER_FILE, ['writer note'])
  const w = stressWorld()
  assert.equal(about(warningsOf(startAs(d, w, S)), 'truss:writer').length, 1)
  appendLines(d, WRITER_FILE, ['a second, different note'])
  const again = warningsOf(resumeAs(d, w, S))
  assert.equal(about(again, 'truss:writer').length, 1, JSON.stringify(again))
})

test('i53 3: a file committed after the session start and then reverted to its session-start content gives no warning, while a changed file still warns', () => {
  const S = Date.now() - HOUR
  const d = gitPlugin()
  const orig = readFileSync(`${d}/${WRITER_FILE}`, 'utf8')
  appendLines(d, WRITER_FILE, ['to be reverted'])
  git(d, ['add', '--', WRITER_FILE])
  commitAt(d, 'change the writer')
  writeFileSync(`${d}/${WRITER_FILE}`, orig)
  git(d, ['add', '--', WRITER_FILE])
  commitAt(d, 'revert the writer')
  assert.equal(git(d, ['status', '--porcelain']), '', 'precondition: the revert is committed')
  appendLines(d, PLANNER_FILE, ['planner note'])
  const ws = warningsOf(startAs(d, stressWorld(), S))
  assert.deepEqual(about(ws, 'truss:writer'), [], JSON.stringify(ws))
  assert.equal(about(ws, 'truss:planning-engineer').length, 1, JSON.stringify(ws))
})

// ---------------------------------------------------------------------------------------------------------------
// item 50: start --model <role>=<model>

const MEMBERS = '1 tester on Sonnet at effort medium writes the tests. Then 1 builder on Opus at effort medium builds.'
function membersWorld(members: string = MEMBERS) {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew('m')]))
  writeGoal(env.dir, 'm', { members })
  return env
}

test('i50 1: start --model builder=sonnet --model tester=opus sets the roles row and the ## Members entry, both', () => {
  const env = membersWorld()
  const r = env.run('start', { stage: 'next', model: ['builder=sonnet', 'tester=opus'] })
  assert.equal(r.status, 0, say(r))
  const t = r.json.truss
  assert.equal(t.roles.builder.model, 'sonnet', say(r))
  assert.equal(t.crews[0].members.builder.model, 'sonnet', say(r))
  assert.equal(t.roles.tester.model, 'opus', say(r))
  assert.equal(t.crews[0].members.tester.model, 'opus', say(r))
  assert.equal(t.crews[0].members.builder.effort, 'medium')
})

test('i50 2: start without --model, where ## Members and the roles row differ, warns once for the crew, naming --model and never editing the args file', () => {
  const r = membersWorld().run('start', { stage: 'next' })
  assert.equal(r.status, 0, say(r))
  const mine = (r.json.warnings ?? []).map(String).filter((w: string) => w.includes('--model'))
  assert.equal(mine.length, 1, JSON.stringify(r.json.warnings))
  assert.ok(mine[0].includes('--model <role>=<model>'), mine[0])
  assert.match(mine[0], /never edit/i)
  assert.match(mine[0], /args file/i)
  assert.match(mine[0], /\bm\b/, 'names the crew')
  assert.match(mine[0], /builder/, 'names the role')
})

test('control 33: i50 with no --model the ## Members model stands, and roles that agree with ## Members give no --model warning', () => {
  const r = membersWorld().run('start', { stage: 'next' })
  assert.equal(r.status, 0, say(r))
  assert.equal(r.json.truss.crews[0].members.builder.model, 'opus', say(r))
  assert.equal(r.json.truss.roles.builder.model, 'sonnet', say(r))
  const same = membersWorld('1 tester on Sonnet at effort medium writes the tests. Then 1 builder on Sonnet at effort medium builds.').run('start', { stage: 'next' })
  assert.equal(same.status, 0, say(same))
  assert.equal((same.json.warnings ?? []).filter((w: string) => String(w).includes('--model')).length, 0, JSON.stringify(same.json.warnings))
})

// ---------------------------------------------------------------------------------------------------------------
// item 53: livePage, a read-only args file

const LIVE = 'Live page (how review takes its own screenshots): http://localhost:5173/board'
function liveWorld(ux: string) {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew('x', { status: 'running' }), crew('f')]))
  for (const s of ['x', 'f']) writeGoal(env.dir, s, { ux })
  addCrewWorktree(env.repo, 'x')
  appendEvent(env.dir, factorySpawn('x', iso(Date.now() - 3 * HOUR)))
  return env
}
function livePages(env: any): { fresh: any; resume: any } {
  const a = env.run('start', { stage: 'next' })
  assert.equal(a.status, 0, say(a))
  const f = a.json.truss.crews.find((c: any) => c.slug === 'f')
  const b = env.run('start', { slug: 'x', resume: 'merge-ready' })
  assert.equal(b.status, 0, say(b))
  return { fresh: f.livePage, resume: b.json.truss.crews[0].livePage }
}

test('i53 1: livePage is null for "Live pages are not built", and found behind a two-space bullet or a numbered marker', () => {
  assert.deepEqual(livePages(liveWorld('Direction: calm.\n\nLive pages are not built')), { fresh: null, resume: null })
  assert.deepEqual(livePages(liveWorld(`Direction: calm.\n\n-  ${LIVE}`)), { fresh: LIVE, resume: LIVE })
  assert.deepEqual(livePages(liveWorld(`Direction: calm.\n\n1. ${LIVE}`)), { fresh: LIVE, resume: LIVE })
  assert.deepEqual(livePages(liveWorld(`- Live pages are not built yet\n- ${LIVE}`)), { fresh: LIVE, resume: LIVE })
})

test('i53 2: a read-only existing --args-file P is refused with exit 2 before start changes any state', () => {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew('a')]))
  writeGoal(env.dir, 'a')
  const p = `${tmp('f6-args-')}/args.json`
  writeFileSync(p, 'old\n')
  chmodSync(p, 0o444)
  let writable = true
  try {
    accessSync(p, constants.W_OK)
  } catch {
    writable = false
  }
  assert.equal(writable, false, 'precondition: P is not writable for this user')
  const before = { plan: readFileSync(`${env.dir}/plan.json`, 'utf8'), decisions: readFileSync(`${env.dir}/decisions.md`, 'utf8'), events: readFileSync(`${env.dir}/events.jsonl`, 'utf8') }
  const r = env.run('start', { stage: 'next', 'args-file': p })
  assert.equal(r.status, 2, say(r))
  assert.match(String(r.json?.error ?? ''), /\S/, say(r))
  assert.equal(readFileSync(`${env.dir}/plan.json`, 'utf8'), before.plan, 'plan.json is byte-identical')
  assert.equal(readFileSync(`${env.dir}/decisions.md`, 'utf8'), before.decisions)
  assert.equal(readFileSync(`${env.dir}/events.jsonl`, 'utf8'), before.events)
  assert.ok(noBranch(env, 'a'), 'no branch was made')
  assert.ok(!existsSync(`${env.repo}/.claude/worktrees/truss-a`), 'no worktree was made')
  assert.equal(readFileSync(p, 'utf8'), 'old\n')
})

// ---------------------------------------------------------------------------------------------------------------
// item 56: finish warns for an agents/*.md the merge changed

/** A repo that holds the plugin at plugins/truss (the CLI runs from there), a crew s that changes the given agent files, and a finish-ready run. */
function mergeWorld(changed: string[]) {
  const repo = mkRepo({ config: CFG })
  for (const sub of ['bin', 'hooks', 'docs', 'workflows', 'resources', 'retro', 'agents']) if (existsSync(`${ROOT}/${sub}`)) cpSync(`${ROOT}/${sub}`, `${repo}/plugins/truss/${sub}`, { recursive: true })
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'plugin'])
  const dir = mkTrussDir()
  const transcripts = tmp('f6-tr-')
  writePlan(dir, planObj([crew('s', { owns: ['plugins/truss/agents/**'], status: 'running' })], { approvedAt: '2026-10-01T00:00:00.000Z' }))
  appendEvent(dir, factorySpawn('s', iso(Date.now() - 3 * HOUR)))
  const wt = addCrewWorktree(repo, 's')
  for (const n of changed) putFile(wt, `plugins/truss/agents/${n}.md`, `${readFileSync(`${wt}/plugins/truss/agents/${n}.md`, 'utf8')}\nA line the crew added to ${n}.\n`, `change ${n}`)
  const base = git(wt, ['merge-base', 'main', 'HEAD'])
  const hd = head(wt)
  const [diffCmd, idCmd] = reg.PATCH_COMMAND.split(' | ').map((s) => s.replace('<base>', base).replace('<head>', hd).split(' '))
  const dres = spawnSync(diffCmd[0], diffCmd.slice(1), { cwd: wt, encoding: 'utf8' })
  const patch = reg.patchIdOf(spawnSync(idCmd[0], idCmd.slice(1), { cwd: wt, input: dres.stdout, encoding: 'utf8' }).stdout)
  mkdirSync(`${dir}/checks`, { recursive: true })
  writeFileSync(`${dir}/checks/s-1.json`, JSON.stringify({ command: 'true', exit: 1, head: hd, tail: '' }))
  const run = mkRun(transcripts, 'wf_1', [
    { label: 's-builder', agentType: 'general-purpose', metaModel: 'sonnet', model: 'claude-sonnet-5-5', effort: 'medium', result: 'built it' },
    { label: 's-qc', agentType: 'truss:qc-engineer', metaModel: 'opus', model: 'claude-opus-5-5', effort: 'medium', result: qcReport({ head: hd, patch }) },
  ])
  const resFile = `${dir}/result.json`
  writeFileSync(resFile, JSON.stringify([{ slug: 's', state: 'passed', head: hd, base, qc: 's-qc' }]))
  return { repo, dir, run, resFile, factory: `${repo}/plugins/truss/bin/factory.ts` }
}

test('i56 1: finish warns once, naming the general-purpose fallback, for each agents/*.md the merge changed, and not for one it left unchanged', () => {
  const w = mergeWorld(['writer', 'qc-engineer'])
  const r = runCli(w.factory, 'finish', ['--dir', w.dir, '--repo', w.repo, '--transcript', w.run.dir, '--result', w.resFile], w.repo)
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(r.json.merged, ['s'], say(r))
  const all = strings(r.json)
  for (const file of ['agents/writer.md', 'agents/qc-engineer.md']) {
    const mine = all.filter((s) => s.includes(file))
    assert.equal(mine.length, 1, `exactly one warning names ${file}: ${JSON.stringify(all)}`)
    assert.ok(mine[0].includes('general-purpose'), mine[0])
  }
  assert.deepEqual(all.filter((s) => s.includes('agents/planning-engineer.md')), [], 'the unchanged agent file gets no warning')
})

// ---------------------------------------------------------------------------------------------------------------
// item 57: admit and start hold a new crew at memory pressure or swap use

const FREE = { freeMB: 64000, totalMB: 64000 }
function admitWorld() {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew('s')]))
  writeGoal(env.dir, 's')
  return env
}

test('i57 7: with plenty of free memory, admit refuses at memPressure 12 and, separately, at swapUsedPct 75, the why naming the reading and the limit; start holds the same crew', () => {
  const env = admitWorld()
  const press = sampleFile({ ...FREE, memPressure: 12 })
  const a = runEnv(env, 'admit', { slug: 's' }, { TRUSS_SAMPLE: press })
  assert.equal(a.status, 1, say(a))
  assert.equal(a.json.admitted, false, say(a))
  assert.match(String(a.json.why), /\b12\b/, say(a))
  assert.match(String(a.json.why), /\b10\b/, say(a))
  const swap = sampleFile({ ...FREE, swapUsedPct: 75 })
  const b = runEnv(env, 'admit', { slug: 's' }, { TRUSS_SAMPLE: swap })
  assert.equal(b.status, 1, say(b))
  assert.equal(b.json.admitted, false, say(b))
  assert.match(String(b.json.why), /\b75\b/, say(b))
  assert.match(String(b.json.why), /\b70\b/, say(b))
  for (const f of [press, swap]) {
    const s = runEnv(env, 'start', { stage: 'next' }, { TRUSS_SAMPLE: f })
    assert.equal(s.status, 0, say(s))
    assert.deepEqual(slugsOf(s.json), [], say(s))
    const held = (s.json.held ?? []).find((x: any) => x.slug === 's')
    assert.ok(held !== undefined && /\b(12|75)\b/.test(String(held.why)), `start holds s with the reading: ${say(s)}`)
    assert.equal(statusOf(env, 's'), 'planned')
    assert.ok(noBranch(env, 's'))
  }
})

test('control 34: i57 a fixture without the fields admits, and so does one at memPressure exactly 10 and swapUsedPct exactly 70', () => {
  for (const o of [FREE, { ...FREE, memPressure: 10, swapUsedPct: 70 }, { ...FREE, memPressure: 0, swapUsedPct: 0 }]) {
    const env = admitWorld()
    const a = runEnv(env, 'admit', { slug: 's' }, { TRUSS_SAMPLE: sampleFile(o) })
    assert.equal(a.status, 0, say(a))
    assert.equal(a.json.admitted, true, say(a))
  }
  const env = admitWorld()
  const s = runEnv(env, 'start', { stage: 'next' }, { TRUSS_SAMPLE: sampleFile({ ...FREE, memPressure: 10, swapUsedPct: 70 }) })
  assert.equal(s.status, 0, say(s))
  assert.deepEqual(slugsOf(s.json), ['s'], say(s))
})

// ---------------------------------------------------------------------------------------------------------------
// item 58 (a): a member that rebased its commit, then the crew branch fast-forwarded to it

function runningWorld(slug = 'x') {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew(slug, { status: 'running' })], { approvedAt: iso(Date.now() - 4 * HOUR) }))
  writeGoal(env.dir, slug, {})
  const wt = addCrewWorktree(env.repo, slug)
  appendEvent(env.dir, factorySpawn(slug, iso(Date.now() - 3 * HOUR)))
  return { env, wt }
}
const member = (task: string, branch: string, marker = 'BLOCKED') => ({ task, marker, branch, commit: 'c0ffee', proof: 'ran it', text: 'ok' })
const names = (done: any[]): string[] => done.map((d: any) => (typeof d === 'string' ? d : d.name))

test('i58 1: a member that rebased its own commit onto the moved crew head, which the crew branch then fast-forwarded to, counts done; a fresh branch on the old head does not', () => {
  const { env, wt } = runningWorld('x')
  putFile(wt, 'crew/a.txt', 'a\n', 'crew a')
  git(wt, ['branch', 'member-fresh', 'HEAD'])
  const mw = `${tmp('f6-member-')}/m`
  git(env.repo, ['worktree', 'add', '-q', '-b', 'member-reb', mw, 'truss-x'])
  git(mw, ['config', 'user.name', 'T'])
  git(mw, ['config', 'user.email', 't@example.invalid'])
  putFile(mw, 'members/hand.txt', 'hand\n', 'member hand work')
  putFile(wt, 'crew/b.txt', 'b\n', 'crew b')
  git(mw, ['rebase', 'truss-x'])
  git(wt, ['merge', '--ff-only', 'member-reb'])
  assert.equal(head(wt), head(mw), 'precondition: the crew branch fast-forwarded to the rebased member tip')
  assert.match(git(env.repo, ['reflog', 'show', 'member-reb']), /rebase \(finish\)/, 'precondition: the member branch reflog holds a rebase finish entry')
  const endMs = Date.now() - 2 * HOUR
  const agents = [
    { label: 'x-builder', result: member('t-reb', 'member-reb') },
    { label: 'x-builder-2', result: member('t-fresh', 'member-fresh') },
  ].map((a) => ({ startTs: iso(endMs - MIN), endTs: iso(endMs), ...a }))
  const run = mkRun(env.transcripts, 'wf_i58', agents, { journalMtimeMs: endMs })
  const answers = `${tmp('f6-ans-')}/answers.json`
  writeFileSync(answers, '[]')
  const r = env.run('start', { slug: 'x', resume: 'answers', transcript: run.dir, answers })
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(names(r.json.truss.crews[0].done), ['t-reb'], say(r))
})

// ---------------------------------------------------------------------------------------------------------------
// item 58 (b): a YAML block scalar holding `...` and `1..N` lines

const ENV_LINE = 'Error: browserType.launch: Host system is missing dependencies to run browsers.'
function checkOf(text: string, expect = 'red', exit = 1) {
  const env = mkEnv({ config: CFG })
  const f = `${tmp('f6-out-')}/out.txt`
  writeFileSync(f, text)
  writePlan(env.dir, planObj([crew('s', { acceptanceTest: `cat '${f}'; exit ${exit}`, status: 'running' })]))
  const res = env.run('check', { slug: 's', cwd: env.repo, expect })
  const rec = JSON.parse(readFileSync(`${env.dir}/checks/s-1.json`, 'utf8'))
  return { res, rec }
}

test('i58 2: an error block scalar holding `...` and `1..3` lines, with an env line after them, stays one block and is judged env', () => {
  const text = [
    'TAP version 13', 'not ok 1 - env case', '  ---', '  duration_ms: 1.5', '  error: |-', '    launching the browser failed', '    ...', '    1..3', `    ${ENV_LINE}`,
    '  code: ERR_X', '  ...', '1..1', '# tests 1', '# fail 1',
  ].join('\n') + '\n'
  const { res, rec } = checkOf(text)
  assert.equal(res.status, 1, say(res))
  assert.match(String(rec.env), /Host system is missing dependencies/, JSON.stringify(rec))
  assert.ok(!Object.hasOwn(rec, 'envSeen'), JSON.stringify(rec))
})

test('control 35: i58 text after the real closing `...` of the YAML diagnostic belongs to no block, so an env line there is only envSeen', () => {
  const text = ['TAP version 13', 'not ok 1 - code case', '  ---', '  duration_ms: 1.5', "  error: 'expected 1 to equal 2'", '  code: ERR_ASSERTION', '  ...', ENV_LINE, '1..1', '# tests 1', '# fail 1'].join('\n') + '\n'
  const { res, rec } = checkOf(text)
  assert.equal(res.status, 0, say(res))
  assert.ok(!Object.hasOwn(rec, 'env'), JSON.stringify(rec))
  assert.equal(rec.envSeen, ENV_LINE)
})

// ---------------------------------------------------------------------------------------------------------------
// item 58 (c), (d): integrate refuses up front while a merge, cherry-pick, revert or rebase is in progress

function crewEnv() {
  const env = mkEnv({ config: CFG, files: { 'a.txt': 'base\n' } })
  writePlan(env.dir, planObj([crew('s', { owns: ['src/s/**'], status: 'running' })]))
  const wt = addCrewWorktree(env.repo, 's')
  return { env, wt }
}
function memberBranch(env: any, name: string, file: string, text: string): string {
  const mw = `${tmp('f6-member-')}/m`
  git(env.repo, ['worktree', 'add', '-q', '-b', name, mw, 'truss-s'])
  git(mw, ['config', 'user.name', 'T'])
  git(mw, ['config', 'user.email', 't@example.invalid'])
  return putFile(mw, file, text, `${name} work\n\nTruss-Crew: s\nTruss-Role: builder`) as string
}
const count = (cwd: string): string => git(cwd, ['rev-list', '--count', '--all'])
const gitDir = (wt: string): string => git(wt, ['rev-parse', '--git-dir'])

/** Asserts integrate of `member-other` is refused up front: merged false, no conflicts, inProgress `kind`, the head and the commit count unchanged. */
function assertRefused(env: any, wt: string, kind: string, mark: () => string): void {
  const tip = head(wt)
  const total = count(wt)
  const m = mark()
  const res = env.run('integrate', { slug: 's', branch: 'member-other' })
  assert.equal(res.status, 1, say(res))
  assert.equal(res.json?.merged, false, say(res))
  assert.deepEqual(res.json?.conflicts, [], say(res))
  assert.equal(res.json?.inProgress, kind, say(res))
  assert.notEqual(res.json?.contained, true, say(res))
  assert.equal(head(wt), tip, 'the head is unchanged')
  assert.equal(count(wt), total, 'no commit was made')
  assert.equal(mark(), m, 'the operation in progress is untouched')
}

test('i58 3: with a conflicted merge in progress, integrate of another branch refuses with no conflicts and inProgress merge, and the head and MERGE_HEAD are unchanged', () => {
  const { env, wt } = crewEnv()
  memberBranch(env, 'member-other', 'src/s/other.ts', 'other\n')
  memberBranch(env, 'member-conf', 'a.txt', 'member side\n')
  putFile(wt, 'a.txt', 'crew side\n', 'crew edit')
  const first = env.run('integrate', { slug: 's', branch: 'member-conf' })
  assert.equal(first.status, 1, say(first))
  assert.equal(gitStatus(wt, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']), 0, 'precondition: the merge is in progress')
  assertRefused(env, wt, 'merge', () => git(wt, ['rev-parse', 'MERGE_HEAD']))
})

test('i58 4: with a conflicted cherry-pick, revert or rebase (rebase-merge and rebase-apply) in progress, integrate refuses with inProgress cherry-pick, revert or rebase and makes no commit', () => {
  // cherry-pick
  {
    const { env, wt } = crewEnv()
    memberBranch(env, 'member-other', 'src/s/other.ts', 'other\n')
    const theirs = memberBranch(env, 'member-conf', 'a.txt', 'member side\n')
    putFile(wt, 'a.txt', 'crew side\n', 'crew edit')
    git(wt, ['cherry-pick', theirs], true)
    assert.equal(gitStatus(wt, ['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD']), 0, 'precondition: a cherry-pick is in progress')
    assertRefused(env, wt, 'cherry-pick', () => git(wt, ['rev-parse', 'CHERRY_PICK_HEAD']))
  }
  // revert
  {
    const { env, wt } = crewEnv()
    memberBranch(env, 'member-other', 'src/s/other.ts', 'other\n')
    const c1 = putFile(wt, 'a.txt', 'v1\n', 'crew v1') as string
    putFile(wt, 'a.txt', 'v2\n', 'crew v2')
    git(wt, ['revert', '--no-edit', c1], true)
    assert.equal(gitStatus(wt, ['rev-parse', '-q', '--verify', 'REVERT_HEAD']), 0, 'precondition: a revert is in progress')
    assertRefused(env, wt, 'revert', () => git(wt, ['rev-parse', 'REVERT_HEAD']))
  }
  // rebase, both backends
  for (const [flag, dirName] of [[[], 'rebase-merge'], [['--apply'], 'rebase-apply']] as const) {
    const { env, wt } = crewEnv()
    memberBranch(env, 'member-other', 'src/s/other.ts', 'other\n')
    memberBranch(env, 'member-conf', 'a.txt', 'member side\n')
    putFile(wt, 'a.txt', 'crew side\n', 'crew edit')
    git(wt, ['rebase', ...flag, 'member-conf'], true)
    assert.ok(existsSync(`${gitDir(wt)}/${dirName}`), `precondition: ${dirName} exists in the git dir`)
    assertRefused(env, wt, 'rebase', () => String(existsSync(`${gitDir(wt)}/${dirName}`)))
  }
})

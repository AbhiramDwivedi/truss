// @ts-nocheck
// ADR-0025 (factory-fixes4), the start-fixes4 items: 36 `start` validates --args-file before it changes any state, 37 `start`
// skips crews of a goal whose approvedAt is null, 40 the crew entry carries livePage (the first `## UX` line starting with
// `Live page`), 41 the newer-than-session agent warnings carry a parenthesised detail.
//
// Written from ADR-0025 and the approved scope before the fix exists. Every case is titled `i<item> <n>:` (fails on the code
// before the fix) or `control <n>:` (passes before and after). The file only drives bin/factory.ts through the CLI `start`
// (harness runCli / mkEnv), in its own mktemp dirs and scratch git repos, so it loads and runs against the base code too.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { addCrewWorktree, appendEvent, crew, factorySpawn, git, mkEnv, mkRepo, mkTrussDir, planObj, readPlan, runCli, tmp, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const LONG_AGO = 1_700_000_000_000 // 2023-11
const HOUR = 3_600_000
const CFG = { merge: 'sequential', target: 'main' }
const iso = (ms: number): string => new Date(ms).toISOString()
const say = (r: any): string => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 700)}; stderr ${String(r.stderr).slice(0, 300)}`

// ---------------------------------------------------------------------------------------------------------------
// item 36: --args-file is validated before start changes any state

/** crew a planned (fresh start), crew b running with a factory spawn line but no worktree and no branch (resume). */
function argsWorld() {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew('a'), crew('b', { status: 'running' })]))
  writeGoal(env.dir, 'a')
  writeGoal(env.dir, 'b')
  appendEvent(env.dir, factorySpawn('b', iso(Date.now() - 3 * HOUR)))
  return env
}
const bytes = (env: any) => ({ plan: readFileSync(`${env.dir}/plan.json`, 'utf8'), decisions: readFileSync(`${env.dir}/decisions.md`, 'utf8'), events: readFileSync(`${env.dir}/events.jsonl`, 'utf8') })
const startFresh = (env: any, argsFile: string) => env.run('start', { stage: 'next', 'args-file': argsFile })
const startResume = (env: any, argsFile: string) => env.run('start', { slug: 'b', resume: 'merge-ready', 'args-file': argsFile })
/** No truss-<slug> branch, no registered worktree and no worktree directory in the repo. */
function assertNoCrewTrace(env: any, slug: string, r: any): void {
  assert.equal(git(env.repo, ['branch', '--list', `truss-${slug}`]), '', `branch truss-${slug} must not exist; ${say(r)}`)
  assert.ok(!git(env.repo, ['worktree', 'list', '--porcelain']).includes(`truss-${slug}`), `no worktree of truss-${slug} is registered; ${say(r)}`)
  assert.ok(!existsSync(`${env.repo}/.claude/worktrees/truss-${slug}`), `the worktree directory of truss-${slug} must not exist; ${say(r)}`)
}
function refusedUntouched(env: any, before: any, r: any, slug: string): void {
  assert.equal(r.status, 2, say(r))
  assert.match(String(r.json?.error ?? ''), /\S/, `a usage error line: ${say(r)}`)
  const after = bytes(env)
  assert.equal(after.plan, before.plan, 'plan.json is byte-identical')
  assert.equal(after.decisions, before.decisions, 'decisions.md is byte-identical')
  assert.equal(after.events, before.events, 'events.jsonl is byte-identical')
  assertNoCrewTrace(env, slug, r)
}
const underFile = (): string => {
  const blocker = `${tmp('f4-blk-')}/afile`
  writeFileSync(blocker, 'not a directory\n')
  return `${blocker}/sub/args.json`
}

test('i36 1: start --stage next with a relative --args-file exits 2 and changes no state, creates no branch or worktree', () => {
  const env = argsWorld()
  const before = bytes(env)
  const r = startFresh(env, 'out/args.json')
  refusedUntouched(env, before, r, 'a')
  assert.ok(!existsSync(`${env.repo}/out`), 'nothing was written to the relative path')
})

test('i36 2: start --slug s --resume with a relative --args-file exits 2 and changes no state, creates no branch or worktree', () => {
  const env = argsWorld()
  const before = bytes(env)
  const r = startResume(env, 'out/args.json')
  refusedUntouched(env, before, r, 'b')
  assert.ok(!existsSync(`${env.repo}/out`), 'nothing was written to the relative path')
})

test('i36 3: start --stage next with an --args-file under a regular file exits 2 and changes no state, creates no branch or worktree', () => {
  const env = argsWorld()
  const before = bytes(env)
  const r = startFresh(env, underFile())
  refusedUntouched(env, before, r, 'a')
})

test('i36 4: start --slug s --resume with an --args-file under a regular file exits 2 and changes no state, creates no branch or worktree', () => {
  const env = argsWorld()
  const before = bytes(env)
  const r = startResume(env, underFile())
  refusedUntouched(env, before, r, 'b')
})

test('control 1: a valid absolute --args-file keeps today\'s output, in both forms', () => {
  const env = argsWorld()
  const p = `${tmp('f4-args-')}/sub/args.json`
  const r = startFresh(env, p)
  assert.equal(r.status, 0, say(r))
  assert.equal(r.json.argsFile, p)
  assert.deepEqual(r.json.crews, ['a'])
  const written = JSON.parse(readFileSync(p, 'utf8'))
  assert.equal(written.truss.crews[0].slug, 'a')
  assert.equal(readPlan(env.dir).crews.find((c: any) => c.slug === 'a').status, 'running')
  const q = `${tmp('f4-args-')}/args.json`
  const s = startResume(env, q)
  assert.equal(s.status, 0, say(s))
  assert.deepEqual(s.json.crews, ['b'])
  assert.equal(JSON.parse(readFileSync(q, 'utf8')).truss.crews[0].resume, 'merge-ready')
})

// ---------------------------------------------------------------------------------------------------------------
// item 37: start skips crews of a goal whose approvedAt is null

const goalRow = (id: string, over: Record<string, unknown> = {}) => ({ id, goal: `goal ${id}`, addedAt: iso(Date.now() - 5 * HOUR), approval: 'auto', approvedAt: iso(Date.now() - 4 * HOUR), ...over })
const OK_GOAL = 'goal-approved'
const NO_GOAL = 'goal-unapproved'
const unapproved = () => goalRow(NO_GOAL, { approval: 'client', approvedAt: null })

function goalsWorld(crews: any[], goals: any[]) {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj(crews, { version: 3, goals }))
  for (const c of crews) writeGoal(env.dir, String(c.slug))
  return env
}
const slugsOf = (j: any): string[] => (j.truss?.crews ?? []).map((c: any) => c.slug)
const mentions = (j: any, slug: string): boolean => [...(j.refused ?? []), ...(j.held ?? []), ...(j.projectManagers ?? [])].some((x: any) => x.slug === slug)

test('i37 1: start --stage next never starts, refuses or holds the crews of an unapproved goal, next to an approved goal and the run goal', () => {
  const env = goalsWorld(
    [crew('runc'), crew('apc', { goal: OK_GOAL }), crew('unc', { goal: NO_GOAL }), crew('unc2', { goal: NO_GOAL })],
    [goalRow(OK_GOAL), unapproved()],
  )
  const r = env.run('start', { stage: 'next' })
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(slugsOf(r.json).sort(), ['apc', 'runc'])
  for (const s of ['unc', 'unc2']) {
    assert.ok(!mentions(r.json, s), `${s} is absent from refused, held and projectManagers: ${say(r)}`)
    assert.equal(readPlan(env.dir).crews.find((c: any) => c.slug === s).status, 'planned')
    assert.equal(git(env.repo, ['branch', '--list', `truss-${s}`]), '', `no branch for ${s}`)
  }
})

test('i37 2: an unapproved goal does not count in the per-goal next stage: --stage N that only it has is refused as not the next stage of any goal', () => {
  const env = goalsWorld([crew('apc', { goal: OK_GOAL }), crew('unc', { goal: NO_GOAL, stage: 2 })], [goalRow(OK_GOAL), unapproved()])
  const r = env.run('start', { stage: '2' })
  assert.notEqual(r.status, 0, say(r))
  assert.match(String(r.json?.error ?? ''), /not the next stage of any goal/, say(r))
  assert.ok(!String(r.json?.error ?? '').includes(NO_GOAL), `the unapproved goal is not listed as a next stage: ${say(r)}`)
  assert.equal(readPlan(env.dir).crews.find((c: any) => c.slug === 'unc').status, 'planned')
  assert.equal(git(env.repo, ['branch', '--list', 'truss-unc']), '')
})

function resumeWorld(slug: string, over: Record<string, unknown>, goals: any[]) {
  const env = goalsWorld([crew(slug, { status: 'running', ...over })], goals)
  addCrewWorktree(env.repo, slug)
  appendEvent(env.dir, factorySpawn(slug, iso(Date.now() - 3 * HOUR)))
  return env
}

test('i37 3: start --slug x --resume of a crew in an unapproved goal is refused with a reason that names the goal', () => {
  const env = resumeWorld('unc', { goal: NO_GOAL }, [goalRow(OK_GOAL), unapproved()])
  const r = env.run('start', { slug: 'unc', resume: 'merge-ready' })
  assert.notEqual(r.status, 0, say(r))
  assert.ok(r.json?.truss === undefined, `no entry is returned: ${say(r)}`)
  assert.ok(r.stdout.includes(NO_GOAL), `the reason names the goal ${NO_GOAL}: ${say(r)}`)
})

test('control 2: crews of the top-level run goal start and resume as today while another goal is unapproved', () => {
  const env = goalsWorld([crew('runc'), crew('apc', { goal: OK_GOAL })], [goalRow(OK_GOAL), unapproved()])
  const r = env.run('start', { stage: 'next' })
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(slugsOf(r.json).sort(), ['apc', 'runc'])
  assert.equal(readPlan(env.dir).crews.find((c: any) => c.slug === 'runc').status, 'running')
  const res = resumeWorld('runr', {}, [goalRow(OK_GOAL), unapproved()])
  const q = res.run('start', { slug: 'runr', resume: 'merge-ready' })
  assert.equal(q.status, 0, say(q))
  assert.deepEqual(slugsOf(q.json), ['runr'])
})

// ---------------------------------------------------------------------------------------------------------------
// item 40: entry.livePage

const LIVE = 'Live page (how review takes its own screenshots): http://localhost:5173/board'
function liveWorld(ux: string | undefined, o: { scope?: string } = {}) {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew('x', { status: 'running' })]))
  writeGoal(env.dir, 'x', { ...(ux === undefined ? {} : { ux }), ...(o.scope === undefined ? {} : { scope: o.scope }) })
  addCrewWorktree(env.repo, 'x')
  appendEvent(env.dir, factorySpawn('x', iso(Date.now() - 3 * HOUR)))
  // a second crew, planned, for the fresh form
  const plan = readPlan(env.dir)
  plan.crews.push(crew('f'))
  writePlan(env.dir, plan)
  writeGoal(env.dir, 'f', { ...(ux === undefined ? {} : { ux }), ...(o.scope === undefined ? {} : { scope: o.scope }) })
  return env
}
/** livePage of the fresh entry (crew f) and of the resume entry (crew x). */
function livePages(env: any): { fresh: any; resume: any } {
  const a = env.run('start', { stage: 'next' })
  assert.equal(a.status, 0, say(a))
  const f = a.json.truss.crews.find((c: any) => c.slug === 'f')
  assert.ok(f, say(a))
  const b = env.run('start', { slug: 'x', resume: 'merge-ready' })
  assert.equal(b.status, 0, say(b))
  assert.ok(Object.hasOwn(f, 'livePage') && Object.hasOwn(b.json.truss.crews[0], 'livePage'), 'every entry carries a livePage key')
  return { fresh: f.livePage, resume: b.json.truss.crews[0].livePage }
}

test('i40 1: a bulleted "- Live page ..." line in ## UX is given whole, without the marker, in a fresh start and in --resume', () => {
  const r = livePages(liveWorld(`Direction: calm, dense.\n\n- ${LIVE}\n- Other: x`))
  assert.deepEqual(r, { fresh: LIVE, resume: LIVE })
})

test('i40 2: a "* Live page ..." marker is dropped too; a bare "Live page ..." line is given whole and trimmed', () => {
  assert.deepEqual(livePages(liveWorld(`Direction: x.\n* ${LIVE}   \n`)), { fresh: LIVE, resume: LIVE })
  assert.deepEqual(livePages(liveWorld(`Direction: x.\n${LIVE}  \n- Other: y`)), { fresh: LIVE, resume: LIVE })
})

test('i40 3: with two Live page lines the first wins', () => {
  const r = livePages(liveWorld(`- ${LIVE}\n- Live page: http://localhost:9999/second`))
  assert.deepEqual(r, { fresh: LIVE, resume: LIVE })
})

test('i40 4: livePage is null with no Live page line in ## UX, with no ## UX section, and when the line is outside ## UX', () => {
  assert.deepEqual(livePages(liveWorld('Direction: calm. See the Live page later.\n- Not a Live page line')), { fresh: null, resume: null })
  assert.deepEqual(livePages(liveWorld(undefined)), { fresh: null, resume: null })
  assert.deepEqual(livePages(liveWorld('none', { scope: `${LIVE}\nBuild x only.` })), { fresh: null, resume: null })
})

test('control 3: a ## UX section with a Live page line still makes the entry ux, and none does not', () => {
  const env = liveWorld(`- ${LIVE}`)
  const a = env.run('start', { stage: 'next' })
  assert.equal(a.json.truss.crews.find((c: any) => c.slug === 'f').ux, true)
  const b = liveWorld('none').run('start', { stage: 'next' })
  assert.equal(b.json.truss.crews.find((c: any) => c.slug === 'f').ux, false)
})

// ---------------------------------------------------------------------------------------------------------------
// item 41: the newer-than-session warnings carry a detail

const STRESS_FILE = 'agents/stress-engineer.md'
const WRITER_FILE = 'agents/writer.md'
const PLANNER_FILE = 'agents/planning-engineer.md'
const stressText = (detail: string): string => `crew s runs truss:stress-engineer, but the role's agent file changed after this session loaded its agents (${detail}); restart the session to load it`
const roleText = (role: string, type: string, file: string, detail: string): string => `crew s runs truss:${type} as its ${role}, but ${file} changed after this session loaded its agents (${detail}); restart the session to load it, or resume with roles.${role}.agentType set to general-purpose and an answer telling the agent to read ${file} and follow it`

/** A private plugin copy, every agents/*.md back-dated to LONG_AGO. With `inGit`, a git repo whose first commit holds the copy, dated `firstAt` (a Date string, default now). Returns the plugin dir. */
function pluginCopyDir(inGit: boolean, firstAt?: string): string {
  const d = tmp('f4-plugin-')
  for (const sub of ['bin', 'hooks', 'docs', 'workflows', 'resources', 'retro', 'agents']) if (existsSync(`${ROOT}/${sub}`)) cpSync(`${ROOT}/${sub}`, `${d}/${sub}`, { recursive: true })
  for (const n of readdirSync(`${d}/agents`)) utimesSync(`${d}/agents/${n}`, LONG_AGO / 1000, LONG_AGO / 1000)
  if (inGit) {
    git(d, ['init', '-q', '-b', 'main'])
    git(d, ['config', 'user.name', 'Test Writer'])
    git(d, ['config', 'user.email', 'tw@example.invalid'])
    git(d, ['add', '-A'])
    commitAt(d, 'plugin at the session start era', firstAt)
  }
  return d
}
function commitAt(d: string, msg: string, when?: string): void {
  const env = { ...process.env, ...(when === undefined ? {} : { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }) }
  const r = spawnSync('git', ['commit', '-q', '-m', msg], { cwd: d, encoding: 'utf8', env })
  assert.equal(r.status, 0, `git commit failed: ${r.stderr}`)
}
/** Replaces the first line of an agent file and appends `add` lines; returns nothing. The file's mtime becomes now. */
function rewrite(d: string, file: string, first: string, add: string[]): void {
  const lines = readFileSync(`${d}/${file}`, 'utf8').split('\n')
  lines[0] = first
  const trailing = lines[lines.length - 1] === '' ? lines.pop() : undefined
  writeFileSync(`${d}/${file}`, [...lines, ...add, ...(trailing === undefined ? [] : [''])].join('\n'))
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
/** start with the plugin copy at `d` and the session start `S`; returns the warnings. */
function warnings(d: string, S: number | undefined): string[] {
  const w = stressWorld()
  const r = runCli(`${d}/bin/factory.ts`, 'start', ['--stage', 'next', '--dir', w.dir, '--repo', w.repo], w.repo, S === undefined ? {} : { TRUSS_SESSION_START: String(S) })
  assert.equal(r.status, 0, say(r))
  assert.ok(Array.isArray(r.json?.warnings), say(r))
  return r.json.warnings.map(String)
}
const about = (ws: string[], type: string): string[] => ws.filter((w) => w.includes(type))
const numstat = (d: string, c: string, file: string): [string, string] => {
  const [a, r] = git(d, ['diff', '--numstat', c, '--', file]).split('\t')
  return [a, r]
}

test('i41 1: in a git work tree, the detail gives the numstat since the session start and the newest commit after it, in the stress and the role warning', () => {
  const S = Date.now() - HOUR
  const d = pluginCopyDir(true, iso(LONG_AGO))
  const base = git(d, ['rev-parse', 'HEAD'])
  // stress-engineer.md: first line replaced + 2 lines added, committed; then 1 more line added, committed again
  rewrite(d, STRESS_FILE, 'A changed first line.', ['added one', 'added two'])
  git(d, ['add', '--', STRESS_FILE])
  commitAt(d, 'rewrite the stress opening')
  appendLines(d, STRESS_FILE, ['added three'])
  git(d, ['add', '--', STRESS_FILE])
  commitAt(d, 'one more stress line')
  // planning-engineer.md: 1 line added, committed
  appendLines(d, PLANNER_FILE, ['planner note'])
  git(d, ['add', '--', PLANNER_FILE])
  commitAt(d, 'planner note')
  const [sa, sr] = numstat(d, base, STRESS_FILE)
  assert.deepEqual([sa, sr], ['4', '1'], 'the test world: 4 lines added and 1 removed in the stress file since the base commit')
  assert.deepEqual(numstat(d, base, PLANNER_FILE), ['1', '0'])
  const sha = git(d, ['log', '-1', '--format=%h', '--', STRESS_FILE])
  const psha = git(d, ['log', '-1', '--format=%h', '--', PLANNER_FILE])
  assert.equal(git(d, ['log', '-1', '--format=%s', '--', STRESS_FILE]), 'one more stress line')
  assert.notEqual(sha, psha)
  const ws = warnings(d, S)
  assert.deepEqual(about(ws, 'truss:stress-engineer'), [stressText(`4 added, 1 removed since the session start, last commit ${sha} one more stress line`)])
  assert.deepEqual(about(ws, 'truss:planning-engineer'), [roleText('planner', 'planning-engineer', PLANNER_FILE, `1 added, 0 removed since the session start, last commit ${psha} planner note`)])
  assert.deepEqual(about(ws, 'truss:writer'), [], 'the unchanged writer file does not warn')
})

test('i41 2: in a git work tree, a file changed but not committed after the session start says uncommitted, with the working-tree numstat', () => {
  const S = Date.now() - HOUR
  const d = pluginCopyDir(true, iso(LONG_AGO))
  appendLines(d, WRITER_FILE, ['writer one', 'writer two'])
  rewrite(d, STRESS_FILE, 'Uncommitted first line.', [])
  const base = git(d, ['rev-parse', 'HEAD'])
  assert.deepEqual(numstat(d, base, WRITER_FILE), ['2', '0'])
  assert.deepEqual(numstat(d, base, STRESS_FILE), ['1', '1'])
  const ws = warnings(d, S)
  assert.deepEqual(about(ws, 'truss:writer'), [roleText('writer', 'writer', WRITER_FILE, '2 added, 0 removed since the session start, uncommitted')])
  assert.deepEqual(about(ws, 'truss:stress-engineer'), [stressText('1 added, 1 removed since the session start, uncommitted')])
})

test('i41 3: a plugin dir outside git gives the file mtime and the session start as ISO times', () => {
  const S = Date.now() - HOUR
  const d = pluginCopyDir(false)
  for (const f of [STRESS_FILE, WRITER_FILE]) utimesSync(`${d}/${f}`, (S + 30 * 60_000) / 1000, (S + 30 * 60_000) / 1000)
  const detail = (f: string) => `mtime ${iso(statSync(`${d}/${f}`).mtimeMs)}, session start ${iso(S)}`
  const ws = warnings(d, S)
  assert.deepEqual(about(ws, 'truss:stress-engineer'), [stressText(detail(STRESS_FILE))])
  assert.deepEqual(about(ws, 'truss:writer'), [roleText('writer', 'writer', WRITER_FILE, detail(WRITER_FILE))])
})

test('i41 4: a git plugin dir with no commit before the session start gives the mtime form', () => {
  const S = Date.now() - HOUR
  const d = pluginCopyDir(true) // the only commit is dated now, after S
  appendLines(d, STRESS_FILE, ['late line'])
  git(d, ['add', '--', STRESS_FILE])
  commitAt(d, 'late stress line')
  const mtime = statSync(`${d}/${STRESS_FILE}`).mtimeMs
  const ws = warnings(d, S)
  assert.deepEqual(about(ws, 'truss:stress-engineer'), [stressText(`mtime ${iso(mtime)}, session start ${iso(S)}`)])
})

test('control 4: the can\'t-tell and missing-file texts are word for word as before', () => {
  const d = pluginCopyDir(false)
  const ws = warnings(d, undefined)
  assert.deepEqual(about(ws, 'truss:stress-engineer'), ["crew s runs truss:stress-engineer, but I can't tell whether its agent file changed after this session loaded its agents; restart the session if it did"])
  assert.deepEqual(about(ws, 'truss:writer'), [`crew s runs truss:writer as its writer, but I can't tell whether ${WRITER_FILE} changed after this session loaded its agents; restart the session if it did, or resume with roles.writer.agentType set to general-purpose and an answer telling the agent to read ${WRITER_FILE} and follow it`])
  const e = pluginCopyDir(false)
  // the writer file is gone: its warning says missing, whatever the session start
  unlinkSync(`${e}/${WRITER_FILE}`)
  const ms = warnings(e, Date.now() - HOUR)
  assert.deepEqual(about(ms, 'truss:writer'), [`crew s runs truss:writer as its writer, but its agent file ${WRITER_FILE} is missing; restart the session once it is back, or resume with roles.writer.agentType set to general-purpose and an answer telling the agent to read ${WRITER_FILE} and follow it`])
})

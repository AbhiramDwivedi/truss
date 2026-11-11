// @ts-nocheck
// ADR-0024 (factory-fixes3), the factory-resume items: 24 a warning for every truss:* agent type a starting crew runs,
// 26 a resume lists and prunes vanished member worktrees, 27 doneTasks counts a hand-merged BLOCKED task, 29 (factory half)
// start prints workflowArgs for an --args-file inside the truss dir, 31 (factory half) the entry carries head, 32 integrate
// skips a branch whose merge leaves the tree unchanged, 34 (factory half) the check env rule works on failure blocks and
// records envSeen, 35 a resume before `finish` recovers the UX direction from the agent results.
//
// Written from ADR-0024 and the approved scope before the fix exists. Every case is titled `i<item> <n>:` (fails on the code
// before the fix) or `control <n>:` (passes before and after). The file only drives bin/factory.ts through the CLI
// (harness runCli / mkEnv), so it loads and runs against the base code too.

import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  addCrewWorktree, appendEvent, crew, factorySpawn, flat, git, gitStatus, head, mkEnv, mkRepo, mkRun, mkTrussDir, planObj, putFile,
  readEvents, readPlan, runCli, tmp, writeGoal, writePlan, writeReport,
} from './fixtures/workflow-run/harness.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const LONG_AGO = 1_700_000_000_000 // 2023-11: before this host's boot and before the test process
const HOUR = 3_600_000
const MIN = 60_000
const CFG = { merge: 'sequential', target: 'main' }
const iso = (ms: number): string => new Date(ms).toISOString()
const say = (r: any): string => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 700)}; stderr ${String(r.stderr).slice(0, 300)}`

// ---------------------------------------------------------------------------------------------------------------
// shared worlds

/** A world with crew `slug` running (worktree, factory spawn line, approved plan) and a goal file. */
function runningWorld(slug = 'x', o: { ux?: string } = {}) {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew(slug, { status: 'running' })], { approvedAt: iso(Date.now() - 4 * HOUR) }))
  writeGoal(env.dir, slug, o.ux === undefined ? {} : { ux: o.ux })
  const wt = addCrewWorktree(env.repo, slug)
  appendEvent(env.dir, factorySpawn(slug, iso(Date.now() - 3 * HOUR)))
  return { env, wt }
}

/** A Workflow run dir whose last write was `agoMs` ago. */
function deadRun(env: any, runId: string, agents: any[], agoMs = 2 * HOUR) {
  const endMs = Date.now() - agoMs
  return mkRun(env.transcripts, runId, agents.map((a) => ({ startTs: iso(endMs - MIN), endTs: iso(endMs), ...a })), { journalMtimeMs: endMs })
}

/** The state `finish` leaves: a `by: "workflow:<runId>"` spawn line per label, plus an `incomplete` line. */
function record(env: any, runId: string, run: any, slug: string): void {
  const ts = iso(Date.now() - 90 * MIN)
  for (const [label, id] of Object.entries(run.ids)) appendEvent(env.dir, { v: 1, ts, event: 'spawn', crew: slug, agent: label, agentId: id, type: 'general-purpose', model: 'opus', effort: 'medium', by: `workflow:${runId}` })
  appendEvent(env.dir, { v: 1, ts, event: 'incomplete', crew: slug, agent: slug, run: runId })
}

/** In the crew worktree: a member branch `name` with one commit from the crew branch head, merged (--no-ff) into the crew branch when `merge`. */
function memberBranch(wt: string, crewBranch: string, name: string, merge: boolean): void {
  git(wt, ['checkout', '-q', '-b', name])
  putFile(wt, `members/${name}.txt`, `${name}\n`, `member ${name}`)
  git(wt, ['checkout', '-q', crewBranch])
  if (merge) git(wt, ['merge', '-q', '--no-ff', '-m', `merge ${name}`, name])
}

const member = (task: string, branch: string | undefined, marker = 'DONE') => ({ task, marker, ...(branch === undefined ? {} : { branch }), commit: 'c0ffee', proof: 'ran it', text: 'ok' })
const names = (done: any[]): string[] => done.map((d: any) => (typeof d === 'string' ? d : d.name))
const answersFile = (answers: unknown): string => {
  const p = `${tmp('f3-ans-')}/answers.json`
  writeFileSync(p, JSON.stringify(answers))
  return p
}
const resumeAnswers = (env: any, run: any, slug = 'x') => env.run('start', { slug, resume: 'answers', transcript: run.dir, answers: answersFile([]) })
const entryOf = (r: any): any => r.json.truss.crews[0]

// ---------------------------------------------------------------------------------------------------------------
// item 24: a warning for every truss:* agent type a starting crew will run

/** A private plugin copy; every agents/*.md is back-dated to LONG_AGO, then `ages` sets a file's mtime (ms) or removes it (null). Keys are file names without .md. */
function pluginAges(ages: Record<string, number | null> = {}): string {
  const d = tmp('f3-plugin-')
  for (const sub of ['bin', 'hooks', 'docs', 'workflows', 'resources', 'retro', 'agents']) if (existsSync(`${ROOT}/${sub}`)) cpSync(`${ROOT}/${sub}`, `${d}/${sub}`, { recursive: true })
  for (const n of readdirSync(`${d}/agents`)) {
    const key = n.replace(/\.md$/, '')
    const v = Object.hasOwn(ages, key) ? ages[key] : LONG_AGO
    if (v === null) rmSync(`${d}/agents/${n}`, { force: true })
    else utimesSync(`${d}/agents/${n}`, v / 1000, v / 1000)
  }
  return `${d}/bin/factory.ts`
}

function startWorld(crews: any[], goals: Record<string, any> = {}) {
  const repo = mkRepo({ config: CFG })
  const dir = mkTrussDir()
  writePlan(dir, planObj(crews))
  for (const c of crews) writeGoal(dir, String(c.slug), goals[String(c.slug)] ?? {})
  return { repo, dir }
}
const startAt = (w: any, factory: string, env: Record<string, string> = {}, extra: string[] = []) => runCli(factory, 'start', ['--stage', 'next', '--dir', w.dir, '--repo', w.repo, ...extra], w.repo, env)
const warningsOf = (r: any): string[] => {
  assert.equal(r.status, 0, say(r))
  assert.ok(Array.isArray(r.json?.warnings), `start prints a warnings array; ${say(r)}`)
  return r.json.warnings.map(String)
}
const about = (ws: string[], type: string): string[] => ws.filter((w) => w.includes(type))

test('i24 1: a ux crew whose planner, qc, writer and ux agent files are newer than the session gets a warning per type, each naming the fallback', () => {
  const now = Date.now()
  const fresh = { 'ux-engineer': now, 'planning-engineer': now, 'qc-engineer': now, writer: now, 'design-engineer': now, 'checking-engineer': now }
  const w = startWorld([crew('u')], { u: { ux: 'Direction: calm, dense, no chrome.' } })
  const r = startAt(w, pluginAges(fresh), { TRUSS_SESSION_START: String(now - HOUR) })
  const ws = warningsOf(r)
  for (const [type, role, file] of [['truss:ux-engineer', 'ux', 'ux-engineer'], ['truss:planning-engineer', 'planner', 'planning-engineer'], ['truss:qc-engineer', 'qc', 'qc-engineer'], ['truss:writer', 'writer', 'writer']]) {
    const mine = about(ws, type)
    assert.ok(mine.some((x) => /\bu\b/.test(x)), `a warning names crew u and ${type}: ${JSON.stringify(ws)}`)
    const text = mine.join(' | ')
    assert.match(text, /restart the session/, `${type} names the restart fallback: ${text}`)
    assert.ok(text.includes('general-purpose'), `${type} names general-purpose: ${text}`)
    assert.ok(text.includes(`roles.${role}.agentType`), `${type} names roles.${role}.agentType: ${text}`)
    assert.ok(text.includes(`agents/${file}.md`), `${type} names agents/${file}.md: ${text}`)
  }
  assert.equal(r.json.truss.crews.length, 1, 'a warning never holds the crew')
})

test('i24 2: never a warning for the designer or checker types, nor for stress when the goal says Stress test no, though their agent files are newer than the session', () => {
  const now = Date.now()
  const fresh = { 'ux-engineer': now, 'planning-engineer': now, 'qc-engineer': now, writer: now, 'design-engineer': now, 'checking-engineer': now, 'stress-engineer': now }
  const w = startWorld([crew('p')])
  const ws = warningsOf(startAt(w, pluginAges(fresh), { TRUSS_SESSION_START: String(now - HOUR) }))
  assert.ok(about(ws, 'truss:planning-engineer').length > 0, `the planner type warns, so the case is not vacuous: ${JSON.stringify(ws)}`)
  for (const type of ['truss:design-engineer', 'truss:checking-engineer', 'truss:stress-engineer', 'truss:ux-engineer']) assert.deepEqual(about(ws, type), [], `${type} is not warned about for this crew`)
})

test('i24 3: a missing agent file and an unreadable session start both warn, for the planner, qc and writer types a crew runs', () => {
  const w = startWorld([crew('p')])
  // the writer's agent file is gone; the session start cannot be read
  const ws = warningsOf(startAt(w, pluginAges({ writer: null }), {}))
  for (const [type, role] of [['truss:planning-engineer', 'planner'], ['truss:qc-engineer', 'qc'], ['truss:writer', 'writer']]) {
    const mine = about(ws, type)
    assert.ok(mine.length > 0 && mine.some((x) => /\bp\b/.test(x)), `${type} warns naming crew p: ${JSON.stringify(ws)}`)
    assert.ok(mine.join(' ').includes(`roles.${role}.agentType`), `${type} names the fallback: ${mine.join(' | ')}`)
  }
  // a missing file warns even when the session start is known and late
  const late = warningsOf(startAt(startWorld([crew('q')]), pluginAges({ writer: null }), { TRUSS_SESSION_START: String(Date.now() + HOUR) }))
  assert.ok(about(late, 'truss:writer').length > 0, `a missing writer.md warns with a late session start: ${JSON.stringify(late)}`)
  assert.deepEqual(about(late, 'truss:planning-engineer'), [], 'a present, older planner file does not')
})

test('i24 4: tester and builder warn only when their agentType is truss:*', () => {
  const now = Date.now()
  const w = startWorld([crew('p')])
  const ws = warningsOf(startAt(w, pluginAges({ foreman: now }), { TRUSS_SESSION_START: String(now - HOUR) }, ['--type', 'builder=truss:foreman']))
  const mine = about(ws, 'truss:foreman')
  assert.ok(mine.length > 0, `a truss:* builder type warns: ${JSON.stringify(ws)}`)
  assert.ok(mine.join(' ').includes('roles.builder.agentType'), mine.join(' | '))
  assert.ok(!ws.some((x) => x.includes('roles.tester.agentType')), `the general-purpose tester does not warn: ${JSON.stringify(ws)}`)
  assert.ok(!ws.some((x) => x.includes('general-purpose, but')), 'no warning about a general-purpose type')
})

test('i24 5: a stress-yes crew still gets the stress warning word for word, next to the new ones', () => {
  const now = Date.now()
  const w = startWorld([crew('s')], { s: { stressTest: 'yes' } })
  const factory = pluginAges({ 'stress-engineer': now, writer: now })
  const ws = warningsOf(startAt(w, factory, { TRUSS_SESSION_START: String(now - HOUR) }))
  // ADR-0025 item 41: the copy sits in a tmp dir outside git, so the detail is the file's mtime and the session start
  const mtime = iso(statSync(factory.replace(/\/bin\/factory\.ts$/, '/agents/stress-engineer.md')).mtimeMs)
  assert.ok(ws.includes(`crew s runs truss:stress-engineer, but the role's agent file changed after this session loaded its agents (mtime ${mtime}, session start ${iso(now - HOUR)}); restart the session to load it`), JSON.stringify(ws))
  assert.ok(about(ws, 'truss:writer').length > 0, `and the writer type warns too: ${JSON.stringify(ws)}`)
})

test('control 1: the stress warning texts are unchanged, newer-than-session and can\'t-tell', () => {
  const now = Date.now()
  const w = startWorld([crew('s')], { s: { stressTest: 'yes' } })
  const factory = pluginAges({ 'stress-engineer': now })
  const newer = warningsOf(startAt(w, factory, { TRUSS_SESSION_START: String(now - HOUR) }))
  const mtime = iso(statSync(factory.replace(/\/bin\/factory\.ts$/, '/agents/stress-engineer.md')).mtimeMs)
  assert.deepEqual(about(newer, 'truss:stress-engineer'), [`crew s runs truss:stress-engineer, but the role's agent file changed after this session loaded its agents (mtime ${mtime}, session start ${iso(now - HOUR)}); restart the session to load it`])
  const unknown = warningsOf(startAt(startWorld([crew('s')], { s: { stressTest: 'yes' } }), pluginAges(), {}))
  assert.deepEqual(about(unknown, 'truss:stress-engineer'), ["crew s runs truss:stress-engineer, but I can't tell whether its agent file changed after this session loaded its agents; restart the session if it did"])
})

test('control 2: agent files older than the session give warnings: []', () => {
  const w = startWorld([crew('u'), crew('s')], { u: { ux: 'Direction: calm.' }, s: { stressTest: 'yes' } })
  const ws = warningsOf(startAt(w, pluginAges(), { TRUSS_SESSION_START: String(LONG_AGO + 100_000) }))
  assert.deepEqual(ws, [])
})

// ---------------------------------------------------------------------------------------------------------------
// item 26: a resume lists and prunes vanished member worktrees

/** A member worktree for run `runId` on branch worktree-<runId>-<n> in the repo; its directory is removed when `gone`. Returns the branch. */
function memberWorktree(env: any, runId: string, n: number, gone: boolean): string {
  const branch = `worktree-${runId}-${n}`
  const p = `${tmp('f3-mw-')}/wt`
  git(env.repo, ['worktree', 'add', '-q', '-b', branch, p, 'main'])
  if (gone) rmSync(p, { recursive: true, force: true })
  return branch
}
const registered = (env: any, branch: string): boolean => git(env.repo, ['worktree', 'list', '--porcelain']).includes(`refs/heads/${branch}`)
const missingOf = (j: any): unknown[] => j.missingWorktrees ?? j.truss?.crews?.[0]?.missingWorktrees ?? []
const listed = (j: any, branch: string): boolean => JSON.stringify(missingOf(j)).includes(branch)
const decisionsOf = (env: any): string => readFileSync(`${env.dir}/decisions.md`, 'utf8')

/** The crew-x resume world: a dead run `wf_i26` holding one builder, member worktrees -1 (alive), -2 (gone), and -7 of another run (gone). */
function vanishedWorld() {
  const { env, wt } = runningWorld('x')
  const run = deadRun(env, 'wf_i26', [{ label: 'x-builder', result: member('t1', 'worktree-wf_i26-1') }])
  const alive = memberWorktree(env, 'wf_i26', 1, false)
  const gone = memberWorktree(env, 'wf_i26', 2, true)
  const other = memberWorktree(env, 'wf_other', 7, true)
  for (const b of [gone, other]) assert.ok(registered(env, b), `precondition: ${b} is still registered though its directory is gone`)
  return { env, wt, run, alive, gone, other }
}

test('i26 1: start --resume answers lists the crew\'s vanished member worktrees under missingWorktrees, writes a decision line and prunes the registration', () => {
  const { env, run, alive, gone, other } = vanishedWorld()
  const before = decisionsOf(env)
  const r = resumeAnswers(env, run)
  assert.equal(r.status, 0, say(r))
  assert.ok(listed(r.json, gone), `${gone} is listed: ${say(r)}`)
  assert.ok(!listed(r.json, alive), `${alive} still has its directory, so it is not listed`)
  assert.ok(!listed(r.json, other), `${other} belongs to a run the crew never had, so it is not listed`)
  const added = decisionsOf(env).slice(before.length)
  assert.match(added, /worktree/i, `a decision line is written: ${added}`)
  assert.ok(added.includes('x'), added)
  assert.ok(!registered(env, gone), 'git worktree list no longer shows the vanished worktree')
  assert.ok(registered(env, alive), 'the live member worktree stays registered')
  assert.equal(git(env.repo, ['branch', '--list', gone]).replace(/^[*+]?\s*/, ''), gone, 'the member branch itself is left alone')
})

test('i26 2: start --resume stale does the same', () => {
  const { env, wt } = runningWorld('x')
  memberBranch(wt, 'truss-x', 'member-t1', true)
  const run = deadRun(env, 'wf_i26s', [{ label: 'x-planner', result: { tasks: [], stop: null } }, { label: 'x-builder', result: member('t1', 'member-t1') }])
  record(env, 'wf_i26s', run, 'x')
  const alive = memberWorktree(env, 'wf_i26s', 1, false)
  const gone = memberWorktree(env, 'wf_i26s', 3, true)
  assert.ok(registered(env, gone))
  const before = decisionsOf(env)
  const r = env.run('start', { slug: 'x', resume: 'stale', transcript: run.dir })
  assert.equal(r.status, 0, say(r))
  assert.equal(entryOf(r).resume, 'stale', say(r))
  assert.ok(listed(r.json, gone), say(r))
  assert.ok(!listed(r.json, alive), say(r))
  assert.match(decisionsOf(env).slice(before.length), /worktree/i)
  assert.ok(!registered(env, gone))
})

test('i26 3: start --resume merge-ready with --transcript does the same', () => {
  const { env, run, alive, gone } = vanishedWorld()
  const before = decisionsOf(env)
  const r = env.run('start', { slug: 'x', resume: 'merge-ready', transcript: run.dir })
  assert.equal(r.status, 0, say(r))
  assert.ok(listed(r.json, gone), say(r))
  assert.ok(!listed(r.json, alive), say(r))
  assert.match(decisionsOf(env).slice(before.length), /worktree/i)
  assert.ok(!registered(env, gone))
})

test('control 3: a resume with every member worktree present lists none and writes no worktree decision', () => {
  const { env } = runningWorld('x')
  const run = deadRun(env, 'wf_c3', [{ label: 'x-builder', result: member('t1', 'worktree-wf_c3-1') }])
  memberWorktree(env, 'wf_c3', 1, false)
  const before = decisionsOf(env)
  const r = resumeAnswers(env, run)
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(missingOf(r.json), [])
  assert.doesNotMatch(decisionsOf(env).slice(before.length), /worktree/i)
})

// ---------------------------------------------------------------------------------------------------------------
// item 27: doneTasks counts a BLOCKED task whose branch the crew branch holds

test('i27 1: a task whose newest result is BLOCKED but whose branch the PM merged by hand is done', () => {
  const { env, wt } = runningWorld('x')
  memberBranch(wt, 'truss-x', 'member-b', true)
  const run = deadRun(env, 'wf_i27a', [{ label: 'x-builder', result: member('tb', 'member-b', 'BLOCKED') }])
  const r = resumeAnswers(env, run)
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(names(entryOf(r).done), ['tb'])
})

test('i27 2: of several BLOCKED results only the hand-merged one counts: not a fresh branch with no commits, an unmerged one, or one with no branch', () => {
  const { env, wt } = runningWorld('x')
  memberBranch(wt, 'truss-x', 'member-m', true)
  memberBranch(wt, 'truss-x', 'member-n', false)
  git(wt, ['branch', 'member-empty', 'truss-x'])
  const run = deadRun(env, 'wf_i27b', [
    { label: 'x-builder', result: member('tm', 'member-m', 'BLOCKED') },
    { label: 'x-builder-2', result: member('te', 'member-empty', 'BLOCKED') },
    { label: 'x-builder-3', result: member('tn', 'member-n', 'BLOCKED') },
    { label: 'x-builder-4', result: member('tx', undefined, 'BLOCKED') },
  ])
  const r = resumeAnswers(env, run)
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(names(entryOf(r).done), ['tm'])
})

test('i27 3: a BLOCKED branch whose every commit was cherry-picked onto the crew branch is done; one with a commit not picked is not', () => {
  const { env, wt } = runningWorld('x')
  git(wt, ['checkout', '-q', '-b', 'member-p'])
  putFile(wt, 'members/p.txt', 'p\n', 'member p')
  git(wt, ['checkout', '-q', '-b', 'member-q', 'truss-x'])
  putFile(wt, 'members/q1.txt', 'q1\n', 'member q1')
  const q1 = head(wt)
  putFile(wt, 'members/q2.txt', 'q2\n', 'member q2')
  git(wt, ['checkout', '-q', 'truss-x'])
  putFile(wt, 'members/pre.txt', 'pre\n', 'crew work, so a pick gets another hash')
  git(wt, ['cherry-pick', 'member-p'])
  git(wt, ['cherry-pick', q1])
  assert.equal(gitStatus(wt, ['merge-base', '--is-ancestor', 'member-p', 'truss-x']), 1, 'precondition: the picked branch is not an ancestor')
  const run = deadRun(env, 'wf_i27c', [
    { label: 'x-builder', result: member('tp', 'member-p', 'BLOCKED') },
    { label: 'x-builder-2', result: member('tq', 'member-q', 'BLOCKED') },
  ])
  const r = resumeAnswers(env, run)
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(names(entryOf(r).done), ['tp'])
})

test('control 4: a DONE merged task is still done; a never-merged branch is not, whatever its marker', () => {
  const { env, wt } = runningWorld('x')
  memberBranch(wt, 'truss-x', 'member-m', true)
  memberBranch(wt, 'truss-x', 'member-n', false)
  memberBranch(wt, 'truss-x', 'member-o', false)
  const run = deadRun(env, 'wf_c4', [
    { label: 'x-builder', result: member('tm', 'member-m') },
    { label: 'x-builder-2', result: member('tn', 'member-n') },
    { label: 'x-builder-3', result: member('to', 'member-o', 'BLOCKED') },
  ])
  const r = resumeAnswers(env, run)
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(names(entryOf(r).done), ['tm'])
})

// ---------------------------------------------------------------------------------------------------------------
// item 29 (factory half): workflowArgs for an --args-file inside the truss dir

const startArgsFile = (env: any, p: string) => env.run('start', { stage: 'next', 'args-file': p })
const SHORT_KEYS = ['argsFile', 'scriptPath', 'crews', 'held', 'foremen', 'refused', 'stale', 'unfinished', 'warnings']

test('i29 1: --args-file inside the truss dir adds workflowArgs {"trussFile": P} to the short output, and the file holds the whole output', () => {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew('x')]))
  writeGoal(env.dir, 'x')
  const p = `${env.dir}/sub/stage-args.json`
  const r = startArgsFile(env, p)
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(r.json.workflowArgs, { trussFile: flat(p) }, say(r))
  assert.equal(r.json.argsFile, flat(p))
  const text = readFileSync(p, 'utf8')
  assert.ok(text.endsWith('}\n') && !text.slice(0, -1).includes('\n'), 'one line, as before')
  assert.deepEqual(JSON.parse(text).truss.crews.map((e: any) => e.slug), ['x'])
})

test('i29 2: --args-file outside the truss dir prints no workflowArgs and adds a warning; the output gains no key and the file is still written', () => {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew('x')]))
  writeGoal(env.dir, 'x')
  const outside = `${tmp('f3-out-')}/stage-args.json`
  // a sibling whose name starts with the truss dir's name is outside too
  const sibling = `${flat(env.dir)}-sibling`
  try {
    for (const p of [outside, `${sibling}/stage-args.json`]) {
      const r = startArgsFile(env, p)
      assert.equal(r.status, 0, say(r))
      assert.ok(!Object.hasOwn(r.json, 'workflowArgs'), `no workflowArgs for ${p}: ${say(r)}`)
      assert.deepEqual(Object.keys(r.json), SHORT_KEYS, 'no new output key')
      assert.ok(r.json.warnings.some((w: string) => /args-file/.test(String(w))), `a warning names --args-file: ${JSON.stringify(r.json.warnings)}`)
      assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')).truss.crews.map((e: any) => e.slug), ['x'], 'the file is written all the same')
      // the crew already runs, so a second start with the same file still finds nothing new; reset for the next path
      const plan = readPlan(env.dir)
      plan.crews[0].status = 'planned'
      writePlan(env.dir, plan)
    }
  } finally {
    rmSync(sibling, { recursive: true, force: true })
  }
})

test('control 5: start without --args-file prints no workflowArgs, and an outside --args-file keeps the pointer keys', () => {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew('x'), crew('y')]))
  writeGoal(env.dir, 'x')
  writeGoal(env.dir, 'y')
  const plain = env.run('start', { stage: 'next' })
  assert.equal(plain.status, 0, say(plain))
  assert.ok(!Object.hasOwn(plain.json, 'workflowArgs'))
  const plan = readPlan(env.dir)
  for (const c of plan.crews) c.status = 'planned'
  writePlan(env.dir, plan)
  const out = startArgsFile(env, `${tmp('f3-ctl-')}/a.json`)
  assert.equal(out.status, 0, say(out))
  assert.deepEqual(Object.keys(out.json), SHORT_KEYS)
  assert.deepEqual(out.json.crews, ['x', 'y'])
})

// ---------------------------------------------------------------------------------------------------------------
// item 31 (factory half): the entry carries head

const HEX40 = /^[0-9a-f]{40}$/

test('i31 1: a fresh start puts git rev-parse refs/heads/truss-<slug> in the entry as head', () => {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew('x')]))
  writeGoal(env.dir, 'x')
  const r = env.run('start', { stage: 'next' })
  assert.equal(r.status, 0, say(r))
  const e = entryOf(r)
  assert.match(String(e.head), HEX40, say(r))
  assert.equal(e.head, git(env.repo, ['rev-parse', 'refs/heads/truss-x']))
})

test('i31 2: every resume form puts the crew branch head in the entry, following the branch as it moves', () => {
  const { env, wt } = runningWorld('x')
  memberBranch(wt, 'truss-x', 'member-h', true)
  const run = deadRun(env, 'wf_i31', [{ label: 'x-planner', result: { tasks: [], stop: null } }, { label: 'x-builder', result: member('th', 'member-h') }])
  record(env, 'wf_i31', run, 'x')
  const tip = git(env.repo, ['rev-parse', 'refs/heads/truss-x'])
  const a = resumeAnswers(env, run)
  assert.equal(a.status, 0, say(a))
  assert.equal(entryOf(a).head, tip, 'resume answers')
  const m = env.run('start', { slug: 'x', resume: 'merge-ready' })
  assert.equal(m.status, 0, say(m))
  assert.equal(entryOf(m).head, tip, 'resume merge-ready')
  const s = env.run('start', { slug: 'x', resume: 'stale', transcript: run.dir })
  assert.equal(s.status, 0, say(s))
  assert.equal(entryOf(s).head, tip, 'resume stale')
  const next = putFile(wt, 'members/more.txt', 'more\n', 'crew moves')
  const again = env.run('start', { slug: 'x', resume: 'merge-ready' })
  assert.equal(entryOf(again).head, next, 'a rewritten or advanced branch gives a new head')
  assert.notEqual(next, tip)
})

// ---------------------------------------------------------------------------------------------------------------
// item 32: integrate skips a branch whose merge leaves the tree unchanged

function crewEnv() {
  const env = mkEnv({ config: CFG, files: { 'a.txt': 'base\n' } })
  writePlan(env.dir, planObj([crew('s', { owns: ['src/s/**'], status: 'running' })]))
  const wt = addCrewWorktree(env.repo, 's')
  return { env, wt }
}
/** A member branch off truss-s in its own worktree; returns the worktree path. */
function memberWt(env: any, name: string): string {
  git(env.repo, ['branch', name, 'truss-s'])
  const mw = `${tmp('f3-member-')}/m`
  git(env.repo, ['worktree', 'add', '-q', mw, name])
  git(mw, ['config', 'user.name', 'T'])
  git(mw, ['config', 'user.email', 't@example.invalid'])
  return mw
}
const parents = (wt: string): number => git(wt, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ').length - 1

/** A stale member branch (one commit adding a.ts and b.ts) and a crew head that holds the same files as two split commits, so the member's commits are not ancestors and no patch id matches. */
function splitRewritten() {
  const { env, wt } = crewEnv()
  const mw = memberWt(env, 'member-old')
  putFile(mw, 'src/s/a.ts', 'a\n')
  putFile(mw, 'src/s/b.ts', 'b\n')
  git(mw, ['add', '--', 'src/s/a.ts', 'src/s/b.ts'])
  git(mw, ['commit', '-q', '-m', 'member both\n\nTruss-Crew: s\nTruss-Role: builder'])
  putFile(wt, 'src/s/a.ts', 'a\n', 'split a')
  putFile(wt, 'src/s/b.ts', 'b\n', 'split b')
  assert.equal(gitStatus(wt, ['merge-base', '--is-ancestor', 'member-old', 'truss-s']), 1, 'precondition: the stale branch is not an ancestor')
  assert.match(git(wt, ['cherry', 'truss-s', 'member-old']), /^\+/, 'precondition: no patch id matches')
  return { env, wt, mw }
}

test('i32 1: a stale member branch whose merge leaves the crew head\'s tree unchanged is not merged: {"merged": true, "contained": true, "head": HEAD}', () => {
  const { env, wt } = splitRewritten()
  const tip = head(wt)
  const count = git(wt, ['rev-list', '--count', 'HEAD'])
  const res = env.run('integrate', { slug: 's', branch: 'member-old' })
  assert.equal(res.status, 0, res.stderr + res.stdout)
  assert.deepEqual(res.json, { merged: true, contained: true, head: tip }, say(res))
  assert.equal(head(wt), tip, 'no merge commit')
  assert.equal(git(wt, ['rev-list', '--count', 'HEAD']), count)
  assert.notEqual(gitStatus(wt, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']), 0, 'no merge in progress')
})

test('i32 2: a second integrate of a branch the first one merged answers contained and leaves the head alone', () => {
  const { env, wt } = crewEnv()
  const mw = memberWt(env, 'member')
  putFile(mw, 'src/s/new.ts', 'export {}\n', 'member work\n\nTruss-Crew: s\nTruss-Role: builder')
  const first =env.run('integrate', { slug: 's', branch: 'member' })
  assert.equal(first.status, 0, say(first))
  assert.equal(first.json.merged, true)
  const tip = head(wt)
  const again = env.run('integrate', { slug: 's', branch: 'member' })
  assert.equal(again.status, 0, say(again))
  assert.deepEqual(again.json, { merged: true, contained: true, head: tip })
  assert.equal(head(wt), tip)
})

test('control 6: a branch with new work still merges with --no-ff and carries no contained key', () => {
  const { env, wt } = crewEnv()
  const mw = memberWt(env, 'member')
  putFile(mw, 'src/s/new.ts', 'export {}\n', 'member work\n\nTruss-Crew: s\nTruss-Role: builder')
  const start =head(wt)
  const res = env.run('integrate', { slug: 's', branch: 'member' })
  assert.equal(res.status, 0, say(res))
  assert.equal(res.json.merged, true)
  assert.notEqual(res.json.contained, true)
  assert.equal(res.json.head, head(wt))
  assert.notEqual(head(wt), start)
  assert.equal(parents(wt), 2, 'a merge commit even though a fast-forward was possible')
  assert.ok(existsSync(`${wt}/src/s/new.ts`))
})

test('control 7: a conflicting branch still leaves the merge in progress with the paths listed, exit 1', () => {
  const { env, wt } = crewEnv()
  const mw = memberWt(env, 'member')
  putFile(mw, 'a.txt', 'member side\n', 'member edit\n\nTruss-Crew: s\nTruss-Role: builder')
  putFile(wt, 'a.txt', 'crew side\n', 'crew edit')
  const res = env.run('integrate', { slug: 's', branch: 'member' })
  assert.equal(res.status, 1, say(res))
  assert.equal(res.json.merged, false)
  assert.deepEqual(res.json.conflicts, ['a.txt'])
  assert.equal(gitStatus(wt, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']), 0, 'the merge is left in progress')
})

test('control 8: the trailer check still runs first, even for a branch whose tree the crew head already holds', () => {
  const { env, wt } = crewEnv()
  const mw = memberWt(env, 'member-bad')
  putFile(mw, 'src/s/a.ts', 'a\n', 'split block\n\nTruss-Crew: s\n\nTruss-Role: builder')
  putFile(wt, 'src/s/a.ts', 'a\n', 'crew has it too')
  const tip = head(wt)
  const res = env.run('integrate', { slug: 's', branch: 'member-bad' })
  assert.equal(res.status, 1, say(res))
  assert.equal(res.json.merged, false)
  assert.equal(res.json.trailers.length, 1, say(res))
  assert.equal(head(wt), tip)
})

// ---------------------------------------------------------------------------------------------------------------
// item 34 (factory half): the env rule works on failure blocks

const ENV_LINE = 'Error: browserType.launch: Host system is missing dependencies to run browsers.'
const CODE_LINE = 'Error: expect(received).toBe(expected) // Object.is equality'

/** Playwright list-reporter output: `N) [project] › file:line:col › title ───` headers, each followed by its body lines. */
function pwOutput(blocks: { project: string; body: string[] }[], preamble: string[] = []): string {
  const out = [...preamble, `Running ${blocks.length + 3} tests using 4 workers`, '']
  blocks.forEach((b, i) => {
    out.push(`  ${i + 1}) [${b.project}] › e2e/floor.spec.ts:${i + 10}:5 › case ${i + 1} ──────────────────────────`, '')
    for (const l of b.body) out.push(`    ${l}`)
    out.push('')
  })
  out.push(`  ${blocks.length} failed`, '  3 passed (12.0s)')
  return out.join('\n') + '\n'
}
const codeBlock = (project = 'chromium') => ({ project, body: [CODE_LINE, '', 'Expected: 1', 'Received: 2'] })
const envBlock = (project = 'webkit') => ({ project, body: [ENV_LINE, 'Call log:', '  - <launching> /x/webkit/pw_run.sh'] })

/** TAP output: `not ok N - title` blocks with a YAML error. */
function tapOutput(cases: { ok: boolean; error?: string }[]): string {
  const out = ['TAP version 13']
  cases.forEach((c, i) => {
    if (c.ok) out.push(`ok ${i + 1} - case ${i + 1}`)
    else out.push(`not ok ${i + 1} - case ${i + 1}`, '  ---', '  duration_ms: 1.5', `  error: '${c.error}'`, '  code: ERR_ASSERTION', '  ...')
  })
  out.push(`1..${cases.length}`, `# fail ${cases.filter((c) => !c.ok).length}`)
  return out.join('\n') + '\n'
}

/** Runs the check command over `text` (cat + exit 1) as crew s, expecting `expect`; returns the CLI result and the stored record. */
function checkOf(text: string, expect = 'red', exit = 1) {
  const env = mkEnv({ config: CFG })
  const f = `${tmp('f3-out-')}/out.txt`
  writeFileSync(f, text)
  writePlan(env.dir, planObj([crew('s', { acceptanceTest: `cat '${f}'; exit ${exit}`, status: 'running' })]))
  const res = env.run('check', { slug: 's', cwd: env.repo, expect })
  const rec = JSON.parse(readFileSync(`${env.dir}/checks/s-1.json`, 'utf8'))
  return { res, rec }
}

test('i34 1: Playwright output with 1 env line and 66 code failures has no env, carries envSeen, and counts as red', () => {
  const blocks = [envBlock(), ...Array.from({ length: 66 }, () => codeBlock())]
  const { res, rec } = checkOf(pwOutput(blocks))
  assert.equal(res.status, 0, `a red with envSeen and no env counts as red: ${say(res)}`)
  assert.equal(res.json.ok, true)
  assert.ok(!Object.hasOwn(res.json, 'env'), say(res))
  assert.equal(res.json.envSeen, ENV_LINE)
  assert.ok(!Object.hasOwn(rec, 'env'), 'the record has no env')
  assert.equal(rec.envSeen, ENV_LINE, 'the record carries envSeen')
  assert.equal(rec.exit, 1)
})

test('i34 2: an env line before the first failure block does not explain the code failures after it', () => {
  const { res, rec } = checkOf(pwOutput([codeBlock(), codeBlock()], [ENV_LINE]))
  assert.equal(res.status, 0, say(res))
  assert.ok(!Object.hasOwn(rec, 'env'), JSON.stringify(rec))
  assert.equal(rec.envSeen, ENV_LINE)
})

test('i34 3: node:test TAP output with one env block and one code failure has no env and carries envSeen', () => {
  const text = tapOutput([{ ok: true }, { ok: false, error: 'Host system is missing dependencies to run browsers.' }, { ok: false, error: 'expected 1 to equal 2' }])
  const { res, rec } = checkOf(text)
  assert.equal(res.status, 0, say(res))
  assert.ok(!Object.hasOwn(rec, 'env'), JSON.stringify(rec))
  assert.equal(rec.envSeen, "error: 'Host system is missing dependencies to run browsers.'")
  assert.equal(res.json.ok, true)
})

test('control 9: Playwright output with an env line in every failure block still sets env, and a red expectation is refused', () => {
  const { res, rec } = checkOf(pwOutput([envBlock('webkit'), envBlock('webkit')]))
  assert.equal(res.status, 1, say(res))
  assert.equal(res.json.ok, false)
  assert.equal(res.json.env, ENV_LINE)
  assert.equal(rec.env, ENV_LINE)
  assert.ok(!Object.hasOwn(rec, 'envSeen'), JSON.stringify(rec))
})

test('control 10: TAP output with an env line in every not ok block still sets env', () => {
  const text = tapOutput([{ ok: false, error: 'Host system is missing dependencies to run browsers.' }, { ok: false, error: 'Host system is missing dependencies to run browsers.' }])
  const { res, rec } = checkOf(text)
  assert.equal(res.status, 1, say(res))
  assert.match(String(rec.env), /Host system is missing dependencies/)
  assert.ok(!Object.hasOwn(rec, 'envSeen'))
})

test('control 11: output with no failure blocks and an env line sets env; without an env line it sets neither key', () => {
  const lone = checkOf('node: error while loading shared libraries: libfoo.so.1: cannot open shared object file\n', 'red', 127)
  assert.equal(lone.rec.env, 'node: error while loading shared libraries: libfoo.so.1: cannot open shared object file')
  assert.ok(!Object.hasOwn(lone.rec, 'envSeen'))
  const code = checkOf(pwOutput([codeBlock(), codeBlock()]))
  assert.equal(code.res.status, 0, say(code.res))
  assert.ok(!Object.hasOwn(code.rec, 'env') && !Object.hasOwn(code.rec, 'envSeen'), JSON.stringify(code.rec))
  const plain = checkOf('boom: something broke\n', 'red', 3)
  assert.ok(!Object.hasOwn(plain.rec, 'env') && !Object.hasOwn(plain.rec, 'envSeen'), JSON.stringify(plain.rec))
})

test('control 12: a passing check carries neither env nor envSeen, even with an env line in its output', () => {
  const { res, rec } = checkOf(`${ENV_LINE}\n`, 'green', 0)
  assert.equal(res.status, 0, say(res))
  assert.ok(!Object.hasOwn(rec, 'env') && !Object.hasOwn(rec, 'envSeen'), JSON.stringify(rec))
})

// ---------------------------------------------------------------------------------------------------------------
// item 35: a resume before `finish` recovers the UX direction from the crew's agent results

const UX = 'Direction: calm and dense.'

test('i35 1: a ux crew resumed before finish takes the newest ux DIRECTION result of its runs as {label, text}; a later run wins a tie, other crews and non-DIRECTION results are skipped', () => {
  const { env } = runningWorld('x', { ux: UX })
  deadRun(env, 'wf_i35a', [
    { label: 'x-ux', result: '\n\nUX: DIRECTION\n\nold direction\n' },
    { label: 'x-ux-2', result: 'UX: DIRECTION\nA second\n' },
    { label: 'y-ux-9', result: 'UX: DIRECTION\nother crew\n' },
    { label: 'x-ux-3', result: 'UX: REWORK\nfix the spacing\n' },
    { label: 'x-builder', result: 'built' },
  ], 40 * MIN)
  const b = deadRun(env, 'wf_i35b', [{ label: 'x-ux-2', result: '  \nUX: DIRECTION\nB second  \n\n' }], 20 * MIN)
  const r = resumeAnswers(env, b)
  assert.equal(r.status, 0, say(r))
  assert.equal(entryOf(r).ux, true)
  assert.deepEqual(entryOf(r).direction, { label: 'x-ux-2', text: 'UX: DIRECTION\nB second' }, say(r))
})

test('i35 2: with a single DIRECTION result in an earlier run, a resume of any kind takes it', () => {
  const { env } = runningWorld('x', { ux: UX })
  const a = deadRun(env, 'wf_i35c', [{ label: 'x-ux', result: 'UX: DIRECTION\nonly one\n' }, { label: 'x-builder', result: 'built' }], 30 * MIN)
  const r = env.run('start', { slug: 'x', resume: 'merge-ready', transcript: a.dir })
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(entryOf(r).direction, { label: 'x-ux', text: 'UX: DIRECTION\nonly one' }, say(r))
})

test('control 13: a resume whose reports dir holds a direction keeps it over the agent results', () => {
  const { env } = runningWorld('x', { ux: UX })
  writeReport(env.dir, 'x', 'x-ux', 'UX: DIRECTION\nfrom the reports dir\n')
  const run = deadRun(env, 'wf_c13', [{ label: 'x-ux-2', result: 'UX: DIRECTION\nfrom the run\n' }])
  const r = resumeAnswers(env, run)
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(entryOf(r).direction, { label: 'x-ux', text: 'UX: DIRECTION\nfrom the reports dir' })
})

test('control 14: no DIRECTION result anywhere leaves direction null', () => {
  const { env } = runningWorld('x', { ux: UX })
  const run = deadRun(env, 'wf_c14', [{ label: 'x-ux', result: 'UX: REWORK\nnot a direction\n' }, { label: 'x-builder', result: 'built' }])
  const r = resumeAnswers(env, run)
  assert.equal(r.status, 0, say(r))
  assert.equal(entryOf(r).direction, null)
})

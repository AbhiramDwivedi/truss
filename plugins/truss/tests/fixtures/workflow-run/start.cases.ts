// @ts-nocheck
// truss ADR-0009 Decision 1, the `start` command (rows at ADR :158-161, paragraphs "start, engine split", "start,
// allowance and label numbering", "start, base", "start, stale runs" and "Labels"). Written from the ADR before
// bin/factory.ts existed; loaded by tests/factory.check.ts (it imports every *.cases.ts here).
//
// Client ruling (overrides ADR :175): `spent` counts the crew's qc FAILs only; stress test reports never add to it.
//
// Assumptions the ADR leaves open (each is also listed in the report):
// - how `start` finds the Workflow runs (T/../*/) is not in the ADR rows: these tests pass `--transcript <a run dir>`
//   to every start call that needs the runs (--stage next with running crews, --resume stale), and the runs root is
//   that dir's parent;
// - a refusal of `--resume ...` is exit 1 with `why` at the top level of the one-line JSON object;
// - the `goal` entry field is only checked to be a string; `stressTest` is `true` or a string that says "yes"; `scope`
//   and `highImpact` contain the goal file's section text;
// - the stage.js copy made by --scripts-dir is `<S>/truss-stage.js` (plan-args writes `truss-plan.js` the same way);
// - a task in `done` is a task name (string) or a task object with a `name`; `tasks` are the planner's task objects;
// - `since` (stale list) is a non-empty string; a foreman's reason for a missing `## Engine` section is a string.

import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import * as reg from '../../../hooks/register.ts'
import {
  addCrewWorktree, appendEvent, assertOneLine, crew, factorySpawn, flat, git, head, qcReport, mkEnv, mkRun, planObj, pluginCopy, putFile,
  readEvents, readPlan, runCli, tmp, validateEvent, writeGoal, writePlan, writeReport,
} from './harness.ts'

const { workflowRoleVerdict, workflowCallVerdict, parsePlan, planVerdict } = reg

const HOUR = 3_600_000
const MIN = 60_000
const iso = (ms: number): string => new Date(ms).toISOString()
const norm = (p: string): string => {
  try {
    return flat(realpathSync.native(p)).toLowerCase()
  } catch {
    return flat(p).toLowerCase()
  }
}

const TRUSS_KEYS = ['crews', 'dir', 'kind', 'plugin', 'repo', 'reworkAllowance', 'roles', 'scriptPath', 'target']
const OUTPUT_KEYS = ['foremen', 'held', 'refused', 'stale', 'truss', 'unfinished', 'warnings']
const ENTRY_KEYS = ['acceptanceTest', 'adrs', 'answers', 'architecture', 'base', 'branch', 'done', 'goal', 'goalFile', 'highImpact', 'labelFrom', 'owns', 'resume', 'scope', 'slug', 'spent', 'stage', 'stressTest', 'tasks', 'worktree']

/** A test world: env with plan.json (crews, `plan` overrides) and one goal file per crew (`goals[slug]` section overrides). */
function world(crews: any[], o: { config?: unknown; plan?: Record<string, unknown>; goals?: Record<string, any> } = {}) {
  const env = mkEnv({ config: o.config })
  writePlan(env.dir, planObj(crews, o.plan ?? {}))
  for (const c of crews) writeGoal(env.dir, c.slug, o.goals?.[c.slug] ?? {})
  return env
}

const start = (env: any, stage: string | number = 'next', flags: Record<string, unknown> = {}, extra: string[] = []) => env.run('start', { stage, ...flags }, extra)
const resume = (env: any, slug: string, kind: string, flags: Record<string, unknown> = {}) => env.run('start', { slug, resume: kind, ...flags })
const statusOf = (env: any, slug: string): string => readPlan(env.dir).crews.find((c: any) => c.slug === slug).status
const factorySpawns = (env: any, slug: string): any[] => readEvents(env.dir).filter((e) => e.event === 'spawn' && e.by === 'factory' && e.crew === slug)
const wtPath = (env: any, slug: string): string => `${env.repo}/.claude/worktrees/truss-${slug}`
const slugsOf = (list: any[]): string[] => list.map((x) => x.slug)

function assertEventsValid(env: any): void {
  for (const ev of readEvents(env.dir)) {
    if (ev.by === 'factory' || ev.event === 'decision') assert.deepEqual(validateEvent(ev), [], JSON.stringify(ev))
  }
}

/** Marks crew `slug` as left running by an earlier start: its worktree, and a factory spawn line at `spawnTs`. */
function makeRunning(env: any, slug: string, spawnTs = iso(Date.now() - 2 * HOUR)): string {
  const wt = addCrewWorktree(env.repo, slug)
  appendEvent(env.dir, factorySpawn(slug, spawnTs))
  return wt
}

/** A Workflow run dir whose last write was `agoMs` ago (default 2 hours); `agents` entries override per-agent fields. */
function deadRun(env: any, runId: string, agents: any[], o: { agoMs?: number; journalMtimeMs?: number } = {}) {
  const endMs = Date.now() - (o.agoMs ?? 2 * HOUR)
  return mkRun(env.transcripts, runId, agents.map((a) => ({ startTs: iso(endMs - MIN), endTs: iso(endMs), ...a })), { journalMtimeMs: o.journalMtimeMs ?? endMs })
}

/** The state `finish` leaves: a `by: "workflow:<runId>"` spawn line per label, plus an `incomplete` line when `incomplete`. */
function record(env: any, runId: string, run: any, slug: string, o: { incomplete?: boolean } = {}): void {
  const ts = iso(Date.now() - 90 * MIN)
  for (const [label, id] of Object.entries(run.ids)) {
    appendEvent(env.dir, { v: 1, ts, event: 'spawn', crew: slug, agent: label, agentId: id, type: 'general-purpose', model: 'opus', effort: 'medium', by: `workflow:${runId}` })
  }
  if (o.incomplete) appendEvent(env.dir, { v: 1, ts, event: 'incomplete', crew: slug, agent: slug, run: runId })
}

/** A run holding none of the crews' labels (a plan run), so a `--transcript` has a runs root to name. */
const anchorRun = (env: any) => deadRun(env, 'wf_anchor', [{ label: 'truss-designer', agentType: 'truss:design-engineer' }])

/** On the crew branch (in its worktree): a member branch `name` with one commit, merged into the crew branch when `merge`. */
function memberBranch(wt: string, crewBranch: string, name: string, merge: boolean): void {
  git(wt, ['checkout', '-q', '-b', name])
  putFile(wt, `members/${name}.txt`, `${name}\n`, `member ${name}`)
  git(wt, ['checkout', '-q', crewBranch])
  if (merge) git(wt, ['merge', '-q', '--no-ff', '-m', `merge ${name}`, name])
}

const task = (name: string) => ({ name, role: 'builder', effort: 'medium', files: [`src/x/${name}.ts`], reads: [], brief: `do ${name}`, after: [] })

// ---------------------------------------------------------------------------------------------------------------
// engine split

test('start engine split: a goal with `## Engine` workflow goes to truss.crews, the others to foremen with their reason', () => {
  const env = world([crew('wf'), crew('ld'), crew('nosec')], { goals: { ld: { engine: 'foreman has a commissioning member' } } })
  // a goal file with no ## Engine section at all
  const text = readFileSync(`${env.dir}/goals/nosec.md`, 'utf8').replace(/\n## Engine[\s\S]*$/, '\n')
  assert.ok(!text.includes('## Engine'))
  writeFileSync(`${env.dir}/goals/nosec.md`, text)
  const res = start(env)
  const j = assertOneLine(res)
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(slugsOf(j.truss.crews), ['wf'])
  assert.deepEqual(slugsOf(j.foremen).sort(), ['ld', 'nosec'])
  const ld = j.foremen.find((l: any) => l.slug === 'ld')
  assert.match(ld.reason, /commissioning member/)
  assert.equal(typeof j.foremen.find((l: any) => l.slug === 'nosec').reason, 'string')
})

test('start engine split: a foreman crew stays planned, gets no worktree and no spawn line, and a second start returns it again', () => {
  const env = world([crew('ld')], { goals: { ld: { engine: 'foreman client raised a member to high' } } })
  const a = start(env)
  const ja = assertOneLine(a)
  assert.equal(a.status, 0, a.stderr)
  assert.deepEqual(slugsOf(ja.foremen), ['ld'])
  assert.deepEqual(ja.truss.crews, [])
  assert.equal(statusOf(env, 'ld'), 'planned')
  assert.ok(!existsSync(wtPath(env, 'ld')), 'no worktree for a foreman crew')
  assert.equal(git(env.repo, ['branch', '--list', 'truss-ld']), '', 'no branch for a foreman crew')
  assert.equal(readEvents(env.dir).filter((e) => e.event === 'spawn').length, 0)
  const b = start(env)
  assert.equal(b.stdout, a.stdout, 'idempotent: same output')
  assert.equal(statusOf(env, 'ld'), 'planned')
})

test('start engine split: `merge: single` forces every crew to foreman', () => {
  const env = world([crew('a'), crew('b')], { config: { merge: 'single', target: 'main' } })
  const j = assertOneLine(start(env))
  assert.deepEqual(j.truss.crews, [])
  assert.deepEqual(slugsOf(j.foremen).sort(), ['a', 'b'])
  assert.equal(statusOf(env, 'a'), 'planned')
  assert.equal(readEvents(env.dir).filter((e) => e.event === 'spawn').length, 0)
})

test('start engine split: --no-workflow forces every crew to foreman', () => {
  const env = world([crew('a'), crew('b')])
  const j = assertOneLine(start(env, 'next', { 'no-workflow': true }))
  assert.deepEqual(j.truss.crews, [])
  assert.deepEqual(slugsOf(j.foremen).sort(), ['a', 'b'])
  assert.ok(!existsSync(wtPath(env, 'a')))
  assert.equal(statusOf(env, 'b'), 'planned')
})

// ---------------------------------------------------------------------------------------------------------------
// status rules, stage choice, the cap

test('start --stage next: the lowest stage with a planned crew; merged stages are skipped; --stage n must be that stage', () => {
  const crews = [crew('old', { stage: 1, status: 'merged' }), crew('a', { stage: 2 }), crew('b', { stage: 3 })]
  const env = world(crews)
  const bad = start(env, 3)
  assert.equal(bad.status, 1, `stdout ${bad.stdout} stderr ${bad.stderr}`)
  assert.equal(statusOf(env, 'b'), 'planned')
  assert.equal(statusOf(env, 'a'), 'planned')
  const bad1 = start(env, 1)
  assert.equal(bad1.status, 1)
  const ok = start(env, 2)
  assert.equal(ok.status, 0, ok.stderr)
  assert.deepEqual(slugsOf(assertOneLine(ok).truss.crews), ['a'])
  assert.equal(statusOf(env, 'a'), 'running')
  assert.equal(statusOf(env, 'b'), 'planned')
})

test('start --stage next: a stage whose only crews are running is still the stage; --stage of a later stage refuses', () => {
  const env = world([crew('r', { stage: 1, status: 'running' }), crew('p', { stage: 2 })])
  makeRunning(env, 'r', iso(Date.now()))
  const anchor = anchorRun(env)
  const res = start(env, 'next', { transcript: anchor.dir })
  const j = assertOneLine(res)
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(j.truss.crews, [], 'a running crew is never in a plain --stage result')
  assert.deepEqual(j.foremen, [])
  assert.equal(statusOf(env, 'p'), 'planned', 'stage 2 waits for stage 1')
  const later = start(env, 2, { transcript: anchor.dir })
  assert.equal(later.status, 1)
  assert.equal(statusOf(env, 'p'), 'planned')
})

test('start: merged, dropped and running crews are never re-marked or returned; only planned ones start', () => {
  const crews = [crew('m', { status: 'merged' }), crew('d', { status: 'dropped' }), crew('r', { status: 'running' }), crew('p')]
  const env = world(crews)
  makeRunning(env, 'r', iso(Date.now()))
  const before = readPlan(env.dir)
  const res = start(env, 'next', { transcript: anchorRun(env).dir })
  const j = assertOneLine(res)
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(slugsOf(j.truss.crews), ['p'])
  const after = readPlan(env.dir)
  for (const c of after.crews) assert.equal(c.status, c.slug === 'p' ? 'running' : before.crews.find((x: any) => x.slug === c.slug).status)
  assert.equal(factorySpawns(env, 'm').length + factorySpawns(env, 'd').length, 0)
  assert.equal(factorySpawns(env, 'r').length, 1, 'the running crew gets no second spawn line')
})

test('start cap: free slots = maxParallelCrews minus running crews (any engine), filled in plan queue order', () => {
  const env = world([crew('zeta'), crew('alpha'), crew('mid'), crew('busy', { status: 'running' })], { plan: { maxParallelCrews: 3 } })
  makeRunning(env, 'busy', iso(Date.now()))
  const j = assertOneLine(start(env, 'next', { transcript: anchorRun(env).dir }))
  assert.deepEqual(slugsOf(j.truss.crews), ['zeta', 'alpha'], 'queue order, not alphabetical; 3 - 1 running = 2 slots')
  assert.equal(statusOf(env, 'mid'), 'planned')
  assert.ok(!j.refused.some((r: any) => r.slug === 'mid'), 'a crew left for lack of a slot is not refused')
})

test('start cap: a running foreman crew counts against the cap like any other', () => {
  const env = world([crew('foreman1', { status: 'running' }), crew('a'), crew('b')], { plan: { maxParallelCrews: 2 }, goals: { foreman1: { engine: 'foreman commissioning member' } } })
  const j = assertOneLine(start(env, 'next', { transcript: anchorRun(env).dir }))
  assert.deepEqual(slugsOf(j.truss.crews), ['a'], 'one slot free')
  assert.equal(statusOf(env, 'b'), 'planned')
})

test('start cap: each returned foreman crew takes one of the call\'s slots', () => {
  const env = world([crew('ld'), crew('w1'), crew('w2')], { plan: { maxParallelCrews: 2 }, goals: { ld: { engine: 'foreman commissioning member' } } })
  const j = assertOneLine(start(env))
  assert.deepEqual(slugsOf(j.foremen), ['ld'])
  assert.deepEqual(slugsOf(j.truss.crews), ['w1'], 'two slots: the foreman took one')
  assert.equal(statusOf(env, 'w2'), 'planned')
  assert.equal(statusOf(env, 'ld'), 'planned')
})

// ---------------------------------------------------------------------------------------------------------------
// workflow crew start

test('start (workflow crew): refused on planVerdict with the hook\'s text; the crew stays planned with no worktree or spawn', () => {
  const env = world([crew('ok'), crew('gate', { verdict: 'design', clientApproval: 'pending' })])
  const expected = planVerdict(parsePlan(readFileSync(`${env.dir}/plan.json`, 'utf8')), 'gate')
  assert.ok(expected, 'fixture: the real planVerdict refuses this crew')
  const j = assertOneLine(start(env))
  assert.deepEqual(slugsOf(j.truss.crews), ['ok'])
  assert.deepEqual(j.refused, [{ slug: 'gate', reason: expected.deny }])
  assert.equal(statusOf(env, 'gate'), 'planned')
  assert.ok(!existsSync(wtPath(env, 'gate')))
  assert.equal(factorySpawns(env, 'gate').length, 0)
})

test('start (workflow crew): an unapproved plan refuses the crew with the real planVerdict text', () => {
  const env = world([crew('d', { stage: 0, verdict: 'design' })], { plan: { approval: 'client', approvedAt: null } })
  const expected = planVerdict(parsePlan(readFileSync(`${env.dir}/plan.json`, 'utf8')), 'd')
  assert.ok(expected)
  const j = assertOneLine(start(env))
  assert.deepEqual(j.truss.crews, [])
  assert.deepEqual(j.refused, [{ slug: 'd', reason: expected.deny }])
  assert.equal(statusOf(env, 'd'), 'planned')
})

test('start (workflow crew): sets running, makes the worktree and branch from the target head, writes one spawn line and a decision', () => {
  const env = world([crew('x')])
  const target = putFile(env.repo, 'later.txt', 'later\n', 'main moves on')
  const res = start(env)
  const j = assertOneLine(res)
  assert.equal(res.status, 0, res.stderr)
  assert.equal(statusOf(env, 'x'), 'running')
  const wt = wtPath(env, 'x')
  assert.ok(existsSync(`${wt}/later.txt`), 'worktree is at the target head')
  assert.equal(git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']), 'truss-x')
  assert.equal(head(wt), target)
  const spawns = readEvents(env.dir).filter((e) => e.event === 'spawn')
  assert.equal(spawns.length, 1)
  const { v, ts, ...rest } = spawns[0]
  assert.equal(v, 1)
  assert.ok(Number.isFinite(Date.parse(ts)))
  assert.deepEqual(rest, { event: 'spawn', crew: 'x', agent: 'x', agentId: null, type: 'workflow-crew', model: null, effort: null, by: 'factory' })
  assert.deepEqual(validateEvent(spawns[0]), [])
  assert.ok(readFileSync(`${env.dir}/decisions.md`, 'utf8').includes('x'), 'a decision line was appended')
  assertEventsValid(env)
})

test('start (workflow crew): an existing crew worktree is reused, its commits kept', () => {
  const env = world([crew('x')])
  const wt = addCrewWorktree(env.repo, 'x')
  const mine = putFile(wt, 'src/x/mine.ts', 'mine\n', 'crew work')
  const j = assertOneLine(start(env))
  assert.deepEqual(slugsOf(j.truss.crews), ['x'])
  assert.equal(head(wt), mine)
  assert.equal(git(env.repo, ['branch', '--list', 'truss-x']).replace(/^[*+]?\s*/, ''), 'truss-x')
  assert.equal(j.truss.crews[0].base, git(wt, ['merge-base', 'main', 'HEAD']))
})

test('start output: top-level keys, truss keys and crew entry keys are exactly the ADR row\'s', () => {
  const env = world([crew('x', { owns: ['src/x/**', 'docs/x.md'], acceptanceTest: 'node --test t.ts' })], {
    plan: { reworkAllowance: 3 },
    goals: { x: { scope: 'Build only the x thing.', highImpact: 'src/x/core.ts', stressTest: 'yes, it takes input' } },
  })
  const j = assertOneLine(start(env))
  assert.deepEqual(Object.keys(j).sort(), OUTPUT_KEYS)
  assert.deepEqual(j.held, [], 'a start with room and memory holds nothing')
  assert.deepEqual(Object.keys(j.truss).sort(), TRUSS_KEYS)
  assert.equal(j.truss.kind, 'stage')
  assert.equal(norm(j.truss.dir), norm(env.dir))
  assert.equal(norm(j.truss.repo), norm(env.repo))
  assert.equal(norm(j.truss.plugin), norm(env.plugin))
  assert.equal(j.truss.target, 'main')
  assert.equal(j.truss.reworkAllowance, 3)
  assert.equal(flat(j.truss.scriptPath), `${flat(j.truss.plugin)}/workflows/stage.js`)
  assert.equal(workflowRoleVerdict(j.truss.roles), undefined)
  assert.deepEqual(j.foremen, [])
  assert.deepEqual(j.refused, [])
  assert.deepEqual(j.stale, [])
  assert.deepEqual(j.unfinished, [])
  assert.equal(j.truss.crews.length, 1)
  const e = j.truss.crews[0]
  assert.deepEqual(Object.keys(e).sort(), ENTRY_KEYS)
  assert.equal(e.slug, 'x')
  assert.equal(e.stage, 1)
  assert.equal(norm(e.goalFile), norm(`${env.dir}/goals/x.md`))
  assert.equal(typeof e.goal, 'string')
  assert.deepEqual(e.owns, ['src/x/**', 'docs/x.md'])
  assert.equal(e.acceptanceTest, 'node --test t.ts')
  assert.ok(JSON.stringify(e.highImpact).includes('src/x/core.ts'), 'high-impact section read from the goal file')
  assert.ok(e.stressTest === true || /yes/i.test(String(e.stressTest)), `stressTest from the goal file: ${JSON.stringify(e.stressTest)}`)
  assert.ok(JSON.stringify(e.scope).includes('Build only the x thing.'), 'approved scope read from the goal file')
  assert.equal(norm(e.worktree), norm(wtPath(env, 'x')))
  assert.equal(e.branch, 'truss-x')
  assert.equal(e.base, git(wtPath(env, 'x'), ['merge-base', 'main', 'HEAD']))
  assert.equal(typeof e.architecture, 'string')
  assert.ok(Array.isArray(e.adrs))
  assert.equal(e.resume, null)
  assert.deepEqual(e.tasks, [])
  assert.deepEqual(e.done, [])
  assert.deepEqual(e.answers, [])
  assert.equal(e.spent, 0)
  assert.deepEqual(e.labelFrom, {})
})

test('start output passes the real workflowCallVerdict (after the crew is running) and workflowRoleVerdict', () => {
  const env = world([crew('x'), crew('y')])
  const j = assertOneLine(start(env))
  assert.equal(workflowRoleVerdict(j.truss.roles), undefined)
  const plan = parsePlan(readFileSync(`${env.dir}/plan.json`, 'utf8'))
  const planJs = readFileSync(`${env.plugin}/workflows/plan.js`, 'utf8')
  const stageJs = readFileSync(`${env.plugin}/workflows/stage.js`, 'utf8')
  const verdict = workflowCallVerdict(plan, { scriptPath: j.truss.scriptPath, args: j, pluginDir: env.plugin, pluginScriptTexts: [planJs, stageJs] })
  assert.equal(verdict, undefined)
})

test('start --scripts-dir copies stage.js byte for byte to <S>/truss-stage.js and points scriptPath at it', () => {
  const env = world([crew('x')])
  const scripts = tmp('fcli-scripts-')
  const j = assertOneLine(start(env, 'next', { 'scripts-dir': scripts }))
  assert.equal(flat(j.truss.scriptPath), `${scripts}/truss-stage.js`)
  assert.ok(readFileSync(`${scripts}/truss-stage.js`).equals(readFileSync(`${pluginCopy()}/workflows/stage.js`)))
  const plan = parsePlan(readFileSync(`${env.dir}/plan.json`, 'utf8'))
  const planJs = readFileSync(`${env.plugin}/workflows/plan.js`, 'utf8')
  const stageJs = readFileSync(`${env.plugin}/workflows/stage.js`, 'utf8')
  const scriptText = readFileSync(j.truss.scriptPath, 'utf8')
  assert.equal(workflowCallVerdict(plan, { scriptPath: j.truss.scriptPath, scriptText, args: j, pluginDir: env.plugin, pluginScriptTexts: [planJs, stageJs] }), undefined)
})

test('start --args-file P writes the whole output to P and prints a short pointer; a relative P is a usage error', () => {
  const env = world([crew('x'), crew('y')])
  const p = `${tmp('fcli-args-')}/sub/stage-args.json`
  const j = assertOneLine(start(env, 'next', { 'args-file': p }))
  assert.deepEqual(Object.keys(j), ['argsFile', 'scriptPath', 'crews', 'held', 'foremen', 'refused', 'stale', 'unfinished', 'warnings'])
  assert.deepEqual(j.held, [])
  assert.equal(j.argsFile, flat(p))
  assert.deepEqual(j.crews, ['x', 'y'])
  const text = readFileSync(p, 'utf8')
  assert.ok(text.endsWith('}\n') && !text.slice(0, -1).includes('\n'), 'one line, as stdout would be')
  const args = JSON.parse(text)
  assert.deepEqual(Object.keys(args).sort(), OUTPUT_KEYS)
  assert.equal(args.truss.scriptPath, j.scriptPath)
  assert.deepEqual(slugsOf(args.truss.crews), ['x', 'y'])
  const plan = parsePlan(readFileSync(`${env.dir}/plan.json`, 'utf8'))
  const texts = ['plan.js', 'stage.js'].map((n) => readFileSync(`${env.plugin}/workflows/${n}`, 'utf8'))
  assert.equal(workflowCallVerdict(plan, { scriptPath: args.truss.scriptPath, args, pluginDir: env.plugin, pluginScriptTexts: texts }), undefined)
  const rel = start(world([crew('z')]), 'next', { 'args-file': 'stage-args.json' })
  assert.equal(rel.status, 2, rel.stdout)
  assert.match(rel.json.error, /absolute/)
})

test('start is idempotent: a second run adds no spawn line and does not return the running crew again', () => {
  const env = world([crew('x')])
  assertOneLine(start(env))
  const planAfterFirst = readFileSync(`${env.dir}/plan.json`, 'utf8')
  const spawnsAfterFirst = readEvents(env.dir).filter((e) => e.event === 'spawn').length
  const second = start(env, 'next', { transcript: anchorRun(env).dir })
  const j = assertOneLine(second)
  assert.equal(second.status, 0, second.stderr)
  assert.deepEqual(j.truss.crews, [])
  assert.equal(readEvents(env.dir).filter((e) => e.event === 'spawn').length, spawnsAfterFirst)
  assert.equal(factorySpawns(env, 'x').length, 1)
  assert.equal(readFileSync(`${env.dir}/plan.json`, 'utf8'), planAfterFirst)
})

test('start: every line it appends validates against events.schema.json', () => {
  const env = world([crew('a'), crew('b'), crew('l')], { goals: { l: { engine: 'foreman commissioning member' } } })
  assertOneLine(start(env))
  const lines = readEvents(env.dir)
  assert.ok(lines.length >= 2)
  for (const ev of lines) assert.deepEqual(validateEvent(ev), [], JSON.stringify(ev))
})

// ---------------------------------------------------------------------------------------------------------------
// --resume answers

/** A stopped run for crew x: planners -10, -2 and plain (journal order puts -10 first), members t1 (DONE, merged), t2 (DONE, not merged),
 * t3 (CHECKPOINT, merged), t4 (DONE, branch missing). Returns {env, run, wt, plannerTasks}. */
function stoppedWorld() {
  const env = world([crew('x', { status: 'running' })], { plan: { approvedAt: iso(Date.now() - 3 * HOUR) } })
  const wt = makeRunning(env, 'x', iso(Date.now() - 5 * MIN))
  memberBranch(wt, 'truss-x', 'member-t1', true)
  memberBranch(wt, 'truss-x', 'member-t2', false)
  memberBranch(wt, 'truss-x', 'member-t3', true)
  const plannerTasks = [task('t1'), task('t2'), task('t3'), task('t4')]
  const member = (n: string, marker: string, branch: string) => ({ task: n, marker, branch, commit: 'c0ffee', proof: 'ran it', text: 'ok' })
  const run = deadRun(env, 'wf_stopped', [
    { label: 'x-planner-10', result: { tasks: plannerTasks, stop: null } },
    { label: 'x-planner', result: { tasks: [task('old')], stop: null } },
    { label: 'x-planner-2', result: { tasks: [task('older')], stop: null } },
    { label: 'x-tester', result: member('t1', 'DONE', 'member-t1') },
    { label: 'x-builder', result: member('t2', 'DONE', 'member-t2') },
    { label: 'x-builder-2', result: member('t3', 'CHECKPOINT', 'member-t3') },
    { label: 'x-writer', result: member('t4', 'DONE', 'member-gone') },
  ], { agoMs: 10 * MIN })
  return { env, run, wt, plannerTasks }
}

const answersFile = (answers: unknown): string => {
  const p = `${tmp('fcli-ans-')}/answers.json`
  writeFileSync(p, JSON.stringify(answers))
  return p
}

test('start --resume answers: refused when the crew is not running, or has no factory spawn line', () => {
  const planned = world([crew('x')])
  const run = anchorRun(planned)
  const f = answersFile([])
  const a = resume(planned, 'x', 'answers', { transcript: run.dir, answers: f })
  assert.equal(a.status, 1, `${a.stdout} ${a.stderr}`)
  assert.equal(typeof a.json, 'object', 'a refusal is one JSON line, not a crash')
  assert.equal(statusOf(planned, 'x'), 'planned')
  const noSpawn = world([crew('x', { status: 'running' })])
  addCrewWorktree(noSpawn.repo, 'x')
  const b = resume(noSpawn, 'x', 'answers', { transcript: anchorRun(noSpawn).dir, answers: f })
  assert.equal(b.status, 1, `${b.stdout} ${b.stderr}`)
  assert.equal(typeof b.json, 'object', 'a refusal is one JSON line, not a crash')
})

test('start --resume answers: tasks come from the highest-numbered planner result; done is decided by git ancestry and DONE', () => {
  const { env, run, plannerTasks } = stoppedWorld()
  const ans = [{ at: 't2', text: 'use the second option' }]
  const res = resume(env, 'x', 'answers', { transcript: run.dir, answers: answersFile(ans) })
  const j = assertOneLine(res)
  assert.equal(res.status, 0, `${res.stdout} ${res.stderr}`)
  assert.deepEqual(Object.keys(j).sort(), OUTPUT_KEYS)
  assert.equal(j.truss.crews.length, 1)
  const e = j.truss.crews[0]
  assert.deepEqual(Object.keys(e).sort(), ENTRY_KEYS)
  assert.equal(e.slug, 'x')
  assert.equal(e.resume, 'answers')
  assert.deepEqual(e.tasks, plannerTasks, 'planner-10 beats planner-2 numerically, not by journal order')
  const done = e.done.map((d: any) => (typeof d === 'string' ? d : d.name))
  assert.deepEqual(done, ['t1'], 't2 is DONE but unmerged, t3 merged but CHECKPOINT, t4 has no branch')
  assert.deepEqual(e.answers, ans)
  assert.equal(statusOf(env, 'x'), 'running')
  assert.equal(e.branch, 'truss-x')
  assert.equal(norm(e.worktree), norm(wtPath(env, 'x')))
})

test('start --resume answers: spent counts qc FAILs only (stress test reports never add) and labelFrom is the next free number per role', () => {
  const { env, run } = stoppedWorld()
  writeReport(env.dir, 'x', 'x-qc', qcReport({ verdict: 'FAIL' }))
  writeReport(env.dir, 'x', 'x-qc-2', qcReport({ verdict: 'FAIL' }))
  writeReport(env.dir, 'x', 'x-stress', 'STRESSTEST: 1 break\n')
  writeReport(env.dir, 'x', 'x-stress-2', 'STRESSTEST: 1 break\n')
  const j = assertOneLine(resume(env, 'x', 'answers', { transcript: run.dir, answers: answersFile([]) }))
  const e = j.truss.crews[0]
  assert.equal(e.spent, 2)
  assert.deepEqual(e.labelFrom, { qc: 3, stress: 3 })
  assert.deepEqual(e.answers, [])
})

test('start --resume answers: a PASS qc report does not count as spend', () => {
  const { env, run } = stoppedWorld()
  writeReport(env.dir, 'x', 'x-qc', qcReport({ verdict: 'FAIL' }))
  writeReport(env.dir, 'x', 'x-qc-2', qcReport({ verdict: 'PASS' }))
  const e = assertOneLine(resume(env, 'x', 'answers', { transcript: run.dir, answers: answersFile([]) })).truss.crews[0]
  assert.equal(e.spent, 1)
  assert.deepEqual(e.labelFrom, { qc: 3 })
})

test('start --resume answers: tasks and done combine every run of the crew next to T; a later re-split drops the older done', () => {
  const env = world([crew('x', { status: 'running' })], { plan: { approvedAt: iso(Date.now() - 3 * HOUR) } })
  const wt = makeRunning(env, 'x', iso(Date.now() - 5 * MIN))
  memberBranch(wt, 'truss-x', 'member-t1', true)
  memberBranch(wt, 'truss-x', 'member-t2', true)
  const member = (n: string, branch: string) => ({ task: n, marker: 'DONE', branch, commit: 'c0ffee', proof: 'ran it', text: 'ok' })
  const tasks = [task('t1'), task('t2'), task('t3')]
  // run 1 planned and merged t1; run 2 was a resume that took the saved tasks (no planner) and merged t2
  deadRun(env, 'wf_first', [{ label: 'x-planner', result: { tasks, stop: null } }, { label: 'x-builder', result: member('t1', 'member-t1') }], { agoMs: 30 * MIN })
  const second = deadRun(env, 'wf_second', [{ label: 'x-builder-2', result: member('t2', 'member-t2') }], { agoMs: 20 * MIN })
  const e = assertOneLine(resume(env, 'x', 'answers', { transcript: second.dir, answers: answersFile([]) })).truss.crews[0]
  assert.deepEqual(e.tasks, tasks, 'the plan comes from run 1: run 2 has no planner result')
  assert.deepEqual(e.done.map((d: any) => (typeof d === 'string' ? d : d.name)), ['t1', 't2'], 't1 was merged in run 1, t2 in run 2')
  // run 3 re-split (planner-2): only its own members count, so run 1's t1 never matches a task of the new plan by name
  const resplit = [task('t1'), task('t4')]
  const third = deadRun(env, 'wf_third', [{ label: 'x-planner-2', result: { tasks: resplit, stop: null } }], { agoMs: 10 * MIN })
  const r = assertOneLine(resume(env, 'x', 'answers', { transcript: third.dir, answers: answersFile([]) })).truss.crews[0]
  assert.deepEqual(r.tasks, resplit)
  assert.deepEqual(r.done, [])
})

// ---------------------------------------------------------------------------------------------------------------
// --resume merge-ready

test('start --resume merge-ready: one entry with resume "merge-ready"; base is the target head last merged in, and moves after a sync', () => {
  const env = world([crew('x', { status: 'running' })])
  const wt = makeRunning(env, 'x', iso(Date.now() - 5 * MIN))
  const startHead = head(env.repo)
  putFile(wt, 'src/x/mine.ts', 'mine\n', 'crew work')
  const a = assertOneLine(resume(env, 'x', 'merge-ready')).truss.crews[0]
  assert.equal(a.resume, 'merge-ready')
  assert.equal(a.slug, 'x')
  assert.equal(a.base, startHead, 'before any sync, the base is the target head at start')
  const moved = putFile(env.repo, 'other.txt', 'other crew\n', 'another crew merged')
  git(wt, ['merge', '-q', '--no-edit', 'main'])
  const b = assertOneLine(resume(env, 'x', 'merge-ready'))
  assert.equal(b.truss.crews.length, 1)
  assert.equal(b.truss.crews[0].base, moved, 'after the merge of the target, the base moves')
  assert.equal(b.truss.crews[0].base, git(wt, ['merge-base', 'main', 'HEAD']))
  assert.equal(b.truss.crews[0].resume, 'merge-ready')
})

// ---------------------------------------------------------------------------------------------------------------
// ADR-0016 Decision 1: `warnings` on a resume, and a missing goal file

/** A merge-ready resume of crew `slug` with the session start pinned by TRUSS_SESSION_START. The plugin copy's agents/stress-engineer.md was written when the copy was made (now). */
function resumeWithSession(env: any, slug: string, sessionStart: number) {
  return runCli(env.factory, 'start', ['--dir', env.dir, '--repo', env.repo, '--slug', slug, '--resume', 'merge-ready'], env.repo, { TRUSS_SESSION_START: String(sessionStart) })
}

test('pf resume: a resume of a stress-yes crew whose agent file is newer than the session start carries one warning naming it', () => {
  const env = world([crew('x', { status: 'running' })], { goals: { x: { stressTest: 'yes' } } })
  makeRunning(env, 'x', iso(Date.now() - 5 * MIN))
  const res = resumeWithSession(env, 'x', 1)
  const j = assertOneLine(res)
  assert.equal(res.status, 0, `${res.stdout} ${res.stderr}`)
  assert.ok(Array.isArray(j.warnings), `the resume output has warnings: ${res.stdout.slice(0, 300)}`)
  assert.equal(j.warnings.length, 1, JSON.stringify(j.warnings))
  assert.ok(String(j.warnings[0]).includes('x') && String(j.warnings[0]).includes('truss:stress-engineer'), String(j.warnings[0]))
  assert.equal(j.truss.crews.length, 1, 'a warning never holds the crew')
})

test('pf resume: a resume of a stress-no crew carries warnings: [] and a session that began after the agent file gives none', () => {
  const no = world([crew('x', { status: 'running' })])
  makeRunning(no, 'x', iso(Date.now() - 5 * MIN))
  const a = assertOneLine(resumeWithSession(no, 'x', 1))
  assert.deepEqual(a.warnings, [])
  const yes = world([crew('x', { status: 'running' })], { goals: { x: { stressTest: 'yes' } } })
  makeRunning(yes, 'x', iso(Date.now() - 5 * MIN))
  const b = assertOneLine(resumeWithSession(yes, 'x', Date.now() + 24 * HOUR))
  assert.deepEqual(b.warnings, [])
})

test('pf missing goal: a crew with no goal file is refused naming the path as missing, not routed to foremen, and stays planned', () => {
  const env = world([crew('has'), crew('gone')])
  rmSync(`${env.dir}/goals/gone.md`)
  const res = start(env)
  const j = assertOneLine(res)
  assert.equal(res.status, 0, res.stderr)
  const r = j.refused.find((x: any) => x.slug === 'gone')
  assert.ok(r, `gone is refused: ${res.stdout.slice(0, 400)}`)
  assert.ok(flat(String(r.reason)).includes(`${flat(env.dir)}/goals/gone.md`), String(r.reason))
  assert.match(String(r.reason), /missing/i)
  assert.ok(!/Engine/.test(String(r.reason)), 'not the old "no ## Engine section" reason')
  assert.deepEqual(slugsOf(j.foremen), [])
  assert.deepEqual(slugsOf(j.truss.crews), ['has'])
  assert.ok(!existsSync(wtPath(env, 'gone')), 'no worktree')
  assert.equal(statusOf(env, 'gone'), 'planned')
})

// ---------------------------------------------------------------------------------------------------------------
// stale rule and --resume stale

test('start stale: no run holds the crew\'s labels and everything is older than 30 minutes -> listed under stale with `since`; stage stays open', () => {
  const env = world([crew('x', { status: 'running' }), crew('later', { stage: 2 })])
  makeRunning(env, 'x')
  const t = anchorRun(env).dir
  const res = start(env, 'next', { transcript: t })
  const j = assertOneLine(res)
  assert.equal(res.status, 0, res.stderr)
  assert.equal(j.stale.length, 1)
  assert.equal(j.stale[0].slug, 'x')
  assert.equal(typeof j.stale[0].since, 'string')
  assert.ok(j.stale[0].since.length > 0)
  assert.deepEqual(j.unfinished, [])
  assert.deepEqual(j.truss.crews, [], 'start never restarts a stale crew itself')
  assert.equal(statusOf(env, 'later'), 'planned', 'stage 1 stays open')
  assert.equal(factorySpawns(env, 'x').length, 1)
  assert.deepEqual(assertOneLine(start(env, 'next', { transcript: t })).stale, j.stale, 'idempotent')
})

test('start --resume stale (no labelled run): appends a fresh factory spawn line, keeps worktree and branch, empty tasks and done', () => {
  const env = world([crew('x', { status: 'running' })])
  const wt = makeRunning(env, 'x')
  const oldTs = factorySpawns(env, 'x')[0].ts
  const branchHead = head(wt)
  const t = anchorRun(env).dir
  const res = resume(env, 'x', 'stale', { transcript: t })
  const j = assertOneLine(res)
  assert.equal(res.status, 0, `${res.stdout} ${res.stderr}`)
  assert.equal(j.truss.crews.length, 1)
  const e = j.truss.crews[0]
  assert.deepEqual(Object.keys(e).sort(), ENTRY_KEYS)
  assert.equal(e.resume, 'stale')
  assert.deepEqual(e.tasks, [])
  assert.deepEqual(e.done, [])
  assert.equal(head(wt), branchHead)
  assert.equal(statusOf(env, 'x'), 'running')
  const spawns = factorySpawns(env, 'x')
  assert.equal(spawns.length, 2)
  assert.ok(Date.parse(spawns[1].ts) > Date.parse(oldTs) + HOUR, 'the fresh line carries a new ts')
  assert.deepEqual(validateEvent(spawns[1]), [])
  // the restart reset the clock: the crew is no longer stale
  const after = assertOneLine(start(env, 'next', { transcript: t }))
  assert.deepEqual(after.stale, [])
})

test('start --resume stale: a dead run recorded with `incomplete` -> tasks and done rebuilt from git, commits survive, spent and labelFrom count the dead run', () => {
  const env = world([crew('x', { status: 'running' })], { plan: { approvedAt: iso(Date.now() - 4 * HOUR) } })
  const wt = makeRunning(env, 'x')
  memberBranch(wt, 'truss-x', 'member-t1', true)
  memberBranch(wt, 'truss-x', 'member-t2', false)
  const kept = head(wt)
  const tasks = [task('t1'), task('t2')]
  const member = (n: string, branch: string) => ({ task: n, marker: 'DONE', branch, commit: 'c0ffee', proof: 'ran', text: 'ok' })
  const run = deadRun(env, 'wf_dead', [
    { label: 'x-planner', result: { tasks, stop: null } },
    { label: 'x-tester', result: member('t1', 'member-t1') },
    { label: 'x-builder', result: member('t2', 'member-t2') },
    { label: 'x-qc', result: 'VERDICT: FAIL\n' },
  ])
  record(env, 'wf_dead', run, 'x', { incomplete: true })
  writeReport(env.dir, 'x', 'x-qc', qcReport({ verdict: 'FAIL' }), Date.now() - 100 * MIN)
  const res = resume(env, 'x', 'stale', { transcript: run.dir })
  const j = assertOneLine(res)
  assert.equal(res.status, 0, `${res.stdout} ${res.stderr}`)
  const e = j.truss.crews[0]
  assert.equal(e.resume, 'stale')
  assert.deepEqual(e.tasks, tasks)
  assert.deepEqual(e.done.map((d: any) => (typeof d === 'string' ? d : d.name)), ['t1'])
  assert.equal(e.spent, 1, 'the dead run\'s qc FAIL is counted')
  assert.equal(e.labelFrom.qc, 2, 'the dead run\'s qc label is skipped')
  assert.equal(head(wt), kept, 'the crew branch keeps its commits')
  assert.ok(existsSync(`${wt}/members/member-t1.txt`))
  assert.equal(git(env.repo, ['branch', '--list', 'member-t2']).replace(/^[*+]?\s*/, ''), 'member-t2', 'unmerged member branches are left alone')
  assert.equal(factorySpawns(env, 'x').length, 2)
})

test('start --resume stale: refuses with why "not stale" when rule 1 fails (running but no factory spawn line)', () => {
  const env = world([crew('x', { status: 'running' })])
  addCrewWorktree(env.repo, 'x')
  const res = resume(env, 'x', 'stale', { transcript: anchorRun(env).dir })
  assert.equal(res.status, 1, `${res.stdout} ${res.stderr}`)
  assert.equal(res.json?.why, 'not stale')
  assert.equal(factorySpawns(env, 'x').length, 0)
})

test('start --resume stale: refuses with why "not stale" when the crew is planned', () => {
  const env = world([crew('x')])
  const res = resume(env, 'x', 'stale', { transcript: anchorRun(env).dir })
  assert.equal(res.status, 1)
  assert.equal(res.json?.why, 'not stale')
  assert.equal(statusOf(env, 'x'), 'planned')
})

test('start --resume stale: a newest run recorded WITHOUT an incomplete line is not stale (why "not stale"), and not listed under stale', () => {
  const env = world([crew('x', { status: 'running' })])
  makeRunning(env, 'x')
  const run = deadRun(env, 'wf_done', [{ label: 'x-planner', result: { tasks: [task('t1')], stop: null } }])
  record(env, 'wf_done', run, 'x', { incomplete: false })
  const res = resume(env, 'x', 'stale', { transcript: run.dir })
  assert.equal(res.status, 1, `${res.stdout} ${res.stderr}`)
  assert.equal(res.json?.why, 'not stale')
  const j = assertOneLine(start(env, 'next', { transcript: run.dir }))
  assert.deepEqual(j.stale, [])
  assert.deepEqual(j.unfinished, [])
  assert.equal(factorySpawns(env, 'x').length, 1)
})

test('start unfinished: the newest run holding the crew\'s labels is unrecorded -> listed under unfinished, and --resume stale refuses "run not finished"', () => {
  const env = world([crew('x', { status: 'running' })])
  makeRunning(env, 'x')
  const run = deadRun(env, 'wf_lost', [{ label: 'x-planner', result: { tasks: [task('t1')], stop: null } }])
  const j = assertOneLine(start(env, 'next', { transcript: run.dir }))
  assert.deepEqual(j.unfinished, [{ slug: 'x', run: 'wf_lost' }])
  assert.deepEqual(j.stale, [])
  assert.deepEqual(j.truss.crews, [])
  const res = resume(env, 'x', 'stale', { transcript: run.dir })
  assert.equal(res.status, 1, `${res.stdout} ${res.stderr}`)
  assert.equal(res.json?.why, 'run not finished')
  assert.equal(factorySpawns(env, 'x').length, 1, 'refusal appends nothing')
})

test('start unfinished: only the NEWEST run counts; an older recorded-incomplete run does not make a newer unrecorded one stale', () => {
  const env = world([crew('x', { status: 'running' })])
  makeRunning(env, 'x', iso(Date.now() - 5 * HOUR))
  const older = deadRun(env, 'wf_old', [{ label: 'x-planner' }], { agoMs: 3 * HOUR })
  record(env, 'wf_old', older, 'x', { incomplete: true })
  const newer = deadRun(env, 'wf_new', [{ label: 'x-planner-2' }], { agoMs: 40 * MIN })
  const j = assertOneLine(start(env, 'next', { transcript: newer.dir }))
  assert.deepEqual(j.unfinished, [{ slug: 'x', run: 'wf_new' }])
  assert.deepEqual(j.stale, [])
  assert.equal(resume(env, 'x', 'stale', { transcript: newer.dir }).json?.why, 'run not finished')
})

test('start --resume stale: a recent agent transcript write (journal old) means "run may be live"', () => {
  const env = world([crew('x', { status: 'running' })])
  makeRunning(env, 'x')
  const run = deadRun(env, 'wf_live', [{ label: 'x-planner' }, { label: 'x-tester', mtimeMs: Date.now() - 2 * MIN }])
  record(env, 'wf_live', run, 'x', { incomplete: true })
  const res = resume(env, 'x', 'stale', { transcript: run.dir })
  assert.equal(res.status, 1, `${res.stdout} ${res.stderr}`)
  assert.equal(res.json?.why, 'run may be live')
  assert.equal(factorySpawns(env, 'x').length, 1)
  const j = assertOneLine(start(env, 'next', { transcript: run.dir }))
  assert.deepEqual(j.stale, [], 'a live run is not stale')
})

test('start --resume stale: a recent journal write, or a spawn line younger than 30 minutes, also means "run may be live"', () => {
  const a = world([crew('x', { status: 'running' })])
  makeRunning(a, 'x')
  const runA = deadRun(a, 'wf_j', [{ label: 'x-planner' }], { journalMtimeMs: Date.now() - 5 * MIN })
  record(a, 'wf_j', runA, 'x', { incomplete: true })
  assert.equal(resume(a, 'x', 'stale', { transcript: runA.dir }).json?.why, 'run may be live')
  const b = world([crew('x', { status: 'running' })])
  makeRunning(b, 'x', iso(Date.now() - 10 * MIN))
  const runB = deadRun(b, 'wf_s', [{ label: 'x-planner' }])
  record(b, 'wf_s', runB, 'x', { incomplete: true })
  const res = resume(b, 'x', 'stale', { transcript: runB.dir })
  assert.equal(res.status, 1)
  assert.equal(res.json?.why, 'run may be live')
})

test('start stale boundary: all signals just under 30 minutes old are live, just over are stale', () => {
  const young = world([crew('x', { status: 'running' })])
  makeRunning(young, 'x', iso(Date.now() - 29 * MIN))
  const ry = deadRun(young, 'wf_y', [{ label: 'x-planner' }], { agoMs: 29 * MIN })
  record(young, 'wf_y', ry, 'x', { incomplete: true })
  assert.equal(resume(young, 'x', 'stale', { transcript: ry.dir }).json?.why, 'run may be live')
  const old = world([crew('x', { status: 'running' })])
  makeRunning(old, 'x', iso(Date.now() - 31 * MIN))
  const ro = deadRun(old, 'wf_o', [{ label: 'x-planner' }], { agoMs: 31 * MIN })
  record(old, 'wf_o', ro, 'x', { incomplete: true })
  const res = resume(old, 'x', 'stale', { transcript: ro.dir })
  assert.equal(res.status, 0, `${res.stdout} ${res.stderr}`)
  assert.equal(assertOneLine(res).truss.crews[0].resume, 'stale')
})

test('start --resume stale: a dead run\'s labels (x-test crew vs x crew) are parsed exactly: x-test-tester does not belong to crew x', () => {
  const env = world([crew('x', { status: 'running' }), crew('x-test', { status: 'running' })])
  makeRunning(env, 'x')
  makeRunning(env, 'x-test')
  // a run that holds only crew x-test's labels: crew x has no labelled run and is stale; x-test's run is unrecorded
  const run = deadRun(env, 'wf_xt', [{ label: 'x-test-tester' }, { label: 'x-test-writer' }])
  const j = assertOneLine(start(env, 'next', { transcript: run.dir }))
  assert.deepEqual(j.unfinished, [{ slug: 'x-test', run: 'wf_xt' }])
  assert.deepEqual(slugsOf(j.stale), ['x'])
})

test('e2e: finish --transcript T (no --result) on a dead run records it incomplete, then start --resume stale restarts the crew', () => {
  const env = world([crew('x', { status: 'running' })], { plan: { approvedAt: iso(Date.now() - 4 * HOUR) } })
  const wt = makeRunning(env, 'x')
  const run = deadRun(env, 'wf_e2e', [
    { label: 'x-planner', agentType: 'truss:planning-engineer', metaModel: 'opus', effort: 'medium', result: { tasks: [task('t1')], stop: null } },
    { label: 'x-qc', agentType: 'truss:qc-engineer', metaModel: 'opus', effort: 'medium', result: 'VERDICT: FAIL\n\n## Findings\n- bad\n' },
  ])
  // before finish: the run is unfinished
  const before = assertOneLine(start(env, 'next', { transcript: run.dir }))
  assert.deepEqual(before.unfinished, [{ slug: 'x', run: 'wf_e2e' }])
  const fin = env.run('finish', { transcript: run.dir })
  assert.equal(fin.status, 0, `finish: ${fin.stdout} ${fin.stderr}`)
  assert.ok(readEvents(env.dir).some((e) => e.event === 'incomplete' && e.crew === 'x' && e.run === 'wf_e2e'), 'finish recorded an incomplete line')
  assert.ok(readEvents(env.dir).some((e) => e.event === 'spawn' && e.by === 'workflow:wf_e2e'))
  const kept = head(wt)
  const listed = assertOneLine(start(env, 'next', { transcript: run.dir }))
  assert.deepEqual(slugsOf(listed.stale), ['x'])
  assert.deepEqual(listed.unfinished, [])
  const res = resume(env, 'x', 'stale', { transcript: run.dir })
  const j = assertOneLine(res)
  assert.equal(res.status, 0, `${res.stdout} ${res.stderr}`)
  const e = j.truss.crews[0]
  assert.equal(e.resume, 'stale')
  assert.equal(e.spent, 1, 'the dead run\'s qc FAIL (filed by finish) counts')
  assert.equal(e.labelFrom.qc, 2)
  assert.equal(e.labelFrom.planner, 2)
  assert.equal(head(wt), kept)
  assert.equal(factorySpawns(env, 'x').length, 2)
  assertEventsValid(env)
})

// @ts-nocheck
// ADR-0052 (run-survival, R-135 and R-141): a run outlives the PM session that started it. Acceptance test for crew
// run-survival, written red before the build. Design default (plan.md, decided by program manager): a new PM session
// finds an unfinished run by scanning `<git common dir>/truss/*/plan.json`; there is no new pointer file; resume starts
// no merged crew; the trussFile gate accepts a file under any truss dir of the same repo's git common dir and still
// refuses everything else.
//
// The contract the builders build to:
//
// find-run: `node bin/factory.ts find-run --repo R` prints one JSON object `{runs: [...]}` and exits 0. It reads each
//   `<git common dir of R>/truss/<name>/plan.json` one level deep. A run is listed when its plan parses as a plan, its
//   `approvedAt` is not null, and at least one crew's status is neither `merged` nor `dropped`. A dir with no plan.json
//   or a broken one is skipped, never an error. Each run is `{dir, session, approvedAt, transcript, crews}`: `dir` is
//   the absolute slashed truss dir, `session` its last segment, `transcript` the main transcript path from
//   `transcriptsOf(session)` or null. `crews` lists only the unfinished crews as `{slug, status, stage, results}`,
//   where `results` is the sorted list of absolute slashed paths of the files directly under `<dir>/reports/<slug>/`
//   and `<dir>/crews/<slug>/`. Runs are sorted newest `approvedAt` first. No runs gives `{runs: []}`.
//
// resume: a new session resumes a found run with `factory.ts start --repo R --dir <found dir> --stage next`. A start
//   record is an `events.jsonl` line with `event: 'spawn'`, `type: 'workflow-crew'`, `by: 'factory'`, `crew: <slug>`.
//   A merged or dropped crew gets no start record and no `truss-<slug>` worktree. Two such processes run at the same
//   moment each exit 0, and each planned crew of the next stage gets exactly one start record across both, with status
//   `running` in plan.json.
//
// gate: the Workflow handler registered by `register()` in hooks/register.ts, for session `s2` with a second session
//   dir `s1` under the same `<common>/truss/`, expands a plugin stage.js call whose `args.trussFile` is under
//   `<common>/truss/s1/` (its `.truss` becomes `args.truss`, passed to next). It refuses (`[truss] Refused:`, next
//   never called) a trussFile outside every `<common>/truss/<session>/` dir: a sibling dir of the common dir, a `..`
//   path that climbs out of `<common>/truss/s1/`, and a symlinked sub-directory of s1 that leads outside.
//
// skill: skills/run/SKILL.md contains `find-run`; its first occurrence comes before the heading
//   `## 4. Have the design engineer draft the plan`; and the 40 lines starting at that first occurrence contain both
//   `--dir` and `--stage next`.
//
// Case 5 opens with a positive control (s1's file is let through) because the refusals alone already hold on the
// base code; without the control it would be a green regression guard, not a red test.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { crew, flat, mkRepo, planObj, readEvents, readPlan, REAL_FACTORY, runCli, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

const HOUR = 3_600_000
const iso = (ms: number): string => new Date(ms).toISOString()
const say = (r: any): string => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 700)}; stderr ${String(r.stderr).slice(0, 300)}`
const CFG = { merge: 'sequential', target: 'main' }

/** A session dir `<repo>/.git/truss/<name>` holding `plan` (when not null) and a goal file per crew. */
function session(repo: string, name: string, plan: unknown): string {
  const dir = `${repo}/.git/truss/${name}`
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/decisions.md`, '')
  writeFileSync(`${dir}/events.jsonl`, '')
  if (plan !== null) {
    writePlan(dir, plan)
    for (const c of (plan as any).crews) writeGoal(dir, String(c.slug), {})
  }
  return dir
}
const emptyRoot = (): string => flat(realpathSync(mkdtempSync(join(tmpdir(), 'rs032-tr-'))))
const startRecords = (dir: string, slug: string): any[] =>
  readEvents(dir).filter((e) => e.event === 'spawn' && e.type === 'workflow-crew' && e.by === 'factory' && e.crew === slug)
const findRun = (repo: string, root: string) => runCli(REAL_FACTORY, 'find-run', ['--repo', repo], repo, { TRUSS_TRANSCRIPTS_ROOT: root })
const startArgs = (repo: string, dir: string): string[] => ['--repo', repo, '--dir', dir, '--stage', 'next']
const cleanup = (...ds: string[]) => {
  for (const d of ds) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
}

// ---------------------------------------------------------------------------------------------------------------

test('a new PM session finds the run whose PM session ended, its unfinished crews and their saved results', () => {
  const root = emptyRoot()
  const repo = mkRepo({ config: CFG })
  try {
    const old = session(repo, 's-old', planObj([crew('m', { stage: 1, status: 'merged' }), crew('r', { stage: 2, status: 'running' }), crew('p', { stage: 2, status: 'planned' })], { approvedAt: iso(Date.now() - 3 * HOUR) }))
    mkdirSync(`${old}/reports/r`, { recursive: true })
    mkdirSync(`${old}/crews/r`, { recursive: true })
    writeFileSync(`${old}/reports/r/qc.md`, 'qc\n')
    writeFileSync(`${old}/reports/r/a.md`, 'a\n')
    writeFileSync(`${old}/crews/r/answers.json`, '[]\n')
    mkdirSync(`${old}/reports/m`, { recursive: true })
    writeFileSync(`${old}/reports/m/done.md`, 'merged crew result\n')
    const newer = session(repo, 's-newer', planObj([crew('q', { status: 'planned' })], { approvedAt: iso(Date.now() - HOUR) }))
    session(repo, 's-done', planObj([crew('d', { status: 'merged' }), crew('e', { status: 'dropped' })], { approvedAt: iso(Date.now() - 5 * HOUR) }))
    session(repo, 's-unapproved', planObj([crew('u', { status: 'planned' })], { approvedAt: null }))
    session(repo, 's-noplan', null)
    const broken = session(repo, 's-broken', null)
    writeFileSync(`${broken}/plan.json`, '{ not json')
    session(repo, 's-fresh', null) // the new PM session's own dir: no plan yet
    mkdirSync(`${root}/proj`, { recursive: true })
    writeFileSync(`${root}/proj/s-old.jsonl`, '{}\n')

    const r = findRun(repo, root)
    assert.equal(r.status, 0, say(r))
    assert.ok(Array.isArray(r.json?.runs), `find-run prints {runs: [...]}; ${say(r)}`)
    assert.deepEqual(r.json.runs.map((x: any) => x.session), ['s-newer', 's-old'], `newest approvedAt first, finished and unapproved runs left out; ${say(r)}`)
    const [a, b] = r.json.runs
    assert.equal(a.dir, flat(newer))
    assert.equal(a.transcript, null)
    assert.equal(b.dir, flat(old))
    assert.equal(b.approvedAt, readPlan(old).approvedAt)
    assert.equal(b.transcript, `${root}/proj/s-old.jsonl`)
    assert.deepEqual(b.crews.map((c: any) => c.slug).sort(), ['p', 'r'], 'the merged crew is absent')
    const run = b.crews.find((c: any) => c.slug === 'r')
    assert.equal(run.status, 'running')
    assert.equal(run.stage, 2)
    assert.deepEqual(run.results, [`${flat(old)}/crews/r/answers.json`, `${flat(old)}/reports/r/a.md`, `${flat(old)}/reports/r/qc.md`].sort())
    assert.deepEqual(b.crews.find((c: any) => c.slug === 'p').results, [])
  } finally {
    cleanup(root, repo)
  }
})

test('resuming that run starts no crew that already merged', () => {
  const root = emptyRoot()
  const repo = mkRepo({ config: CFG })
  try {
    const old = session(repo, 's-old', planObj([crew('m', { stage: 1, status: 'merged' }), crew('p', { stage: 2, status: 'planned' }), crew('later', { stage: 3, status: 'planned' })], { approvedAt: iso(Date.now() - 3 * HOUR) }))
    // a new session finds the run first, then resumes the dir it was told about
    const found = findRun(repo, root)
    assert.equal(found.status, 0, say(found))
    const run = (found.json?.runs ?? []).find((x: any) => x.session === 's-old')
    assert.ok(run, `find-run lists s-old; ${say(found)}`)
    const r = runCli(REAL_FACTORY, 'start', startArgs(repo, run.dir), repo, { TRUSS_TRANSCRIPTS_ROOT: root })
    assert.equal(r.status, 0, say(r))
    assert.equal(startRecords(old, 'p').length, 1, 'the planned crew of the next stage starts once')
    assert.equal(startRecords(old, 'm').length, 0, 'the merged crew gets no start record')
    assert.equal(startRecords(old, 'later').length, 0, 'a crew of a later stage is not started')
    assert.ok(!existsSync(`${repo}/.claude/worktrees/truss-m`), 'the merged crew gets no worktree')
    assert.ok(existsSync(`${repo}/.claude/worktrees/truss-p`), 'the started crew has its worktree')
    const plan = readPlan(old)
    assert.equal(plan.crews.find((c: any) => c.slug === 'm').status, 'merged')
    assert.equal(plan.crews.find((c: any) => c.slug === 'p').status, 'running')
  } finally {
    cleanup(root, repo)
  }
})

test('two real processes that resume the same run at once start each unfinished crew exactly once', { timeout: 240_000 }, async () => {
  const root = emptyRoot()
  const slugs = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v
  for (const k of ['TRUSS_SAMPLE', 'TRUSS_MIN_FREE_MB', 'TRUSS_SESSION_START', 'CLAUDE_PID', 'CLAUDE_CODE_SESSION_ID']) delete base[k]
  // the same high free-memory sample runCli points TRUSS_SAMPLE at, so admission never reads this host
  const sample = `${root}/high.json`
  writeFileSync(sample, JSON.stringify({ freeMB: 64000, totalMB: 64000 }))
  const env = { ...base, TRUSS_SAMPLE: sample, TRUSS_TRANSCRIPTS_ROOT: root }
  const child = (repo: string, dir: string) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const p = spawn(process.execPath, [REAL_FACTORY, 'start', ...startArgs(repo, dir)], { cwd: repo, env, windowsHide: true })
      let stdout = ''
      let stderr = ''
      p.stdout.on('data', (d) => (stdout += d))
      p.stderr.on('data', (d) => (stderr += d))
      p.on('error', reject)
      p.on('close', (status) => resolve({ status, stdout, stderr }))
    })
  const repos: string[] = []
  try {
    for (let round = 1; round <= 3; round++) {
      const repo = mkRepo({ config: CFG })
      repos.push(repo)
      const dir = session(repo, 's-old', planObj([crew('m', { stage: 1, status: 'merged' }), ...slugs.map((s) => crew(s, { stage: 2 }))], { approvedAt: iso(Date.now() - 3 * HOUR), maxParallelCrews: 8 }))
      const [x, y] = await Promise.all([child(repo, dir), child(repo, dir)])
      assert.equal(x.status, 0, `round ${round}, process 1: ${say(x)}`)
      assert.equal(y.status, 0, `round ${round}, process 2: ${say(y)}`)
      const seen: Record<string, number> = {}
      for (const out of [x, y]) {
        const line = out.stdout.split('\n').filter(Boolean)
        const entries = line.length === 1 ? (JSON.parse(line[0]).truss?.crews ?? []) : []
        for (const e of entries) seen[e.slug] = (seen[e.slug] ?? 0) + 1
      }
      const plan = readPlan(dir)
      for (const s of slugs) {
        assert.equal(startRecords(dir, s).length, 1, `round ${round}: crew ${s} has ${startRecords(dir, s).length} start records, wanted 1`)
        assert.equal(plan.crews.find((c: any) => c.slug === s).status, 'running', `round ${round}: crew ${s} is running in plan.json`)
        assert.equal(seen[s], 1, `round ${round}: crew ${s} is in the stage args of ${seen[s] ?? 0} processes, wanted 1`)
      }
      assert.equal(startRecords(dir, 'm').length, 0, 'the merged crew is never started')
    }
  } finally {
    cleanup(root, ...repos)
  }
})

// ---------------------------------------------------------------------------------------------------------------
// the trussFile gate, driven through register() as gate-trussfile.check.ts drives it, for session s2 with a sibling s1

const REAL_STAGE = fileURLToPath(new URL('../workflows/stage.js', import.meta.url))
const ROLE = { agentType: 'general-purpose', model: 'sonnet', effort: 'low', isolation: 'none' }
const ROLES = Object.fromEntries(['designer', 'checker', 'planner', 'tester', 'builder', 'resolver', 'writer', 'rca', 'stress', 'qc', 'runner'].map((k) => [k, ROLE]))
const stageTruss = () => ({ kind: 'stage', roles: ROLES, crews: [{ slug: 'a' }] })
const runningPlan = () => ({ version: 2, goal: 'g', approval: 'auto', approvedAt: '2026-10-29T00:00:00Z', maxParallelCrews: 4, reworkAllowance: 2, crews: [{ slug: 'a', stage: 1, status: 'running', verdict: 'extend' }] })

async function drive(fn: (h: { call: (e: Record<string, unknown>) => Promise<any>; s1: string; outside: string; common: string; nexts: any[] }) => Promise<void>) {
  const mod = await import('../hooks/register.ts')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rs032-gate-')))
  try {
    const common = join(root, 'git')
    const outside = join(root, 'outside')
    mkdirSync(outside)
    const s1 = mod.trussDir(common, undefined, 's1')
    const s2 = mod.trussDir(common, undefined, 's2')
    mkdirSync(s1, { recursive: true })
    mkdirSync(s2, { recursive: true })
    writeFileSync(mod.planPath(s2), JSON.stringify(runningPlan()))
    const $: any = {
      process: { run: async () => ({ exitCode: 0, stdout: `${common}\n`, stderr: '' }) },
      session: { cwd: async () => root, id: async () => 's2' },
      env: { get: async () => undefined },
      clock: { after: () => ({ cancel() {} }) },
      ui: { log: () => {} },
      fs: {
        exists: async (p: string) => existsSync(p),
        read: async (p: string) => readFileSync(p, 'utf8'),
        stat: async (p: string) => ({ realPath: realpathSync(p) }),
        write: async () => {},
      },
      state: { get: async () => ({ value: undefined, version: 0 }), set: async () => ({ isSet: true, version: 1 }) },
    }
    let handler: any
    const on: any = (...a: any[]) => {
      if (a[1] && typeof a[1] === 'object' && a[1].tool === 'Workflow') handler = a[a.length - 1]
      const chain: any = { catch: () => chain }
      return chain
    }
    mod.register(on)
    assert.ok(handler, 'the Workflow handler was not registered')
    const nexts: any[] = []
    const next = async (ev: any) => {
      nexts.push(ev)
      return { passed: ev }
    }
    const call = (e: Record<string, unknown>) => handler($, { tool: 'Workflow', scriptPath: REAL_STAGE, ...e }, next)
    await fn({ call, s1, outside, common, nexts })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }
}
const denied = (r: any) => {
  assert.ok(r && typeof r.deny === 'string', `expected {deny}, got ${JSON.stringify(r)}`)
  assert.ok(r.deny.startsWith('[truss] Refused:'), r.deny)
}

test("the trussFile gate lets through a trussFile under another session's truss dir of the same repo", async () => {
  await drive(async ({ call, s1, nexts }) => {
    const file = join(s1, 'stage-args.json')
    writeFileSync(file, JSON.stringify({ truss: stageTruss() }))
    const r = await call({ args: { trussFile: file, other: 1 } })
    assert.equal(r.deny, undefined, r.deny)
    assert.equal(nexts.length, 1)
    assert.deepEqual(nexts[0].args, { other: 1, truss: stageTruss() })
    assert.equal(nexts[0].scriptPath, REAL_STAGE)
  })
})

test("the trussFile gate still refuses a trussFile outside the repo's truss dirs", async () => {
  await drive(async ({ call, s1, outside, nexts }) => {
    const body = JSON.stringify({ truss: stageTruss() })
    // positive control: the widened gate lets s1's own file through (red on the base code, where only s2's dir is allowed)
    writeFileSync(join(s1, 'ok.json'), body)
    const ok = await call({ args: { trussFile: join(s1, 'ok.json') } })
    assert.equal(ok.deny, undefined, `s1's file is let through: ${ok.deny}`)
    assert.equal(nexts.length, 1)
    nexts.length = 0
    // a sibling dir of the git common dir
    writeFileSync(join(outside, 'a.json'), body)
    denied(await call({ args: { trussFile: join(outside, 'a.json') } }))
    // a .. path that climbs out of s1: <root>/git/truss/s1/../../../outside/a.json
    denied(await call({ args: { trussFile: `${s1}/../../../outside/a.json` } }))
    // a symlinked sub-directory of s1 that leads outside ('junction' needs no privilege on Windows)
    let linked = true
    try {
      symlinkSync(outside, join(s1, 'sub'), 'junction')
    } catch {
      linked = false
    }
    if (linked) denied(await call({ args: { trussFile: join(s1, 'sub', 'a.json') } }))
    assert.equal(nexts.length, 0, 'next was called for a refused trussFile')
  })
})

// ---------------------------------------------------------------------------------------------------------------

test('the run skill tells a new PM session to find and resume an unfinished run before it starts a new one', () => {
  const text = readFileSync(new URL('../skills/run/SKILL.md', import.meta.url), 'utf8')
  const lines = text.split('\n')
  const at = lines.findIndex((l) => l.includes('find-run'))
  assert.ok(at >= 0, 'SKILL.md never names find-run')
  const design = lines.findIndex((l) => l.startsWith('## 4. Have the design engineer draft the plan'))
  assert.ok(design >= 0, 'the heading "## 4. Have the design engineer draft the plan" is missing')
  assert.ok(at < design, `find-run first appears at line ${at + 1}, after the design step at line ${design + 1}`)
  const near = lines.slice(at, at + 40).join('\n')
  assert.ok(near.includes('--dir'), 'the 40 lines from find-run do not name --dir')
  assert.ok(near.includes('--stage next'), 'the 40 lines from find-run do not name --stage next')
})

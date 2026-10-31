// @ts-nocheck
// truss ADR-0015 (resource-aware), Decisions 2 to 4: the behaviour tests/factory-resources-contract.check.ts does not
// pin, through the real CLI (bin/factory.ts of this checkout). Red until bin/factory.ts has admit, heavy and reap.
//
// Run with: node --test tests/factory-resources.check.ts
// Every run uses mkdtemp dirs (a repo, a truss dir, a scratch dir); the live truss dir is never touched. TRUSS_SAMPLE
// and TRUSS_MIN_FREE_MB are set per child and any inherited value is removed. Only processes this file started are signalled.

import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { crew, mkRepo, mkTrussDir, planObj, readEvents, readPlan, tmp, validateEvent, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const FACTORY = `${REPO_ROOT}/bin/factory.ts`
const NODE = process.execPath

function env(sample?: string, min?: number): Record<string, string> {
  const e: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) e[k] = v
  delete e.TRUSS_SAMPLE
  delete e.TRUSS_MIN_FREE_MB
  if (sample !== undefined) e.TRUSS_SAMPLE = sample
  if (min !== undefined) e.TRUSS_MIN_FREE_MB = String(min)
  return e
}

function parseOut(stdout: string): any {
  const lines = stdout.split('\n').filter((l) => l.length > 0)
  if (lines.length !== 1) return undefined
  try {
    return JSON.parse(lines[0])
  } catch {
    return undefined
  }
}

type Res = { status: number | null; json: any; stdout: string; stderr: string }
type World = { repo: string; dir: string; scratch: string; ok: string; run(args: string[], o?: { sample?: string; min?: number }): Res }

function world(crews: any[], planOver: Record<string, unknown> = {}): World {
  const repo = mkRepo()
  const dir = mkTrussDir()
  const scratch = tmp('fres2-scratch-')
  writePlan(dir, planObj(crews, planOver))
  for (const c of crews) writeGoal(dir, c.slug)
  const ok = `${scratch}/ok.json`
  writeFileSync(ok, JSON.stringify({ freeMB: 9000, totalMB: 16000 }))
  return {
    repo, dir, scratch, ok,
    run(args, o = {}) {
      const r = spawnSync(NODE, [FACTORY, ...args], { cwd: repo, encoding: 'utf8', timeout: 60_000, env: env(o.sample ?? ok, o.min ?? 1000) })
      const stdout = r.stdout ?? ''
      return { status: r.status, json: parseOut(stdout), stdout, stderr: r.stderr ?? '' }
    },
  }
}

const say = (r: Res): string => `exit ${r.status}; stdout ${r.stdout.slice(0, 300)}; stderr ${r.stderr.slice(0, 300)}`
const fl = (w: World, slug: string): string[] => ['--dir', w.dir, '--repo', w.repo, '--slug', slug]
const heavyArgs = (w: World, slug: string, label: string, cmd: string[]): string[] => ['heavy', ...fl(w, slug), '--label', label, '--cwd', w.repo, '--', ...cmd]

function heavy(w: World, slug: string, label: string, cmd: string[], o = {}): Res {
  const r = w.run(heavyArgs(w, slug, label, cmd), o)
  if (typeof r.json?.heavy !== 'object' || r.json.heavy === null) assert.fail(`producer missing: factory heavy (${say(r)})`)
  return r
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    if (stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z') return false
  } catch {}
  return true
}

function waitFor(fn: () => boolean, ms = 6000): boolean {
  const end = Date.now() + ms
  for (;;) {
    if (fn()) return true
    if (Date.now() >= end) return false
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
  }
}

/** A pid that is not running: a short child that has exited and been reaped. */
function deadPid(): number {
  const r = spawnSync(NODE, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  return Number(r.stdout)
}

const ONE_JSON = `console.log(JSON.stringify({ ok: true }))`
const planned = (s: string) => crew(s, { status: 'planned' })

// ---------- heavy: argument split ----------

test('factory heavy splits argv at the first -- so command args that start with -- reach the command', () => {
  const w = world([planned('q')])
  const js = `console.log(JSON.stringify({ ok: true, argv: process.argv.slice(1) }))`
  const r = heavy(w, 'q', 'split', [NODE, '-e', js, '--dir', 'not-a-flag', '--', '--label', 'x'])
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(r.json.argv, ['--dir', 'not-a-flag', '--', '--label', 'x'], 'everything after the first -- is passed unchanged')
  assert.equal(r.json.heavy.label, 'split', 'flags before the -- are the heavy flags')
})

// ---------- heavy: stale locks ----------

test('factory heavy takes over a lock whose owner pid is dead', () => {
  const w = world([planned('q')])
  const lock = `${w.dir}/resources/heavy.lock`
  mkdirSync(lock, { recursive: true })
  writeFileSync(`${lock}/owner.json`, JSON.stringify({ pid: deadPid(), token: 'dead-token', label: 'old', slug: 'q', since: Date.now() }))
  const r = heavy(w, 'q', 'after-dead', [NODE, '-e', ONE_JSON])
  assert.equal(r.status, 0, say(r))
  assert.equal(r.json.ok, true, 'the command ran')
  assert.ok(r.json.heavy.waitedMs < 5000, `a stale lock is taken at once, waited ${r.json.heavy.waitedMs}`)
  assert.ok(!existsSync(lock), 'the slot is released when the run ends')
})

test('factory heavy takes over an owner-less lock older than 10 s, and waits on a fresh one', () => {
  const w = world([planned('q')])
  const lock = `${w.dir}/resources/heavy.lock`
  mkdirSync(lock, { recursive: true })
  const old = (Date.now() - 60_000) / 1000
  utimesSync(lock, old, old)
  const r = heavy(w, 'q', 'after-old', [NODE, '-e', ONE_JSON])
  assert.equal(r.status, 0, say(r))
  assert.equal(r.json.ok, true)
  assert.ok(r.json.heavy.waitedMs < 5000, `waited ${r.json.heavy.waitedMs}`)
  assert.ok(!existsSync(lock))

  // A fresh owner-less lock (an owner between mkdir and its write) is not stale: heavy must wait, not take it.
  mkdirSync(lock, { recursive: true })
  const c = spawn(NODE, [FACTORY, ...heavyArgs(w, 'q', 'waiter', [NODE, '-e', ONE_JSON])], { cwd: w.repo, env: env(w.ok, 1000), stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  c.stdout.on('data', (d) => (out += d))
  c.stderr.resume()
  try {
    // Within its first seconds the fresh lock is still young; no output yet means the waiter is waiting.
    assert.ok(!waitFor(() => out.includes('"ok"'), 3000), 'heavy does not take a fresh owner-less lock')
  } finally {
    if (c.pid && alive(c.pid)) process.kill(c.pid, 'SIGKILL')
  }
})

// ---------- heavy: group record ----------

test('factory heavy deletes its group record when the group is empty', () => {
  const w = world([planned('q')])
  const r = heavy(w, 'q', 'clean', [NODE, '-e', ONE_JSON])
  assert.equal(r.status, 0, say(r))
  const groups = `${w.dir}/resources/groups`
  const left = existsSync(groups) ? readdirSync(groups) : []
  assert.deepEqual(left, [], 'no group record is left behind when nothing outlives the command')
})

// ---------- reap ----------

test('factory reap skips a record whose heavyPid is alive and prints reaped and skipped arrays', () => {
  const w = world([planned('q')])
  const label = 'skipme'
  // Stand-ins this test started and owns: one for the heavy process, one for the group.
  const hv = spawn('sleep', ['300'], { stdio: 'ignore' })
  const grp = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' })
  hv.unref()
  grp.unref()
  try {
    mkdirSync(`${w.dir}/resources/groups`, { recursive: true })
    writeFileSync(`${w.dir}/resources/groups/${grp.pid}.json`, JSON.stringify({ pgid: grp.pid, heavyPid: hv.pid, label, slug: 'q', since: Date.now() }))
    const r = w.run(['reap', ...fl(w, 'q'), '--label', label])
    assert.equal(r.status, 0, say(r))
    assert.ok(Array.isArray(r.json?.reaped) && Array.isArray(r.json?.skipped), `reap prints reaped and skipped arrays, got ${r.stdout}`)
    assert.deepEqual(r.json.reaped, [])
    assert.deepEqual(r.json.skipped, [grp.pid])
    assert.ok(alive(grp.pid), 'a group whose heavy run is alive is left alone')
    assert.ok(existsSync(`${w.dir}/resources/groups/${grp.pid}.json`), 'the skipped record stays')

    // Once heavyPid is gone, the same record is reaped.
    process.kill(hv.pid, 'SIGKILL')
    assert.ok(waitFor(() => !alive(hv.pid)))
    const r2 = w.run(['reap', ...fl(w, 'q'), '--label', label])
    assert.deepEqual(r2.json?.reaped, [grp.pid], say(r2))
    assert.deepEqual(r2.json.skipped, [])
    assert.ok(waitFor(() => !alive(grp.pid)), 'the recorded group is killed')
    assert.ok(!existsSync(`${w.dir}/resources/groups/${grp.pid}.json`), 'reap deletes the record')
  } finally {
    for (const p of [hv.pid, grp.pid]) if (p && alive(p)) process.kill(p, 'SIGKILL')
  }
})

// ---------- sampler-error events ----------

function samplerErrors(w: World): any[] {
  return readEvents(w.dir).filter((e) => e.event === 'sampler-error')
}

test('the sampler-error event from admit, start and heavy is schema-valid and carries command and error', () => {
  const w = world([planned('q')], { maxParallelCrews: 4 })
  const a = w.run(['admit', ...fl(w, 'q')], { sample: 'error' })
  assert.equal(a.json?.admitted, true, `admit fails open; ${say(a)}`)
  const s = w.run(['start', '--stage', 'next', '--dir', w.dir, '--repo', w.repo], { sample: 'error' })
  assert.equal(s.status, 0, say(s))
  const h = heavy(w, 'q', 'se', [NODE, '-e', ONE_JSON], { sample: 'error' })
  assert.equal(h.status, 0, `heavy runs the command when the sampler fails; ${say(h)}`)
  assert.equal(h.json.ok, true)
  const evs = samplerErrors(w)
  for (const cmd of ['admit', 'start', 'heavy']) {
    const e = evs.find((x) => x.command === cmd)
    assert.ok(e, `a sampler-error event with command ${cmd}, got ${JSON.stringify(evs)}`)
    assert.deepEqual(validateEvent(e), [], `${cmd} event is valid against the schema`)
    assert.equal(typeof e.error, 'string')
    assert.ok(e.error.length >= 1 && e.error.length <= 200)
    assert.equal(e.crew, 'q')
    assert.equal(e.agent, 'q')
  }
})

test('a sampler error prints freeMB null on admit', () => {
  const w = world([planned('q')])
  const r = w.run(['admit', ...fl(w, 'q')], { sample: 'error' })
  assert.equal(r.status, 0, say(r))
  assert.equal(r.json?.freeMB, null, say(r))
})

// ---------- admit usage, start output ----------

test('admit with a slug not in the plan exits 2 with an error line', () => {
  const w = world([planned('q')])
  const r = w.run(['admit', ...fl(w, 'nope')])
  assert.equal(r.status, 2, say(r))
  assert.equal(typeof r.json?.error, 'string')
})

test('start --args-file short output carries held, after crews', () => {
  const w = world([planned('q')], { maxParallelCrews: 4 })
  const p = `${w.scratch}/args.json`
  const low = `${w.scratch}/low.json`
  writeFileSync(low, JSON.stringify({ freeMB: 10, totalMB: 16000 }))
  const r = w.run(['start', '--stage', 'next', '--dir', w.dir, '--repo', w.repo, '--args-file', p], { sample: low })
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(Object.keys(r.json), ['argsFile', 'scriptPath', 'crews', 'held', 'foremen', 'refused', 'stale', 'unfinished'])
  assert.deepEqual(r.json.held.map((x) => x.slug), ['q'])
  assert.equal(typeof r.json.held[0].why, 'string')
  const full = JSON.parse(readFileSync(p, 'utf8'))
  assert.deepEqual(full.held, r.json.held, 'the args file and the short output agree')
  assert.equal(readPlan(w.dir).crews[0].status, 'planned')
})

test('a parallelism file never lifts a start that memory holds', () => {
  const w = world([planned('q')], { maxParallelCrews: 4 })
  mkdirSync(`${w.dir}/resources`, { recursive: true })
  writeFileSync(`${w.dir}/resources/parallelism.json`, JSON.stringify({ parallelism: 4 }))
  const low = `${w.scratch}/low.json`
  writeFileSync(low, JSON.stringify({ freeMB: 10, totalMB: 16000 }))
  const r = w.run(['start', '--stage', 'next', '--dir', w.dir, '--repo', w.repo], { sample: low })
  assert.deepEqual(r.json?.held?.map((x) => x.slug), ['q'], say(r))
  assert.equal(readPlan(w.dir).crews[0].status, 'planned')
  assert.ok(!existsSync(`${w.repo}/.claude/worktrees/truss-q`))
})

// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0015 (resource-aware), Decisions 2 to 4 and Seams to pin, section 2: factory admit, heavy and reap,
// start's `held` list and the effective parallelism file. Written from the ADR before bin/factory.ts has them.
//
// Run with: node --test tests/factory-resources-contract.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs.
//
// The producer is read from $TRUSS_CONTRACT_ROOT/bin/factory.ts (default: the repo root). With no producer each case
// prints its own line: `producer missing: factory admit`, `factory heavy`, `factory reap`, `factory start held` and
// `factory parallelism`, whether the variable is unset or set to the repo root. The root is only a place to read the
// producer from; nothing here branches on its value.
//
// Every run uses temp dirs made with mkdtemp (a repo, a truss dir and a scratch dir); the live truss dir is never
// touched. TRUSS_SAMPLE and TRUSS_MIN_FREE_MB are set per child process, and any value inherited from the caller is
// removed first. The only processes this file signals are the ones it started and recorded by pid.

import assert from 'node:assert/strict'
import { randomBytes, randomInt } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { addCrewWorktree, appendEvent, crew, factorySpawn, mkRepo, mkTrussDir, planObj, readEvents, readPlan, tmp, validateEvent, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const ROOT = (process.env.TRUSS_CONTRACT_ROOT || REPO_ROOT).replace(/\\/g, '/').replace(/\/$/, '')
const FACTORY = `${ROOT}/bin/factory.ts`

const hex = (): string => randomBytes(3).toString('hex')

// ---------- running the CLI ----------

/** The env a factory child gets: the caller's, minus any TRUSS_SAMPLE or TRUSS_MIN_FREE_MB, plus the two given. */
function childEnv(sample?: string, minFreeMB?: number): Record<string, string> {
  const e: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) e[k] = v
  delete e.TRUSS_SAMPLE
  delete e.TRUSS_MIN_FREE_MB
  if (sample !== undefined) e.TRUSS_SAMPLE = sample
  if (minFreeMB !== undefined) e.TRUSS_MIN_FREE_MB = String(minFreeMB)
  return e
}

type Res = { status: number | null; json: any; stdout: string; stderr: string; ms: number }

function parseOut(stdout: string): any {
  const lines = stdout.split('\n').filter((l) => l.length > 0)
  if (lines.length !== 1) return undefined
  try {
    return JSON.parse(lines[0])
  } catch {
    return undefined
  }
}

/** A world: a temp repo with `plan` crews, a temp truss dir with plan.json and goal files, and a scratch dir. */
type World = { repo: string; dir: string; scratch: string; run(args: string[], o?: { sample?: string; min?: number; cwd?: string }): Res; sampleFile(freeMB: number): string }

function world(crews: any[], planOver: Record<string, unknown> = {}): World {
  const repo = mkRepo()
  const dir = mkTrussDir()
  const scratch = tmp('fres-scratch-')
  writePlan(dir, planObj(crews, planOver))
  for (const c of crews) writeGoal(dir, c.slug)
  let n = 0
  const w: World = {
    repo, dir, scratch,
    sampleFile(freeMB) {
      const p = `${scratch}/sample-${n++}.json`
      writeFileSync(p, JSON.stringify({ freeMB, totalMB: Math.max(freeMB, 16000) }))
      return p
    },
    run(args, o = {}) {
      const t0 = Date.now()
      const r = spawnSync(process.execPath, [FACTORY, ...args], { cwd: o.cwd ?? repo, encoding: 'utf8', timeout: 120_000, env: childEnv(o.sample, o.min) })
      const stdout = r.stdout ?? ''
      return { status: r.status, json: parseOut(stdout), stdout, stderr: r.stderr ?? '', ms: Date.now() - t0 }
    },
  }
  return w
}

const fl = (w: World, slug?: string): string[] => ['--dir', w.dir, '--repo', w.repo, ...(slug === undefined ? [] : ['--slug', slug])]
const admit = (w: World, slug: string, sample?: string, min?: number): Res => w.run(['admit', ...fl(w, slug)], { sample, min })

const say = (r: Res): string => `exit ${r.status}; stdout ${r.stdout.slice(0, 200)}; stderr ${r.stderr.slice(0, 200)}`

/** admit's answer, or a failure `producer missing: factory admit` when the command is not there. */
function admitAnswer(w: World, slug: string, sample?: string, min?: number): Res {
  const r = admit(w, slug, sample, min)
  if (typeof r.json?.admitted !== 'boolean') assert.fail(`producer missing: factory admit (${say(r)})`)
  return r
}

const running = (slug: string) => crew(slug, { status: 'running' })
const planned = (slug: string) => crew(slug, { status: 'planned' })

function writeParallelism(w: World, text: string): void {
  mkdirSync(`${w.dir}/resources`, { recursive: true })
  writeFileSync(`${w.dir}/resources/parallelism.json`, text)
}

// ---------- admit ----------

test('factory admit holds below the threshold and admits at or above it', () => {
  const w = world([planned('q')])
  const min = randomInt(1000, 5000)
  const up = admitAnswer(w, 'q', w.sampleFile(min + randomInt(1, 3000)), min)
  assert.equal(up.status, 0, `admitted exits 0; ${say(up)}`)
  assert.equal(up.json.admitted, true)
  assert.equal(typeof up.json.parallelism, 'number', 'admit prints parallelism')
  assert.ok(up.stdout.endsWith('\n') && up.stdout.trim().split('\n').length === 1, 'one JSON line')

  const down = admitAnswer(w, 'q', w.sampleFile(min - randomInt(1, 900)), min)
  assert.equal(down.status, 1, `held exits 1; ${say(down)}`)
  assert.equal(down.json.admitted, false)
  assert.equal(typeof down.json.parallelism, 'number', 'a held admit prints parallelism too')

  const edge = admitAnswer(w, 'q', w.sampleFile(min), min)
  assert.equal(edge.status, 0, 'free memory equal to the threshold admits')

  // The same sample is admitted or held by the threshold alone: TRUSS_MIN_FREE_MB is what moves the line.
  const s = w.sampleFile(3000)
  assert.equal(admitAnswer(w, 'q', s, 2000).json.admitted, true)
  assert.equal(admitAnswer(w, 'q', s, 4000).json.admitted, false)
  assert.ok(down.ms < 10_000 && up.ms < 10_000, 'admit returns at once')
})

test('factory admit: a slug that is not in the plan is a usage error', () => {
  const w = world([planned('q')])
  admitAnswer(w, 'q', w.sampleFile(9000), 1000)
  const r = admit(w, `nope-${hex()}`, w.sampleFile(9000), 1000)
  assert.equal(r.status, 2, say(r))
  assert.equal(typeof r.json?.error, 'string')
})

test('factory admit: a sampler error admits and appends a sampler-error event', () => {
  const w = world([planned('q')])
  const before = readEvents(w.dir).length
  const r = admitAnswer(w, 'q', 'error', 4000)
  assert.equal(r.status, 0, `a sampler error fails open; ${say(r)}`)
  assert.equal(r.json.admitted, true)
  const fresh = readEvents(w.dir).slice(before).filter((e) => typeof e.event === 'string' && e.event.includes('sampler') && e.event.includes('error'))
  assert.equal(fresh.length, 1, `one new sampler error line in events.jsonl, got ${JSON.stringify(readEvents(w.dir).slice(before))}`)
  assert.equal(fresh[0].event, 'sampler-error')
  assert.equal(fresh[0].command, 'admit')
  assert.equal(typeof fresh[0].error, 'string')
  assert.deepEqual(validateEvent(fresh[0]), [], 'the event is valid against docs/events.schema.json')
})

// ---------- the effective parallelism file ----------

test('factory parallelism: a good value is used, a bad one means maxParallelCrews, and nothing goes above the cap', () => {
  const cap = 3
  const w = world([running('r'), planned('q')], { maxParallelCrews: cap })
  const ok = w.sampleFile(9000)
  const probe = admit(w, 'q', ok, 1000)
  if (typeof probe.json?.parallelism !== 'number') assert.fail(`producer missing: factory parallelism (${say(probe)})`)

  assert.equal(admitAnswer(w, 'q', ok, 1000).json.parallelism, cap, 'no file means maxParallelCrews')

  writeParallelism(w, JSON.stringify({ parallelism: 2 }))
  const two = admitAnswer(w, 'q', ok, 1000)
  assert.equal(two.json.parallelism, 2, 'a good file is used')
  assert.equal(two.json.admitted, true, 'one running crew leaves room under 2')

  writeParallelism(w, JSON.stringify({ parallelism: 1 }))
  const one = admitAnswer(w, 'q', ok, 1000)
  assert.equal(one.json.parallelism, 1)
  assert.equal(one.json.admitted, false, 'one running crew fills a parallelism of 1')
  assert.equal(one.status, 1)

  writeParallelism(w, JSON.stringify({ parallelism: cap }))
  assert.equal(admitAnswer(w, 'q', ok, 1000).json.parallelism, cap, 'the cap itself counts')

  for (const bad of [JSON.stringify({ parallelism: 9 }), JSON.stringify({ parallelism: 0 }), JSON.stringify({ parallelism: -1 }), JSON.stringify({ parallelism: 2.5 }), JSON.stringify({ parallelism: '2' }), JSON.stringify({ other: 2 }), 'garbage', '', '[2]']) {
    writeParallelism(w, bad)
    const r = admitAnswer(w, 'q', ok, 1000)
    assert.equal(r.json.parallelism, cap, `file ${JSON.stringify(bad)} means maxParallelCrews`)
    assert.equal(r.json.admitted, true, `file ${JSON.stringify(bad)} still admits with room and memory`)
  }

  // The memory hold stays the floor: a file at the cap cannot admit a start that memory holds.
  writeParallelism(w, JSON.stringify({ parallelism: cap }))
  assert.equal(admitAnswer(w, 'q', w.sampleFile(10), 1000).json.admitted, false)
})

// ---------- start ----------

function startWorld(over: Record<string, unknown> = {}, extra: any[] = []): World {
  return world([planned('q'), ...extra], { maxParallelCrews: 4, ...over })
}
const start = (w: World, sample?: string, min?: number): Res => w.run(['start', '--stage', 'next', ...fl(w)], { sample, min })

function startAnswer(w: World, sample?: string, min?: number): Res {
  const r = start(w, sample, min)
  if (!Array.isArray(r.json?.held)) assert.fail(`producer missing: factory start held (${say(r)})`)
  return r
}

test('factory start lists a crew held by admission under held and leaves it planned, with no worktree', () => {
  const w = startWorld()
  const r = startAnswer(w, w.sampleFile(10), 1000)
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(r.json.held.map((x: any) => x.slug), ['q'])
  assert.equal(typeof r.json.held[0].why, 'string')
  assert.ok(r.json.held[0].why.length > 0)
  assert.equal(readPlan(w.dir).crews.find((c: any) => c.slug === 'q').status, 'planned', 'a held crew stays planned')
  assert.ok(!existsSync(`${w.repo}/.claude/worktrees/truss-q`), 'a held crew gets no worktree')
  assert.equal(readEvents(w.dir).filter((e) => e.event === 'spawn' && e.crew === 'q').length, 0, 'a held crew gets no spawn line')
  assert.ok(!r.json.truss.crews.some((e: any) => e.slug === 'q'), 'a held crew is not among the started crews')
})

test('factory start with room and memory starts the crew and holds nothing', () => {
  const w = startWorld()
  const r = startAnswer(w, w.sampleFile(9000), 1000)
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(r.json.held, [])
  assert.equal(readPlan(w.dir).crews.find((c: any) => c.slug === 'q').status, 'running')
  assert.ok(existsSync(`${w.repo}/.claude/worktrees/truss-q`), 'the started crew has its worktree')
})

test('factory start: a sampler error starts the crew and logs sampler-error', () => {
  const w = startWorld()
  const r = startAnswer(w, 'error', 4000)
  assert.deepEqual(r.json.held, [])
  assert.equal(readPlan(w.dir).crews.find((c: any) => c.slug === 'q').status, 'running')
  const ev = readEvents(w.dir).filter((e) => e.event === 'sampler-error')
  assert.ok(ev.length >= 1 && ev.every((e) => e.command === 'start'), `sampler-error lines with command start, got ${JSON.stringify(ev)}`)
})

test('factory start: the parallelism file holds a planned crew while the running crews fill it', () => {
  const w = startWorld({}, [])
  // A second crew runs already: a worktree and a factory spawn line, as an earlier start leaves them.
  const plan = readPlan(w.dir)
  plan.crews.push(running('r'))
  writePlan(w.dir, plan)
  writeGoal(w.dir, 'r')
  addCrewWorktree(w.repo, 'r')
  appendEvent(w.dir, factorySpawn('r', new Date(Date.now() - 60_000).toISOString()))
  const ok = w.sampleFile(9000)

  writeParallelism(w, JSON.stringify({ parallelism: 1 }))
  const held = startAnswer(w, ok, 1000)
  assert.deepEqual(held.json.held.map((x: any) => x.slug), ['q'], 'a parallelism of 1 holds q while r runs')
  assert.equal(readPlan(w.dir).crews.find((c: any) => c.slug === 'q').status, 'planned')
  assert.ok(!existsSync(`${w.repo}/.claude/worktrees/truss-q`))

  writeParallelism(w, JSON.stringify({ parallelism: 2 }))
  const free = startAnswer(w, ok, 1000)
  assert.deepEqual(free.json.held, [], 'a parallelism of 2 leaves room for q')
  assert.equal(readPlan(w.dir).crews.find((c: any) => c.slug === 'q').status, 'running')
})

// ---------- heavy ----------

/** Waits up to `ms` for `fn` to be true, in short sleeps. */
function waitFor(fn: () => boolean, ms = 6000): boolean {
  const end = Date.now() + ms
  for (;;) {
    if (fn()) return true
    if (Date.now() >= end) return false
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
  }
}

/** True when pid is a live process that is not a zombie. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
    if (state === 'Z') return false
  } catch {}
  return true
}

const heavyArgs = (w: World, slug: string, label: string, cwd: string, cmd: string[]): string[] => ['heavy', ...fl(w, slug), '--label', label, '--cwd', cwd, '--', ...cmd]
const NODE = process.execPath

function heavyAnswer(w: World, slug: string, label: string, cmd: string[], cwd = w.repo): Res {
  const r = w.run(heavyArgs(w, slug, label, cwd, cmd), { sample: w.sampleFile(9000), min: 1000 })
  if (r.json === undefined || r.json === null || typeof r.json.heavy !== 'object' || r.json.heavy === null) assert.fail(`producer missing: factory heavy (${say(r)})`)
  return r
}

test('factory heavy runs the command in cwd, passes a JSON stdout through with heavy added, and exits with the command', () => {
  const w = world([planned('q')])
  const label = `l-${hex()}`
  const token = hex()
  const js = `console.log(JSON.stringify({ ok: true, token: ${JSON.stringify(token)}, cwd: process.cwd() }))`
  const r = heavyAnswer(w, 'q', label, [NODE, '-e', js])
  assert.equal(r.status, 0, say(r))
  assert.equal(r.json.ok, true, 'the command JSON reaches the caller unchanged')
  assert.equal(r.json.token, token)
  assert.equal(r.json.heavy.label, label)
  assert.equal(r.json.heavy.exit, 0)
  assert.equal(typeof r.json.heavy.waitedMs, 'number')
  assert.ok(r.json.cwd.replace(/\\/g, '/').endsWith(w.repo.split('/').pop()), `the command ran in --cwd, got ${r.json.cwd}`)

  const plain = heavyAnswer(w, 'q', label, [NODE, '-e', `console.log('not json ${token}'); process.exit(3)`])
  assert.equal(plain.status, 3, `heavy exits with the command's code; ${say(plain)}`)
  assert.equal(plain.json.heavy.exit, 3)
  assert.ok(String(plain.json.tail).includes(`not json ${token}`), 'a non-JSON stdout comes back as tail')
})

test('factory heavy keeps its records under the truss dir and writes nothing in the repo', () => {
  const w = world([planned('q')])
  const r = heavyAnswer(w, 'q', `l-${hex()}`, [NODE, '-e', 'console.log(JSON.stringify({ ok: true }))'])
  assert.equal(r.status, 0, say(r))
  const porcelain = spawnSync('git', ['status', '--porcelain'], { cwd: w.repo, encoding: 'utf8' }).stdout
  assert.equal(porcelain.trim(), '', `the worktree is still clean, got ${porcelain}`)
})

test('factory heavy serializes concurrent runs: one heavy slot', async () => {
  const w = world([planned('q')])
  const log = `${w.scratch}/serial.log`
  // Probe first, so a missing command reports as such rather than as three failed spawns.
  heavyAnswer(w, 'q', `l-${hex()}`, [NODE, '-e', 'console.log(JSON.stringify({ ok: true }))'])
  const body = `const fs = require('fs'); fs.appendFileSync(${JSON.stringify(log)}, 's ' + Date.now() + '\\n'); setTimeout(() => { fs.appendFileSync(${JSON.stringify(log)}, 'e ' + Date.now() + '\\n'); console.log(JSON.stringify({ ok: true })) }, 1200)`
  const env = childEnv(w.sampleFile(9000), 1000)
  const runs = [0, 1, 2].map(
    (i) =>
      new Promise<number | null>((resolve) => {
        const c = spawn(NODE, [FACTORY, ...heavyArgs(w, 'q', `l-${i}-${hex()}`, w.repo, [NODE, '-e', body])], { cwd: w.repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
        c.stdout.resume()
        c.stderr.resume()
        c.on('close', (code) => resolve(code))
      }),
  )
  const codes = await Promise.all(runs)
  assert.deepEqual(codes, [0, 0, 0], 'all three runs finish')
  const marks = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ')[0])
  assert.deepEqual(marks, ['s', 'e', 's', 'e', 's', 'e'], `runs must not overlap, got ${marks.join('')}`)
  const porcelain = spawnSync('git', ['status', '--porcelain'], { cwd: w.repo, encoding: 'utf8' }).stdout
  assert.equal(porcelain.trim(), '', 'the repo stays clean')
})

// ---------- reap ----------

function listFiles(d: string): string[] {
  if (!existsSync(d)) return []
  return readdirSync(d, { recursive: true }).map(String).filter((p) => statSync(`${d}/${p}`).isFile())
}

test('factory reap kills the recorded orphan group of its label and leaves an unrelated process', () => {
  const w = world([planned('q')])
  const probe = w.run(['reap', ...fl(w, 'q'), '--label', `none-${hex()}`])
  if (!Array.isArray(probe.json?.reaped)) assert.fail(`producer missing: factory reap (${say(probe)})`)
  assert.equal(probe.status, 0, say(probe))

  const label = `l-${hex()}`
  const pidFile = `${w.scratch}/orphan.pid`
  // heavy's command leaves a sleep in its own process group and exits: an orphan that outlives the group leader.
  const leave = `const { spawn } = require('child_process'); const c = spawn('sleep', ['300'], { stdio: 'ignore' }); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); c.unref(); console.log(JSON.stringify({ ok: true }))`
  // An unrelated sleep in a group of its own, started and recorded by this test.
  const other = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' })
  other.unref()
  const unrelated = other.pid as number
  let orphan = 0
  try {
    const r = heavyAnswer(w, 'q', label, [NODE, '-e', leave])
    assert.equal(r.status, 0, say(r))
    orphan = Number(readFileSync(pidFile, 'utf8'))
    assert.ok(orphan > 0 && alive(orphan), 'the orphan is running after heavy ends')
    assert.ok(listFiles(`${w.dir}/resources`).length > 0, 'the group record stays under D/resources until reap')

    const wrong = w.run(['reap', ...fl(w, 'q'), '--label', `other-${hex()}`])
    assert.equal(wrong.status, 0, say(wrong))
    assert.ok(alive(orphan), 'reap of another label leaves the orphan')

    const reaped = w.run(['reap', ...fl(w, 'q'), '--label', label])
    assert.equal(reaped.status, 0, say(reaped))
    assert.ok(Array.isArray(reaped.json.reaped) && reaped.json.reaped.length >= 1, `reap names the group it killed, got ${reaped.stdout}`)
    assert.ok(waitFor(() => !alive(orphan)), 'reap kills the orphan')
    assert.ok(alive(unrelated), 'an unrelated process in another group survives')
  } finally {
    for (const pid of [orphan, unrelated]) {
      if (pid > 0 && alive(pid)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
    }
  }
})

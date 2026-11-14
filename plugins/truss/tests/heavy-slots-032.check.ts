// 0.32.0 heavy-slots acceptance test (written red first): admit folds the reap into its own call, the stage crew's member start needs no
// separate admit or reap runner call (heavy-slots-stage-032.cases.ts, imported below), the heavy background job runs on win32, a job
// past TRUSS_HEAVY_RUN_MS is stopped, and a slot whose holder hangs past its `until` deadline goes to the next waiter.
import './heavy-slots-stage-032.cases.ts'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { heavyJobMain, heavyMain } from '../bin/factory/heavy.ts'
import { crew, mkEnv, planObj, runCli, tmp, writePlan } from './fixtures/workflow-run/harness.ts'

const say = (r) => `exit ${r.status}\n${r.stdout}\n${r.stderr}`
const body = (r) => JSON.parse(r.stdout.split('\n')[0])
const SLEEP = 'setInterval(() => {}, 1000)'
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    return e.code === 'EPERM'
  }
}
// resolves when the child has exited (a real signal, no fixed sleep decides)
const exited = (child, ms: number): Promise<boolean> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true)
    const t = setTimeout(() => resolve(false), ms)
    child.once('exit', () => {
      clearTimeout(t)
      resolve(true)
    })
  })
// a bounded wait for a condition that a real process will make true
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return cond()
}
const deadPid = (): number => Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout)

function world(config = {}) {
  const env = mkEnv({ config: { merge: 'sequential', target: 'main', ...config }, files: { 'a.txt': 'a\n' } })
  const sample = join(tmp('heavy-slots-032-sample-'), 'ok.json')
  writeFileSync(sample, JSON.stringify({ freeMB: 9000, totalMB: 16000 }))
  return { ...env, extra: { TRUSS_SAMPLE: sample } }
}

test('a direct crew\'s member start runs admission and the reap inside the same factory call', async () => {
  const w = world()
  writePlan(w.dir, planObj([crew('hs')]))
  // a sleeping detached node child is the group the dead heavy job left behind
  const sleeper = spawn(process.execPath, ['-e', SLEEP], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  const pgid = sleeper.pid as number
  const closed = new Promise<void>((resolve) => sleeper.stdout.on('close', () => resolve()))
  const groups = join(w.dir, 'resources', 'groups')
  mkdirSync(groups, { recursive: true })
  const rec = join(groups, `${pgid}.json`)
  writeFileSync(rec, JSON.stringify({ pgid, heavyPid: deadPid(), label: 'hs-check', slug: 'hs' }))
  try {
    const r = runCli(w.factory, 'admit', ['--dir', w.dir, '--repo', w.repo, '--slug', 'hs', '--label', 'hs-builder', '--title', 'build hs'], w.repo, w.extra)
    assert.equal(r.status, 0, say(r))
    const b = body(r)
    assert.equal(b.admitted, true, say(r))
    assert.ok(Array.isArray(b.reaped) && b.reaped.includes(pgid), `the admit body names the reaped group ${pgid}: ${say(r)}`)
    assert.ok(!existsSync(rec), 'the group record is gone after the one call')
    // the pipe closes only when the sleeper has exited
    const gone = await Promise.race([closed.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10000))])
    assert.equal(gone, true, 'the sleeping group exited')
  } finally {
    try {
      process.kill(-pgid, 'SIGKILL')
    } catch {}
  }
})

test('a heavy background job on win32 runs, reports its result and releases its slot', async () => {
  // This Mac has no Windows, so the win32 branch is driven in process: sys.platform is stubbed to win32 and sys.spawn is a recorder
  // that delegates to the real spawn, so the command really runs.
  const dir = tmp('heavy-slots-032-win-')
  const cwd = tmp('heavy-slots-032-wincwd-')
  const key = 'wink'
  const jdir = join(dir, 'resources', 'jobs', key)
  mkdirSync(jdir, { recursive: true })
  const cmd = [process.execPath, '-e', "console.log('win32-ran'); process.exit(3)"]
  // the job dir as startJob writes it
  writeFileSync(join(jdir, 'job.json'), JSON.stringify({ cmd, cwd, slug: 'hs', label: 'hs-check', slots: 1, slot: true, waitLimit: 5000, budgetMs: 10000, since: Date.now(), spawner: process.pid }))
  const seen: Array<{ cmd: string; opts: any }> = []
  const sys = {
    platform: 'win32' as NodeJS.Platform,
    spawn: ((c: string, a: string[], o: any) => {
      seen.push({ cmd: c, opts: o })
      return spawn(c, a, o)
    }) as typeof spawn,
  }
  const r = await (heavyJobMain as any)(['--dir', dir, '--job', key], sys)
  assert.equal(r.code, 0, JSON.stringify(r))
  assert.ok(seen.length > 0, 'the win32 branch spawned through sys.spawn')
  assert.ok(seen.some((s) => s.cmd === process.execPath && s.opts.windowsHide === true), 'the command spawned with windowsHide: true')
  assert.ok(seen.every((s) => s.opts.windowsHide === true), 'every spawn the stub saw used windowsHide: true')
  const res = JSON.parse(readFileSync(join(jdir, 'result.json'), 'utf8'))
  assert.equal(res.ran, true)
  assert.equal(res.exit, 3)
  assert.match(readFileSync(join(jdir, 'out.txt'), 'utf8'), /win32-ran/)
  const locks = readdirSync(join(dir, 'resources')).filter((n) => /^heavy.*\.lock$/.test(n))
  assert.deepEqual(locks, [], 'the heavy slot lock is gone')
  // heavyMain takes the same seam
  assert.equal(typeof heavyMain, 'function')
})

test('a heavy job that is a real sleeping child process past its limit is stopped and its slot released', { timeout: 90000 }, async () => {
  const w = world({ heavySlots: 1 })
  const scratch = tmp('heavy-slots-032-run-')
  const pidFile = join(scratch, 'child.pid')
  const code = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); ${SLEEP}`
  const line = ['--dir', w.dir, '--repo', w.repo, '--slug', 'hs', '--label', 'hs-check', '--cwd', w.repo, '--', process.execPath, '-e', code]
  try {
    const first = runCli(w.factory, 'heavy', line, w.repo, { ...w.extra, TRUSS_HEAVY_ATTACH_MS: '300', TRUSS_HEAVY_WAIT_MS: '5000', TRUSS_HEAVY_RUN_MS: '1500' })
    assert.equal(body(first).heavy.pending, true, `the run outlasts the attach budget: ${say(first)}`)
    const second = runCli(w.factory, 'heavy', line, w.repo, { ...w.extra, TRUSS_HEAVY_ATTACH_MS: '15000', TRUSS_HEAVY_WAIT_MS: '5000', TRUSS_HEAVY_RUN_MS: '1500' })
    const b = body(second)
    assert.equal(b.heavy.timedOut, true, `the collected body carries heavy.timedOut: ${say(second)}`)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    assert.ok(await until(() => !alive(pid), 10000), `the sleeping child ${pid} was stopped`)
    assert.ok(!existsSync(join(w.dir, 'resources', 'heavy.lock')), 'the slot lock is released')
  } finally {
    // a red run must not leave the sleeper behind
    try {
      process.kill(-Number(readFileSync(pidFile, 'utf8')), 'SIGKILL')
    } catch {}
  }
})

test('a second real check process takes the slot a hung real job held once the limit passes', { timeout: 90000 }, async () => {
  const w = world({ heavySlots: 1 })
  // the hung holder: a real sleeping process that owns the slot lock, with a deadline in epoch ms
  const hung = spawn(process.execPath, ['-e', SLEEP], { detached: true, stdio: 'ignore' })
  const lock = join(w.dir, 'resources', 'heavy.lock')
  mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: hung.pid, token: 'hung-token', label: 'hs-check', slug: 'hs', since: Date.now(), until: Date.now() + 1500 }))
  try {
    const line = ['--dir', w.dir, '--repo', w.repo, '--slug', 'hs2', '--label', 'hs2-check', '--cwd', w.repo, '--', process.execPath, '-e', "console.log('second-ran')"]
    const r = runCli(w.factory, 'heavy', line, w.repo, { ...w.extra, TRUSS_HEAVY_ATTACH_MS: '60000', TRUSS_HEAVY_WAIT_MS: '20000' })
    assert.equal(r.status, 0, say(r))
    const b = body(r)
    assert.notEqual(b.heavy.ran, false, `the second process took the slot: ${say(r)}`)
    assert.match(r.stdout, /second-ran/)
    assert.equal(await exited(hung, 10000), true, 'the hung holder was stopped')
  } finally {
    try {
      process.kill(-(hung.pid as number), 'SIGKILL')
    } catch {}
  }
})

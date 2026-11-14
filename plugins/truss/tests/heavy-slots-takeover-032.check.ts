// 0.32.0 heavy-slots QC finding, regression cases written red first against the real CLI: the `until` takeover of a check that runs
// under `factory heavy` must stop that check's suite (the wrapper's group record names the check's pid as its group), and a run the
// limit stopped stretches the next default run limit, which a run that is never recorded could not.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { recordHeavyTime, runMsOf, slotWaitMs } from '../bin/factory/slot.ts'
import { crew, mkEnv, planObj, tmp, writePlan } from './fixtures/workflow-run/harness.ts'

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    return e.code === 'EPERM'
  }
}
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return cond()
}

test('heavy takeover: the until takeover stops the suite of a check that runs under factory heavy', { timeout: 90000 }, async () => {
  const scratch = tmp('hs-takeover-032-')
  const pidFile = join(scratch, 'suite.pid')
  const pkg = JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: `node -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setTimeout(()=>{}, 60000)"` } })
  const w = mkEnv({ useRealPlugin: true, config: { merge: 'sequential', target: 'main', heavySlots: 1 }, files: { 'package.json': pkg } })
  writePlan(w.dir, planObj([crew('p', { acceptanceTest: 'npm test' }), crew('q', { acceptanceTest: 'npm test' })]))
  const sample = join(scratch, 'ok.json')
  writeFileSync(sample, JSON.stringify({ freeMB: 9000, totalMB: 16000 }))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('GIT_') && k !== 'NODE_TEST_CONTEXT') env[k] = v
  delete env.TRUSS_MIN_FREE_MB
  Object.assign(env, { TRUSS_SAMPLE: sample, TRUSS_HEAVY_ATTACH_MS: '60000', TRUSS_HEAVY_WAIT_MS: '40000', TRUSS_HEAVY_RUN_MS: '1000' })
  const inner = [process.execPath, w.factory, 'check', '--slug', 'p', '--cwd', w.repo, '--expect', 'red', '--dir', w.dir, '--repo', w.repo]
  const first = spawn(process.execPath, [w.factory, 'heavy', '--dir', w.dir, '--repo', w.repo, '--slug', 'p', '--label', 'p-check', '--cwd', w.repo, '--', ...inner], { cwd: w.repo, env, stdio: 'ignore' })
  let suitePid = 0
  try {
    assert.ok(await until(() => existsSync(pidFile), 20000), 'the suite started')
    suitePid = Number(readFileSync(pidFile, 'utf8'))
    const marker = join(scratch, 'second.txt')
    const sec = spawn(process.execPath, [w.factory, 'heavy', '--dir', w.dir, '--repo', w.repo, '--slug', 'q', '--label', 'q-check', '--cwd', w.repo, '--', process.execPath, '-e', `require('fs').writeFileSync('${marker}', 'x')`], { cwd: w.repo, env, stdio: 'ignore' })
    await new Promise((r) => sec.on('close', r))
    assert.ok(existsSync(marker), 'the second caller took the slot over and ran')
    assert.ok(await until(() => !alive(suitePid), 10000), `the first suite ${suitePid} is still alive after the takeover`)
  } finally {
    try {
      if (suitePid) process.kill(suitePid, 'SIGKILL')
    } catch {}
    try {
      process.kill(first.pid as number, 'SIGKILL')
    } catch {}
  }
})

test('heavy limit: a run the limit stopped stretches the next default run limit, not the slot wait', () => {
  const dir = tmp('hs-limit-032-')
  mkdirSync(join(dir, 'resources'), { recursive: true })
  assert.equal(runMsOf(dir, {}), 540000)
  recordHeavyTime(dir, { label: 'a', slug: 'a', ms: 540000, timedOut: true })
  assert.equal(slotWaitMs(dir), 540000, 'a stopped run is no suite time')
  assert.equal(runMsOf(dir, {}), 1080000, 'the next default limit grows to fit a longer suite')
  assert.equal(runMsOf(dir, { TRUSS_HEAVY_RUN_MS: '5000' }), 5000, 'the env var still wins')
})

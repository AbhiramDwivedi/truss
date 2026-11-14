// 0.32.0 heavy-slots stress findings, regression cases written red first against the real CLI: defect 1 (the run limit counts the slot wait of
// a check that takes the slot inside its own command) and defect 2 (the `until` takeover leaves a direct check's hung suite running).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
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
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('GIT_') && k !== 'NODE_TEST_CONTEXT') env[k] = v
  delete env.TRUSS_MIN_FREE_MB
  return Object.assign(env, extra)
}
function world(suite: string) {
  const pkg = JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: suite } })
  const w = mkEnv({ useRealPlugin: true, config: { merge: 'sequential', target: 'main', heavySlots: 1 }, files: { 'package.json': pkg } })
  writePlan(w.dir, planObj([crew('p', { acceptanceTest: 'npm test' }), crew('q', { acceptanceTest: 'npm test' })]))
  const sample = join(tmp('hs-stress-032-sample-'), 'ok.json')
  writeFileSync(sample, JSON.stringify({ freeMB: 9000, totalMB: 16000 }))
  return { w, sample }
}

test('heavy stress 1: a check that only waited for the slot is not stopped by the run limit', { timeout: 60000 }, async () => {
  const SUITE_MS = 3000
  const { w, sample } = world(`node -e "setTimeout(()=>{console.log('suite-done')}, ${SUITE_MS})"`)
  const env = cleanEnv({ TRUSS_SAMPLE: sample, TRUSS_HEAVY_ATTACH_MS: '60000', TRUSS_HEAVY_WAIT_MS: '30000', TRUSS_HEAVY_RUN_MS: '4500' })
  const heavyCheck = (slug: string): Promise<{ out: string }> => {
    const inner = [process.execPath, w.factory, 'check', '--slug', slug, '--cwd', w.repo, '--expect', 'red', '--dir', w.dir, '--repo', w.repo]
    const c = spawn(process.execPath, [w.factory, 'heavy', '--dir', w.dir, '--repo', w.repo, '--slug', slug, '--label', `${slug}-check`, '--cwd', w.repo, '--', ...inner], { cwd: w.repo, env })
    let out = ''
    c.stdout.on('data', (d) => (out += d))
    c.stderr.on('data', (d) => (out += d))
    return new Promise((r) => c.on('close', () => r({ out })))
  }
  const a = heavyCheck('p')
  await new Promise((r) => setTimeout(r, 700))
  const b = heavyCheck('q')
  const [ra, rb] = await Promise.all([a, b])
  const hq = JSON.parse(rb.out.split('\n')[0]).heavy
  assert.notEqual(hq.timedOut, true, `q's suite ran ${SUITE_MS} ms, inside the 4500 ms run limit; only its slot wait was long: ${rb.out}`)
  assert.match(rb.out, /suite-done/, 'q\'s suite finished')
  assert.match(ra.out, /suite-done/, 'p\'s suite finished')
})

test('heavy stress 2: the until takeover stops a direct check\'s hung suite, not only the check process', { timeout: 90000 }, async () => {
  const scratch = tmp('hs-stress-032-direct-')
  const pidFile = join(scratch, 'suite.pid')
  const { w, sample } = world(`node -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setTimeout(()=>{}, 40000)"`)
  const env = cleanEnv({ TRUSS_SAMPLE: sample, TRUSS_HEAVY_ATTACH_MS: '60000', TRUSS_HEAVY_WAIT_MS: '40000', TRUSS_HEAVY_RUN_MS: '1000' })
  const direct = spawn(process.execPath, [w.factory, 'check', '--dir', w.dir, '--repo', w.repo, '--slug', 'p', '--cwd', w.repo, '--expect', 'red'], { cwd: w.repo, env, stdio: 'ignore' })
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
      process.kill(direct.pid as number, 'SIGKILL')
    } catch {}
  }
})

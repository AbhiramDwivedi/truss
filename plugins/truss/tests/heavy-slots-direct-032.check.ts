// 0.32.0 heavy-slots stress finding, regression case written red first against the real CLI: a direct `factory check` (SKILL.md step 1,
// the full suite as acceptance test) holds the slot in its own process. When a waiter takes the slot over after the run limit, the check
// must not die as a bare SIGKILL with empty output: the caller must be told the limit (TRUSS_HEAVY_RUN_MS) and a timedOut row must be
// recorded, so the next default limit grows (ADR-0054).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { crew, mkEnv, planObj, tmp, writePlan } from './fixtures/workflow-run/harness.ts'

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return cond()
}

test('heavy takeover: a direct full-suite check stopped by a waiter names the run limit and records a timedOut row', { timeout: 90000 }, async () => {
  const scratch = tmp('hs-direct-032-')
  const pidFile = join(scratch, 'suite.pid')
  const pkg = JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: `node -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setTimeout(()=>{}, 30000)"` } })
  const w = mkEnv({ useRealPlugin: true, config: { merge: 'sequential', target: 'main', heavySlots: 1 }, files: { 'package.json': pkg } })
  writePlan(w.dir, planObj([crew('p', { acceptanceTest: 'npm test' }), crew('q', { acceptanceTest: 'npm test' })]))
  const sample = join(scratch, 'ok.json')
  writeFileSync(sample, JSON.stringify({ freeMB: 9000, totalMB: 16000 }))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('GIT_') && k !== 'NODE_TEST_CONTEXT') env[k] = v
  delete env.TRUSS_MIN_FREE_MB
  Object.assign(env, { TRUSS_SAMPLE: sample, TRUSS_HEAVY_ATTACH_MS: '60000', TRUSS_HEAVY_WAIT_MS: '40000', TRUSS_HEAVY_RUN_MS: '1000' })
  const direct = spawn(process.execPath, [w.factory, 'check', '--dir', w.dir, '--repo', w.repo, '--slug', 'p', '--cwd', w.repo, '--expect', 'red'], { cwd: w.repo, env })
  let out = ''
  direct.stdout.on('data', (d) => (out += d))
  direct.stderr.on('data', (d) => (out += d))
  const closed = new Promise<[number | null, string | null]>((r) => direct.on('close', (c, s) => r([c, s])))
  let suitePid = 0
  try {
    assert.ok(await until(() => existsSync(pidFile), 20000), 'the suite started')
    suitePid = Number(readFileSync(pidFile, 'utf8'))
    const sec = spawn(process.execPath, [w.factory, 'heavy', '--dir', w.dir, '--repo', w.repo, '--slug', 'q', '--label', 'q-check', '--cwd', w.repo, '--', process.execPath, '-e', 'console.log("second-ran")'], { cwd: w.repo, env, stdio: 'ignore' })
    await new Promise((r) => sec.on('close', r))
    const [code, sig] = await closed
    assert.notEqual(sig, 'SIGKILL', `the direct check died of SIGKILL (exit ${code}) with output ${JSON.stringify(out)}`)
    assert.match(out, /TRUSS_HEAVY_RUN_MS/, `the direct caller's output names the run limit variable, got ${JSON.stringify(out)}`)
    const ht = join(w.dir, 'resources', 'heavy-times.jsonl')
    const rows = existsSync(ht) ? readFileSync(ht, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
    assert.ok(rows.some((r) => r.slug === 'p' && r.timedOut === true), `a timedOut row for crew p is recorded, got ${JSON.stringify(rows)}`)
  } finally {
    try {
      if (suitePid) process.kill(suitePid, 'SIGKILL')
    } catch {}
    try {
      process.kill(direct.pid as number, 'SIGKILL')
    } catch {}
  }
})

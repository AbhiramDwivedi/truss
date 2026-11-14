// @ts-nocheck
// A heavy job the run limit stops names TRUSS_HEAVY_RUN_MS, the limit in force and how to raise it (client condition on R-145).
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertOneLine, crew, mkEnv, planObj, putFile, runCli, tmp, writePlan } from './fixtures/workflow-run/harness.ts'

const sampleFile = (): string => {
  const p = join(tmp('hlm-032-sample-'), 'ok.json')
  writeFileSync(p, JSON.stringify({ freeMB: 9000, totalMB: 16000 }))
  return p
}
const NOTE = /TRUSS_HEAVY_RUN_MS/
const LIMIT = /1500 ms/
const RAISE = /larger number of milliseconds to raise it/

test('heavy limit message: factory heavy stopped at the run limit names TRUSS_HEAVY_RUN_MS and the limit', { timeout: 60000 }, () => {
  const env = mkEnv({ useRealPlugin: true, config: { merge: 'sequential', target: 'main', heavySlots: 1 } })
  const res = runCli(
    env.factory,
    'heavy',
    ['--dir', env.dir, '--repo', env.repo, '--slug', 'p', '--label', 'p-suite', '--cwd', env.repo, '--', process.execPath, '-e', 'setTimeout(() => {}, 600000)'],
    env.repo,
    { TRUSS_SAMPLE: sampleFile(), TRUSS_HEAVY_ATTACH_MS: '30000', TRUSS_HEAVY_RUN_MS: '1500' },
  )
  const j = assertOneLine(res)
  assert.equal(j.heavy?.timedOut, true, res.stdout)
  assert.match(String(j.heavy?.limitNote), NOTE, res.stdout)
  assert.match(String(j.heavy?.limitNote), LIMIT, res.stdout)
  assert.match(String(j.heavy?.limitNote), RAISE, res.stdout)
})

test('heavy limit message: goal-check stopped at the run limit names TRUSS_HEAVY_RUN_MS in its output and decision line', { timeout: 60000 }, () => {
  const pidFile = join(tmp('hlm-032-slow-'), 'pid')
  const env = mkEnv({ config: { target: 'main' } })
  putFile(env.repo, 'slow.cjs', "require('node:fs').writeFileSync(process.argv[2], String(process.pid))\nsetTimeout(() => {}, 600000)\n", 'add slow check')
  writePlan(env.dir, planObj([crew('c', { status: 'merged' })], { goalCheck: `node slow.cjs ${pidFile}` }))
  writeFileSync(`${env.dir}/decisions.md`, '- 00:00 | seed | none | followed\n')
  try {
    const res = runCli(env.factory, 'goal-check', ['--dir', env.dir, '--repo', env.repo], env.repo, {
      TRUSS_TRANSCRIPTS_ROOT: tmp('hlm-032-root-'),
      CLAUDE_CONFIG_DIR: '',
      TRUSS_SAMPLE: sampleFile(),
      TRUSS_HEAVY_RUN_MS: '1500',
      TRUSS_HEAVY_ATTACH_MS: '30000',
    })
    const j = assertOneLine(res)
    assert.equal(j.timedOut, true, res.stdout)
    assert.match(String(j.limitNote), NOTE, res.stdout)
    assert.match(String(j.limitNote), LIMIT, res.stdout)
    assert.match(String(j.limitNote), RAISE, res.stdout)
    const last = readFileSync(`${env.dir}/decisions.md`, 'utf8').trim().split('\n').pop()
    assert.match(last, NOTE, last)
    assert.match(last, LIMIT, last)
  } finally {
    try {
      if (existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL')
    } catch {}
  }
})

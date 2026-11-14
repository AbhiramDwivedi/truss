// 0.32.0 heavy-slots stress finding (ADR-0054 Decision 1, Consequence 2), regression cases written red first against the real CLI: a full
// `factory check` that runs under `factory heavy` and that the run limit stops must leave a heavy-times.jsonl row with timedOut: true,
// or runMsOf never grows and a healthy suite longer than the default limit is stopped for ever. A check job holds no wrapper token
// (slot: false), so heavyJobMain records nothing, and a takeover by a waiting crew kills the check before suiteRun records its own row.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { crew, mkEnv, planObj, tmp, writePlan } from './fixtures/workflow-run/harness.ts'

type Rows = { label: string; ms: number; timedOut?: boolean }[]

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return cond()
}
const closed = (c: ReturnType<typeof spawn>): Promise<string> =>
  new Promise((r) => {
    let out = ''
    c.stdout?.on('data', (d) => (out += d))
    c.on('close', () => r(out))
  })

function world(waitMs: string) {
  const scratch = tmp('hs-fullcheck-032-')
  const pidFile = join(scratch, 'suite.pid')
  const pkg = JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: `node -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setTimeout(()=>{}, 120000)"` } })
  const w = mkEnv({ useRealPlugin: true, config: { merge: 'sequential', target: 'main', heavySlots: 1 }, files: { 'package.json': pkg } })
  writePlan(w.dir, planObj([crew('p', { acceptanceTest: 'npm test' }), crew('q', { acceptanceTest: 'npm test' })]))
  const sample = join(scratch, 'ok.json')
  writeFileSync(sample, JSON.stringify({ freeMB: 9000, totalMB: 16000 }))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('GIT_') && k !== 'NODE_TEST_CONTEXT') env[k] = v
  delete env.TRUSS_MIN_FREE_MB
  Object.assign(env, { TRUSS_SAMPLE: sample, TRUSS_HEAVY_ATTACH_MS: '90000', TRUSS_HEAVY_WAIT_MS: waitMs, TRUSS_HEAVY_RUN_MS: '2000' })
  const inner = [process.execPath, w.factory, 'check', '--slug', 'p', '--cwd', w.repo, '--expect', 'green', '--full', '--dir', w.dir, '--repo', w.repo]
  const heavy = (slug: string, label: string, cmd: string[]) =>
    spawn(process.execPath, [w.factory, 'heavy', '--dir', w.dir, '--repo', w.repo, '--slug', slug, '--label', label, '--cwd', w.repo, '--', ...cmd], { cwd: w.repo, env, stdio: ['ignore', 'pipe', 'ignore'] })
  const rows = (): Rows => {
    const f = join(w.dir, 'resources', 'heavy-times.jsonl')
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l)) : []
  }
  const killSuite = () => {
    try {
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL')
    } catch {}
  }
  return { w, inner, heavy, rows, pidFile, killSuite }
}

test('heavy full check: a full check the run limit stopped records a timedOut row (no waiter)', { timeout: 90000 }, async () => {
  const x = world('5000')
  const first = x.heavy('p', 'p-check', x.inner)
  try {
    const out = await closed(first)
    assert.match(out, /"timedOut":true/, `the result says the run was stopped: ${out}`)
    const row = x.rows().find((r) => r.label === 'p-check')
    assert.ok(row, `a p-check row was recorded in heavy-times.jsonl: ${JSON.stringify(x.rows())}`)
    assert.equal(row.timedOut, true, 'the row is marked timedOut')
  } finally {
    x.killSuite()
    try {
      first.kill('SIGKILL')
    } catch {}
  }
})

test('heavy full check: a full check a waiting crew takes the slot from records a timedOut row and the caller learns of it', { timeout: 120000 }, async () => {
  const x = world('40000')
  const first = x.heavy('p', 'p-check', x.inner)
  const firstOut = closed(first)
  try {
    assert.ok(await until(() => existsSync(x.pidFile), 30000), 'the suite started')
    const sec = x.heavy('q', 'q-check', [process.execPath, '-e', '0'])
    await closed(sec)
    const out = await firstOut
    assert.match(out, /"timedOut":true/, `the first caller learns the run timed out: ${out}`)
    const row = x.rows().find((r) => r.label === 'p-check')
    assert.ok(row, `a p-check row was recorded in heavy-times.jsonl: ${JSON.stringify(x.rows())}`)
    assert.equal(row.timedOut, true, 'the row is marked timedOut')
  } finally {
    x.killSuite()
    try {
      first.kill('SIGKILL')
    } catch {}
  }
})

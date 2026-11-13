// @ts-nocheck
// truss 0.31.0, speed goal items 1 and 2, the factory side: `check --expect green` runs the acceptance test without a trailing
// whole-suite step and then the tests the diff reaches (bin/testmap.ts), outside the heavy slot; `check --full` runs the full suite
// inside the slot and records its time; the slot wait scales with the recorded times; a heavy run longer than the attach budget
// goes on in the background and the same line collects it. Node built-ins only.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { HEAVY_WAIT_MAX_MS, HEAVY_WAIT_MS, heavyWaitMs, slotWaitMs, statusLine } from '../bin/factory.ts'
import { takeHeavySlot, releaseHeavySlot } from '../resources/index.ts'
import { crew, git, mkEnv, mkTrussDir, planObj, runCli, tmp, writePlan } from './fixtures/workflow-run/harness.ts'

const say = (r) => `exit ${r.status}\n${r.stdout}\n${r.stderr}`
const body = (r) => JSON.parse(r.stdout.split('\n')[0])

/** A repo whose package.json runs node --test, a failing test no diff reaches, and a crew branch that changes lib/a.ts. */
function world(config = {}, a = 2) {
  const env = mkEnv({
    config: { merge: 'sequential', target: 'main', ...config },
    files: {
      'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test lib/*.check.ts' } }),
      'lib/a.ts': 'export const a = 1\n',
      'lib/a.check.ts': "import test from 'node:test'\nimport assert from 'node:assert'\nimport { a } from './a.ts'\ntest('a', () => assert.equal(a, 2))\n",
      'lib/bad.check.ts': "import test from 'node:test'\ntest('bad', () => { throw new Error('bad') })\n",
    },
  })
  git(env.repo, ['checkout', '-q', '-b', 'crew'])
  writeFileSync(join(env.repo, 'lib', 'a.ts'), `export const a = ${a}\n`)
  git(env.repo, ['commit', '-q', '-am', 'change a'])
  const sample = join(tmp('heavy-031-sample-'), 'ok.json')
  writeFileSync(sample, JSON.stringify({ freeMB: 9000, totalMB: 16000 }))
  return { ...env, extra: { TRUSS_SAMPLE: sample } }
}
const check = (w, more = []) => runCli(w.factory, 'check', ['--dir', w.dir, '--repo', w.repo, '--slug', 'x', '--cwd', w.repo, '--expect', 'green', ...more], w.repo, w.extra)

test('check --expect green drops the blanket npm test and runs the tests the diff reaches', () => {
  const w = world()
  writePlan(w.dir, planObj([crew('x', { acceptanceTest: 'node -e "0" && npm test' })]))
  const r = check(w)
  assert.equal(r.status, 0, say(r))
  const b = body(r)
  assert.equal(b.tests.mode, 'targeted')
  assert.deepEqual(b.tests.files, ['lib/a.check.ts'])
  assert.ok(b.tests.why.some((x) => /lib\/a\.ts/.test(x)), b.tests.why.join('\n'))
  assert.equal(typeof b.record, 'string')
  assert.deepEqual(JSON.parse(readFileSync(b.record, 'utf8')).tests.files, ['lib/a.check.ts'])
})

test('check --expect green fails when a reached test fails', () => {
  const w = world({}, 3)
  writePlan(w.dir, planObj([crew('x', { acceptanceTest: 'node -e "0"' })]))
  const r = check(w)
  assert.equal(r.status, 1, say(r))
  assert.equal(body(r).tests.mode, 'targeted')
})

test('check --full runs the full suite inside the heavy slot, releases it and records its time', () => {
  const w = world({ targetedTests: { full: 'node -e "require(\'fs\').writeFileSync(\'full-ran\', \'\')"' } })
  writePlan(w.dir, planObj([crew('x', { acceptanceTest: 'node -e "0"' })]))
  const r = check(w, ['--full'])
  assert.equal(r.status, 0, say(r))
  assert.equal(body(r).tests.mode, 'full')
  assert.ok(existsSync(join(w.repo, 'full-ran')), 'the full command ran')
  assert.ok(!existsSync(join(w.dir, 'resources', 'heavy.lock')), 'the slot is released when the suite ends')
  const rows = readFileSync(join(w.dir, 'resources', 'heavy-times.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].label, 'x-check')
  assert.ok(Number.isInteger(rows[0].ms) && rows[0].ms >= 0)
})

test('the heavy slot wait scales with the measured suite time', () => {
  const dir = mkTrussDir()
  assert.equal(slotWaitMs(dir), HEAVY_WAIT_MS, 'no measured run: the old 540 s')
  const rows = (ms) => ms.map((m) => JSON.stringify({ label: 'x-check', ms: m })).join('\n') + '\n'
  mkdirSync(join(dir, 'resources'), { recursive: true })
  writeFileSync(join(dir, 'resources', 'heavy-times.jsonl'), rows([400000, 900000]))
  assert.equal(slotWaitMs(dir), 1800000, 'twice the longest recent suite')
  writeFileSync(join(dir, 'resources', 'heavy-times.jsonl'), rows([10000]))
  assert.equal(slotWaitMs(dir), HEAVY_WAIT_MS, 'never below 540 s')
  writeFileSync(join(dir, 'resources', 'heavy-times.jsonl'), rows([HEAVY_WAIT_MAX_MS]))
  assert.equal(slotWaitMs(dir), HEAVY_WAIT_MAX_MS, 'capped')
  assert.equal(heavyWaitMs({}, { TRUSS_HEAVY_WAIT_MS: '1200' }, dir), 1200, 'an explicit wait still wins')
  assert.equal(heavyWaitMs({}, {}, dir), HEAVY_WAIT_MAX_MS)
})

test('a targeted check through heavy runs while another crew holds the only slot', () => {
  const w = world({ heavySlots: 1 })
  writePlan(w.dir, planObj([crew('x', { acceptanceTest: 'node -e "0"' })]))
  const token = takeHeavySlot(w.dir, { slug: 'other', label: 'other', pid: process.pid }, process.platform, 1)
  assert.equal(typeof token, 'string')
  try {
    const r = runCli(w.factory, 'heavy', ['--dir', w.dir, '--repo', w.repo, '--slug', 'x', '--label', 'x-check', '--cwd', w.repo, '--wait-ms', '0', '--', process.execPath, w.factory, 'check', '--slug', 'x', '--cwd', w.repo, '--expect', 'green', '--dir', w.dir, '--repo', w.repo], w.repo, w.extra)
    assert.equal(r.status, 0, say(r))
    assert.notEqual(body(r).heavy.ran, false)
    assert.equal(body(r).tests.mode, 'targeted')
  } finally {
    releaseHeavySlot(w.dir, token)
  }
})

test('a heavy run longer than the attach budget goes on in the background, holds the slot, and the same line collects it', () => {
  const w = world({ heavySlots: 1 })
  const scratch = tmp('heavy-031-bg-')
  const go = join(scratch, 'go')
  const started = join(scratch, 'started')
  const hold = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(started)},'');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(go)})){clearInterval(t);console.log(JSON.stringify({ok:true}))}},20)`
  const line = ['--dir', w.dir, '--repo', w.repo, '--slug', 'x', '--label', 'x-run', '--cwd', w.repo, '--status-line', '--', process.execPath, '-e', hold]
  const first = runCli(w.factory, 'heavy', line, w.repo, { ...w.extra, TRUSS_HEAVY_ATTACH_MS: '300' })
  assert.equal(first.status, 1, say(first))
  assert.equal(body(first).heavy.pending, true)
  assert.match(first.stdout, /truss-status: .*"pending":true/)
  const lock = join(w.dir, 'resources', 'heavy.lock', 'owner.json')
  assert.ok(existsSync(lock), 'the job holds the slot after the caller returned')
  const owner = JSON.parse(readFileSync(lock, 'utf8'))
  assert.doesNotThrow(() => process.kill(owner.pid, 0), 'the slot owner is the live background job')
  writeFileSync(go, '')
  const second = runCli(w.factory, 'heavy', line, w.repo, { ...w.extra, TRUSS_HEAVY_ATTACH_MS: '30000' })
  assert.equal(second.status, 0, say(second))
  assert.equal(body(second).ok, true)
  assert.ok(existsSync(started))
  assert.ok(!existsSync(join(w.dir, 'resources', 'heavy.lock')), 'the slot is released when the command ends')
})

test('statusLine carries a pending heavy run', () => {
  assert.equal(statusLine({ heavy: { pending: true, label: 'x' } }), 'truss-status: {"pending":true}')
})

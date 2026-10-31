// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0015 Decision 1: sample() fields from the host, the worktrees listing, and script mode.
// Written from the ADR before resources/index.ts exists. Complements tests/resources-contract.check.ts.
//
// Run with: node --test tests/resources/sample.check.ts
// The producer is read from $TRUSS_CONTRACT_ROOT/resources/index.ts (default: the repo root).

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const ROOT = (process.env.TRUSS_CONTRACT_ROOT || REPO_ROOT).replace(/\\/g, '/').replace(/\/$/, '')
const ENTRY = `${ROOT}/resources/index.ts`

async function load(): Promise<any> {
  if (!existsSync(ENTRY)) assert.fail(`producer missing: resources (no ${ENTRY})`)
  return await import(pathToFileURL(ENTRY).href)
}

/** A child env with the test seams removed, so the real host is read. */
function cleanEnv() {
  const e = { ...process.env }
  delete e.TRUSS_SAMPLE
  delete e.TRUSS_MIN_FREE_MB
  return e
}

function hostSample(m: any, opts?: any) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'TRUSS_SAMPLE')
  const old = process.env.TRUSS_SAMPLE
  delete process.env.TRUSS_SAMPLE
  try {
    return m.sample(opts)
  } finally {
    if (had) process.env.TRUSS_SAMPLE = old
  }
}

test('host sample: cpus is os.availableParallelism()', async () => {
  const m = await load()
  const s = await hostSample(m)
  assert.equal(s.cpus, os.availableParallelism())
})

test('host sample: load1 is os.loadavg()[0] when not all zero, absent otherwise', async () => {
  const m = await load()
  const s = await hostSample(m)
  const la = os.loadavg()
  if (la.every((v) => v === 0)) {
    assert.equal('load1' in s && s.load1 !== undefined, false, 'load1 is left out when loadavg is all zeros')
  } else {
    assert.equal(typeof s.load1, 'number')
    // the load moves between two reads, so allow a small drift
    assert.ok(Math.abs(s.load1 - os.loadavg()[0]) <= 1, `load1 ${s.load1} vs ${os.loadavg()[0]}`)
  }
})

test('worktrees: lists the worktree dir holding a live process, not the idle one', { skip: process.platform !== 'linux' }, async () => {
  const m = await load()
  const root = mkdtempSync(`${os.tmpdir()}/resources-sample-`)
  mkdirSync(`${root}/wt-busy`)
  mkdirSync(`${root}/wt-idle`)
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { cwd: `${root}/wt-busy`, stdio: 'ignore' })
  try {
    await new Promise((res, rej) => {
      child.once('spawn', res)
      child.once('error', rej)
    })
    const s = await hostSample(m, { worktreesRoot: root })
    assert.ok(Array.isArray(s.worktrees), 'worktrees is an array')
    const base = (p: string) => p.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop()
    const busy = s.worktrees.find((w: any) => base(w.path) === 'wt-busy')
    assert.ok(busy, `wt-busy is listed: ${JSON.stringify(s.worktrees)}`)
    assert.ok(busy.procs >= 1, `procs >= 1, got ${busy.procs}`)
    assert.ok(busy.rssMB > 0, `rssMB > 0, got ${busy.rssMB}`)
    const idle = s.worktrees.find((w: any) => base(w.path) === 'wt-idle')
    assert.ok(!idle || idle.procs === 0, `wt-idle has no procs: ${JSON.stringify(idle)}`)
  } finally {
    child.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
})

test('worktrees: a missing root does not throw', async () => {
  const m = await load()
  const root = `${os.tmpdir()}/resources-sample-missing-${process.pid}-${Date.now()}`
  const s = await hostSample(m, { worktreesRoot: root })
  assert.equal(typeof s.freeMB, 'number')
  if (s.worktrees !== undefined) assert.ok(Array.isArray(s.worktrees))
})

function runScript(args: string[]) {
  if (!existsSync(ENTRY)) assert.fail(`producer missing: resources (no ${ENTRY})`)
  const r = spawnSync(process.execPath, [ENTRY, ...args], { env: cleanEnv(), encoding: 'utf8', timeout: 30000 })
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`)
  const lines = r.stdout.split('\n').filter((l: string) => l.length > 0)
  assert.equal(lines.length, 1, `exactly one output line, got ${lines.length}: ${r.stdout}`)
  const o = JSON.parse(lines[0])
  assert.ok(o !== null && typeof o === 'object' && !Array.isArray(o), 'the line is a JSON object')
  assert.equal(typeof o.freeMB, 'number')
  assert.equal(typeof o.totalMB, 'number')
  return o
}

test('script mode prints one JSON line with freeMB and totalMB', () => {
  const o = runScript([])
  assert.equal(o.totalMB, Math.round(os.totalmem() / 2 ** 20))
})

test('script mode with --worktrees <root> prints one JSON line', () => {
  const root = mkdtempSync(`${os.tmpdir()}/resources-sample-script-`)
  try {
    mkdirSync(`${root}/wt-a`)
    const o = runScript(['--worktrees', root])
    if (process.platform === 'linux') assert.ok(Array.isArray(o.worktrees), 'worktrees listed on linux')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

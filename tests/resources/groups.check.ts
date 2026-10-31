// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0015 Decision 4: groupAlive(pgid) and killGroup(pgid, signal) act on the group only.
// Written from the ADR before resources/index.ts exists.
//
// Run with: node --test tests/resources/groups.check.ts
// The producer is read from $TRUSS_CONTRACT_ROOT/resources/index.ts (default: the repo root).

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const ROOT = (process.env.TRUSS_CONTRACT_ROOT || REPO_ROOT).replace(/\\/g, '/').replace(/\/$/, '')

async function load(): Promise<any> {
  const p = `${ROOT}/resources/index.ts`
  if (!existsSync(p)) assert.fail(`producer missing: resources (no ${p})`)
  return await import(pathToFileURL(p).href)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

async function waitFor(fn: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await sleep(50)
  }
  return fn()
}

test('groupAlive and killGroup act on the whole group and nothing else', { skip: process.platform !== 'linux' }, async () => {
  const m = await load()
  const d = mkdtempSync(`${os.tmpdir()}/resources-groups-`)
  const pidFile = `${d}/bg.pid`
  let leader: any = null
  let other: any = null
  let bgPid = 0
  try {
    // A detached leader (its own group) starts a background sleep and exits; the sleep stays in the group.
    leader = spawn('bash', ['-c', `sleep 300 & echo $! > ${pidFile}; exit 0`], { detached: true, stdio: 'ignore' })
    const pgid = leader.pid
    await new Promise((res) => leader.once('exit', res))
    assert.ok(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim().length > 0, 5000), 'bg pid recorded')
    bgPid = Number(readFileSync(pidFile, 'utf8').trim())
    assert.ok(alive(bgPid), 'the background sleep runs')

    // A separate sleep in another group.
    other = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' })
    await new Promise((res, rej) => {
      other.once('spawn', res)
      other.once('error', rej)
    })

    assert.equal(m.groupAlive(pgid), true, 'the group lives on after its leader exited')
    assert.equal(m.groupAlive(other.pid), true, 'the other group is alive')

    m.killGroup(pgid, 'SIGTERM')

    assert.ok(await waitFor(() => m.groupAlive(pgid) === false, 5000), 'the group is gone within a few seconds')
    assert.ok(await waitFor(() => !alive(bgPid), 5000), 'the background sleep is dead')
    assert.equal(alive(other.pid), true, 'the sleep in another group survives')
    assert.equal(m.groupAlive(other.pid), true)

    process.kill(other.pid, 'SIGTERM')
    assert.ok(await waitFor(() => !alive(other.pid), 5000), 'the other sleep stops when killed by its pid')
  } finally {
    for (const g of [leader && leader.pid, other && other.pid]) {
      if (!g) continue
      try {
        process.kill(-g, 'SIGKILL')
      } catch {}
      try {
        process.kill(g, 'SIGKILL')
      } catch {}
    }
    if (bgPid) {
      try {
        process.kill(bgPid, 'SIGKILL')
      } catch {}
    }
    rmSync(d, { recursive: true, force: true })
  }
})

test('groupAlive is false for a group that does not exist', { skip: process.platform !== 'linux' }, async () => {
  const m = await load()
  // a pid that just exited has no group
  const c = spawn(process.execPath, ['-e', '0'], { detached: true, stdio: 'ignore' })
  await new Promise((res) => c.once('exit', res))
  assert.equal(m.groupAlive(c.pid), false)
})

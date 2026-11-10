// Tests for bin/store.ts (contract-025 section 2, "store.ts"). Written from the spec before the module exists.
// Assumptions pinned here: lock dir is <dir>/locks/<name>.lock with owner.json {pid, host, token, since (ms number)};
// appendJsonl's `file` is a name relative to `dir`; transcript agent meta is agent-*.meta.json beside agent-*.jsonl.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STORE = path.join(HERE, '..', 'bin', 'store.ts')
const WORKER = path.join(HERE, 'fixtures', 'store', 'worker.ts')
const PATHS = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'store', 'paths.json'), 'utf8'))

const load = async (): Promise<any> => await import(pathToFileURL(STORE).href)
const tmp = (): string => realpathSync(mkdtempSync(path.join(os.tmpdir(), 'truss-store-')))
const fsErr = (code: string): Error => Object.assign(new Error(`${code}: injected`), { code })

// A pid that is not alive: spawn a child, let it exit, reuse its pid.
const deadPid = (): number => {
  const r = spawnSync(process.execPath, ['-e', ''], { windowsHide: true })
  assert.ok(r.pid > 0)
  return r.pid
}

const lockPath = (dir: string, name: string): string => path.join(dir, 'locks', `${name}.lock`)
const plantLock = (dir: string, name: string, owner: Record<string, unknown>): string => {
  const lock = lockPath(dir, name)
  mkdirSync(lock, { recursive: true })
  writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(owner))
  return lock
}

const runWorker = (args: string[]): Promise<{ code: number | null; out: string; err: string }> =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [WORKER, STORE, ...args], { windowsHide: true })
    let out = ''
    let err = ''
    c.stdout.on('data', (d) => (out += d))
    c.stderr.on('data', (d) => (err += d))
    c.on('close', (code) => resolve({ code, out, err }))
  })

test('store: 8 processes x 50 appends give 400 lines', async () => {
  const dir = tmp()
  const results = await Promise.all(Array.from({ length: 8 }, (_, w) => runWorker(['append', dir, 'rows', 'rows.jsonl', '50', `w${w}`])))
  for (const r of results) assert.equal(r.code, 0, r.err)
  const text = readFileSync(path.join(dir, 'rows.jsonl'), 'utf8')
  const lines = text.split('\n').filter((l) => l !== '')
  assert.equal(lines.length, 400)
  const rows = lines.map((l) => JSON.parse(l))
  for (let w = 0; w < 8; w++) assert.equal(rows.filter((r) => r.tag === `w${w}`).length, 50)
  assert.equal(readdirSync(path.join(dir, 'locks')).filter((n) => n.endsWith('.lock')).length, 0)
})

test('store: of 8 processes running createExclusive exactly one wins', async () => {
  const dir = tmp()
  const target = path.join(dir, 'item.json')
  const results = await Promise.all(Array.from({ length: 8 }, (_, w) => runWorker(['exclusive', target, `p${w}`])))
  for (const r of results) assert.equal(r.code, 0, r.err)
  const winners = results.map((r) => JSON.parse(r.out.trim())).filter((o) => o.won === true)
  assert.equal(winners.length, 1)
  const stored = JSON.parse(readFileSync(target, 'utf8'))
  assert.match(stored.id, /^p[0-7]$/)
  assert.deepEqual(readdirSync(dir).filter((n) => n !== 'item.json'), [], 'no tmp file left behind')
})

test('store: a lock held by a dead pid is taken over', async () => {
  const { withLock } = await load()
  const dir = tmp()
  plantLock(dir, 'inbox', { pid: deadPid(), host: 'h1', token: 'old-token', since: Date.now() })
  const got = withLock(dir, 'inbox', () => 'ran', { host: 'h1', waitMs: 2000 })
  assert.equal(got, 'ran')
  assert.equal(existsSync(lockPath(dir, 'inbox')), false, 'released after fn')
  assert.deepEqual(readdirSync(path.join(dir, 'locks')), [], 'no .stale-* leftovers')
})

test('store: 8 waiters racing to take over one stale lock never overlap and none is lost', async () => {
  // the window is narrow, so each round plants a fresh stale lock (a dead owner on this host) that all 8 waiters see at once
  for (let round = 0; round < 12; round++) {
    const dir = tmp()
    plantLock(dir, 'race', { pid: deadPid(), host: os.hostname(), token: `dead-token-${round}`, since: Date.now() })
    const file = path.join(dir, 'counter.txt')
    const results = await Promise.all(Array.from({ length: 8 }, () => runWorker(['counter', dir, 'race', file, '1'])))
    for (const r of results) assert.equal(r.code, 0, r.err)
    assert.equal(readFileSync(file, 'utf8'), '8', `round ${round}: an overlap lost an increment`)
    assert.deepEqual(readdirSync(path.join(dir, 'locks')), [], `round ${round}: no lock or .break leftovers`)
  }
})

test('store: a lock older than 200 s is taken over', async () => {
  const { withLock } = await load()
  const dir = tmp()
  // the owner pid is alive (this process), so only the age can make it stale
  plantLock(dir, 'ledger', { pid: process.pid, host: 'h1', token: 'old-token', since: Date.now() - 201_000 })
  const got = withLock(dir, 'ledger', () => 42, { host: 'h1', waitMs: 2000 })
  assert.equal(got, 42)
  assert.equal(existsSync(lockPath(dir, 'ledger')), false)
})

test('store: a busy lock throws StoreBusy with exit 2 after waitMs', async () => {
  const { withLock, StoreBusy, CliError } = await load()
  const dir = tmp()
  const lock = plantLock(dir, 'queue', { pid: process.pid, host: 'h1', token: 'live-token', since: Date.now() })
  let called = false
  const t0 = Date.now()
  let thrown: any
  try {
    withLock(dir, 'queue', () => (called = true), { host: 'h1', waitMs: 200 })
  } catch (e) {
    thrown = e
  }
  const waited = Date.now() - t0
  assert.ok(thrown instanceof StoreBusy, 'throws StoreBusy')
  assert.ok(thrown instanceof CliError, 'StoreBusy is a CliError')
  assert.equal(thrown.code, 2)
  assert.deepEqual(thrown.body, { error: 'store busy: queue' })
  assert.ok(waited >= 150, `waited ${waited} ms`)
  assert.equal(called, false)
  assert.ok(existsSync(lock), 'the live owner keeps its lock')
  assert.equal(JSON.parse(readFileSync(path.join(lock, 'owner.json'), 'utf8')).token, 'live-token')
})

test('store: writeJsonAtomic retries rename on EPERM through an injected fs', async () => {
  const { writeJsonAtomic } = await load()
  const dir = tmp()
  const target = path.join(dir, 'a.json')
  let calls = 0
  const fs = {
    renameSync: (a: string, b: string) => {
      calls++
      if (calls <= 3) throw fsErr('EPERM')
      renameSync(a, b)
    },
  }
  writeJsonAtomic(target, { n: 1 }, { fs })
  assert.equal(calls, 4)
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { n: 1 })
  assert.deepEqual(readdirSync(dir), ['a.json'], 'no tmp file left')
  // a persistent EPERM gives up and throws, after retrying
  let always = 0
  const stuck = { renameSync: () => { always++; throw fsErr('EPERM') } }
  assert.throws(() => writeJsonAtomic(path.join(dir, 'b.json'), { n: 2 }, { fs: stuck }), (e: any) => e.code === 'EPERM')
  assert.ok(always >= 10, `retried ${always} times`)
  // a non-retryable error is not retried
  let once = 0
  const bad = { renameSync: () => { once++; throw fsErr('ENOENT') } }
  assert.throws(() => writeJsonAtomic(path.join(dir, 'c.json'), { n: 3 }, { fs: bad }), (e: any) => e.code === 'ENOENT')
  assert.equal(once, 1)
})

test('store: lock release retries rm and never masks the result through an injected fs', async () => {
  const { withLock } = await load()
  const dir = tmp()
  const rmCalls: Array<{ p: string; o: any }> = []
  const fs = {
    rmSync: (p: string, o: any) => {
      rmCalls.push({ p: String(p), o })
      throw fsErr('EBUSY')
    },
  }
  assert.equal(withLock(dir, 'inbox', () => 'value', { fs }), 'value')
  assert.ok(rmCalls.length >= 1, 'release called rmSync')
  const rel = rmCalls.find((c) => c.p.replace(/\\/g, '/').endsWith('locks/inbox.lock'))
  assert.ok(rel, 'release removes the lock dir')
  assert.equal(rel.o.recursive, true)
  assert.equal(rel.o.maxRetries, 5)
  assert.equal(rel.o.retryDelay, 20)
  // fn's own error survives a failing release, unchanged
  rmSync(lockPath(dir, 'inbox'), { recursive: true, force: true })
  const boom = new Error('boom')
  let thrown: unknown
  try {
    withLock(dir, 'inbox', () => { throw boom }, { fs })
  } catch (e) {
    thrown = e
  }
  assert.equal(thrown, boom)
})

test('store: readJsonl tolerates CRLF and a BOM and skips a torn last line', async () => {
  const { readJsonl } = await load()
  const dir = tmp()
  const f = path.join(dir, 'r.jsonl')
  writeFileSync(f, '﻿{"a":1}\r\n{"a":2}\r\n{"a":3}\r\n{"a":4,"tor')
  const r = readJsonl(f)
  assert.deepEqual(r.rows, [{ a: 1 }, { a: 2 }, { a: 3 }])
  assert.equal(typeof r.bad, 'number')
  // LF only, a complete file, gives all rows
  writeFileSync(f, '{"a":1}\n{"a":2}\n')
  assert.deepEqual(readJsonl(f).rows, [{ a: 1 }, { a: 2 }])
})

test('store: transcriptsOf finds the main and agent transcripts with a null meta when it is absent', async () => {
  const { transcriptsOf } = await load()
  const root = tmp()
  const sid = '739d34ab-c391-4f99-92b8-66e3bb3d6025'
  const proj = path.join(root, '-home-x-proj')
  const subs = path.join(proj, sid, 'subagents')
  mkdirSync(path.join(subs, 'workflows', 'wf1'), { recursive: true })
  writeFileSync(path.join(proj, `${sid}.jsonl`), '{}\n')
  writeFileSync(path.join(proj, 'other-session.jsonl'), '{}\n')
  writeFileSync(path.join(subs, 'agent-a.jsonl'), '{}\n')
  writeFileSync(path.join(subs, 'agent-a.meta.json'), JSON.stringify({ agentType: 'builder' }))
  writeFileSync(path.join(subs, 'workflows', 'wf1', 'agent-b.jsonl'), '{}\n')
  const flat = (p: string): string => p.replace(/\\/g, '/')
  const t = transcriptsOf(sid, { TRUSS_TRANSCRIPTS_ROOT: root })
  assert.equal(flat(t.root), flat(root))
  assert.equal(flat(t.main), flat(path.join(proj, `${sid}.jsonl`)))
  assert.equal(t.agents.length, 2)
  const byName = Object.fromEntries(t.agents.map((a: any) => [path.basename(a.path), a]))
  assert.deepEqual(byName['agent-a.jsonl'].meta, { agentType: 'builder' })
  assert.equal(byName['agent-b.jsonl'].meta, null)
  // an unknown session has no main and no agents
  const none = transcriptsOf('00000000-0000-0000-0000-000000000000', { TRUSS_TRANSCRIPTS_ROOT: root })
  assert.equal(none.main, null)
  assert.deepEqual(none.agents, [])
})

test('store: commonDir outside git exits 2 with needs a git repo', async () => {
  const { commonDir, CliError } = await load()
  const dir = tmp()
  let thrown: any
  try {
    commonDir(dir)
  } catch (e) {
    thrown = e
  }
  assert.ok(thrown instanceof CliError, 'throws a CliError')
  assert.equal(thrown.code, 2)
  assert.match(String(thrown.body.error), /needs a git repo/)
})

test('store: darwin and win32 fixture paths flatten to forward slashes', async () => {
  const { flat } = await load()
  for (const platform of ['darwin', 'win32']) {
    assert.ok(PATHS[platform].length >= 2)
    for (const p of PATHS[platform]) {
      assert.equal(flat(p.raw), p.flat, `${platform}: ${p.raw}`)
      assert.ok(!flat(p.raw).includes('\\'))
    }
  }
})

test('store: withLock and the stale-lock takeover take the platform as a parameter and pass on win32 and darwin fixture paths', async () => {
  const { withLock, flat } = await load()
  for (const platform of ['darwin', 'win32']) {
    const dir = tmp()
    // a plain lock under the platform
    assert.equal(withLock(dir, 'inbox', () => platform, { platform, host: 'h1' }), platform)
    // a stale lock (dead pid) taken over under the platform
    plantLock(dir, 'ledger', { pid: deadPid(), host: 'h1', token: 't-old', since: Date.now() })
    assert.equal(withLock(dir, 'ledger', () => 'taken', { platform, host: 'h1', waitMs: 2000 }), 'taken')
    assert.equal(existsSync(lockPath(dir, 'ledger')), false)
    // a stale lock by age (injected clock) taken over under the platform
    plantLock(dir, 'queue', { pid: process.pid, host: 'h1', token: 't-age', since: 1_000 })
    assert.equal(withLock(dir, 'queue', () => 'aged', { platform, host: 'h1', now: () => 1_000 + 300_000, waitMs: 2000 }), 'aged')
    // fixture paths for this platform flatten
    for (const p of PATHS[platform]) assert.equal(flat(p.raw), p.flat)
    // a dead pid on another host is not stale: busy
    plantLock(dir, 'other', { pid: deadPid(), host: 'elsewhere', token: 't-far', since: Date.now() })
    assert.throws(() => withLock(dir, 'other', () => 1, { platform, host: 'h1', waitMs: 100 }), (e: any) => e.code === 2 && e.body.error === 'store busy: other')
  }
})

// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0015 Decision 3: the heavy lock, <dir>/resources/heavy.lock/ with owner.json.
// Written from the ADR before resources/index.ts exists.
//
// Run with: node --test tests/resources/heavy-lock.check.ts
// The producer is read from $TRUSS_CONTRACT_ROOT/resources/index.ts (default: the repo root).

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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

/** Runs fn with a fresh truss dir inside a mkdtemp parent; removes the parent after. */
async function withDir(fn: (dir: string, parent: string) => Promise<void> | void) {
  const parent = mkdtempSync(`${os.tmpdir()}/resources-heavy-`)
  const dir = `${parent}/truss`
  mkdirSync(dir)
  try {
    await fn(dir, parent)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

const lockOf = (dir: string) => `${dir}/resources/heavy.lock`
const ownerOf = (dir: string) => JSON.parse(readFileSync(`${lockOf(dir)}/owner.json`, 'utf8'))

/** The pid of a child that has already exited. */
function deadPid(): Promise<number> {
  return new Promise((res, rej) => {
    const c = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' })
    c.once('error', rej)
    c.once('exit', () => res(c.pid))
  })
}

test('first take wins, a second returns null while the first is held', async () => {
  const m = await load()
  await withDir((dir) => {
    const t1 = m.takeHeavySlot(dir, { label: 'a', slug: 'sa' })
    assert.equal(typeof t1, 'string')
    assert.ok(t1.length > 0, 'token is non-empty')
    const t2 = m.takeHeavySlot(dir, { label: 'b', slug: 'sb' })
    assert.equal(t2, null)
    assert.equal(ownerOf(dir).token, t1, 'the first owner still holds the lock')
  })
})

test('release with the wrong token leaves the lock; the right token frees it and a new take wins', async () => {
  const m = await load()
  await withDir((dir) => {
    const t1 = m.takeHeavySlot(dir, { label: 'a', slug: 'sa' })
    assert.ok(t1)
    m.releaseHeavySlot(dir, `${t1}-wrong`)
    assert.ok(existsSync(lockOf(dir)), 'wrong token leaves the lock')
    assert.equal(ownerOf(dir).token, t1)
    assert.equal(m.takeHeavySlot(dir, { label: 'b', slug: 'sb' }), null, 'still held')
    m.releaseHeavySlot(dir, t1)
    assert.ok(!existsSync(lockOf(dir)), 'right token removes the lock')
    const t3 = m.takeHeavySlot(dir, { label: 'c', slug: 'sc' })
    assert.equal(typeof t3, 'string')
    assert.ok(t3.length > 0)
    assert.notEqual(t3, t1, 'a new take gets a new token')
  })
})

test('owner.json holds pid, token, label, slug and since', async () => {
  const m = await load()
  await withDir((dir) => {
    const before = Date.now()
    const t = m.takeHeavySlot(dir, { label: 'build x', slug: 'slug-x' })
    const o = ownerOf(dir)
    for (const k of ['pid', 'token', 'label', 'slug', 'since']) assert.ok(k in o, `owner.json has ${k}: ${JSON.stringify(o)}`)
    assert.equal(o.pid, process.pid, 'pid defaults to process.pid')
    assert.equal(o.token, t)
    assert.equal(o.label, 'build x')
    assert.equal(o.slug, 'slug-x')
    assert.ok(o.since !== undefined && o.since !== null && o.since !== '')
    const since = typeof o.since === 'number' ? o.since : Date.parse(o.since)
    assert.ok(Number.isFinite(since), `since is a time: ${o.since}`)
    assert.ok(Math.abs(since - before) < 60000, `since is recent: ${o.since}`)
  })
})

test('owner.pid given by the caller is recorded', async () => {
  const m = await load()
  await withDir((dir) => {
    const t = m.takeHeavySlot(dir, { label: 'a', slug: 'sa', pid: process.pid })
    assert.ok(t)
    assert.equal(ownerOf(dir).pid, process.pid)
  })
})

test('a lock whose owner pid is dead is taken over', async () => {
  const m = await load()
  const pid = await deadPid()
  await withDir((dir) => {
    mkdirSync(lockOf(dir), { recursive: true })
    writeFileSync(`${lockOf(dir)}/owner.json`, JSON.stringify({ pid, token: 'old', label: 'old', slug: 'old', since: Date.now() }))
    const t = m.takeHeavySlot(dir, { label: 'new', slug: 'new' })
    assert.equal(typeof t, 'string', 'a dead owner does not hold the slot')
    assert.ok(t.length > 0)
    assert.notEqual(t, 'old')
    const o = ownerOf(dir)
    assert.equal(o.token, t)
    assert.equal(o.label, 'new')
  })
})

test('a lock with no owner.json and mtime older than 10 s is taken over', async () => {
  const m = await load()
  await withDir((dir) => {
    mkdirSync(lockOf(dir), { recursive: true })
    const old = new Date(Date.now() - 60000)
    utimesSync(lockOf(dir), old, old)
    const t = m.takeHeavySlot(dir, { label: 'new', slug: 'new' })
    assert.equal(typeof t, 'string')
    assert.ok(t.length > 0)
    assert.equal(ownerOf(dir).token, t)
  })
})

test('a lock with no owner.json and mtime younger than 10 s is not taken', async () => {
  const m = await load()
  await withDir((dir) => {
    mkdirSync(lockOf(dir), { recursive: true })
    const recent = new Date(Date.now() - 1000)
    utimesSync(lockOf(dir), recent, recent)
    const t = m.takeHeavySlot(dir, { label: 'new', slug: 'new' })
    assert.equal(t, null)
    assert.ok(!existsSync(`${lockOf(dir)}/owner.json`), 'the young lock is left alone')
  })
})

test('nothing is written outside <dir>/resources/', async () => {
  const m = await load()
  await withDir((dir, parent) => {
    const t = m.takeHeavySlot(dir, { label: 'a', slug: 'sa' })
    assert.equal(m.takeHeavySlot(dir, { label: 'b', slug: 'sb' }), null)
    m.releaseHeavySlot(dir, 'nope')
    m.releaseHeavySlot(dir, t)
    m.takeHeavySlot(dir, { label: 'c', slug: 'sc' })
    assert.deepEqual(readdirSync(dir), ['resources'], 'the truss dir holds only resources/')
    assert.deepEqual(readdirSync(parent), ['truss'], 'nothing next to the truss dir')
  })
})

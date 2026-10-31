// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0015 (resource-aware), Decision 1 and Seams to pin, section 1: the sampler module resources/index.ts.
// Written from the ADR before resources/index.ts exists.
//
// Run with: node --test tests/resources-contract.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs.
//
// The producer is read from $TRUSS_CONTRACT_ROOT/resources/index.ts. The default root is the repo root. With no
// producer the file prints `producer missing: resources`, whether the variable is unset or set to the repo root.
// The root is only a place to read the producer from: nothing here branches on its value or on what the producer holds.
// The negative controls (tests/fixtures/resources/admit-constant and min-free-ignored) run this file against a stub
// producer and must fail exactly their named case, so the two `case:` names below are the plan's strings.
//
// Every threshold and sample number is drawn per run, so a producer that admits always, or holds a fixed threshold,
// fails on the draw.

import assert from 'node:assert/strict'
import { randomInt } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const ROOT = (process.env.TRUSS_CONTRACT_ROOT || REPO_ROOT).replace(/\\/g, '/').replace(/\/$/, '')

/** Loads the producer; its absence fails as `producer missing: resources`. */
async function load(): Promise<any> {
  const p = `${ROOT}/resources/index.ts`
  if (!existsSync(p)) assert.fail(`producer missing: resources (no ${p})`)
  return await import(pathToFileURL(p).href)
}

/** Runs `fn` with TRUSS_SAMPLE set to `value` (or unset when undefined), then restores it. */
function withSample<T>(value: string | undefined, fn: () => T): T {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'TRUSS_SAMPLE')
  const old = process.env.TRUSS_SAMPLE
  if (value === undefined) delete process.env.TRUSS_SAMPLE
  else process.env.TRUSS_SAMPLE = value
  try {
    return fn()
  } finally {
    if (had) process.env.TRUSS_SAMPLE = old
    else delete process.env.TRUSS_SAMPLE
  }
}

/** A temp file holding `text`; returns its path and a remover. */
function sampleFile(text: string): { path: string; done: () => void } {
  const d = mkdtempSync(`${tmpdir()}/resources-contract-`)
  const path = `${d}/sample.json`
  writeFileSync(path, text)
  return { path: path.replace(/\\/g, '/'), done: () => rmSync(d, { recursive: true, force: true }) }
}

test('sample() with TRUSS_SAMPLE unset reads the real host', async () => {
  const m = await load()
  assert.equal(typeof m.sample, 'function', 'resources/index.ts exports sample()')
  const s = withSample(undefined, () => m.sample())
  const total = Math.round(os.totalmem() / 2 ** 20)
  assert.ok(Math.abs(s.totalMB - total) <= 1, `totalMB ${s.totalMB} is not within 1 of ${total}`)
  assert.ok(s.freeMB > 0, `freeMB ${s.freeMB} must be above 0`)
  assert.ok(s.freeMB <= s.totalMB, `freeMB ${s.freeMB} must not pass totalMB ${s.totalMB}`)
})

test('sample() with TRUSS_SAMPLE set to a file returns that sample; the word error throws', async () => {
  const m = await load()
  const freeMB = randomInt(100, 9000)
  const totalMB = freeMB + randomInt(100, 9000)
  const f = sampleFile(JSON.stringify({ freeMB, totalMB }))
  try {
    const s = withSample(f.path, () => m.sample())
    assert.equal(s.freeMB, freeMB)
    assert.equal(s.totalMB, totalMB)
  } finally {
    f.done()
  }
  assert.throws(() => withSample('error', () => m.sample()), 'TRUSS_SAMPLE=error forces a sampler error')
  assert.throws(() => withSample(`${tmpdir()}/no-such-sample-${randomInt(1e9)}.json`, () => m.sample()), 'an unreadable sample file is a sampler error')
  const bad = sampleFile(JSON.stringify({ freeMB: 'lots', totalMB }))
  try {
    assert.throws(() => withSample(bad.path, () => m.sample()), 'a sample of the wrong shape is a sampler error')
  } finally {
    bad.done()
  }
})

test('case: holds below the threshold', async () => {
  const m = await load()
  assert.equal(typeof m.admits, 'function', 'resources/index.ts exports admits()')
  const min = randomInt(1000, 9000)
  const total = 20000
  assert.equal(m.admits({ freeMB: min - 1, totalMB: total }, min), false, 'one MB below the threshold holds')
  assert.equal(m.admits({ freeMB: 0, totalMB: total }, min), false, 'no free memory holds')
  assert.equal(m.admits({ freeMB: min, totalMB: total }, min), true, 'exactly the threshold admits')
  assert.equal(m.admits({ freeMB: min + 1, totalMB: total }, min), true, 'above the threshold admits')
  // The same through the sampler: a sampled value below the threshold holds, one above admits.
  const low = sampleFile(JSON.stringify({ freeMB: min - 1, totalMB: total }))
  const high = sampleFile(JSON.stringify({ freeMB: min + 1, totalMB: total }))
  try {
    assert.equal(m.admits(withSample(low.path, () => m.sample()), min), false)
    assert.equal(m.admits(withSample(high.path, () => m.sample()), min), true)
  } finally {
    low.done()
    high.done()
  }
})

test('case: TRUSS_MIN_FREE_MB sets the threshold', async () => {
  const m = await load()
  assert.equal(typeof m.minFreeMB, 'function', 'resources/index.ts exports minFreeMB()')
  assert.equal(m.minFreeMB({ TRUSS_MIN_FREE_MB: '5000' }), 5000)
  const n = randomInt(1, 100000)
  assert.equal(m.minFreeMB({ TRUSS_MIN_FREE_MB: String(n) }), n, 'the env value is the threshold')
  assert.equal(typeof m.DEFAULT_MIN_FREE_MB, 'number', 'resources/index.ts exports DEFAULT_MIN_FREE_MB')
  assert.equal(m.minFreeMB({}), m.DEFAULT_MIN_FREE_MB, 'unset gives the default')
})

test('minFreeMB falls back to the default when the value is not a whole number', async () => {
  const m = await load()
  for (const bad of ['', 'abc', '12.5', '-5', '1e3', ' 7']) {
    assert.equal(m.minFreeMB({ TRUSS_MIN_FREE_MB: bad }), m.DEFAULT_MIN_FREE_MB, `TRUSS_MIN_FREE_MB=${JSON.stringify(bad)}`)
  }
})

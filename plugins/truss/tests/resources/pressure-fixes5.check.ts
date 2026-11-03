// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0026 seam 4 (crew agents-fixes5, item 57): pressureOf, the sample() pressure fields and the TRUSS_SAMPLE checks.
// The producer is read relative to this file, so a base-copy run reads the base code.
//
// Run with: node --test tests/resources/pressure-fixes5.check.ts

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ENTRY = fileURLToPath(new URL('../../resources/index.ts', import.meta.url))

function withDir(fn) {
  const d = mkdtempSync(join(tmpdir(), 'pressure-fixes5-'))
  try {
    return fn(d)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
}

const PSI = 'some avg10=12.50 avg60=8.00 avg300=3.00 total=123456\nfull avg10=3.00 avg60=2.00 avg300=1.00 total=654321\n'
const meminfo = (total, free) => `MemTotal:       16000000 kB\nMemFree:         8000000 kB\nSwapCached:            0 kB\nSwapTotal:      ${total} kB\nSwapFree:       ${free} kB\n`

function cleanEnv(extra = {}) {
  const e = { ...process.env }
  delete e.TRUSS_SAMPLE
  delete e.TRUSS_MIN_FREE_MB
  return { ...e, ...extra }
}

const cli = (env) => spawnSync(process.execPath, [ENTRY], { env, encoding: 'utf8', timeout: 30000 })

test('i57 1: pressureOf on fixture files gives memPressure from the some avg10 and the rounded swapUsedPct', async () => {
  const m = await import(pathToFileURL(ENTRY).href)
  withDir((d) => {
    writeFileSync(join(d, 'pressure'), PSI)
    writeFileSync(join(d, 'meminfo'), meminfo(3000, 1000))
    const r = m.pressureOf({ pressure: join(d, 'pressure'), meminfo: join(d, 'meminfo') })
    assert.equal(r.memPressure, 12.5)
    assert.equal(r.swapUsedPct, 67)
  })
})

test('i57 2: absent fixture paths give neither field, and SwapTotal 0 gives no swapUsedPct', async () => {
  const m = await import(pathToFileURL(ENTRY).href)
  withDir((d) => {
    const none = m.pressureOf({ pressure: join(d, 'no-pressure'), meminfo: join(d, 'no-meminfo') })
    assert.ok(!('memPressure' in none) && !('swapUsedPct' in none), JSON.stringify(none))
    writeFileSync(join(d, 'pressure'), PSI)
    writeFileSync(join(d, 'meminfo'), meminfo(0, 0))
    const noSwap = m.pressureOf({ pressure: join(d, 'pressure'), meminfo: join(d, 'meminfo') })
    assert.equal(noSwap.memPressure, 12.5)
    assert.ok(!('swapUsedPct' in noSwap), JSON.stringify(noSwap))
  })
})

test('i57 3: with TRUSS_SAMPLE unset, the sampler CLI prints a numeric memPressure when /proc/pressure/memory exists, else no field', () => {
  const p = cli(cleanEnv())
  assert.equal(p.status, 0, p.stderr)
  const s = JSON.parse(p.stdout)
  let readable = false
  try {
    readFileSync('/proc/pressure/memory', 'utf8')
    readable = true
  } catch {}
  if (readable) {
    assert.equal(typeof s.memPressure, 'number', p.stdout)
    assert.ok(s.memPressure >= 0 && s.memPressure <= 100, p.stdout)
  } else {
    assert.ok(!('memPressure' in s), p.stdout)
  }
})

test('i57 4: a TRUSS_SAMPLE fixture whose memPressure or swapUsedPct is a string, negative or above 100 is refused, and the sampler CLI exits non-zero', () => {
  withDir((d) => {
    const bad = [
      { memPressure: '5' }, { memPressure: -1 }, { memPressure: 101 },
      { swapUsedPct: '5' }, { swapUsedPct: -1 }, { swapUsedPct: 101 },
    ]
    for (const [i, extra] of bad.entries()) {
      const f = join(d, `s${i}.json`)
      writeFileSync(f, JSON.stringify({ freeMB: 4096, totalMB: 8192, cpus: 4, ...extra }))
      const p = cli(cleanEnv({ TRUSS_SAMPLE: f }))
      assert.notEqual(p.status, 0, `${JSON.stringify(extra)} was accepted: ${p.stdout}`)
    }
  })
})

test('control 1: i57 a TRUSS_SAMPLE fixture without the fields is returned without them', () => {
  withDir((d) => {
    const f = join(d, 's.json')
    const o = { freeMB: 4096, totalMB: 8192, cpus: 4 }
    writeFileSync(f, JSON.stringify(o))
    const p = cli(cleanEnv({ TRUSS_SAMPLE: f }))
    assert.equal(p.status, 0, p.stderr)
    const s = JSON.parse(p.stdout)
    assert.deepEqual(s, o)
    assert.ok(!('memPressure' in s) && !('swapUsedPct' in s))
  })
})

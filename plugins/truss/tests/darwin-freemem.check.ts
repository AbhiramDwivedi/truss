import assert from 'node:assert/strict'
import os from 'node:os'
import { test } from 'node:test'
import { darwinAvailableMB, sample } from '../resources/index.ts'

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     8815.
Pages active:                                 436443.
Pages inactive:                               434251.
Pages speculative:                              1907.
Pages throttled:                                   0.
Pages wired down:                             251271.
Pages purgeable:                                7148.
`
// (8815 + 434251 + 1907) pages * 16384 bytes / 1048576, rounded
const EXPECTED_MB = Math.round(((8815 + 434251 + 1907) * 16384) / 1048576)

function withoutSeam<T>(fn: () => T): T {
  const saved = process.env.TRUSS_SAMPLE
  delete process.env.TRUSS_SAMPLE
  try {
    return fn()
  } finally {
    if (saved !== undefined) process.env.TRUSS_SAMPLE = saved
  }
}

test('darwinAvailableMB counts free, inactive and speculative pages from vm_stat', () => {
  assert.equal(darwinAvailableMB(VM_STAT), EXPECTED_MB)
  assert.equal(darwinAvailableMB(''), null)
  assert.equal(darwinAvailableMB('Pages free: 5.\nPages inactive: 5.\n'), null)
  assert.equal(darwinAvailableMB('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: lots.\n'), null)
})

test('sample on darwin reports available memory, not only truly free pages', () => {
  const s = withoutSeam(() => sample({ platform: 'darwin', vmStat: () => VM_STAT }))
  assert.equal(s.freeMB, EXPECTED_MB)
})

test('sample on darwin falls back to os.freemem when vm_stat fails', () => {
  for (const vmStat of [() => { throw new Error('no vm_stat') }, () => 'garbage']) {
    const before = os.freemem() / 1048576
    const s = withoutSeam(() => sample({ platform: 'darwin', vmStat }))
    const after = os.freemem() / 1048576
    assert.ok(s.freeMB >= Math.floor(Math.min(before, after)) - 1 && s.freeMB <= Math.ceil(Math.max(before, after)) + 1)
    assert.notEqual(s.freeMB, EXPECTED_MB)
  }
})

test('sample on linux and win32 still reads os.freemem', () => {
  for (const platform of ['linux', 'win32'] as const) {
    let called = false
    const before = os.freemem() / 1048576
    const s = withoutSeam(() => sample({ platform, vmStat: () => { called = true; return VM_STAT } }))
    const after = os.freemem() / 1048576
    assert.equal(called, false)
    assert.ok(s.freeMB >= Math.floor(Math.min(before, after)) - 1 && s.freeMB <= Math.ceil(Math.max(before, after)) + 1)
  }
})

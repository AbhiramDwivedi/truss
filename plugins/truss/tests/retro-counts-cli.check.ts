// @ts-nocheck
// The counts tests run the counts function in-process (retro-counts-lib.ts); these few spawn the real CLI process.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { ev, mktmp, retro, runCli, runCounts, write } from './retro-counts-lib.ts'

describe('retro counts: the real CLI process', () => {
  test('a normal dir prints the same JSON the in-process call returns, exit 0', () => {
    const dir = mktmp()
    write(dir, 'events.jsonl', ev('2026-01-01T00:00:00Z', 'run-start', { goal: 'g' }) + '\n')
    const spawned = runCli([dir])
    assert.equal(spawned.code, 0)
    assert.equal(spawned.stderr, '')
    assert.equal(spawned.stdout, runCounts(dir).stdout)
    assert.equal(JSON.parse(spawned.stdout).retro, retro(dir).retro)
  })

  test('a missing dir exits 2 with retro: NO_TRUSS_DIR: on stderr', () => {
    const dir = join(mktmp(), 'absent')
    const r = runCli([dir])
    assert.equal(r.code, 2)
    assert.equal(r.stdout, '')
    assert.ok(r.stderr.startsWith('retro: NO_TRUSS_DIR:'), r.stderr)
  })

  test('a wrong argument count exits 2 with the usage line', () => {
    for (const args of [[], ['a', 'b']]) {
      const r = runCli(args)
      assert.equal(r.code, 2)
      assert.ok(r.stderr.startsWith('retro: usage:'), r.stderr)
    }
  })
})

// F-33: the test-time trend compares green runs of one command; a fast red first run is not a baseline.
// Fixtures are built in mkdtemp dirs; the default suite needs only node.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { problems } from '../retro/counts.ts'

type Json = Record<string, any>

function world(runs: { exit: number; ms: number; command?: string }[]): string {
  const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'retro-f33-')))
  mkdirSync(path.join(d, 'checks'), { recursive: true })
  const ts = '2026-11-12T00:00:00.000Z'
  writeFileSync(path.join(d, 'events.jsonl'), JSON.stringify({ v: 1, ts, event: 'spawn', crew: 'ca', agent: 'ca-builder', agentId: 'a1', type: 'general-purpose', model: 'opus', effort: 'medium', by: 'factory' }) + '\n')
  writeFileSync(path.join(d, 'usage.jsonl'), JSON.stringify({ v: 1, ts, sid: 's', agentId: 'a1', model: 'm', in: 1, out: 1, cr: 0, cw5m: 0, cw1h: 0 }) + '\n')
  runs.forEach((r, i) => writeFileSync(path.join(d, 'checks', `ca-${i + 1}.json`), JSON.stringify({ exit: r.exit, head: `h${i}`, command: r.command ?? 'npm test', tail: `# duration_ms ${r.ms}\n` })))
  return d
}
const trend = (d: string): Json[] => (problems(d).findings as Json[]).filter((f) => f.id.startsWith('P-tests-trend-'))

test('retro F-33: a fast red first run does not make later green runs of the same command look like growth', () => {
  const d = world([{ exit: 1, ms: 10000 }, { exit: 0, ms: 60000 }, { exit: 0, ms: 60000 }, { exit: 0, ms: 60000 }])
  assert.deepEqual(trend(d).map((f) => f.id), [], 'the green runs are flat')
})

test('retro F-33: growth across green runs of one command is still found, from the first green run', () => {
  const d = world([{ exit: 1, ms: 10000 }, { exit: 0, ms: 60000 }, { exit: 0, ms: 60000 }, { exit: 0, ms: 90000 }, { exit: 0, ms: 100000 }])
  const f = trend(d)
  assert.equal(f.length, 1)
  assert.equal(f[0]!.cost.wallMs, 70000, 'the excess over the first green run only')
})

test('retro F-33: runs of a different command are not compared with each other', () => {
  const d = world([{ exit: 0, ms: 10000, command: 'node --test one.check.ts' }, { exit: 0, ms: 60000 }, { exit: 0, ms: 60000 }, { exit: 0, ms: 60000 }])
  assert.deepEqual(trend(d).map((f) => f.id), [], 'the short targeted run is not the baseline of the full runs')
})

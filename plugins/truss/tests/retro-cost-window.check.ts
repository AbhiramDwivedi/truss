// The retro's cost measures cover the run window of `factory.ts cost` (the plan's approvedAt), not usage rows from before the run.
// Fixture built in a mkdtemp dir; the default suite needs only node.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { problems } from '../retro/counts.ts'

type Json = Record<string, any>

function world(): string {
  const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'retro-window-')))
  mkdirSync(path.join(d, 'checks'), { recursive: true })
  const T0 = Date.parse('2026-11-12T00:00:00Z')
  const at = (min: number): string => new Date(T0 + min * 60000).toISOString()
  writeFileSync(path.join(d, 'plan.json'), JSON.stringify({ v: 4, approvedAt: at(100), crews: [{ slug: 'alpha', owns: ['a/**'] }] }))
  const ev = [{ v: 1, ts: at(101), event: 'spawn', crew: 'alpha', agent: 'alpha-builder-1', agentId: 'sp1', type: 'general-purpose', model: 'opus', effort: 'medium', by: 'factory' }]
  writeFileSync(path.join(d, 'events.jsonl'), ev.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const row = (id: string, agent: string | undefined, out: number, min: number): Json => ({ v: 1, ts: at(min), sid: 's', agentId: id, ...(agent === undefined ? {} : { agent }), model: 'model-a', in: 0, out, cr: 0, cw5m: 0, cw1h: 0 })
  const rows = [
    row('old1', undefined, 1000000, 10), // before the run
    row('old2', 'mystery-agent', 2000000, 50),
    row('sp1', undefined, 1000, 101),
    row('m1', 'alpha-builder-2', 500, 102),
  ]
  writeFileSync(path.join(d, 'usage.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return d
}

test('retro cost window: usage rows before the plan approval are left out of every cost measure', () => {
  const m = problems(world()).measures as Record<string, number>
  assert.equal(m['cost.tokens.total'], 1500, 'only the two rows at or after approvedAt count')
  assert.equal(m['cost.tokens.alpha'], 1500)
  assert.equal(m['cost.tokens.unattributed'] ?? 0, 0, 'the pre-run rows are not reported as unattributed')
  assert.equal(m['cost.modelTokens.model-a'], 1500)
})

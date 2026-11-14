// F-37: a usage row of an agent with no spawn event is attributed by the agent name the row records, not all dumped in `unattributed`.
// Fixture built in a mkdtemp dir; the default suite needs only node.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { nameOfMeta } from '../bin/cost.ts'
import { problems } from '../retro/counts.ts'

type Json = Record<string, any>

function world(): string {
  const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'retro-f37-')))
  mkdirSync(path.join(d, 'checks'), { recursive: true })
  const T0 = Date.parse('2026-11-12T00:00:00Z')
  const at = (min: number): string => new Date(T0 + min * 60000).toISOString()
  writeFileSync(path.join(d, 'plan.json'), JSON.stringify({ v: 4, crews: [{ slug: 'stage-events', owns: ['a/**'] }, { slug: 'stage', owns: ['b/**'] }] }))
  const ev = [{ v: 1, ts: at(0), event: 'spawn', crew: 'stage-events', agent: 'stage-events-runner', agentId: 'sp1', type: 'general-purpose', model: 'opus', effort: 'medium', by: 'factory' }]
  writeFileSync(path.join(d, 'events.jsonl'), ev.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const row = (id: string, agent: string | undefined, out: number, min: number): Json => ({ v: 1, ts: at(min), sid: 's', agentId: id, ...(agent === undefined ? {} : { agent }), model: 'model-a', in: 0, out, cr: 0, cw5m: 0, cw1h: 0 })
  const rows = [
    row('sp1', undefined, 1000, 1),
    row('d1', 'stage-events-builder-1', 2000, 2),
    row('d2', 'stage-checker', 4000, 3),
    row('h1', 'hotfix-bug-h', 8000, 4),
    row('u1', 'mystery-agent', 16000, 5),
    row('u2', undefined, 32000, 6),
  ]
  writeFileSync(path.join(d, 'usage.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return d
}

test('retro F-37: the cost sweep records an agent name from its meta file, a bare label and never free text', () => {
  assert.equal(nameOfMeta({ name: 'stage-events-builder-1', description: 'x' }), 'stage-events-builder-1')
  assert.equal(nameOfMeta({ description: 'hotfix-bug-h' }), 'hotfix-bug-h')
  assert.equal(nameOfMeta({ description: 'Fix the retro counting bugs' }), undefined)
  assert.equal(nameOfMeta(null), undefined)
})

test('retro F-37: an agent with no spawn event is attributed by its name to a crew slug or a hotfix, and only unknown agents stay unattributed', () => {
  const m = problems(world()).measures as Record<string, number>
  const tok = (k: string): number => m[`cost.tokens.${k}`] ?? 0
  assert.equal(tok('stage-events'), 3000, 'spawned 1000 plus the direct builder 2000 sit in crew stage-events')
  assert.equal(tok('stage'), 4000, 'the longest slug that prefixes the name wins, so stage-checker is crew stage')
  assert.equal(tok('hotfix'), 8000, 'a hotfix agent is its own group')
  assert.equal(tok('unattributed'), 48000, 'an unknown name and a row with no name stay unattributed')
})

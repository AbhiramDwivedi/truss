// F-34: the owns-overlap pair findings charge each crew's conflict time once, so the pairs never add up to more than the crews' conflict time.
// Fixture: three crews with the same owns, each with a 10 minute resolver agent, in a real git repo made in a mkdtemp dir.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { problems } from '../retro/counts.ts'
import { analyze } from '../retro/timing.ts'

type Json = Record<string, any>
const MIN = 60000

function world(): string {
  const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'retro-f34-')))
  const r = spawnSync('git', ['init', '-q', repo], { windowsHide: true })
  assert.equal(r.status, 0)
  const d = path.join(repo, '.git', 'truss', 's1')
  mkdirSync(path.join(d, 'checks'), { recursive: true })
  const T0 = Date.parse('2026-11-12T00:00:00Z')
  const at = (min: number): string => new Date(T0 + min * MIN).toISOString()
  const slugs = ['ca', 'cb', 'cc']
  writeFileSync(path.join(d, 'plan.json'), JSON.stringify({ v: 4, crews: slugs.map((s) => ({ slug: s, owns: ['src/**'] })) }))
  const ev: Json[] = []
  const rows: Json[] = []
  slugs.forEach((s, i) => {
    ev.push({ v: 1, ts: at(0), event: 'spawn', crew: s, agent: `${s}-resolver`, agentId: `r${i}`, type: 'general-purpose', model: 'opus', effort: 'medium', by: 'workflow:wf_1' })
    rows.push({ v: 1, ts: at(1), sid: 's', agentId: `r${i}`, model: 'm', in: 1, out: 1, cr: 0, cw5m: 0, cw1h: 0 })
    rows.push({ v: 1, ts: at(11), sid: 's', agentId: `r${i}`, model: 'm', in: 1, out: 1, cr: 0, cw5m: 0, cw1h: 0 })
  })
  writeFileSync(path.join(d, 'events.jsonl'), ev.map((e) => JSON.stringify(e)).join('\n') + '\n')
  writeFileSync(path.join(d, 'usage.jsonl'), rows.map((e) => JSON.stringify(e)).join('\n') + '\n')
  return d
}

test('retro F-34: the owns-overlap pairs of three crews do not charge a crew conflict time once per pair', () => {
  const d = world()
  const crewConflict = (analyze(d).crews as Json[]).reduce((n, c) => n + Number(c.conflictMs), 0)
  assert.ok(crewConflict >= 30 * MIN, `the fixture has about 30 minutes of crew conflict time, got ${crewConflict}`)
  const pairs = (problems(d).findings as Json[]).filter((f) => f.id.startsWith('P-code-owns-'))
  assert.equal(pairs.length, 3, 'all three pairs overlap and are reported')
  const sum = pairs.reduce((n, f) => n + Number(f.cost.wallMs), 0)
  assert.ok(sum <= crewConflict, `pairs charge ${sum} ms in all, more than the crews' ${crewConflict} ms of conflict time`)
})

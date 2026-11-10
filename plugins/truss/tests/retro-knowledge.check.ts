// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0033 review fix: the retro's signal for optional learning. Each crew's `knowledge` event {crews' learned items members
// reported, whether the knowledge step ran} becomes the per-run key `knowledge`: {crews, items, ran, skipped}.
// Run with: node --test tests/retro-knowledge.check.ts
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { mktmp, NR, retro, write } from './retro-counts-lib.ts'

const HEAD = '## Run 2026-11-09T09:00:00Z | g\n'
const kn = (crew, items, ran, ts = '2026-11-09T09:30:00Z', kw = {}) => JSON.stringify({ v: 1, ts, event: 'knowledge', crew, items, ran, run: 'wf_1', ...kw })

describe('retro knowledge count', () => {
  let dir: string
  beforeEach(() => {
    dir = mktmp('retro-kn-')
  })
  const events = (lines: string[], head: string | null = HEAD) => {
    if (head !== null) write(dir, 'decisions.md', head)
    write(dir, 'events.jsonl', `${lines.join('\n')}\n`)
    return retro(dir)
  }

  test('crews, items and steps run versus skipped, summed over the crews of the run', () => {
    const out = events([kn('a', 2, true), kn('b', 0, false), kn('c', 3, false), kn('d', 0, true)])
    assert.deepEqual(out.runs[0].knowledge, { crews: 4, items: 5, ran: 2, skipped: 2 })
    assert.equal(out.eventsSkipped, 0)
  })

  test('a crew counts once: its later line (a resume) merges into the earlier one', () => {
    const out = events([kn('a', 0, false, '2026-11-09T09:10:00Z'), kn('a', 1, true, '2026-11-09T09:40:00Z')])
    assert.deepEqual(out.runs[0].knowledge, { crews: 1, items: 1, ran: 1, skipped: 0 })
  })

  test('review 13: a merge-ready resume line (ran false, items 0) after a line that ran keeps ran true and the larger item count', () => {
    const out = events([kn('a', 2, true, '2026-11-09T09:10:00Z'), kn('a', 0, false, '2026-11-09T09:40:00Z')])
    assert.deepEqual(out.runs[0].knowledge, { crews: 1, items: 2, ran: 1, skipped: 0 })
  })

  test('a log with no knowledge line says not recorded, never 0', () => {
    const out = events([JSON.stringify({ v: 1, ts: '2026-11-09T09:30:00Z', event: 'allowance-spent', crew: 'a', agent: 'a-qc-3' })])
    assert.equal(out.runs[0].knowledge, NR)
    assert.notEqual(out.runs[0].knowledge, 0)
  })

  test('a line with a bad items or ran adds nothing; it is not a skipped line', () => {
    const out = events([kn('a', -1, true), kn('b', 1.5, true), kn('c', 1, 'yes'), kn('', 1, true), kn(7, 1, true), kn('ok', 1, true)])
    assert.deepEqual(out.runs[0].knowledge, { crews: 1, items: 1, ran: 1, skipped: 0 })
    assert.equal(out.eventsSkipped, 0)
  })

  test('each run counts its own crews', () => {
    write(dir, 'decisions.md', `## Run 2026-11-09T09:00:00Z | g1\n\n## Run 2026-11-09T12:00:00Z | g2\n`)
    write(dir, 'events.jsonl', `${[kn('a', 1, true, '2026-11-09T09:30:00Z'), kn('a', 0, false, '2026-11-09T12:30:00Z'), kn('b', 2, true, '2026-11-09T12:31:00Z')].join('\n')}\n`)
    const out = retro(dir)
    assert.deepEqual(out.runs.map((r) => r.knowledge), [{ crews: 1, items: 1, ran: 1, skipped: 0 }, { crews: 2, items: 2, ran: 1, skipped: 1 }])
  })

  test('the key sits right after allowancesSpent and the old keys stay', () => {
    const keys = Object.keys(events([kn('a', 1, true)]).runs[0])
    assert.equal(keys[keys.indexOf('allowancesSpent') + 1], 'knowledge')
    assert.ok(keys.includes('fetches') && keys.includes('refusals'))
  })
})

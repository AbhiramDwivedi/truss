// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// Retro counts' 0.5.0 per-run key `allowancesSpent` (truss ADR-0004 sections 5 and 8, Seams 4), contract and edge
// cases. Ported from the Python test_contract_retro_050.py and test_retro_050.py.
//
// Readings where the ADR is silent follow retro-counts-edges.check.ts: retro skips only lines that are not JSON
// objects, not v 1, have no parsable ts, or exceed the line cap; wrong-typed or missing fields are ignored, not
// skipped. So an allowance line with a missing or non-string crew adds no crew and is not counted in eventsSkipped;
// extra keys or a missing agent do not matter, because retro counts distinct crews only.
// Fixtures: fixtures/contract-050/retro/ and fixtures/retro-050/ (synthetic); other data goes to temp dirs.
// Run with: node --test tests/retro-counts-050.check.ts
import assert from 'node:assert/strict'
import { cpSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import { FIXTURES, mktmp, NR, retro, write } from './retro-counts-lib.ts'

const ROOT = join(FIXTURES, 'contract-050', 'retro')
const FIX = join(FIXTURES, 'retro-050')
const HEAD = '## Run 2026-10-27T09:00:00Z | g\n'

const cache = new Map()
const fixture = (name: string) => {
  if (!cache.has(name)) cache.set(name, retro(join(ROOT, name)))
  return cache.get(name)
}
const run0 = (name: string) => {
  const runs = fixture(name).runs
  assert.equal(runs.length, 1, `fixture ${name} should yield one run`)
  return runs[0]
}

describe('contract: allowancesSpent', () => {
  test('two crews, one twice, counts distinct crews', () => {
    const run = run0('spent')
    assert.ok('allowancesSpent' in run)
    assert.equal(run.allowancesSpent, 2)
  })

  test('a run with events but no allowance line is not recorded, never zero', () => {
    const run = run0('none')
    assert.ok('allowancesSpent' in run)
    assert.equal(run.allowancesSpent, NR)
    assert.notEqual(run.allowancesSpent, 0)
  })

  test('a run without events is not recorded', () => {
    const run = run0('noevents')
    assert.ok('allowancesSpent' in run)
    assert.equal(run.allowancesSpent, NR)
  })

  test('allowancesSpent is a per-run key after qcs', () => {
    assert.ok(!('allowancesSpent' in fixture('spent')), 'allowancesSpent is per run, not top level')
    const keys = Object.keys(run0('spent'))
    assert.ok(keys.includes('allowancesSpent'))
    assert.ok(keys.includes('qcs'))
    assert.equal(keys.indexOf('allowancesSpent'), keys.indexOf('qcs') + 1)
  })

  test('the retro version stays 1', () => {
    for (const name of ['spent', 'none', 'noevents']) assert.equal(fixture(name).retro, 1, name)
  })

  test('top-level keys are unchanged', () => {
    const want = ['leftovers', 'leftoverDetails', 'retro', 'dir', 'split', 'runs', 'qcFiles', 'plan', 'eventsSkipped', 'eventsOutsideRuns']
    assert.deepEqual(Object.keys(fixture('spent')).sort(), want.sort())
  })

  test('spawns are counted from spawn lines only', () => {
    // Spawn lines gain no keys; the allowance-spent lines are not spawns.
    const run = run0('spent')
    assert.ok('allowancesSpent' in run, 'fixture must be read as a 0.5.0 run')
    assert.deepEqual(run.spawns, { total: 3, byModelEffort: { 'opus/high': 1, 'sonnet/medium': 2 } })
  })

  test('allowance lines are not skipped as malformed', () => {
    const out = fixture('spent')
    assert.ok('allowancesSpent' in out.runs[0], 'fixture must be read as a 0.5.0 run')
    assert.equal(out.eventsSkipped, 0)
    assert.equal(out.eventsOutsideRuns, 0)
  })
})

const bl = (ts: string, crew: unknown = 'auth', kw = {}) =>
  JSON.stringify({ v: 1, ts, event: 'allowance-spent', crew, agent: `${crew}-qc-3`, ...kw })
const sp = (ts: string, crew = 'auth') =>
  JSON.stringify({ v: 1, ts, event: 'spawn', crew, agent: crew, agentId: 'x', type: 'truss:foreman', model: 'opus', effort: 'high', by: 'main' })

describe('fixtures', () => {
  test('an allowance line in the second run belongs to the second run only', () => {
    const out = retro(join(FIX, 'tworuns'))
    const [first, second] = out.runs
    assert.equal(first.allowancesSpent, NR)
    assert.equal(second.allowancesSpent, 1)
    assert.equal(first.spawns.total, 1)
    assert.equal(second.spawns.total, 1)
    assert.equal(out.eventsSkipped, 0)
  })

  test('the same crew in two events files counts once and a new crew adds one', () => {
    // events.1.jsonl: auth; events.jsonl: auth (other agent) and billing.
    const out = retro(join(FIX, 'twofiles'))
    assert.equal(out.runs[0].allowancesSpent, 2)
    assert.equal(out.eventsSkipped, 0)
  })
})

describe('edges', () => {
  let dir: string
  beforeEach(() => {
    dir = mktmp('retro050-')
  })
  const put = (name: string, data: string | Buffer) => write(dir, name, data)
  const events = (lines: string[], head: string | null = HEAD) => {
    if (head !== null) put('decisions.md', head)
    put('events.jsonl', `${lines.join('\n')}\n`)
    return retro(dir)
  }

  test('a single allowance line is one', () => {
    assert.equal(events([bl('2026-10-27T09:30:00Z')]).runs[0].allowancesSpent, 1)
  })

  test('repeated lines for one crew stay one', () => {
    const out = events([0, 1, 2, 3, 4].map((i) => bl(`2026-10-27T09:3${i}:00Z`)))
    assert.equal(out.runs[0].allowancesSpent, 1)
  })

  test('the same crew name with different agents is one crew', () => {
    const out = events([bl('2026-10-27T09:30:00Z', 'auth', { agent: 'auth-qc-3' }), bl('2026-10-27T09:31:00Z', 'auth', { agent: 'auth-qc-4' })])
    assert.equal(out.runs[0].allowancesSpent, 1)
  })

  test('distinct crew values are distinct', () => {
    const out = events([bl('2026-10-27T09:30:00Z', 'auth'), bl('2026-10-27T09:31:00Z', 'auth-2')])
    assert.equal(out.runs[0].allowancesSpent, 2)
  })

  test('the same crew in two runs counts in each', () => {
    put('decisions.md', `${HEAD}## Run 2026-10-27T12:00:00Z | g2\n`)
    put('events.jsonl', `${bl('2026-10-27T09:30:00Z')}\n${bl('2026-10-27T12:30:00Z')}\n`)
    assert.deepEqual(retro(dir).runs.map((r) => r.allowancesSpent), [1, 1])
  })

  test('an allowance line before the first heading is outside every run', () => {
    const out = events([bl('2026-10-27T08:00:00Z'), sp('2026-10-27T09:01:00Z')])
    assert.equal(out.eventsOutsideRuns, 1)
    assert.equal(out.runs[0].allowancesSpent, NR)
  })

  test('allowance lines without a run heading are not recorded', () => {
    const out = events([bl('2026-10-27T09:30:00Z')], '- 09:00 | a | b | c | followed\n')
    const run = out.runs[0]
    assert.equal(out.split, NR)
    assert.ok('allowancesSpent' in run)
    assert.equal(run.allowancesSpent, NR)
    assert.equal(out.eventsOutsideRuns, 1)
  })

  test('an allowance line with an extra key still counts', () => {
    const out = events([bl('2026-10-27T09:30:00Z', 'auth', { reason: 'x', n: 3 })])
    assert.equal(out.runs[0].allowancesSpent, 1)
    assert.equal(out.eventsSkipped, 0)
  })

  test('an allowance line missing agent still counts its crew', () => {
    const d = JSON.parse(bl('2026-10-27T09:30:00Z'))
    delete d.agent
    const out = events([JSON.stringify(d)])
    assert.equal(out.runs[0].allowancesSpent, 1)
    assert.equal(out.eventsSkipped, 0)
  })

  test('allowance lines with a missing or wrong-typed crew add no crew and are not skipped', () => {
    const d = JSON.parse(bl('2026-10-27T09:30:00Z'))
    delete d.crew
    const out = events([
      JSON.stringify(d),
      bl('2026-10-27T09:31:00Z', ['auth'], { agent: 'x' }),
      bl('2026-10-27T09:32:00Z', { a: 1 }, { agent: 'x' }),
      bl('2026-10-27T09:33:00Z', 'billing'),
    ])
    assert.equal(out.runs[0].allowancesSpent, 1)
    assert.equal(out.eventsSkipped, 0)
  })

  test('an allowance line with a bad ts or the wrong v is skipped and not counted', () => {
    const wrongV = JSON.stringify({ v: 2, ts: '2026-10-27T09:30:00Z', event: 'allowance-spent', crew: 'y', agent: 'y-qc' })
    const out = events([bl('not a time', 'x'), wrongV, bl('2026-10-27T09:30:00Z', 'auth')])
    assert.equal(out.eventsSkipped, 2)
    assert.equal(out.runs[0].allowancesSpent, 1)
  })

  test('only skipped allowance lines leave not recorded', () => {
    assert.equal(events([bl('garbage', 'x')]).runs[0].allowancesSpent, NR)
  })

  test('allowance lines are not spawns and do not move other categories', () => {
    const base = events([sp('2026-10-27T09:01:00Z')]).runs[0]
    const withAllowance = events([sp('2026-10-27T09:01:00Z'), bl('2026-10-27T09:30:00Z')]).runs[0]
    assert.equal(withAllowance.allowancesSpent, 1)
    for (const k of Object.keys(base)) if (k !== 'allowancesSpent') assert.deepEqual(base[k], withAllowance[k], k)
    assert.equal(withAllowance.spawns.total, 1)
  })

  test('a spawns-only run is not recorded, not zero', () => {
    assert.equal(events([sp('2026-10-27T09:01:00Z')]).runs[0].allowancesSpent, NR)
  })

  test('an empty events file with a heading is not recorded, never zero', () => {
    put('decisions.md', HEAD)
    put('events.jsonl', '')
    const run = retro(dir).runs[0]
    assert.equal(run.allowancesSpent, NR)
    assert.deepEqual(run.stalls, { agent: 0, idleForeman: 0 })
  })

  test('allowancesSpent comes right after qcs and the old keys remain', () => {
    const keys = Object.keys(events([bl('2026-10-27T09:30:00Z')]).runs[0])
    assert.equal(keys[keys.indexOf('qcs') + 1], 'allowancesSpent')
    assert.deepEqual(keys, Object.keys(retro(join(FIX, 'twofiles')).runs[0]))
  })

  test('the key is present on every run even without events', () => {
    put('decisions.md', `${HEAD}## Run 2026-10-27T12:00:00Z | g2\n`)
    for (const run of retro(dir).runs) {
      const keys = Object.keys(run)
      assert.ok(keys.includes('allowancesSpent'))
      assert.equal(run.allowancesSpent, NR)
      assert.equal(keys[keys.indexOf('qcs') + 1], 'allowancesSpent')
    }
  })

  test('the retro version stays 1 with allowance lines', () => {
    assert.equal(events([bl('2026-10-27T09:30:00Z')]).retro, 1)
  })

  test('an oversize allowance line is skipped by the line cap', () => {
    put('decisions.md', HEAD)
    const big = Buffer.concat([
      Buffer.from('{"v":1,"ts":"2026-10-27T09:30:00Z","event":"allowance-spent","crew":"big","agent":"'),
      Buffer.alloc(3 << 20, 'x'),
      Buffer.from('"}\n'),
    ])
    put('events.jsonl', Buffer.concat([big, Buffer.from(`${bl('2026-10-27T09:31:00Z')}\n`)]))
    const out = retro(dir)
    assert.equal(out.eventsSkipped, 1)
    assert.equal(out.runs[0].allowancesSpent, 1)
  })

  test('the script writes nothing into the truss dir', () => {
    const snapshot = (root: string) => {
      const snap: Record<string, unknown> = {}
      const walk = (d: string) => {
        for (const n of readdirSync(d)) {
          const p = join(d, n)
          const st = statSync(p)
          if (st.isDirectory()) {
            snap[relative(root, p)] = null
            walk(p)
          } else snap[relative(root, p)] = [st.size, st.mtimeMs, readFileSync(p).toString('base64')]
        }
      }
      walk(root)
      return snap
    }
    const d = join(dir, 'd')
    cpSync(join(FIX, 'tworuns'), d, { recursive: true })
    const before = snapshot(d)
    assert.equal(retro(d).runs[1].allowancesSpent, 1)
    assert.deepEqual(snapshot(d), before)
  })
})

// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// Retro counts' 0.8.0 per-run keys, truss ADR-0005 (growth model) point 4: `fetches` {total, perAgent},
// `extendPasses`, `defaultDecisions`, `openClientActions`, each "not recorded" where its source is absent; and the
// per-run `refusals` counts (P24: counts only, never a body). Ported from the Python test_contract_retro_080.py,
// test_retro_080.py and test_retro_refusals.py.
//
// Fixtures are synthetic (fixtures/contract-080/data); the contract suite builds throwaway git repos in a tempdir
// from them, with a fixed author and dates. Session dir = <repo>/.git/truss/<session>, as for the leftovers
// contract. Run 1 window starts 2026-10-27T09:00Z, run 2 starts 2026-10-28T09:00Z.
// Run with: node --test tests/retro-counts-080.check.ts
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { before, beforeEach, describe, test } from 'node:test'
import { FIXTURES, git, mktmp, NR, retro, write } from './retro-counts-lib.ts'

const DATA = join(FIXTURES, 'contract-080', 'data')

// (iso date, subject). Run 1 should count the 2 matching ones inside its window; run 2 the last one.
const COMMITS = [
  ['2026-10-26T09:00:00Z', 'docs(arch): extend before-window'],
  ['2026-10-27T09:30:00Z', 'docs(arch): extend payments'],
  ['2026-10-27T10:00:00Z', 'docs(arch): adopt learned items'],
  ['2026-10-27T11:00:00Z', 'docs(arch): extension notes'],
  ['2026-10-27T11:30:00Z', 'docs(arch): adopt learned item'],
  ['2026-10-27T12:00:00Z', 'feat: extend something'],
  ['2026-10-28T10:00:00Z', 'docs(arch): extend search'],
]

const copy = (name: string, dest: string) => {
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(join(DATA, name), dest)
}

describe('contract', () => {
  let tmp: string
  let full: string
  let bare: string
  const cache = new Map()

  // full: config, architecture doc, ADRs and the extend commits. Otherwise a bare repo with one commit.
  const makeRepo = (name: string, events: string, isFull: boolean): string => {
    const repo = join(tmp, name)
    mkdirSync(repo)
    git(repo, '2026-10-01T00:00:00Z', 'init', '-q')
    git(repo, '2026-10-01T00:00:00Z', 'commit', '-q', '--allow-empty', '-m', 'chore: start')
    const sess = join(repo, '.git', 'truss', '2026-10-27-run')
    copy('decisions.md', join(sess, 'decisions.md'))
    copy(events, join(sess, 'events.jsonl'))
    if (isFull) {
      write(repo, join('.claude', 'truss.json'), JSON.stringify({ architecture: 'docs/architecture.md', adr: 'docs/adr' }))
      copy('architecture.md', join(repo, 'docs', 'architecture.md'))
      for (const f of readdirSync(join(DATA, 'adr')).sort()) copy(join('adr', f), join(repo, 'docs', 'adr', f))
      for (const [date, subject] of COMMITS) git(repo, date, 'commit', '-q', '--allow-empty', '-m', subject)
    }
    return sess
  }

  before(() => {
    tmp = mktmp('retro080-')
    full = makeRepo('full', 'events-fetch.jsonl', true)
    bare = makeRepo('bare', 'events-nofetch.jsonl', false)
  })

  const runs = (sess: string) => {
    if (!cache.has(sess)) cache.set(sess, retro(sess).runs)
    return cache.get(sess)
  }
  const run1 = (sess: string) => {
    const r = runs(sess)
    assert.equal(r.length, 2, 'fixture should yield two runs')
    return r[0]
  }

  test('fetches total and per agent', () => {
    const run = run1(full)
    assert.ok('fetches' in run)
    assert.deepEqual(run.fetches, { total: 3, perAgent: { 'alpha-designer': 2, 'alpha-writer': 1 } })
  })

  test('fetches without fetch lines is not recorded, never zero', () => {
    const run = run1(bare)
    assert.ok('fetches' in run)
    assert.equal(run.fetches, NR)
  })

  test('extendPasses counts only matching subjects inside the window', () => {
    const run = run1(full)
    assert.ok('extendPasses' in run)
    assert.equal(run.extendPasses, 2)
  })

  test('extendPasses for the second run window', () => {
    const run = runs(full)[1]
    assert.ok('extendPasses' in run)
    assert.equal(run.extendPasses, 1)
  })

  test('defaultDecisions counts ADRs with the line', () => {
    const run = run1(full)
    assert.ok('defaultDecisions' in run)
    assert.equal(run.defaultDecisions, 2)
  })

  test('defaultDecisions without an ADR dir is not recorded', () => {
    const run = run1(bare)
    assert.ok('defaultDecisions' in run)
    assert.equal(run.defaultDecisions, NR)
  })

  test('openClientActions counts open boxes under Client actions only', () => {
    // 2 open under "Client actions", 3 done (not counted), 1 open under "Notes" (not counted)
    const run = run1(full)
    assert.ok('openClientActions' in run)
    assert.equal(run.openClientActions, 2)
  })

  test('openClientActions without an architecture doc is not recorded', () => {
    const run = run1(bare)
    assert.ok('openClientActions' in run)
    assert.equal(run.openClientActions, NR)
  })
})

const DECISIONS =
  '# Decisions\n## Run 2026-10-27T09:00:00Z | first\n- 09:05 | a | b | checker: none | followed\n' +
  '## Run 2026-10-28T09:00:00Z | second\n- 09:05 | a | b | checker: none | followed\n'
const SPAWN =
  '{"v":1,"ts":"2026-10-27T09:01:00.000Z","event":"spawn","crew":"c","agent":"c","agentId":"e0",' +
  '"type":"x","model":"opus","effort":"high","by":"main"}\n'

const fetchLine = (ts: string, agent: string | null = 'c-writer') => {
  const e: Record<string, unknown> = { v: 1, ts, event: 'fetch', crew: 'c', tool: 'WebFetch', url: 'https://docs.invalid/x' }
  if (agent !== null) e.agent = agent
  return `${JSON.stringify(e)}\n`
}

describe('edges', () => {
  let tmp: string
  let n: number
  beforeEach(() => {
    tmp = mktmp('retro080x-')
    n = 0
  })

  const repo = (events: string, files: Record<string, string> = {}, commits: string[][] = []) => {
    n++
    const r = join(tmp, `r${n}`)
    mkdirSync(r)
    git(r, '2026-10-01T00:00:00Z', 'init', '-q')
    git(r, '2026-10-01T00:00:00Z', 'commit', '-q', '--allow-empty', '-m', 'chore: start')
    for (const [rel, data] of Object.entries(files)) write(r, rel, data)
    for (const [date, subject] of commits) git(r, date, 'commit', '-q', '--allow-empty', '-m', subject)
    const sess = join(r, '.git', 'truss', 's')
    write(sess, 'decisions.md', DECISIONS)
    write(sess, 'events.jsonl', events)
    return sess
  }
  const runsOf = (sess: string) => retro(sess).runs

  test('fetches only in run two', () => {
    const sess = repo(SPAWN + fetchLine('2026-10-28T10:00:00.000Z') + fetchLine('2026-10-28T10:01:00.000Z', null))
    const [a, b] = runsOf(sess)
    assert.deepEqual(a.fetches, { total: 0, perAgent: {} })
    assert.deepEqual(b.fetches, { total: 2, perAgent: { 'c-writer': 1, unset: 1 } })
  })

  test('an outside-repo layout is not recorded', () => {
    const sess = join(tmp, 'plain', 's')
    write(sess, 'decisions.md', DECISIONS)
    write(sess, 'events.jsonl', SPAWN + fetchLine('2026-10-27T10:00:00.000Z'))
    const runs = runsOf(sess)
    for (const run of runs) {
      assert.equal(run.extendPasses, NR)
      assert.equal(run.defaultDecisions, NR)
      assert.equal(run.openClientActions, NR)
    }
    assert.equal(runs[0].fetches.total, 1)
  })

  test('git readable without a matching subject is zero', () => {
    const sess = repo(SPAWN, {}, [['2026-10-27T10:00:00Z', 'feat: extend nothing']])
    assert.deepEqual(runsOf(sess).map((r) => r.extendPasses), [0, 0])
  })

  test('an adr key pointing at a missing dir is not recorded', () => {
    const sess = repo(SPAWN, { '.claude/truss.json': JSON.stringify({ adr: 'docs/nope' }) })
    assert.equal(runsOf(sess)[0].defaultDecisions, NR)
  })

  test('a CRLF ADR counts and non-md files are ignored', () => {
    const sess = repo(SPAWN, {
      '.claude/truss.json': JSON.stringify({ adr: 'adr' }),
      'adr/0001-a.md': '# A\r\nDecided by: default\r\n',
      'adr/0002-b.md': '# B\r\nDecided by: client\r\n',
      'adr/notes.txt': 'Decided by: default\n',
    })
    assert.equal(runsOf(sess)[0].defaultDecisions, 1)
  })

  test('checked boxes and boxes under other headings are not counted', () => {
    const doc =
      '# Arch\n## Notes\n- [ ] not mine\n## Client actions\n- [x] done\n- [ ] open one\n' +
      '- [ ] open two\n### Sub\n- [ ] under sub heading\n# Client actions\r\n- [ ] top level\r\n'
    const sess = repo(SPAWN, { '.claude/truss.json': JSON.stringify({ architecture: 'arch.md' }), 'arch.md': doc })
    assert.equal(runsOf(sess)[0].openClientActions, 3)
  })
})

// retro's per-run "refusals" counts, from the hooks' refusal lines (P24: counts only, never a body)
describe('refusals', () => {
  let sess: string
  beforeEach(() => {
    sess = join(mktmp('retrorefusals-'), 's')
    write(sess, 'decisions.md', DECISIONS)
  })

  const refusal = (ts: string, o: Record<string, unknown> = {}) =>
    `${JSON.stringify({
      v: 1, ts, event: 'refusal', crew: 'c', agent: 'c-builder', tool: 'Bash', source: 'worktree-guard',
      category: 'is too complex to verify that it stays inside the worktree', program: 'cat', shape: ['heredoc'], ...o,
    })}\n`
  const runsOf = (events: string) => {
    write(sess, 'events.jsonl', events)
    return retro(sess).runs
  }

  test('counts by source, tool, category, program and shape per run', () => {
    const [a, b] = runsOf(
      SPAWN +
        refusal('2026-10-27T10:00:00.000Z') +
        refusal('2026-10-27T10:01:00.000Z', { shape: ['heredoc', 'compound'], program: 'mkdir' }) +
        refusal('2026-10-27T10:02:00.000Z', { source: 'classifier', tool: 'Write', category: 'no verdict', program: null, shape: [] }) +
        refusal('2026-10-28T10:00:00.000Z', {
          source: 'truss', tool: 'Workflow', category: "truss agents run in a Workflow only from the plugin's plan.js and stage.js",
          program: null, shape: [],
        }),
    )
    assert.deepEqual(a.refusals, {
      total: 3,
      bySource: { 'worktree-guard': 2, classifier: 1 },
      byTool: { Bash: 2, Write: 1 },
      byCategory: { 'worktree-guard: is too complex to verify that it stays inside the worktree': 2, 'classifier: no verdict': 1 },
      byProgram: { cat: 1, mkdir: 1 },
      byShape: { heredoc: 2, compound: 1 },
    })
    assert.equal(b.refusals.total, 1)
    assert.deepEqual(b.refusals.bySource, { truss: 1 })
    assert.deepEqual(b.refusals.byProgram, {})
  })

  test('no refusal line is not recorded, never zero', () => {
    for (const run of runsOf(SPAWN)) assert.equal(run.refusals, NR)
  })

  test('a run with none beside one with some is zero', () => {
    const [a, b] = runsOf(SPAWN + refusal('2026-10-28T10:00:00.000Z'))
    assert.equal(a.refusals.total, 0)
    assert.equal(b.refusals.total, 1)
  })

  test('odd fields count as unset and never break the count', () => {
    const bad = { v: 1, ts: '2026-10-27T10:00:00.000Z', event: 'refusal', crew: 'c', agent: 'x', tool: 'Bash', source: 7, program: '', shape: 'heredoc' }
    const [a] = runsOf(`${SPAWN}${JSON.stringify(bad)}\n`)
    assert.deepEqual(a.refusals.bySource, { unset: 1 })
    assert.deepEqual(a.refusals.byCategory, { 'unset: unset': 1 })
    assert.deepEqual(a.refusals.byProgram, { unset: 1 })
    assert.deepEqual(a.refusals.byShape, {})
  })

  test('no text beyond the line fields is printed', () => {
    const line = JSON.parse(refusal('2026-10-27T10:00:00.000Z'))
    line.command = "cat > x <<'EOF' TOPSECRET"
    const runs = runsOf(`${SPAWN}${JSON.stringify(line)}\n`)
    assert.ok(!JSON.stringify(runs).includes('TOPSECRET'))
  })
})

// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// The `leftovers` key of truss's retro counts. Ported from the Python test_contract_leftovers.py and
// test_retro_leftovers.py.
//
// Spec: the JSON has a top-level "leftovers". For a session dir D = <git common dir>/truss/<session>, every distinct
// agentId of a `spawn` event in D/events.jsonl may leave a branch `worktree-agent-<id>` and a folder
// `.claude/worktrees/agent-<id>` (relative to the main checkout). leftovers is {"branches": [sorted],
// "folders": [sorted, forward slashes, relative], "count": distinct agent ids with a branch or a folder or both}.
// Other sessions' agents never count, slots.json is never read, the repo is never changed. A dir not in that shape
// gives the string "not recorded". Fixtures under fixtures/leftovers are synthetic (P8); the rest are temp git repos.
// Run with: node --test tests/retro-counts-leftovers.check.ts
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import { CLI, FIXTURES, mktmp, NR, repoGit as git, retro, runCounts, TOP_KEYS, write } from './retro-counts-lib.ts'

const FIX = join(FIXTURES, 'leftovers')
const SESSION = '2026-10-27-run'
const A = 'a0123456789abcdef' // spawned in spawn-one and spawn-two
const B = 'a1fedcba98765432' // spawned in spawn-two only
const C = 'a2468ace13579bdf' // never spawned in D: another session's agent
const D2 = 'a13579bdf2468ace' // never spawned in D: another session's agent
const EMPTY = { branches: [], folders: [], count: 0 }
const TS = '2026-10-27T09:01:00.000Z'

const br = (i: string) => `worktree-agent-${i}`
const fo = (i: string) => `.claude/worktrees/agent-${i}`

let tmp: string
let repo: string
let session: string
beforeEach(() => {
  tmp = mktmp('leftovers-')
  repo = join(tmp, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q')
  writeFileSync(join(repo, 'f.txt'), 'x\n')
  git(repo, 'add', 'f.txt')
  git(repo, 'commit', '-q', '-m', 'one')
})

const addBranch = (i: string) => git(repo, 'branch', br(i))
const addDir = (i: string) => mkdirSync(join(repo, ...fo(i).split('/')), { recursive: true })
const addWorktree = (i: string, branch: boolean) => {
  const args = ['worktree', 'add', '-q', ...(branch ? ['-b', br(i)] : ['--detach'])]
  git(repo, ...args, join(repo, ...fo(i).split('/')))
}
const leftovers = (path: string, env?: Record<string, string>) => {
  const out = retro(path, { env })
  assert.ok('leftovers' in out, 'producer missing: counts emit no leftovers key')
  return out.leftovers
}
const repoState = () => [git(repo, 'for-each-ref'), git(repo, 'worktree', 'list', '--porcelain')]

describe('contract', () => {
  const sess = () => join(repo, '.git', 'truss', SESSION)
  const putEvents = (kase: string, dest = sess()) => {
    mkdirSync(dest, { recursive: true })
    copyFileSync(join(FIX, kase, 'events.jsonl'), join(dest, 'events.jsonl'))
    return dest
  }
  const slotsJson = () => {
    const slots = join(repo, '.git', 'claude-worktrees', 'slots.json')
    mkdirSync(join(repo, '.git', 'claude-worktrees'), { recursive: true })
    copyFileSync(join(FIX, 'slots.json'), slots)
  }

  test('branch only', () => {
    putEvents('spawn-one')
    addBranch(A)
    assert.deepEqual(leftovers(sess()), { branches: [br(A)], folders: [], count: 1 })
  })

  test('folder only, a real worktree', () => {
    putEvents('spawn-one')
    addWorktree(A, false)
    assert.deepEqual(leftovers(sess()), { branches: [], folders: [fo(A)], count: 1 })
  })

  test('folder only, a plain directory', () => {
    putEvents('spawn-one')
    addDir(A)
    assert.deepEqual(leftovers(sess()), { branches: [], folders: [fo(A)], count: 1 })
  })

  test('a branch and a folder for the same agent count once', () => {
    putEvents('spawn-one')
    addWorktree(A, true)
    assert.deepEqual(leftovers(sess()), { branches: [br(A)], folders: [fo(A)], count: 1 })
  })

  test('two agents are sorted and counted per agent', () => {
    putEvents('spawn-two')
    addWorktree(B, true)
    addBranch(A)
    assert.deepEqual(leftovers(sess()), { branches: [br(A), br(B)].sort(), folders: [fo(B)], count: 2 })
  })

  test('none left', () => {
    putEvents('spawn-two')
    assert.deepEqual(leftovers(sess()), EMPTY)
  })

  test("other sessions' agents do not count", () => {
    putEvents('spawn-one')
    for (const i of [C, D2]) addWorktree(i, true)
    addDir('a99999999999999999')
    assert.deepEqual(leftovers(sess()), EMPTY)
  })

  test("other sessions' agents do not inflate our own", () => {
    putEvents('spawn-one')
    addBranch(A)
    addWorktree(C, true)
    assert.deepEqual(leftovers(sess()), { branches: [br(A)], folders: [], count: 1 })
  })

  test('slots.json is never read', () => {
    putEvents('spawn-one')
    addBranch(A)
    slotsJson()
    addWorktree(C, true) // listed active in slots.json, not spawned in D
    assert.deepEqual(leftovers(sess()), { branches: [br(A)], folders: [], count: 1 })
  })

  test('slots.json with nothing on disk', () => {
    putEvents('spawn-one')
    slotsJson()
    assert.deepEqual(leftovers(sess()), EMPTY)
  })

  test('the repo is unchanged by a run', () => {
    putEvents('spawn-two')
    addWorktree(A, true)
    addBranch(B)
    addDir(C)
    const before = repoState()
    leftovers(sess())
    assert.deepEqual(repoState(), before)
  })

  test('a dir not under a common dir is not recorded', () => {
    for (const sub of [`elsewhere/truss/${SESSION}`, `repo/truss/${SESSION}`, `repo/.git/other/${SESSION}`]) {
      const d = putEvents('spawn-one', join(tmp, ...sub.split('/')))
      assert.equal(leftovers(d), NR, sub)
    }
  })

  test('the top-level keys include leftovers', () => {
    putEvents('spawn-one')
    const out = retro(sess())
    assert.ok('leftovers' in out)
    assert.deepEqual(Object.keys(out).sort(), TOP_KEYS)
  })
})

const spawn = (agentId: unknown, over = {}) =>
  JSON.stringify({ v: 1, ts: TS, event: 'spawn', crew: 'c', agent: 'c', agentId, type: 'truss:project-manager', model: 'opus', effort: 'high', by: 'main', ...over })

describe('edges', () => {
  const sess = () => join(repo, '.git', 'truss', 'S1')
  const put = (lines: string[], name = 'events.jsonl', dest = sess()) => {
    write(dest, name, `${lines.join('\n')}\n`)
    return dest
  }
  const branch = (i: string) => git(repo, 'branch', br(i))

  test('a bare repo is not recorded', () => {
    const bare = join(tmp, 'x.git')
    git(tmp, 'init', '-q', '--bare', bare)
    const d = put([spawn('a1')], 'events.jsonl', join(bare, 'truss', 'S1'))
    assert.equal(leftovers(d), NR)
  })

  test('no events file is not recorded', () => {
    write(sess(), 'decisions.md', '# d\n')
    put([spawn('a1')], 'messages.jsonl') // not an events*.jsonl file
    assert.equal(leftovers(sess()), NR)
  })

  test('events without spawns is zero, not unrecorded', () => {
    put([JSON.stringify({ v: 1, ts: TS, event: 'stall', agentId: 'a1' })])
    branch('a1')
    assert.deepEqual(leftovers(sess()), EMPTY)
  })

  test('ids come from every events file', () => {
    put([spawn('a1')])
    put([spawn('b2')], 'events.1.jsonl')
    put([spawn('c3')], 'events-2026.jsonl')
    for (const i of ['a1', 'b2', 'c3', 'd4']) branch(i)
    assert.deepEqual(leftovers(sess()), { branches: ['a1', 'b2', 'c3'].map(br), folders: [], count: 3 })
  })

  test('invalid lines are ignored', () => {
    put(['not json {', spawn('a1', { v: 2 }), spawn('b2', { ts: 'yesterday' }), spawn('c3'), '', '[1]'])
    for (const i of ['a1', 'b2', 'c3']) branch(i)
    assert.deepEqual(leftovers(sess()), { branches: [br('c3')], folders: [], count: 1 })
  })

  test('only spawn events contribute ids', () => {
    put([JSON.stringify({ v: 1, ts: TS, event: 'stall', agentId: 's9' }), spawn('a1')])
    branch('s9')
    branch('a1')
    assert.deepEqual(leftovers(sess()), { branches: [br('a1')], folders: [], count: 1 })
  })

  test('malformed ids are ignored and do not crash', () => {
    const bad = ['../x', 'A1B2', '', 123, null, 'a b', 'a/b', 'a-b']
    put([...bad.map((b) => spawn(b)), spawn('ok1')])
    branch('ok1')
    mkdirSync(join(repo, '.claude', 'worktrees', 'x'), { recursive: true })
    assert.deepEqual(leftovers(sess()), { branches: [br('ok1')], folders: [], count: 1 })
  })

  test('an event without an agentId key', () => {
    const e = JSON.parse(spawn('a1'))
    delete e.agentId
    put([JSON.stringify(e), spawn('b2')])
    branch('b2')
    assert.deepEqual(leftovers(sess()), { branches: [br('b2')], folders: [], count: 1 })
  })

  test('only exact local branches count', () => {
    put([spawn('a1')])
    git(repo, 'update-ref', `refs/remotes/origin/${br('a1')}`, 'HEAD')
    branch('a1-old')
    branch('zz9') // not spawned
    assert.deepEqual(leftovers(sess()), EMPTY)
  })

  test('a regular file at the folder path does not count', () => {
    put([spawn('a1')])
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
    writeFileSync(join(repo, ...fo('a1').split('/')), 'x')
    assert.deepEqual(leftovers(sess()), EMPTY)
  })

  test('the folder string is relative with forward slashes', () => {
    put([spawn('a1'), spawn('a1')])
    addDir('a1')
    const got = leftovers(sess())
    assert.deepEqual(got.folders, ['.claude/worktrees/agent-a1'])
    assert.equal(got.count, 1)
  })

  test('git unavailable is not recorded and the rest is intact', () => {
    put([spawn('a1')])
    branch('a1')
    const empty = join(tmp, 'emptybin')
    mkdirSync(empty)
    const out = retro(sess(), { env: { ...process.env, PATH: empty } })
    assert.ok('leftovers' in out)
    assert.equal(out.leftovers, NR)
    assert.deepEqual(Object.keys(out).sort(), TOP_KEYS)
  })

  test('a run changes nothing in the repo', () => {
    put([spawn('a1'), spawn('b2')])
    branch('a1')
    addDir('b2')
    const idx = join(repo, '.git', 'index')
    const state = () => [git(repo, 'for-each-ref'), git(repo, 'worktree', 'list', '--porcelain'), existsSync(idx) ? readFileSync(idx).toString('base64') : null]
    const before = state()
    assert.equal(leftovers(sess()).count, 2)
    assert.deepEqual(state(), before)
  })

  test('the counts source never mentions slots', () => {
    assert.ok(!readFileSync(join(CLI, '..', 'counts.ts'), 'utf8').toLowerCase().includes('slots'))
  })

  test('an odd slots.json changes nothing', () => {
    put([spawn('a1')])
    branch('a1')
    const base = join(repo, '.git', 'claude-worktrees')
    mkdirSync(base, { recursive: true })
    const p = join(base, 'slots.json')
    mkdirSync(p) // a directory where the file would be
    assert.deepEqual(leftovers(sess()), { branches: [br('a1')], folders: [], count: 1 })
    rmSync(p, { recursive: true })
    writeFileSync(p, Buffer.concat([Buffer.from([0xff, 0xfe, 0x00]), Buffer.from('{{{ not json')]))
    assert.deepEqual(leftovers(sess()), { branches: [br('a1')], folders: [], count: 1 })
  })

  test('a spawn outside any run and the split unchanged', () => {
    put([spawn('a1')]) // no decisions.md, no run headings
    branch('a1')
    const out = retro(sess())
    assert.deepEqual(out.leftovers, { branches: [br('a1')], folders: [], count: 1 })
    assert.equal(out.split, NR)
    const other = retro(put([spawn('a1')], 'events.jsonl', join(tmp, 'plain', 'S1')))
    assert.deepEqual(out.runs, other.runs)
    assert.equal(out.split, other.split)
  })
})

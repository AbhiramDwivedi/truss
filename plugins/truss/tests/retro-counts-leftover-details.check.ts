// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// The `leftoverDetails` key of truss's retro counts (ADR-0006 section 1), contract and edge cases. Ported from the
// Python test_contract_leftover_details.py and test_retro_leftover_details.py. Real git in temp repos, never mocks.
// Events come from fixtures/leftovers (synthetic, shared with retro-counts-leftovers.check.ts, read only). Every
// contract case also checks that a run leaves the repo unchanged: `git for-each-ref`, `git worktree list
// --porcelain` and `git count-objects -v`.
// Run with: node --test tests/retro-counts-leftover-details.check.ts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import { FIXTURES, mktmp, NR, repoGit as git, retro, write } from './retro-counts-lib.ts'

const FIX = join(FIXTURES, 'leftovers')
const SESSION = '2026-10-27-run'
const A = 'a0123456789abcdef'
const B = 'a1fedcba98765432'
const KEYS = ['id', 'branch', 'folder', 'head', 'dirty', 'inMain', 'skip'].sort()
const PASSES = 'passes every check retro can see'
const TS = '2026-10-27T09:01:00.000Z'

const br = (i: string) => `worktree-agent-${i}`
const fo = (i: string) => `.claude/worktrees/agent-${i}`
const entry = (i: string, o: Record<string, unknown> = {}) => ({
  id: i,
  branch: o.branch === false ? null : br(i),
  folder: o.folder === false ? null : fo(i),
  head: 'head' in o ? o.head : null,
  dirty: 'dirty' in o ? o.dirty : false,
  inMain: 'inMain' in o ? o.inMain : null,
  skip: 'skip' in o ? o.skip : '',
})

let tmp: string
let repo: string
const commit = (name: string, text: string, msg: string, where = repo) => {
  writeFileSync(join(where, name), text)
  git(where, 'add', name)
  git(where, 'commit', '-q', '-m', msg)
}
const wtPath = (i: string) => join(repo, ...fo(i).split('/'))
const sha = (where: string, rev = 'HEAD') => git(where, 'rev-parse', rev).trim()
const state = () => [git(repo, 'for-each-ref'), git(repo, 'worktree', 'list', '--porcelain'), git(repo, 'count-objects', '-v')]
const gitStatus = (...args: string[]) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
const notInMain = (i: string) => `${br(i)} is not in the main checkout's HEAD yet`
const lines = (s: string) => s.split('\n').filter((l) => l !== '')

describe('contract', () => {
  let session: string
  beforeEach(() => {
    tmp = mktmp('leftover-details-contract-')
    repo = join(tmp, 'repo')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    commit('f.txt', 'x\n', 'one')
    session = join(repo, '.git', 'truss', SESSION)
  })

  const putEvents = (kase: string, dest = session) => {
    mkdirSync(dest, { recursive: true })
    copyFileSync(join(FIX, kase, 'events.jsonl'), join(dest, 'events.jsonl'))
    return dest
  }
  const addWorktree = (i: string, branch = true, start: string | null = null) => {
    const args = ['worktree', 'add', '-q', ...(branch ? ['-b', br(i)] : ['--detach']), wtPath(i)]
    if (start) args.push(start)
    git(repo, ...args)
  }
  // run retro, check the repo is unchanged, return leftoverDetails (or the whole output with full)
  const details = (path = session, full = false) => {
    const before = state()
    const out = retro(path)
    assert.deepEqual(state(), before, 'retro changed the repo')
    assert.ok('leftoverDetails' in out, 'producer missing: no leftoverDetails key')
    return full ? out : out.leftoverDetails
  }

  test('a detached worktree', () => {
    putEvents('spawn-one')
    addWorktree(A, false)
    const s = sha(wtPath(A))
    assert.deepEqual(details(), [entry(A, { branch: false, head: `detached ${s}`, skip: 'not on a worktree-* branch (detached)' })])
  })

  test('a detached worktree with a branch at the same commit', () => {
    putEvents('spawn-one')
    addWorktree(A, false)
    git(repo, 'branch', br(A))
    const s = sha(wtPath(A))
    assert.deepEqual(details(), [entry(A, { head: `detached ${s}`, inMain: 'ancestor', skip: 'not on a worktree-* branch (detached)' })])
  })

  test('a dirty worktree: an untracked file counts', () => {
    putEvents('spawn-one')
    addWorktree(A)
    writeFileSync(join(wtPath(A), 'new.txt'), 'u\n')
    assert.deepEqual(details(), [entry(A, { head: br(A), dirty: true, inMain: 'ancestor', skip: 'uncommitted changes' })])
  })

  test('a locked worktree with a reason', () => {
    putEvents('spawn-one')
    addWorktree(A)
    git(repo, 'worktree', 'lock', '--reason', 'agent still working', wtPath(A))
    assert.deepEqual(details(), [entry(A, { head: br(A), inMain: 'ancestor', skip: 'locked (agent still working)' })])
  })

  test('a locked worktree, bare lock', () => {
    putEvents('spawn-one')
    addWorktree(A)
    git(repo, 'worktree', 'lock', wtPath(A))
    assert.deepEqual(details(), [entry(A, { head: br(A), inMain: 'ancestor', skip: 'locked (locked)' })])
  })

  test('a branch in main', () => {
    putEvents('spawn-one')
    addWorktree(A)
    assert.deepEqual(details(), [entry(A, { head: br(A), inMain: 'ancestor', skip: PASSES })])
  })

  test('a branch not in main', () => {
    putEvents('spawn-one')
    addWorktree(A)
    commit('g.txt', 'g\n', 'ahead', wtPath(A))
    assert.deepEqual(details(), [entry(A, { head: br(A), inMain: null, skip: notInMain(A) })])
  })

  test('a registered worktree whose folder is gone', () => {
    putEvents('spawn-one')
    addWorktree(A)
    rmSync(wtPath(A), { recursive: true, force: true })
    assert.deepEqual(details(), [entry(A, { folder: false, head: br(A), dirty: true, inMain: 'ancestor', skip: 'uncommitted changes' })])
  })

  test('a branch with no worktree', () => {
    putEvents('spawn-one')
    git(repo, 'branch', br(A))
    assert.deepEqual(details(), [entry(A, { folder: false, head: null, dirty: null, inMain: 'ancestor', skip: 'no longer a registered worktree' })])
  })

  test('a plain folder git does not list', () => {
    putEvents('spawn-one')
    mkdirSync(wtPath(A), { recursive: true })
    assert.deepEqual(details(), [entry(A, { branch: false, head: null, dirty: null, inMain: null, skip: 'no longer a registered worktree' })])
  })

  test('the main checkout is detached', () => {
    putEvents('spawn-one')
    addWorktree(A)
    git(repo, 'checkout', '-q', '--detach')
    assert.deepEqual(details(), [entry(A, { head: br(A), inMain: 'ancestor', skip: 'the main checkout is on no branch (detached or unreadable)' })])
  })

  // A's commit adds g.txt; main gets h.txt, then a cherry-pick of A's commit (and optionally a later edit of g.txt)
  const diverged = (furtherEdit: boolean) => {
    const base = sha(repo)
    putEvents('spawn-one')
    addWorktree(A, true, base)
    commit('g.txt', 'a\n', 'A work', wtPath(A))
    commit('h.txt', 'h\n', 'main moves')
    git(repo, 'cherry-pick', br(A))
    if (furtherEdit) commit('g.txt', 'a2\n', 'main edits g again')
  }

  test('main on a crew branch: a tree-only branch', () => {
    diverged(false)
    git(repo, 'checkout', '-q', '-b', 'worktree-main-crew')
    assert.deepEqual(details(), [entry(A, { head: br(A), inMain: 'tree', skip: notInMain(A) })])
  })

  test('main on a crew branch: a cherry-only branch', () => {
    diverged(true)
    git(repo, 'checkout', '-q', '-b', 'worktree-main-crew')
    assert.deepEqual(details(), [entry(A, { head: br(A), inMain: 'cherry', skip: notInMain(A) })])
  })

  test('a tree-only branch with main on an ordinary branch passes', () => {
    diverged(false)
    assert.deepEqual(details(), [entry(A, { head: br(A), inMain: 'tree', skip: PASSES })])
  })

  test('a cherry-only branch with main on an ordinary branch passes', () => {
    diverged(true)
    assert.deepEqual(details(), [entry(A, { head: br(A), inMain: 'cherry', skip: PASSES })])
  })

  test('every entry has exactly seven keys and nulls are kept', () => {
    putEvents('spawn-two')
    git(repo, 'branch', br(A)) // no worktree: head, dirty null
    mkdirSync(wtPath(B), { recursive: true }) // plain folder: branch, head, dirty, inMain null
    const d = details()
    assert.equal(d.length, 2)
    for (const e of d) assert.deepEqual(Object.keys(e).sort(), KEYS)
    assert.equal(d[0].head, null)
    assert.equal(d[1].inMain, null)
  })

  test('sorted by id and matching leftovers', () => {
    putEvents('spawn-two')
    addWorktree(B)
    git(repo, 'branch', br(A))
    const out = details(session, true)
    const d = out.leftoverDetails
    assert.deepEqual(d.map((e) => e.id), [A, B])
    assert.equal(d.length, out.leftovers.count)
    assert.deepEqual(d.filter((e) => e.branch).map((e) => e.branch).sort(), out.leftovers.branches)
    assert.deepEqual(d.filter((e) => e.folder).map((e) => e.folder).sort(), out.leftovers.folders)
  })

  test('an empty list when nothing is left', () => {
    putEvents('spawn-two')
    const out = details(session, true)
    assert.equal(out.leftovers.count, 0)
    assert.deepEqual(out.leftoverDetails, [])
  })

  test('a stale registration without a branch or folder has no entry', () => {
    putEvents('spawn-one')
    addWorktree(A)
    rmSync(wtPath(A), { recursive: true, force: true })
    // drop the branch while the registration stays (git refuses to delete a checked-out branch)
    unlinkSync(join(repo, '.git', 'refs', 'heads', br(A)))
    const out = details(session, true)
    assert.equal(out.leftovers.count, 0)
    assert.deepEqual(out.leftoverDetails, [])
  })

  test('not recorded whenever leftovers is', () => {
    for (const sub of [`elsewhere/truss/${SESSION}`, `repo/truss/${SESSION}`, `repo/.git/other/${SESSION}`]) {
      const d = putEvents('spawn-one', join(tmp, ...sub.split('/')))
      const out = details(d, true)
      assert.equal(out.leftovers, NR, sub)
      assert.equal(out.leftoverDetails, NR, sub)
    }
  })
})

const spawn = (agentId: string) =>
  JSON.stringify({ v: 1, ts: TS, event: 'spawn', crew: 'c', agent: 'c', agentId, type: 'truss:foreman', model: 'opus', effort: 'high', by: 'main' })

describe('edges', () => {
  const ID = A
  let session: string
  let wt: string
  beforeEach(() => {
    tmp = mktmp('retro-details-edges-')
    repo = join(tmp, 'repo')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    commit('f.txt', 'x\n', 'one')
    session = join(repo, '.git', 'truss', 'S1')
    write(session, 'events.jsonl', `${spawn(ID)}\n`)
    wt = join(repo, ...fo(ID).split('/'))
  })

  const runRetro = (env?: Record<string, string>) => {
    const out = retro(session, { env })
    assert.ok('leftoverDetails' in out, 'producer missing: no leftoverDetails key')
    return out
  }

  // run the fixture's `merge-tree --write-tree` under its own quarantine so it writes nothing into the repo
  const quarantinedMergeTree = (ref: string) => {
    const q = mktmp('probe-quarantine-')
    return spawnSync('git', ['-C', repo, 'merge-tree', '--write-tree', '--no-messages', 'HEAD', ref], {
      encoding: 'utf8',
      env: { ...process.env, GIT_OBJECT_DIRECTORY: q, GIT_ALTERNATE_OBJECT_DIRECTORIES: resolve(repo, '.git', 'objects') },
    })
  }

  test('a worktree on a non-worktree branch', () => {
    git(repo, 'branch', br(ID))
    git(repo, 'worktree', 'add', '-q', '-b', 'feature-x', wt)
    const out = runRetro()
    assert.deepEqual(out.leftovers, { branches: [br(ID)], folders: [fo(ID)], count: 1 })
    assert.equal(out.leftoverDetails.length, 1)
    const e = out.leftoverDetails[0]
    assert.equal(e.head, 'feature-x')
    assert.equal(e.skip, 'not on a worktree-* branch (feature-x)')
    assert.equal(e.branch, br(ID))
    assert.equal(e.dirty, false)
  })

  test('a worktree list failure is not recorded but leftovers stays an object', () => {
    git(repo, 'branch', br(ID))
    git(repo, 'worktree', 'add', '-q', '-b', 'wb', wt)
    // make `git worktree list --porcelain` really fail: a directory where git expects the `locked` file
    mkdirSync(join(repo, '.git', 'worktrees', `agent-${ID}`, 'locked'))
    assert.notEqual(gitStatus('worktree', 'list', '--porcelain').status, 0, 'fixture broken: worktree list still succeeds')
    git(repo, 'for-each-ref') // the rest of git still works (throws otherwise)
    const out = runRetro()
    assert.equal(typeof out.leftovers, 'object')
    assert.equal(out.leftovers.count, 1)
    assert.equal(out.leftoverDetails, NR)
  })

  test('a clean merge with a new tree leaves the repo and temp dir untouched', () => {
    const base = git(repo, 'rev-parse', 'HEAD').trim()
    git(repo, 'checkout', '-q', '-b', br(ID), base)
    commit('b.txt', 'b\n', 'crew change')
    git(repo, 'checkout', '-q', '-')
    commit('c.txt', 'c\n', 'main change') // non-conflicting: the merged tree differs from HEAD^{tree}
    assert.notEqual(gitStatus('merge-base', '--is-ancestor', br(ID), 'HEAD').status, 0)
    const before = state() // baseline taken before any fixture probe; the probe below is quarantined and must not move it
    const merged = quarantinedMergeTree(br(ID))
    assert.equal(merged.status, 0, 'fixture broken: the merge is not clean')
    assert.notEqual(lines(merged.stdout)[0], git(repo, 'rev-parse', 'HEAD^{tree}').trim())
    assert.deepEqual(state(), before, 'fixture broken: the quarantined probe changed the repo')
    const scratch = join(tmp, 'scratch-tmp')
    mkdirSync(scratch)
    const out = runRetro({ ...process.env, TMP: scratch, TEMP: scratch, TMPDIR: scratch })
    assert.equal(out.leftoverDetails.length, 1)
    const e = out.leftoverDetails[0]
    assert.equal(e.branch, br(ID))
    assert.equal(e.inMain, null)
    assert.deepEqual(state(), before, 'retro changed refs, worktrees or the loose-object count')
    assert.deepEqual(readdirSync(scratch), [], 'retro left a temp dir behind')
  })

  test('an unregistered branch cherry-picked into main is cherry', () => {
    const base = git(repo, 'rev-parse', 'HEAD').trim()
    git(repo, 'checkout', '-q', '-b', br(ID), base)
    commit('b.txt', 'b\n', 'crew change')
    git(repo, 'checkout', '-q', '-')
    commit('c.txt', 'c\n', 'main change') // so the pick is a new commit, not the branch commit itself
    git(repo, 'cherry-pick', br(ID))
    git(repo, 'rm', '-q', 'b.txt') // main moves on: the merged tree now differs from HEAD^{tree}
    git(repo, 'commit', '-q', '-m', 'drop b')
    assert.notEqual(gitStatus('merge-base', '--is-ancestor', br(ID), 'HEAD').status, 0)
    const before = git(repo, 'count-objects', '-v')
    const merged = quarantinedMergeTree(br(ID))
    assert.equal(merged.status, 0, 'fixture broken: the merge is not clean')
    assert.notEqual(lines(merged.stdout)[0], git(repo, 'rev-parse', 'HEAD^{tree}').trim())
    assert.equal(git(repo, 'count-objects', '-v'), before, 'fixture broken: the probe wrote objects')
    const cherry = lines(git(repo, 'cherry', 'HEAD', br(ID)))
    assert.ok(cherry.length > 0 && cherry.every((l) => l.startsWith('- ')), String(cherry))
    assert.ok(!existsSync(wt))
    const out = runRetro()
    assert.equal(out.leftoverDetails.length, 1)
    const e = out.leftoverDetails[0]
    assert.equal(e.branch, br(ID))
    assert.equal(e.head, null)
    assert.equal(e.dirty, null)
    assert.equal(e.inMain, 'cherry')
    assert.equal(e.skip, 'no longer a registered worktree')
  })
})

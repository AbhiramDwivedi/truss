// R-131: `factory consolidate` proposes one reviewed diff for docs/knowledge and the architecture doc, decided in code, and applies it
// only on --accept. The run skill runs it between waves and has the read-only checking engineer review the diff.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildFixture, git, type Cases } from './fixtures/consolidation/knowledge-fixture.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FACTORY = path.join(HERE, '..', 'bin', 'factory.ts')
const SKILL = path.join(HERE, '..', 'skills', 'run', 'SKILL.md')

// Value-less flags go last: positionalsToFlags lets a boolean flag swallow the next bare word.
const consolidate = (repo: string, dir: string, ...flags: string[]) => {
  const r = spawnSync(process.execPath, [FACTORY, 'consolidate', '--repo', repo, '--dir', dir, ...flags], { encoding: 'utf8', windowsHide: true })
  let body: any
  try { body = JSON.parse(r.stdout.trim()) } catch { body = r.stdout }
  return { status: r.status, body, out: r.stdout }
}
type Row = { kind: string; doc: string; reason: string }
const patchOf = (dir: string): string => readFileSync(path.join(dir, 'consolidation.patch'), 'utf8')
const added = (patch: string): string[] => patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))
const removed = (patch: string): string[] => patch.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'))
const count = (repo: string): number => Number(git(repo, 'rev-list', '--count', 'HEAD'))
const withFixture = (cases: Cases, fn: (f: ReturnType<typeof buildFixture>) => void): void => {
  const f = buildFixture(cases)
  try { fn(f) } finally { f.cleanup() }
}
const propose = (f: { repo: string; dir: string }) => {
  const r = consolidate(f.repo, f.dir)
  assert.equal(r.status, 0, `consolidate exited ${r.status}: ${r.out}`)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.proposed, true)
  assert.equal(r.body.patch, path.join(f.dir, 'consolidation.patch').split(path.sep).join('/'))
  const git2 = spawnSync('git', ['apply', '--check', r.body.patch], { cwd: f.repo, encoding: 'utf8', windowsHide: true })
  assert.equal(git2.status, 0, `git apply --check refused the patch: ${git2.stderr}`)
  return r.body as { changes: Row[] }
}

test('consolidate on one fixture with two duplicate entries, one contradicted claim, one unsupported entry and one line citation proposes one diff with all four changes', () => {
  withFixture({ dup: true, contra: true, unsupported: true, linecite: true }, (f) => {
    const body = propose(f)
    assert.deepEqual(body.changes.map((c) => c.kind).sort(), ['flag', 'merge', 'prune', 'repoint'])
    for (const c of body.changes) assert.ok(c.doc !== '' && c.reason !== '', `change ${c.kind} lacks a doc or reason`)
    const patch = patchOf(f.dir)
    const files = patch.split('\n').filter((l) => l.startsWith('diff --git')).length
    assert.equal(files, 3, 'the one patch touches the feature map, the knowledge doc and the architecture doc')
    assert.ok(added(patch).some((l) => l.includes('`src/util.ts` `helper`')), 'the re-pointed citation')
    assert.ok(added(patch).some((l) => l.includes('withLock')), 'the flag line')
    assert.ok(added(patch).some((l) => l.includes('Gone feature')), 'the prune reason')
    assert.ok(removed(patch).some((l) => l.includes('## login')), 'the merged duplicate is removed')
  })
})

test('consolidate proposes one diff that merges two knowledge entries for one capability', () => {
  withFixture({ dup: true }, (f) => {
    const body = propose(f)
    assert.deepEqual(body.changes.map((c) => c.kind), ['merge'])
    assert.equal(body.changes[0]?.doc, 'docs/features.md')
    git(f.repo, 'apply', path.join(f.dir, 'consolidation.patch'))
    const text = readFileSync(path.join(f.repo, 'docs', 'features.md'), 'utf8')
    assert.equal(text.split('\n').filter((l) => /^## login\s*$/i.test(l)).length, 1, 'one Login heading is left')
    assert.match(text, /## Login\b/, 'the first entry is the one kept')
    assert.match(text, /src\/login\.ts/)
    assert.match(text, /src\/login-extra\.ts/, 'the second entry content is merged into the first')
    assert.match(text, /second factor/)
  })
})

test('consolidate flags a knowledge claim whose cited symbol the code no longer has, in its proposed diff', () => {
  withFixture({ contra: true }, (f) => {
    const body = propose(f)
    assert.deepEqual(body.changes.map((c) => c.kind), ['flag'])
    assert.equal(body.changes[0]?.doc, 'docs/knowledge/store.md')
    const patch = patchOf(f.dir)
    assert.ok(added(patch).some((l) => l.includes('withLock') && l.includes('src/lock.ts')), 'an added line names the symbol and the file')
    assert.ok(!removed(patch).some((l) => l.includes('takes the lock')), 'the claim is kept, not resolved')
  })
})

test('consolidate prunes an entry whose entry paths no longer exist and gives the reason in the diff', () => {
  withFixture({ unsupported: true }, (f) => {
    const body = propose(f)
    assert.deepEqual(body.changes.map((c) => c.kind), ['prune'])
    assert.match(body.changes[0]?.reason ?? '', /exist/i)
    const patch = patchOf(f.dir)
    assert.ok(removed(patch).some((l) => l.includes('## Gone feature')), 'the entry is removed')
    assert.ok(added(patch).some((l) => l.includes('Gone feature') && /exist/i.test(l)), 'an added line names the entry and the reason')
    assert.ok(!removed(patch).some((l) => l.includes('Ok capability')), 'a supported entry stays')
  })
})

test('consolidate re-points a line citation to a symbol citation in its proposed diff', () => {
  withFixture({ linecite: true }, (f) => {
    const body = propose(f)
    assert.deepEqual(body.changes.map((c) => c.kind), ['repoint'])
    assert.equal(body.changes[0]?.doc, 'docs/architecture.md')
    const patch = patchOf(f.dir)
    assert.ok(removed(patch).some((l) => l.includes('`src/util.ts:3`')), 'the line citation is replaced')
    assert.ok(added(patch).some((l) => l.includes('`src/util.ts` `helper`')), 'with the enclosing top-level symbol')
  })
})

test('consolidate changes no tracked file until a reviewer accepts the diff', () => {
  withFixture({ dup: true, contra: true, unsupported: true, linecite: true }, (f) => {
    const before = { head: git(f.repo, 'rev-parse', 'HEAD'), tree: git(f.repo, 'write-tree'), status: git(f.repo, 'status', '--porcelain'), diff: git(f.repo, 'diff', 'HEAD') }
    const docs = ['docs/features.md', 'docs/knowledge/store.md', 'docs/architecture.md'].map((p) => readFileSync(path.join(f.repo, p), 'utf8'))
    propose(f)
    assert.ok(existsSync(path.join(f.dir, 'consolidation.patch')) && existsSync(path.join(f.dir, 'consolidation.json')), 'the proposal is stored in the truss dir')
    assert.deepEqual({ head: git(f.repo, 'rev-parse', 'HEAD'), tree: git(f.repo, 'write-tree'), status: git(f.repo, 'status', '--porcelain'), diff: git(f.repo, 'diff', 'HEAD') }, before)
    assert.deepEqual(['docs/features.md', 'docs/knowledge/store.md', 'docs/architecture.md'].map((p) => readFileSync(path.join(f.repo, p), 'utf8')), docs)
  })
})

test('an accepted consolidation diff is applied and committed once', () => {
  withFixture({ dup: true, contra: true, unsupported: true, linecite: true }, (f) => {
    propose(f)
    const n = count(f.repo)
    const a = consolidate(f.repo, f.dir, '--accept')
    assert.equal(a.status, 0, a.out)
    assert.equal(a.body.ok, true)
    assert.equal(count(f.repo), n + 1)
    assert.equal(git(f.repo, 'log', '-1', '--format=%s'), 'docs: consolidate knowledge')
    assert.equal(git(f.repo, 'status', '--porcelain'), '')
    assert.ok(!existsSync(path.join(f.dir, 'consolidation.patch')), 'the proposal is removed')
    assert.match(readFileSync(path.join(f.repo, 'docs', 'architecture.md'), 'utf8'), /`src\/util\.ts` `helper`/)
    const again = consolidate(f.repo, f.dir, '--accept')
    assert.notEqual(again.status, 0, 'a second accept has nothing to apply')
    assert.equal(count(f.repo), n + 1, 'a second accept makes no commit')
  })
})

test('a rejected consolidation diff changes nothing', () => {
  withFixture({ dup: true, contra: true, unsupported: true, linecite: true }, (f) => {
    propose(f)
    const before = { head: git(f.repo, 'rev-parse', 'HEAD'), status: git(f.repo, 'status', '--porcelain') }
    const r = consolidate(f.repo, f.dir, '--reject')
    assert.equal(r.status, 0, r.out)
    assert.equal(r.body.ok, true)
    assert.deepEqual({ head: git(f.repo, 'rev-parse', 'HEAD'), status: git(f.repo, 'status', '--porcelain') }, before)
    assert.ok(!existsSync(path.join(f.dir, 'consolidation.patch')), 'the proposal is removed')
    assert.ok(!existsSync(path.join(f.dir, 'consolidation.json')), 'the proposal record is removed')
  })
})

test('the run skill runs consolidate between waves and has a reviewer accept or reject its diff', () => {
  const text = readFileSync(SKILL, 'utf8')
  const start = text.indexOf('## 6. ')
  const end = text.indexOf('\n## 7. ')
  assert.ok(start >= 0 && end > start, 'section 6 is found')
  const section = text.slice(start, end)
  const para = section.split('\n').find((l) => /factory(\.ts)?\s+consolidate/.test(l))
  assert.ok(para !== undefined, 'section 6 tells the PM to run factory consolidate')
  assert.match(para, /last crew[^.]*merged/i, 'when the stage last crew has merged')
  assert.match(para, /before the next stage/i, 'and before the next stage starts')
  assert.match(para, /`truss:checking-engineer`/, 'a checking engineer reviews the proposed diff')
  assert.match(para, /read-only/i)
  assert.match(para, /--accept/)
  assert.match(para, /--reject/)
})

// @ts-nocheck
// Truss 0.31.0 item 4: crews write doc fragments, `factory stitch` folds them in, and a merge conflict confined to YAML
// frontmatter resolves itself. Fixtures are built in temp dirs; git is the only tool used.
//
// Run with: node --test plugins/truss/tests/doc-fragments-031.check.ts

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { docOfFragment, fragmentPathOf, isFragment, mergeFields, resolveFrontmatterConflicts, splitFront, stitchDoc, stitchTree } from '../bin/fragments.ts'

const DOC = ['# Features', '', '## Login', '', 'Old login text.', '', '### Detail', '', 'old detail', '', '## Search', '', 'Search text.', ''].join('\n')

test('doc-fragments: fragment paths map to their doc, rules fragments sit outside the rules dir', () => {
  assert.equal(fragmentPathOf('docs/features.md', 'crew-a'), 'docs/features.d/crew-a.md')
  assert.equal(fragmentPathOf('docs/knowledge/store.md', 'c'), 'docs/knowledge/store.d/c.md')
  assert.equal(fragmentPathOf('.claude/rules/plugin-tests.md', 'c'), '.claude/rules.d/plugin-tests/c.md')
  assert.equal(docOfFragment('docs/features.d/crew-a.md'), 'docs/features.md')
  assert.equal(docOfFragment('.claude/rules.d/plugin-tests/c.md'), '.claude/rules/plugin-tests.md')
  assert.equal(docOfFragment('docs/features.md'), undefined)
  assert.equal(isFragment('plugins/truss/docs/architecture.d/x.md'), true)
  assert.equal(isFragment('docs/knowledge/store.md'), false)
})

test('doc-fragments: a section replaces its namesake with its subsections, a new one appends, a remove mark deletes', () => {
  const r = stitchDoc(DOC, [
    { name: 'b.md', text: '## Login\n\nNew login text.\n' },
    { name: 'a.md', text: '## Export\n\nExport text.\n\n## Search\n\n<!-- remove -->\n' },
  ])
  assert.equal(r.text, '# Features\n\n## Login\n\nNew login text.\n\n## Export\n\nExport text.\n')
  assert.deepEqual(r.warnings, [])
})

test('doc-fragments: the stitch is byte-stable, order-free and idempotent', () => {
  const frags = [
    { name: 'crew-b.md', text: '## Search\r\n\r\nB search.\r\n' },
    { name: 'crew-a.md', text: '## Search\n\nA search.\n\n## New\n\nnew\n' },
  ]
  const one = stitchDoc(DOC, frags)
  const two = stitchDoc(DOC, [...frags].reverse())
  assert.equal(one.text, two.text)
  assert.match(one.text, /## Search\n\nB search\.\n/, 'the later name wins a shared section')
  assert.ok(!one.text.includes('\r'))
  assert.ok(one.text.endsWith('\n') && !one.text.endsWith('\n\n'))
  assert.equal(stitchDoc(one.text, frags).text, one.text)
  assert.equal(one.warnings.length, 1)
  assert.match(one.warnings[0], /crew-b\.md: section "Search" also comes from crew-a\.md/)
})

test('doc-fragments: fragment frontmatter merges into the doc: lists union, scalars replace', () => {
  const doc = '---\nsources:\n  - a.ts\nverified: abc123\n---\n# Store\n\n## Lock\n\nold\n'
  const r = stitchDoc(doc, [{ name: 'c.md', text: '---\nsources:\n  - b.ts\n  - a.ts\nverified: def456\n---\n## Lock\n\nnew\n' }])
  assert.equal(r.text, '---\nsources:\n  - a.ts\n  - b.ts\nverified: def456\n---\n# Store\n\n## Lock\n\nnew\n')
})

test('doc-fragments: headings inside fenced code are not sections', () => {
  const doc = '# A\n\n## One\n\n```md\n## Two\n```\n\nafter\n'
  const r = stitchDoc(doc, [{ name: 'x.md', text: '## One\n\nreplaced\n' }])
  assert.equal(r.text, '# A\n\n## One\n\nreplaced\n')
})

test('doc-fragments: stitchTree folds a tree and deletes the fragments, a second run does nothing', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'doc-fragments-'))
  try {
    const put = (rel, text) => {
      mkdirSync(path.dirname(path.join(root, ...rel.split('/'))), { recursive: true })
      writeFileSync(path.join(root, ...rel.split('/')), text)
    }
    put('docs/features.md', DOC)
    put('docs/features.d/crew-a.md', '## Login\n\nA login.\n')
    put('.claude/rules/area.md', '# Area\n\nrule\n')
    put('.claude/rules.d/area/crew-a.md', '## More\n\nmore rule\n')
    const files = ['docs/features.md', 'docs/features.d/crew-a.md', '.claude/rules/area.md', '.claude/rules.d/area/crew-a.md']
    const dry = stitchTree(root, files)
    assert.deepEqual(dry.removed, ['.claude/rules.d/area/crew-a.md', 'docs/features.d/crew-a.md'])
    assert.ok(existsSync(path.join(root, 'docs', 'features.d', 'crew-a.md')), 'a dry run writes nothing')
    stitchTree(root, files, { write: true })
    assert.match(readFileSync(path.join(root, 'docs', 'features.md'), 'utf8'), /## Login\n\nA login\.\n/)
    assert.equal(readFileSync(path.join(root, '.claude', 'rules', 'area.md'), 'utf8'), '# Area\n\nrule\n\n## More\n\nmore rule\n')
    assert.ok(!existsSync(path.join(root, 'docs', 'features.d', 'crew-a.md')))
    assert.deepEqual(stitchTree(root, ['docs/features.md']).removed, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('doc-fragments: mergeFields unions lists, keeps the newer verified, refuses other scalar clashes', () => {
  const f = (t) => splitFront(t).fields
  const base = f('---\nsources:\n  - a.ts\n  - old.ts\nverified: v0\ntitle: T\n---\n')
  const ours = f('---\nsources:\n  - a.ts\n  - b.ts\nverified: v1\ntitle: T\n---\n')
  const theirs = f('---\nsources:\n  - a.ts\n  - old.ts\n  - c.ts\nverified: v2\ntitle: T\n---\n')
  const m = mergeFields(base, ours, theirs, (a, b) => (b === 'v2' ? b : a))
  assert.deepEqual(m.map((x) => [x.key, x.value]), [['sources', ['a.ts', 'b.ts', 'c.ts']], ['verified', 'v2'], ['title', 'T']])
  assert.equal(mergeFields(base, ours, theirs, () => undefined), undefined, 'two verified stamps with no order cannot merge')
  const t2 = f('---\nsources:\n  - a.ts\nverified: v0\ntitle: U\n---\n')
  const o2 = f('---\nsources:\n  - a.ts\nverified: v0\ntitle: V\n---\n')
  assert.equal(mergeFields(base, o2, t2), undefined)
})

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0 && args[0] !== 'merge') throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r
}
const repoWith = (doc) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'doc-fragments-git-'))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 't@example.com')
  git(root, 'config', 'user.name', 'T')
  git(root, 'config', 'commit.gpgsign', 'false')
  mkdirSync(path.join(root, 'docs', 'knowledge'), { recursive: true })
  writeFileSync(path.join(root, 'docs', 'knowledge', 'store.md'), doc)
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'base')
  return root
}
const commitDoc = (root, branch, text, from = 'main') => {
  git(root, 'checkout', '-q', '-B', branch, from)
  writeFileSync(path.join(root, 'docs', 'knowledge', 'store.md'), text)
  git(root, 'commit', '-q', '-am', branch)
  return git(root, 'rev-parse', 'HEAD').stdout.trim()
}

test('doc-fragments: a merge conflict confined to frontmatter resolves and stages', () => {
  const base = '---\nsources:\n  - a.ts\nverified: v0\n---\n# Store\n\n## Lock\n\nlock text\n\n## Queue\n\nqueue text\n'
  const root = repoWith(base)
  try {
    const v1 = commitDoc(root, 'one', base.replace('## Lock\n\nlock text', '## Lock\n\nlock text, crew one').replace('  - a.ts', '  - a.ts\n  - b.ts'))
    const two = base.replace('queue text', 'queue text, crew two').replace('  - a.ts', '  - a.ts\n  - c.ts')
    commitDoc(root, 'two', two.replace('verified: v0', `verified: ${v1}`), 'one')
    // `three` re-stamps from main with an older verified while `two` already holds v1's descendant stamp
    git(root, 'checkout', '-q', 'one')
    writeFileSync(path.join(root, 'docs', 'knowledge', 'store.md'), base.replace('## Lock\n\nlock text', '## Lock\n\nlock text, crew one').replace('  - a.ts', '  - a.ts\n  - b.ts\n  - d.ts').replace('verified: v0', 'verified: v0x'))
    git(root, 'commit', '-q', '-am', 'one again')
    const m = git(root, 'merge', '--no-edit', 'two')
    assert.notEqual(m.status, 0, 'the fixture must conflict')
    const r = resolveFrontmatterConflicts(root)
    // verified: v0x vs <v1 sha>: neither is a commit ancestry the other way round, so this one is left
    assert.deepEqual(r.left, ['docs/knowledge/store.md'])
    git(root, 'merge', '--abort')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('doc-fragments: two crews that re-stamp verified to commits and add sources merge clean', () => {
  const base = '---\nsources:\n  - a.ts\nverified: v0\n---\n# Store\n\n## Lock\n\nlock text\n\n## Queue\n\nqueue text\n'
  const root = repoWith(base)
  try {
    const main0 = git(root, 'rev-parse', 'HEAD').stdout.trim()
    // crew one stamps main0 and edits Lock; then main moves on (c1) and crew two stamps c1 and edits Queue
    commitDoc(root, 'one', base.replace('lock text', 'lock text, one').replace('  - a.ts', '  - a.ts\n  - b.ts').replace('verified: v0', `verified: ${main0}`))
    git(root, 'checkout', '-q', 'main')
    writeFileSync(path.join(root, 'other.txt'), 'x\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'c1')
    const c1 = git(root, 'rev-parse', 'HEAD').stdout.trim()
    commitDoc(root, 'two', base.replace('queue text', 'queue text, two').replace('  - a.ts', '  - a.ts\n  - c.ts').replace('verified: v0', `verified: ${c1}`), 'main')
    git(root, 'checkout', '-q', 'one')
    const m = git(root, 'merge', '--no-edit', 'two')
    assert.notEqual(m.status, 0, 'the fixture must conflict')
    const r = resolveFrontmatterConflicts(root)
    assert.deepEqual(r, { resolved: ['docs/knowledge/store.md'], left: [] })
    const text = readFileSync(path.join(root, 'docs', 'knowledge', 'store.md'), 'utf8')
    assert.equal(text, `---\nsources:\n  - a.ts\n  - b.ts\n  - c.ts\nverified: ${c1}\n---\n# Store\n\n## Lock\n\nlock text, one\n\n## Queue\n\nqueue text, two\n`)
    git(root, 'commit', '-q', '--no-edit')
    assert.equal(git(root, 'status', '--porcelain').stdout, '')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

const FACTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'factory.ts')
const cli = (args) => {
  const r = spawnSync(process.execPath, [FACTORY, ...args], { encoding: 'utf8' })
  let body
  try { body = JSON.parse(r.stdout) } catch { body = r.stdout }
  return { status: r.status, body, err: r.stderr }
}

test('doc-fragments: factory stitch folds committed fragments of shared docs, commits once, and leaves other .d dirs alone', () => {
  const root = repoWith('---\nsources:\n  - a.ts\nverified: v0\n---\n# Store\n\n## Lock\n\nold\n')
  try {
    const put = (rel, text) => {
      mkdirSync(path.dirname(path.join(root, ...rel.split('/'))), { recursive: true })
      writeFileSync(path.join(root, ...rel.split('/')), text)
    }
    put('docs/features.md', DOC)
    put('docs/features.d/crew-a.md', '## Login\n\nA login.\n')
    put('docs/knowledge/store.d/crew-b.md', '## Lock\n\nnew lock\n')
    put('.claude/rules/area.md', '# Area\n\nrule\n')
    put('.claude/rules.d/area/crew-a.md', '## More\n\nmore\n')
    put('src/conf.d/x.md', '## Not a fragment\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'fragments')
    const dry = cli(['stitch', '--repo', root, '--dry'])
    assert.equal(dry.status, 0, dry.err)
    assert.deepEqual(dry.body.removed, ['.claude/rules.d/area/crew-a.md', 'docs/features.d/crew-a.md', 'docs/knowledge/store.d/crew-b.md'])
    assert.equal(dry.body.committed, false)
    const r = cli(['stitch', '--repo', root])
    assert.equal(r.status, 0, r.err)
    assert.equal(r.body.committed, true)
    assert.equal(git(root, 'log', '-1', '--format=%s').stdout.trim(), 'docs: stitch doc fragments')
    assert.equal(git(root, 'status', '--porcelain').stdout, '')
    assert.ok(existsSync(path.join(root, 'src', 'conf.d', 'x.md')), 'a .d dir beside no shared doc is untouched')
    assert.match(readFileSync(path.join(root, 'docs', 'knowledge', 'store.md'), 'utf8'), /## Lock\n\nnew lock\n$/)
    const again = cli(['stitch', '--repo', root])
    assert.equal(again.status, 0, again.err)
    assert.equal(again.body.committed, false, 'a second stitch has nothing to do')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('doc-fragments: factory stitch refuses while a stitched doc has uncommitted changes', () => {
  const root = repoWith('# Store\n')
  try {
    mkdirSync(path.join(root, 'docs', 'knowledge', 'store.d'), { recursive: true })
    writeFileSync(path.join(root, 'docs', 'knowledge', 'store.d', 'c.md'), '## X\n\nx\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'frag')
    writeFileSync(path.join(root, 'docs', 'knowledge', 'store.md'), '# Store, edited\n')
    const r = cli(['stitch', '--repo', root])
    assert.equal(r.status, 1, r.err)
    assert.match(JSON.stringify(r.body), /commit or discard the changes/)
    assert.ok(existsSync(path.join(root, 'docs', 'knowledge', 'store.d', 'c.md')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('doc-fragments: factory sync concludes a merge whose only conflict is a knowledge doc frontmatter', () => {
  const base = '---\nsources:\n  - a.ts\nverified: v0\n---\n# Store\n\n## Lock\n\nlock text\n\n## Queue\n\nqueue text\n'
  const root = repoWith(base)
  const dir = mkdtempSync(path.join(os.tmpdir(), 'doc-fragments-dir-'))
  try {
    const main0 = git(root, 'rev-parse', 'HEAD').stdout.trim()
    git(root, 'branch', 'truss-c1')
    const wt = path.join(root, '.claude', 'worktrees', 'truss-c1')
    git(root, 'worktree', 'add', '-q', wt, 'truss-c1')
    writeFileSync(path.join(wt, 'docs', 'knowledge', 'store.md'), base.replace('lock text', 'lock text, crew').replace('  - a.ts', '  - a.ts\n  - b.ts').replace('verified: v0', `verified: ${main0}`))
    git(wt, 'commit', '-q', '-am', 'crew re-stamps')
    writeFileSync(path.join(root, 'other.txt'), 'x\n')
    git(root, 'add', 'other.txt')
    git(root, 'commit', '-q', '-m', 'c1')
    const c1 = git(root, 'rev-parse', 'HEAD').stdout.trim()
    writeFileSync(path.join(root, 'docs', 'knowledge', 'store.md'), base.replace('queue text', 'queue text, main').replace('  - a.ts', '  - a.ts\n  - c.ts').replace('verified: v0', `verified: ${c1}`))
    git(root, 'commit', '-q', '-am', 'main re-stamps')
    const r = cli(['sync', '--repo', root, '--dir', dir, '--slug', 'c1'])
    assert.equal(r.status, 0, `${r.err}\n${JSON.stringify(r.body)}`)
    assert.equal(r.body.merged, true)
    assert.equal(r.body.frontmatterResolved, true)
    const text = readFileSync(path.join(wt, 'docs', 'knowledge', 'store.md'), 'utf8')
    assert.match(text, /sources:\n {2}- a\.ts\n {2}- b\.ts\n {2}- c\.ts\n/)
    assert.match(text, new RegExp(`verified: ${c1}\n`))
    assert.match(text, /lock text, crew[\s\S]*queue text, main/)
    assert.equal(git(wt, 'status', '--porcelain').stdout, '')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('doc-fragments: a body conflict is left for the caller', () => {
  const base = '---\nverified: v0\n---\n# Store\n\nline\n'
  const root = repoWith(base)
  try {
    commitDoc(root, 'one', base.replace('line', 'line one'))
    commitDoc(root, 'two', base.replace('line', 'line two'), 'main')
    git(root, 'checkout', '-q', 'one')
    assert.notEqual(git(root, 'merge', '--no-edit', 'two').status, 0)
    assert.deepEqual(resolveFrontmatterConflicts(root), { resolved: [], left: ['docs/knowledge/store.md'] })
    git(root, 'merge', '--abort')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

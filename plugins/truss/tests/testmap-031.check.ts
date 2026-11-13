// @ts-nocheck
// bin/testmap.ts (truss 0.31.0, speed goal item 1): a deterministic map from a diff to the tests that cover it. The pure core
// (selectTests) is pinned here on synthetic trees; selectForCheckout is pinned once on a real git repository. Node built-ins only.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DEFAULT_MAX_FILES, selectForCheckout, selectTests, stripBlanketSuite } from '../bin/testmap.ts'

const NODE_TEST = 'node --test lib/*.check.ts'
/** A tree as {path: text}; read() serves it, tracked lists it. */
function tree(files: Record<string, string>, changed: string[], extra: Record<string, unknown> = {}) {
  return selectTests({
    tracked: Object.keys(files),
    changed: changed.map((p) => ({ path: p, deleted: !Object.hasOwn(files, p) })),
    read: (p: string) => (Object.hasOwn(files, p) ? files[p] : null),
    config: {},
    packageTest: NODE_TEST,
    ...extra,
  })
}

const BASE = {
  'src/a.ts': "export const a = 1\n",
  'src/b.ts': "import { a } from './a.ts'\nexport const b = a\n",
  'src/c.ts': "export const c = 3\n",
  'src/flow.js': 'export default async function () {}\n',
  'tests/b.check.ts': "import { b } from '../src/b.ts'\n",
  'tests/c.check.ts': "import { c } from '../src/c.ts'\n",
  'tests/flow.check.ts': "import { readFileSync } from 'node:fs'\nconst src = readFileSync(path.join(root, 'src', 'flow.js'), 'utf8')\n",
  'tests/harness.ts': 'export const h = 1\n',
  'docs/guide.md': '# guide\n',
}

test('testmap: a changed file selects the test files that import it, transitively', () => {
  const s = tree(BASE, ['src/a.ts'])
  assert.equal(s.mode, 'targeted')
  assert.deepEqual(s.files, ['tests/b.check.ts'])
  assert.deepEqual(s.commands, ["node --test 'tests/b.check.ts'"])
  assert.ok(s.why.some((w) => /src\/a\.ts/.test(w) && /tests\/b\.check\.ts/.test(w)), s.why.join('\n'))
})

test('testmap: a test that names a file in a string literal covers it (a script read, not imported)', () => {
  const s = tree(BASE, ['src/flow.js'])
  assert.equal(s.mode, 'targeted')
  assert.deepEqual(s.files, ['tests/flow.check.ts'])
})

test('testmap: a file name in a source module makes no reach, and a nested package keeps its own tests', () => {
  const files = { ...BASE, 'src/a.ts': "export const a = 1\nconst doc = 'guide.md'\n", 'web/package.json': '{}', 'web/x.test.ts': "import '../src/c.ts'\n" }
  assert.deepEqual(tree(files, ['docs/guide.md']).files, [])
  assert.deepEqual(tree(files, ['src/c.ts']).files, ['tests/c.check.ts'])
})

test('testmap: a changed test file selects itself', () => {
  const s = tree(BASE, ['tests/c.check.ts'])
  assert.equal(s.mode, 'targeted')
  assert.deepEqual(s.files, ['tests/c.check.ts'])
})

test('testmap: reach unclear runs the full suite, and says why', () => {
  for (const [changed, re] of [
    [['package.json'], /package\.json/],
    [['.claude/truss.json'], /truss\.json/],
    [['tests/harness.ts'], /shared test helper/],
    [['src/lonely.ts'], /no test reaches/],
    [['src/gone.ts'], /deleted/],
    [['vite.config.ts'], /config/],
  ]) {
    const files = { ...BASE, 'package.json': '{}', '.claude/truss.json': '{}', 'src/lonely.ts': 'export const z = 1\n', 'vite.config.ts': 'export default {}\n' }
    const s = tree(files, changed)
    assert.equal(s.mode, 'full', `${changed} should run the full suite`)
    assert.ok(s.why.some((w) => re.test(w)), `${changed}: ${s.why.join(' | ')}`)
  }
})

test('testmap: a diff over the file limit runs the full suite', () => {
  const files = { ...BASE }
  const changed = []
  for (let i = 0; i <= DEFAULT_MAX_FILES; i++) {
    files[`docs/n${i}.md`] = 'x\n'
    changed.push(`docs/n${i}.md`)
  }
  const s = tree(files, changed)
  assert.equal(s.mode, 'full')
  assert.ok(s.why.some((w) => /over the limit/.test(w)), s.why.join('\n'))
  const small = tree(files, changed, { config: { maxFiles: 100 } })
  assert.equal(small.mode, 'targeted')
})

test('testmap: a doc no test names selects nothing and needs no full suite', () => {
  const s = tree(BASE, ['docs/guide.md'])
  assert.equal(s.mode, 'targeted')
  assert.deepEqual(s.files, [])
  assert.deepEqual(s.commands, [])
})

test('testmap: a config map entry adds a whole-repo check triggered by its inputs, and covers a non-JS file', () => {
  const files = { ...BASE, 'svc/app.py': 'x = 1\n', 'tests/cite.check.ts': '// citation check\n' }
  const config = { map: [{ paths: ['docs/**'], tests: ['tests/cite.check.ts'] }, { paths: ['svc/**/*.py'], run: 'pytest -q svc' }] }
  const doc = tree(files, ['docs/guide.md'], { config })
  assert.equal(doc.mode, 'targeted')
  assert.deepEqual(doc.files, ['tests/cite.check.ts'])
  const py = tree(files, ['svc/app.py'], { config })
  assert.equal(py.mode, 'targeted')
  assert.deepEqual(py.commands, ['pytest -q svc'])
  // without the map a Python file is reach unclear
  assert.equal(tree(files, ['svc/app.py']).mode, 'full')
})

test('testmap: fullOn globs and the configured runner and full command are honoured', () => {
  const config = { fullOn: ['src/c.ts'], full: 'make test', runner: 'npx vitest run' }
  const s = tree(BASE, ['src/c.ts'], { config })
  assert.equal(s.mode, 'full')
  assert.equal(s.full, 'make test')
  const t = tree(BASE, ['src/a.ts'], { config, packageTest: null })
  assert.deepEqual(t.commands, ["npx vitest run 'tests/b.check.ts'"])
})

test('testmap: JS tests with no known runner fall back to the full suite', () => {
  const s = tree(BASE, ['src/a.ts'], { packageTest: 'jest' })
  assert.equal(s.mode, 'full')
  assert.ok(s.why.some((w) => /runner/.test(w)), s.why.join('\n'))
})

test('testmap: stripBlanketSuite drops a trailing whole-suite step from an acceptance command', () => {
  const wave4 = 'set -u\nF=t.check.ts\nnode --test "$F" > "$O" 2>&1 || fail x\nN=$(mktemp) || fail "mktemp failed"\nnpm test > "$N" 2>&1 || { tail -40 "$N"; fail "npm test fails"; }\necho "c: ok"'
  const a = stripBlanketSuite(wave4)
  assert.equal(a.blanket, true)
  assert.doesNotMatch(a.command, /npm test >/)
  assert.match(a.command, /echo "c: ok"/)
  assert.deepEqual(stripBlanketSuite('node --test a.check.ts && npm test'), { command: 'node --test a.check.ts', blanket: true })
  assert.deepEqual(stripBlanketSuite('node --test a.check.ts'), { command: 'node --test a.check.ts', blanket: false })
})

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

test('testmap: selectForCheckout reads the diff from git and the runner from package.json', () => {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), 'testmap-031-')))
  git(d, 'init', '-q', '-b', 'main')
  for (const [p, t] of Object.entries({ ...BASE, 'package.json': JSON.stringify({ scripts: { test: NODE_TEST } }) })) {
    mkdirSync(path.dirname(path.join(d, p)), { recursive: true })
    writeFileSync(path.join(d, p), t)
  }
  git(d, 'add', '-A')
  git(d, 'commit', '-q', '-m', 'base')
  const base = git(d, 'rev-parse', 'HEAD')
  writeFileSync(path.join(d, 'src', 'c.ts'), 'export const c = 4\n')
  git(d, 'commit', '-q', '-am', 'change c')
  const s = selectForCheckout(d, base, {})
  assert.equal(s.mode, 'targeted')
  assert.deepEqual(s.files, ['tests/c.check.ts'])
  assert.equal(s.full, 'npm test')
})

// @ts-nocheck
// truss ADR-0033 review fixes, factory side:
//   1. owns-check exempts a file only when the crew's knowledge commit (subject `docs(knowledge): <slug> learned`) is the only commit
//      that changed it and it is a doc path (feature map, ADR dir, .claude/agents/*.md, any *.md); never code, never another member's edit
//   2. check --expect green lists the non-test source files the crew diff added, renamed or deleted (sourceChanges), so stage.js can
//      run the knowledge step without a learned item
//   3. featureMap and adrDir are keys of .claude/truss.json: declared in the schema, passed on to stage.js by start when they are
//      string paths inside the repo
// Run with: node --test tests/knowledge-scope.check.ts

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { addCrewWorktree, assertOneLine, crew, git, mkEnv, planObj, putFile, validate, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')
const t = (name, fn) => test(name, { timeout: 90000 }, fn)
const KNOWLEDGE = 'docs(knowledge): s learned'

function world(config = { merge: 'sequential', target: 'main' }, files = { 'a.txt': 'base\n' }) {
  const env = mkEnv({ config, files })
  writePlan(env.dir, planObj([crew('s', { owns: ['src/s/**'], status: 'running' })]))
  const wt = addCrewWorktree(env.repo, 's')
  return { env, wt }
}
// one commit with the given subject that writes every file in `files` ({path: text})
const commitAll = (wt, files, subject) => {
  for (const [rel, text] of Object.entries(files)) putFile(wt, rel, text)
  git(wt, ['add', '-A'])
  git(wt, ['commit', '-q', '-m', subject])
}
const owns = (env) => {
  const r = env.run('owns-check', { slug: 's' })
  return { status: r.status, outside: assertOneLine(r).outside ?? [] }
}

// ---------------------------------------------------------------- owns-check and the knowledge commit

t('scope 1: a knowledge commit that edits the feature map, an ADR, a persona, the product-owner file and a markdown target passes', () => {
  const { env, wt } = world()
  putFile(wt, 'src/s/a.ts', 'export {}\n', 'work')
  commitAll(wt, { 'docs/features.md': 'map\n', 'docs/adr/0040-x.md': 'adr\n', '.claude/agents/dev.md': 'persona\n', '.claude/agents/product-owner.md': 'po\n', 'README.md': 'readme\n', 'docs/knowledge/export.md': 'k\n' }, KNOWLEDGE)
  assert.deepEqual(owns(env), { status: 0, outside: [] })
})

t('scope 2: a knowledge commit that edits a .ts target fails; the doc files in the same commit still pass', () => {
  const { env, wt } = world()
  commitAll(wt, { 'docs/features.md': 'map\n', 'src/other/x.ts': 'export const x = 1\n' }, KNOWLEDGE)
  const r = owns(env)
  assert.equal(r.status, 1)
  assert.deepEqual(r.outside, ['src/other/x.ts'])
})

t('scope 3: a member code change outside owns still fails, and so does a member edit of a doc path', () => {
  const { env, wt } = world()
  putFile(wt, 'lib/out.ts', 'x\n', 'member work')
  putFile(wt, 'docs/features.md', 'member wrote this\n', 'member also edits the map')
  const r = owns(env)
  assert.equal(r.status, 1)
  assert.deepEqual([...r.outside].sort(), ['docs/features.md', 'lib/out.ts'])
})

t('scope 4: a doc a member also changed is not exempt, even when the knowledge commit changed it too', () => {
  const { env, wt } = world()
  putFile(wt, 'docs/features.md', 'member\n', 'member edits the map')
  putFile(wt, 'docs/features.md', 'member\nknowledge\n', KNOWLEDGE)
  assert.deepEqual(owns(env).outside, ['docs/features.md'])
})

t('scope 5: only a commit with the exact subject for this crew counts: another crew\'s subject or a longer one does not', () => {
  const { env, wt } = world()
  putFile(wt, 'docs/a.md', 'x\n', 'docs(knowledge): other learned')
  putFile(wt, 'docs/b.md', 'x\n', `${KNOWLEDGE} and more`)
  assert.deepEqual([...owns(env).outside].sort(), ['docs/a.md', 'docs/b.md'])
})

t('scope 6: the configured featureMap (any extension) and adrDir are doc paths of the knowledge commit; without the key they are not', () => {
  const cfg = { merge: 'sequential', target: 'main', featureMap: 'docs/capabilities.yaml', adrDir: 'decisions' }
  const a = world(cfg)
  commitAll(a.wt, { 'docs/capabilities.yaml': 'x: 1\n', 'decisions/0001-q.txt': 'q\n' }, KNOWLEDGE)
  assert.deepEqual(owns(a.env), { status: 0, outside: [] })
  const b = world()
  commitAll(b.wt, { 'docs/capabilities.yaml': 'x: 1\n', 'decisions/0001-q.txt': 'q\n' }, KNOWLEDGE)
  assert.deepEqual([...owns(b.env).outside].sort(), ['decisions/0001-q.txt', 'docs/capabilities.yaml'])
})

// ---------------------------------------------------------------- sourceChanges in the green check

t('diff 1: the green check lists added, renamed and deleted non-test source files; edits, tests, fixtures and docs are left out', () => {
  const { env, wt } = world(undefined, { 'a.txt': 'base\n', 'src/old.ts': 'export const old = 1\n', 'src/gone.py': 'x = 1\n', 'src/keep.ts': 'export const keep = 1\n' })
  git(wt, ['merge', '-q', 'main'], true)
  putFile(wt, 'src/new.ts', 'export const n = 1\n', 'add')
  git(wt, ['mv', 'src/old.ts', 'src/moved.ts'])
  git(wt, ['commit', '-q', '-m', 'move'])
  git(wt, ['rm', '-q', 'src/gone.py'])
  git(wt, ['commit', '-q', '-m', 'delete'])
  putFile(wt, 'src/keep.ts', 'export const keep = 2\n', 'edit only')
  putFile(wt, 'tests/new.check.ts', 'x\n', 'test')
  putFile(wt, 'src/fixtures/data.ts', 'x\n', 'fixture')
  putFile(wt, 'docs/guide.md', 'x\n', 'doc')
  putFile(wt, 'docs/example.ts', 'x\n', 'doc code')
  putFile(wt, 'package-lock.json', '{}\n', 'lock')
  const r = env.run('check', { slug: 's', cwd: wt, expect: 'green' })
  const j = assertOneLine(r)
  assert.equal(j.ok, true, JSON.stringify(j))
  const by = Object.fromEntries(j.sourceChanges.map((c) => [c.path, c]))
  assert.deepEqual(Object.keys(by).sort(), ['src/gone.py', 'src/moved.ts', 'src/new.ts'])
  assert.equal(by['src/new.ts'].status, 'A')
  assert.equal(by['src/gone.py'].status, 'D')
  assert.equal(by['src/moved.ts'].status, 'R')
  assert.equal(by['src/moved.ts'].from, 'src/old.ts')
})

t('diff 2: a crew that changed no source file has an empty sourceChanges, and a red check carries none', () => {
  const { env, wt } = world()
  putFile(wt, 'src/s/a.ts', 'x\n', 'work')
  git(wt, ['reset', '-q', '--hard', 'main'])
  const j = assertOneLine(env.run('check', { slug: 's', cwd: wt, expect: 'green' }))
  assert.deepEqual(j.sourceChanges, [])
})

// ---------------------------------------------------------------- config keys

const SCHEMA = JSON.parse(readFileSync(`${PLUGIN}/docs/truss-config.schema.json`, 'utf8'))

t('config 1: the schema declares featureMap and adrDir as non-empty repo-relative path strings', () => {
  for (const k of ['featureMap', 'adrDir']) {
    const s = SCHEMA.properties[k]
    assert.ok(s, `${k} is declared`)
    assert.equal(s.type, 'string')
    for (const good of ['docs/features.md', 'features.md', 'docs/adr', 'a/b/c.yaml']) assert.deepEqual(validate(s, good), [], `${k}: ${good}`)
    for (const bad of ['', '/etc/passwd', '../x.md', 'a/../../x', 'C:\\x.md', 'C:/x.md', 'a\\b', 5, null]) assert.ok(validate(s, bad).length > 0, `${k}: ${JSON.stringify(bad)} is refused`)
  }
})

function startArgs(config) {
  const env = mkEnv({ config })
  writePlan(env.dir, planObj([crew('s')]))
  writeGoal(env.dir, 's', {})
  const r = env.run('start', { stage: 'next' })
  return assertOneLine(r).truss
}

t('config 2: start passes a valid featureMap and adrDir to stage.js, and nothing when they are absent', () => {
  const on = startArgs({ merge: 'sequential', target: 'main', featureMap: 'docs/capabilities.md', adrDir: 'decisions/' })
  assert.equal(on.featureMap, 'docs/capabilities.md')
  assert.equal(on.adrDir, 'decisions')
  const off = startArgs({ merge: 'sequential', target: 'main' })
  assert.ok(!Object.hasOwn(off, 'featureMap') && !Object.hasOwn(off, 'adrDir'))
})

t('config 3: a featureMap or adrDir that is absolute, climbs out of the repo or is not a string is dropped; adr stands in for a missing adrDir', () => {
  for (const bad of ['/etc/x.md', '../x.md', 'a/../../x.md', 'C:/x.md', '', 5, ['x']]) {
    const a = startArgs({ merge: 'sequential', target: 'main', featureMap: bad, adrDir: bad })
    assert.ok(!Object.hasOwn(a, 'featureMap'), `featureMap ${JSON.stringify(bad)}`)
    assert.ok(!Object.hasOwn(a, 'adrDir'), `adrDir ${JSON.stringify(bad)}`)
  }
  assert.equal(startArgs({ merge: 'sequential', target: 'main', adr: 'docs/decisions' }).adrDir, 'docs/decisions')
  assert.equal(startArgs({ merge: 'sequential', target: 'main', adr: 'docs/decisions', adrDir: 'adrs' }).adrDir, 'adrs')
})

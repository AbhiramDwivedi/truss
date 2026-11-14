// @ts-nocheck
// truss ADR-0033 review fixes, factory side:
//   1. owns-check exempts a .md file on a doc path (feature map, architecture doc, ADR dir, rules and knowledge dirs, agents index,
//      product decisions, .claude/agents/*.md body, item targets) that any crew commit changed (ADR-0046 item 0: the crew owns its
//      docs); never code
//   2. check --expect green lists the non-test source files the crew diff added, renamed or deleted (sourceChanges), so stage.js can
//      run the knowledge step without a learned item
//   3. featureMap and adrDir are keys of .claude/truss.json: declared in the schema, passed on to stage.js by start when they are
//      string paths inside the repo
// Run with: node --test tests/knowledge-scope.check.ts

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
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

const FM = (extra = '') => `---\nname: dev\ndescription: dev area\nmodel: sonnet\n${extra}---\n\n`
const PERSONA_BASE = { '.claude/agents/dev.md': `${FM()}## Standards\n\n- old rule\n`, '.claude/agents/product-owner.md': `${FM().replace('name: dev', 'name: product-owner')}## Standards\n\n- old\n` }
// records the head as the crew's knowledge commit, and the given markdown targets as the crew's learned item targets
const record = (env, wt, targets = []) => {
  const sha = git(wt, ['rev-parse', 'HEAD'])
  const r = env.run('knowledge-commit', { slug: 's', sha })
  assert.equal(r.status, 0, r.stderr + r.stdout)
  if (targets.length) {
    const items = targets.map((target) => ({ kind: 'feature', text: 'a fact', source: '', target }))
    assert.equal(env.run('crew-learned', { slug: 's' }, [`--add=${JSON.stringify(items)}`]).status, 0)
  }
  return sha
}
const ownsFull = (env) => {
  const r = env.run('owns-check', { slug: 's' })
  return { status: r.status, outside: r.json.outside ?? [], exempt: r.json.exempt ?? [] }
}

t('scope 1: a recorded knowledge commit that edits the feature map, an ADR, a persona body and a knowledge doc passes them as exempt; the product-owner file and an item target off the doc paths are not', () => {
  const { env, wt } = world(undefined, { 'a.txt': 'base\n', ...PERSONA_BASE })
  putFile(wt, 'src/s/a.ts', 'export {}\n', 'work')
  commitAll(wt, { 'docs/features.md': 'map\n', 'docs/adr/0040-x.md': 'adr\n', '.claude/agents/dev.md': `${FM()}## Standards\n\n- old rule\n- new rule\n`, '.claude/agents/product-owner.md': `${FM().replace('name: dev', 'name: product-owner')}## Standards\n\n- old\n- new call\n`, 'AGENTS.md': 'agents\n', 'NOTES.md': 'n\n', 'docs/knowledge/export.md': 'k\n' }, KNOWLEDGE)
  record(env, wt, ['NOTES.md', 'docs/knowledge/export.md'])
  const r = ownsFull(env)
  // ADR-0046 review: a judge persona is never a crew's to edit, and a learned item's target (NOTES.md) widens nothing;
  // the configured agents index changed by the knowledge commit alone is a prompt file the knowledge member may write
  assert.deepEqual({ status: r.status, outside: [...r.outside].sort() }, { status: 1, outside: ['.claude/agents/product-owner.md', 'NOTES.md'] })
  assert.deepEqual([...r.exempt].sort(), ['.claude/agents/dev.md', 'AGENTS.md', 'docs/adr/0040-x.md', 'docs/features.md', 'docs/knowledge/export.md'])
})

t('scope 2: a knowledge commit that edits a .ts target fails; the doc files in the same commit still pass', () => {
  const { env, wt } = world()
  commitAll(wt, { 'docs/features.md': 'map\n', 'src/other/x.ts': 'export const x = 1\n' }, KNOWLEDGE)
  record(env, wt, ['src/other/x.ts'])
  const r = ownsFull(env)
  assert.equal(r.status, 1)
  assert.deepEqual(r.outside, ['src/other/x.ts'])
  assert.deepEqual(r.exempt, ['docs/features.md'])
})

t('scope 2b (ADR-0046 item 0): the exemption needs no knowledge-commit record: a crew doc commit is exempt with or without one', () => {
  const { env, wt } = world()
  commitAll(wt, { 'docs/features.md': 'map\n' }, 'feat: the builder updates the map with its code')
  assert.deepEqual(ownsFull(env), { status: 0, outside: [], exempt: ['docs/features.md'] }, 'no record')
  record(env, wt)
  assert.deepEqual(ownsFull(env), { status: 0, outside: [], exempt: ['docs/features.md'] }, 'with a record')
})

t('scope 2c (review 6): only .md files are exempt: a featureMap or adrDir file of another extension is not; CLAUDE.md is not, item target or not; AGENTS.md is only as the agents index changed by the knowledge commit alone', () => {
  const cfg = { merge: 'sequential', target: 'main', featureMap: 'docs/capabilities.yaml', adrDir: 'decisions' }
  const { env, wt } = world(cfg)
  commitAll(wt, { 'docs/capabilities.yaml': 'x: 1\n', 'decisions/0001-q.txt': 'q\n', 'decisions/0002-q.md': 'q\n', 'CLAUDE.md': 'rules\n', 'AGENTS.md': 'r\n' }, KNOWLEDGE)
  record(env, wt, ['CLAUDE.md'])
  const r = ownsFull(env)
  assert.deepEqual([...r.outside].sort(), ['CLAUDE.md', 'decisions/0001-q.txt', 'docs/capabilities.yaml'])
  assert.deepEqual([...r.exempt].sort(), ['AGENTS.md', 'decisions/0002-q.md'])
  const b = world()
  putFile(b.wt, 'AGENTS.md', 'builder rewrites the index\n', 'builder edits the agents index')
  assert.deepEqual(ownsFull(b.env), { status: 1, outside: ['AGENTS.md'], exempt: [] })
})

t('scope 2d (review 6): a change to a persona\'s YAML frontmatter is never exempt, a body-only change is; a new persona file with frontmatter is not', () => {
  const UI = `${FM().replace('name: dev', 'name: ui')}## Standards\n\n- old\n`
  const { env, wt } = world(undefined, { 'a.txt': 'base\n', ...PERSONA_BASE, '.claude/agents/ui.md': UI })
  commitAll(wt, {
    '.claude/agents/dev.md': `${FM('tools: Read, Write, Edit, Bash\n')}## Standards\n\n- old rule\n`, // frontmatter gains a tools line
    '.claude/agents/ui.md': `${UI}- new\n`, // body only
    '.claude/agents/product-owner.md': `${FM().replace('name: dev', 'name: product-owner')}## Standards\n\n- old\n- new\n`, // body only, but a judge
    '.claude/agents/fresh.md': `${FM().replace('name: dev', 'name: fresh')}## Standards\n\n- x\n`,
  }, KNOWLEDGE)
  record(env, wt)
  const r = ownsFull(env)
  assert.deepEqual([...r.outside].sort(), ['.claude/agents/dev.md', '.claude/agents/fresh.md', '.claude/agents/product-owner.md'])
  assert.deepEqual(r.exempt, ['.claude/agents/ui.md'])
})

t('scope 2e (review 6): a non-ASCII doc path is exempt: owns-check and the exemption read paths with the same core.quotepath=off', () => {
  const { env, wt } = world()
  commitAll(wt, { 'docs/knowledge/übersicht.md': 'k\n', 'docs/adr/0041-ünï.md': 'adr\n' }, KNOWLEDGE)
  record(env, wt)
  assert.deepEqual(ownsFull(env), { status: 0, outside: [], exempt: ['docs/adr/0041-ünï.md', 'docs/knowledge/übersicht.md'] })
})

t('scope 3 (ADR-0046 item 0): a member code change outside owns still fails; a member edit of a doc path is exempt (the crew owns its docs)', () => {
  const { env, wt } = world()
  putFile(wt, 'lib/out.ts', 'x\n', 'member work')
  putFile(wt, 'docs/features.md', 'member wrote this\n', 'member also edits the map')
  const r = ownsFull(env)
  assert.equal(r.status, 1)
  assert.deepEqual(r.outside, ['lib/out.ts'])
  assert.deepEqual(r.exempt, ['docs/features.md'])
})

t('scope 4 (ADR-0046 item 0): a doc both a member and the knowledge commit changed is exempt; a .md off the doc paths is not, under docs/ or not', () => {
  const { env, wt } = world()
  putFile(wt, 'docs/features.md', 'member\n', 'member edits the map')
  putFile(wt, 'docs/features.md', 'member\nknowledge\n', KNOWLEDGE)
  putFile(wt, 'docs/a.md', 'x\n', 'member writes a loose doc')
  putFile(wt, 'notes/a.md', 'x\n', 'member writes a note off the doc paths')
  record(env, wt)
  assert.deepEqual(ownsFull(env), { status: 1, outside: ['docs/a.md', 'notes/a.md'], exempt: ['docs/features.md'] })
})

t('scope 5 (ADR-0046 item 0): the architecture doc (truss.json `architecture`, default docs/architecture.md) is a doc path', () => {
  const a = world()
  putFile(a.wt, 'docs/architecture.md', 'x\n', 'builder updates the module map')
  assert.deepEqual(ownsFull(a.env), { status: 0, outside: [], exempt: ['docs/architecture.md'] })
  const b = world({ merge: 'sequential', target: 'main', architecture: 'arch/ARCH.md' })
  putFile(b.wt, 'arch/ARCH.md', 'x\n', 'builder updates the module map')
  putFile(b.wt, 'ARCHITECTURE.md', 'x\n', 'not the configured doc')
  assert.deepEqual(ownsFull(b.env), { status: 1, outside: ['ARCHITECTURE.md'], exempt: ['arch/ARCH.md'] })
})

t('scope 5b (ADR-0046 review): a builder edit of a skill it does not own is never exempt, body or frontmatter; the knowledge commit may change a body only', () => {
  const SK = (desc, body) => `---\nname: export\ndescription: ${desc}\n---\n\n${body}`
  const base = { 'a.txt': 'base\n', '.claude/skills/export/SKILL.md': SK('exports', 'old\n'), '.claude/skills/ship/SKILL.md': SK('ships', 'old\n'), 'plugins/p/skills/run/SKILL.md': SK('runs', 'old\n') }
  const a = world(undefined, base)
  putFile(a.wt, '.claude/skills/export/SKILL.md', SK('exports', 'new behaviour\n'), 'builder keeps the skill true to the code')
  putFile(a.wt, 'plugins/p/skills/run/SKILL.md', SK('runs', 'new behaviour\n'), 'builder edits a plugin skill body')
  putFile(a.wt, '.claude/skills/ship/SKILL.md', SK('ships everything', 'old\n'), 'builder changes when the skill loads')
  assert.deepEqual(ownsFull(a.env), { status: 1, outside: ['.claude/skills/export/SKILL.md', '.claude/skills/ship/SKILL.md', 'plugins/p/skills/run/SKILL.md'], exempt: [] })
  const b = world(undefined, base)
  commitAll(b.wt, { '.claude/skills/export/SKILL.md': SK('exports', 'new behaviour\n'), 'plugins/p/skills/run/SKILL.md': SK('runs', 'new\n'), '.claude/skills/ship/SKILL.md': SK('ships everything', 'old\n') }, KNOWLEDGE)
  record(b.env, b.wt)
  assert.deepEqual(ownsFull(b.env), { status: 1, outside: ['.claude/skills/ship/SKILL.md'], exempt: ['.claude/skills/export/SKILL.md', 'plugins/p/skills/run/SKILL.md'] })
})

t('scope 5c (ADR-0046 review): every exempt file keeps its frontmatter: an ADR body edit is exempt, an ADR frontmatter edit is not; a knowledge doc\'s verified and sources may change; a README or CHANGELOG is never a free doc', () => {
  const D = (fm, body) => `---\n${fm}---\n\n${body}`
  const K = (v, src) => D(`verified: ${v}\nsources:\n${src.map((s) => `  - ${s}\n`).join('')}kind: area\n`, 'k\n')
  const { env, wt } = world(undefined, { 'a.txt': 'base\n', 'docs/adr/0001-guide.md': D('title: Guide\n', 'old\n'), 'docs/adr/0002-how.md': D('title: How\n', 'old\n'), 'docs/knowledge/x.md': K('aaa', ['src/a.ts']), 'docs/knowledge/y.md': K('aaa', ['src/a.ts']) })
  putFile(wt, 'docs/adr/0001-guide.md', D('title: Guide\n', 'new\n'), 'builder updates the ADR body')
  putFile(wt, 'docs/adr/0002-how.md', D('title: How it really works\n', 'old\n'), 'builder retitles an ADR')
  putFile(wt, 'docs/knowledge/x.md', K('bbb', ['src/a.ts', 'src/b.ts']), 'builder re-stamps the knowledge doc')
  putFile(wt, 'docs/knowledge/y.md', K('aaa', ['src/a.ts']).replace('kind: area', 'kind: flow'), 'builder changes another key')
  putFile(wt, 'pkg/README.md', 'r\n', 'builder writes a package readme')
  putFile(wt, 'CHANGELOG.md', 'c\n', 'builder adds a changelog line')
  assert.deepEqual(ownsFull(env), { status: 1, outside: ['CHANGELOG.md', 'docs/adr/0002-how.md', 'docs/knowledge/y.md', 'pkg/README.md'], exempt: ['docs/adr/0001-guide.md', 'docs/knowledge/x.md'] })
})

t('scope 5d (ADR-0046 review): an agent file is a prompt file at any depth: a builder edit of a non-owned agents/*.md is not exempt, a QC or checking agent never is', () => {
  const A = (name, body) => `---\nname: ${name}\n---\n\n${body}`
  const base = { 'a.txt': 'base\n', 'plugins/p/agents/writer.md': A('writer', 'old\n'), 'plugins/p/agents/qc-engineer.md': A('qc', 'old\n'), 'plugins/p/agents/checking-engineer.md': A('checking', 'old\n') }
  const a = world(undefined, base)
  putFile(a.wt, 'plugins/p/agents/writer.md', A('writer', 'new\n'), 'builder edits an agent body')
  assert.deepEqual(ownsFull(a.env), { status: 1, outside: ['plugins/p/agents/writer.md'], exempt: [] })
  const b = world(undefined, base)
  commitAll(b.wt, { 'plugins/p/agents/writer.md': A('writer', 'new\n'), 'plugins/p/agents/qc-engineer.md': A('qc', 'new\n'), 'plugins/p/agents/checking-engineer.md': A('checking', 'new\n') }, KNOWLEDGE)
  record(b.env, b.wt)
  assert.deepEqual(ownsFull(b.env), { status: 1, outside: ['plugins/p/agents/checking-engineer.md', 'plugins/p/agents/qc-engineer.md'], exempt: ['plugins/p/agents/writer.md'] })
})

t('scope 5e (0.32.0 hotfix): a knowledge commit\'s rule fragment may carry verified and sources frontmatter; a fragment that changes paths is never exempt, and a rule file is exempt only for a verified and sources change', () => {
  const R = (fm, body) => `---\n${fm}---\n\n${body}`
  const base = { 'a.txt': 'base\n', '.claude/rules/area.md': R('paths:\n  - "src/**"\nsources:\n  - src/a.ts\nverified: aaa\n', '## Rules\n\n- old\n') }
  const a = world(undefined, base)
  commitAll(a.wt, { '.claude/rules.d/area/s.md': R('sources:\n  - src/b.ts\nverified: bbb\n', '## More\n\n- new\n') }, KNOWLEDGE)
  record(a.env, a.wt)
  assert.deepEqual(ownsFull(a.env), { status: 0, outside: [], exempt: ['.claude/rules.d/area/s.md'] })
  const b = world(undefined, base)
  commitAll(b.wt, { '.claude/rules/area.md': R('paths:\n  - "src/**"\nsources:\n  - src/a.ts\n  - src/b.ts\nverified: bbb\n', '## Rules\n\n- old\n'), '.claude/rules.d/area/s.md': R('paths:\n  - "lib/**"\n', '## More\n\n- new\n') }, KNOWLEDGE)
  record(b.env, b.wt)
  // the rule file's own change is only verified and sources, bookkeeping the owns check accepts; the fragment that changes paths is not
  assert.deepEqual(ownsFull(b.env), { status: 1, outside: ['.claude/rules.d/area/s.md'], exempt: ['.claude/rules/area.md'] })
})

t('scope 6: the configured featureMap and adrDir (as .md) are doc paths of the recorded knowledge commit; without the key they are not', () => {
  const cfg = { merge: 'sequential', target: 'main', featureMap: 'docs/capabilities.md', adrDir: 'decisions' }
  const a = world(cfg)
  commitAll(a.wt, { 'docs/capabilities.md': 'x\n', 'decisions/0001-q.md': 'q\n' }, KNOWLEDGE)
  record(a.env, a.wt)
  assert.deepEqual(owns(a.env), { status: 0, outside: [] })
  const b = world()
  commitAll(b.wt, { 'docs/capabilities.md': 'x\n', 'decisions/0001-q.md': 'q\n' }, KNOWLEDGE)
  record(b.env, b.wt)
  assert.deepEqual([...owns(b.env).outside].sort(), ['decisions/0001-q.md', 'docs/capabilities.md'])
})

t('scope 7 (review 14): repoPathOf turns a Windows backslash path into a repo path, then validates it', async () => {
  const f = await import('../bin/factory.ts')
  assert.equal(f.repoPathOf('docs\\features.md'), 'docs/features.md')
  assert.equal(f.repoPathOf('.\\docs\\adr\\'), 'docs/adr')
  for (const bad of ['..\\x.md', 'a\\..\\..\\x', '\\etc\\passwd', 'C:\\x.md', 'C:/x.md', '/etc/x', 'a\nb', '']) assert.equal(f.repoPathOf(bad), undefined, JSON.stringify(bad))
  assert.equal(startArgs({ merge: 'sequential', target: 'main', featureMap: 'docs\\caps.md', adrDir: 'docs\\decisions' }).featureMap, 'docs/caps.md')
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

// ADR-0046 item 3: a stress-fix round's green check names the test files changed since the round's start head
t('diff 3: check --expect green --tests-since <sha> lists the test files changed since that sha, and [] when none', () => {
  const { env, wt } = world(undefined, { 'a.txt': 'base\n', 'tests/old.check.ts': 'x\n' })
  git(wt, ['merge', '-q', 'main'], true)
  putFile(wt, 'src/s/a.ts', 'x\n', 'work')
  const since = git(wt, ['rev-parse', 'HEAD']).trim()
  putFile(wt, 'src/s/a.ts', 'y\n', 'fix, no test')
  const none = assertOneLine(env.run('check', { slug: 's', cwd: wt, expect: 'green', 'tests-since': since }))
  assert.equal(none.ok, true, JSON.stringify(none))
  assert.deepEqual(none.testsSince, [])
  putFile(wt, 'tests/s/a.check.ts', 'x\n', 'regression case')
  putFile(wt, 'docs/s.md', 'x\n', 'doc')
  const some = assertOneLine(env.run('check', { slug: 's', cwd: wt, expect: 'green', 'tests-since': since }))
  assert.deepEqual(some.testsSince, ['tests/s/a.check.ts'])
  // without the flag, or with one that is not a sha, the field is absent: an old stage.js sees no change
  assert.equal('testsSince' in assertOneLine(env.run('check', { slug: 's', cwd: wt, expect: 'green' })), false)
  assert.equal('testsSince' in assertOneLine(env.run('check', { slug: 's', cwd: wt, expect: 'green', 'tests-since': 'HEAD~1;x' })), false)
})

t('diff 3b (ADR-0046 review): with no tracked file a test by name or by testGlobs, the list is unknown: testsUnknown says so, testsSince is absent', () => {
  const { env, wt } = world(undefined, { 'a.txt': 'base\n', 'lib/a_spec.rb': 'x\n' })
  putFile(wt, 'src/s/a.ts', 'x\n', 'work')
  const since = git(wt, ['rev-parse', 'HEAD']).trim()
  putFile(wt, 'src/s/a.ts', 'y\n', 'fix, no test')
  const j = assertOneLine(env.run('check', { slug: 's', cwd: wt, expect: 'green', 'tests-since': since }))
  assert.equal(j.ok, true, JSON.stringify(j))
  assert.equal('testsSince' in j, false)
  assert.match(j.testsUnknown, /no tracked file is a test file.*testGlobs/)
})

t('diff 3c (ADR-0046 review): testGlobs in .claude/truss.json names the project\'s test files, so a file of its own layout counts', () => {
  const { env, wt } = world({ merge: 'sequential', target: 'main', testGlobs: ['lib/**/*_spec.rb'] }, { 'a.txt': 'base\n', 'lib/a_spec.rb': 'x\n' })
  putFile(wt, 'src/s/a.ts', 'x\n', 'work')
  const since = git(wt, ['rev-parse', 'HEAD']).trim()
  putFile(wt, 'src/s/a.ts', 'y\n', 'fix, no test')
  const none = assertOneLine(env.run('check', { slug: 's', cwd: wt, expect: 'green', 'tests-since': since }))
  assert.deepEqual({ list: none.testsSince, unknown: 'testsUnknown' in none }, { list: [], unknown: false })
  putFile(wt, 'lib/s/b_spec.rb', 'x\n', 'regression case')
  const some = assertOneLine(env.run('check', { slug: 's', cwd: wt, expect: 'green', 'tests-since': since }))
  assert.deepEqual(some.testsSince, ['lib/s/b_spec.rb'])
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

t('scope 6: knowledge-commit with --base and --head reports the files of the range and no docsOnly (green always re-runs after the knowledge commit); without them it prints no files', () => {
  const { env, wt } = world()
  const base = git(wt, ['rev-parse', 'HEAD'])
  commitAll(wt, { 'docs/features.md': 'map\n', 'docs/UP.MD': 'x\n' }, KNOWLEDGE)
  const docsHead = git(wt, ['rev-parse', 'HEAD'])
  const d = env.run('knowledge-commit', { slug: 's', sha: docsHead }, [`--base=${base}`, `--head=${docsHead}`])
  assert.equal(d.status, 0, d.stderr + d.stdout)
  assert.deepEqual([...d.json.files].sort(), ['docs/UP.MD', 'docs/features.md'])
  assert.ok(!Object.hasOwn(d.json, 'docsOnly'), 'markdown can be test input, so the factory no longer calls a commit docs-only')
  commitAll(wt, { 'src/s/x.ts': 'export {}\n' }, KNOWLEDGE)
  const codeHead = git(wt, ['rev-parse', 'HEAD'])
  const c = env.run('knowledge-commit', { slug: 's', sha: codeHead }, [`--base=${base}`, `--head=${codeHead}`])
  assert.ok(c.json.files.includes('src/s/x.ts'))
  assert.ok(!Object.hasOwn(c.json, 'docsOnly'))
  const plain = env.run('knowledge-commit', { slug: 's', sha: codeHead }, [`--base=${base}`])
  assert.equal(plain.status, 0)
  assert.ok(!Object.hasOwn(plain.json, 'docsOnly') && !Object.hasOwn(plain.json, 'files'))
})

t('scope 6b (review 3): with --base and --head the sha must be a non-merge commit in base..head; any other sha is a usage error and records nothing', () => {
  const { env, wt } = world()
  const early = git(wt, ['rev-parse', 'HEAD'])
  commitAll(wt, { 'docs/a.md': 'a\n' }, 'work')
  const base = git(wt, ['rev-parse', 'HEAD'])
  git(wt, ['checkout', '-q', '-b', 'side'])
  commitAll(wt, { 'docs/k.md': 'k\n' }, KNOWLEDGE)
  const kn = git(wt, ['rev-parse', 'HEAD'])
  git(wt, ['checkout', '-q', 'truss-s'])
  commitAll(wt, { 'docs/b.md': 'b\n' }, 'other work')
  git(wt, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side'])
  const merge = git(wt, ['rev-parse', 'HEAD'])
  const range = [`--base=${base}`, `--head=${merge}`]
  for (const outside of [early, base, merge]) {
    const r = env.run('knowledge-commit', { slug: 's', sha: outside }, range)
    assert.equal(r.status, 2, `${outside} must be refused: ${r.stdout}${r.stderr}`)
  }
  assert.ok(!existsSync(`${env.dir}/crews/s/knowledge-commit.json`), 'a refused sha records nothing')
  const ok = env.run('knowledge-commit', { slug: 's', sha: kn }, range)
  assert.equal(ok.status, 0, ok.stderr + ok.stdout)
  assert.equal(ok.json.sha, kn)
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

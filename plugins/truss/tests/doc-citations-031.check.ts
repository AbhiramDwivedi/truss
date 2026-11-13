// @ts-nocheck
// Truss 0.31.0 item 4: docs cite code by symbol, never by line. A line number goes stale with every edit above it, and two
// crews that both re-point one citation conflict on it. This lint runs in the default suite over the plugin docs (ADRs and
// goals included), the repo docs (feature map, knowledge docs) and the rule files.
//
// Run with: node --test plugins/truss/tests/doc-citations-031.check.ts

import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { selectTests } from '../bin/testmap.ts'
import { CITATION_DOC_ROOTS, citationDocs, citationLintFailures, lineCitations } from './fixtures/citations/line-citations.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const texts = (md) => lineCitations(md).map((c) => c.text)

test('doc-citations: the lint finds every line-citation form', () => {
  assert.deepEqual(texts('The lock is broken in `bin/store.ts:204`.'), ['store.ts:204'])
  assert.deepEqual(texts('See `ux-engineer.md:41-42` and `register.ts:2200`.'), ['ux-engineer.md:41-42', 'register.ts:2200'])
  assert.deepEqual(texts('`uxReviewPrompt` gives the green tail only (`:1046-1047`).'), [':1046-1047'])
  assert.deepEqual(texts('`fixPrompt` (:431) opens with a merge step (:445-446).'), [':431', ':445-446'])
  assert.deepEqual(texts('`recordRun`, `:1489-1496`, called at `:1778`.'), [':1489-1496', ':1778'])
  assert.deepEqual(texts('README.md:16-17 says so, and roles.json:5 too.'), ['README.md:16-17', 'roles.json:5'])
  assert.deepEqual(texts('A GitHub anchor `a.js#L12` is a line citation too.'), ['a.js#L12'])
})

test('doc-citations: symbol citations, times and fenced examples pass', () => {
  assert.deepEqual(texts('The lock is broken in `bin/store.ts` `withLock`.'), [])
  assert.deepEqual(texts('`README.md` section "Install" says so.'), [])
  assert.deepEqual(texts('The client ruled at 21:23 (decisions.md, 04:28), ratio 1:2.'), [])
  assert.deepEqual(texts('Stage `0.31.0` ships `factory.ts` and a `http://localhost:8080` page.'), [])
  assert.deepEqual(texts('```\nsrc/a.ts:40-90\n```\nafter the fence `b.ts:3`'), ['b.ts:3'])
  assert.deepEqual(lineCitations('one\n\ntwo `c.ts:9`').map((c) => c.line), [3])
})

test('doc-citations: the lint covers plugin docs, ADRs, knowledge and rule files of a tree', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'doc-citations-'))
  try {
    const put = (rel, text) => {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      writeFileSync(path.join(root, rel), text)
    }
    put('plugins/truss/docs/architecture.md', 'Clean: `bin/store.ts` `withLock`.\n')
    put('plugins/truss/docs/adr/0001-x.md', 'Stale: `register.ts:12`.\n')
    put('docs/knowledge/store.md', '---\nsources:\n  - plugins/truss/bin/store.ts\n---\nSee (`:40`).\n')
    put('.claude/rules/area.md', 'Cites `gates.check.ts:194`.\n')
    put('plugins/truss/src/code.md.ts', 'not a doc: `a.ts:1`\n')
    assert.deepEqual(citationDocs(root), ['plugins/truss/docs/adr/0001-x.md', 'plugins/truss/docs/architecture.md', 'docs/knowledge/store.md', '.claude/rules/area.md'])
    assert.deepEqual(citationLintFailures(root), [
      'plugins/truss/docs/adr/0001-x.md:1 cites register.ts:12',
      'docs/knowledge/store.md:5 cites :40',
      '.claude/rules/area.md:1 cites gates.check.ts:194',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('doc-citations: no doc in this repo cites code by line number', () => {
  const docs = citationDocs(ROOT)
  assert.ok(docs.some((d) => d.startsWith('plugins/truss/docs/adr/')) && docs.includes('docs/knowledge/store.md'), `the lint found too few docs: ${docs.length}`)
  const fails = citationLintFailures(ROOT)
  assert.deepEqual(fails, [], `${fails.length} line citation(s); cite the symbol (function, constant, test title) or the section heading instead:\n${fails.join('\n')}`)
})

test('doc-citations: a change to any doc the lint scans selects the citation checks (targetedTests.map)', () => {
  const config = JSON.parse(readFileSync(path.join(ROOT, '.claude', 'truss.json'), 'utf8')).targetedTests
  for (const dir of CITATION_DOC_ROOTS) {
    const doc = `${dir}/sub/some-doc.md`
    const s = selectTests({ tracked: [doc], changed: [{ path: doc, deleted: false }], read: () => '', config, packageTest: 'node --test' })
    assert.equal(s.mode, 'targeted', `${doc}: ${s.why.join('; ')}`)
    for (const t of ['doc-citations-031', 'release-026']) assert.ok(s.files.some((f) => f.endsWith(`/${t}.check.ts`)), `${doc} does not select ${t}: ${s.files.join(', ')}`)
  }
})

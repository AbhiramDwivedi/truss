// @ts-nocheck
// Truss 0.32.0 heavy-slots QC findings: the heavy-slots ADR must not take a number the plan gives to another crew, and the
// heavy-slots architecture fragment must survive stitchDoc whole.
//
// Run with: node --test plugins/truss/tests/heavy-slots-qc-032.check.ts

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { stitchDoc } from '../bin/fragments.ts'
import { docText, pendingFragment } from './fixtures/doc-text.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const plugin = path.resolve(here, '..')
const repo = path.resolve(plugin, '..', '..')
const adrDir = path.join(plugin, 'docs', 'adr')

// plan.md gives ADR-0052 to run-survival and ADR-0053 to deferred-fixes; heavy-slots may not take either.
const RESERVED = ['0052', '0053']

test('heavy-slots QC: the heavy-slots ADR takes no number the plan gives to another crew', () => {
  const adrs = readdirSync(adrDir).filter((f) => /heavy-slot/.test(f) && f.endsWith('.md'))
  assert.equal(adrs.length, 1, `expected one heavy-slots ADR, found ${adrs.join(', ')}`)
  const num = adrs[0].slice(0, 4)
  assert.ok(!RESERVED.includes(num), `${adrs[0]} uses ADR-${num}, which the plan gives to run-survival or deferred-fixes`)
})

// The feature doc is read through docText: the stitched doc, or the doc plus any pending fragment before the stitch.
test('heavy-slots QC: the features fragment links to the heavy-slots ADR file, which names its own number', () => {
  const frag = docText('docs/features.md')
  const m = frag.match(/\[ADR-(\d{4})\]\(\.\.\/plugins\/truss\/docs\/adr\/([^)]+)\)/g) ?? []
  const heavy = m.map((x) => x.match(/\[ADR-(\d{4})\]\(\.\.\/plugins\/truss\/docs\/adr\/([^)]+)\)/)).filter((x) => /heavy-slot/.test(x[2]))
  assert.equal(heavy.length, 1, 'the fragment should link the heavy-slots ADR once')
  const [, num, file] = heavy[0]
  assert.ok(!RESERVED.includes(num), `the fragment links ADR-${num}, a number the plan gives to another crew`)
  assert.ok(file.startsWith(`${num}-`), `link text ADR-${num} does not match file ${file}`)
  const body = readFileSync(path.join(adrDir, file), 'utf8')
  assert.match(body.split('\n')[0], new RegExp(`^# ADR-${num}:`))
})

test('heavy-slots QC: stitchDoc keeps the whole heavy-slots architecture fragment, its ### section and the cmdAdmit paragraph', () => {
  const ARCH = 'plugins/truss/docs/architecture.md'
  const doc = readFileSync(path.join(plugin, 'docs', 'architecture.md'), 'utf8')
  const text = pendingFragment(ARCH, 'heavy-slots.md')
  // Once the stitch step has folded the fragment in, the stitched doc is what must hold the sections.
  const r = text === undefined ? { text: doc, warnings: [] } : stitchDoc(doc, [{ name: 'heavy-slots.md', text }])
  assert.ok(r.text.includes('### Admission and reap folds in stage.js (R-142, 0.32.0)'), 'the ### section heading was dropped')
  assert.ok(r.text.includes('`cmdAdmit` in `bin/factory/admit.ts` reaps too.'), 'the cmdAdmit reap paragraph was dropped')
  assert.ok(r.text.includes('## Heavy job on win32 and the run limit (0.32.0)'), 'the ## section was dropped')
  assert.deepEqual(r.warnings, [], `stitchDoc warned: ${r.warnings.join('; ')}`)
})

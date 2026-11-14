// Regression cases for the retro-generic architecture fragment (QC findings on d4ae569).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { stitchDoc } from '../bin/fragments.ts'
import { docText, pendingFragment } from './fixtures/doc-text.ts'

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p: string[]) => readFileSync(path.join(PLUGIN, ...p), 'utf8')
const DOC = read('docs', 'architecture.md')
const ARCH = 'plugins/truss/docs/architecture.md'
// The fragment is transient: once the stitch step folds it into architecture.md it is gone, and the doc text stands in.
const PENDING = pendingFragment(ARCH, 'retro-generic.md')
const FRAGMENT = PENDING ?? docText(ARCH)
const CITE = 'Docs cite code by symbol, never by line number.'

test('stitching the retro-generic architecture fragment keeps the doc fragments section whole', () => {
  assert.ok(DOC.includes(CITE), 'the architecture doc holds the citation paragraph')
  const text = PENDING === undefined ? DOC : stitchDoc(DOC, [{ name: 'retro-generic.md', text: PENDING }]).text
  assert.ok(text.includes(CITE), 'the stitched doc still holds the citation paragraph')
})

// Only a pending fragment can hold a section outside its goal; the stitched doc rightly has a "Doc fragments" section.
test('the retro-generic architecture fragment holds no section outside the retro goal', { skip: PENDING === undefined && 'fragment already stitched into the doc' }, () => {
  assert.doesNotMatch(FRAGMENT, /^#+ Doc fragments/m)
})

test('the retro-generic architecture fragment does not call SKILL.md step 4 stale while the skill already uses problems.json', () => {
  const skill = read('skills', 'retro', 'SKILL.md')
  const step4 = skill.split('\n').find((l) => l.startsWith('4. **`triage`.**')) ?? ''
  assert.match(step4, /problems\.json/, 'SKILL.md step 4 hands triage retro/problems.json')
  assert.doesNotMatch(FRAGMENT, /step 4, still hands triage/)
  assert.doesNotMatch(FRAGMENT, /outside goal `retro-generic`'s owns/)
})

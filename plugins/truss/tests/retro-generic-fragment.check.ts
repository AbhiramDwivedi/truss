// Regression cases for the retro-generic architecture fragment (QC findings on d4ae569).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { stitchDoc } from '../bin/fragments.ts'

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p: string[]) => readFileSync(path.join(PLUGIN, ...p), 'utf8')
const DOC = read('docs', 'architecture.md')
const FRAGMENT = read('docs', 'architecture.d', 'retro-generic.md')
const CITE = 'Docs cite code by symbol, never by line number.'

test('stitching the retro-generic architecture fragment keeps the doc fragments section whole', () => {
  assert.ok(DOC.includes(CITE), 'the architecture doc holds the citation paragraph')
  const { text } = stitchDoc(DOC, [{ name: 'retro-generic.md', text: FRAGMENT }])
  assert.ok(text.includes(CITE), 'the stitched doc still holds the citation paragraph')
})

test('the retro-generic architecture fragment holds no section outside the retro goal', () => {
  assert.doesNotMatch(FRAGMENT, /^#+ Doc fragments/m)
})

test('the retro-generic architecture fragment does not call SKILL.md step 4 stale while the skill already uses problems.json', () => {
  const skill = read('skills', 'retro', 'SKILL.md')
  const step4 = skill.split('\n').find((l) => l.startsWith('4. **`triage`.**')) ?? ''
  assert.match(step4, /problems\.json/, 'SKILL.md step 4 hands triage retro/problems.json')
  assert.doesNotMatch(FRAGMENT, /step 4, still hands triage/)
  assert.doesNotMatch(FRAGMENT, /outside goal `retro-generic`'s owns/)
})

// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss 0.24.0, ADR-0036: diff hygiene (DIFF), the debugging rule (DEBUG), core rule 15 and the new QC step.
// The member and QC prompts are also checked at run time in tests/workflows.check.ts.
//
// Run with: node --test tests/diff-hygiene.check.ts

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => readFileSync(join(PLUGIN, ...p), 'utf8').replace(/\r\n/g, '\n')

export const DIFF = "Change only the lines your task needs. Match the file's existing style; don't reformat, rename or tidy lines the task doesn't change. Add no dependency that the standard library or the project's existing dependencies cover. A dependency the approved scope doesn't name goes back in your report as a proposal."
export const DEBUG = 'On a bug, reproduce it first with a test that fails, then fix the cause. A guard that hides an unexpected null, empty or error value is a fix only when your report says why the value occurs.'
export const QC_STEP = "Check that every hunk traces to the task: a hunk that only reformats, renames or reorders lines the task didn't change is a finding, unless the project's formatter or a hook produced it (compare `git diff <base>...<branch>` with `git diff -w`). Check each manifest addition against core rule 15. A bug fix that adds a null or empty guard, or a catch, without saying why the value occurs is a finding."

const stage = read('workflows', 'stage.js')
// a function's source: from its header line to the next top-level function
const fn = (name) => {
  const start = stage.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `function ${name} missing from stage.js`)
  const next = stage.indexOf('\nfunction ', start + 10)
  return stage.slice(start, next < 0 ? undefined : next)
}
// the text of a stage.js string constant, read from its double-quoted or single-quoted literal
const literal = (name) => {
  const m = stage.match(new RegExp(`^const ${name} = (["'])(.*)\\1$`, 'm'))
  assert.ok(m, `const ${name} missing from stage.js`)
  return m[2].replace(/\\'/g, "'")
}

test('stage.js: DIFF and DEBUG are held word for word', () => {
  assert.equal(literal('DIFF'), DIFF)
  assert.equal(literal('DEBUG'), DEBUG)
})
test('stage.js: memberPrompt carries DIFF for builder, tester and resolver, never the writer', () => {
  const body = fn('memberPrompt')
  assert.match(body, /DIFF/)
  assert.match(body, /writer/, 'memberPrompt names the writer exclusion')
})
test('stage.js: DEBUG is in the builder prompts and fixPrompt', () => {
  assert.match(fn('memberPrompt'), /DEBUG/)
  assert.match(fn('fixPrompt'), /debug/)
})
test('stage.js: DIFF and DEBUG are in no QC, stress, planning, judge or writer prompt function', () => {
  for (const name of ['qcPrompt']) {
    const body = fn(name)
    assert.doesNotMatch(body, /\bDIFF\b/, `${name} holds DIFF`)
    assert.doesNotMatch(body, /\bDEBUG\b/, `${name} holds DEBUG`)
  }
  const uses = stage.split('\n').filter((l) => /\b(DIFF|DEBUG)\b/.test(l) && !/^const (DIFF|DEBUG) =/.test(l))
  assert.ok(uses.length <= 4, `DIFF/DEBUG used in more places than the member prompt: ${uses.join(' | ')}`)
})
test('stage.js: qcPrompt holds the new QC step word for word, right after the reuse step', () => {
  const body = fn('qcPrompt')
  const i = body.indexOf(QC_STEP)
  assert.ok(i >= 0, 'QC step missing from qcPrompt')
  assert.ok(body.indexOf('Check that new code reuses what exists') < i, 'after the reuse step')
  assert.ok(i < body.indexOf("Check the goal file's Non-goals"), 'before the Non-goals step')
})

test('project-manager.md holds both sentences word for word', () => {
  const t = read('agents', 'project-manager.md')
  assert.ok(t.includes(DIFF), 'DIFF')
  assert.ok(t.includes(DEBUG), 'DEBUG')
})
test('drift is reverted and dropped, never proposed', () => {
  const t = read('agents', 'project-manager.md')
  const run = read('skills', 'run', 'SKILL.md')
  const qc = read('agents', 'qc-engineer.md')
  assert.ok(t.includes('is reverted and dropped, never reported as a proposal'), 'project manager drop-drift rule')
  assert.ok(t.includes('A meaningful change is never dropped'), 'project manager surface rule')
  assert.ok(!t.includes('or goes to main as a `PROPOSAL:`'), 'QC findings line')
  assert.ok(!t.includes('You send it to main as a `PROPOSAL:` or drop it'), 'member rule')
  assert.ok(stage.includes('never goes into the diff and is never reported as a proposal'), 'stage.js drop-drift rule')
  assert.ok(stage.includes('is never left out: surface it in your report'), 'stage.js surface rule')
  assert.ok(!stage.includes('An idea beyond it goes back in your report'), 'stage.js old line')
  assert.ok(t.includes('A meaningful change beyond approved scope, never drift'), 'project manager proposal wording')
  assert.ok(run.includes('A meaningful change beyond approved scope, never drift'), 'run skill proposal wording')
  const stale = 'Name every architecture section, ADR, feature-map entry or rule file this change makes stale'
  assert.ok(stage.includes(stale) && qc.includes(stale), 'stale-design sentence in knowledgePrompt and QC')
  for (const [n, s] of [['project manager', t], ['run', run], ['stage', stage], ['adr', read('docs', 'adr', '0036-diff-hygiene-and-dependencies.md')]]) {
    assert.ok(!/good idea[^.\n]*(lost|dropped)/i.test(s), `${n}: no line says a good idea is dropped`)
  }
})
test('QC steps 7 and 11: QC never edits; knowledge-commit description edits to the architecture doc are allowed; the knowledge prompt agrees', () => {
  const qc = read('agents', 'qc-engineer.md')
  const s7 = qc.slice(qc.indexOf('\n7. '), qc.indexOf('\n8. '))
  for (const s of ['`docs(knowledge):` commit', 'only correct descriptions', "existing ADR's Decision or Status", "architecture doc's principles", 'The crew owns the docs of its change', 'a design crew']) assert.ok(s7.includes(s), `step 7: ${s}`)
  assert.ok(!s7.includes('Crews never edit them'), 'step 7 old rule')
  const s11 = qc.slice(qc.indexOf('\n11. '), qc.indexOf('\n12. '))
  assert.ok(s11.includes('Non-goals'), 'Non-goals sentence kept')
  assert.ok(s11.includes('QC never edits.') && s11.includes('is a finding for rework') && s11.includes('design `PROPOSAL:`; if it does not, that is a finding'), 'step 11 new text')
  assert.ok(!s11.includes('update the text when it is a description'), 'step 11 old text')
  assert.ok(stage.includes('update the descriptive text in the architecture doc and the feature map') && stage.includes('never edit an existing ADR'), 'knowledge prompt')
  assert.ok(!stage.includes('update the text when it is a description'), 'stage.js old text')
})
test('qc-engineer.md holds the new QC step word for word, as a numbered step after the reuse step', () => {
  const t = read('agents', 'qc-engineer.md')
  assert.ok(t.includes(`10. ${QC_STEP}`), 'step 10 text')
  assert.ok(t.indexOf('9. Check that new code reuses') < t.indexOf(QC_STEP))
  assert.ok(t.indexOf(QC_STEP) < t.indexOf('Check the goal file'))
  assert.match(t, /\n12\. Answer the five rubric questions/)
})

test('core.md has 15 numbered rules and rule 15 names a dependency', () => {
  const t = read('skills', 'principles', 'core.md')
  const nums = [...t.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]))
  assert.deepEqual(nums, Array.from({ length: 15 }, (_, i) => i + 1))
  const r15 = t.slice(t.indexOf('\n15. '))
  assert.match(r15, /dependenc/)
  assert.match(r15, /Test: /)
  assert.match(t, /\n13\. A behavior change or bug fix ships with a test/)
})
test('design-engineer.md: persona Standards name the stack built-ins that replace packages', () => {
  const t = read('agents', 'design-engineer.md')
  for (const s of ['crypto.randomUUID', 'structuredClone', 'pathlib', 'urllib.request', 'log/slog']) assert.ok(t.includes(s), s)
})
test('architecture.md: core pack all 15 rules adopted', () => {
  const t = read('docs', 'architecture.md')
  assert.ok(t.includes('Core pack: all 15 rules adopted'))
  assert.ok(!t.includes('Core pack: all 14 rules adopted'))
})
test('ADR-0036 records adopted, declined and the long-term costs', () => {
  const t = read('docs', 'adr', '0036-diff-hygiene-and-dependencies.md')
  for (const s of ['Declined', 'Consequences', '15-rule cap', 'formatter']) assert.ok(t.includes(s), s)
})

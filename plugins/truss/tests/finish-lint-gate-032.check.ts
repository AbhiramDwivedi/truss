// @ts-nocheck
// 0.32.0 hotfix (bug F): the merge gate reads the knowledge lint. `finish` does not merge a passed Workflow result whose
// `knowledgeLint.failures` holds a failure that is new (not `new: false`); it lists the crew under `rework` with
// `why: "knowledge-lint"` and the failures, for `start --resume merge-ready`, whose QC loop re-lints and sends the knowledge
// writer the failing lines (stage.js `lintClean`). Predating failures, warnings, `ran: false` and no field merge as before.
// `land` lints the direct crew's worktree itself and refuses while that lint has a new failure.

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { assertOneLine, crewWorld, git, mkWorld, say } from './fixtures/ltc/harness.ts'
import { putFile } from './fixtures/workflow-run/harness.ts'

const STALE = { check: 'stale', path: '.claude/rules/plugin-tests.md', message: 'bin/a.ts changed in this diff but `verified` did not', new: true }
const OLD = { check: 'over-budget', path: '.claude/rules/plugin-tests.md', message: '55 lines, budget 40', new: false }

/** A full crew ready to merge, its saved result carrying `lint` as knowledgeLint (undefined: no field). */
function fullCrew(lint) {
  const w = mkWorld()
  const cw = crewWorld(w, { process: 'full' })
  writeFileSync(`${w.dir}/result.json`, JSON.stringify([{ slug: cw.slug, state: 'passed', head: cw.head, base: cw.base, qc: `${cw.slug}-qc`, ...(lint === undefined ? {} : { knowledgeLint: lint }) }]))
  return cw
}

test('finish-lint-gate-032: a passed result with a new knowledge-lint failure is not merged; it is rework knowledge-lint with the failures', () => {
  const cw = fullCrew({ ran: true, failures: [STALE], predating: [OLD], predatingCount: 1 })
  const r = cw.finish()
  const j = assertOneLine(r)
  assert.equal(r.status, 1, say(r))
  assert.deepEqual(j.merged, [], say(r))
  assert.equal(cw.merged(), false, 'the target must not hold the crew head')
  const rw = j.rework.find((x) => x.slug === cw.slug)
  assert.ok(rw !== undefined, say(r))
  assert.equal(rw.why, 'knowledge-lint')
  assert.deepEqual(rw.failures, [STALE])
})

test('finish-lint-gate-032: a failure with no new field counts as new, as stage.js counts it', () => {
  const { new: _n, ...bare } = STALE
  const cw = fullCrew({ ran: true, failures: [bare] })
  const r = cw.finish()
  const j = assertOneLine(r)
  assert.equal(cw.merged(), false, say(r))
  assert.equal(j.rework.find((x) => x.slug === cw.slug)?.why, 'knowledge-lint', say(r))
})

test('finish-lint-gate-032: predating failures and warnings never block the merge', () => {
  const cw = fullCrew({ ran: true, failures: [OLD], predating: [OLD], warnings: [{ check: 'over-budget', path: 'docs/features.md', message: 'entry long', new: true }], predatingCount: 1, warningCount: 1 })
  const r = cw.finish()
  const j = assertOneLine(r)
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(j.merged, [cw.slug])
  assert.ok(cw.merged())
})

test('finish-lint-gate-032: ran false, or no knowledgeLint field, merges as before', () => {
  for (const lint of [{ ran: false, failures: [STALE] }, undefined]) {
    const cw = fullCrew(lint)
    const r = cw.finish()
    const j = assertOneLine(r)
    assert.equal(r.status, 0, say(r))
    assert.deepEqual(j.merged, [cw.slug], JSON.stringify(lint))
  }
})

const longRule = Array.from({ length: 50 }, (_, i) => `- rule line ${i + 1}`).join('\n') + '\n'

test('finish-lint-gate-032: land refuses a direct crew whose knowledge lint has a new failure; once fixed it lands', () => {
  const w = mkWorld()
  const cw = crewWorld(w, { process: 'lean', files: { '.claude/rules/area.md': longRule } })
  const r = cw.land()
  const j = assertOneLine(r)
  assert.equal(r.status, 1, say(r))
  assert.equal(j.merged, false)
  assert.match(String(j.why), /^knowledge-lint: 1 new failure: \[over-budget\] \.claude\/rules\/area\.md: /, say(r))
  assert.equal(j.failures?.[0]?.check, 'over-budget', say(r))
  assert.equal(cw.merged(), false)
  const fixed = putFile(cw.wt, '.claude/rules/area.md', '- one rule\n', 'fold the rule file under budget')
  const again = cw.land()
  assert.equal(again.status, 0, say(again))
  assert.equal(assertOneLine(again).merged, true)
  assert.equal(git(w.repo, ['rev-parse', 'refs/heads/main']), fixed)
})

test('finish-lint-gate-032: land does not block on a failure that predates the crew', () => {
  const w = mkWorld({}, { '.claude/rules/area.md': longRule })
  const cw = crewWorld(w, { process: 'lean' })
  const r = cw.land()
  assert.equal(r.status, 0, say(r))
  assert.equal(assertOneLine(r).merged, true)
})

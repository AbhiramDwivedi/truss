// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0012 (R-23, R-26, R-29, R-30, R-32): the run skill's doctor step, automatic retro and fix goal.
// Written before skills/run/SKILL.md and agents/design-engineer.md change.
//
// Run with: node --test tests/run-retro.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs. Every read returns ''
// for a missing path, so each test fails on its own assertion. Every failure says "producer missing: skills/run".
//
// The triage sentence below is copied unchanged into tests/retro-skill.check.ts (ADR-0012 Decision 6).
// It is not a shared import: importing a check file would run its tests too.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...parts: string[]): string => {
  try {
    return readFileSync(join(PLUGIN, ...parts), 'utf8').replace(/\r/g, '')
  } catch {
    return ''
  }
}
const RUN = read('skills', 'run', 'SKILL.md')
const DESIGN = read('agents', 'design-engineer.md')

const flatten = (s: string): string => s.replace(/\s+/g, ' ')
const section = (doc: string, heading: string): string => {
  const i = doc.indexOf(heading)
  if (i < 0) return ''
  const rest = doc.slice(i + heading.length)
  const j = rest.search(/\n## /)
  return j < 0 ? doc.slice(i) : doc.slice(i, i + heading.length + j)
}
const has = (text: string, needle: string, label: string) =>
  assert.ok(flatten(text).includes(flatten(needle)), `producer missing: skills/run ${label} does not carry ${JSON.stringify(needle)}`)
const matches = (text: string, re: RegExp, label: string) =>
  assert.ok(re.test(flatten(text)), `producer missing: skills/run ${label} does not match ${re}`)

const S5 = '## 5. Show the plan, approve it, freeze the scope'
const S10 = '## 10. Report to the client'

const DOCTOR_STEP =
  'After `plan-check` passes and before any crew starts, run `node <plugin>/bin/factory.ts doctor --dir <truss dir> --repo <repo>`, show the client its bundle with the plan as one approval (allow rules for the committed `.claude/settings.json`, downloads and standing rulings), and log each bundle item as a decision.'
const FIX_APPROVAL =
  'A fix goal is `"auto"` unless a run-skill section-4 client trigger applies, and a `.claude/settings.json` edit counts as one; then it is `"client"`.'
const TRIAGE =
  'A retro triage sorts each finding into fix now, defer or drop, one line each as `TRIAGE: <finding id> | <fix now|defer|drop> | <reason>`, and drops a finding the catalog already holds, naming the catalog id as the reason.'

test('skills/run exists', () => {
  assert.ok(RUN !== '', 'producer missing: skills/run/SKILL.md')
})

test('section 5 runs factory.ts doctor after plan-check and shows the bundle as one approval (R-26)', () => {
  const s = section(RUN, S5)
  assert.ok(s !== '', `producer missing: skills/run has no ${JSON.stringify(S5)}`)
  has(s, DOCTOR_STEP, 'section 5')
})

test('section 5 puts the doctor step after the plan-check step and before the crews start', () => {
  const s = flatten(section(RUN, S5))
  const d = s.indexOf(flatten(DOCTOR_STEP))
  const p = s.indexOf('plan-check')
  assert.ok(d >= 0 && p >= 0 && p <= d, 'producer missing: skills/run section 5 does not run doctor after plan-check')
})

test('section 5 makes a non-empty bundle wait for the client even in an auto-approved run', () => {
  matches(section(RUN, S5), /auto-approved run[^.]*bundle[^.]*(waits|wait) for the client|bundle[^.]*auto-approved[^.]*client/i, 'section 5')
})

test('section 5 has the design engineer list each crew\'s `needs`, and agents/design-engineer.md plan mode lists them', () => {
  const plan = section(DESIGN, '## plan mode')
  assert.ok(plan !== '', 'producer missing: skills/run agents/design-engineer.md has no "## plan mode"')
  matches(plan, /`needs`[^.]*probe|probe[^.]*`needs`/, 'agents/design-engineer.md plan mode')
  matches(plan, /(each|every) crew[^.]*`needs`|`needs`[^.]*(each|every) crew/, 'agents/design-engineer.md plan mode')
})

test('section 10 starts the retro on its own after the end-of-run sweep (R-23)', () => {
  const s = section(RUN, S10)
  assert.ok(s !== '', `producer missing: skills/run has no ${JSON.stringify(S10)}`)
  matches(s, /starts the retro without waiting for the client to ask/, 'section 10')
  has(s, 'skills/retro/SKILL.md', 'section 10')
  const flat = flatten(s)
  const sweep = flat.indexOf('End-of-run sweep.')
  const retro = flat.search(/starts the retro without waiting/)
  assert.ok(sweep >= 0 && retro > sweep, 'producer missing: skills/run section 10 starts the retro before or without the sweep')
})

test('section 10 adds the fix-now findings as a goal through amend (ADR-0010), with QC (R-29)', () => {
  const s = section(RUN, S10)
  matches(s, /fix-now findings[^.]*goal[^.]*amend[^.]*\(ADR-0010\)|amend[^.]*\(ADR-0010\)[^.]*fix-now findings/, 'section 10')
  matches(s, /QC engineer[^.]*(before|then)[^.]*merge|fix[^.]*fails? QC[^.]*(not merged|not applied)/i, 'section 10')
})

test('the fix goal approval sentence is pinned', () => {
  has(RUN, FIX_APPROVAL, 'the fix goal approval')
})

test('the shared triage sentence is pinned in the run skill (R-29)', () => {
  has(section(RUN, S10), TRIAGE, 'section 10')
})

test('the scope rule (R-30): out of scope findings are dropped, run-delivered code is never touched', () => {
  const s = section(RUN, S10)
  has(s, 'out of scope (R-30)', 'section 10')
  matches(s, /never (changes? |edits? )?(code|a file) (that )?a (truss )?run delivered|code (that )?a (truss )?run delivered/, 'section 10')
})

test('on another project a plugin fix is a draft in retro/upstream, reported to the client', () => {
  has(section(RUN, S10), '`<truss dir>/retro/upstream/<finding id>.md`', 'section 10')
})

test('scrub before commit (R-32): retro/cli.ts scrub runs on each changed file before each merge', () => {
  matches(RUN, /retro\/cli\.ts scrub[^.]*(before|every)[^.]*merge|before (each|every) merge[^.]*retro\/cli\.ts scrub/i, 'the merge step')
})

test('section 10 lets a retro fix goal on the truss repo write agents and skills, and settings.json is written by truss', () => {
  const s = section(RUN, S10)
  matches(s, /(truss never writes agents or skills)[^.]*(retro fix goal|except)|retro fix goal[^.]*(truss repo)[^.]*does/i, 'section 10')
})

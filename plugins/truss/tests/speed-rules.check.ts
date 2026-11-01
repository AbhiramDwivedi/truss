// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss speed-rules goal: six prose rules, pinned before the prompts change.
// Each test needs the new rule's key phrase present AND the superseded sentence gone.
//
// Run with: node --test tests/speed-rules.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs. Every read returns ''
// for a missing path, so each test fails on its own assertion.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
// markdown noise (backticks, bold) dropped and whitespace collapsed, so line wraps and formatting don't matter
const read = (...parts: string[]): string => {
  try {
    return readFileSync(join(PLUGIN, ...parts), 'utf8').replace(/[`*]/g, '').replace(/\s+/g, ' ')
  } catch {
    return ''
  }
}
const FOREMAN = read('agents', 'foreman.md')
const QC = read('agents', 'qc-engineer.md')
const STRESS = read('agents', 'stress-engineer.md')
const ARCH =read('agents', 'design-engineer.md')
const RUN = read('skills', 'run', 'SKILL.md')

const has = (text: string, re: RegExp, what: string) => assert.match(text, re, `missing: ${what}`)
const gone = (text: string, re: RegExp, what: string) => assert.doesNotMatch(text, re, `superseded text still there: ${what}`)

describe('speed-rules', () => {
  test('1 stress test: one round, DEFECT/GAP, mkdtemp clone, high-impact crews only', () => {
    assert.ok(STRESS !== '', 'producer missing: agents/stress-engineer.md')
    has(FOREMAN, /(one|1|a single) stress[- ]test round/i, 'foreman: one stress test round')
    has(FOREMAN, /at most (once|one more|a single|1)|only once|at most one (re-?run|more)/i, 'foreman: rerun at most once')
    has(FOREMAN, /real[- ]defect|\bDEFECT\b/i, 'foreman: rerun only after a real-defect fix')
    has(STRESS, /\bDEFECT\b/, 'stress: DEFECT label')
    has(STRESS, /\bGAP\b/, 'stress: GAP label')
    has(STRESS, /end-of-run/i, 'stress: GAPs go to the end-of-run list')
    has(STRESS, /mkdtemp/i, 'stress: probes in a mkdtemp clone')
    has(STRESS, /GIT_\w*/, 'stress: GIT_* variables')
    has(STRESS, /unset/i, 'stress: GIT_* unset')
    has(RUN + FOREMAN, /stress test[^.]{0,120}(high-impact|hooks, gates, merge)|(high-impact|hooks, gates, merge)[^.]{0,120}stress test/i, 'stress test only for high-impact crews')
    gone(FOREMAN, /After the fixes, run a fresh stress test/i, 'foreman: "After the fixes, run a fresh stress test"')
    gone(FOREMAN, /Have every break it reports fixed/i, 'foreman: "Have every break it reports fixed"')
  })

  test('2 start without batch holds: whole current stage at once, next stage in the same turn, hook note kept', () => {
    has(RUN, /(start )?every crew in the current stage/i, 'run: start every crew in the current stage')
    has(RUN, /maxParallelCrews/, 'run: cap kept')
    has(RUN, /no (batch )?hold (inside|within) a stage|(inside|within) a stage[^.]{0,60}no (batch )?hold/i, 'run: no batch hold inside a stage')
    has(RUN, /same turn/i, 'run: next stage starts in the same turn')
    has(RUN, /last crew[^.]{0,80}merge|merges?[^.]{0,80}last crew/i, 'run: the moment the stage last crew merges')
    has(RUN, /(every|each|end of) turn[^.]{0,160}start(ing)? (any|every|each) crews? (the )?hooks? allow|start(ing)? (any|every|each) crews? (the )?hooks? allow[^.]{0,120}(every|each) turn/i, 'run: ends every turn by starting any crew the hooks allow')
    has(RUN, /When a hook refuses to start a foreman/i, 'run: hook-refusal section kept')
    has(RUN, /stage <n> isn.t merged yet/i, 'run: hook bullet for an unmerged earlier stage kept')
    // The old line "A stage starts only when every crew in every earlier stage is merged or dropped" restates the hook and stays true; not pinned.
    gone(RUN, /When the whole stage has merged, start the next stage/i, 'run: "When the whole stage has merged, start the next stage"')
  })

  test('3 PM never blocks: no AskUserQuestion while a crew runs; foreman proceeds on its recommendation', () => {
    has(RUN, /(never|not|no|don.t)[^.]{0,80}AskUserQuestion[^.]{0,120}(crew|crews)[^.]{0,40}(runs?|running)|AskUserQuestion[^.]{0,80}(while|when)[^.]{0,40}(any )?crews? (is |are )?(running|runs)/i, 'run: no AskUserQuestion while any crew runs')
    has(RUN, /plain text/i, 'run: ask in plain text')
    has(RUN, /notifications?/i, 'run: keep handling notifications')
    has(FOREMAN, /recommended option/i, 'foreman: proceeds on recommended option')
    has(FOREMAN, /different file sets/i, 'foreman: stops only when options lead to different file sets')
    has(FOREMAN, /record(s|ed)?[^.]{0,60}(in|on) (your|its) (final )?report/i, 'foreman: records the choice in its report')
    gone(FOREMAN, /Then wait; the answer arrives as a message/i, 'foreman: "Then wait; the answer arrives as a message"')
  })

  test('4 design crews: ADR word allowance, seams in goal files, one FAIL round', () => {
    has(ARCH, /3,?000 words/i, 'designer: 3,000-word allowance per ADR')
    has(ARCH, /seams[^.]{0,120}(build crews?.{0,3}|crews?.{0,3}) goal files?|goal files?[^.]{0,120}seams/i, 'designer: seams go in the build crews goal files')
    has(FOREMAN, /design crew[^.]{0,200}(one|1) FAIL round|(one|1) FAIL round[^.]{0,200}design crew/i, 'foreman: design crew gets one FAIL round')
    has(FOREMAN, /(only|just) bug findings|bug findings[^.]{0,80}(only|fixed)/i, 'foreman: after it only bug findings are fixed')
    has(FOREMAN, /same writer/i, 'foreman: fixed by the same writer')
    has(FOREMAN, /deferred?/i, 'foreman: the rest are deferred')
    gone(ARCH, /The seams the crew.s test-writer must pin with contract tests/i, 'designer: seams the test-writer must pin, as an ADR/design output')
  })

  test('5 planning one round: empty-implementation self-check, parallel checker review', () => {
    has(ARCH, /empty implementation/i, 'designer: checks every acceptance test against an empty implementation')
    has(RUN, /checker[^.]{0,200}in parallel[^.]{0,120}(approval|plan)|in parallel with[^.]{0,80}(plan )?approval/i, 'run: checker review in parallel with plan approval')
    has(RUN, /not a gate|isn.t a gate|no gate|never a gate|doesn.t gate|does not gate/i, 'run: the checker review is not a gate')
    has(RUN, /gameable/i, 'run: send back only for a gameable acceptance test')
    gone(RUN, /the designer gets one round to reconcile/i, 'run: "the designer gets one round to reconcile" after a checker disagree')
    gone(RUN, /the reconcile round has happened/i, 'run: "the reconcile round has happened"')
  })

  test('6 flatten small crews: at most 2 members and no stress test runs without a foreman', () => {
    has(RUN, /at most (2|two) members|(2|two) members or (fewer|less)/i, 'run: crew of at most 2 members')
    has(RUN, /no foreman|without a foreman/i, 'run: no foreman')
    has(RUN, /PM[^.]{0,120}(directly|itself)[^.]{0,200}(test-writer|builder|qc)|(directly|itself)[^.]{0,200}test-writer[^.]{0,80}builder[^.]{0,80}qc/i, 'run: PM runs test-writer, builder, qc directly')
    has(RUN, /no stress test/i, 'run: only crews with no stress test')
    has(RUN, /Head\/Patch|patch id|merge gate/i, 'run: Head/Patch rules and merge gate kept')
  })

  test('7 shell rule: every worktree member brief steers Bash past the worktree guard', () => {
    has(FOREMAN, /the shell rule, for every member with a worktree: Claude Code.s worktree guard refuses/i, 'foreman: the shell rule names the guard as Claude Code\'s')
    has(FOREMAN, /writes files with Write and Edit, never a shell heredoc/i, 'foreman: Write and Edit, not heredocs')
    has(FOREMAN, /one plain command per Bash call, with no &&, ;, cd, for-loop or \$VAR argument/i, 'foreman: one plain command per call')
    has(FOREMAN, /never cds into the main checkout/i, 'foreman: never cd into the main checkout')
  })
})

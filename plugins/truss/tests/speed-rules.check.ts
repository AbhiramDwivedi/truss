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
const PROJECT_MANAGER = read('agents', 'project-manager.md')
const QC = read('agents', 'qc-engineer.md')
const STRESS = read('agents', 'stress-engineer.md')
const ARCH =read('agents', 'design-engineer.md')
const RUN = read('skills', 'run', 'SKILL.md')

const has = (text: string, re: RegExp, what: string) => assert.match(text, re, `missing: ${what}`)
const gone = (text: string, re: RegExp, what: string) => assert.doesNotMatch(text, re, `superseded text still there: ${what}`)

describe('speed-rules', () => {
  test('1 stress test: one round, DEFECT/GAP, mkdtemp clone, high-impact crews only', () => {
    assert.ok(STRESS !== '', 'producer missing: agents/stress-engineer.md')
    has(PROJECT_MANAGER, /(one|1|a single) stress[- ]test round/i, 'project manager: one stress test round')
    has(PROJECT_MANAGER, /at most (once|one more|a single|1)|only once|at most one (re-?run|more)/i, 'project manager: rerun at most once')
    has(PROJECT_MANAGER, /real[- ]defect|\bDEFECT\b/i, 'project manager: rerun only after a real-defect fix')
    has(STRESS, /\bDEFECT\b/, 'stress: DEFECT label')
    has(STRESS, /\bGAP\b/, 'stress: GAP label')
    has(STRESS, /end-of-run/i, 'stress: GAPs go to the end-of-run list')
    has(STRESS, /mkdtemp/i, 'stress: probes in a mkdtemp clone')
    has(STRESS, /GIT_\w*/, 'stress: GIT_* variables')
    has(STRESS, /unset/i, 'stress: GIT_* unset')
    has(RUN + PROJECT_MANAGER, /stress test[^.]{0,120}(high-impact|hooks, gates, merge)|(high-impact|hooks, gates, merge)[^.]{0,120}stress test/i, 'stress test only for high-impact crews')
    gone(PROJECT_MANAGER, /After the fixes, run a fresh stress test/i, 'project manager: "After the fixes, run a fresh stress test"')
    gone(PROJECT_MANAGER, /Have every break it reports fixed/i, 'project manager: "Have every break it reports fixed"')
  })

  test('2 start without batch holds: whole current stage at once, next stage in the same turn, hook note kept', () => {
    has(RUN, /(start )?every crew in the current stage/i, 'run: start every crew in the current stage')
    has(RUN, /maxParallelCrews/, 'run: cap kept')
    has(RUN, /no (batch )?hold (inside|within) a stage|(inside|within) a stage[^.]{0,60}no (batch )?hold/i, 'run: no batch hold inside a stage')
    has(RUN, /same turn/i, 'run: next stage starts in the same turn')
    has(RUN, /last crew[^.]{0,80}merge|merges?[^.]{0,80}last crew/i, 'run: the moment the stage last crew merges')
    has(RUN, /(every|each|end of) turn[^.]{0,160}start(ing)? (any|every|each) crews? (the )?hooks? allow|start(ing)? (any|every|each) crews? (the )?hooks? allow[^.]{0,120}(every|each) turn/i, 'run: ends every turn by starting any crew the hooks allow')
    has(RUN, /When a hook refuses to start a project manager/i, 'run: hook-refusal section kept')
    has(RUN, /stage <n> isn.t merged yet/i, 'run: hook bullet for an unmerged earlier stage kept')
    // The old line "A stage starts only when every crew in every earlier stage is merged or dropped" restates the hook and stays true; not pinned.
    gone(RUN, /When the whole stage has merged, start the next stage/i, 'run: "When the whole stage has merged, start the next stage"')
  })

  test('3 PM never blocks: no AskUserQuestion while a crew runs; project manager proceeds on its recommendation', () => {
    has(RUN, /(never|not|no|don.t)[^.]{0,80}AskUserQuestion[^.]{0,120}(crew|crews)[^.]{0,40}(runs?|running)|AskUserQuestion[^.]{0,80}(while|when)[^.]{0,40}(any )?crews? (is |are )?(running|runs)/i, 'run: no AskUserQuestion while any crew runs')
    has(RUN, /plain text/i, 'run: ask in plain text')
    has(RUN, /notifications?/i, 'run: keep handling notifications')
    has(PROJECT_MANAGER, /recommended option/i, 'project manager: proceeds on recommended option')
    has(PROJECT_MANAGER, /different file sets/i, 'project manager: stops only when options lead to different file sets')
    has(PROJECT_MANAGER, /record(s|ed)?[^.]{0,60}(in|on) (your|its) (final )?report/i, 'project manager: records the choice in its report')
    gone(PROJECT_MANAGER, /Then wait; the answer arrives as a message/i, 'project manager: "Then wait; the answer arrives as a message"')
  })

  test('4 design crews: ADR word allowance, seams in goal files, one FAIL round', () => {
    has(ARCH, /3,?000 words/i, 'designer: 3,000-word allowance per ADR')
    has(ARCH, /seams[^.]{0,120}(build crews?.{0,3}|crews?.{0,3}) goal files?|goal files?[^.]{0,120}seams/i, 'designer: seams go in the build crews goal files')
    has(PROJECT_MANAGER, /design crew[^.]{0,200}(one|1) FAIL round|(one|1) FAIL round[^.]{0,200}design crew/i, 'project manager: design crew gets one FAIL round')
    has(PROJECT_MANAGER, /(only|just) bug findings|bug findings[^.]{0,80}(only|fixed)/i, 'project manager: after it only bug findings are fixed')
    has(PROJECT_MANAGER, /same writer/i, 'project manager: fixed by the same writer')
    has(PROJECT_MANAGER, /deferred?/i, 'project manager: the rest are deferred')
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

  test('6 flatten small crews: direct crews of one or two members run without a project manager', () => {
    has(RUN, /one or two members/i, 'run: one or two members')
    has(RUN, /no project manager/i, 'run: no project manager')
    has(RUN, /run each direct crew yourself[^.]{0,200}project manager.s rules for members/i, 'run: PM runs each direct crew itself')
    has(RUN, /\blean\b[^]{0,300}\bqc\b[^]{0,100}\bred\b/i, 'run: lean crew qc and red flags')
    has(RUN, /factory\.ts land/, 'run: factory.ts land')
    has(RUN, /Head\/Patch|patch id|merge gate/i, 'run: Head/Patch rules and merge gate kept')
  })

  test('7 shell rule: every worktree member brief steers Bash past the worktree guard', () => {
    has(PROJECT_MANAGER, /the shell rule, for every member with a worktree: Claude Code.s worktree guard refuses/i, 'project manager: the shell rule names the guard as Claude Code\'s')
    has(PROJECT_MANAGER, /writes files with Write and Edit, never a shell heredoc/i, 'project manager: Write and Edit, not heredocs')
    has(PROJECT_MANAGER, /one plain command per Bash call, with no &&, ;, cd, for-loop or \$VAR argument/i, 'project manager: one plain command per call')
    has(PROJECT_MANAGER, /never cds into the main checkout/i, 'project manager: never cd into the main checkout')
  })
})

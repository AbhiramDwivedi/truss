// truss 0.32.0 crew deferred-fixes, rework round 2 (PM ruling 01:52, item 2): the run skill's prompt callers of `settings` and
// `gated-merge` pass the truss dir, so a run whose plan.json carries a top-level `target` (ADR-0053) merges onto that target on the
// project manager path too, not onto the .claude/truss.json target. The code side threads the dir through `settingsFor`; this pins the
// prompt side, which no code test reaches (truss-prompts Standard 1: a prompt change that changes behaviour lands with a prose test).
//
// Skills are outside the line-citation lint, so the lines are found by their own opening words, never by line number. The all-solo
// path ("4. Merge the task branch into the target") has no plan.json and so no plan target; it is left alone.
// Run with: node --test plugins/truss/tests/deferred-032-prose.check.ts

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { REAL_PLUGIN } from './fixtures/workflow-run/harness.ts'

const SKILL = readFileSync(`${REAL_PLUGIN}/skills/run/SKILL.md`, 'utf8').split('\n')

/** The one SKILL.md line that starts with `start` (leading spaces ignored). */
function lineStarting(start: string): string {
  const hits = SKILL.filter((l) => l.trimStart().startsWith(start))
  assert.equal(hits.length, 1, `one line of skills/run/SKILL.md starts with ${JSON.stringify(start)}; found ${hits.length}`)
  return hits[0] as string
}

/** Every inline-code command in `line` that runs `factory.ts <cmd>`. */
const commands = (line: string, cmd: string): string[] => [...line.matchAll(/`([^`]*)`/g)].map((m) => m[1] as string).filter((c) => new RegExp(`factory\\.ts ${cmd}\\b`).test(c))

test('deferred-032 prose: the PM-path gated-merge and the plan-table settings command pass --dir, and settings says plan.json sets the target', () => {
  // the sequential merge on the project manager path, section 9 step 3
  const merge = lineStarting('3. Fast-forward the target with')
  const gm = commands(merge, 'gated-merge')
  assert.equal(gm.length, 1, `the step names one gated-merge command: ${merge}`)
  assert.match(gm[0] as string, /--ff-only/, gm[0])
  assert.match(gm[0] as string, /(^|\s)--dir <truss dir>(\s|$)/, `the PM-path gated-merge passes the truss dir, so the plan target is the one it moves: ${gm[0]}`)

  // the plan table's merge mode and target, which the PM shows the client and logs
  const table = lineStarting('**Merge mode and target.**')
  const st = commands(table, 'settings')
  assert.ok(st.length >= 1, `the paragraph names the settings command: ${table}`)
  for (const c of st) assert.match(c, /(^|\s)--dir <truss dir>(\s|$)/, `the plan-table settings command passes the truss dir, so it shows the plan target: ${c}`)

  // the start-of-run settings step keeps saying where the target comes from
  const step = lineStarting('1. Run `node <plugin>/bin/factory.ts settings')
  const s1 = commands(step, 'settings')
  assert.equal(s1.length, 1, step)
  assert.match(s1[0] as string, /(^|\s)--dir <truss dir>(\s|$)/, s1[0])
  assert.match(step, /`plan\.json`/, 'the source list names plan.json')
  assert.ok(step.includes('An optional top-level `target` in `plan.json` overrides the config target for this run (ADR-0053).'), `the step says the plan.json target is used: ${step}`)
})

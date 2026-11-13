// @ts-nocheck
// truss 0.32.0 plan-hotspots (R-132, R-133): plan-check warns on a hotspot file, the design and checking engineer prompts carry the
// hotspot rule, the run skill carries the next-goal rule, and an R-132 rubric grader (fixtures/hotspots/grader.ts) is pinned on a
// recorded review and a doctored copy. Written from the goal file before any code.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { crew, mkTrussDir, planObj, REAL_FACTORY, REAL_PLUGIN, runCli, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'
import { gradeHotspotReview } from './fixtures/hotspots/grader.ts'

const read = (rel: string): string => readFileSync(`${REAL_PLUGIN}/${rel}`, 'utf8')
const FIX = new URL('./fixtures/hotspots/', import.meta.url)
const fixture = (name: string): string => readFileSync(new URL(name, FIX), 'utf8')
const HOTSPOT = 'src/router.ts'

function planCheck(crews: any[]) {
  const dir = mkTrussDir()
  writePlan(dir, planObj(crews, { version: 4 }))
  for (const c of crews) writeGoal(dir, c.slug)
  return runCli(REAL_FACTORY, 'plan-check', ['--dir', dir])
}

const warningsOf = (r: any): string[] => (Array.isArray(r.json?.warnings) ? r.json.warnings.map(String) : [])

test('plan-check warns on a file that more than half of a goal\'s crews own and names the file', () => {
  const r = planCheck([
    crew('alpha', { owns: [HOTSPOT, 'src/alpha/**'] }),
    crew('beta', { owns: [HOTSPOT, 'src/beta/**'] }),
    crew('gamma', { owns: [HOTSPOT, 'src/gamma/**'] }),
    crew('delta', { owns: ['src/delta/**'] }),
  ])
  assert.equal(r.status, 0, `a warning must not fail plan-check: ${r.stdout} ${r.stderr}`)
  assert.equal(r.json.ok, true, r.stdout)
  const w = warningsOf(r).filter((x) => x.includes(HOTSPOT))
  assert.ok(w.length >= 1, `a warning must name ${HOTSPOT}: ${r.stdout}`)
})

test('plan-check gives no hotspot warning when no file is owned by more than half of the crews', () => {
  const r = planCheck([
    crew('alpha', { owns: ['src/alpha.ts'] }),
    crew('beta', { owns: ['src/beta.ts'] }),
    crew('gamma', { owns: ['src/gamma.ts'] }),
    crew('delta', { owns: [HOTSPOT, 'src/delta.ts'] }),
  ])
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`)
  assert.equal(r.json.ok, true, r.stdout)
  assert.ok(Array.isArray(r.json.warnings), `plan-check must report a warnings array, empty when none: ${r.stdout}`)
  assert.deepEqual(warningsOf(r).filter((x) => /hotspot|owned by/i.test(x)), [], r.stdout)
})

const HOTSPOT_RULE = [
  /more than half of the (planned )?crews/i,
  /refactor goal first/i,
  /one (owning )?crew (that )?owns/i,
  /serial merges/i,
]
function assertHotspotRule(text: string, who: string) {
  for (const re of HOTSPOT_RULE) assert.match(text, re, `${who} lacks a sentence matching ${re}`)
  // the flag and the remedy must sit in the same paragraph, so the rule is one rule and not four stray mentions
  const para = text.split(/\n\s*\n/).find((p) => /more than half of the (planned )?crews/i.test(p)) ?? ''
  assert.match(para, /refactor goal first/i, `${who}: the half-of-crews flag and the refactor remedy are not together`)
  assert.match(para, /serial merges/i, `${who}: the paragraph must say the remedy replaces serial merges`)
}

test('the design engineer prompt tells it to flag a hotspot file and propose a refactor goal first or one owning crew', () => {
  assertHotspotRule(read('agents/design-engineer.md'), 'design-engineer.md')
})

test('the checking engineer prompt tells it to flag a hotspot file and propose a refactor goal first or one owning crew', () => {
  assertHotspotRule(read('agents/checking-engineer.md'), 'checking-engineer.md')
})

test('the hotspot rubric grader passes the recorded checking-engineer review that flags the hotspot file', () => {
  const res = gradeHotspotReview(fixture('recorded-review.md'), HOTSPOT)
  assert.equal(res.pass, true, `reasons: ${JSON.stringify(res.reasons)}`)
})

test('the hotspot rubric grader fails a doctored review that accepts serial merges', () => {
  const res = gradeHotspotReview(fixture('doctored-review.md'), HOTSPOT)
  assert.equal(res.pass, false, 'a review that accepts serial merges must fail')
  assert.ok(Array.isArray(res.reasons) && res.reasons.length > 0, 'a failing grade must say why')
  // the grader is not a constant: the same text without the doctoring would pass, so the fail is about serial merges
  assert.ok(res.reasons.some((x) => /serial|merge/i.test(String(x))), `reasons must name the serial merges: ${JSON.stringify(res.reasons)}`)
})

test('the run skill has the PM propose next goals from retro findings with evidence and a cost estimate and start none unasked', () => {
  const text = read('skills/run/SKILL.md')
  const para = text.split(/\n\s*\n/).find((p) => /next goals?/i.test(p) && /retro/i.test(p)) ?? ''
  assert.ok(para, 'no paragraph ties next goals to retro findings')
  assert.match(para, /propos\w+ (the )?next goals?/i)
  assert.match(para, /evidence/i, 'each proposal needs evidence')
  assert.match(para, /cost estimate/i, 'each proposal needs a cost estimate')
  assert.match(para, /(starts? none|never starts?|does not start|do not start)[^.]*(client'?s? (yes|approval)|unasked|asked)/i, 'the PM must start none without the client\'s yes')
})

// @ts-nocheck
// truss 0.32.0 plan-hotspots (R-132): the rubric grader fails a review made before the prompt change, whose first recommendation
// is to merge the hotspot's crews in turn and whose single owning crew is only a fallback.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { gradeHotspotReview } from './fixtures/hotspots/grader.ts'

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/hotspots/${name}`, import.meta.url), 'utf8')

test('the hotspot rubric grader fails the review made before the prompt change, whose first answer is to merge in turn', () => {
  const res = gradeHotspotReview(fixture('before-review.md'), 'src/router.ts')
  assert.equal(res.pass, false, 'a review whose first recommendation is merging in turn must fail')
  assert.ok(res.reasons.some((x) => /serial|merge/i.test(String(x))), `reasons must name serial merges: ${JSON.stringify(res.reasons)}`)
})

// R-132 rubric grader for a plan review that touches a hotspot file (one that more than half of the planned crews own).
// Deterministic, no model call. gradeHotspotReview(reviewText, hotspotPath) returns { pass, reasons }.
// It grades what the review recommends, not the prompt's exact words. It reads the review one sentence at a time and
// sorts each sentence into one of three kinds:
//   remedy: it proposes a refactor goal or a split of the file that runs first, or one crew that alone owns the file
//           while the others build on its merged result.
//   accept: it recommends keeping the crews merging their edits to the file one after another ("merge in turn",
//           "serial merges", "serial stages", "one after another"). A sentence that only quotes the plan ("the plan says it
//           accepts serial merges") or rejects the idea ("no need for", "no reason", "instead of") is neither kind.
//   other:  everything else.
// The first remedy or accept sentence is the review's primary recommendation. The grade is:
//   fail when the hotspot path is not named;
//   fail when the primary recommendation accepts serial merges, even if a remedy is offered later as a fallback;
//   fail when the review gives no remedy at all.
// pass is true only when no rule failed; reasons is empty on a pass.

const ACCEPT_WHAT = /(merg(?:e|es|ed|ing) [^.]*?in turn|serial (?:merges?|stages?)|one after (?:another|the other))/i
const RECOMMEND_CUE = /\b(recommend\w*|let|keep\w*|put|should|fine|acceptable|answer|stay\w*)\b/i
const REMEDY_WHAT = [/refactor(?:ing)? goal/i, /\bsplit(?:s|ting)?\b[^.]*\b(?:file|registration)\b/i, /\b(?:single|one|alone)\b[^.]*\bown(?:s|er)?\b/i]
const NEGATED = /\b(no need|no reason|not need|without|would not work|no refactor|no single|never|instead of|rather than)\b/i
const QUOTED_PLAN = /\bthe plan (?:says|states)\b/i

type Kind = 'remedy' | 'accept' | 'other'

function kindOf(sentence: string): Kind {
  if (NEGATED.test(sentence)) return 'other'
  if (REMEDY_WHAT.some((re) => re.test(sentence))) return 'remedy'
  if (ACCEPT_WHAT.test(sentence) && RECOMMEND_CUE.test(sentence) && !QUOTED_PLAN.test(sentence.replace(/"[^"]*"/g, ''))) return 'accept'
  return 'other'
}

export function gradeHotspotReview(reviewText: string, hotspotPath: string): { pass: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (!reviewText.includes(hotspotPath)) reasons.push(`the review does not name the hotspot file ${hotspotPath}`)
  const kinds = reviewText.split(/(?<=[.!?])\s+|\n+/).map(kindOf).filter((k) => k !== 'other')
  if (kinds[0] === 'accept') reasons.push('the review first recommends serial merges (merging in turn) on the hotspot file; a later remedy is only a fallback')
  else if (!kinds.includes('remedy')) reasons.push('the review proposes neither a refactor goal first nor one crew that owns the file; no remedy to serial merges')
  return { pass: reasons.length === 0, reasons }
}

// R-132 rubric grader for a plan review that touches a hotspot file (one that more than half of the planned crews own).
// Deterministic, no model call. gradeHotspotReview(reviewText, hotspotPath) returns { pass, reasons }.
//   1. The text must name the hotspot path, else it fails.
//   2. The text must not accept or recommend serial merges (or merging in turn) as its answer, else it fails and the reason says so.
//      A sentence that rejects serial merges ("instead of serial merges", "not serial merges") does not count as accepting them.
//   3. The text must propose a refactor goal first, or one crew that owns the file, else it fails.
// pass is true only when every rule holds; reasons lists each rule that failed and is empty on a pass.

const ACCEPTS = /\b(keep(?:ing)?|accept(?:ing)?|recommend(?:ing)?|stay(?:ing)? with|go(?:ing)? with|proceed(?:ing)? with|merg(?:e|ing)\b[^.]*\bin turn)\b[^.]*\b(serial (?:stages?|merges?)|merg(?:e|ing) in turn|merged? in turn)/i
const REJECTS = /\b(instead of|rather than|not|never|avoid|no)\b[^.]*\bserial merges?\b/i
const REMEDY = [/refactor goal first/i, /one (owning )?crew (that )?owns/i, /single (owning )?crew (that )?owns/i]

export function gradeHotspotReview(reviewText: string, hotspotPath: string): { pass: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (!reviewText.includes(hotspotPath)) reasons.push(`the review does not name the hotspot file ${hotspotPath}`)
  const sentences = reviewText.split(/(?<=[.!?])\s+|\n+/)
  const accepts = sentences.some((s) => ACCEPTS.test(s) && !REJECTS.test(s))
  if (accepts) reasons.push('the review accepts serial merges (merging in turn) on the hotspot file instead of a refactor goal or one owning crew')
  if (!REMEDY.some((re) => re.test(reviewText))) reasons.push('the review proposes neither a refactor goal first nor one crew that owns the file; no remedy to serial merges')
  return { pass: reasons.length === 0, reasons }
}

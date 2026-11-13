// R-132 rubric grader (interface stub, red until the builder implements it).
// Passes review text that names the hotspot file and proposes a refactor goal first or one owning crew.
// Fails review text that accepts serial merges on the hotspot file.

export type HotspotGrade = { pass: boolean; reasons: string[] }

export function gradeHotspotReview(_reviewText: string, _hotspotPath: string): HotspotGrade {
  throw new Error('gradeHotspotReview is not implemented')
}

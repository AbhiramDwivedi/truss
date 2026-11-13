// stage.js module: a lean entry's scope and acceptance test, answers, prior members and the first step of a resume. Edit here, then run `npm run build:stage`.
// ADR-0019 item 7: a lean entry carries no scope or acceptanceTest, because the goal file holds them under these headings
const scopeOf = (e) => (typeof e.scope === 'string' ? e.scope : `the "## Approved scope" section of the goal file ${e.goalFile}; read it first`)
const acceptanceOf = (e) => (typeof e.acceptanceTest === 'string' ? e.acceptanceTest : `the "## Acceptance test" section of the goal file ${e.goalFile}`)

// ADR-0019 item 12: the answers a member gets. An answer at a task name goes to that task only; one at any other name
// (a step such as red, split, green or qc, or a task the plan no longer has) goes to every member. name: null for a fix member.
// ADR-0026 item 48: an answer at a done task's name re-runs that task (runMembers), and still reaches that task only.
// ADR-0024 item 25: an answer at a UX step reaches that step, the planner and QC, never a member.
const UX_STEPS = ['ux-direction', 'ux-review']
const answersFor = (crew, name) => {
  const names = new Set((crew.tasks || []).map((t) => t.name))
  return (crew.e.answers || []).filter((a) => !UX_STEPS.includes(a.at) &&((name !== null && a.at === name) || !names.has(a.at))).map((a) => `- ${a.text}`)
}

// the earlier member branch a resumed task (or `fix, <what>`) carries over from a run before this one: the factory lists it in
// entry.prior only when the crew branch lacks its commits (factory.ts priorBranches); '' when none, or when rulingStep merged it
const priorOf = (crew, at) => {
  const p = (Array.isArray(crew.e.prior) ? crew.e.prior : []).find((x) => x && x.at === at && typeof x.branch === 'string' && !(crew.priorMerged || []).includes(x.branch))
  return p ? p.branch : ''
}

// a member's first step. --no-ff: a plain merge fast-forwards when the member branch has no commits of its own, so the branch
// equals the crew branch and the harness reaps the worktree as unchanged (bug 26). prev: the branch an earlier member of this
// task committed on before it stopped (QUESTION, BLOCKED, PROPOSAL, CHECKPOINT). The new member's worktree forks from the
// session checkout, not from that branch, so the step merges it too after the crew branch, or its commits are lost.
function firstStep(e, prev) {
  const crewMerge = `git merge --no-ff -m "merge ${e.branch}" ${e.branch}`
  const tail = [`Work in your own worktree. The crew branch is ${e.branch}.`, '']
  if (typeof prev !== 'string' || prev === '' || prev === e.branch) return [`Your first step, before anything else: ${crewMerge}`, ...tail]
  return [
    `Your first step, before anything else: ${crewMerge}, then git merge --no-ff -m "merge ${prev}" ${prev}`,
    `The second merge brings in the commits an earlier member made for this task on its branch ${prev}; the crew branch does not have them yet. Never drop either side: if either merge conflicts, run git merge --abort and stop with marker BLOCKED, naming the conflicting files.`,
    ...tail,
  ]
}


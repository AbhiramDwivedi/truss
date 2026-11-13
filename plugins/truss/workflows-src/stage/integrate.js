// stage.js module: merge conflicts and integration of member branches. Edit here, then run `npm run build:stage`.
async function resolveConflicts(crew, what, conflicts, at) {
  const persona = personaFor(crew, 'resolver', conflicts.join('\n'), at)
  const report = await ask(crew, 'resolver', resolverPrompt(crew, what, conflicts), { schema: MEMBER_SCHEMA, at, title: `Resolve merge for ${crew.slug}`, ...(persona ? { persona } : {}) })
  if (!report || report.marker !== 'DONE') throw new Stop('BLOCKED', `the resolver did not finish ${what}: ${report ? report.text : 'no report'}`, at)
}

const conflictsOf = (r) => (r.parsed && Array.isArray(r.parsed.conflicts) ? r.parsed.conflicts.map(String) : [])

// one integration at a time per crew
function integrate(crew, branch, at) {
  const job = crew.lock.then(() => integrateNow(crew, branch, at))
  crew.lock = job.catch(() => {})
  return job
}

async function integrateNow(crew, branch, at) {
  const command = `integrate --slug ${sh(crew.slug)} --branch ${sh(branch)}`
  let r = await runFactory(crew, command, 'merged')
  if (r.met) return moved(crew, headOf(r))
  // commits whose Truss-Crew or Truss-Role line git does not parse as a trailer: a stop that names them, never a resolver or a QC role FAIL
  const bad = r.parsed && Array.isArray(r.parsed.trailers) ? r.parsed.trailers.map(String) : []
  if (bad.length) throw new Stop('BLOCKED', `${branch} not merged: git does not parse the Truss-Crew or Truss-Role trailer of ${bad.join('; ')}. The trailers must be the last block of the message, with no blank line between Truss-Crew, Truss-Role and any Co-Authored-By. Reword those commits, or rerun the task.`, at)
  // commits with no Truss trailer at all: the same stop, never a resolver (its merge would put the bare commit on the crew branch)
  const bare = r.parsed && Array.isArray(r.parsed.missingTrailers) ? r.parsed.missingTrailers.map(String) : []
  if (bare.length) throw new Stop('BLOCKED', `BLOCKED: ${branch} not merged: these commits carry neither a Truss-Crew nor a Truss-Role trailer: ${bare.join('; ')}. Reword those commits to end with both trailers, or rerun the task.`, at)
  // a refusal with no conflicts and a reason (an unreadable commit range) is no merge conflict: a stop that carries the reason, never a
  // resolver; an operation in progress (inProgress) goes to the resolver, the one that can conclude it
  const conflicts = conflictsOf(r)
  if (!conflicts.length && !(r.parsed && r.parsed.inProgress) && r.parsed && typeof r.parsed.why === 'string' && r.parsed.why) throw new Stop('BLOCKED', `BLOCKED: ${branch} not merged: ${r.parsed.why}`, at)
  await resolveConflicts(crew, `merging ${branch} into ${crew.e.branch}`, conflicts, at)
  r = await runFactory(crew, command, 'merged')
  if (!r.met) throw new Stop('BLOCKED', `could not integrate ${branch} after the resolver:\n${r.out}`, at)
  return moved(crew, headOf(r))
}

// the crew head factory integrate printed after a merge, or null when it printed none
const headOf = (r) => (r.parsed && typeof r.parsed.head === 'string' && r.parsed.head ? r.parsed.head : null)

// ADR-0046 item 1: crew.moves counts the merges that changed the crew head (one that printed no head counts: it may have).
// green, scope and testsGuard remember the count they last passed at and skip a re-run on the same head.
function moved(crew, head) {
  if (!head || head !== crew.head) crew.moves = (crew.moves || 0) + 1
  return head
}
const unmoved = (crew, key) => crew[key] !== undefined && crew[key] === (crew.moves || 0)
const passedAt = (crew, key) => {
  crew[key] = crew.moves || 0
}


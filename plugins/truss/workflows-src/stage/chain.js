// stage.js module: sync, red, the crew chain, runCrew and the stage entry. Edit here, then run `npm run build:stage`.
// ---------------------------------------------------------------- one crew

async function syncStep(crew) {
  crew.step = 'R1'
  const command = `sync --slug ${sh(crew.slug)}`
  let r = await runFactory(crew, command, 'merged')
  if (r.met) return void moved(crew, headOf(r))
  await resolveConflicts(crew, `syncing ${crew.e.branch} with ${F.target}`, conflictsOf(r), 'R1')
  r = await runFactory(crew, command, 'merged')
  if (!r.met) throw new Stop('BLOCKED', `the sync is still not merged after the resolver:\n${r.out}`, 'R1')
  moved(crew, headOf(r))
}

async function redStep(crew) {
  crew.step = 'red'
  // R-142: the red check is the factory call just before the first member start (the UX direction, else the planner), so its
  // call carries that member's admission. Saved tasks leave the first member to runMembers: no admission rides here.
  crew.admitPlan = null
  if (uxOn(crew) && !crew.direction) planAdmit(crew, 'ux', `UX direction ${crew.slug}`)
  else if (!(crew.e.tasks || []).length) planAdmit(crew, 'planner')
  let r
  try {
    r = await check(crew, 'red')
  } finally {
    crew.admitPlan = null
  }
  const env = envOf(r)
  if (env) throw new Stop('BLOCKED', `the acceptance test fails on the environment, not the code, so its red proves nothing: ${env}\nFix the host (install what it names) and resume the crew.${knownOf(r)}\n${r.out}`, 'red')
  if (!r.met) throw new Stop('BLOCKED', `the acceptance test is not red at the start:${knownOf(r)}\n${r.out}`, 'red')
}

async function chain(crew) {
  const e = crew.e
  // a resume restores what the crew learned (seeded from args.learned in makeCrew) and its product calls (factory decisions --crew)
  if (e.resume) await restoreDecisions(crew)
  if (e.resume === 'merge-ready') {
    // the earlier run passed the reply checkpoint and the knowledge step; a reply that comes now is late
    crew.checkpointed = true
    crew.pastKnowledge = true
    await syncStep(crew)
    await gates(crew, { green: true, owns: true, tests: true, lint: true, admit: true })
    await green(crew)
    await scope(crew)
    return qc(crew)
  }
  // R-90: every other resume merges the target into the crew branch before the red check and any member
  if (e.resume) await syncStep(crew)
  let tasks = e.tasks || []
  crew.tasks = tasks
  // an answers resume skips the red check, unless the stop it answers was at red (an environment failure the client fixed)
  const redAnswered = (e.answers || []).some((a) => a.at === 'red')
  if ((e.resume !== 'answers' || redAnswered) && !(e.resume === 'stale' && tasks.length)) await redStep(crew)
  // ADR-0022 U4: a ux crew with no direction (a first run, or a resume with saved tasks but none) gets one before the split
  if (uxOn(crew) && !crew.direction) await uxDirection(crew)
  if (tasks.length) {
    crew.step = 'split'
    const errors = validateTasks(tasks, e.owns)
    if (errors.length) throw new Stop('BLOCKED', `the saved tasks failed these checks:\n${errors.map((x) => `- ${x}`).join('\n')}`, 'split')
  } else {
    tasks = await split(crew)
    crew.tasks = tasks
  }
  const proofsBefore = crew.proofs.length
  await runMembers(crew, tasks)
  if (e.resume) await rulingStep(crew, crew.proofs.length > proofsBefore)
  await green(crew)
  // ADR-0033: the one reply checkpoint (a change re-runs its task and checks green again). A reply that arrives after this is late:
  // the crew result lists it.
  await checkpoint(crew)
  if (uxOn(crew)) await uxReview(crew)
  // ADR-0046 item 7: the stress test runs before the knowledge step, so its fixes (and their learned items) are recorded
  if (e.stressTest) await stressTest(crew)
  // record what the crew learned (its commit moves the head, so green always runs again)
  const recorded = await knowledge(crew)
  crew.pastKnowledge = true
  // ADR-0046 item 1: green (when the knowledge commit moved the head), scope, the tests check, the lint and the QC admit in one call
  await gates(crew, { green: recorded, owns: true, tests: true, lint: true, admit: true })
  if (recorded) await green(crew)
  await scope(crew)
  return qc(crew)
}

async function runCrew(entry) {
  const crew = makeCrew(entry)
  let result
  try {
    result = await chain(crew)
  } catch (err) {
    result = stopResult(crew, err)
  }
  // replies that arrived after the checkpoint are not applied here; the main session turns a late change into a fix at merge
  // R-142: the crew-end reap rides on the crew's next factory call (the late-reply read, --reap-first) and runs alone only when
  // that read makes no call or fails before the reap ran. A Stop there still leaves the reap to run.
  let lateRead
  try {
    lateRead = await lateReplies(crew)
  } finally {
    if (crew.reapDue) await reap(crew)
  }
  const { late, unknown } = lateRead
  return { ...result, ...(late.length ? { late } : {}), ...(unknown ? { lateUnknown: true } : {}), ...(crew.unrecorded.length ? { unrecorded: crew.unrecorded } : {}) }
}

const results = await Promise.all(F.crews.map(runCrew))
log(`stage done: ${results.map((r) => `${r.slug} ${r.state}`).join(', ')}`)
return results

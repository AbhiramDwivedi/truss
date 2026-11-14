// stage.js module: crew state, Stop, results, labels, ask, admit, reap and the rework allowance. Edit here, then run `npm run build:stage`.
// ---------------------------------------------------------------- crew state and stops

class Stop {
  constructor(tag, text, at) {
    this.tag = tag
    this.text = text
    this.at = at
  }
}

// ADR-0022 U4: an entry's direction is {label, text}, or null; a missing or malformed one is null
const directionOf = (entry) => (entry.direction && typeof entry.direction === 'object' && typeof entry.direction.label === 'string' && typeof entry.direction.text === 'string' ? { label: entry.direction.label, text: entry.direction.text } : null)

// a learned item the stage args carry on a resume (factory start puts the stored items there): the same shape runMember pushes
const seededLearned = (list) =>
  (Array.isArray(list) ? list : [])
    .filter((i) => isPlainObject(i) && LEARNED_KINDS.includes(i.kind) && typeof i.text === 'string' && i.text.trim() !== '')
    .map((i) => ({ kind: i.kind, text: i.text.trim(), source: typeof i.source === 'string' ? i.source : '', ...(typeof i.target === 'string' && i.target.trim() ? { target: i.target.trim() } : {}), task: typeof i.task === 'string' && i.task ? i.task : 'earlier run', member: typeof i.member === 'string' && i.member ? i.member : 'earlier run' }))

function makeCrew(entry) {
  return { e: entry, slug: entry.slug, step: 'red', counters: {}, fails: 0, head: null, proofs: [], stressTest: null, deferred: Array.isArray(entry.deferred) ? entry.deferred : [], lock: Promise.resolve(), halted: null, direction: directionOf(entry), uxReview: null, greenOut: '', learned: seededLearned(entry.learned), decisions: [], asked: new Set(), calls: {}, knowledgeRan: false, knowledgeSha: null, checkpointed: false, pastKnowledge: false, unrecorded: [], sourceChanges: [], lint: null, lintHead: null }
}

// ADR-0022 U3: a crew builds UI only when its entry says ux true; a missing ux is false
const uxOn = (crew) => crew.e.ux === true

// the crew result's ux field (ADR-0022 U4), present only on a ux crew
const uxResult = (crew) => ({
  direction: crew.direction ? crew.direction.label : null,
  review: crew.uxReview ? crew.uxReview.label : null,
  verdict: crew.uxReview ? crew.uxReview.verdict : null,
  findings: crew.uxReview ? crew.uxReview.findings : [],
})

// the crew result's knowledge field (the retro's signal for optional learning): how many learned items members reported (a product
// call's item is not one), whether the knowledge step ran, and how many source files the diff added, renamed or deleted
// A stopped crew carries it only when something was learned or seen (a crew stopped at red or split never reached the step, so it is no skip).
const knowledgeResult = (crew, stopped = false) => {
  const k = { items: crew.learned.filter((i) => i.member !== 'po').length, ran: crew.knowledgeRan, sourceChanges: crew.sourceChanges.length }
  return stopped && !k.items && !k.ran && !k.sourceChanges ? {} : { knowledge: k }
}

function stopResult(crew, err) {
  const ux = { ...(uxOn(crew) && crew.uxReview ? { ux: uxResult(crew) } : {}), ...(crew.ltc && crew.ltc.length ? { longTermCosts: crew.ltc } : {}), ...decisionsResult(crew), ...knowledgeResult(crew, true) }
  if (err instanceof Stop) return { slug: crew.slug, state: 'stopped', tag: err.tag, text: err.text, at: err.at, ...ux }
  const text = err && err.message ? String(err.message) : String(err)
  return { slug: crew.slug, state: 'stopped', tag: 'BLOCKED', text, at: crew.step, ...ux }
}

// the label of the crew's next agent of a role: <slug>-<role>, then -2, -3 ... (numbering starts at labelFrom[role])
function peekLabel(crew, role) {
  const n = crew.counters[role] ?? (crew.e.labelFrom && crew.e.labelFrom[role]) ?? 1
  return n === 1 ? `${crew.slug}-${role}` : `${crew.slug}-${role}-${n}`
}
function nextLabel(crew, role) {
  const label = peekLabel(crew, role)
  crew.counters[role] = (crew.counters[role] ?? (crew.e.labelFrom && crew.e.labelFrom[role]) ?? 1) + 1
  return label
}

// the card title admit records for a label (ADR-0015 Decision 6): 3-8 plain words, cut to 60 characters. A runner gets none.
const TITLES = {
  planner: (s) => `Plan ${s} tasks`, resolver: (s) => `Resolve merge for ${s}`, qc: (s) => `QC ${s}`, stress: (s) => `Stress test ${s}`,
  rca: (s) => `Find root cause for ${s}`, writer: (s) => `Write docs for ${s}`, designer: (s) => `Design ${s}`,
  builder: (s) => `Build ${s}`, tester: (s) => `Write tests for ${s}`, ux: (s) => `UX direction ${s}`, po: (s) => `Product call for ${s}`,
}
const titleOf = (crew, role, title) => String(title || (TITLES[role] || ((s) => `${role} ${s}`))(crew.slug)).replace(/\s+/g, ' ').trim().slice(0, 60)

// ADR-0022 U6: the entry's ## Members value for a role ({model, effort}), or null. Builder and tester take their own line;
// a resolver follows the builder line, and a fix member takes the line of its role. A missing members is {}.
function memberFor(crew, role) {
  const m = crew.e.members
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null
  const key = role === 'resolver' ? 'builder' : role
  if (key !== 'builder' && key !== 'tester') return null
  const v = m[key]
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null
}

// ADR-0015 Decision 6: every spawn of a role other than runner is preceded by admit and followed by reap (since ADR-0046
// item 1 the reap runs inside the crew's next factory call, --reap-first, or the crew-end reap).
// opts.at names where a held admission stops (a task's name); it defaults to the crew's step.
async function ask(crew, role, prompt, opts = {}) {
  if (role === 'runner') return spawn(role, nextLabel(crew, role), prompt, opts)
  const { at, labelOut, title, ...rest } = opts
  const persona = typeof rest.persona === 'string' && rest.persona ? rest.persona : null
  if (!persona) delete rest.persona
  // ADR-0032: the ## Members line applies only to a member with no persona
  const member = persona ? null : memberFor(crew, role)
  // whether this member is meant to run at effort high, so factory's audit does not flag it (a persona, task effort or ## Members line)
  const high = (PERSONA_ROLES.includes(role) || role === 'po') && ((persona && PERSONAS[persona] && PERSONAS[persona].effort === 'high') || rest.effort === 'high' || (member && member.effort === 'high'))
  // reserve the label before the awaited admit: sibling members start in parallel, and a peek taken before the counter moves
  // would give two of them one label, so the admission title (persona, --high) would land on a label the member does not run under.
  // A held admission stops the crew and its number stays used: a resume numbers from labelFrom, so the gap is harmless.
  const label = nextLabel(crew, role)
  if (labelOut) labelOut.label = label
  await admit(crew, at ?? crew.step, label, titleOf(crew, role, title), persona, !!high)
  // a member can change the crew branch: no gates result outlives it
  dropGates(crew)
  try {
    return await spawn(role, label, prompt, member ? { ...rest, member } : rest)
  } finally {
    // ADR-0046 item 1: the reap rides on the crew's next factory call (--reap-first), not a runner spawn of its own;
    // reap() runs it alone only where no factory call follows (the crew's end)
    crew.reapDue = true
  }
}

// R-142: the member start the next factory call carries the admission for. Sets crew.admitPlan (runFactory sends it as
// --admit-first) for the label, title, persona and high that ask() will admit with; the step's call must be the very next runner call.
function planAdmit(crew, role, title, persona = null, high = false) {
  crew.admitPlan = { label: peekLabel(crew, role), title: titleOf(crew, role, title), persona, high }
}

// the admit-first answer of the last factory call (runFactory), once: only for the member start it was planned for
function takeAdmitFirst(crew, label, title, persona, high) {
  const f = crew.admitFirst
  crew.admitFirst = null
  return label && f && f.label === label && f.title === title && f.persona === (persona || null) && f.high === !!high ? f : null
}

// admit --slug: a held answer stops the crew, with no retry. ADR-0027 F-67: admit fails closed, so a result with no JSON
// object or no boolean admitted stops the crew BLOCKED with the runner output ("admission check failed:", never the
// "held by admission:" prefix the run skill reads as a memory hold). admitted: true admits, freeMB: null included (G7).
// label and title, when given, ride on the admit so factory records the card title (an event in events.jsonl)
// A hold waits inside factory (admit --wait-ms: it re-checks every 2 s for up to 90 s) before it stops the crew; a hold is never retried, only a store-busy exit is (below).
async function admit(crew, at, label, title, persona = null, high = false) {
  const cmd = `admit --wait-ms 90000 --slug ${sh(crew.slug)}${label ? ` --label ${sh(label)} --title ${sh(title)}${persona ? ` --persona ${sh(persona)}` : ''}${high ? ' --high' : ''}` : ''}`
  // ADR-0046 item 1: the QC admit may have run inside gates, with this same label and title
  // R-142: or the factory call just before this member start (--admit-first) answered for it, with this label, title, persona and high
  const first = takeAdmitFirst(crew, label, title, persona, high)
  const pre = first ?? (label && !persona && !high ? takeGate(crew, 'admit', (g) => g.admitLabel === label && g.admitTitle === title) : null)
  // a gates admit sent with no wait (the call ran green) that came back held for memory or parallelism gets its own waiting run
  const held = pre && pre.noWait && isPlainObject(pre.parsed) && pre.parsed.admitted === false && pre.parsed.budget !== true && pre.parsed.awaiting !== true
  let r = pre && !held ? pre : await runFactory(crew, cmd, 'admitted')
  // exit 2 "store busy": another process holds the crew store for a moment; one retry, then the stop below. Workflow scripts have
  // no timers (ADR-0009), so the pause is not here: factory's own lock wait (withLock, 5 s) already ran before this exit.
  if (r.exit === 2 && /store busy/.test(r.out)) {
    r = await runFactory(crew, cmd, 'admitted')
  }
  if (!isPlainObject(r.parsed) || typeof r.parsed.admitted !== 'boolean') throw new Stop('BLOCKED', `admission check failed: ${r.out}`, at)
  if (r.parsed.admitted === false) {
    const why = typeof r.parsed.why === 'string' && r.parsed.why ? r.parsed.why : r.out
    if (r.parsed.budget === true) throw new Stop('BLOCKED', `BLOCKED: budget: ${why}`, at)
    if (r.parsed.awaiting === true) {
      // factory words every open blocking item as "awaiting client:", whatever its kind; a pm-question is the program manager's to answer
      const id = (/^awaiting client: (\S+)/.exec(why) ?? [])[1]
      await (crew.callsRead ??= restoreCalls(crew))
      const row = id ? Object.values(crew.calls).find((c) => c && c.id === id && c.kind === 'pm-question') : null
      if (row) throw holdStop(row, oneLine(row.title), '', at)
      throw new Stop('BLOCKED', `BLOCKED: ${/^awaiting client:/.test(why) ? why : `awaiting client: ${why}`}`, at)
    }
    throw new Stop('BLOCKED', `held by admission: ${why}`, at)
  }
}

// reap --slug --label: a failure is logged in the crew's proofs and never stops the crew. A reap a member left due
// (crew.reapDue) is folded into this call, so it is cleared here too.
async function reap(crew) {
  crew.reapDue = false
  try {
    const r = await runFactory(crew, `reap --slug ${sh(crew.slug)} --label ${sh(`${crew.slug}-check`)}`, 'reaped')
    if (!r.parsed || typeof r.parsed !== 'object' || !Array.isArray(r.parsed.reaped)) crew.proofs.push(`reap failed: ${r.out}`)
  } catch (err) {
    crew.proofs.push(`reap failed: ${err && err.message ? err.message : String(err)}`)
  }
}

const spendOf = (crew) => crew.e.spent + crew.fails

function allowanceStop(crew, at, findings) {
  const head = `BLOCKED: rework allowance spent: ${crew.slug}, spend ${spendOf(crew)}, reworkAllowance ${F.reworkAllowance}`
  return new Stop('BLOCKED', findings ? `${head}\n${findings}` : head, at)
}

// before every QC, stress-test or fix-builder spawn
function guardAllowance(crew, at) {
  if (spendOf(crew) > F.reworkAllowance) throw allowanceStop(crew, at)
}


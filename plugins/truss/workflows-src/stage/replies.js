// stage.js module: product calls that wait on an inbox item, decision replies and the checkpoint. Edit here, then run `npm run build:stage`.
// ---------------------------------------------------------------- product calls that wait on an inbox item (R-86, ADR-0047)

// The ref of a task's inbox item: factory escalate dedupes an open item with the same kind and ref, so a re-open on a resume is one item.
// factory inbox and its dedupe span sessions, so the ref also names the run: the truss dir path under .git/truss (the basename repeats
// as wave subdirs) and the plan's approvedAt (args.truss.approvedAt, '' when the caller passes none), after the slug and task. An
// older run's item, or another session's with the same slug and task, never carries this suffix, so it never answers this run.
const RUN_KEY = (() => {
  const d = trussDir().replace(/\\/g, '/')
  const k = d.lastIndexOf('/.git/truss/')
  return [k < 0 ? '' : d.slice(k + '/.git/truss/'.length), typeof F.approvedAt === 'string' ? F.approvedAt : ''].filter(Boolean).join('@')
})()
const callRef = (crew, at) => `crew-call:${crew.slug}:${at}${RUN_KEY ? `@${RUN_KEY}` : ''}`
const callAt = (crew, ref) => {
  const head = callRef(crew, '')
  const tail = RUN_KEY ? `@${RUN_KEY}` : ''
  const lead = head.slice(0, head.length - tail.length)
  return ref.startsWith(lead) && ref.endsWith(tail) && ref.length > head.length ? ref.slice(lead.length, ref.length - tail.length) : ''
}

// The inbox rows of one kind linked to this crew whose ref is one of its calls, in the order factory inbox lists them. The wait is
// this re-read: Workflow scripts have no timers, so the script never polls; a resumed stage reads again, once per pass.
async function callRows(crew, kind) {
  const r = await runFactory(crew, `inbox --kind ${kind} --crew ${sh(crew.slug)}`, 'ok')
  const list = r.parsed && Array.isArray(r.parsed.items) ? r.parsed.items : []
  return list.filter((i) => isPlainObject(i) && i.kind === kind && typeof i.ref === 'string' && callAt(crew, i.ref) !== '' && typeof i.id === 'string')
}

// The stop of a crew whose task waits on an inbox item: only this crew stops, every other crew runs. A scope-change item is the
// client's; the program manager answers a pm-question item and never a scope-change one.
const holdStop = (row, question, branch, at) =>
  new Stop('BLOCKED', `awaiting ${row.kind === 'scope-change' ? 'client' : 'program manager'}: ${row.id} (${row.kind}, ${row.ref}): ${question}${branch ? `\nThe asking member's branch was ${branch}.` : ''}\nResume the crew after the item is resolved.`, at)

// Opens the inbox item of an escalated product call, then holds the crew at this task (the item is open) or takes its answer (it is
// already resolved). When no item can be opened the question stops the crew as a QUESTION, the old path, never a faked wait.
async function openCall(crew, role, report, at, makePrompt, opts, kind, why) {
  const ref = callRef(crew, at)
  const question = oneLine(report.text)
  let id = null
  let failed = ''
  try {
    const r = await runFactory(crew, `escalate --kind ${kind} --crew ${sh(crew.slug)} --blocking --ref ${sh(ref)} --title=${sh(oneLine(report.text, 200))} --detail=${sh(oneLine(`Product call of crew ${crew.slug}, from the ${role} on ${at}. Question: ${question} The product owner's reason: ${why}`, 3000))}`, 'id')
    if (r.parsed && typeof r.parsed.id === 'string' && r.parsed.id !== '') id = r.parsed.id
    else failed = clip(r.out, 200)
  } catch (err) {
    if (err instanceof Stop) throw err
    failed = err && err.message ? String(err.message) : String(err)
  }
  if (id === null) return { escalate: `${why} (no ${kind} inbox item could be opened: ${failed})` }
  let row = null
  try {
    row = (await callRows(crew, kind)).find((i) => i.id === id && i.ref === ref) ?? null
  } catch (err) {
    if (err instanceof Stop) throw err
    log(`inbox read failed: crew ${crew.slug}: ${err && err.message ? err.message : String(err)}`)
  }
  const branch = typeof report.branch === 'string' ? report.branch : ''
  if (!row || row.state !== 'resolved') throw holdStop({ id, kind, ref }, question, branch, at)
  return takeCall(crew, role, makePrompt, opts, at, row, branch, true)
}

// A resolved item's answer for the asking task: its resolve note, logged as a crew decision by whoever resolved it. A resolve with no
// note holds no answer, so the question stops the crew as a QUESTION.
async function takeCall(crew, role, makePrompt, opts, at, row, branch, log) {
  // the cap is resolve's own (inbox.ts resolveItem keeps 4000), so no stored answer reaches the member cut short
  const note = oneLine(row.note, 4000)
  if (!note) return { escalate: `inbox item ${row.id} was resolved (${row.decision}) with no note, so it holds no answer` }
  // a client resolve whose note factory inbox could not bind to the client's typed line is not the client's decision
  if (row.noteUnbound === true) return { escalate: `inbox item ${row.id} was resolved (${row.decision}) with a note that is not bound to a proven answer, so it holds no answer` }
  const by = row.by === 'client' ? 'client' : 'program-manager'
  // the item id is in the logged question: it is how a resumed run knows this item is already logged (pendingCall)
  return recordCall(crew, role, makePrompt, opts, at, { question: `${oneLine(row.title)} (inbox item ${row.id})`, answer: row.decision === 'answer' ? note : `${row.decision}: ${note}`, reason: '', by, source: `${by === 'client' ? 'client' : 'program manager'}, crew product call ${row.id}`, branch, log })
}

// On a resume: the stage's inbox items for the crew's calls, by task (an open one wins over a resolved one, a later over an earlier).
// A failed read is logged and changes nothing.
async function restoreCalls(crew) {
  for (const kind of ['pm-question', 'scope-change']) {
    try {
      for (const row of await callRows(crew, kind)) {
        const at = callAt(crew, row.ref)
        const was = crew.calls[at]
        // later over earlier is by the time each item was opened (row.ts), not by kind order
        const older = was && Date.parse(row.ts) < Date.parse(was.ts)
        if (at && !(was && was.state === 'open' && row.state !== 'open') && !(older && !(was.state !== 'open' && row.state === 'open'))) crew.calls[at] = row
      }
    } catch (err) {
      if (err instanceof Stop) throw err
      log(`inbox read failed: crew ${crew.slug}: ${err && err.message ? err.message : String(err)}`)
    }
  }
}

// Before a task's first member on a resume: its item still open holds the crew again (the item and not a timer decides), a resolved
// one starts the member with the answer (logged once: not again when an earlier run's decision for this task came back).
// Returns the first member's retry note, or null when the task asked nothing.
async function pendingCall(crew, role, makePrompt, opts, at, isTask = false) {
  // one inbox read per resumed crew, shared by its parallel tasks, made when the first task starts (after red and split)
  if (crew.e.resume) await (crew.callsRead ??= restoreCalls(crew))
  const row = crew.calls[at]
  if (!row) return null
  if (row.state !== 'resolved') throw holdStop(row, oneLine(row.title), '', at)
  // used once: a later member at the same step asked nothing, so the item must not answer it again
  delete crew.calls[at]
  // logged once per item, not per task: a task can ask twice, and the second item's answer is a new decision. An earlier run's
  // decision stands for this item when its logged question names the item id (takeCall puts it there)
  const logged = crew.decisions.some((d) => String(d.question).includes(`(inbox item ${row.id})`))
  // a fix or writer member at a step (green, qc, stress, knowledge) is a new member on every resume: an item an earlier run already
  // used for its asking member answers none of them (ADR-0047, one item answers one member). A task is its own asker, so it re-reads.
  if (logged && !isTask) return null
  const got = await takeCall(crew, role, makePrompt, opts, at, row, '', !logged)
  if (got.resume) return got.resume
  // a resolve with no note holds no answer, but the program manager's answers resume does: the member starts with that answer (answersFor)
  if ((crew.e.answers || []).some((a) => a && a.at === at)) return null
  throw new Stop('QUESTION', `${oneLine(row.title)}\n\n${got.escalate}`, at)
}

// re-runs the asking task once, as a fix member on top of the integrated crew branch with a main-session note, and integrates the
// result. Returns whether it ran (false: the task is not among the crew's tasks, so the change cannot be applied here).
function rerunOf(crew, role, makePrompt, opts, at) {
  return async (note) => {
    const rep = await runMember(crew, role, makePrompt, opts, at, { reason: 'product change', note, branch: '' })
    crew.proofs.push(`${at}: ${rep.proof} (after a main-session change)`)
    await integrate(crew, rep.branch, at)
    return true
  }
}

// a rerun for a decision rebuilt on a resume: the closure of the first run is gone, so the task is found by name
function rerunByTask(crew, at) {
  return async (note) => {
    const task = crewTasks(crew).find((t) => t.name === at)
    if (!task) {
      crew.proofs.push(`a main-session change to the product call at ${at} could not be applied: no task of that name; it goes to merge as a fix`)
      return false
    }
    // a done task a resume shrank to a stub may carry no brief; a rerun without one would build from "undefined"
    if (typeof task.brief !== 'string' || task.brief.trim() === '') {
      crew.proofs.push(`a main-session change to the product call at ${at} could not be applied: the task has no brief after the resume; it goes to merge as a fix`)
      return false
    }
    return rerunOf(crew, task.role, (n) => taskPrompt(crew, task, n), taskOpts(task), at)(note)
  }
}

// On a resume the crew's earlier product calls come back from factory decisions --crew: a call whose reply the crew already took
// keeps that reply; one without goes through the checkpoint like a call of this run. A failure is logged and changes nothing.
async function restoreDecisions(crew) {
  try {
    const r = await runFactory(crew, `decisions --crew ${sh(crew.slug)}`, 'ok')
    const list = r.parsed && Array.isArray(r.parsed.decisions) ? r.parsed.decisions : []
    // review 3: the earlier run already passed its reply checkpoint (the main session was told a later change is a fix at merge), so
    // this run applies no reply: checkpoint() skips, and a reply that is still unacked comes out in the result's late list
    if (r.parsed && r.parsed.checkpoint === true) crew.checkpointed = true
    for (const d of list) {
      // decisions --crew already filters by crew: a row that names another crew is skipped, one that names none is this crew's
      if (!isPlainObject(d) || (d.crew !== undefined && d.crew !== crew.slug) || typeof d.id !== 'string' || !d.id || typeof d.question !== 'string' || typeof d.answer !== 'string') continue
      if (crew.decisions.some((c) => c.id === d.id)) continue
      const task = typeof d.task === 'string' && d.task ? d.task : 'earlier run'
      const taken = d.consumed === true && (d.reply === 'ack' || d.reply === 'change')
      const changed = taken && d.reply === 'change' && typeof d.note === 'string' && d.note.trim() !== ''
      const answer = changed ? oneLine(d.note, 800) : oneLine(d.answer)
      const item = { kind: 'product', text: changed ? `${d.question} -> ${answer} (overruled by main session)` : `${d.question} -> ${answer}`, source: changed ? `main session, product call ${d.id}` : 'product-owner persona, crew product call', task, member: 'po' }
      crew.learned.push(item)
      crew.asked.add(task)
      crew.decisions.push({ id: d.id, question: d.question, answer, reason: '', reply: taken ? d.reply : null, note: changed ? answer : '', item, rerun: rerunByTask(crew, task) })
    }
  } catch (err) {
    if (err instanceof Stop) throw err
    log(`decisions --crew failed: crew ${crew.slug}: ${err && err.message ? err.message : String(err)}`)
  }
}

// the replies array factory decision-replies printed: the whole stdout, or its last line that is an array; null when the output has none
function repliesRead(out) {
  const s = String(out || '').replace(/\r/g, '').replace(/^exit -?\d+\n/, '')
  const tryParse = (x) => {
    try {
      const v = JSON.parse(x)
      return Array.isArray(v) ? v : null
    } catch {
      return null
    }
  }
  const whole = tryParse(s.trim())
  const lines = s.split('\n')
  const found = whole ?? lines.map((l) => l.trim()).filter((l) => l.startsWith('[')).map(tryParse).filter(Boolean).pop()
  return found ? found.filter((x) => isPlainObject(x) && (x.reply === 'ack' || x.reply === 'change')) : null
}
const repliesOf = (out) => repliesRead(out) ?? []

// The crew's one reply checkpoint, after every member task has integrated and the first green check has passed, before the knowledge
// step. Nothing else reads replies: a read before a member spawn, in a fix builder or in QC rework would race the integration of the
// asking member or a parallel one, or loop QC. Only a crew that made a product call reads (a read is a runner spawn).
//   read (factory decision-replies marks nothing consumed), apply each reply and ack it right after it is applied (decision-ack, one id at a time), record the
//   checkpoint (decision-checkpoint, also for a crew with no call), then the green check again when a change re-ran code.
// ack is recorded; change replaces the call's learned item and re-runs the asking task once on top of the integrated crew branch.
// A reply the crew cannot read or cannot apply is not acked, so it is still there at the late read. A failed read is logged in the
// proofs and never stops the crew.
async function checkpoint(crew) {
  // a resume whose earlier run recorded the checkpoint (restoreDecisions): its replies are late, never applied
  if (crew.checkpointed) return
  const changed = crew.decisions.length ? await applyReplies(crew) : 0
  await markCheckpoint(crew)
  if (changed) await green(crew)
}

async function applyReplies(crew) {
  let changed = 0
  try {
    const r = await runFactory(crew, `decision-replies --crew ${sh(crew.slug)}`, 'ok')
    for (const x of repliesOf(r.out)) {
      const d = crew.decisions.find((c) => c.id !== null && c.id === String(x.id))
      if (!d || d.reply !== null) continue
      if (x.reply === 'ack') {
        d.reply = 'ack'
        await ackReply(crew, d.id)
        continue
      }
      const note = oneLine(x.note, 800) || 'no note given'
      if (!(await d.rerun(`Main session changed product call ${d.id}: ${note}`))) continue
      d.reply = 'change'
      d.note = note
      d.answer = note
      const k = crew.learned.indexOf(d.item)
      d.item = { kind: 'product', text: `${d.question} -> ${note} (overruled by main session)`, source: `main session, product call ${d.id}`, task: d.item.task, member: 'po' }
      if (k >= 0) crew.learned[k] = d.item
      else crew.learned.push(d.item)
      // review 3: acked right after its own rerun integrated, so a Stop on a later change leaves this one acked and a resume does not reapply it
      await ackReply(crew, d.id)
      changed++
    }
  } catch (err) {
    if (err instanceof Stop) throw err
    crew.proofs.push(`decision-replies failed: ${err && err.message ? err.message : String(err)}`)
  }
  return changed
}

// factory decision-ack for one applied reply. A failure is logged and never stops the crew.
async function ackReply(crew, id) {
  try {
    await runFactory(crew, `decision-ack --crew ${sh(crew.slug)} --ids ${sh(id)}`, 'acked')
  } catch (err) {
    if (err instanceof Stop) throw err
    log(`decision-ack failed: crew ${crew.slug}: ${err && err.message ? err.message : String(err)}`)
  }
}

// factory decision-checkpoint: the crew passed its reply checkpoint, so a later reply is the main session's to turn into a fix at merge
async function markCheckpoint(crew) {
  crew.checkpointed = true
  try {
    // factory prints {crew, checkpoint: true}
    const r = await runFactory(crew, `decision-checkpoint --crew ${sh(crew.slug)}`, 'checkpoint')
    if (!r.met) log(`decision-checkpoint not confirmed: crew ${crew.slug}: ${clip(r.out, 300)}`)
  } catch (err) {
    if (err instanceof Stop) throw err
    log(`decision-checkpoint failed: crew ${crew.slug}: ${err && err.message ? err.message : String(err)}`)
  }
}

// the replies that arrived after the checkpoint, for the crew result's late field. Applies nothing and acks nothing: the main
// session turns a late change into a fix at merge. Only a crew that passed the checkpoint with product calls reads. A read that fails
// or cannot be read is logged and comes back as unknown: true, which the crew result carries as lateUnknown.
async function lateReplies(crew) {
  if (!crew.checkpointed || !crew.decisions.length) return { late: [], unknown: false }
  try {
    const r = await runFactory(crew, `decision-replies --crew ${sh(crew.slug)}`, 'ok')
    const read = repliesRead(r.out)
    if (read === null) {
      log(`decision-replies unreadable (late read): crew ${crew.slug}: ${clip(r.out, 300)}`)
      return { late: [], unknown: true }
    }
    const late = read
      .filter((x) => crew.decisions.some((d) => d.id !== null && d.id === String(x.id) && d.reply === null))
      .map((x) => ({ id: String(x.id), reply: x.reply, note: oneLine(x.note, 800) }))
    return { late, unknown: false }
  } catch (err) {
    if (err instanceof Stop) throw err
    log(`decision-replies failed (late read): crew ${crew.slug}: ${err && err.message ? err.message : String(err)}`)
    return { late: [], unknown: true }
  }
}

// the crew result's decisions field: only on a crew that made product calls. A call nobody answered counts as accepted.
function decisionsResult(crew) {
  if (!crew.decisions.length) return {}
  return {
    decisions: crew.decisions.map((d) => ({
      id: d.id, question: d.question, answer: d.answer,
      reply: d.reply ?? 'accepted',
      ...(d.reply === null ? { note: 'no reply from the main session by the end of the crew; counts as accepted' } : d.note ? { note: d.note } : {}),
    })),
  }
}


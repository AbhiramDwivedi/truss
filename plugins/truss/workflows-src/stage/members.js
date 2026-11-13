// stage.js module: resume lines and runMember, the restart loop of one member. Edit here, then run `npm run build:stage`.
// ---------------------------------------------------------------- members

// the lines a restart successor's prompt adds (ADR-0021 Decision 5); resume is null for a first member
function resumeLines(resume) {
  if (!resume) return []
  // ADR-0033: a product answer (the product-owner decided your QUESTION) or a main-session change of one; the note is the text
  if (resume.reason === 'product answer') return ['The product owner answered your QUESTION:', resume.note, 'Carry on with that answer. Your earlier work on this task is on the crew branch or your earlier branch; build on it.', ...(resume.branch ? [`Its branch was ${resume.branch}.`] : [])]
  if (resume.reason === 'program manager answer') return ['The program manager (or the client, for a scope change) answered your QUESTION through the inbox:', resume.note, 'Carry on with that answer. Your earlier work on this task is on the crew branch or your earlier branch; build on it.', ...(resume.branch ? [`Its branch was ${resume.branch}.`] : [])]
  if (resume.reason === 'product change') return [resume.note, 'Your earlier work on this task is already on the crew branch; change it to match, and only that.']
  const lines = resume.reason === 'no report'
    ? ['A member before you returned no report.']
    : ['A member before you stopped at a checkpoint. Carry on from its note:', resume.note]
  lines.push(resume.branch ? `Its branch was ${resume.branch}.` : '', "Read the branch's commits before you start.")
  return lines.filter((l) => l !== '')
}

// one member chain; a CHECKPOINT or a missing report restarts a fresh member of the same role, up to max(1, reworkAllowance)
// times. Restarts add no rework spend and call no guardAllowance.
// ADR-0033: a QUESTION goes to the product-owner persona first (productCall); first is a retry note for the first spawn
// (a main-session change of an earlier answer). Replies to product calls are not read here: the crew reads them at one checkpoint.
async function runMember(crew, role, makePrompt, opts, at, first = null) {
  const max = Math.max(1, F.reworkAllowance)
  let resume = first
  let restarts = 0
  let report
  let label
  let escalated = ''
  for (;;) {
    const got = {}
    report = await ask(crew, role, makePrompt(resume), { ...opts, schema: MEMBER_SCHEMA, at, labelOut: got })
    label = got.label
    const reason = !report || typeof report !== 'object' ? 'no report' : report.marker === 'CHECKPOINT' ? 'CHECKPOINT' : null
    if (!reason) {
      if (report.marker !== 'QUESTION') break
      const call = await productCall(crew, role, report, at, makePrompt, opts)
      if (call && call.resume) {
        resume = call.resume
        continue
      }
      if (call && call.escalate) escalated = call.escalate
      break
    }
    if (restarts >= max) throw new Stop('BLOCKED', `restarts spent: ${max} restart${max === 1 ? '' : 's'} used, the last member ${got.label} ended with ${reason}`, at)
    restarts++
    log(`restart: crew ${crew.slug}, label ${got.label}, n ${restarts}, reason ${reason}`)
    resume = { reason, note: reason === 'CHECKPOINT' ? report.text || '' : '', branch: reason === 'CHECKPOINT' && typeof report.branch === 'string' ? report.branch : '' }
  }
  if (report.marker !== 'DONE') {
    const tag = ['QUESTION', 'BLOCKED', 'PROPOSAL', 'CHECKPOINT'].includes(report.marker) ? report.marker : 'BLOCKED'
    // member: the stop is the member's own report, which green may re-route (ADR-0027 F-70)
    // branch: the member's own branch, for a successor that must carry its commits (greenFix); never in the crew result
    throw Object.assign(new Stop(tag, escalated ? `${report.text}\n\nThe product owner escalated this question: ${escalated}` : report.text, at), { member: true, branch: typeof report.branch === 'string' ? report.branch : '' })
  }
  const fresh = learnedOf(report).map((item) => ({ ...item, task: at, member: label }))
  if (fresh.length) {
    // a member that runs after the knowledge step (a QC fixer) is unrecorded until the knowledge re-run after its round records it
    // (knowledgeAgain, ADR-0046 item 6); what is still unrecorded at the end goes in the crew result for the run-end reconcile pass
    if (crew.pastKnowledge) crew.unrecorded.push(...fresh)
    else crew.learned.push(...fresh)
    if (at !== 'knowledge') await recordLearned(crew, fresh)
  }
  return report
}

// factory crew-learned: the crew's learned items reach the truss dir, so a resume can seed them. A failure is logged, never stops the crew.
// The items ride in one --add= argument, and a Windows command line is short, so they go in chunks whose JSON stays under
// LEARNED_CHUNK characters. One item over the limit goes alone, its text cut to fit, with a log line.
const LEARNED_CHUNK = 6000
function learnedChunks(crew, items) {
  const fits = (list) => JSON.stringify(list).length <= LEARNED_CHUNK
  const chunks = []
  let cur = []
  for (const item of items) {
    let one = item
    if (!fits([one])) {
      // cut the text until the item fits on its own; JSON escapes can make a character cost more than one
      let n = typeof one.text === 'string' ? one.text.length : 0
      while (n > 1 && !fits([one])) {
        n = Math.max(1, n - (JSON.stringify([one]).length - LEARNED_CHUNK))
        one = { ...one, text: item.text.slice(0, n) }
      }
      log(`crew-learned: an item of crew ${crew.slug} is over ${LEARNED_CHUNK} characters; its text was cut to ${one.text.length}`)
      if (cur.length) chunks.push(cur)
      chunks.push([one])
      cur = []
      continue
    }
    if (cur.length && !fits([...cur, one])) {
      chunks.push(cur)
      cur = []
    }
    cur.push(one)
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

async function recordLearned(crew, items) {
  for (const chunk of learnedChunks(crew, items)) {
    try {
      // factory prints {slug, added, total}
      const r = await runFactory(crew, `crew-learned --slug ${sh(crew.slug)} --add=${sh(JSON.stringify(chunk))}`, 'added')
      if (!r.parsed || r.parsed.added === undefined) log(`crew-learned not confirmed: crew ${crew.slug}: ${clip(r.out, 300)}`)
    } catch (err) {
      if (err instanceof Stop) throw err
      log(`crew-learned failed: crew ${crew.slug}: ${err && err.message ? err.message : String(err)}`)
    }
  }
}


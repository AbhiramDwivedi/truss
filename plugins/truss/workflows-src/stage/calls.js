// stage.js module: learned items and crew product calls (ADR-0033). Edit here, then run `npm run build:stage`.
// ---------------------------------------------------------------- learned items and crew product calls (ADR-0033)

// the well-formed learned items of a member report; a missing field is []
function learnedOf(report) {
  const list = report && Array.isArray(report.learned) ? report.learned : []
  return list
    .filter((i) => isPlainObject(i) && LEARNED_KINDS.includes(i.kind) && typeof i.text === 'string' && i.text.trim() !== '')
    .map((i) => ({ kind: i.kind, text: i.text.trim(), source: typeof i.source === 'string' ? i.source : '', ...(typeof i.target === 'string' && i.target.trim() ? { target: i.target.trim() } : {}) }))
}

const oneLine = (v, n = 500) => String(v ?? '').replace(/\s+/g, ' ').replace(/\|/g, '/').trim().slice(0, n)

// every crew decision of the run so far, one JSON line each, from the {decisions: [...]} object factory decisions prints (crew
// and reply status per call); '' when it gave none or something else
async function runDecisions(crew) {
  try {
    const r = await runFactory(crew, 'decisions', 'ok')
    const list = r.parsed && Array.isArray(r.parsed.decisions) ? r.parsed.decisions.filter(isPlainObject) : []
    return list.length ? clip(list.map((d) => JSON.stringify(d)).join('\n')) : ''
  } catch (err) {
    if (err instanceof Stop) throw err
    return ''
  }
}

function productCallPrompt(crew, report, role, at, all) {
  const e = crew.e
  // factory decisions lists every crew's calls; when it gave nothing, this crew's own earlier calls stand in
  const earlier = all ? all.split('\n') : crew.decisions.map((d) => `- ${d.question} | ${d.answer}`)
  return [
    `Product call: crew ${crew.slug}`,
    '',
    `Decide the product question below for crew ${crew.slug}, as its product owner. You are read-only: change no file and commit nothing.`,
    `The question, verbatim, from the ${role} working on ${at}:`,
    String(report.text || '').trim(),
    '',
    `Goal file: ${e.goalFile}`,
    `Approved scope: ${scopeOf(e)}`,
    `Files this crew owns: ${(Array.isArray(e.owns) ? e.owns : []).join(', ') || 'none'}`,
    `Product decisions file: ${productOwnerFile()}`,
    `Product calls of this run so far, from every crew (factory decisions: each call's crew and reply status):${earlier.length ? `\n${earlier.join('\n')}` : ' none'}`,
    '',
    'Read the goal file, the product decisions file and the requirements the goal file names, then decide.',
    "Follow an earlier call, from any crew, that settles the question. Reply PO: ESCALATE when your answer would contradict an earlier call from another crew: crews run in parallel and must not decide the same thing two ways.",
    'Escalate (reply PO: ESCALATE) when the question stays inside the crew\'s approved scope but is not yours to settle: it is not a product question; it touches another crew\'s area; or neither the product decisions file nor the requirements settle it. The program manager answers it through the inbox and the asking task waits for that answer.',
    'Reply PO: SCOPE-CHANGE when the answer would contradict the approved scope or a client ruling, or the question hits a client approval trigger in the goal file. That goes to the client as a scope-change item; only this crew waits on it, and the program manager never answers it.',
    'Never guess a product answer.',
    '',
    'Reply with no other text. Either:',
    'PO: DECIDE',
    '<the answer, in a few sentences the member can act on>',
    'Reason: <one line>',
    'or:',
    'PO: ESCALATE <why>',
    '<why this goes to the program manager>',
    'or:',
    'PO: SCOPE-CHANGE <why>',
    '<why this contradicts the approved scope or a client ruling>',
    '',
    SHELL,
    REFUSAL,
  ].join('\n')
}

// Runs the product-owner persona on a member's QUESTION. null: no product call applies (no read-only product-owner persona, or
// this task already had one); {escalate}: the question goes on to the main session with that reason; {resume}: the answer, as the
// retry note of the asking member (a DECIDE, logged through crew-decision, kept in the crew's decisions).
async function productCall(crew, role, report, at, makePrompt, opts) {
  const po = PERSONAS['product-owner']
  if (!po || po.readOnly !== true) return null
  if (crew.asked.has(at)) return null
  crew.asked.add(at)
  let text
  try {
    const all = await runDecisions(crew)
    text = await ask(crew, 'po', productCallPrompt(crew, report, role, at, all), { persona: 'product-owner', at, title: `Product call for ${crew.slug}` })
  } catch (err) {
    if (err instanceof Stop) throw err
    return { escalate: `the product call failed: ${err && err.message ? String(err.message) : String(err)}` }
  }
  const lines = unbannered(typeof text === 'string' ? text : '').replace(/\r/g, '').split('\n')
  const i = lines.findIndex((l) => l.trim() !== '')
  const head = i < 0 ? '' : lines[i].trim()
  const body = i < 0 ? [] : lines.slice(i + 1)
  // R-86: an escalation inside approved scope goes to the program manager's inbox, one that contradicts approved scope or a client
  // ruling to the client as a scope-change item; either way the asking task waits (openCall)
  for (const [lead, kind] of [['PO: ESCALATE', 'pm-question'], ['PO: SCOPE-CHANGE', 'scope-change']]) {
    if (head.startsWith(lead)) return openCall(crew, role, report, at, makePrompt, opts, kind, oneLine([head.slice(lead.length).replace(/^[:\s-]+/, ''), ...body].join(' '), 800) || 'no reason given')
  }
  if (!head.startsWith('PO: DECIDE')) return { escalate: 'the product owner gave neither a PO: DECIDE nor a PO: ESCALATE first line' }
  const reasonLine = body.find((l) => /^reason:/i.test(l.trim()))
  const answer = oneLine([head.slice('PO: DECIDE'.length).replace(/^[:\s-]+/, ''), ...body.filter((l) => l !== reasonLine)].join(' '))
  if (!answer) return { escalate: 'the product owner decided with no answer' }
  const reason = reasonLine ? oneLine(reasonLine.trim().replace(/^reason:\s*/i, '')) : ''
  return recordCall(crew, role, makePrompt, opts, at, { question: oneLine(report.text), answer, reason, by: 'product-owner', source: 'product-owner persona, crew product call', branch: typeof report.branch === 'string' ? report.branch : '', log: true })
}

// Logs a settled product call through crew-decision (log false: an earlier run already logged it), keeps it in the crew's decisions
// and learned items, and returns the retry note of the asking member. c.by is who decided: product-owner, program-manager or client.
async function recordCall(crew, role, makePrompt, opts, at, c) {
  const { question, answer, reason } = c
  const resume = { reason: c.by === 'product-owner' ? 'product answer' : 'program manager answer', note: reason ? `${answer}\nReason: ${reason}` : answer, branch: c.branch }
  if (!c.log) return { resume }
  let id = null
  try {
    // free text goes in the --flag=value form, so a value that starts with -- cannot be read as a flag
    const r = await runFactory(crew, `crew-decision --crew ${sh(crew.slug)} --task ${sh(at)} --question=${sh(question)} --answer=${sh(answer)} --by ${sh(c.by)}`, 'id')
    if (r.parsed && (typeof r.parsed.id === 'string' || typeof r.parsed.id === 'number') && String(r.parsed.id) !== '') id = String(r.parsed.id)
    else crew.proofs.push(`crew-decision failed: ${r.out}`)
  } catch (err) {
    if (err instanceof Stop) throw err
    crew.proofs.push(`crew-decision failed: ${err && err.message ? err.message : String(err)}`)
  }
  const item = { kind: 'product', text: `${question} -> ${answer}`, source: c.source, task: at, member: 'po' }
  crew.learned.push(item)
  crew.decisions.push({
    id, question, answer, reason, reply: null, note: '', item,
    rerun: rerunOf(crew, role, makePrompt, opts, at),
  })
  return { resume }
}


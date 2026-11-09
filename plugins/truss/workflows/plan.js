export const meta = {
  name: 'truss-plan',
  description: 'Runs the truss design engineer in plan mode, has a checking engineer review its verdicts.',
}

// ADR-0009 Decision 3. Every agent() call goes through spawn(); the roles table comes from args.truss.roles.
const F = args.truss
const BAD_TYPES = ['truss:foreman', 'truss:commissioning-engineer', 'truss:integrator']

function spawn(role, label, prompt, opts) {
  const r = F.roles && F.roles[role]
  if (!r) throw new Error(`role ${role} is missing from the roles table`)
  if (r.model !== 'opus' && r.model !== 'sonnet') throw new Error(`role ${role}: model must be opus or sonnet`)
  if (r.effort !== 'low' && r.effort !== 'medium') throw new Error(`role ${role}: effort must be low or medium`)
  if (typeof r.agentType !== 'string' || !r.agentType || BAD_TYPES.includes(r.agentType)) throw new Error(`role ${role}: agentType ${r.agentType} is not allowed`)
  const { judge, ...rest } = opts || {}
  const o = { ...rest, label, agentType: r.agentType, model: r.model, effort: r.effort }
  if (judge) {
    // the product-owner judge (ADR-0033): its own type, model and effort, under the same limits, in no worktree
    if (judge.model !== 'opus' && judge.model !== 'sonnet') throw new Error(`judge ${label}: model must be opus or sonnet`)
    if (judge.effort !== 'low' && judge.effort !== 'medium') throw new Error(`judge ${label}: effort must be low or medium`)
    if (typeof judge.agentType !== 'string' || !judge.agentType || BAD_TYPES.includes(judge.agentType)) throw new Error(`judge ${label}: agentType ${judge.agentType} is not allowed`)
    o.agentType = judge.agentType
    o.model = judge.model
    o.effort = judge.effort
  } else if (r.isolation === 'worktree') {
    o.isolation = 'worktree'
  }
  return agent(prompt, o)
}

const SCHEMA = {
  type: 'object',
  properties: { report: { type: 'string' }, planJson: { type: 'string' }, planMd: { type: 'string' } },
  required: ['report', 'planJson', 'planMd'],
}
const linesOf = (text, re) => String(text ?? '').split('\n').map((l) => l.trim()).filter((l) => re.test(l))

function designerPrompt(extra) {
  return [
    'Mode: plan',
    '',
    args.brief,
    '',
    'Return the plan blocks in two places: put the plan JSON in `planJson` and the plan markdown in `planMd`, and also fence both in `report`.',
    ...(extra ? ['', extra] : []),
  ].join('\n')
}

function checkerPrompt(a) {
  return [
    'Your job: the verdict review of the run skill\'s section 4 ("Have a checking engineer review the verdicts"). Review the design engineer\'s extend/change verdicts in this plan against the architecture doc and the code.',
    '',
    `Architecture doc: ${F.architecture}`,
    '',
    'planJson:',
    a.planJson,
    '',
    'planMd:',
    a.planMd,
    '',
    'For each module give one `REVIEW: agree` or `REVIEW: disagree` line, and the client triggers that hold as `Client:` lines (`Client: none` when no trigger holds).',
  ].join('\n')
}

// ---------------------------------------------------------------- product-owner review (ADR-0033)

const PERSONAS = F.personas && typeof F.personas === 'object' && !Array.isArray(F.personas) ? F.personas : {}
const NO_PO = 'the project has no product-owner persona and no draft of one in this plan'

// The `PERSONA: <name>` blocks of a design engineer's report: name and file text (bin/factory.ts personaDrafts checks them fully).
function draftsOf(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^PERSONA:\s*`?([^`\s]*)`?\s*$/.exec(lines[i])
    if (!m) continue
    let j = i + 1
    while (j < lines.length && lines[j].trim() === '') j++
    const open = /^(`{3,}|~{3,})/.exec(lines[j] || '')
    if (!open) continue
    let k = j + 1
    while (k < lines.length && !(/^(`+|~+)$/.test(lines[k].trim()) && lines[k].trim()[0] === open[1][0] && lines[k].trim().length >= open[1].length)) k++
    if (k >= lines.length) continue
    out.push({ name: m[1], text: lines.slice(j + 1, k).join('\n') })
    i = k
  }
  return out
}
// A persona file without its frontmatter block.
const bodyOf = (text) => {
  const lines = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  if (lines[0].trim() !== '---') return lines.join('\n').trim()
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  return (end < 0 ? lines : lines.slice(end + 1)).join('\n').trim()
}

// Who judges: the project's product-owner persona, else the product-owner draft in this plan's report, else nobody.
// A judge that is not loaded as its own type runs on a read-only agent type with its definition inlined, never on a type that can write.
// The neutral read-only host (agents/judge.md): it takes the inlined persona as its instructions and holds no write tool.
const JUDGE_HOST = 'truss:judge'
function judgeFor(report) {
  const p = PERSONAS['product-owner']
  if (p && typeof p === 'object') {
    const effort = p.effort === 'low' ? 'low' : 'medium' // a plan-time agent never runs above medium
    // A loaded persona runs as its own type only when it is read-only: a judge that can write must not, so any other persona is
    // inlined on the neutral host, which holds no write tool.
    if (p.readOnly === true && p.loaded === true && typeof p.agentType === 'string' && p.agentType && !BAD_TYPES.includes(p.agentType)) return { source: 'persona', agentType: p.agentType, model: p.model === 'opus' ? 'opus' : 'sonnet', effort }
    const host = p.readOnly === true && typeof p.inlineType === 'string' && p.inlineType && !BAD_TYPES.includes(p.inlineType) ? p.inlineType : JUDGE_HOST
    return { source: 'persona', agentType: host, model: p.model === 'opus' ? 'opus' : 'sonnet', effort, body: typeof p.body === 'string' ? p.body : '', file: typeof p.file === 'string' ? p.file : '' }
  }
  const draft = draftsOf(report).find((d) => d.name === 'product-owner')
  if (draft) return { source: 'draft', agentType: JUDGE_HOST, model: 'sonnet', effort: 'medium', body: bodyOf(draft.text) }
  return undefined
}

function poPrompt(judge, a) {
  const brief = [
    'Plan review:',
    '',
    "Review this plan's acceptance criteria as the product owner. Flag any that only prove the code runs: no representative or realistic data, no automated grader or eval for AI or LLM output, no check a user would recognise, a requirement with no acceptance test.",
    '',
    `Requirements: ${F.repo}/docs/requirements.md (read it when it exists; every numbered requirement needs an acceptance test)`,
    `Goal files: ${F.dir}/goals/<crew slug>.md (written once the plan is approved; until then the crew goals and acceptance tests are in the plan below)`,
    `Architecture doc: ${F.architecture}`,
    ...(typeof F.featureMap === 'string' && F.featureMap ? [`Feature map: ${F.repo}/${F.featureMap} (the capabilities that exist; read it to judge whether a criterion matches how the product is used)`] : []),
    '',
    'planJson (crews, acceptance tests):',
    a.planJson,
    '',
    'planMd:',
    a.planMd,
    '',
    'Reply: first line `PO: ACCEPT` or `PO: REVISE`. On REVISE, then numbered findings, one per line: `<n>. <crew>: <what is wrong>. Fix: <fix>`.',
  ].join('\n')
  if (judge.body === undefined) return brief
  // a persona that is loaded but not read-only arrives without its body: the file holds it
  if (judge.body.trim() === '' && judge.file) return `You are the product-owner persona. Its definition is the text below the frontmatter of ${judge.file}: read that file first, then adopt it as your system prompt for this task.\n---\n${brief}`
  return `You are the product-owner persona. Its definition follows and is your system prompt for this task:\n\n${judge.body.replace(/\s+$/, '')}\n---\n${brief}`
}

// What a revision must not change: the verdict lines of plan.md (`<module>: extend|change (...)`) and the crews of plan.json
// (slug, verdict, owns and modules), each as one comparable string. A plan.json that does not parse gives no crews.
const listOf = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).sort()
function shapeOf(plan) {
  const verdicts = linesOf(plan.planMd, /^[-*\s]*`?[^:|`]+`?\s*:\s*(extend|change)\b/i)
    .map((l) => l.replace(/^[-*\s]+/, '').replace(/\s*\(.*$/, '').replace(/`/g, '').replace(/\s+/g, ' ').toLowerCase())
    .sort()
  let crews = []
  try {
    const j = JSON.parse(plan.planJson)
    crews = (Array.isArray(j.crews) ? j.crews : []).map((c) => `${c && c.slug}:${c && c.verdict}:${JSON.stringify(listOf(c && c.owns))}:${JSON.stringify(listOf(c && c.modules))}`).sort()
  } catch {}
  return { verdicts: verdicts.join('\n'), crews: crews.join('\n') }
}

// The revise brief: the findings, and the first plan verbatim (planJson, planMd and the PERSONA drafts of its report), so the
// second designer edits that plan instead of planning again: slugs, owns, verdicts and drafts stay as they were. A persona file is
// fenced with a run of backticks longer than any it holds, as the design engineer fences it.
function reviseNote(first, findings) {
  const fence = (text) => '`'.repeat(Math.max(4, ...(String(text).match(/`+/g) || []).map((m) => m.length + 1)))
  const drafts = draftsOf(first.report).map((d) => `PERSONA: ${d.name}\n${fence(d.text)}\n${d.text}\n${fence(d.text)}`)
  return [
    'The product owner reviewed the plan and found these acceptance-criteria problems. Revise the plan to fix them. Change only the acceptance criteria, the acceptance tests and the test data: never the verdicts, the crew split or the scope. Keep every other part, and return the whole plan (and any persona drafts) again:',
    '',
    ...findings,
    '',
    'The plan under review, verbatim. Edit it; do not plan again. Keep every slug, verdict, owns and module as written here:',
    '',
    'planJson:',
    first.planJson,
    '',
    'planMd:',
    first.planMd,
    ...(drafts.length ? ['', 'Persona drafts from its report, verbatim (return them again, changed only where a finding needs it):', '', ...drafts.flatMap((d) => [d, ''])] : []),
  ].join('\n')
}

// One review: { verdict: 'ACCEPT' | 'REVISE' | 'UNCLEAR', findings: ['1. ...'] }.
async function reviewOnce(judge, label, a) {
  const text = await spawn('checker', label, poPrompt(judge, a), { judge })
  if (text == null) throw new Error(`${label} returned nothing`)
  const first = linesOf(text, /^PO:/)[0] || ''
  const verdict = /^PO:\s*ACCEPT\b/i.test(first) ? 'ACCEPT' : /^PO:\s*REVISE\b/i.test(first) ? 'REVISE' : 'UNCLEAR'
  const findings = linesOf(text, /^\d+\.\s/)
  return { verdict, findings: verdict === 'UNCLEAR' && !findings.length ? ['(the product-owner review had no `PO: ACCEPT` or `PO: REVISE` line: ' + String(typeof text === 'string' ? text : JSON.stringify(text)).slice(0, 200).replace(/\s+/g, ' ') + ')'] : findings }
}

const fix = F.fix === true
const designerLabel = fix ? 'truss-designer-3' : 'truss-designer'
const checkerLabel = fix ? 'truss-checker-3' : 'truss-checker'
const poLabel = fix ? 'truss-po-3' : 'truss-po'
const poLabel2 = fix ? 'truss-po-4' : 'truss-po-2'

phase('Plan')
let a = await spawn('designer', designerLabel, designerPrompt(), { schema: SCHEMA })
if (!a || typeof a.planJson !== 'string') throw new Error(`${designerLabel} returned no plan`)

const uncovered = linesOf(a.report, /^UNCOVERED:/)
if (uncovered.length) return { uncovered }

phase('Review')
const client = []
const addClient = (text) => {
  for (const l of linesOf(text, /^Client:/)) if (!/^Client:\s*none\b/i.test(l) && !client.includes(l)) client.push(l)
}
const review = await spawn('checker', checkerLabel, checkerPrompt(a))
if (review == null) throw new Error(`${checkerLabel} returned nothing`)
addClient(review)
const reviews = linesOf(review, /^REVIEW:/)
const disagrees = () => reviews.some((l) => /^REVIEW:\s*disagree\b/i.test(l))

// The product-owner review of the acceptance criteria. REVISE goes back to the designer once, then the review runs once more;
// a second REVISE stays in the result as open findings for the PM to rule on. The checking engineer's review above is of the first plan.
let resultLabel = designerLabel
let productOwner = { skipped: NO_PO }
let recheck
const judge = judgeFor(a.report)
// A plan the checking engineer disagrees with goes back to the design engineer (run skill, step 2) whatever the product owner says,
// so reviewing its acceptance criteria now would be paid for twice.
if (disagrees()) {
  productOwner = { skipped: 'checking engineer disagrees; plan goes back to step 2' }
} else if (judge) {
  phase('Product owner')
  let r = await reviewOnce(judge, poLabel, a)
  let revised = false
  if (r.verdict === 'REVISE') {
    resultLabel = `${designerLabel}-po`
    const b = await spawn('designer', resultLabel, designerPrompt(reviseNote(a, r.findings)), { schema: SCHEMA })
    if (!b || typeof b.planJson !== 'string') throw new Error(`${resultLabel} returned no plan`)
    const before = shapeOf(a)
    a = b
    revised = true
    r = await reviewOnce(judge, poLabel2, a)
    // The revision may only touch acceptance criteria. When its verdict lines or crew list differ from the first plan anyway,
    // the checking engineer's review of the first plan no longer covers it, so it reviews the revised plan once.
    const after = shapeOf(a)
    const changed = []
    if (before.verdicts !== after.verdicts) changed.push('verdict lines')
    if (before.crews !== after.crews) changed.push('crew list')
    if (changed.length) {
      const text = await spawn('checker', `${checkerLabel}-2`, checkerPrompt(a))
      if (text == null) throw new Error(`${checkerLabel}-2 returned nothing`)
      addClient(text)
      const rr = linesOf(text, /^REVIEW:/)
      recheck = { ran: true, reason: `the revised plan changed its ${changed.join(' and ')}`, reviews: rr, stillDisagree: rr.some((l) => /^REVIEW:\s*disagree\b/i.test(l)) }
    } else {
      recheck = { ran: false, reason: 'the revised plan kept the first plan\'s verdict lines and crew list' }
    }
  }
  productOwner = { judge: judge.source, verdict: r.verdict, revised, open: r.verdict === 'ACCEPT' ? [] : r.findings }
}
const personaDrafts = draftsOf(a.report).map((d) => d.name)

return { designerLabel: resultLabel, reviews, client, stillDisagree: recheck && recheck.ran ? recheck.stillDisagree : disagrees(), productOwner, ...(recheck ? { recheck } : {}), ...(personaDrafts.length ? { personaDrafts } : {}) }

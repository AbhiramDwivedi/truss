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
  const o = { ...(opts || {}), label, agentType: r.agentType, model: r.model, effort: r.effort }
  if (r.isolation === 'worktree') o.isolation = 'worktree'
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

const fix = F.fix === true
const designerLabel = fix ? 'truss-designer-3' : 'truss-designer'
const checkerLabel = fix ? 'truss-checker-3' : 'truss-checker'

phase('Plan')
const a = await spawn('designer', designerLabel, designerPrompt(), { schema: SCHEMA })
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

return { designerLabel, reviews, client, stillDisagree: disagrees() }

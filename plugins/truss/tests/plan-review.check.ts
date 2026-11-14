// @ts-nocheck
// truss ADR-0033, plan-time mechanics. Written from the contract before the change.
//   1. plan.js runs a product-owner review of the plan's acceptance criteria after the checking engineer, once more after one revision
//   2. plan-write puts every `PERSONA: <name>` draft on disk under <truss dir>/personas and lists it; a malformed block is reported, never written
//   3. plan-args carries the project's personas, so plan.js can find the product-owner persona
//   4. admit --persona x --high then finish writes persona "x" on the spawn event and no effort audit finding; no persona records null
// Run with: node --test tests/plan-review.check.ts

import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as reg from '../hooks/register.ts'
import { addCrewWorktree, appendEvent, crew, factorySpawn, git, head, mkEnv, mkRepo, mkRun, mkTrussDir, planObj, putFile, qcReport, readEvents, runCli, tmp, writePlan } from './fixtures/workflow-run/harness.ts'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')
const PLAN_JS = `${PLUGIN}/workflows/plan.js`
const t = (name, fn) => test(name, { timeout: 90000 }, fn)

const ROLES = {
  designer: { agentType: 'truss:design-engineer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  checker: { agentType: 'truss:checking-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
}

// ---------------------------------------------------------------- plan.js harness

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
async function execPlan(args, labels) {
  const body = readFileSync(PLAN_JS, 'utf8').replace(/^\s*export\s+const\s+meta\b/m, 'const meta')
  const calls = []
  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts, label: opts.label })
    await new Promise((r) => setImmediate(r))
    if (!Object.hasOwn(labels, opts.label)) throw new Error(`unscripted label: ${opts.label}`)
    const h = labels[opts.label]
    const v = typeof h === 'function' ? await h(calls[calls.length - 1], calls) : h
    return v === null || v === undefined ? v : structuredClone(v)
  }
  let result
  let error
  try {
    result = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'allowance', body)(agent, async () => [], async () => [], () => {}, () => {}, structuredClone(args), {})
  } catch (e) {
    error = e
  }
  return { result, error, calls, labels: calls.map((c) => c.label) }
}

const planArgs = (o = {}) => ({
  truss: { kind: 'plan', dir: '/proj/.truss', repo: '/proj', plugin: PLUGIN, schema: 'S', architecture: '/proj/docs/ARCH.md', roles: ROLES, scriptPath: PLAN_JS, personas: o.personas ?? {}, ...(o.fix ? { fix: true } : {}) },
  brief: 'BRIEF-TEXT',
})
const ARCH = (report = 'Plan ready.', extra = {}) => ({ report, planJson: '{"PLANJSON":1}', planMd: '# PLANMD-MARK', ...extra })
const AGREE = 'REVIEW: agree\nClient: none'
const PO_BODY = 'You judge the product fit.\nBe strict about realistic data.'
const DRAFT_FILE = `---\nname: product-owner\ndescription: Judges plan fit\ntools: Read, Grep, Glob\nmodel: opus\n---\n\n${PO_BODY}\n\n## Standards\n\n- realistic data\n`
const withDraft = (name = 'product-owner', file = DRAFT_FILE) => `Plan ready.\n\nPersonas: ${name}: judge\nProduct owner: drafted\n\nPERSONA: ${name}\n\`\`\`\`markdown\n${file}\`\`\`\`\n`
const PO_PERSONA = { agentType: 'product-owner', model: 'opus', effort: 'medium', file: '/proj/.claude/agents/product-owner.md', description: 'judge', readOnly: true, loaded: true }
const ACCEPT = 'PO: ACCEPT\n'
const REVISE = (n = 1) => `PO: REVISE\n1. api: only checks the code runs. Fix: add a graded fixture run (round ${n})\n2. ui: no check a user would recognise. Fix: screenshot the page\n`

t('po 1: with no product-owner persona and no draft, plan.js skips the review and says so in the result', async () => {
  const r = await execPlan(planArgs(), { 'truss-designer': ARCH(), 'truss-checker': AGREE })
  assert.ifError(r.error)
  assert.deepEqual(r.labels, ['truss-designer', 'truss-checker'])
  assert.equal(r.result.designerLabel, 'truss-designer')
  assert.equal(r.result.stillDisagree, false)
  assert.match(r.result.productOwner.skipped, /no product-owner persona and no draft/)
})

t('po 2: a loaded product-owner persona reviews as its own type; the brief starts "Plan review:" and carries the plan and the paths', async () => {
  const r = await execPlan(planArgs({ personas: { 'product-owner': PO_PERSONA } }), { 'truss-designer': ARCH(), 'truss-checker': AGREE, 'truss-po': ACCEPT })
  assert.ifError(r.error)
  assert.deepEqual(r.labels, ['truss-designer', 'truss-checker', 'truss-po'])
  const c = r.calls[2]
  assert.equal(c.opts.agentType, 'product-owner')
  assert.equal(c.opts.model, 'opus')
  assert.equal(c.prompt.split('\n')[0], 'Plan review:')
  for (const w of ['{"PLANJSON":1}', '# PLANMD-MARK', '/proj/docs/requirements.md', '/proj/.truss/goals', 'PO: ACCEPT', 'PO: REVISE']) assert.ok(c.prompt.includes(w), w)
  assert.ok(!Object.hasOwn(c.opts, 'isolation'))
  assert.equal(r.result.productOwner.verdict, 'ACCEPT')
  assert.equal(r.result.productOwner.revised, false)
  assert.deepEqual(r.result.productOwner.open, [])
})

t('po 3: with no persona but a PERSONA: product-owner draft, the draft body is inlined under the fixed header on a read-only host', async () => {
  const r = await execPlan(planArgs(), { 'truss-designer': ARCH(withDraft()), 'truss-checker': AGREE, 'truss-po': ACCEPT })
  assert.ifError(r.error)
  const c = r.calls[2]
  assert.equal(c.opts.agentType, 'truss:judge') // the neutral read-only host, never a writing type and never the checker's own prompt
  assert.ok(c.prompt.startsWith('You are the product-owner persona. Its definition follows and is your system prompt for this task:\n\n'), c.prompt.slice(0, 120))
  assert.ok(c.prompt.includes(PO_BODY))
  assert.ok(!c.prompt.includes('name: product-owner'), 'the frontmatter is not inlined')
  assert.ok(c.prompt.includes('\nPlan review:\n'))
  assert.deepEqual(r.result.personaDrafts, ['product-owner'])
  assert.equal(r.result.productOwner.verdict, 'ACCEPT')
})

t('po 4: an unloaded read-only product-owner persona runs on its inlineType with its body inlined', async () => {
  const p = { ...PO_PERSONA, loaded: false, body: PO_BODY, inlineType: 'truss:judge' }
  const r = await execPlan(planArgs({ personas: { 'product-owner': p } }), { 'truss-designer': ARCH(), 'truss-checker': AGREE, 'truss-po': ACCEPT })
  assert.ifError(r.error)
  assert.equal(r.calls[2].opts.agentType, 'truss:judge')
  assert.ok(r.calls[2].prompt.includes(PO_BODY))
})

t('po 5: REVISE sends the numbered findings to the designer once, then the review runs again; ACCEPT on the second pass', async () => {
  const r = await execPlan(planArgs({ personas: { 'product-owner': PO_PERSONA } }), {
    'truss-designer': ARCH(), 'truss-checker': AGREE, 'truss-po': REVISE(), 'truss-designer-2': ARCH('Revised plan.', { planJson: '{"REVISED":1}' }), 'truss-po-2': ACCEPT,
  })
  assert.ifError(r.error)
  assert.deepEqual(r.labels, ['truss-designer', 'truss-checker', 'truss-po', 'truss-designer-2', 'truss-po-2'])
  const d = r.calls[3]
  assert.equal(d.prompt.split('\n')[0], 'Mode: plan')
  assert.ok(d.prompt.includes('1. api: only checks the code runs. Fix: add a graded fixture run (round 1)'))
  assert.ok(d.prompt.includes('2. ui: no check a user would recognise'))
  assert.ok(r.calls[4].prompt.includes('{"REVISED":1}'), 'the second review sees the revised plan')
  assert.equal(r.result.designerLabel, 'truss-designer-2')
  assert.equal(r.result.productOwner.verdict, 'ACCEPT')
  assert.equal(r.result.productOwner.revised, true)
  assert.deepEqual(r.result.productOwner.open, [])
})

t('po 6: a second REVISE ends the loop: no third designer or review, the findings go into the result as open', async () => {
  const r = await execPlan(planArgs({ personas: { 'product-owner': PO_PERSONA } }), {
    'truss-designer': ARCH(), 'truss-checker': AGREE, 'truss-po': REVISE(1), 'truss-designer-2': ARCH('Revised.'), 'truss-po-2': REVISE(2),
    'truss-designer-3': ARCH(), 'truss-po-3': ACCEPT,
  })
  assert.ifError(r.error)
  assert.deepEqual(r.labels, ['truss-designer', 'truss-checker', 'truss-po', 'truss-designer-2', 'truss-po-2'])
  assert.equal(r.result.productOwner.verdict, 'REVISE')
  assert.equal(r.result.productOwner.revised, true)
  assert.equal(r.result.productOwner.open.length, 2)
  assert.match(r.result.productOwner.open[0], /^1\. api: .*round 2/)
})

t('po 7: a fix run labels the review truss-po-3 and the revision truss-designer-4', async () => {
  const r = await execPlan(planArgs({ fix: true, personas: { 'product-owner': PO_PERSONA } }), {
    'truss-designer-3': ARCH(), 'truss-checker-3': AGREE, 'truss-po-3': REVISE(), 'truss-designer-4': ARCH(), 'truss-po-4': ACCEPT,
  })
  assert.ifError(r.error)
  assert.deepEqual(r.labels, ['truss-designer-3', 'truss-checker-3', 'truss-po-3', 'truss-designer-4', 'truss-po-4'])
})

t('po 8: an UNCOVERED line returns before any review; a reply with no PO: line is reported, not guessed', async () => {
  const u = await execPlan(planArgs({ personas: { 'product-owner': PO_PERSONA } }), { 'truss-designer': ARCH('UNCOVERED: x | y') })
  assert.deepEqual(u.labels, ['truss-designer'])
  assert.deepEqual(u.result, { uncovered: ['UNCOVERED: x | y'] })
  const r = await execPlan(planArgs({ personas: { 'product-owner': PO_PERSONA } }), { 'truss-designer': ARCH(), 'truss-checker': AGREE, 'truss-po': 'looks fine to me' })
  assert.deepEqual(r.labels, ['truss-designer', 'truss-checker', 'truss-po'])
  assert.equal(r.result.productOwner.verdict, 'UNCLEAR')
  assert.equal(r.result.productOwner.open.length, 1)
})

t('po 9 (review 1): the revise prompt carries the first plan verbatim: planJson, planMd and the PERSONA blocks of the first report', async () => {
  const first = { report: withDraft(), planJson: '{"crews":[{"slug":"api","verdict":"extend","owns":["src/api/**"]}],"FIRST":"x y  z"}', planMd: '# First plan\n\n- store: extend (reuses the seam)\n\n| 1 | api | extend |\n' }
  const r = await execPlan(planArgs({ personas: { 'product-owner': PO_PERSONA } }), {
    'truss-designer': first, 'truss-checker': AGREE, 'truss-po': REVISE(), 'truss-designer-2': ARCH('Revised plan.', { planJson: first.planJson, planMd: first.planMd }), 'truss-po-2': ACCEPT,
  })
  assert.ifError(r.error)
  const p = r.calls[3].prompt
  assert.equal(p.split('\n')[0], 'Mode: plan')
  assert.ok(p.includes(first.planJson), 'planJson verbatim')
  assert.ok(p.includes(first.planMd), 'planMd verbatim')
  assert.ok(p.includes('PERSONA: product-owner\n````\n' + DRAFT_FILE.replace(/\n$/, '') + '\n````'), 'the PERSONA block verbatim in a four-backtick fence:\n' + p.slice(-700))
  assert.ok(p.includes('1. api: only checks the code runs'), 'and the findings')
  assert.ok(p.indexOf('BRIEF-TEXT') < p.indexOf(first.planJson))
})

t('po 9b (review 1): a persona draft that holds a four-backtick run is fenced with a longer fence; a first plan with no draft carries no PERSONA line', async () => {
  const tricky = DRAFT_FILE + '\n````text\ninner\n````\n'
  const a = await execPlan(planArgs({ personas: { 'product-owner': PO_PERSONA } }), {
    'truss-designer': ARCH(`R\n\nPERSONA: product-owner\n\`\`\`\`\`markdown\n${tricky}\`\`\`\`\`\n`), 'truss-checker': AGREE, 'truss-po': REVISE(), 'truss-designer-2': ARCH('Revised.'), 'truss-po-2': ACCEPT,
  })
  assert.ifError(a.error)
  assert.ok(a.calls[3].prompt.includes('PERSONA: product-owner\n`````\n' + tricky.replace(/\n$/, '') + '\n`````'), a.calls[3].prompt.slice(-500))
  const b = await execPlan(planArgs({ personas: { 'product-owner': PO_PERSONA } }), {
    'truss-designer': ARCH(), 'truss-checker': AGREE, 'truss-po': REVISE(), 'truss-designer-2': ARCH('Revised.'), 'truss-po-2': ACCEPT,
  })
  assert.ok(!b.calls[3].prompt.includes('PERSONA:'))
})

t('po 10 (cost): when the checking engineer already disagrees, the product-owner review is skipped and the result says why', async () => {
  const r = await execPlan(planArgs({ personas: { 'product-owner': PO_PERSONA } }), { 'truss-designer': ARCH(), 'truss-checker': 'REVIEW: disagree\nClient: new seam' })
  assert.ifError(r.error)
  assert.deepEqual(r.labels, ['truss-designer', 'truss-checker'])
  assert.deepEqual(r.result.productOwner, { skipped: 'checking engineer disagrees; plan goes back to step 2' })
  assert.equal(r.result.stillDisagree, true)
  assert.deepEqual(r.result.client, ['Client: new seam'])
  const d = await execPlan(planArgs(), { 'truss-designer': ARCH(withDraft()), 'truss-checker': 'REVIEW: disagree' })
  assert.deepEqual(d.labels, ['truss-designer', 'truss-checker'], 'with a draft too')
  assert.deepEqual(d.result.personaDrafts, ['product-owner'], 'the drafts still reach the result')
})

t('po 11 (review 9): a loaded product-owner persona that is not read-only never judges as its own type: truss:judge with the body inlined', async () => {
  for (const readOnly of [false, undefined]) {
    const p = { ...PO_PERSONA, readOnly, body: PO_BODY }
    if (readOnly === undefined) delete p.readOnly
    const r = await execPlan(planArgs({ personas: { 'product-owner': p } }), { 'truss-designer': ARCH(), 'truss-checker': AGREE, 'truss-po': ACCEPT })
    assert.ifError(r.error)
    assert.equal(r.calls[2].opts.agentType, 'truss:judge', `readOnly ${readOnly}`)
    assert.ok(r.calls[2].prompt.includes(PO_BODY))
  }
  const noBody = await execPlan(planArgs({ personas: { 'product-owner': { ...PO_PERSONA, readOnly: false } } }), { 'truss-designer': ARCH(), 'truss-checker': AGREE, 'truss-po': ACCEPT })
  assert.equal(noBody.calls[2].opts.agentType, 'truss:judge')
  assert.ok(noBody.calls[2].prompt.includes('/proj/.claude/agents/product-owner.md'), 'with no body the brief points at the persona file')
  const ro = await execPlan(planArgs({ personas: { 'product-owner': PO_PERSONA } }), { 'truss-designer': ARCH(), 'truss-checker': AGREE, 'truss-po': ACCEPT })
  assert.equal(ro.calls[2].opts.agentType, 'product-owner', 'readOnly true and loaded still runs as its own type')
})

t('po 12 (review 10): the review brief names the feature map when plan-args found one; without it, no feature-map line', async () => {
  const withMap = planArgs({ personas: { 'product-owner': PO_PERSONA } })
  withMap.truss.featureMap = 'docs/features.md'
  const r = await execPlan(withMap, { 'truss-designer': ARCH(), 'truss-checker': AGREE, 'truss-po': ACCEPT })
  assert.match(r.calls[2].prompt, /Feature map: \/proj\/docs\/features\.md/)
  const without = await execPlan(planArgs({ personas: { 'product-owner': PO_PERSONA } }), { 'truss-designer': ARCH(), 'truss-checker': AGREE, 'truss-po': ACCEPT })
  assert.ok(!without.calls[2].prompt.includes('Feature map'))
})

// ---------------------------------------------------------------- re-check of a revised plan

const PLAN_A = (verdict = 'extend', slugs = ['api', 'ui']) => ({
  planJson: JSON.stringify({ crews: slugs.map((slug) => ({ slug, verdict })) }),
  planMd: `# Plan\n\nVerdicts:\n- store: ${verdict} (reuses the seam)\n- web: extend (no new seam)\n\n| 1 | api | ${verdict} |\n`,
})
const PO_ARGS = () => planArgs({ personas: { 'product-owner': PO_PERSONA } })

t('recheck 1: the revision brief limits the designer to acceptance criteria, acceptance tests and test data', async () => {
  const r = await execPlan(PO_ARGS(), { 'truss-designer': ARCH('R', PLAN_A()), 'truss-checker': AGREE, 'truss-po': REVISE(), 'truss-designer-2': ARCH('R2', PLAN_A()), 'truss-po-2': ACCEPT })
  assert.ifError(r.error)
  const p = r.calls[3].prompt
  assert.match(p, /Change only the acceptance criteria, the acceptance tests and the test data/)
  assert.match(p, /never the verdicts, the crew split or the scope/)
})

t('recheck 2: a revised plan with the same verdict lines and crews is not re-checked; the result says so', async () => {
  const r = await execPlan(PO_ARGS(), { 'truss-designer': ARCH('R', PLAN_A()), 'truss-checker': AGREE, 'truss-po': REVISE(), 'truss-designer-2': ARCH('R2', PLAN_A()), 'truss-po-2': ACCEPT })
  assert.ifError(r.error)
  assert.deepEqual(r.labels, ['truss-designer', 'truss-checker', 'truss-po', 'truss-designer-2', 'truss-po-2'])
  assert.equal(r.result.recheck.ran, false)
})

t('recheck 3: a revision that changes a verdict re-runs the checking engineer once on the revised plan and reports it', async () => {
  const r = await execPlan(PO_ARGS(), {
    'truss-designer': ARCH('R', PLAN_A('extend')), 'truss-checker': AGREE, 'truss-po': REVISE(), 'truss-designer-2': ARCH('R2', PLAN_A('change')), 'truss-po-2': ACCEPT,
    'truss-checker-2': 'REVIEW: disagree\nClient: new seam needs the client',
  })
  assert.ifError(r.error)
  assert.deepEqual(r.labels, ['truss-designer', 'truss-checker', 'truss-po', 'truss-designer-2', 'truss-po-2', 'truss-checker-2'])
  const c = r.calls[5]
  assert.equal(c.opts.agentType, 'truss:checking-engineer')
  assert.ok(c.prompt.includes('"verdict":"change"'), 'the re-check sees the revised plan')
  assert.equal(r.result.recheck.ran, true)
  assert.deepEqual(r.result.recheck.reviews, ['REVIEW: disagree'])
  assert.equal(r.result.stillDisagree, true)
  assert.ok(r.result.client.includes('Client: new seam needs the client'))
})

t('recheck 4: a revision that changes the crew list re-runs it; a fix run labels it truss-checker-4', async () => {
  const r = await execPlan(planArgs({ fix: true, personas: { 'product-owner': PO_PERSONA } }), {
    'truss-designer-3': ARCH('R', PLAN_A('extend', ['api'])), 'truss-checker-3': AGREE, 'truss-po-3': REVISE(), 'truss-designer-4': ARCH('R2', PLAN_A('extend', ['api', 'ui'])), 'truss-po-4': ACCEPT,
    'truss-checker-4': AGREE,
  })
  assert.ifError(r.error)
  assert.deepEqual(r.labels.slice(-1), ['truss-checker-4'])
  assert.equal(r.result.recheck.ran, true)
  assert.equal(r.result.stillDisagree, false)
})

t('recheck 5: no product-owner revision means no recheck field', async () => {
  const r = await execPlan(planArgs(), { 'truss-designer': ARCH(), 'truss-checker': AGREE })
  assert.ok(!Object.hasOwn(r.result, 'recheck'))
})

t('recheck 6 (review 1): a revision that changes a crew\'s owns or modules re-runs the checking engineer, even with the same slugs and verdicts', async () => {
  const planWith = (crews) => ({ planJson: JSON.stringify({ crews }), planMd: '# Plan\n\n- store: extend (x)\n' })
  const base = [{ slug: 'api', verdict: 'extend', owns: ['src/api/**'], modules: ['api'] }]
  for (const [name, changed] of [['owns', [{ ...base[0], owns: ['src/**'] }]], ['modules', [{ ...base[0], modules: ['api', 'db'] }]]]) {
    const r = await execPlan(PO_ARGS(), { 'truss-designer': ARCH('R', planWith(base)), 'truss-checker': AGREE, 'truss-po': REVISE(), 'truss-designer-2': ARCH('R2', planWith(changed)), 'truss-po-2': ACCEPT, 'truss-checker-2': AGREE })
    assert.ifError(r.error)
    assert.equal(r.result.recheck.ran, true, `${name} changed`)
    assert.deepEqual(r.labels.slice(-1), ['truss-checker-2'])
  }
  const same = await execPlan(PO_ARGS(), { 'truss-designer': ARCH('R', planWith(base)), 'truss-checker': AGREE, 'truss-po': REVISE(), 'truss-designer-2': ARCH('R2', planWith([{ slug: 'api', verdict: 'extend', modules: ['api'], owns: ['src/api/**'] }])), 'truss-po-2': ACCEPT })
  assert.equal(same.result.recheck.ran, false, 'key order alone is no change')
})

// ---------------------------------------------------------------- plan-write persona drafts

const fenced = (json, md) => `Report.\n\n\`\`\`\`json plan.json\n${json}\n\`\`\`\`\n\n\`\`\`\`markdown plan.md\n${md}\n\`\`\`\`\n`
const PLAN = JSON.stringify({ ...planObj([crew('arch', { stage: 0, verdict: 'design' })], { approval: 'client', approvedAt: null }), goal: 'g' })
const file = (name, extra = '') => `---\nname: ${name}\ndescription: ${name} area\nmodel: sonnet\n${extra}---\n\nBody of ${name}.\n\n## Standards\n\n- a rule\n`
const block = (name, text, fence = '````markdown') => `PERSONA: ${name}\n${fence}\n${text}${fence.replace(/[^`~]*$/, '')}\n`

function writeWith(report) {
  const env = mkEnv({ useRealPlugin: true })
  const { dir } = mkRun(env.transcripts, 'wf_plan', [{ id: 'aarch', label: 'truss-designer', agentType: 'truss:design-engineer', metaModel: 'opus', result: { report, planJson: PLAN, planMd: '# md' } }])
  const res = env.run('plan-write', { transcript: dir, label: 'truss-designer' })
  const pdir = `${env.dir}/personas`
  return { env, res, files: existsSync(pdir) ? readdirSync(pdir).sort() : [], read: (n) => readFileSync(`${pdir}/${n}.md`, 'utf8') }
}

t('draft 1: plan-write writes each PERSONA block to <truss dir>/personas/<name>.md and lists {name, path}', () => {
  const report = `${fenced(PLAN, '# md')}\nPersonas: a, b\n\n${block('java-service-dev', file('java-service-dev'))}\nprose\n\n${block('product-owner', file('product-owner', 'tools: Read, Grep, Glob\n'), '```')}`
  const w = writeWith(report)
  assert.equal(w.res.status, 0, w.res.stderr)
  assert.deepEqual(w.files, ['java-service-dev.md', 'product-owner.md'])
  assert.equal(w.read('java-service-dev'), file('java-service-dev'))
  assert.deepEqual(w.res.json.personas, [{ name: 'java-service-dev', path: `${w.env.dir}/personas/java-service-dev.md` }, { name: 'product-owner', path: `${w.env.dir}/personas/product-owner.md` }])
  assert.equal(w.res.json.written, true)
  assert.ok(!Object.hasOwn(w.res.json, 'personaProblems'))
})

t('draft 2: the written directory installs with factory persona-install', () => {
  const w = writeWith(`${fenced(PLAN, '# md')}\n${block('java-service-dev', file('java-service-dev'))}`)
  const r = runCli(w.env.factory, 'persona-install', ['--from', `${w.env.dir}/personas`, '--repo', w.env.repo], w.env.repo)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.deepEqual(r.json.installed, ['java-service-dev'])
})

t('draft 3: a bad name, a missing or unterminated fence, and a file that would not install are reported and never written', () => {
  const report = [
    fenced(PLAN, '# md'),
    block('Bad_Name', file('Bad_Name')),
    'PERSONA: no-fence\nsome prose, no block\n',
    block('mismatch', file('other-name')),
    block('good-one', file('good-one')),
    'PERSONA: open-ended\n````markdown\n' + file('open-ended'),
  ].join('\n')
  const w = writeWith(report)
  assert.equal(w.res.status, 0, w.res.stderr)
  assert.deepEqual(w.files, ['good-one.md'])
  assert.deepEqual(w.res.json.personas.map((p) => p.name), ['good-one'])
  const problems = w.res.json.personaProblems
  assert.equal(problems.length, 4, JSON.stringify(problems))
  for (const [i, name] of ['Bad_Name', 'no-fence', 'mismatch', 'open-ended'].entries()) assert.ok(problems[i].includes(name), problems[i])
  assert.match(problems[0], /kebab-case/)
})

t('draft 3b (review 8): a four-backtick PERSONA block holding a fenced command block is written whole; a three-backtick one closes early and is refused', () => {
  const inner = `---\nname: java-dev\ndescription: java area\nmodel: sonnet\n---\n\nBody.\n\n## Review checklist\n\nRun:\n\n\`\`\`bash\nmvn -q verify\n\`\`\`\n\n## Standards\n\n- null-safe APIs\n`
  const ok = writeWith(`${fenced(PLAN, '# md')}\n${block('java-dev', inner, '````markdown')}`)
  assert.equal(ok.res.status, 0, ok.res.stderr)
  assert.equal(ok.read('java-dev'), inner)
  assert.ok(!Object.hasOwn(ok.res.json, 'personaProblems'))
  const bad = writeWith(`${fenced(PLAN, '# md')}\n${block('java-dev', inner, '```markdown')}`)
  assert.deepEqual(bad.files, [], 'the truncated file (no ## Standards) is not installed')
  assert.match(bad.res.json.personaProblems.join('\n'), /Standards/)
})

t('draft 3c (review 8): a persona draft without a ## Standards heading is a problem, not a draft; so is plan.js\'s view of it (no body check needed)', () => {
  const noStd = `---\nname: java-dev\ndescription: java area\nmodel: sonnet\n---\n\nBody only.\n`
  const w = writeWith(`${fenced(PLAN, '# md')}\n${block('java-dev', noStd)}`)
  assert.deepEqual(w.files, [])
  assert.match(w.res.json.personaProblems[0], /java-dev is malformed: .*## Standards/)
})

t('draft 4: a report with no PERSONA lines gives no personas field and no personas directory', () => {
  const w = writeWith(fenced(PLAN, '# md'))
  assert.equal(w.res.status, 0)
  assert.deepEqual(w.files, [])
  assert.ok(!Object.hasOwn(w.res.json, 'personas'))
})

t('draft 5: a refused plan-write (no plan block) writes no drafts', () => {
  const env = mkEnv({ useRealPlugin: true })
  const { dir } = mkRun(env.transcripts, 'wf_plan', [{ id: 'aarch', label: 'truss-designer', agentType: 'truss:design-engineer', metaModel: 'opus', result: { report: block('java-service-dev', file('java-service-dev')), planJson: 'nope', planMd: '' } }])
  const res = env.run('plan-write', { transcript: dir, label: 'truss-designer' })
  assert.equal(res.status, 1)
  assert.ok(!existsSync(`${env.dir}/personas`))
})

// ---------------------------------------------------------------- plan-args carries the personas

t('plan-args 1: truss.personas holds the project personas as factory start builds them', () => {
  const repo = mkRepo({ files: { '.claude/agents/product-owner.md': `---\nname: product-owner\ndescription: judge\ntools: Read, Grep, Glob\nmodel: opus\n---\n\nBody.\n\n## Standards\n\n- s\n`, '.claude/agents/java-dev.md': `---\nname: java-dev\ndescription: java\n---\n\nJ.\n\n## Standards\n\n- s\n` } })
  const dir = mkTrussDir()
  writeFileSync(`${dir}/decisions.md`, '- 05:10 | checker-1 WORTH worth: the goal item | followed\n')
  const brief = `${tmp('brief-')}/brief.md`
  writeFileSync(brief, 'brief\n')
  const r = runCli(`${PLUGIN}/bin/factory.ts`, 'plan-args', ['--dir', dir, '--repo', repo, '--brief-file', brief], repo, { TRUSS_SESSION_START: String(Date.now() + 3_600_000) })
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const p = r.json.truss.personas
  assert.deepEqual(Object.keys(p).sort(), ['java-dev', 'product-owner'])
  assert.equal(p['product-owner'].readOnly, true)
  assert.equal(p['product-owner'].loaded, true)
  assert.equal(p['java-dev'].readOnly, false)
})

t('plan-args 3 (review 10): plan-args carries truss.featureMap (the key or docs/features.md) only when that file exists in the repo', () => {
  const brief = `${tmp('brief-')}/brief.md`
  writeFileSync(brief, 'brief\n')
  const worthDir = () => {
    const d = mkTrussDir()
    writeFileSync(`${d}/decisions.md`, '- 05:10 | checker-1 WORTH worth: the goal item | followed\n')
    return d
  }
  const argsOf = (repo) => runCli(`${PLUGIN}/bin/factory.ts`, 'plan-args', ['--dir', worthDir(), '--repo', repo, '--brief-file', brief], repo).json.truss
  assert.ok(!Object.hasOwn(argsOf(mkRepo()), 'featureMap'))
  assert.equal(argsOf(mkRepo({ files: { 'docs/features.md': '# map\n' } })).featureMap, 'docs/features.md')
  assert.equal(argsOf(mkRepo({ config: { featureMap: 'docs/caps.md' }, files: { 'docs/caps.md': '# map\n' } })).featureMap, 'docs/caps.md')
  assert.ok(!Object.hasOwn(argsOf(mkRepo({ config: { featureMap: 'docs/caps.md' }, files: { 'docs/features.md': '# map\n' } })), 'featureMap'), 'the configured file is what counts')
})

t('plan-args 2: a repo with no .claude/agents has personas {}', () => {
  const repo = mkRepo()
  const dir = mkTrussDir()
  writeFileSync(`${dir}/decisions.md`, '- 05:10 | checker-1 WORTH worth: the goal item | followed\n')
  const brief = `${tmp('brief-')}/brief.md`
  writeFileSync(brief, 'brief\n')
  const r = runCli(`${PLUGIN}/bin/factory.ts`, 'plan-args', ['--dir', dir, '--repo', repo, '--brief-file', brief], repo)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.deepEqual(r.json.truss.personas, {})
})

// ---------------------------------------------------------------- spawn event: persona and --high

const ROOT = PLUGIN
const HOUR = 3_600_000

/** A repo that holds the plugin, a running crew s, and a finish-ready run whose builder ran at effort high (the label s-builder). */
function world(admitArgs) {
  const repo = mkRepo({ config: { merge: 'sequential', target: 'main' } })
  for (const sub of ['bin', 'hooks', 'docs', 'workflows', 'resources', 'retro', 'agents']) if (existsSync(`${ROOT}/${sub}`)) cpSync(`${ROOT}/${sub}`, `${repo}/plugins/truss/${sub}`, { recursive: true })
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'plugin'])
  const dir = mkTrussDir()
  writePlan(dir, planObj([crew('s', { owns: ['plugins/truss/**'], status: 'running' })], { approvedAt: '2026-10-01T00:00:00.000Z' }))
  appendEvent(dir, factorySpawn('s', new Date(Date.now() - 3 * HOUR).toISOString()))
  const wt = addCrewWorktree(repo, 's')
  putFile(wt, 'plugins/truss/notes.txt', 'unrelated\n', 'unrelated')
  const base = git(wt, ['merge-base', 'main', 'HEAD'])
  const hd = head(wt)
  const [diffCmd, idCmd] = reg.PATCH_COMMAND.split(' | ').map((s) => s.replace('<base>', base).replace('<head>', hd).split(' '))
  const dres = spawnSync(diffCmd[0], diffCmd.slice(1), { cwd: wt, encoding: 'utf8' })
  const patch = reg.patchIdOf(spawnSync(idCmd[0], idCmd.slice(1), { cwd: wt, input: dres.stdout, encoding: 'utf8' }).stdout)
  mkdirSync(`${dir}/checks`, { recursive: true })
  writeFileSync(`${dir}/checks/s-1.json`, JSON.stringify({ command: 'true', exit: 1, head: hd, tail: '' }))
  const factory = `${repo}/plugins/truss/bin/factory.ts`
  const adm = runCli(factory, 'admit', ['--dir', dir, '--repo', repo, '--slug', 's', '--label', 's-builder', '--title', 'build it', ...admitArgs], repo)
  assert.equal(adm.status, 0, adm.stdout + adm.stderr)
  const run = mkRun(tmp('pr-tr-'), 'wf_1', [
    { label: 's-builder', agentType: 'general-purpose', metaModel: 'sonnet', model: 'claude-sonnet-5-5', effort: 'high', result: 'built it' },
    { label: 's-qc', agentType: 'truss:qc-engineer', metaModel: 'opus', model: 'claude-opus-5-5', effort: 'medium', result: qcReport({ head: hd, patch }) },
  ])
  const resFile = `${dir}/result.json`
  writeFileSync(resFile, JSON.stringify([{ slug: 's', state: 'passed', head: hd, base, qc: 's-qc' }]))
  const fin = runCli(factory, 'finish', ['--dir', dir, '--repo', repo, '--transcript', run.dir, '--result', resFile], repo)
  return { dir, fin }
}

t('spawn 1: admit --persona x --high then finish writes persona "x" on the spawn event and no effort-high audit finding', () => {
  const w = world(['--persona', 'x', '--high'])
  assert.equal(w.fin.status, 0, w.fin.stdout + w.fin.stderr)
  assert.deepEqual(w.fin.json.audit, [])
  const spawn = readEvents(w.dir).find((e) => e.event === 'spawn' && e.agent === 's-builder')
  assert.ok(spawn, 'a spawn event for s-builder')
  assert.equal(spawn.persona, 'x')
  assert.equal(spawn.effort, 'high')
  assert.ok(!JSON.stringify(w.fin.json).includes('effort high'), JSON.stringify(w.fin.json).slice(0, 600))
})

t('spawn 2: without --persona the spawn event records persona null (and effort high without --high is an audit finding)', () => {
  const w = world([])
  const spawn = readEvents(w.dir).find((e) => e.event === 'spawn' && e.agent === 's-builder')
  assert.ok(spawn, 'a spawn event for s-builder')
  assert.equal(spawn.persona, null)
  assert.equal(w.fin.json.audit.length, 1)
  assert.ok(JSON.stringify(w.fin.json).includes('effort high'), JSON.stringify(w.fin.json).slice(0, 600))
})

// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0033, per-crew knowledge and crew-level product calls. Written from the contract before the change.
//   1. a member report carries optional learned items {kind, text, source}; missing is []
//   2. after members and the green check, before stress test and QC, one writer member records what the crew learned
//   3. the QC brief carries a Knowledge: block after Standards:
//   4. a member QUESTION goes to the crew's product-owner persona first; DECIDE re-runs the member once, ESCALATE or a second
//      question stops the crew with QUESTION as before; no read-only product-owner persona means the old behaviour
// Run with: node --test tests/crew-knowledge.check.ts

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')
const STAGE = `${PLUGIN}/workflows/stage.js`
const t = (name, fn) => test(name, { timeout: 90000 }, fn)

const ROLES = {
  designer: { agentType: 'truss:design-engineer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  checker: { agentType: 'truss:checking-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  planner: { agentType: 'truss:planning-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  tester: { agentType: 'proj:tester', model: 'sonnet', effort: 'medium', isolation: 'worktree' },
  builder: { agentType: 'proj:builder', model: 'sonnet', effort: 'low', isolation: 'worktree' },
  resolver: { agentType: 'proj:resolver', model: 'sonnet', effort: 'medium', isolation: 'none' },
  writer: { agentType: 'truss:writer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  rca: { agentType: 'general-purpose', model: 'opus', effort: 'medium', isolation: 'none' },
  stress: { agentType: 'truss:qc-engineer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  qc: { agentType: 'truss:qc-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  runner: { agentType: 'general-purpose', model: 'sonnet', effort: 'low', isolation: 'none' },
  ux: { agentType: 'truss:ux-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  po: { agentType: 'general-purpose', model: 'opus', effort: 'medium', isolation: 'none' },
}

// ---------------------------------------------------------------- stage.js harness (as tests/personas-routing.check.ts)

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const tick = () => new Promise((r) => setImmediate(r))
const ticks = async (n) => {
  for (let i = 0; i < n; i++) await tick()
}
const rj = (obj, exit = 0) => ({ exit, stdout: JSON.stringify(obj) })

async function exec(args, o = {}) {
  const body = readFileSync(STAGE, 'utf8').replace(/^\s*export\s+const\s+meta\b/m, 'const meta')
  const calls = []
  const unscripted = []
  const counters = {}
  const agent = async (prompt, opts = {}) => {
    const call = { prompt, opts, label: opts.label, i: calls.length }
    calls.push(call)
    await tick()
    if (/-runner(-\d+)?$/.test(String(opts.label))) {
      const m = prompt.match(/factory\.ts\s+(admit|reap|check|integrate|owns-check|tests-check|sync|crew-decision|decision-replies|decisions)\b([^\n]*)/)
      if (!m) {
        unscripted.push(`${opts.label} (no factory.ts command in prompt)`)
        throw new Error(`unparsable runner prompt for label ${opts.label}`)
      }
      const cmd = m[1]
      const flag = (name) => (m[2].match(new RegExp(`--${name}\\s+([^\\s\`]+)`)) || [])[1]
      const slug = flag("slug") ?? flag("crew")
      const expect = flag('expect')
      const branch = flag('branch')
      const key = cmd === 'check' ? `check:${expect}` : cmd === 'integrate' ? `integrate:${branch}` : cmd
      const name = `runner:${slug}:${key}`
      call.runner = { cmd, slug, expect, branch, key, name, rest: m[2] }
      const n = (counters[name] = (counters[name] ?? -1) + 1)
      let out = o.runner ? await o.runner({ cmd, key, slug, expect, branch, n, prompt, call }) : undefined
      if (out === undefined) {
        const plain = expect === 'red' ? { ok: true } : { ok: true, head: HEAD }
        out =
          cmd === 'admit' ? rj({ admitted: true, parallelism: 4, running: 0, freeMB: 8000, minFreeMB: 2048 }) : cmd === 'reap' ? rj({ reaped: [], skipped: [] }) : cmd === 'check' ? rj(plain) : cmd === 'integrate' ? rj({ merged: true }) : cmd === 'owns-check' ? rj({ ok: true, outside: [] }) : cmd === 'tests-check' ? rj({ ok: true, tests: [] }) : cmd === 'crew-decision' ? rj({ id: `d${n + 1}` }) : cmd === 'decision-replies' ? rj([]) : cmd === 'decisions' ? rj({ decisions: [] }) : rj({ merged: true })
      }
      await ticks(1)
      return out
    }
    const labels = o.labels ?? {}
    if (!Object.hasOwn(labels, opts.label)) {
      unscripted.push(String(opts.label))
      throw new Error(`unscripted label: ${opts.label}`)
    }
    const h = labels[opts.label]
    const v = typeof h === 'function' ? await h(call, calls) : h
    await ticks(2)
    return v === null || v === undefined ? v : structuredClone(v)
  }
  const parallel = async (thunks) => Promise.all(thunks.map(async (th) => { try { return await (typeof th === 'function' ? th() : th) } catch { return null } }))
  const pipeline = async (items, ...stages) => Promise.all(items.map(async (item, i) => { try { let prev = item; for (const st of stages) prev = await st(prev, item, i); return prev } catch { return null } }))
  let result
  let error
  try {
    result = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'allowance', body)(agent, parallel, pipeline, () => {}, () => {}, structuredClone(args), {})
  } catch (e) {
    error = e
  }
  return { result, error, calls, unscripted, labels: calls.map((c) => c.label) }
}

const HEAD = 'a1'.repeat(20)
const BASE = 'd4'.repeat(20)
const PATCH = 'e5'.repeat(20)
const PASS = `VERDICT: PASS\n\n## Proof checked\nHead: ${HEAD}\nPatch: ${PATCH}\n`
const done = (branch, extra = {}) => ({ task: 'whatever', marker: 'DONE', branch, commit: 'c0'.repeat(20), proof: 'PROOF-' + branch, text: 'finished ' + branch, ...extra })

const PERSONAS = {
  'frontend-ui-developer': { agentType: 'frontend-ui-developer', model: 'opus', effort: 'high', file: '/proj/.claude/agents/frontend-ui-developer.md', description: 'React design system and UI components', readOnly: false, loaded: true },
  'product-owner': { agentType: 'product-owner', model: 'opus', effort: 'medium', file: '/proj/.claude/agents/product-owner.md', description: 'Judges the product fit', readOnly: true, loaded: true },
}
const PO_NOT_LOADED = { ...PERSONAS['product-owner'], loaded: false, body: 'BODY-PO line one\nBODY-PO line two\n' }
const TT = { name: 'write-tests', role: 'tester', effort: 'medium', persona: null, files: ['tests/a.check.ts'], reads: [], brief: 'BRIEF-TT', after: [] }
const TF = { name: 'build-ui', role: 'builder', effort: 'low', persona: 'frontend-ui-developer', files: ['src/ui/a.ts'], reads: [], brief: 'BRIEF-TF', after: ['write-tests'] }
const TW = { name: 'write-docs', role: 'writer', effort: 'medium', persona: null, files: ['docs/a.md'], reads: [], brief: 'BRIEF-TW', after: [] }
const PLAN = (...tasks) => ({ tasks, stop: null })

const OLD = (slug = 'a', o = {}) => ({
  slug, stage: 1, goalFile: `/proj/.truss/goals/${slug}.md`, goal: 'GOAL-TEXT', owns: ['src/**', 'tests/*.ts'],
  acceptanceTest: 'node --test tests/a.check.ts', highImpact: ['src/core/**'], stressTest: false, scope: 'SCOPE-VERBATIM: build a, nothing else',
  worktree: `/wt/${slug}`, branch: `truss/${slug}`, base: BASE, architecture: '/proj/docs/ARCH.md', adrs: [],
  resume: null, tasks: [], done: [], answers: [], spent: 0, labelFrom: {}, ...o,
})
const stageArgs = (crews, o = {}) => ({
  truss: { kind: 'stage', dir: '/proj/.truss', repo: '/proj', plugin: PLUGIN, target: 'main', reworkAllowance: 2, roles: ROLES, scriptPath: STAGE, crews, ...(o.personas === undefined ? {} : { personas: o.personas }), ...(o.truss || {}) },
})
async function runStage(crews, o = {}) {
  const r = await exec(stageArgs(crews, o), o)
  if (r.error) throw r.error
  return r
}
const why = (r) => `result ${JSON.stringify(r.result).slice(0, 600)}; labels ${r.labels.join(',')}; unscripted ${r.unscripted.join(',')}`
const has = (s, sub) => assert.ok(s.includes(sub), `missing ${JSON.stringify(sub)} in:\n${s.slice(0, 3000)}`)
const hasnt = (s, sub) => assert.ok(!s.includes(sub), `unexpected ${JSON.stringify(sub)} in:\n${s.slice(0, 3000)}`)
const passed = (r, slug = 'a') => assert.equal(r.result.find((x) => x.slug === slug).state, 'passed', why(r))
const callOf = (r, label) => r.calls.find((c) => c.label === label)
const indexOf = (r, label) => r.calls.findIndex((c) => c.label === label)
const greens = (r) => r.calls.filter((c) => c.runner && c.runner.key === 'check:green')
const ITEM = { kind: 'feature', text: 'export button lives in ExportMenu', source: 'src/ui/a.ts:10' }
// the default builder reports one learned item, so the knowledge step runs; PLAIN is a crew that learned nothing
const labelsFor = (o = {}) => ({ 'a-planner': PLAN(TT, TF), 'a-tester': done('feat/t'), 'a-builder': done('feat/b', { learned: [ITEM] }), 'a-writer': done('feat/k'), 'a-qc': PASS, ...o })
const PLAIN = { 'a-builder': done('feat/b') }

// ---------------------------------------------------------------- learned items

t('knowledge 1: the member schema carries optional learned items of four kinds, each with text and source', async () => {
  const r = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor() })
  const schema = callOf(r, 'a-builder').opts.schema
  const l = schema.properties.learned
  assert.equal(l.type, 'array')
  assert.deepEqual(l.items.properties.kind.enum, ['feature', 'persona', 'product', 'decision'])
  assert.equal(l.items.properties.text.type, 'string')
  assert.equal(l.items.properties.source.type, 'string')
  assert.ok(!schema.required.includes('learned'), 'learned is optional')
})

t('knowledge 2: the member brief asks for learned items with a source, empty when nothing is new', async () => {
  const r = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor() })
  const p = callOf(r, 'a-builder').prompt
  has(p, 'learned')
  has(p, 'source')
  has(p, 'entry points')
  has(p, 'later crew')
  has(p, 'target')
})

t('knowledge 3: learned items reach the knowledge brief with member and task; a member with none, or a malformed item, adds nothing', async () => {
  const labels = labelsFor({
    'a-tester': done('feat/t', { learned: [{ kind: 'persona', text: 'tests live beside the module', source: 'tests/a.check.ts:1' }] }),
    'a-builder': done('feat/b', { learned: [{ kind: 'feature', text: 'export button moved to ExportMenu', source: 'src/ui/a.ts:10' }, { kind: 'nonsense', text: 'dropped', source: 'x' }, 'junk'] }),
  })
  const r = await runStage([OLD()], { personas: PERSONAS, labels })
  passed(r)
  const p = callOf(r, 'a-writer').prompt
  has(p, 'export button moved to ExportMenu')
  has(p, 'src/ui/a.ts:10')
  has(p, 'tests live beside the module')
  has(p, 'build-ui')
  has(p, 'write-tests')
  has(p, '[feature]')
  has(p, '[persona]')
  hasnt(p, 'dropped')
})

t('knowledge 4: the step is skipped silently when no member reported an item and no product call was made: no writer, no second green', async () => {
  const r = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor(PLAIN) })
  passed(r)
  assert.ok(!r.labels.includes('a-writer'), r.labels.join(','))
  assert.ok(!r.calls.some((c) => c.prompt.startsWith('Knowledge: crew')))
  assert.equal(greens(r).length, 1)
})

t('knowledge 4b: the writer brief lists an item target, says to stay terse and merge, and allows recording nothing', async () => {
  const labels = labelsFor({ 'a-builder': done('feat/b', { learned: [{ ...ITEM, target: 'docs/knowledge/export.md' }, { kind: 'decision', text: 'queue exports', source: 'src/q.ts:3' }] }) })
  const r = await runStage([OLD()], { personas: PERSONAS, labels })
  const p = callOf(r, 'a-writer').prompt
  has(p, 'target: docs/knowledge/export.md')
  assert.ok(!/queue exports[^\n]*target:/.test(p), 'an item with no target lists none')
  has(p, 'terse')
  has(p, 'rather than appending')
  has(p, 'Recording nothing')
  hasnt(p, 'nothing new')
})

// ---------------------------------------------------------------- the knowledge step

t('knowledge 5: the knowledge writer runs after members and the green check, before QC; its brief opens Knowledge: crew and carries every path', async () => {
  const r = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor() })
  passed(r)
  const w = callOf(r, 'a-writer')
  assert.ok(w.prompt.startsWith('Knowledge: crew a\n'), w.prompt.slice(0, 80))
  assert.equal(w.opts.agentType, 'truss:writer')
  assert.equal(w.opts.isolation, 'worktree')
  has(w.prompt, 'docs/features.md')
  has(w.prompt, 'docs/adr')
  has(w.prompt, `${BASE}...`)
  has(w.prompt, '.claude/agents/frontend-ui-developer.md')
  has(w.prompt, '.claude/agents/product-owner.md')
  has(w.prompt, 'docs(knowledge): a learned')
  const green = r.calls.findIndex((c) => c.runner && c.runner.key === 'check:green')
  assert.ok(green >= 0 && green < indexOf(r, 'a-writer'), 'writer after the first green check')
  assert.ok(indexOf(r, 'a-writer') < indexOf(r, 'a-qc'), 'writer before QC')
  const title = r.calls.find((c) => c.runner && c.runner.cmd === 'admit' && c.runner.rest.includes('a-writer'))
  assert.ok(title && title.prompt.includes('Record what a learned'), 'admit records the title')
})

t('knowledge 6: the knowledge writer comes before the stress test', async () => {
  const labels = labelsFor({ 'a-stress': 'STRESSTEST: 0 findings\n' })
  const r = await runStage([OLD('a', { stressTest: true })], { personas: PERSONAS, labels })
  passed(r)
  assert.ok(indexOf(r, 'a-writer') < indexOf(r, 'a-stress'), r.labels.join(','))
})

t('knowledge 7: args.truss.featureMap and adrDir override the default paths', async () => {
  const r = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor(), truss: { featureMap: 'docs/capabilities.md', adrDir: 'decisions' } })
  const p = callOf(r, 'a-writer').prompt
  has(p, 'docs/capabilities.md')
  has(p, 'decisions')
  hasnt(p, 'docs/features.md')
  has(callOf(r, 'a-qc').prompt, 'docs/capabilities.md')
})

t('knowledge 8: a crew with no personas still gets the step, without persona or product-owner files', async () => {
  const labels = labelsFor({ 'a-planner': PLAN(TT, { ...TF, persona: null }) })
  const r = await runStage([OLD()], { labels })
  passed(r)
  const p = callOf(r, 'a-writer').prompt
  has(p, 'Knowledge: crew a')
  has(p, 'Persona files the crew used: none')
  has(p, 'Product-owner file: none')
})

t('knowledge 9: a crew whose tasks are all writer tasks skips the step and gets no Knowledge block in QC', async () => {
  const labels = { 'a-planner': PLAN(TW), 'a-writer': done('feat/w', { learned: [ITEM] }), 'a-qc': PASS }
  const r = await runStage([OLD('a', { owns: ['docs/**'] })], { personas: PERSONAS, labels })
  passed(r)
  assert.ok(!r.calls.some((c) => c.prompt.startsWith('Knowledge: crew')), 'no knowledge brief')
  assert.ok(!r.labels.includes('a-writer-2'))
  hasnt(callOf(r, 'a-qc').prompt, 'Knowledge:')
})

t('knowledge 10: the knowledge commit is merged and green runs again on it', async () => {
  const some = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor() })
  passed(some)
  assert.equal(greens(some).length, 2, 'green again on the knowledge commit')
  assert.ok(some.calls.some((c) => c.runner && c.runner.key === 'integrate:feat/k'))
  assert.ok(indexOf(some, 'a-writer') < some.calls.findIndex((c, i) => i > indexOf(some, 'a-writer') && c.runner && c.runner.key === 'check:green'))
})

t('knowledge 11: a knowledge writer that ends BLOCKED stops the crew', async () => {
  const r = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor({ 'a-writer': done('feat/k', { marker: 'BLOCKED', text: 'no feature map' }) }) })
  const s = r.result.find((x) => x.slug === 'a')
  assert.equal(s.state, 'stopped')
  assert.equal(s.tag, 'BLOCKED')
  assert.equal(s.at, 'knowledge')
})

t('knowledge 12: the scope check is factory owns-check alone: stage.js exempts nothing, so a knowledge-step file it reports stops the crew', async () => {
  // factory owns-check exempts the knowledge commit's doc files itself (tests/knowledge-scope.check.ts); whatever it still lists is outside
  const bad = (out) => ({ cmd }) => (cmd === 'owns-check' ? rj({ ok: false, outside: out }, 2) : undefined)
  for (const out of [['docs/features.md'], ['docs/features.md', 'src/other.ts'], ['src/other.ts']]) {
    const r = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor(), runner: bad(out) })
    const s = r.result.find((x) => x.slug === 'a')
    assert.equal(s.state, 'stopped', out.join(','))
    assert.equal(s.at, 'scope')
    for (const f of out) has(s.text, f)
  }
})

t('knowledge 12b: the brief tells the writer to skip a learned item whose target is not a markdown file and to list it in its report', async () => {
  const labels = labelsFor({ 'a-builder': done('feat/b', { learned: [{ ...ITEM, target: 'docs/knowledge/export.md' }, { kind: 'decision', text: 'queue exports', source: 'src/q.ts:3', target: 'src/q.ts' }] }) })
  const r = await runStage([OLD()], { personas: PERSONAS, labels })
  const p = callOf(r, 'a-writer').prompt
  has(p, 'target: docs/knowledge/export.md')
  assert.ok(/queue exports[^\n]*target: src\/q\.ts \(not markdown: skip it and list it in your report\)/.test(p), p)
  assert.ok(!/export button[^\n]*not markdown/.test(p), 'a markdown target is not flagged')
  has(p, 'Only a markdown file (*.md) is a target')
  hasnt(p, 'whatever it is')
})

// ---------------------------------------------------------------- new or moved source files start the step

const CHANGES = [{ status: 'A', path: 'src/export/menu.ts' }, { status: 'R', path: 'src/ui/b.ts', from: 'src/old/b.ts' }, { status: 'D', path: 'src/legacy.py' }]
const greenWith = (sourceChanges) => ({ cmd, expect }) => (cmd === 'check' && expect === 'green' ? rj({ ok: true, head: HEAD, sourceChanges }) : undefined)

t('knowledge 15: with no learned item, source files the diff added, renamed or deleted start the step; the brief lists them and asks for feature-map entries', async () => {
  const r = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor(PLAIN), runner: greenWith(CHANGES) })
  passed(r)
  const p = callOf(r, 'a-writer').prompt
  assert.ok(p.startsWith('Knowledge: crew a\n'))
  has(p, 'Learned items: none reported')
  has(p, 'Source files the diff added, renamed or deleted')
  has(p, 'added src/export/menu.ts')
  has(p, 'renamed src/old/b.ts -> src/ui/b.ts')
  has(p, 'deleted src/legacy.py')
  has(p, 'feature-map entry')
  assert.equal(greens(r).length, 2, 'green again on the knowledge commit')
  assert.deepEqual(r.result.find((x) => x.slug === 'a').knowledge, { items: 0, ran: true, sourceChanges: 3 })
})

t('knowledge 16: no source change and no learned item: the step is skipped; a malformed sourceChanges entry counts for nothing', async () => {
  for (const sc of [undefined, [], 'junk', [{ status: 'M', path: 'src/a.ts' }, { status: 'A' }, null, 5]]) {
    const r = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor(PLAIN), runner: greenWith(sc) })
    passed(r)
    assert.ok(!r.labels.includes('a-writer'), JSON.stringify(sc))
    assert.deepEqual(r.result.find((x) => x.slug === 'a').knowledge, { items: 0, ran: false, sourceChanges: 0 })
  }
})

t('knowledge 17: a crew of only writer tasks skips the step even when source files changed', async () => {
  const labels = { 'a-planner': PLAN(TW), 'a-writer': done('feat/w'), 'a-qc': PASS }
  const r = await runStage([OLD('a', { owns: ['docs/**'] })], { personas: PERSONAS, labels, runner: greenWith(CHANGES) })
  passed(r)
  assert.ok(!r.calls.some((c) => c.prompt.startsWith('Knowledge: crew')))
})

t('knowledge 18: the crew result records how many learned items members reported and whether the step ran, on a passed and a stopped crew', async () => {
  const r = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor({ 'a-builder': done('feat/b', { learned: [ITEM, { ...ITEM, text: 'second' }] }) }) })
  assert.deepEqual(r.result.find((x) => x.slug === 'a').knowledge, { items: 2, ran: true, sourceChanges: 0 })
  const none = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor(PLAIN) })
  assert.deepEqual(none.result.find((x) => x.slug === 'a').knowledge, { items: 0, ran: false, sourceChanges: 0 })
  // a product call's item is not a member's learned item
  const asked = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor({ 'a-builder': ASK, 'a-builder-2': done('feat/b2'), 'a-po': 'PO: DECIDE\nInclude archived items.\nReason: r' }) })
  assert.deepEqual(asked.result.find((x) => x.slug === 'a').knowledge, { items: 0, ran: true, sourceChanges: 0 })
  // stopped before the step with nothing learned: it never reached the step, so it is no skip and carries no field; one that had learned something does
  const early = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor({ 'a-builder': done('feat/b', { marker: 'BLOCKED', text: 'no' }) }) })
  assert.ok(!Object.hasOwn(early.result.find((x) => x.slug === 'a'), 'knowledge'))
  const stopped = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor(), runner: ({ cmd }) => (cmd === 'owns-check' ? rj({ ok: false, outside: ['x.ts'] }, 2) : undefined) })
  const s = stopped.result.find((x) => x.slug === 'a')
  assert.equal(s.state, 'stopped')
  assert.deepEqual(s.knowledge, { items: 1, ran: true, sourceChanges: 0 })
})

// ---------------------------------------------------------------- QC brief

t('knowledge 13: the QC brief carries a Knowledge: block after Standards:, with the feature map and the rule', async () => {
  const r = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor() })
  const p = callOf(r, 'a-qc').prompt
  has(p, 'Knowledge:')
  has(p, 'docs/features.md')
  has(p, 'If the diff adds or moves user-facing functionality, the feature map must be updated in this diff, and every product call this crew made must appear in the product-owner file; otherwise FAIL, quoting the missing entry.')
  assert.ok(p.indexOf('Standards:') >= 0 && p.indexOf('Standards:') < p.indexOf('Knowledge:'), 'Knowledge after Standards')
})

t('knowledge 14: a crew with no personas also gets the Knowledge block in QC', async () => {
  const r = await runStage([OLD()], { labels: labelsFor({ 'a-planner': PLAN(TT, { ...TF, persona: null }), ...PLAIN }) })
  const p = callOf(r, 'a-qc').prompt
  has(p, 'Knowledge:')
  has(p, 'Never FAIL for missing optional learning')
  has(p, 'Product-owner file: none')
})

// ---------------------------------------------------------------- product calls

const ASK = done('feat/b', { marker: 'QUESTION', text: 'Should the export include archived items?' })
const decideLines = (r) => r.calls.filter((c) => c.runner && c.runner.cmd === 'crew-decision')
const replyPolls = (r) => r.calls.filter((c) => c.runner && c.runner.cmd === 'decision-replies')

t('product 1: a member QUESTION goes to the product-owner persona; DECIDE re-runs the member with the answer, logs it and feeds the knowledge step', async () => {
  const labels = labelsFor({ 'a-builder': ASK, 'a-builder-2': done('feat/b2'), 'a-po': 'PO: DECIDE\nInclude archived items, flagged.\nReason: the requirements say export is complete.' })
  const r = await runStage([OLD()], { personas: PERSONAS, labels })
  passed(r)
  const po = callOf(r, 'a-po')
  assert.ok(po.prompt.startsWith('Product call: crew a\n'), po.prompt.slice(0, 60))
  has(po.prompt, 'Should the export include archived items?')
  has(po.prompt, '/proj/.truss/goals/a.md')
  has(po.prompt, 'SCOPE-VERBATIM: build a, nothing else')
  has(po.prompt, 'src/**')
  has(po.prompt, '/proj/.claude/agents/product-owner.md')
  has(po.prompt, 'PO: DECIDE')
  has(po.prompt, 'PO: ESCALATE')
  assert.equal(po.opts.agentType, 'product-owner')
  assert.equal(po.opts.model, 'opus')
  assert.equal(po.opts.effort, 'medium')
  assert.ok(!po.opts.isolation, 'no worktree isolation')
  const again = callOf(r, 'a-builder-2').prompt
  has(again, 'Include archived items, flagged.')
  has(again, 'Task: build-ui')
  const d = decideLines(r)
  assert.equal(d.length, 1, 'one crew-decision call')
  has(d[0].prompt, '--crew a')
  has(d[0].prompt, '--task build-ui')
  has(d[0].prompt, "--question 'Should the export include archived items?'")
  has(d[0].prompt, '--answer')
  has(d[0].prompt, 'Include archived items, flagged.')
  has(d[0].prompt, '--by product-owner')
  hasnt(d[0].prompt, ' decide ')
  assert.deepEqual(r.result.find((x) => x.slug === 'a').decisions.map((x) => [x.id, x.reply]), [['d1', 'accepted']], 'no reply by the end counts as accepted')
  has(r.result.find((x) => x.slug === 'a').decisions[0].note, 'counts as accepted')
  const admit = r.calls.find((c) => c.runner && c.runner.cmd === 'admit' && c.runner.rest.includes('a-po'))
  assert.ok(admit && admit.prompt.includes('--persona product-owner'), 'admit records the persona')
  const k = callOf(r, 'a-writer').prompt
  has(k, '[product]')
  has(k, 'Should the export include archived items?')
  has(k, 'Include archived items, flagged.')
})

t('product 2: a persona that is not loaded runs the product call as general-purpose with its body inlined', async () => {
  const labels = labelsFor({ 'a-builder': ASK, 'a-builder-2': done('feat/b2'), 'a-po': 'PO: DECIDE\nyes\nReason: r' })
  const r = await runStage([OLD()], { personas: { ...PERSONAS, 'product-owner': PO_NOT_LOADED }, labels })
  passed(r)
  const po = callOf(r, 'a-po')
  assert.equal(po.opts.agentType, 'general-purpose')
  has(po.prompt, 'BODY-PO line one')
  has(po.prompt, 'Product call: crew a')
})

t('product 2b: an inlined read-only persona runs as its inlineType, whatever value it has; without one it falls back to general-purpose', async () => {
  const labels = labelsFor({ 'a-builder': ASK, 'a-builder-2': done('feat/b2'), 'a-po': 'PO: DECIDE\nyes\nReason: r' })
  for (const inlineType of ['truss:readonly-judge', 'other:viewer']) {
    const r = await runStage([OLD()], { personas: { ...PERSONAS, 'product-owner': { ...PO_NOT_LOADED, inlineType } }, labels })
    passed(r)
    assert.equal(callOf(r, 'a-po').opts.agentType, inlineType)
    has(callOf(r, 'a-po').prompt, 'BODY-PO line one')
  }
  // a loaded persona keeps its own type even when it carries an inlineType
  const loaded = await runStage([OLD()], { personas: { ...PERSONAS, 'product-owner': { ...PERSONAS['product-owner'], inlineType: 'truss:readonly-judge' } }, labels })
  assert.equal(callOf(loaded, 'a-po').opts.agentType, 'product-owner')
})

t('product 3: ESCALATE stops the crew with the member QUESTION and the product owner reason; the member is not re-run', async () => {
  const labels = labelsFor({ 'a-builder': ASK, 'a-po': 'PO: ESCALATE\nThis is a billing-model question, another crew\'s area.' })
  const r = await runStage([OLD()], { personas: PERSONAS, labels })
  const s = r.result.find((x) => x.slug === 'a')
  assert.equal(s.state, 'stopped')
  assert.equal(s.tag, 'QUESTION')
  has(s.text, 'Should the export include archived items?')
  has(s.text, "another crew's area")
  assert.ok(!r.labels.includes('a-builder-2'))
  assert.equal(decideLines(r).length, 0, 'nothing logged')
})

t('product 4: a second QUESTION from the same task after a DECIDE goes to the PM without a second product call', async () => {
  const labels = labelsFor({ 'a-builder': ASK, 'a-builder-2': { ...ASK, text: 'And what about deleted items?' }, 'a-po': 'PO: DECIDE\nyes\nReason: r' })
  const r = await runStage([OLD()], { personas: PERSONAS, labels })
  const s = r.result.find((x) => x.slug === 'a')
  assert.equal(s.state, 'stopped')
  assert.equal(s.tag, 'QUESTION')
  has(s.text, 'And what about deleted items?')
  assert.equal(r.labels.filter((l) => l === 'a-po').length, 1)
  assert.ok(!r.labels.includes('a-po-2'))
})

t('product 5: the second product call of a crew sees the earlier ones', async () => {
  const two = { ...TF, name: 'build-more', files: ['src/ui/b.ts'], after: ['write-tests', 'build-ui'] }
  const labels = labelsFor({
    'a-planner': PLAN(TT, TF, two),
    'a-builder': ASK,
    'a-builder-2': done('feat/b2'),
    'a-builder-3': { ...ASK, text: 'Which date format?' },
    'a-builder-4': done('feat/b4'),
    'a-po': 'PO: DECIDE\nyes\nReason: r',
    'a-po-2': 'PO: DECIDE\nISO\nReason: r',
  })
  const r = await runStage([OLD()], { personas: PERSONAS, labels })
  // build-more runs after build-ui, so its call sees build-ui's
  const second = callOf(r, 'a-po-2')
  assert.ok(second, why(r))
  has(second.prompt, 'Product calls of this run so far')
  has(second.prompt, 'Should the export include archived items?')
})

t("product 5b: the brief carries every crew's decisions from factory decisions, and the rule to follow or escalate on them", async () => {
  const other = JSON.stringify({ decisions: [{ id: 'x7', crew: 'b', task: 'build-api', question: 'Do exports include archived items?', answer: 'No, archived items are excluded', reply: 'ack' }] })
  const runner = ({ cmd }) => (cmd === 'decisions' ? { exit: 0, stdout: other } : undefined)
  const labels = labelsFor({ 'a-builder': ASK, 'a-builder-2': done('feat/b2'), 'a-po': 'PO: ESCALATE\ncontradicts crew b' })
  const r = await runStage([OLD()], { personas: PERSONAS, labels, runner })
  const p = callOf(r, 'a-po').prompt
  has(p, 'No, archived items are excluded')
  has(p, '"crew":"b"')
  has(p, '"reply":"ack"')
  has(p, 'Follow an earlier call, from any crew, that settles the question')
  has(p, 'contradict an earlier call from another crew')
  assert.ok(r.calls.some((c) => c.runner && c.runner.cmd === 'decisions'))
})

t('product 6: an unparseable product owner reply is an ESCALATE', async () => {
  const labels = labelsFor({ 'a-builder': ASK, 'a-po': 'hmm, not sure' })
  const r = await runStage([OLD()], { personas: PERSONAS, labels })
  const s = r.result.find((x) => x.slug === 'a')
  assert.equal(s.tag, 'QUESTION')
  has(s.text, 'Should the export include archived items?')
})

t('product 7: no product-owner persona, or one that is not read-only, keeps the old behaviour: the QUESTION stops the crew, no product call', async () => {
  for (const personas of [{ 'frontend-ui-developer': PERSONAS['frontend-ui-developer'] }, { ...PERSONAS, 'product-owner': { ...PERSONAS['product-owner'], readOnly: false } }, undefined]) {
    const r = await runStage([OLD()], { personas, labels: labelsFor({ 'a-builder': ASK, 'a-planner': PLAN(TT, personas ? TF : { ...TF, persona: null }) }) })
    const s = r.result.find((x) => x.slug === 'a')
    assert.equal(s.state, 'stopped')
    assert.equal(s.tag, 'QUESTION')
    assert.equal(s.text, 'Should the export include archived items?')
    assert.ok(!r.labels.includes('a-po'))
    assert.equal(decideLines(r).length, 0)
  }
})

t('product 8: a failed crew-decision does not stop the crew', async () => {
  const labels = labelsFor({ 'a-builder': ASK, 'a-builder-2': done('feat/b2'), 'a-po': 'PO: DECIDE\nyes\nReason: r' })
  const runner = ({ cmd }) => (cmd === 'crew-decision' ? rj({ error: 'no' }, 2) : undefined)
  const r = await runStage([OLD()], { personas: PERSONAS, labels, runner })
  passed(r)
})

t('product 9: pipes and newlines in a question or answer cannot break the one-line decision', async () => {
  const labels = labelsFor({ 'a-builder': { ...ASK, text: 'A | B?\nsecond line' }, 'a-builder-2': done('feat/b2'), 'a-po': 'PO: DECIDE\nuse A | not B\nReason: r' })
  const r = await runStage([OLD()], { personas: PERSONAS, labels })
  passed(r)
  const p = decideLines(r)[0].prompt
  assert.ok(!/--question [^\n]*\|/.test(p) && !/--answer [^\n]*\|/.test(p), p)
  has(p, 'A / B? second line')
})

// ---------------------------------------------------------------- main-session replies to product calls

const DECIDING = (o = {}) => labelsFor({ 'a-builder': ASK, 'a-builder-2': done('feat/b2', { learned: [ITEM] }), 'a-po': 'PO: DECIDE\nInclude archived items.\nReason: r', ...o })
const replying = (...byN) => ({ cmd, n }) => (cmd === 'decision-replies' && byN[n] ? rj(byN[n]) : undefined)

t('replies 1: a crew that made no product call never reads replies', async () => {
  const r = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor() })
  passed(r)
  assert.equal(replyPolls(r).length, 0)
  assert.equal(r.result.find((x) => x.slug === 'a').decisions, undefined)
})

t('replies 2: replies are read before each member spawn, before the knowledge step and before QC, and never waited for', async () => {
  const r = await runStage([OLD()], { personas: PERSONAS, labels: DECIDING() })
  passed(r)
  // before the re-run member a-builder-2, before the knowledge writer (a-writer), before QC (a-qc)
  const at = (label) => r.calls.findIndex((c) => c.label === label)
  const polls = replyPolls(r).map((c) => c.i)
  // polls: before the re-run member, at the checkpoint before the knowledge step, before the knowledge writer's own spawn, before QC
  assert.equal(polls.length, 4, `polls ${polls}`)
  assert.ok(polls[0] < at('a-builder-2') && polls[0] > at('a-po'), 'before the re-run')
  assert.ok(polls[1] < at('a-writer') && polls[1] > at('a-builder-2'), 'before the knowledge step')
  assert.ok(polls[2] < at('a-writer') && polls[2] > polls[1], 'before the knowledge writer spawn')
  assert.ok(polls[3] < at('a-qc') && polls[3] > at('a-writer'), 'before QC')
  assert.ok(at('a-builder-2') > at('a-po') && decideLines(r)[0].i < at('a-builder-2'), 'the re-run does not wait on a reply')
})

t('replies 3: an ack is recorded in the crew result and changes nothing else', async () => {
  const runner = replying(undefined, [{ id: 'd1', reply: 'ack', note: '' }])
  const r = await runStage([OLD()], { personas: PERSONAS, labels: DECIDING(), runner })
  passed(r)
  assert.ok(!r.labels.includes('a-builder-3'))
  const d = r.result.find((x) => x.slug === 'a').decisions
  assert.deepEqual(d.map((x) => [x.id, x.reply, x.answer]), [['d1', 'ack', 'Include archived items.']])
})

t('replies 4: a change re-runs the asking member with the main session note, checks green again, and corrects the learned item', async () => {
  const runner = replying([], [{ id: 'd1', reply: 'change', note: 'Exclude archived items.' }])
  const labels = DECIDING({ 'a-builder-3': done('feat/b3') })
  const r = await runStage([OLD()], { personas: PERSONAS, labels, runner })
  passed(r)
  const again = callOf(r, 'a-builder-3')
  assert.ok(again, why(r))
  has(again.prompt, 'Main session changed product call d1: Exclude archived items.')
  has(again.prompt, 'Task: build-ui')
  assert.ok(r.calls.some((c) => c.runner && c.runner.key === 'integrate:feat/b3'), 'the re-run is merged')
  assert.ok(greens(r).length >= 2)
  const k = callOf(r, 'a-writer').prompt
  has(k, 'Exclude archived items.')
  has(k, 'overruled by main session')
  hasnt(k, 'Include archived items.')
  const d = r.result.find((x) => x.slug === 'a').decisions
  assert.deepEqual(d.map((x) => [x.id, x.reply, x.answer]), [['d1', 'change', 'Exclude archived items.']])
  assert.ok(callOf(r, 'a-qc').prompt.includes('overruled by main session'))
})

t('replies 5: a change that arrives before QC re-runs the member, the green check and the knowledge step', async () => {
  const runner = replying([], [], [], [{ id: 'd1', reply: 'change', note: 'Exclude archived items.' }])
  const labels = DECIDING({ 'a-builder-3': done('feat/b3'), 'a-writer-2': done('feat/k2') })
  const r = await runStage([OLD()], { personas: PERSONAS, labels, runner })
  passed(r)
  assert.ok(indexOf(r, 'a-builder-3') > indexOf(r, 'a-writer'), 'the re-run follows the first knowledge step')
  assert.ok(indexOf(r, 'a-writer-2') > indexOf(r, 'a-builder-3') && indexOf(r, 'a-writer-2') < indexOf(r, 'a-qc'))
  has(callOf(r, 'a-writer-2').prompt, 'overruled by main session')
})

t('replies 6: a reply for an id the crew does not know is ignored', async () => {
  const runner = replying([{ id: 'zzz', reply: 'change', note: 'x' }])
  const r = await runStage([OLD()], { personas: PERSONAS, labels: DECIDING(), runner })
  passed(r)
  assert.ok(!r.labels.includes('a-builder-3'))
})

t('replies 7: a stopped crew still reports its decisions', async () => {
  const labels = DECIDING({ 'a-builder-2': { ...ASK, text: 'And deleted items?' } })
  const r = await runStage([OLD()], { personas: PERSONAS, labels })
  const s = r.result.find((x) => x.slug === 'a')
  assert.equal(s.state, 'stopped')
  assert.equal(s.decisions.length, 1)
})

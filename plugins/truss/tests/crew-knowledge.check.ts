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
      const m = prompt.match(/factory\.ts\s+(admit|reap|check|integrate|owns-check|tests-check|sync|crew-decision|decision-replies|decision-ack|decision-checkpoint|crew-learned|knowledge-commit|decisions)\b([^\n]*)/)
      if (!m) {
        unscripted.push(`${opts.label} (no factory.ts command in prompt)`)
        throw new Error(`unparsable runner prompt for label ${opts.label}`)
      }
      const cmd = m[1]
      const flag = (name) => (m[2].match(new RegExp(`--${name}(?:\\s+|=)([^\\s\`]+)`)) || [])[1]
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
          cmd === 'admit' ? rj({ admitted: true, parallelism: 4, running: 0, freeMB: 8000, minFreeMB: 2048 }) : cmd === 'reap' ? rj({ reaped: [], skipped: [] }) : cmd === 'check' ? rj(plain) : cmd === 'integrate' ? rj({ merged: true }) : cmd === 'owns-check' ? rj({ ok: true, outside: [] }) : cmd === 'tests-check' ? rj({ ok: true, tests: [] }) : cmd === 'crew-decision' ? rj({ id: `d${n + 1}` }) : cmd === 'decision-replies' ? rj([]) : cmd === 'decision-ack' ? rj({ acked: [], already: [] }) : cmd === 'decision-checkpoint' || cmd === 'crew-learned' || cmd === 'knowledge-commit' ? rj({ ok: true }) : cmd === 'decisions' ? rj({ decisions: [] }) : rj({ merged: true })
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
  has(d[0].prompt, "--question='Should the export include archived items?'")
  has(d[0].prompt, '--answer=')
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

t('product 2: a persona that is not loaded runs the product call as truss:judge (never general-purpose) with its body inlined', async () => {
  const labels = labelsFor({ 'a-builder': ASK, 'a-builder-2': done('feat/b2'), 'a-po': 'PO: DECIDE\nyes\nReason: r' })
  const r = await runStage([OLD()], { personas: { ...PERSONAS, 'product-owner': PO_NOT_LOADED }, labels })
  passed(r)
  const po = callOf(r, 'a-po')
  assert.equal(po.opts.agentType, 'truss:judge')
  assert.notEqual(po.opts.agentType, 'general-purpose')
  has(po.prompt, 'BODY-PO line one')
  has(po.prompt, 'Product call: crew a')
})

t('product 2b: an inlined read-only persona runs as its inlineType, whatever value it has; without one it falls back to truss:judge', async () => {
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
  assert.ok(!/--question=[^\n]*\|/.test(p) && !/--answer=[^\n]*\|/.test(p), p)
  has(p, 'A / B? second line')
})

// ---------------------------------------------------------------- main-session replies: one checkpoint (contract fix round 2)

const DECIDING = (o = {}) => labelsFor({ 'a-builder': ASK, 'a-builder-2': done('feat/b2', { learned: [ITEM] }), 'a-po': 'PO: DECIDE\nInclude archived items.\nReason: r', ...o })
// byN[n]: what the n-th decision-replies call prints (an array, or a string for a garbled result); a missing one prints []
const replying = (...byN) => ({ cmd, n }) => (cmd === 'decision-replies' && byN[n] !== undefined ? (typeof byN[n] === 'string' ? { exit: 0, stdout: byN[n] } : rj(byN[n])) : undefined)
const cmdsOf = (r, cmd) => r.calls.filter((c) => c.runner && c.runner.cmd === cmd)
const integrateAt = (r, branch) => r.calls.findIndex((c) => c.runner && c.runner.key === `integrate:${branch}`)
const CHANGE = { id: 'd1', reply: 'change', note: 'Exclude archived items.' }

t('replies 1: a crew that made no product call never reads replies, and still records that it passed the checkpoint', async () => {
  const r = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor() })
  passed(r)
  assert.equal(replyPolls(r).length, 0)
  assert.equal(cmdsOf(r, 'decision-ack').length, 0)
  const cp = cmdsOf(r, 'decision-checkpoint')
  assert.equal(cp.length, 1)
  has(cp[0].prompt, '--crew a')
  assert.ok(cp[0].i > greens(r)[0].i && cp[0].i < indexOf(r, 'a-writer'), 'after the first green, before the knowledge step')
  assert.equal(r.result.find((x) => x.slug === 'a').decisions, undefined)
  assert.equal(r.result.find((x) => x.slug === 'a').late, undefined)
})

t('replies 2: replies are read once, at the checkpoint after the first green and before the knowledge step; then once more after QC for late replies', async () => {
  const r = await runStage([OLD()], { personas: PERSONAS, labels: DECIDING() })
  passed(r)
  const at = (label) => indexOf(r, label)
  const polls = replyPolls(r).map((c) => c.i)
  // not before the re-run member (a-builder-2), not before the knowledge writer's spawn, not before QC
  assert.equal(polls.length, 2, `polls ${polls}`)
  assert.ok(polls[0] > greens(r)[0].i && polls[0] > at('a-builder-2'), 'the checkpoint follows the first green')
  assert.ok(polls[0] < at('a-writer'), 'before the knowledge step')
  assert.ok(polls[1] > at('a-qc'), 'the late read follows QC')
  const cp = cmdsOf(r, 'decision-checkpoint')
  assert.equal(cp.length, 1)
  assert.ok(cp[0].i > polls[0] && cp[0].i < at('a-writer'), 'checkpoint recorded right after the read, before the knowledge step')
  assert.ok(decideLines(r)[0].i < at('a-builder-2'), 'the re-run does not wait on a reply')
})

t('replies 3: an ack is recorded, acked only after it is applied, and changes nothing else', async () => {
  const runner = replying([{ id: 'd1', reply: 'ack', note: '' }])
  const r = await runStage([OLD()], { personas: PERSONAS, labels: DECIDING(), runner })
  passed(r)
  assert.ok(!r.labels.includes('a-builder-3'))
  const d = r.result.find((x) => x.slug === 'a').decisions
  assert.deepEqual(d.map((x) => [x.id, x.reply, x.answer]), [['d1', 'ack', 'Include archived items.']])
  const ack = cmdsOf(r, 'decision-ack')
  assert.equal(ack.length, 1)
  has(ack[0].prompt, '--crew a')
  has(ack[0].prompt, '--ids d1')
  const cp = cmdsOf(r, 'decision-checkpoint')[0]
  assert.ok(ack[0].i > replyPolls(r)[0].i && cp.i > ack[0].i, 'read, then ack, then checkpoint')
})

t('replies 4: a change re-runs the asking task as a fix member, integrates it, then acks, checkpoints, runs green again and corrects the learned item', async () => {
  const runner = replying([CHANGE])
  const labels = DECIDING({ 'a-builder-3': done('feat/b3') })
  const r = await runStage([OLD()], { personas: PERSONAS, labels, runner })
  passed(r)
  const again = callOf(r, 'a-builder-3')
  assert.ok(again, why(r))
  has(again.prompt, 'Main session changed product call d1: Exclude archived items.')
  has(again.prompt, 'Task: build-ui')
  const merged = integrateAt(r, 'feat/b3')
  assert.ok(merged > again.i, 'the re-run is merged')
  const ack = cmdsOf(r, 'decision-ack')
  assert.equal(ack.length, 1)
  has(ack[0].prompt, '--ids d1')
  assert.ok(ack[0].i > merged, 'acked only after the change is applied and integrated')
  assert.ok(cmdsOf(r, 'decision-checkpoint')[0].i > ack[0].i)
  const green2 = greens(r).find((g) => g.i > merged)
  assert.ok(green2 && green2.i < indexOf(r, 'a-writer'), 'green again on the change, before the knowledge step')
  const k = callOf(r, 'a-writer').prompt
  has(k, 'Exclude archived items.')
  has(k, 'overruled by main session')
  hasnt(k, 'Include archived items.')
  const d = r.result.find((x) => x.slug === 'a').decisions
  assert.deepEqual(d.map((x) => [x.id, x.reply, x.answer]), [['d1', 'change', 'Exclude archived items.']])
  assert.ok(callOf(r, 'a-qc').prompt.includes('overruled by main session'))
  assert.equal(replyPolls(r).length, 2, 'no read before QC, none for the re-run')
})

t('replies 5: parallel tasks: a change is not applied before the asking task and its sibling are both integrated', async () => {
  const TA = { ...TF, persona: null, after: [] }
  const TB = { name: 'build-api', role: 'builder', effort: 'low', persona: null, files: ['src/api/a.ts'], reads: [], brief: 'BRIEF-API', after: [] }
  // two builders run at once; which label each gets does not matter: the reply decides by task. The sibling is slow.
  const byTask = async (call) => {
    if (call.prompt.includes('Task: build-api')) {
      await ticks(40)
      return done('feat/s')
    }
    if (call.prompt.includes('Main session changed product call')) return done('feat/b3')
    return call.prompt.includes('The product owner answered') ? done('feat/b2', { learned: [ITEM] }) : ASK
  }
  // the reply is available from the start, as a main session that answered at once
  const runner = replying([CHANGE])
  const labels = DECIDING({ 'a-planner': PLAN(TA, TB), 'a-builder': byTask, 'a-builder-2': byTask, 'a-builder-3': byTask, 'a-builder-4': byTask })
  const r = await runStage([OLD()], { personas: PERSONAS, labels, runner })
  passed(r)
  const asked = integrateAt(r, 'feat/b2')
  const sibling = integrateAt(r, 'feat/s')
  assert.ok(asked >= 0 && sibling >= 0, why(r))
  assert.ok(sibling > asked, 'the sibling was still running when the asking member had already integrated')
  const first = replyPolls(r)[0].i
  assert.ok(first > asked && first > sibling, 'no read before both are integrated')
  const rerun = r.calls.find((c) => c.prompt.includes('Main session changed product call d1'))
  assert.ok(rerun, why(r))
  assert.ok(rerun.i > Math.max(asked, sibling), 'the re-run starts only after both are integrated')
})

t('replies 6: a reply for an id the crew does not know is ignored and not acked', async () => {
  const runner = replying([{ id: 'zzz', reply: 'change', note: 'x' }])
  const r = await runStage([OLD()], { personas: PERSONAS, labels: DECIDING(), runner })
  passed(r)
  assert.ok(!r.labels.includes('a-builder-3'))
  assert.equal(cmdsOf(r, 'decision-ack').length, 0)
  assert.equal(cmdsOf(r, 'decision-checkpoint').length, 1)
})

t('replies 7: a stopped crew still reports its decisions; it never reached the checkpoint, so it read no replies', async () => {
  const labels = DECIDING({ 'a-builder-2': { ...ASK, text: 'And deleted items?' } })
  const r = await runStage([OLD()], { personas: PERSONAS, labels })
  const s = r.result.find((x) => x.slug === 'a')
  assert.equal(s.state, 'stopped')
  assert.equal(s.decisions.length, 1)
  assert.equal(replyPolls(r).length, 0)
  assert.equal(cmdsOf(r, 'decision-checkpoint').length, 0)
  assert.equal(s.late, undefined)
})

t('replies 8: a runner result the crew cannot read is not acked, so the reply is still there next time and shows up as late', async () => {
  const runner = replying('Sorry, I could not run that command.', [CHANGE])
  const r = await runStage([OLD()], { personas: PERSONAS, labels: DECIDING({ 'a-builder-3': done('feat/b3') }), runner })
  passed(r)
  assert.equal(cmdsOf(r, 'decision-ack').length, 0, 'nothing was applied, so nothing is acked')
  assert.equal(cmdsOf(r, 'decision-checkpoint').length, 1, 'the checkpoint is still recorded')
  assert.ok(!r.labels.includes('a-builder-3'), 'a garbled read applies nothing')
  const s = r.result.find((x) => x.slug === 'a')
  assert.deepEqual(s.decisions.map((x) => [x.id, x.reply]), [['d1', 'accepted']])
  assert.deepEqual(s.late, [{ id: 'd1', reply: 'change', note: 'Exclude archived items.' }])
})

t('replies 9: a change that arrives during QC rework is not applied and is listed as late; the crew is not looped', async () => {
  const FAIL = 'VERDICT: FAIL\n\n## Findings\n- src/ui/a.ts: the export button is wrong\n'
  const labels = DECIDING({ 'a-qc': FAIL, 'a-qc-2': PASS, 'a-builder-3': done('feat/fix') })
  const runner = replying([], [CHANGE])
  const r = await runStage([OLD()], { personas: PERSONAS, labels, runner })
  passed(r)
  assert.ok(r.labels.includes('a-qc-2'), 'QC reworked once')
  assert.ok(!r.calls.some((c) => c.prompt.includes('Main session changed product call')), 'nobody applied the change')
  assert.equal(cmdsOf(r, 'decision-ack').length, 0)
  assert.equal(replyPolls(r).length, 2)
  assert.ok(replyPolls(r)[1].i > indexOf(r, 'a-qc-2'), 'the late read follows the last QC')
  assert.equal(r.labels.filter((l) => /^a-writer/.test(l)).length, 1, 'the knowledge step does not rerun')
  const s = r.result.find((x) => x.slug === 'a')
  assert.deepEqual(s.late, [CHANGE].map(({ id, reply, note }) => ({ id, reply, note })))
  assert.deepEqual(s.decisions.map((x) => [x.id, x.reply]), [['d1', 'accepted']])
})

// ---------------------------------------------------------------- resume keeps learned items and decisions (finding 2)

const OLD_ITEM = { kind: 'feature', text: 'old learned fact', source: 'src/old.ts:1', task: 'write-tests', member: 'a-tester' }
const STORED = { decisions: [{ id: 'd-a-1', crew: 'a', task: 'build-ui', question: 'Use blue?', answer: 'Yes blue.', by: 'product-owner', reply: null, note: null, consumed: false }, { id: 'd-b-1', crew: 'b', task: 'x', question: 'Other crew?', answer: 'Other.', by: 'product-owner', reply: null, note: null, consumed: false }] }
const RESUMED = (o = {}) => OLD('a', { resume: 'answers', tasks: [TT, TF], done: ['write-tests'], answers: [{ at: 'build-ui', text: 'blue it is' }], learned: [OLD_ITEM], ...o })
const resumeLabels = (o = {}) => ({ 'a-builder': done('feat/b', { learned: [{ ...ITEM, text: 'fresh fact' }] }), 'a-writer': done('feat/k'), 'a-qc': PASS, ...o })
const stored = ({ cmd, prompt }) => (cmd === 'decisions' && /factory\.ts\s+decisions\s+--crew a\b/.test(prompt) ? rj(STORED) : undefined)

t('resume 1: a resumed crew seeds learned from the stage arg and rebuilds its decisions from factory decisions --crew', async () => {
  const r = await runStage([RESUMED()], { personas: PERSONAS, labels: resumeLabels(), runner: stored })
  passed(r)
  assert.ok(cmdsOf(r, 'decisions').some((c) => /--crew a\b/.test(c.runner.rest)), 'decisions --crew a')
  const k = callOf(r, 'a-writer').prompt
  has(k, 'old learned fact')
  has(k, 'fresh fact')
  has(k, 'Use blue? -> Yes blue.')
  hasnt(k, 'Other crew?')
  const q = callOf(r, 'a-qc').prompt
  has(q, 'Use blue? | Yes blue.')
  hasnt(q, 'Other crew?')
  const s = r.result.find((x) => x.slug === 'a')
  assert.deepEqual(s.decisions.map((x) => [x.id, x.reply]), [['d-a-1', 'accepted']])
  assert.deepEqual(s.knowledge, { items: 2, ran: true, sourceChanges: 0 })
  // it made no call of its own, but it has decisions, so the checkpoint reads replies
  assert.equal(replyPolls(r).length >= 1, true)
})

t('resume 2: a pending change reply to a rebuilt decision re-runs its task on the crew branch, then is acked', async () => {
  const runner = (c) => stored(c) ?? replying([{ id: 'd-a-1', reply: 'change', note: 'Use green.' }])(c)
  const r = await runStage([RESUMED()], { personas: PERSONAS, labels: resumeLabels({ 'a-builder-2': done('feat/b2') }), runner })
  passed(r)
  const again = callOf(r, 'a-builder-2')
  assert.ok(again, why(r))
  has(again.prompt, 'Main session changed product call d-a-1: Use green.')
  has(again.prompt, 'Task: build-ui')
  const ack = cmdsOf(r, 'decision-ack')
  assert.equal(ack.length, 1)
  has(ack[0].prompt, '--ids d-a-1')
  assert.ok(ack[0].i > integrateAt(r, 'feat/b2'))
  has(callOf(r, 'a-writer').prompt, 'Use green.')
  hasnt(callOf(r, 'a-writer').prompt, 'Yes blue.')
})

t('resume 3: a resume with nothing stored makes no decisions call and a fresh crew never asks for them', async () => {
  const none = await runStage([RESUMED({ learned: undefined })], { personas: PERSONAS, labels: resumeLabels() })
  passed(none)
  assert.equal(none.result.find((x) => x.slug === 'a').decisions, undefined)
  const fresh = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor() })
  assert.equal(cmdsOf(fresh, 'decisions').length, 0)
})

const CH1 = { id: 'd-a-1', reply: 'change', note: 'Use green.' }
const D2 = { ...STORED.decisions[0], id: 'd-a-2', task: 'write-tests', question: 'Use red?', answer: 'Yes red.' }
// a runner for a resume whose factory has the stored decisions (and the given checkpoint flag) and the given replies by read number
const resumedRunner = (decisions, checkpoint, ...replies) => (c) => (c.cmd === 'decisions' && /--crew a\b/.test(c.prompt) ? rj({ decisions, checkpoint }) : replying(...replies)(c))

t('resume 4 (review 3): a resume whose checkpoint is already recorded applies no reply: no rerun, no ack, no second checkpoint; the unacked change is listed as late', async () => {
  const r = await runStage([RESUMED()], { personas: PERSONAS, labels: resumeLabels(), runner: resumedRunner(STORED.decisions, true, [CH1], [CH1]) })
  passed(r)
  assert.ok(!r.calls.some((c) => c.prompt.includes('Main session changed product call')), 'nobody applied the change')
  assert.equal(cmdsOf(r, 'decision-ack').length, 0)
  assert.equal(cmdsOf(r, 'decision-checkpoint').length, 0, 'the checkpoint was recorded by the earlier run')
  assert.equal(replyPolls(r).length, 1, 'only the late read')
  assert.deepEqual(r.result.find((x) => x.slug === 'a').late, [{ id: 'd-a-1', reply: 'change', note: 'Use green.' }])
  // the same resume with no checkpoint recorded still applies the reply
  const open = await runStage([RESUMED()], { personas: PERSONAS, labels: resumeLabels({ 'a-builder-2': done('feat/b2') }), runner: resumedRunner(STORED.decisions, false, [CH1]) })
  passed(open)
  assert.ok(open.calls.some((c) => c.prompt.includes('Main session changed product call d-a-1')))
})

t('replies 10 (review 3): each reply is acked right after it is applied, so a Stop on the second change leaves the first acked', async () => {
  const runner = resumedRunner([STORED.decisions[0], D2], false, [CH1, { ...CH1, id: 'd-a-2', note: 'Use red.' }])
  const labels = resumeLabels({ 'a-builder-2': done('feat/b2'), 'a-tester': { task: 'x', marker: 'BLOCKED', text: 'cannot redo the tests', proof: '' } })
  const r = await runStage([RESUMED()], { personas: PERSONAS, labels, runner })
  const s = r.result.find((x) => x.slug === 'a')
  assert.equal(s.state, 'stopped', why(r))
  assert.ok(callOf(r, 'a-tester'), 'the second change was tried')
  const ack = cmdsOf(r, 'decision-ack')
  assert.equal(ack.length, 1, 'the first id was acked before the Stop')
  has(ack[0].prompt, '--ids d-a-1')
  hasnt(ack[0].prompt, 'd-a-2')
  assert.ok(ack[0].i > integrateAt(r, 'feat/b2') && ack[0].i < indexOf(r, 'a-tester'), 'acked after its own integrate, before the next rerun')
})

t('replies 11 (review 3): a done task that lost its brief is not rerun: the change goes to late, not applied', async () => {
  const bare = ({ name, role, effort, files, after }) => ({ name, role, effort, files, after })
  const entry = RESUMED({ tasks: [bare(TT), bare(TF)], done: ['write-tests', 'build-ui'], answers: [] })
  const r = await runStage([entry], { personas: PERSONAS, labels: resumeLabels(), runner: resumedRunner(STORED.decisions, false, [CH1], [CH1]) })
  passed(r)
  assert.ok(!r.calls.some((c) => c.prompt.includes('Main session changed product call')), 'no rerun without a brief')
  assert.equal(cmdsOf(r, 'decision-ack').length, 0)
  assert.deepEqual(r.result.find((x) => x.slug === 'a').late, [{ id: 'd-a-1', reply: 'change', note: 'Use green.' }])
})

t('replies 12 (review 3): a rerun after a resume carries the task brief and persona', async () => {
  const r = await runStage([RESUMED()], { personas: PERSONAS, labels: resumeLabels({ 'a-builder-2': done('feat/b2') }), runner: resumedRunner(STORED.decisions, false, [CH1]) })
  passed(r)
  const again = callOf(r, 'a-builder-2')
  has(again.prompt, 'BRIEF-TF')
  assert.equal(again.opts.agentType, 'frontend-ui-developer')
})

t('replies 13 (review 3): a late read that fails is logged and the crew result says lateUnknown; a read that works says nothing', async () => {
  const boom = ({ cmd, n }) => {
    if (cmd === 'decision-replies' && n === 1) throw new Error('runner died')
  }
  const failed = await runStage([OLD()], { personas: PERSONAS, labels: DECIDING(), runner: boom })
  passed(failed)
  const s = failed.result.find((x) => x.slug === 'a')
  assert.equal(s.lateUnknown, true)
  assert.equal(s.late, undefined)
  const garbled = await runStage([OLD()], { personas: PERSONAS, labels: DECIDING(), runner: replying([], 'Sorry, I could not run that command.') })
  assert.equal(garbled.result.find((x) => x.slug === 'a').lateUnknown, true, 'an unreadable late read is unknown too')
  const ok = await runStage([OLD()], { personas: PERSONAS, labels: DECIDING(), runner: replying([], []) })
  assert.equal(ok.result.find((x) => x.slug === 'a').lateUnknown, undefined)
  const none = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor() })
  assert.equal(none.result.find((x) => x.slug === 'a').lateUnknown, undefined, 'a crew with no product call never reads')
})

t('learned 2 (review 3): the learned items go to crew-learned in chunks whose JSON stays under 6000 characters; one oversize item goes alone with its text cut', async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ kind: 'feature', text: `fact ${i} ` + 'x'.repeat(300), source: 'src/a.ts:1' }))
  const r = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor({ 'a-builder': done('feat/b', { learned: many }) }) })
  passed(r)
  const adds = cmdsOf(r, 'crew-learned').map((c) => JSON.parse(c.prompt.match(/--add='([^']*)'/)[1]))
  assert.ok(adds.length >= 2, `${adds.length} calls`)
  for (const a of adds) assert.ok(JSON.stringify(a).length <= 6000, `chunk of ${JSON.stringify(a).length}`)
  assert.deepEqual(adds.flat().map((i) => i.text.slice(0, 7)), many.map((i) => i.text.slice(0, 7)), 'every item, in order')
  const huge = { kind: 'decision', text: 'big ' + 'y'.repeat(9000), source: '' }
  const small = { kind: 'feature', text: 'small one', source: '' }
  const r2 = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor({ 'a-builder': done('feat/b', { learned: [small, huge, small] }) }) })
  passed(r2)
  const adds2 = cmdsOf(r2, 'crew-learned').map((c) => JSON.parse(c.prompt.match(/--add='([^']*)'/)[1]))
  assert.equal(adds2.length, 3, 'the oversize item is alone')
  assert.equal(adds2[1].length, 1)
  assert.ok(JSON.stringify(adds2[1]).length <= 6000)
  assert.ok(adds2[1][0].text.startsWith('big yyy') && adds2[1][0].text.length < huge.text.length)
})

t('learned 1: crew-learned is called once per member report that carries items, with the items, and only then', async () => {
  const labels = labelsFor({ 'a-tester': done('feat/t'), 'a-builder': done('feat/b', { learned: [ITEM, { ...ITEM, text: 'second fact' }] }) })
  const r = await runStage([OLD()], { personas: PERSONAS, labels })
  passed(r)
  const l = cmdsOf(r, 'crew-learned')
  assert.equal(l.length, 1, 'the tester reported nothing: no call')
  has(l[0].prompt, '--slug a')
  has(l[0].prompt, '--add=')
  has(l[0].prompt, 'export button lives in ExportMenu')
  has(l[0].prompt, 'second fact')
  // the stored items keep the task and the member, so a resume can seed them
  has(l[0].prompt, 'build-ui')
  assert.equal(cmdsOf(await runStage([OLD()], { personas: PERSONAS, labels: labelsFor(PLAIN) }), 'crew-learned').length, 0)
})

// ---------------------------------------------------------------- the knowledge step after the checkpoint

t('knowledge 19: the knowledge writer runs on Sonnet at effort medium', async () => {
  const r = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor() })
  passed(r)
  const w = callOf(r, 'a-writer')
  assert.equal(w.opts.model, 'sonnet')
  assert.equal(w.opts.effort, 'medium')
  assert.equal(w.opts.agentType, 'truss:writer')
  // an ordinary writer task keeps its role row
  const plain = await runStage([OLD('a', { owns: ['docs/**'] })], { personas: PERSONAS, labels: { 'a-planner': PLAN(TW), 'a-writer': done('feat/w'), 'a-qc': PASS } })
  assert.equal(callOf(plain, 'a-writer').opts.model, 'opus')
})

const KSHA = 'c0'.repeat(20)

t('knowledge 20: knowledge-commit records the writer commit after it integrates; the QC Knowledge block names the SHA; a skipped step records nothing', async () => {
  const r = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor() })
  passed(r)
  const kc = cmdsOf(r, 'knowledge-commit')
  assert.equal(kc.length, 1)
  has(kc[0].prompt, '--slug a')
  has(kc[0].prompt, `--sha ${KSHA}`)
  assert.ok(kc[0].i > integrateAt(r, 'feat/k'), 'after the knowledge branch is integrated')
  has(callOf(r, 'a-qc').prompt, `Knowledge commit: ${KSHA}`)
  const skipped = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor(PLAIN) })
  assert.equal(cmdsOf(skipped, 'knowledge-commit').length, 0)
  hasnt(callOf(skipped, 'a-qc').prompt, 'Knowledge commit:')
})

t('knowledge 21 (review 3): green always re-runs after the knowledge commit (markdown can be test input), whatever knowledge-commit says; the range is sent', async () => {
  const H2 = 'f6'.repeat(20)
  const integ = (head, kc) => ({ cmd, branch }) => (cmd === 'integrate' && branch === 'feat/k' ? rj(head ? { merged: true, head } : { merged: true }) : cmd === 'knowledge-commit' && kc !== undefined ? kc : undefined)
  const docs = rj({ slug: 'a', sha: KSHA, files: ['docs/features.md'] })
  const labels = () => labelsFor({ 'a-writer': done('feat/k', { files: ['docs/features.md'] }) })
  const only = await runStage([OLD()], { personas: PERSONAS, labels: labels(), runner: integ(H2, docs) })
  passed(only)
  assert.equal(greens(only).length, 2, 'green re-runs after a markdown-only knowledge commit')
  assert.ok(greens(only)[1].i > integrateAt(only, 'feat/k'), 'after the knowledge branch is integrated')
  const kc = cmdsOf(only, 'knowledge-commit')[0]
  has(kc.prompt, `--base=${HEAD}`)
  has(kc.prompt, `--head=${H2}`)
  const sneaky = rj({ slug: 'a', sha: KSHA, files: ['docs/features.md'], docsOnly: true })
  for (const [name, runner] of [['an old factory still says docsOnly', integ(H2, sneaky)], ['the factory refuses the sha (not in the range)', integ(H2, rj({ error: 'sha is not in the range' }, 2))], ['the factory fails', integ(H2, rj({ error: 'boom' }, 1))], ['no integrated head', integ(null, docs)]]) {
    const r = await runStage([OLD()], { personas: PERSONAS, labels: labels(), runner })
    passed(r)
    assert.equal(greens(r).length, 2, name)
  }
})

t('knowledge 22: learned items from members after the knowledge step are listed as unrecorded in the crew result, never counted', async () => {
  const FAIL = 'VERDICT: FAIL\n\n## Findings\n- src/ui/a.ts: wrong\n'
  const late = { kind: 'persona', text: 'always run the fixer', source: 'qc' }
  const labels = labelsFor({ 'a-qc': FAIL, 'a-qc-2': PASS, 'a-builder-2': done('feat/fix', { learned: [late] }) })
  const r = await runStage([OLD()], { personas: PERSONAS, labels })
  passed(r)
  const s = r.result.find((x) => x.slug === 'a')
  assert.equal(s.unrecorded.length, 1)
  assert.equal(s.unrecorded[0].text, 'always run the fixer')
  assert.equal(s.unrecorded[0].kind, 'persona')
  assert.deepEqual(s.knowledge, { items: 1, ran: true, sourceChanges: 0 }, 'the late item is not in the count')
  assert.equal(r.labels.filter((l) => /^a-writer/.test(l)).length, 1, 'the step does not rerun')
  const clean = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor() })
  assert.equal(clean.result.find((x) => x.slug === 'a').unrecorded, undefined)
})

t('product 10: the product-answer resume names the asking member earlier branch', async () => {
  const labels = DECIDING()
  const r = await runStage([OLD()], { personas: PERSONAS, labels })
  passed(r)
  has(callOf(r, 'a-builder-2').prompt, 'Its branch was feat/b.')
})

// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0035, path-scoped knowledge, stage.js side. Written from the 0.24.0 contract before the change.
//   1. a local glob matcher (`**`, `*`, `?`, `/`) that passes the shared vectors
//   2. taskPrompt: one `Context for your files:` line, only when a rule matches a task file
//   3. knowledgePrompt: routing table, reconcile, verified, budgets, nowhere
//   4. productOwnerFile(): args.truss.productDecisions, default docs/knowledge/product-decisions.md
//   5. factory knowledge-lint --slug=<crew> runs once before QC, on the crew worktree with the factory's merge base; the QC brief
//      gets the results and the full counts; only new failures fail the crew; a lint that cannot run, or whose output does not
//      parse, never stops the crew, and QC is told which
//   6. a product item never targets an always-loaded file; a knowledgeBudgets value of 0 is kept
// Run with: node --test tests/knowledge-stage.check.ts

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
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

// ---------------------------------------------------------------- the glob matcher, pulled out of stage.js between its markers

const SRC = readFileSync(STAGE, 'utf8')
function matcher() {
  const a = SRC.indexOf('// rule globs: begin')
  const b = SRC.indexOf('// rule globs: end')
  assert.ok(a >= 0 && b > a, 'stage.js carries the rule glob block between "// rule globs: begin" and "// rule globs: end"')
  return new Function(`${SRC.slice(a, b)}\nreturn { globMatches, rulesFor }`)()
}

const VECTORS = [
  ['**/*.ts', 'a.ts', true],
  ['**/*.ts', 'src/a/b.ts', true],
  ['**/*.ts', 'src/a.js', false],
  ['src/**', 'src/a/b.ts', true],
  ['src/**', 'src/a.ts', true],
  ['src/**', 'src', false],
  ['src/**', 'lib/a.ts', false],
  ['src/**/test.ts', 'src/test.ts', true],
  ['src/**/test.ts', 'src/a/b/test.ts', true],
  ['src/**/test.ts', 'src/a/b/other.ts', false],
  ['src/*.ts', 'src/b.ts', true],
  ['src/*.ts', 'src/a/b.ts', false],
  ['src/?.ts', 'src/a.ts', true],
  ['src/?.ts', 'src/ab.ts', false],
  ['src?a.ts', 'src/a.ts', false],
  ['*.md', '.hidden.md', true],
  ['*', 'a/b', false],
  ['*', '.env', true],
  ['**', 'a/b/c', true],
  ['**/.env', 'a/b/.env', true],
  ['**/.env', '.env', true],
  ['.github/**', '.github/workflows/ci.yml', true],
  ['docs/*/index.md', 'docs/a/index.md', true],
  ['docs/*/index.md', 'docs/a/b/index.md', false],
  ['a.b', 'aXb', false],
  ['a.b', 'a.b', true],
  ['src/[id]/page.ts', 'src/[id]/page.ts', true],
  ['src/[id]/page.ts', 'src/i/page.ts', false],
  ['**/test/**', 'a/test/b/c.ts', true],
  ['**/test/**', 'a/tests/b/c.ts', false],
  ['src/a+b.ts', 'src/aab.ts', false],
  ['src/*.test.ts', 'src/x.test.ts', true],
  ['src/*.test.ts', 'src/x.spec.ts', false],
]

t('glob 1: the inline vectors pass (** at the start, middle and end, * stops at /, ?, dotfiles, regex characters are literal)', () => {
  const { globMatches } = matcher()
  for (const [glob, path, match] of VECTORS) assert.equal(globMatches(glob, path), match, `${glob} vs ${path}`)
})

// the dialect of bin/knowledge.ts globToRegExp that the first stage.js copy missed, and the brace alternation of 0.24.0
const DIALECT_VECTORS = [
  ['src/', 'src/a.ts', true],
  ['src/', 'src', false],
  ['src/a/', 'src/a/b/c.ts', true],
  ['src/a/', 'src/ab.ts', false],
  ['./src/*.ts', 'src/a.ts', true],
  ['/src/*.ts', 'src/a.ts', true],
  ['src\\ui\\*.ts', 'src/ui/a.ts', true],
  ['src/ui/*.ts', 'src\\ui\\a.ts', true],
  ['a**', 'abc', true],
  ['a**', 'a/b', false],
  ['**b', 'a/b', false],
  ['src/**', 'src', false],
  ['**/', 'a/b', true],
  ['src/?.ts', 'src/é.ts', true],
  ['src/?.ts', 'src/😀.ts', true],
  ['src/**/*.{ts,tsx}', 'src/a/b.tsx', true],
  ['src/**/*.{ts,tsx}', 'src/b.ts', true],
  ['src/**/*.{ts,tsx}', 'src/b.js', false],
  ['src/**/*.{ts,tsx}', 'src/b.{ts,tsx}', false],
  ['{src,lib}/**', 'lib/a/b.ts', true],
  ['{src,lib}/**', 'src/a.ts', true],
  ['{src,lib}/**', 'test/a.ts', false],
  ['{src,lib}/**', 'src', false],
  ['a{b', 'a{b', true],
  ['a{b', 'ab', false],
  ['a}b', 'a}b', true],
  ['{,x}y', 'y', true],
  ['{,x}y', 'xy', true],
  ['{,x}y', 'zy', false],
  // malformed groups are literal: one alternative, an empty one other than {,x}, and the outer brace of a nested group
  ['{a}.ts', '{a}.ts', true],
  ['{a,}.ts', '{a,}.ts', true],
  ['{a,}.ts', 'a.ts', false],
  ['{a,{b,c}}', '{a,b}', true],
  ['{a,{b,c}}', '{a,c}', true],
  ['{a,{b,c}}', 'a', false],
]

t('glob 1b: the knowledge.ts dialect: trailing and leading slashes, ./, backslashes, whole-segment double star, code points, braces', () => {
  const { globMatches } = matcher()
  for (const [glob, path, match] of DIALECT_VECTORS) assert.equal(globMatches(glob, path), match, `${glob} vs ${path}`)
})

t('glob 2: the shared vectors in tests/fixtures/glob-vectors.json pass, when the file exists', () => {
  const file = `${PLUGIN}/tests/fixtures/glob-vectors.json`
  if (!existsSync(file)) return
  const { globMatches } = matcher()
  const vectors = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(Array.isArray(vectors) && vectors.length > 0)
  for (const v of vectors) assert.equal(globMatches(v.glob, v.path), v.match, `${v.glob} vs ${v.path}`)
})

t('glob 3: rulesFor returns the rule paths whose globs match a task file, once each, in rule order; a wildcard task file matches by overlap', () => {
  const { rulesFor } = matcher()
  const rules = [
    { path: '.claude/rules/ui.md', paths: ['src/ui/**/*.tsx', 'src/ui/*.css'] },
    { path: '.claude/rules/api.md', paths: ['src/api/**'] },
    { path: '.claude/rules/all.md', paths: ['**/*.ts'] },
  ]
  assert.deepEqual(rulesFor(rules, ['src/ui/a/b.tsx', 'src/ui/c.css']), ['.claude/rules/ui.md'])
  assert.deepEqual(rulesFor(rules, ['src/api/x.ts']), ['.claude/rules/api.md', '.claude/rules/all.md'])
  assert.deepEqual(rulesFor(rules, ['docs/a.md']), [])
  // a wildcard task file matches by directory overlap, unless both end in a literal extension and the extensions differ
  assert.deepEqual(rulesFor(rules, ['src/ui/**']), ['.claude/rules/ui.md', '.claude/rules/all.md'])
  assert.deepEqual(rulesFor(rules, ['lib/**']), ['.claude/rules/all.md'])
  assert.deepEqual(rulesFor(rules, ['src/api/*.css']), ['.claude/rules/api.md'])
  assert.deepEqual(rulesFor(rules, ['docs/**/*.md']), [])
  // malformed entries count for nothing
  assert.deepEqual(rulesFor([null, { path: 'x.md' }, { path: 'y.md', paths: 'src/**' }, { paths: ['src/**'] }], ['src/a.ts']), [])
  assert.deepEqual(rulesFor(undefined, ['src/a.ts']), [])
})

t('glob 4: rulesFor takes a planner task file with backslashes as slashes, and a brace rule glob overlaps by any alternative', () => {
  const { rulesFor } = matcher()
  const rules = [
    { path: '.claude/rules/ui.md', paths: ['src/ui/**/*.tsx'] },
    { path: '.claude/rules/code.md', paths: ['{src,lib}/**/*.{ts,tsx}'] },
  ]
  assert.deepEqual(rulesFor(rules, ['src\\ui\\a\\b.tsx']), ['.claude/rules/ui.md', '.claude/rules/code.md'])
  assert.deepEqual(rulesFor(rules, ['lib\\x.ts']), ['.claude/rules/code.md'])
  assert.deepEqual(rulesFor(rules, ['lib\\**']), ['.claude/rules/code.md'])
  assert.deepEqual(rulesFor(rules, ['lib/**/*.css']), [])
  assert.deepEqual(rulesFor(rules, ['./src/ui/**']), ['.claude/rules/ui.md', '.claude/rules/code.md'])
})

// ---------------------------------------------------------------- stage.js harness (as tests/crew-knowledge.check.ts)

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const tick = () => new Promise((r) => setImmediate(r))
const ticks = async (n) => {
  for (let i = 0; i < n; i++) await tick()
}
const rj = (obj, exit = 0) => ({ exit, stdout: JSON.stringify(obj) })
const HEAD = 'a1'.repeat(20)
const BASE = 'd4'.repeat(20)
const PATCH = 'e5'.repeat(20)
const CLEAN = { ok: true, failures: [], warnings: [] }

async function exec(args, o = {}) {
  const body = SRC.replace(/^\s*export\s+const\s+meta\b/m, 'const meta')
  const calls = []
  const agent = async (prompt, opts = {}) => {
    const call = { prompt, opts, label: opts.label, i: calls.length }
    calls.push(call)
    await tick()
    if (/-runner(-\d+)?$/.test(String(opts.label))) {
      const m = prompt.match(/factory\.ts\s+(admit|reap|check|integrate|owns-check|tests-check|sync|crew-decision|decision-replies|decision-ack|decision-checkpoint|crew-learned|knowledge-commit|knowledge-lint|decisions)\b([^\n]*)/)
      if (!m) throw new Error(`unparsable runner prompt for label ${opts.label}`)
      const cmd = m[1]
      const flag = (name) => (m[2].match(new RegExp(`--${name}(?:\\s+|=)([^\\s\`]+)`)) || [])[1]
      const expect = flag('expect')
      call.runner = { cmd, expect, rest: m[2] }
      let out = o.runner ? await o.runner({ cmd, expect, call, prompt }) : undefined
      if (out === undefined) {
        const plain = expect === 'red' ? { ok: true } : { ok: true, head: HEAD }
        out =
          cmd === 'admit' ? rj({ admitted: true, parallelism: 4, running: 0, freeMB: 8000, minFreeMB: 2048 }) : cmd === 'reap' ? rj({ reaped: [], skipped: [] }) : cmd === 'check' ? rj(plain) : cmd === 'integrate' ? rj({ merged: true }) : cmd === 'owns-check' ? rj({ ok: true, outside: [] }) : cmd === 'tests-check' ? rj({ ok: true, tests: [] }) : cmd === 'crew-decision' ? rj({ id: 'd1' }) : cmd === 'decision-replies' ? rj([]) : cmd === 'decision-ack' ? rj({ acked: [], already: [] }) : cmd === 'knowledge-lint' ? rj(CLEAN) : cmd === 'decisions' ? rj({ decisions: [] }) : cmd === 'integrate' ? rj({ merged: true }) : rj({ ok: true })
      }
      await ticks(1)
      return out
    }
    const labels = o.labels ?? {}
    if (!Object.hasOwn(labels, opts.label)) throw new Error(`unscripted label: ${opts.label}`)
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
    result = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'allowance', body)(agent, parallel, pipeline, () => {}, o.log ?? (() => {}), structuredClone(args), {})
  } catch (e) {
    error = e
  }
  return { result, error, calls, labels: calls.map((c) => c.label) }
}

const PASS = `VERDICT: PASS\n\n## Proof checked\nHead: ${HEAD}\nPatch: ${PATCH}\n`
const done = (branch, extra = {}) => ({ task: 'whatever', marker: 'DONE', branch, commit: 'c0'.repeat(20), proof: 'PROOF-' + branch, text: 'finished ' + branch, ...extra })
const TT = { name: 'write-tests', role: 'tester', effort: 'medium', persona: null, files: ['tests/a.check.ts'], reads: [], brief: 'BRIEF-TT', after: [] }
const TB = { name: 'build-ui', role: 'builder', effort: 'low', persona: null, files: ['src/ui/a.ts'], reads: [], brief: 'BRIEF-TB', after: ['write-tests'] }
const TW = { name: 'write-docs', role: 'writer', effort: 'medium', persona: null, files: ['docs/a.md'], reads: [], brief: 'BRIEF-TW', after: [] }
const PLAN = (...tasks) => ({ tasks, stop: null })
const OLD = (slug = 'a', o = {}) => ({
  slug, stage: 1, goalFile: `/proj/.truss/goals/${slug}.md`, goal: 'GOAL-TEXT', owns: ['src/**', 'tests/*.ts', 'docs/**'],
  acceptanceTest: 'node --test tests/a.check.ts', highImpact: [], stressTest: false, scope: 'SCOPE-VERBATIM',
  worktree: `/wt/${slug}`, branch: `truss/${slug}`, base: BASE, architecture: '/proj/docs/ARCH.md', adrs: [],
  resume: null, tasks: [], done: [], answers: [], spent: 0, labelFrom: {}, ...o,
})
const ITEM = { kind: 'feature', text: 'export button lives in ExportMenu', source: 'src/ui/a.ts:10' }
const labelsFor = (o = {}) => ({ 'a-planner': PLAN(TT, TB), 'a-tester': done('feat/t'), 'a-builder': done('feat/b', { learned: [ITEM] }), 'a-writer': done('feat/k'), 'a-qc': PASS, ...o })
const PLAIN = { 'a-builder': done('feat/b') }
async function runStage(crews, o = {}) {
  const args = { truss: { kind: 'stage', dir: '/proj/.truss', repo: '/proj', plugin: PLUGIN, target: 'main', reworkAllowance: 2, roles: ROLES, scriptPath: STAGE, crews, ...(o.truss || {}) } }
  const r = await exec(args, o)
  if (r.error) throw r.error
  return r
}
const has = (s, sub) => assert.ok(s.includes(sub), `missing ${JSON.stringify(sub)} in:\n${s.slice(0, 3500)}`)
const hasnt = (s, sub) => assert.ok(!s.includes(sub), `unexpected ${JSON.stringify(sub)} in:\n${s.slice(0, 3500)}`)
const callOf = (r, label) => r.calls.find((c) => c.label === label)
const stateOf = (r, slug = 'a') => r.result.find((x) => x.slug === slug)
const lints = (r) => r.calls.filter((c) => c.runner && c.runner.cmd === 'knowledge-lint')
const RULES = [{ path: '.claude/rules/ui.md', paths: ['src/ui/**'] }, { path: '.claude/rules/api.md', paths: ['src/api/**'] }]

// ---------------------------------------------------------------- taskPrompt: the context line

t('context 1: a task whose file matches a rule gets one Context for your files line naming that rule, and no other rule', async () => {
  const r = await runStage([OLD()], { labels: labelsFor(), truss: { rules: RULES } })
  const p = callOf(r, 'a-builder').prompt
  has(p, 'Context for your files: .claude/rules/ui.md. Read each one unless it is already in your context.')
  hasnt(p, '.claude/rules/api.md')
  assert.equal(p.split('Context for your files:').length, 2, 'one line')
  // the tester task owns tests/a.check.ts, which no rule matches
  hasnt(callOf(r, 'a-tester').prompt, 'Context for your files')
})

t('context 2: with no rules arg, an empty one, or no match, no task prompt carries the line', async () => {
  for (const truss of [{}, { rules: [] }, { rules: [{ path: '.claude/rules/api.md', paths: ['src/api/**'] }] }]) {
    const r = await runStage([OLD()], { labels: labelsFor(), truss })
    for (const label of ['a-tester', 'a-builder']) hasnt(callOf(r, label).prompt, 'Context for your files')
  }
})

t('context 3: two matching rules are listed together, comma separated', async () => {
  const rules = [...RULES, { path: '.claude/rules/ts.md', paths: ['**/*.ts'] }]
  const r = await runStage([OLD()], { labels: labelsFor(), truss: { rules } })
  has(callOf(r, 'a-builder').prompt, 'Context for your files: .claude/rules/ui.md, .claude/rules/ts.md. Read each one')
})

t('context 4: the planner brief carries the agents index and the rules index, only when the stage args have them', async () => {
  const r = await runStage([OLD()], { labels: labelsFor(), truss: { rules: RULES, agentsIndex: 'AGENTS.md' } })
  const p = callOf(r, 'a-planner').prompt
  has(p, 'Agents index: AGENTS.md')
  has(p, 'Rules index (area rules')
  has(p, '- .claude/rules/ui.md: src/ui/**')
  has(p, '- .claude/rules/api.md: src/api/**')
  const none = await runStage([OLD()], { labels: labelsFor() })
  hasnt(callOf(none, 'a-planner').prompt, 'Agents index')
  hasnt(callOf(none, 'a-planner').prompt, 'Rules index')
})

// ---------------------------------------------------------------- knowledgePrompt

t('knowledge prompt: routing table, reconcile, source, verified, budgets and nowhere; the paths follow the stage args', async () => {
  const r = await runStage([OLD()], { labels: labelsFor(), truss: { rulesDir: '.claude/rules', knowledgeDir: 'docs/knowledge', agentsIndex: 'AGENTS.md', rules: RULES } })
  const p = callOf(r, 'a-writer').prompt
  assert.ok(p.startsWith('Knowledge: crew a\n'))
  has(p, 'Where each item goes:')
  has(p, '| Area-scoped stack rule or invariant | `.claude/rules/<area>.md`, with `paths` globs |')
  has(p, '| Cross-cutting persona rule | the persona file, under `## Standards` |')
  has(p, '| Capability | the feature map (docs/features.md) |')
  has(p, '| Product call | the product decisions file (docs/knowledge/product-decisions.md) |')
  has(p, '| Decision | a new ADR in docs/adr |')
  has(p, '| Anything else | nowhere |')
  has(p, 'Every fact you write cites its source path or hunk; drop a fact you cannot cite.')
  has(p, 'Reconcile before you add')
  has(p, 'never append a duplicate')
  has(p, `\`verified: ${HEAD}\``)
  has(p, 'Budgets (lines; the lint fails an always-loaded file over its budget)')
  has(p, 'agents index 60')
  has(p, 'rule file 40')
  has(p, 'persona 120')
  has(p, '15 items under `## Standards`')
  has(p, 'Nothing to record is a valid outcome')
  has(p, 'A new knowledge or rule file is linked from the feature map or the agents index (AGENTS.md)')
  has(p, 'Rule files that exist: .claude/rules/ui.md, .claude/rules/api.md')
})

t('knowledge prompt: the rules, knowledge and agents-index paths are overridable; a knowledgeBudgets override replaces the defaults it names', async () => {
  const truss = { rulesDir: 'ctx/rules', knowledgeDir: 'ctx/docs', agentsIndex: 'ctx/INDEX.md', productDecisions: 'ctx/docs/calls.md', knowledgeBudgets: { rule: 25 } }
  const r = await runStage([OLD()], { labels: labelsFor(), truss })
  const p = callOf(r, 'a-writer').prompt
  has(p, '`ctx/rules/<area>.md`')
  has(p, 'ctx/docs/calls.md')
  has(p, 'ctx/INDEX.md')
  has(p, 'rule file 25')
  has(p, 'agents index 60')
  hasnt(p, '.claude/rules/<area>.md')
})

t('knowledge prompt: the old routing (product to the product-owner file) is gone', async () => {
  const r = await runStage([OLD()], { labels: labelsFor() })
  const p = callOf(r, 'a-writer').prompt
  hasnt(p, 'product, to the product-owner file')
  hasnt(p, 'The product-owner file gets')
  hasnt(p, '.claude/agents/product-owner.md')
})

t('knowledge prompt: a knowledgeBudgets value of 0 is kept, not replaced by the default', async () => {
  const r = await runStage([OLD()], { labels: labelsFor(), truss: { knowledgeBudgets: { rule: 0, persona: -1, doc: 1.5 } } })
  const p = callOf(r, 'a-writer').prompt
  has(p, 'rule file 0')
  has(p, 'persona 120')
  has(p, 'knowledge doc over 150')
})

t('learned 1: the member brief never offers an always-loaded file as a product call target; area rules go to a rule file, the feature map or an ADR', async () => {
  const r = await runStage([OLD()], { labels: labelsFor(), truss: { productDecisions: 'kb/calls.md' } })
  const p = callOf(r, 'a-builder').prompt
  has(p, "A product item's target is only the product decisions file (kb/calls.md), never CLAUDE.md, AGENTS.md or a persona file.")
  has(p, "An area rule's target is a rule file under .claude/rules, the feature map (docs/features.md) or an ADR")
  hasnt(p, 'AGENTS.md, CLAUDE.md, a persona file, the product-owner file')
})

t('learned 2: a product item that names an always-loaded target is redirected to the product decisions file; other kinds keep their target', async () => {
  const items = [
    { kind: 'product', text: 'CALL-ROOT', source: 's:1', target: 'CLAUDE.md' },
    { kind: 'product', text: 'CALL-SUB', source: 's:2', target: 'src/ui/AGENTS.md' },
    { kind: 'product', text: 'CALL-PERSONA', source: 's:3', target: '.claude/agents/product-owner.md' },
    { kind: 'product', text: 'CALL-INDEX', source: 's:4', target: 'ctx/INDEX.md' },
    { kind: 'product', text: 'CALL-OK', source: 's:5', target: 'docs/knowledge/billing.md' },
    { kind: 'feature', text: 'FEAT-ROOT', source: 's:6', target: 'CLAUDE.md' },
  ]
  const r = await runStage([OLD()], { labels: labelsFor({ 'a-builder': done('feat/b', { learned: items }) }), truss: { agentsIndex: 'ctx/INDEX.md' } })
  const p = callOf(r, 'a-writer').prompt
  has(p, 'a product item never goes into an always-loaded file (CLAUDE.md, AGENTS.md, the agents index or a persona file): ignore that target and record the call in the product decisions file.')
  const line = (text) => p.split('\n').find((l) => l.includes(text)) || ''
  const redirect = '(always loaded: a product call never goes there; record it in docs/knowledge/product-decisions.md instead)'
  for (const text of ['CALL-ROOT', 'CALL-SUB', 'CALL-PERSONA', 'CALL-INDEX']) has(line(text), redirect)
  hasnt(line('CALL-OK'), 'always loaded')
  hasnt(line('FEAT-ROOT'), 'always loaded')
})

// ---------------------------------------------------------------- productOwnerFile

const PO_PERSONA = { agentType: 'product-owner', model: 'opus', effort: 'medium', file: '/proj/.claude/agents/product-owner.md', description: 'Judges the product fit', readOnly: true, loaded: true }
const ASK = done('feat/b', { marker: 'QUESTION', text: 'Should the export include archived items?' })

t('product file 1: the default is docs/knowledge/product-decisions.md in the product call, the knowledge brief and the QC brief', async () => {
  const labels = labelsFor({ 'a-builder': ASK, 'a-builder-2': done('feat/b2'), 'a-po': 'PO: DECIDE\nInclude archived items.\nReason: r' })
  const r = await runStage([OLD()], { labels, truss: { personas: { 'product-owner': PO_PERSONA } } })
  assert.equal(stateOf(r).state, 'passed', JSON.stringify(r.result).slice(0, 500))
  for (const label of ['a-po', 'a-writer', 'a-qc']) {
    const p = callOf(r, label).prompt
    has(p, 'Product decisions file: docs/knowledge/product-decisions.md')
    // QC still holds the diff to the persona's Standards, so its brief lists that file; no other brief does
    if (label !== 'a-qc') hasnt(p, '.claude/agents/product-owner.md')
  }
  has(callOf(r, 'a-qc').prompt, 'every product call this crew made must appear in the product decisions file')
})

t('product file 2: args.truss.productDecisions overrides it everywhere, and nothing falls back to the default', async () => {
  const labels = labelsFor({ 'a-builder': ASK, 'a-builder-2': done('feat/b2'), 'a-po': 'PO: DECIDE\nInclude archived items.\nReason: r' })
  const r = await runStage([OLD()], { labels, truss: { productDecisions: 'kb/calls.md', personas: { 'product-owner': PO_PERSONA } } })
  assert.equal(stateOf(r).state, 'passed')
  for (const label of ['a-po', 'a-writer', 'a-qc']) {
    const p = callOf(r, label).prompt
    has(p, 'Product decisions file: kb/calls.md')
    hasnt(p, 'docs/knowledge/product-decisions.md')
  }
})

t('product file 3: a crew with no product-owner persona still names the product decisions file', async () => {
  const r = await runStage([OLD()], { labels: labelsFor(PLAIN) })
  has(callOf(r, 'a-qc').prompt, 'Product decisions file: docs/knowledge/product-decisions.md')
})

// ---------------------------------------------------------------- the lint

const FAIL_NEW = { check: 'dead-glob', path: '.claude/rules/ui.md', message: 'glob src/old/** matches no tracked file', new: true }
const FAIL_OLD = { check: 'missing-source', path: 'docs/knowledge/legacy.md', message: 'src/gone.ts is not tracked', new: false }
const WARN = { check: 'stale', path: 'docs/knowledge/export.md', message: 'src/export.ts changed since verified', new: true }
const lintOut = (failures, warnings = []) => ({ cmd }) => (cmd === 'knowledge-lint' ? rj({ ok: failures.length === 0, failures, warnings }) : undefined)

t('lint 1: it runs once, before QC, as factory knowledge-lint --slug=<crew>, on the crew worktree, with no start-time --base', async () => {
  const r = await runStage([OLD()], { labels: labelsFor(PLAIN) })
  assert.equal(stateOf(r).state, 'passed')
  const l = lints(r)
  assert.equal(l.length, 1)
  has(l[0].prompt, `bin/factory.ts knowledge-lint --slug=a --dir /proj/.truss --repo /proj --status-line`)
  hasnt(l[0].prompt, '--base')
  hasnt(l[0].prompt, BASE)
  assert.ok(l[0].i < r.calls.findIndex((c) => c.label === 'a-qc'), 'before QC')
})

t('lint 2: a clean result says so in the QC brief', async () => {
  const r = await runStage([OLD()], { labels: labelsFor(PLAIN) })
  const p = callOf(r, 'a-qc').prompt
  has(p, 'Knowledge lint (factory knowledge-lint):')
  has(p, 'no failures and no warnings')
  hasnt(p, 'did not run')
})

t('lint 3: new failures are listed as the ones that fail the crew; failures that predate it and warnings are listed and fail nothing', async () => {
  const r = await runStage([OLD()], { labels: labelsFor(PLAIN), runner: lintOut([FAIL_NEW, FAIL_OLD], [WARN]) })
  assert.equal(stateOf(r).state, 'passed', 'stage.js itself rules nothing: QC does')
  const p = callOf(r, 'a-qc').prompt
  has(p, 'New failures (this crew\'s diff caused them; FAIL on each, quoting it):')
  has(p, '- [dead-glob] .claude/rules/ui.md: glob src/old/** matches no tracked file')
  has(p, 'Failures that predate this crew (list them in your report for the main session; never FAIL for them):')
  has(p, '- [missing-source] docs/knowledge/legacy.md: src/gone.ts is not tracked')
  has(p, 'Warnings (list them in your report; never FAIL for them):')
  has(p, '- [stale] docs/knowledge/export.md: src/export.ts changed since verified')
  assert.ok(p.indexOf('New failures') < p.indexOf('Failures that predate'), 'new first')
  assert.ok(!/New failures[^\n]*\n(- [^\n]*\n)*[^\n]*legacy\.md[^\n]*\nFailures that predate/.test(p), 'the old failure is not under New failures')
})

t('lint 4: only old failures and warnings: no New failures heading', async () => {
  const r = await runStage([OLD()], { labels: labelsFor(PLAIN), runner: lintOut([FAIL_OLD], [WARN]) })
  const p = callOf(r, 'a-qc').prompt
  hasnt(p, 'New failures')
  has(p, 'Failures that predate this crew')
})

t('lint 5: a failure with no new key counts as new', async () => {
  const { new: _n, ...bare } = FAIL_NEW
  const r = await runStage([OLD()], { labels: labelsFor(PLAIN), runner: lintOut([bare]) })
  has(callOf(r, 'a-qc').prompt, 'New failures')
})

t('lint 6: the crew result lists the failures that predate it and the warnings, for the main session', async () => {
  const r = await runStage([OLD()], { labels: labelsFor(PLAIN), runner: lintOut([FAIL_OLD], [WARN]) })
  assert.deepEqual(stateOf(r).knowledgeLint, { ran: true, predating: [FAIL_OLD], warnings: [WARN] })
  const clean = await runStage([OLD()], { labels: labelsFor(PLAIN) })
  assert.ok(!Object.hasOwn(stateOf(clean), 'knowledgeLint'), 'a clean lint adds nothing')
})

t('lint 7: a lint that fails to run (a usage error, no runner result, a thrown runner) never stops the crew; QC is told it did not run', async () => {
  const cases = [
    () => ({ exit: 2, stdout: 'usage: factory knowledge-lint' }),
    () => null,
    () => {
      throw new Error('runner died')
    },
  ]
  for (const bad of cases) {
    const r = await runStage([OLD()], { labels: labelsFor(PLAIN), runner: ({ cmd }) => (cmd === 'knowledge-lint' ? bad() : undefined) })
    assert.equal(stateOf(r).state, 'passed', JSON.stringify(r.result).slice(0, 400))
    const p = callOf(r, 'a-qc').prompt
    has(p, 'Knowledge lint did not run.')
    hasnt(p, 'could not be parsed')
    hasnt(p, 'New failures')
    assert.ok(!Object.hasOwn(stateOf(r), 'knowledgeLint'), 'the result adds nothing: the log and the QC brief say it did not run')
  }
})

t('lint 7b: a lint that ran but whose output does not parse (garbage, a malformed body, a stdout the runner cut short) is reported as such, and logged', async () => {
  const cut = JSON.stringify({ ok: false, failures: [FAIL_NEW], warnings: [WARN] }).slice(0, 60)
  const cases = [
    () => ({ exit: 0, stdout: 'not json' }),
    () => rj({ ok: true, failures: 'junk', warnings: [] }),
    () => ({ exit: 0, stdout: cut }),
    // a cut stdout whose exit the runner got wrong: the status line still says the command ran
    () => ({ exit: 1, stdout: cut, status: 'truss-status: {"ok":false}' }),
  ]
  for (const bad of cases) {
    const logs = []
    const r = await exec(
      { truss: { kind: 'stage', dir: '/proj/.truss', repo: '/proj', plugin: PLUGIN, target: 'main', reworkAllowance: 2, roles: ROLES, scriptPath: STAGE, crews: [OLD()] } },
      { labels: labelsFor(PLAIN), runner: ({ cmd }) => (cmd === 'knowledge-lint' ? bad() : undefined), log: (m) => logs.push(String(m)) },
    )
    if (r.error) throw r.error
    assert.equal(stateOf(r).state, 'passed', JSON.stringify(r.result).slice(0, 400))
    const p = callOf(r, 'a-qc').prompt
    has(p, 'Knowledge lint output could not be parsed. Check the knowledge rules above by hand.')
    hasnt(p, 'did not run')
    hasnt(p, 'New failures')
    assert.ok(!Object.hasOwn(stateOf(r), 'knowledgeLint'))
    assert.ok(logs.some((m) => m.startsWith('knowledge-lint output could not be parsed: crew a')), logs.join('\n'))
  }
})

t('lint 11: capped lists: the counts reach QC as a not-listed line and the crew result as predatingCount and warningCount', async () => {
  const out = { ok: false, failures: [FAIL_NEW, FAIL_OLD], warnings: [WARN], predatingCount: 40, warningCount: 12 }
  const r = await runStage([OLD()], { labels: labelsFor(PLAIN), runner: ({ cmd }) => (cmd === 'knowledge-lint' ? rj(out) : undefined) })
  const p = callOf(r, 'a-qc').prompt
  has(p, '- [missing-source] docs/knowledge/legacy.md: src/gone.ts is not tracked\n- and 39 more not listed (40 in all)')
  has(p, '- [stale] docs/knowledge/export.md: src/export.ts changed since verified\n- and 11 more not listed (12 in all)')
  assert.deepEqual(stateOf(r).knowledgeLint, { ran: true, failures: [FAIL_NEW], predating: [FAIL_OLD], warnings: [WARN], predatingCount: 40, warningCount: 12 })
  // counts equal to the lists add no line; a count below the list length is ignored
  const even = await runStage([OLD()], { labels: labelsFor(PLAIN), runner: ({ cmd }) => (cmd === 'knowledge-lint' ? rj({ ...out, predatingCount: 1, warningCount: 0 }) : undefined) })
  hasnt(callOf(even, 'a-qc').prompt, 'not listed')
  // only predating failures, every one cut by the cap: the heading still shows
  const none = await runStage([OLD()], { labels: labelsFor(PLAIN), runner: ({ cmd }) => (cmd === 'knowledge-lint' ? rj({ ok: true, failures: [], warnings: [], predatingCount: 3, warningCount: 0 }) : undefined) })
  const q = callOf(none, 'a-qc').prompt
  has(q, 'Failures that predate this crew (list them in your report for the main session; never FAIL for them):\n- and 3 more not listed (3 in all)')
  hasnt(q, 'no failures and no warnings')
})

t('lint 8: malformed entries inside failures and warnings are dropped', async () => {
  const r = await runStage([OLD()], { labels: labelsFor(PLAIN), runner: lintOut([FAIL_NEW, null, 'junk', { check: 'x' }], [5, WARN]) })
  const p = callOf(r, 'a-qc').prompt
  has(p, '- [dead-glob] .claude/rules/ui.md')
  has(p, '- [stale] docs/knowledge/export.md')
  hasnt(p, 'junk')
})

t('lint 9: skipped silently for a crew with no code tasks when no knowledge file exists: no lint run, no lint block', async () => {
  const labels = { 'a-planner': PLAN(TW), 'a-writer': done('feat/w'), 'a-qc': PASS }
  const r = await runStage([OLD()], { labels })
  assert.equal(stateOf(r).state, 'passed', JSON.stringify(r.result).slice(0, 400))
  assert.equal(lints(r).length, 0)
  hasnt(callOf(r, 'a-qc').prompt, 'Knowledge lint')
  assert.ok(!Object.hasOwn(stateOf(r), 'knowledgeLint'))
})

t('lint 10: a docs-only crew still gets the lint when the stage args name a knowledge file or dir', async () => {
  for (const truss of [{ rules: RULES }, { knowledgeDir: 'docs/knowledge' }, { agentsIndex: 'AGENTS.md' }, { productDecisions: 'docs/knowledge/product-decisions.md' }, { rulesDir: '.claude/rules' }]) {
    const labels = { 'a-planner': PLAN(TW), 'a-writer': done('feat/w'), 'a-qc': PASS }
    const r = await runStage([OLD()], { labels, truss })
    assert.equal(lints(r).length, 1, JSON.stringify(truss))
    has(callOf(r, 'a-qc').prompt, 'Knowledge lint (factory knowledge-lint):')
  }
})

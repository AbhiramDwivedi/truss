// @ts-nocheck
// truss 0.31.0, speed goal item 5: workflows/stage.js is generated from the modules in workflows-src/stage/ by bin/build-stage.ts
// (`npm run build:stage`). A Workflow script must be one file (ADR-0009; factory start copies it byte for byte), so the bundle is
// committed. These cases fail when a module is edited without a rebuild, or the build stops being deterministic.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { GENERATED_HEADER, STAGE_MODULES, STAGE_SRC_DIR, WORKFLOWS_DIR, buildStage } from '../bin/build-stage.ts'
import { gatesAware } from './fixtures/gates-stub.ts'
import { REAL_PLUGIN } from './fixtures/workflow-run/harness.ts'

const BUILD = path.join(import.meta.dirname, '..', 'bin', 'build-stage.ts')
const STAGE_JS = path.join(WORKFLOWS_DIR, 'stage.js')
const tmp = (p) => mkdtempSync(path.join(tmpdir(), p))
const copyModules = () => {
  const d = tmp('stage-bundle-')
  cpSync(STAGE_SRC_DIR, d, { recursive: true })
  return d
}

test('stage bundle: a rebuild into a temp dir is byte-identical to the committed stage.js', () => {
  const out = path.join(tmp('stage-bundle-out-'), 'stage.js')
  const r = spawnSync(process.execPath, [BUILD, '--out', out], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(readFileSync(out).equals(readFileSync(STAGE_JS)), 'stage.js is out of date with workflows-src/stage/*.js: run npm run build:stage')
  assert.equal(buildStage(), readFileSync(STAGE_JS, 'utf8'))
})

test('stage bundle: stage.js starts with the generated header, then the meta block', () => {
  const text = readFileSync(STAGE_JS, 'utf8')
  assert.ok(text.startsWith(GENERATED_HEADER))
  assert.ok(text.slice(GENERATED_HEADER.length).startsWith('export const meta = {'))
  assert.ok(!text.includes('\r'), 'LF line ends only')
})

test('stage bundle: every module is listed once and starts with its module comment', () => {
  assert.equal(new Set(STAGE_MODULES).size, STAGE_MODULES.length)
  const found = readdirSync(STAGE_SRC_DIR).filter((f) => f.endsWith('.js')).sort()
  assert.deepEqual(found, STAGE_MODULES.map((m) => `${m}.js`).sort())
  for (const m of STAGE_MODULES) assert.match(readFileSync(path.join(STAGE_SRC_DIR, `${m}.js`), 'utf8'), /^\/\/ stage\.js module: /, m)
})

test('stage bundle: an edited module changes the bundle, and CRLF modules build the same bytes', () => {
  const d = copyModules()
  const f = path.join(d, 'ruling.js')
  const orig = readFileSync(f, 'utf8')
  writeFileSync(f, orig.replace(/\n/g, '\r\n'))
  assert.equal(buildStage(d), buildStage())
  writeFileSync(f, `${orig}// edited\n`)
  assert.notEqual(buildStage(d), buildStage())
})

test('stage bundle: a module not in STAGE_MODULES, a missing one or one without its comment is refused', () => {
  const extra = copyModules()
  writeFileSync(path.join(extra, 'stray.js'), '// stage.js module: stray.\n')
  assert.throws(() => buildStage(extra), /not in STAGE_MODULES.*stray\.js/)
  const head = copyModules()
  const f = path.join(head, 'qc.js')
  writeFileSync(f, readFileSync(f, 'utf8').replace(/^[^\n]*\n/, ''))
  assert.throws(() => buildStage(head), /qc\.js: the first line/)
  const missing = tmp('stage-bundle-empty-')
  cpSync(path.join(STAGE_SRC_DIR, 'args.js'), path.join(missing, 'args.js'))
  assert.throws(() => buildStage(missing), /missing from/)
})

// ---------------------------------------------------------------- R-127: stage.js keeps multi-line text intact (stubbed agents, as pm-calls-029.check.ts)

const R127_STAGE = `${REAL_PLUGIN}/workflows/stage.js`
const R127_ROLES = {
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
const R127_PERSONAS = { 'product-owner': { agentType: 'product-owner', model: 'opus', effort: 'medium', file: '/proj/.claude/agents/product-owner.md', description: 'Judges the product fit', readOnly: true, loaded: true } }
const R127_HEAD = 'a1'.repeat(20)
const R127_PASS = `VERDICT: PASS\n\n## Proof checked\nHead: ${R127_HEAD}\nPatch: ${'e5'.repeat(20)}\n`
const r127done = (branch, extra = {}) => ({ task: 'whatever', marker: 'DONE', branch, commit: 'c0'.repeat(20), proof: `PROOF-${branch}`, text: `finished ${branch}`, ...extra })
const R127_TASKS = [
  { name: 'write-tests', role: 'tester', effort: 'medium', persona: null, files: ['tests/a.check.ts'], reads: [], brief: 'BRIEF-TT', after: [] },
  { name: 'build-export', role: 'builder', effort: 'low', persona: null, files: ['src/export.ts'], reads: [], brief: 'BRIEF-TF', after: ['write-tests'] },
  { name: 'write-docs', role: 'writer', effort: 'medium', persona: null, files: ['docs/export.md'], reads: [], brief: 'BRIEF-TD', after: ['build-export'] },
]
const R127_ENTRY = {
  slug: 'a', stage: 1, goalFile: '/proj/.truss/goals/a.md', goal: 'GOAL-TEXT', owns: ['src/**', 'tests/*.ts', 'docs/**'],
  acceptanceTest: 'node --test tests/a.check.ts', highImpact: ['src/core/**'], stressTest: false, scope: 'SCOPE-VERBATIM: build the export, nothing else',
  worktree: '/wt/a', branch: 'truss/a', base: 'd4'.repeat(20), architecture: '/proj/docs/ARCH.md', adrs: [],
  resume: null, tasks: [], done: [], answers: [], spent: 0, labelFrom: {},
}
const r127rj = (obj) => ({ exit: 0, stdout: JSON.stringify(obj) })
const R127_ITEM = 'E-20261113-0a1b2c'

// runs the built stage.js for one crew with stubbed agents; the runner answers every factory command a crew makes with its default
async function r127stage(labels, itemOpen) {
  const body = readFileSync(R127_STAGE, 'utf8').replace(/^\s*export\s+const\s+meta\b/m, 'const meta')
  const calls = []
  const agent = gatesAware(async (prompt, opts = {}) => {
    calls.push({ prompt, label: opts.label })
    await new Promise((r) => setImmediate(r))
    if (/-runner(-\d+)?$/.test(String(opts.label))) {
      const m = prompt.match(/factory\.ts\s+(admit|reap|check|integrate|owns-check|tests-check|sync|crew-decision|decision-replies|decision-ack|decision-checkpoint|crew-learned|knowledge-commit|knowledge-lint|decisions|escalate|inbox|resolve)\b([^\n]*)/)
      if (!m) throw new Error(`unparsable runner prompt for label ${opts.label}`)
      const cmd = m[1]
      const expect = (m[2].match(/--expect(?:\s+|=)([^\s`]+)/) || [])[1]
      if (cmd === 'admit') return r127rj({ admitted: true, parallelism: 4, running: 0, freeMB: 8000, minFreeMB: 2048 })
      if (cmd === 'reap') return r127rj({ reaped: [], skipped: [] })
      if (cmd === 'check') return r127rj(expect === 'red' ? { ok: true } : { ok: true, head: R127_HEAD })
      if (cmd === 'owns-check') return r127rj({ ok: true, outside: [] })
      if (cmd === 'tests-check') return r127rj({ ok: true, tests: [] })
      if (cmd === 'crew-decision') return r127rj({ id: 'd1' })
      if (cmd === 'decision-replies') return r127rj([])
      if (cmd === 'decision-ack') return r127rj({ acked: [], already: [] })
      if (cmd === 'decisions') return r127rj({ decisions: [] })
      if (cmd === 'escalate') return r127rj({ id: R127_ITEM, kind: 'pm-question', deduped: false, code: 'XK3P9Q', notified: null })
      if (cmd === 'inbox') {
        const row = { id: R127_ITEM, ts: '2026-11-13T12:30:00.000Z', kind: 'pm-question', session: 'sess-1', crews: ['a'], ref: 'crew-call:a:build-export', blocking: true, title: 'Product call for a', state: 'open', applied: false }
        const seen = itemOpen && calls.some((c) => /-runner/.test(String(c.label)) && /factory\.ts\s+escalate\b/.test(c.prompt))
        return r127rj({ items: seen ? [row] : [], open: seen ? 1 : 0 })
      }
      if (cmd === 'decision-checkpoint' || cmd === 'crew-learned' || cmd === 'knowledge-commit') return r127rj({ ok: true })
      return r127rj({ merged: true })
    }
    if (!Object.hasOwn(labels, opts.label)) throw new Error(`unscripted label: ${opts.label}`)
    await new Promise((r) => setImmediate(r))
    return structuredClone(labels[opts.label])
  })
  const parallel = async (thunks) => Promise.all(thunks.map(async (th) => { try { return await (typeof th === 'function' ? th() : th) } catch { return null } }))
  const pipeline = async (items, ...stages) => Promise.all(items.map(async (item, i) => { try { let prev = item; for (const st of stages) prev = await st(prev, item, i); return prev } catch { return null } }))
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const args = { truss: { kind: 'stage', dir: '/proj/.truss', repo: '/proj', plugin: REAL_PLUGIN, target: 'main', reworkAllowance: 2, roles: R127_ROLES, scriptPath: R127_STAGE, crews: [R127_ENTRY], personas: R127_PERSONAS } }
  const result = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'allowance', body)(agent, parallel, pipeline, () => {}, () => {}, structuredClone(args), {})
  return { result: result.find((x) => x.slug === 'a'), calls }
}

const R127_LABELS = (over) => ({
  'a-planner': { tasks: R127_TASKS, stop: null },
  'a-tester': r127done('feat/t'),
  'a-builder': r127done('feat/b'),
  'a-writer': r127done('feat/w'),
  'a-writer-2': r127done('feat/k'),
  'a-qc': R127_PASS,
  ...over,
})

test('stage.js keeps a three-line stop text as three lines in the crew result', async () => {
  const question = 'Should the export include archived items?\nThey are flagged in the table.\nThe goal file does not say.'
  const labels = R127_LABELS({
    'a-builder': r127done('feat/b', { marker: 'QUESTION', text: question }),
    'a-po': 'PO: ESCALATE\nThe export rule is in scope but the requirements do not settle it.',
  })
  const { result } = await r127stage(labels, true)
  assert.equal(result.state, 'stopped', JSON.stringify(result).slice(0, 500))
  assert.ok(result.text.includes(R127_ITEM), result.text)
  assert.ok(result.text.includes(question), `the three-line question is three lines in the stop text, got:\n${result.text}`)
})

test('stage.js keeps a three-line ruling as three lines in the member prompt', async () => {
  const ruling = 'Include archived items.\nFlag each one in the table.\nLeave deleted items out.'
  const labels = R127_LABELS({
    'a-builder': r127done('feat/b', { marker: 'QUESTION', text: 'Should the export include archived items?' }),
    'a-builder-2': r127done('feat/b2'),
    'a-po': `PO: DECIDE\n${ruling}\nReason: the requirements say export is complete.`,
  })
  const { result, calls } = await r127stage(labels, false)
  assert.equal(result.state, 'passed', JSON.stringify(result).slice(0, 500))
  const next = calls.find((c) => c.label === 'a-builder-2')
  assert.ok(next, 'the asking member was re-spawned with the ruling')
  assert.ok(next.prompt.includes(ruling), `the three-line ruling is three lines in the member prompt, got:\n${next.prompt.slice(0, 3000)}`)
})

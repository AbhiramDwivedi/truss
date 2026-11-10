// @ts-nocheck
// truss 0.25.0 wave 2, A0: the wiring of contract-025 sections 2 and 3 into factory.ts, the stubs, the schemas, stage.js and
// plan.js. Written from the contract before the code. Every module that may not exist yet is imported inside its case, so a
// missing piece fails only the cases that need it. Stubbed seams are test files laid over a private copy of the plugin: the
// copy's bin/inbox.ts (and bin/cost.ts) re-export the real module and override only the seam under test.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  REAL_FACTORY, REAL_PLUGIN, appendEvent, assertOneLine, crew, factorySpawn, mkEnv, mkRun, planObj, pluginCopy, readPlan, runCli, tmp, validate, validateEvent, writeGoal, writePlan,
} from './fixtures/workflow-run/harness.ts'

const BIN = `${REAL_PLUGIN}/bin`
const ROOT = `${REAL_PLUGIN}/../..`
const NOW = '2026-11-10T10:00:00.000Z'
const BLOCK_ID = 'E-20261110-a1b2c3'

// The pieces A0 writes as stubs and the other crews replace; each must exist after A0.
const STUBS = ['inbox', 'guard', 'cost', 'worktypes', 'ledger', 'queue']
const NEW_BIN = ['store', ...STUBS, 'notify-run']
const mustExist = (names: string[]): void => {
  for (const n of names) assert.ok(existsSync(`${BIN}/${n}.ts`), `bin/${n}.ts is missing`)
}

/** A private copy of the plugin whose bin/inbox.ts and bin/cost.ts keep the real module's exports and override the stubbed seams. */
function stubbedPlugin(): string {
  const d = tmp('w025-plugin-')
  cpSync(pluginCopy(), d, { recursive: true })
  const lay = (name: string, override: string): void => {
    const p = `${d}/bin/${name}.ts`
    const real = existsSync(p)
    if (real) renameSync(p, `${d}/bin/${name}-real.ts`)
    writeFileSync(p, `${real ? `export * from './${name}-real.ts'\n` : ''}${override}`)
  }
  lay('inbox', [
    `import { appendFileSync } from 'node:fs'`,
    `export const INBOX_COMMANDS = {}`,
    `export function blockingFor(repo, session, slug) { return slug === process.env.W025_BLOCK_SLUG ? [process.env.W025_BLOCK_ID] : [] }`,
    `export function budgetRaises() { return [] }`,
    `export function escalate() { appendFileSync(process.env.W025_ESC_LOG, 'escalate\\n'); throw new Error('escalate is stubbed to throw') }`,
    '',
  ].join('\n'))
  lay('cost', [
    `export const COST_COMMANDS = {}`,
    `export function budgetVerdict() { return { held: true, scope: 'run', spentUsd: null, limitUsd: 1, why: 'the run budget of 1 USD is spent' } }`,
    `export function crewCost() { return { usd: null, why: 'not recorded' } }`,
    '',
  ].join('\n'))
  return d
}

/** Runs a factory command of `plugin` with --dir and --repo of `env` (flags: {name: value}); extraEnv is laid on the child env. */
function runIn(plugin: string, env: any, command: string, flags: Record<string, string> = {}, extra: string[] = [], extraEnv: Record<string, string> = {}) {
  const args: string[] = []
  for (const [k, v] of Object.entries({ dir: env.dir, repo: env.repo, ...flags })) args.push(`--${k}`, String(v))
  return runCli(`${plugin}/bin/factory.ts`, command, [...args, ...extra], env.repo, extraEnv)
}

const CONFIG = { architecture: 'docs/architecture.md', adr: 'docs/adr' }

test('wiring 025: every new command answers through the stubs', () => {
  const env = mkEnv({ config: CONFIG })
  const id = BLOCK_ID
  const cmds: [string, string[], string[]][] = [
    ['escalate', ['--kind', 'scope-change', '--title', 'a title'], []],
    ['inbox', [], []],
    ['resolve', ['--decision', 'approve', '--by', 'client', '--code', 'ABCDEF'], [id]],
    ['mark-applied', [], [id]],
    ['cost', [], []],
    ['worktypes', [], []],
  ]
  for (const [cmd, flags, positional] of cmds) {
    const args: string[] = []
    for (let i = 0; i < flags.length; i += 2) args.push(flags[i], flags[i + 1])
    const r = runCli(env.factory, cmd, ['--dir', env.dir, '--repo', env.repo, ...args, ...positional], env.repo)
    const j = assertOneLine(r)
    assert.ok([0, 1, 2].includes(r.status as number), `${cmd}: exit ${r.status}`)
    assert.ok(!/unknown command/.test(String(j.error ?? '')), `${cmd} is not a registered command: ${r.stdout}`)
  }
})

test('wiring 025: approve by auto refuses a client goal', () => {
  const env = mkEnv()
  const goal = { id: 'extra', goal: 'a client goal', addedAt: NOW, approval: 'client', approvedAt: null }
  writePlan(env.dir, planObj([crew('alpha'), crew('beta', { goal: 'extra' })], { version: 3, approvedAt: null, goals: [goal] }))
  const r = env.run('approve', { by: 'auto' })
  assert.equal(r.status, 1, `exit 1 expected: ${r.stdout} ${r.stderr}`)
  assert.equal(readPlan(env.dir).approvedAt, null, 'the plan stays unapproved')
  // control: with only auto goals the same command approves
  const ok = mkEnv()
  writePlan(ok.dir, planObj([crew('alpha'), crew('beta', { goal: 'extra' })], { version: 3, approvedAt: null, goals: [{ ...goal, approval: 'auto', approvedAt: NOW }] }))
  assert.equal(ok.run('approve', { by: 'auto' }).status, 0)
})

test('wiring 025: approve by auto refuses a stage-0 crew', () => {
  const env = mkEnv()
  writePlan(env.dir, planObj([crew('design0', { stage: 0, verdict: 'design' }), crew('alpha', { stage: 1 })], { approvedAt: null, approval: 'client' }))
  const r = env.run('approve', { by: 'auto' })
  assert.equal(r.status, 1, `exit 1 expected: ${r.stdout} ${r.stderr}`)
  assert.equal(readPlan(env.dir).approvedAt, null, 'the plan stays unapproved')
  // control: the client can approve the same plan
  assert.equal(env.run('approve', { by: 'client' }).status, 0)
})

test('wiring 025: admit holds on a stubbed blocking id', () => {
  const plugin = stubbedPlugin()
  const env = mkEnv({ config: CONFIG })
  writePlan(env.dir, planObj([crew('alpha')]))
  writeGoal(env.dir, 'alpha')
  const t0 = Date.now()
  const r = runIn(plugin, env, 'admit', { slug: 'alpha', 'wait-ms': '10000' }, [], { W025_BLOCK_SLUG: 'alpha', W025_BLOCK_ID: BLOCK_ID })
  const j = assertOneLine(r)
  assert.equal(r.status, 1, `exit 1 expected: ${r.stdout} ${r.stderr}`)
  assert.equal(j.admitted, false)
  assert.equal(j.awaiting, true, r.stdout)
  assert.ok(String(j.why).includes(`awaiting client: ${BLOCK_ID}`), r.stdout)
  assert.ok(Date.now() - t0 < 8000, 'an awaiting hold does not wait out --wait-ms')
  // a crew that is not linked is admitted by the same stub
  writePlan(env.dir, planObj([crew('alpha'), crew('beta', { stage: 1 })]))
  const free = runIn(plugin, env, 'admit', { slug: 'beta' }, [], { W025_BLOCK_SLUG: 'alpha', W025_BLOCK_ID: BLOCK_ID })
  assert.equal(free.status, 0, `${free.stdout} ${free.stderr}`)
})

test('wiring 025: start refuses the linked crew with awaiting client and the id while another crew starts', () => {
  const plugin = stubbedPlugin()
  const env = mkEnv({ config: CONFIG })
  writePlan(env.dir, planObj([crew('linked'), crew('free')]))
  writeGoal(env.dir, 'linked')
  writeGoal(env.dir, 'free')
  const r = runIn(plugin, env, 'start', { stage: '1' }, [], { W025_BLOCK_SLUG: 'linked', W025_BLOCK_ID: BLOCK_ID })
  const j = assertOneLine(r)
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`)
  const stopped = [...(j.held ?? []), ...(j.refused ?? [])].find((x: any) => x.slug === 'linked')
  assert.ok(stopped, `linked is neither held nor refused: ${r.stdout.slice(0, 600)}`)
  assert.ok(String(stopped.why ?? stopped.reason).includes(`awaiting client: ${BLOCK_ID}`), JSON.stringify(stopped))
  assert.ok((j.truss?.crews ?? []).some((e: any) => e.slug === 'free'), `free did not start: ${r.stdout.slice(0, 600)}`)
  const plan = readPlan(env.dir)
  assert.equal(plan.crews.find((c: any) => c.slug === 'linked').status, 'planned')
  assert.equal(plan.crews.find((c: any) => c.slug === 'free').status, 'running')
})

test('wiring 025: admit still holds when escalate throws', () => {
  const plugin = stubbedPlugin()
  const env = mkEnv({ config: { ...CONFIG, budget: { runUsd: 1 } } })
  writePlan(env.dir, planObj([crew('alpha')]))
  writeGoal(env.dir, 'alpha')
  const log = `${tmp('w025-esc-')}/escalate.log`
  const t0 = Date.now()
  const r = runIn(plugin, env, 'admit', { slug: 'alpha', 'wait-ms': '10000' }, [], { W025_BLOCK_SLUG: 'none', W025_BLOCK_ID: BLOCK_ID, W025_ESC_LOG: log })
  const j = assertOneLine(r)
  assert.equal(r.status, 1, `exit 1 expected: ${r.stdout} ${r.stderr}`)
  assert.equal(j.admitted, false)
  assert.equal(j.budget, true, r.stdout)
  assert.equal(typeof j.why, 'string')
  assert.ok(Date.now() - t0 < 8000, 'a budget hold does not wait out --wait-ms')
  assert.ok(existsSync(log) && readFileSync(log, 'utf8').includes('escalate'), 'the hold tried to escalate, and the throw did not stop it')
})

test('wiring 025: factory re-exports the moved helpers', async () => {
  const store = await import(`${BIN}/store.ts`)
  const factory = await import(REAL_FACTORY)
  for (const name of ['CliError', 'usage', 'refuse', 'flat', 'str', 'need', 'listOf', 'isObj', 'readText', 'readJson', 'parseLabel', 'repoPathOf', 'configOf']) {
    assert.equal(typeof store[name], 'function', `store.ts does not export ${name}`)
    assert.equal(factory[name], store[name], `factory.ts does not re-export ${name} from store.ts`)
  }
})

// ---------------------------------------------------------------------------------------------------------------
// Static scans. Each scanner runs on a planted counter-example first and must flag it.

const codeLines = (text: string): string[] => text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))

/** Every module specifier a source text imports, exports from, dynamically imports or requires. */
function specifiersOf(text: string): string[] {
  const re = /(?:\bimport|\bexport)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  return [...codeLines(text).join('\n').matchAll(re)].map((m) => m[1] ?? m[2] ?? m[3])
}
const importsFactory = (text: string): string[] => specifiersOf(text).filter((s) => /(^|\/)factory(\.ts)?$/.test(s))
const badImports = (text: string): string[] => specifiersOf(text).filter((s) => !s.startsWith('node:') && !s.startsWith('.'))

const TERMS: [string, RegExp][] = [
  ['/tmp', /\/tmp\b/g],
  ['flock', /\bflock\b/g],
  ['fs.watch', /\bfs\.watch\b/g],
  ['sh -c', /\bsh -c\b|['"]sh['"]\s*,\s*\[\s*['"]-c['"]/g],
]
const FORBIDS = /\b(?:no|never|not|nor|don't|without|forbidden|avoid)\b/i
/** The uses of a forbidden term in `text`; a use on a line that names the term as forbidden is allowed. */
function forbiddenUses(text: string): { n: number; term: string }[] {
  const hits: { n: number; term: string }[] = []
  text.split('\n').forEach((line, i) => {
    for (const [term, re] of TERMS) {
      for (const m of line.matchAll(re)) if (!FORBIDS.test(line.slice(Math.max(0, (m.index ?? 0) - 60), m.index ?? 0))) hits.push({ n: i + 1, term })
    }
  })
  return hits
}

test('wiring 025: no new bin module imports factory', () => {
  assert.deepEqual(importsFactory(`import { x } from './factory.ts'\n`), ['./factory.ts'], 'the scanner misses a planted static import')
  assert.deepEqual(importsFactory(`const m = await import("../bin/factory.ts")\n`), ['../bin/factory.ts'], 'the scanner misses a planted dynamic import')
  assert.deepEqual(importsFactory(`import { y } from './store.ts'\n// imports nothing from factory\n`), [], 'the scanner flags a clean file')
  mustExist(['store', ...STUBS])
  for (const n of NEW_BIN) {
    if (!existsSync(`${BIN}/${n}.ts`)) continue
    assert.deepEqual(importsFactory(readFileSync(`${BIN}/${n}.ts`, 'utf8')), [], `bin/${n}.ts imports factory.ts`)
  }
})

test('wiring 025: every import in the new bin modules is a node: builtin or a relative path, package.json gains no dependencies, and a planted import is caught', () => {
  const planted = `import a from 'ajv'\nimport { b } from "lodash/fp"\nconst c = require('chalk')\nconst d = await import('left-pad')\nimport 'dotenv'\n`
  assert.deepEqual(badImports(planted), ['ajv', 'lodash/fp', 'chalk', 'left-pad', 'dotenv'], 'the scanner misses a planted package import')
  assert.deepEqual(badImports(`import fs from 'node:fs'\nimport type { T } from "node:path"\nimport { s } from './store.ts'\nexport * from '../x.ts'\n`), [], 'the scanner flags builtins or relative paths')
  mustExist(['store', ...STUBS])
  for (const n of NEW_BIN) {
    if (!existsSync(`${BIN}/${n}.ts`)) continue
    assert.deepEqual(badImports(readFileSync(`${BIN}/${n}.ts`, 'utf8')), [], `bin/${n}.ts imports something other than a node: builtin or a relative path`)
  }
  const KEYS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies']
  const depsOf = (text: string): Record<string, string[]> => {
    const pkg = JSON.parse(text)
    return Object.fromEntries(KEYS.filter((k) => pkg[k] !== undefined).map((k) => [k, Object.keys(pkg[k]).sort()]))
  }
  const now = depsOf(readFileSync(`${ROOT}/package.json`, 'utf8'))
  assert.deepEqual(now, {}, 'the repo-root package.json declares dependencies')
  const committed = spawnSync('git', ['-c', 'core.quotepath=off', 'show', 'HEAD:package.json'], { cwd: ROOT, encoding: 'utf8', windowsHide: true })
  assert.equal(committed.status, 0, `git show HEAD:package.json failed: ${committed.stderr}`)
  assert.deepEqual(now, depsOf(committed.stdout), 'package.json gains dependencies against the committed HEAD')
})

test('wiring 025: no new bin module, workflow script, wave-2 test or truss prose uses /tmp, flock, fs.watch or sh -c, and a planted use is caught', () => {
  const planted: [string, string][] = [
    [`const p = '/tmp/truss-x'`, '/tmp'],
    [`spawnSync('flock', ['-n', lockFile, 'cmd'])`, 'flock'],
    [`const w = fs.watch(dir, cb)`, 'fs.watch'],
    [`spawnSync('sh', ['-c', text])`, 'sh -c'],
    [`run: sh -c "echo hi"`, 'sh -c'],
  ]
  for (const [line, term] of planted) assert.deepEqual(forbiddenUses(line).map((h) => h.term), [term], `the scanner misses a planted use: ${line}`)
  assert.deepEqual(forbiddenUses('No `/tmp`, no `flock`, no `fs.watch`, never `sh -c`.'), [], 'the scanner flags a line that names the terms as forbidden')
  assert.deepEqual(forbiddenUses('Tests never use `sh -c` and make temp dirs with os.tmpdir().'), [], 'the scanner flags an allowed line')

  mustExist(['store', ...STUBS])
  const files: string[] = NEW_BIN.map((n) => `${BIN}/${n}.ts`)
  for (const f of readdirSync(`${REAL_PLUGIN}/workflows`)) if (f.endsWith('.js')) files.push(`${REAL_PLUGIN}/workflows/${f}`)
  for (const t of ['store', 'plan-worktype', 'inbox', 'ltc-guard', 'ltc-paragraph', 'cost', 'worktypes', 'ledger', 'queue', 'unattended', 'brief-unattended', 'agent-prose-025', 'autonomy-prose']) files.push(`${REAL_PLUGIN}/tests/${t}.check.ts`)
  for (const f of readdirSync(`${REAL_PLUGIN}/agents`)) if (f.endsWith('.md')) files.push(`${REAL_PLUGIN}/agents/${f}`)
  for (const s of ['run', 'retro', 'init', 'inbox', 'brief']) files.push(`${REAL_PLUGIN}/skills/${s}/SKILL.md`)
  const found: string[] = []
  let scanned = 0
  for (const f of files) {
    if (!existsSync(f)) continue
    scanned++
    for (const h of forbiddenUses(readFileSync(f, 'utf8'))) found.push(`${f.slice(REAL_PLUGIN.length + 1)}:${h.n} ${h.term}`)
  }
  assert.ok(scanned >= 7 + 2, `only ${scanned} files scanned`)
  assert.deepEqual(found, [], 'forbidden uses found')
})

// ---------------------------------------------------------------------------------------------------------------

// The paragraph is asserted on the prompts the stubbed agent() receives, in tests/workflows.check.ts; this test runs those two cases.
test('wiring 025: qcPrompt and checkerPrompt carry the long-term cost paragraph', () => {
  const r = spawnSync(process.execPath, ['--test', '--test-name-pattern=the prompt the (qc|checker) agent receives carries the long-term cost paragraph', `${REAL_PLUGIN}/tests/workflows.check.ts`], { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } })
  assert.equal(r.status, 0, (r.stdout ?? '') + (r.stderr ?? ''))
  assert.match(r.stdout, /pass 2\b/, 'both prompt cases ran')
  assert.match(r.stdout, /fail 0\b/)
})
test('wiring 025: the events schema accepts each new kind', () => {
  const base = { v: 1, ts: NOW, crew: 'alpha' }
  const rows: Record<string, any> = {
    escalate: { id: BLOCK_ID, kind: 'scope-change', blocking: true },
    resolve: { id: BLOCK_ID, decision: 'approve', by: 'client' },
    'notify-error': { id: BLOCK_ID, error: 'spawn failed' },
    'budget-hold': { scope: 'run', spentUsd: 1.5, limitUsd: 1 },
    intake: { source: 'md', added: 2, seen: 5 },
    unattended: { on: true, item: null },
    ltc: { id: BLOCK_ID, scope: 'plan', reversal: 'costly' },
  }
  for (const [event, body] of Object.entries(rows)) {
    const row = { ...base, event, ...body }
    assert.deepEqual(validateEvent(row), [], `${event}: a valid row is refused`)
    // a field the kind does not declare is refused; the kinds carry no agent field and still pass
    assert.notDeepEqual(validateEvent({ ...row, bogus: 1 }), [], `${event}: an undeclared field is accepted`)
  }
  for (const scope of ['run', 'crew', 'workType', 'session']) assert.deepEqual(validateEvent({ ...base, event: 'budget-hold', scope, spentUsd: null, limitUsd: 2 }), [], `budget-hold scope ${scope}`)
  assert.deepEqual(validateEvent({ ...base, event: 'unattended', on: false, item: null }), [])
  assert.deepEqual(validateEvent({ ...base, event: 'ltc', id: null, scope: 'plan', reversal: 'irreversible' }), [], 'ltc with a null id')
  assert.notDeepEqual(validateEvent({ ...base, event: 'budget-hold', scope: 'galaxy', spentUsd: null, limitUsd: 1 }), [], 'an unknown budget scope is accepted')
  assert.notDeepEqual(validateEvent({ ...base, event: 'notify-error', id: BLOCK_ID, error: 'x'.repeat(201) }), [], 'a notify-error longer than 200 is accepted')
  assert.notDeepEqual(validateEvent({ ...base, event: 'ltc', id: null, scope: 'plan', reversal: 'maybe' }), [], 'an unknown reversal is accepted')
  assert.notDeepEqual(validateEvent({ ...base, event: 'escalate', id: BLOCK_ID, kind: 'scope-change' }), [], 'an escalate without blocking is accepted')
})

test('wiring 025: the config schema accepts notify, pricing, budget, workTypes and intake and refuses an unknown key', () => {
  const schema = JSON.parse(readFileSync(`${REAL_PLUGIN}/docs/truss-config.schema.json`, 'utf8'))
  assert.equal(schema.additionalProperties, false)
  for (const k of ['notify', 'pricing', 'budget', 'workTypes', 'intake']) assert.ok(schema.properties?.[k], `the schema has no ${k} property`)
  const zero = { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWrite5mPerMTok: 0, cacheWrite1hPerMTok: 0 }
  const cfg = {
    ...CONFIG,
    notify: 'notify-send truss',
    pricing: { 'claude-model-prefix': { ...zero, fast: { ...zero } } },
    budget: { runUsd: 5, crewUsd: 2, sessionUsd: 10, workTypes: { feature: { crewUsd: 1 } } },
    workTypes: { migration: { minProcess: 'full', stressTest: true, red: true } },
    intake: { sources: ['md', 'gh'], queueFile: 'docs/queue.md', ghLabel: 'truss', claimTtlHours: 24 },
  }
  assert.deepEqual(validate(schema, cfg), [], 'a config with the new keys is refused')
  assert.deepEqual(validate(schema, CONFIG), [], 'a config without them is refused')
  assert.notDeepEqual(validate(schema, { ...cfg, bogus: true }), [], 'an unknown key is accepted')
  assert.notDeepEqual(validate(schema, { ...cfg, notify: 5 }), [], 'a non-string notify is accepted')
  assert.notDeepEqual(validate(schema, { ...cfg, intake: { sources: ['svn'] } }), [], 'an unknown intake source is accepted')
  assert.notDeepEqual(validate(schema, { ...cfg, intake: { bogus: 1 } }), [], 'an unknown intake key is accepted')
})

/** A finish world: crew s running, its stage run, and a second plan run whose agents carry `planLabels` (label -> agentType). Returns finish's audit list. */
function auditOf(planLabels: [string, string][]): { label: string; why: string }[] {
  const env = mkEnv({ config: { merge: 'sequential', target: 'main' } })
  writePlan(env.dir, planObj([crew('s', { status: 'running', owns: ['src/s/**'], acceptanceTest: 'true' })], { approvedAt: '2026-10-01T00:00:00.000Z' }))
  appendEvent(env.dir, factorySpawn('s', new Date(Date.now() - 3 * 3600_000).toISOString()))
  const agent = { metaModel: 'opus', model: 'claude-opus-5-5', effort: 'medium', startTs: '2026-10-29T09:00:00.000Z' }
  const run = mkRun(env.transcripts, 'wf_1', [{ ...agent, label: 's-builder', metaModel: 'sonnet', model: 'claude-sonnet-5-5', result: 'built it' }])
  mkRun(env.transcripts, 'wf_plan', planLabels.map(([label, agentType]) => ({ ...agent, label, agentType })))
  const resFile = `${env.dir}/result.json`
  writeFileSync(resFile, JSON.stringify([]))
  const j = assertOneLine(env.run('finish', { transcript: run.dir, result: resFile }))
  return j.audit ?? []
}

test("wiring 025: the session audit counts a plan run labelled truss-designer, truss-checker, truss-po, truss-designer-2, truss-po-2 and truss-checker-2 as truss's", () => {
  const audit = auditOf([
    ['truss-designer', 'truss:design-engineer'], ['truss-checker', 'truss:checking-engineer'], ['truss-po', 'truss:judge'],
    ['truss-designer-2', 'truss:design-engineer'], ['truss-po-2', 'truss:judge'], ['truss-checker-2', 'truss:checking-engineer'],
  ])
  assert.deepEqual(audit.filter((a) => a.label.startsWith('wf_plan/')), [], `the plan run is flagged: ${JSON.stringify(audit)}`)
})

test('wiring 025: the session audit still flags a plan run with the label truss-designer-po', () => {
  const audit = auditOf([['truss-designer', 'truss:design-engineer'], ['truss-designer-po', 'truss:judge']])
  assert.ok(audit.some((a) => a.label.startsWith('wf_plan/')), `the unparsable label is not flagged: ${JSON.stringify(audit)}`)
})

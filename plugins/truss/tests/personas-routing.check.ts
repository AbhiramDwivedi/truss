// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0032, route by persona. Written from the contract before the change.
//   1. factory start builds `personas` into the stage args from <repo>/.claude/agents/*.md
//   2. the planner schema and brief carry a persona per task; validateTasks rejects an unknown or read-only persona
//   3. spawn takes the persona's type (loaded) or general-purpose with its body inlined (not loaded), its model, the higher effort
//   4. the ## Members line applies only to persona-null tasks; a resolver or fix member inherits the task's persona
//   5. the QC brief lists the persona files and the judges; admit records the persona
//   6. factory persona-install copies, validates and commits persona files
// Run with: node --test tests/personas-routing.check.ts

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { crew, git, mkRepo, mkTrussDir, planObj, runCli, tmp, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')
const FACTORY = `${PLUGIN}/bin/factory.ts`
const PATHS = { 'stage.js': `${PLUGIN}/workflows/stage.js` }
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
}

// ---------------------------------------------------------------- stage.js harness (from tests/stage-fixes5.check.ts)

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const tick = () => new Promise((r) => setImmediate(r))
const ticks = async (n) => {
  for (let i = 0; i < n; i++) await tick()
}
const rj = (obj, exit = 0) => ({ exit, stdout: JSON.stringify(obj) })

async function exec(file, args, o = {}) {
  const body = readFileSync(PATHS[file], 'utf8').replace(/^\s*export\s+const\s+meta\b/m, 'const meta')
  const calls = []
  const unscripted = []
  const counters = {}
  const agent = async (prompt, opts = {}) => {
    const call = { prompt, opts, label: opts.label, i: calls.length }
    calls.push(call)
    await tick()
    if (/-runner(-\d+)?$/.test(String(opts.label))) {
      const m = prompt.match(/factory\.ts\s+(admit|reap|check|integrate|owns-check|tests-check|sync|decision-checkpoint|crew-learned|knowledge-commit|decision-ack|decisions)\b([^\n`]*)/)
      if (!m) {
        unscripted.push(`${opts.label} (no factory.ts command in prompt)`)
        throw new Error(`unparsable runner prompt for label ${opts.label}`)
      }
      const cmd = m[1]
      const flag = (name) => (m[2].match(new RegExp(`--${name}\\s+([^\\s\`]+)`)) || [])[1]
      const slug = flag('slug')
      const expect = flag('expect')
      const branch = flag('branch')
      const key = cmd === 'check' ? `check:${expect}` : cmd === 'integrate' ? `integrate:${branch}` : cmd
      const name = `runner:${slug}:${key}`
      call.runner = { cmd, slug, expect, branch, key, name }
      const n = (counters[name] = (counters[name] ?? -1) + 1)
      let out = o.runner ? await o.runner({ cmd, key, slug, expect, branch, n, prompt, call }) : undefined
      if (out === undefined) {
        const plain = expect === 'red' ? { ok: true } : { ok: true, head: HEAD }
        out =
          cmd === 'admit' ? rj({ admitted: true, parallelism: 4, running: 0, freeMB: 8000, minFreeMB: 2048 }) : cmd === 'reap' ? rj({ reaped: [], skipped: [] }) : cmd === 'check' ? rj(plain) : cmd === 'integrate' ? rj({ merged: true }) : cmd === 'owns-check' ? rj({ ok: true, outside: [] }) : cmd === 'tests-check' ? rj({ ok: true, tests: [] }) : rj({ merged: true })
      }
      await ticks(cmd === 'integrate' ? 3 : 1)
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
  const pipeline = async (items, ...stages) =>
    Promise.all(items.map(async (item, i) => {
      try {
        let prev = item
        for (const st of stages) prev = await st(prev, item, i)
        return prev
      } catch {
        return null
      }
    }))
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
const done = (branch) => ({ task: 'whatever', marker: 'DONE', branch, commit: 'c0'.repeat(20), proof: 'PROOF-' + branch, text: 'finished ' + branch })

const PERSONAS = {
  'frontend-ui-developer': { agentType: 'frontend-ui-developer', model: 'opus', effort: 'high', file: '/proj/.claude/agents/frontend-ui-developer.md', description: 'React design system and UI components', readOnly: false, loaded: true },
  'backend-service-architect': { agentType: 'backend-service-architect', model: 'sonnet', effort: 'medium', file: '/proj/.claude/agents/backend-service-architect.md', description: 'Java services', readOnly: false, loaded: false, body: 'BODY-BACKEND line one\nBODY-BACKEND line two\n' },
  'product-owner': { agentType: 'product-owner', model: 'opus', effort: 'medium', file: '/proj/.claude/agents/product-owner.md', description: 'Judges the product fit', readOnly: true, loaded: true },
}
const TT = { name: 'write-tests', role: 'tester', effort: 'medium', persona: 'frontend-ui-developer', files: ['tests/a.check.ts'], reads: [], brief: 'BRIEF-TT', after: [] }
const TF = { name: 'build-ui', role: 'builder', effort: 'low', persona: 'frontend-ui-developer', files: ['src/ui/a.ts'], reads: [], brief: 'BRIEF-TF', after: ['write-tests'] }
const TB = { name: 'build-svc', role: 'builder', effort: 'high', persona: 'backend-service-architect', files: ['src/svc/b.ts'], reads: [], brief: 'BRIEF-TB', after: ['write-tests'] }
const TN = { name: 'build-misc', role: 'builder', effort: 'medium', persona: null, files: ['src/misc/c.ts'], reads: [], brief: 'BRIEF-TN', after: ['write-tests'] }
const PLAN = (...tasks) => ({ tasks, stop: null })

const OLD = (slug = 'a', o = {}) => ({
  slug, stage: 1, goalFile: `/proj/.truss/goals/${slug}.md`, goal: 'GOAL-TEXT', owns: ['src/**', 'tests/*.ts'],
  acceptanceTest: 'node --test tests/a.check.ts', highImpact: ['src/core/**'], stressTest: false, scope: 'SCOPE-VERBATIM: build a, nothing else',
  worktree: `/wt/${slug}`, branch: `truss/${slug}`, base: BASE, architecture: '/proj/docs/ARCH.md', adrs: [],
  resume: null, tasks: [], done: [], answers: [], spent: 0, labelFrom: {}, ...o,
})
const stageArgs = (crews, o = {}) => ({
  truss: { kind: 'stage', dir: '/proj/.truss', repo: '/proj', plugin: PLUGIN, target: 'main', reworkAllowance: 2, roles: ROLES, scriptPath: PATHS['stage.js'], crews, ...(o.personas === undefined ? {} : { personas: o.personas }) },
})
async function runStage(crews, o = {}) {
  const r = await exec('stage.js', stageArgs(crews, o), o)
  if (r.error) throw r.error
  return r
}
const why = (r) => `result ${JSON.stringify(r.result).slice(0, 500)}; labels ${r.labels.join(',')}; unscripted ${r.unscripted.join(',')}`
const has = (s, sub) => assert.ok(s.includes(sub), `missing ${JSON.stringify(sub)} in:\n${s.slice(0, 2500)}`)
const hasnt = (s, sub) => assert.ok(!s.includes(sub), `unexpected ${JSON.stringify(sub)} in:\n${s.slice(0, 2500)}`)
// the member spawn whose prompt carries `Task: <name>`
const spawnOf = (r, name) => r.calls.find((c) => !c.runner && c.prompt.includes(`Task: ${name}\n`))
const passed = (r, slug = 'a') => assert.equal(r.result.find((x) => x.slug === slug).state, 'passed', why(r))
const membersDone = { 'a-tester': done('feat/t'), 'a-builder': done('feat/b'), 'a-builder-2': done('feat/b2'), 'a-builder-3': done('feat/b3') }
const labelsFor = (...tasks) => ({ 'a-planner': PLAN(...tasks), ...membersDone, 'a-qc': PASS })

// ---------------------------------------------------------------- planner schema, brief, validation

t('persona 1: the planner schema carries persona (string or null, required) and effort high', async () => {
  const r = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor(TT, TF) })
  const schema = r.calls.find((c) => c.label === 'a-planner').opts.schema
  const item = schema.properties.tasks.items
  assert.ok(item.required.includes('persona'), 'persona is required')
  const p = JSON.stringify(item.properties.persona)
  assert.ok(p.includes('string') && p.includes('null'), p)
  assert.deepEqual(item.properties.effort.enum, ['low', 'medium', 'high'])
})

t('persona 2: the planner brief lists every persona with its description and read-only flag, and the routing rule', async () => {
  const r = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor(TT, TF) })
  const p = r.calls.find((c) => c.label === 'a-planner').prompt
  for (const [n, v] of Object.entries(PERSONAS)) {
    has(p, n)
    has(p, v.description)
  }
  assert.match(p, /product-owner[^\n]*read-only/i)
  assert.doesNotMatch(p, /frontend-ui-developer[^\n]*read-only/i)
  has(p, 'a task never spans two personas')
  has(p, 'null only when no persona fits')
})

t('persona 3: an unknown persona and a read-only persona are plan errors, the planner is asked again, and a null persona and effort high pass', async () => {
  const bad1 = { ...TF, persona: 'no-such-persona' }
  const bad2 = { ...TB, persona: 'product-owner' }
  const labels = { ...labelsFor(TT, TF), 'a-planner': PLAN(TT, bad1, bad2), 'a-planner-2': PLAN(TT, TF, { ...TN, effort: 'high' }) }
  const r = await runStage([OLD()], { personas: PERSONAS, labels })
  const second = r.calls.find((c) => c.label === 'a-planner-2')
  assert.ok(second, `no second planner: ${why(r)}`)
  has(second.prompt, 'build-ui')
  has(second.prompt, 'no-such-persona')
  has(second.prompt, 'build-svc')
  has(second.prompt, 'product-owner')
  passed(r)
})

// ---------------------------------------------------------------- spawn

t('persona 4: a loaded persona spawns as its own type with its model and max(persona effort, task effort)', async () => {
  const r = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor(TT, TF) })
  const b = spawnOf(r, 'build-ui')
  assert.equal(b.opts.agentType, 'frontend-ui-developer')
  assert.equal(b.opts.model, 'opus')
  assert.equal(b.opts.effort, 'high', 'persona high beats task low')
  assert.equal(b.opts.isolation, 'worktree', 'isolation stays the role row')
  hasnt(b.prompt, 'persona. Its definition follows')
  has(b.prompt, 'Truss-Role: builder')
  const tt = spawnOf(r, 'write-tests')
  assert.equal(tt.opts.agentType, 'frontend-ui-developer')
  assert.equal(tt.opts.effort, 'high')
  has(tt.prompt, 'Truss-Role: test-writer')
  passed(r)
})

t('persona 5: an unloaded persona spawns as general-purpose with its body inlined before the brief, under the fixed header', async () => {
  const r = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor(TT, TB) })
  const b = spawnOf(r, 'build-svc')
  assert.equal(b.opts.agentType, 'general-purpose')
  assert.equal(b.opts.model, 'sonnet')
  assert.equal(b.opts.effort, 'high', 'task high beats persona medium')
  assert.ok(b.prompt.startsWith('You are the backend-service-architect persona. Its definition follows and is your system prompt for this task:\n\nBODY-BACKEND line one\nBODY-BACKEND line two\n---\n'), b.prompt.slice(0, 300))
  has(b.prompt, 'You are the builder for crew a.')
  passed(r)
})

t('persona 6: the ## Members line is ignored for a persona task and honoured for a null-persona task', async () => {
  const members = { builder: { model: 'opus', effort: 'high' }, tester: { model: 'opus', effort: 'low' } }
  const r = await runStage([OLD('a', { members })], { personas: PERSONAS, labels: labelsFor(TT, TF, TN) })
  const f = spawnOf(r, 'build-ui')
  assert.equal(f.opts.agentType, 'frontend-ui-developer')
  assert.equal(f.opts.effort, 'high')
  const tt = spawnOf(r, 'write-tests')
  assert.equal(tt.opts.model, 'opus')
  assert.equal(tt.opts.effort, 'high', 'persona effort stands over ## Members low')
  const n = spawnOf(r, 'build-misc')
  assert.equal(n.opts.agentType, 'proj:builder')
  assert.equal(n.opts.model, 'opus')
  assert.equal(n.opts.effort, 'high')
  passed(r)
})

t('persona 7: a null-persona builder keeps its role row, and its task effort high is accepted', async () => {
  const r = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor({ ...TT, persona: null }, { ...TN, effort: 'high' }) })
  const n = spawnOf(r, 'build-misc')
  assert.equal(n.opts.agentType, 'proj:builder')
  assert.equal(n.opts.model, 'sonnet')
  assert.equal(n.opts.effort, 'high')
  assert.equal(spawnOf(r, 'write-tests').opts.agentType, 'proj:tester')
  passed(r)
})

t('persona 8: a resolver for a persona task inherits the persona (loaded: its type; unloaded: general-purpose with the body)', async () => {
  const runner = ({ cmd, branch, n }) => (cmd === 'integrate' && branch === 'feat/b' && n === 0 ? rj({ merged: false, conflicts: ['src/x.ts'] }, 1) : undefined)
  const labels = (...tasks) => ({ ...labelsFor(...tasks), 'a-resolver': done('feat/res') })
  const tester = { ...TT, persona: null }
  const loaded = await runStage([OLD()], { personas: PERSONAS, labels: labels(tester, TF), runner })
  const res = loaded.calls.find((c) => c.label === 'a-resolver')
  assert.ok(res, `no resolver spawned: ${why(loaded)}`)
  assert.equal(res.opts.agentType, 'frontend-ui-developer')
  assert.equal(res.opts.model, 'opus')
  assert.equal(res.opts.effort, 'high')
  assert.equal(res.opts.isolation, undefined, 'resolver isolation stays none')
  const unloaded = await runStage([OLD()], { personas: PERSONAS, labels: labels(tester, TB), runner })
  const res2 = unloaded.calls.find((c) => c.label === 'a-resolver')
  assert.equal(res2.opts.agentType, 'general-purpose')
  has(res2.prompt, 'You are the backend-service-architect persona.')
  has(res2.prompt, 'BODY-BACKEND line one')
})

t('persona 9: admit records the persona of a persona task (--persona) and omits it for a null-persona task', async () => {
  const r = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor(TT, TF, TN) })
  const admits = r.calls.filter((c) => c.runner?.cmd === 'admit').map((c) => c.prompt)
  assert.ok(admits.some((p) => /--persona\s+frontend-ui-developer/.test(p) && p.includes('a-builder')), JSON.stringify(admits.map((p) => p.slice(-200))))
  assert.ok(admits.some((p) => p.includes('--label') && !p.includes('--persona')), 'a spawn without a persona carries none')
})

// ---------------------------------------------------------------- QC brief

t('persona 10: the QC brief lists the used persona files and every judge file under the Standards line; none used and none read-only omits it', async () => {
  const r = await runStage([OLD()], { personas: PERSONAS, labels: labelsFor(TT, TF) })
  const q = r.calls.find((c) => c.label === 'a-qc').prompt
  has(q, 'Standards: hold the diff to the Standards section of each of these persona files; quote the item you rule on:')
  has(q, '/proj/.claude/agents/frontend-ui-developer.md')
  has(q, '/proj/.claude/agents/product-owner.md')
  hasnt(q, '/proj/.claude/agents/backend-service-architect.md')
  const none = await runStage([OLD()], { personas: {}, labels: labelsFor({ ...TT, persona: null }, { ...TN, persona: null }) })
  hasnt(none.calls.find((c) => c.label === 'a-qc').prompt, 'Standards:')
})

// ---------------------------------------------------------------- factory start builds personas

const HOUR = 3_600_000
const LONG_AGO = 1_700_000_000_000
const fm = (o, body = '## Standards\n- one rule\n') => `---\n${Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n${body}`
const agentsDir = (repo) => `${repo}/.claude/agents`
function put(p, text, ageMs = LONG_AGO) {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
  utimesSync(p, ageMs / 1000, ageMs / 1000)
}
function startWorld() {
  const repo = mkRepo({ config: { merge: 'sequential', target: 'main' } })
  const dir = mkTrussDir()
  writePlan(dir, planObj([crew('p')]))
  writeGoal(dir, 'p', {})
  return { repo, dir }
}
const startOf = (w) => runCli(FACTORY, 'start', ['--stage', 'next', '--dir', w.dir, '--repo', w.repo], w.repo, { TRUSS_SESSION_START: String(Date.now() - HOUR) })

t('persona 11: start builds personas from .claude/agents: editing vs read-only, defaults, loaded, a symlinked file, a malformed file skipped with a warning', async () => {
  const w = startWorld()
  const A = agentsDir(w.repo)
  put(`${A}/frontend-ui-developer.md`, fm({ name: 'frontend-ui-developer', description: 'React design system', tools: 'Read, Write, Edit, Bash', model: 'opus', effort: 'high' }))
  put(`${A}/product-owner.md`, fm({ name: 'product-owner', description: 'Judges product fit', tools: 'Read, Grep' }))
  put(`${A}/ai-service-developer.md`, fm({ name: 'ai-service-developer', description: 'LLM services' }), Date.now())
  put(`${w.repo}/.agents/postgres-db-architect.md`, fm({ name: 'postgres-db-architect', description: 'Postgres schemas', tools: 'Read, Edit' }))
  let linked = true
  try {
    symlinkSync('../../.agents/postgres-db-architect.md', `${A}/postgres-db-architect.md`)
  } catch {
    linked = false
  }
  put(`${A}/broken.md`, 'no frontmatter here\n')
  put(`${A}/long-one.md`, fm({ name: 'long-one', description: 'x'.repeat(500) }))
  const r = startOf(w)
  assert.equal(r.status, 0, r.stdout.slice(0, 500) + r.stderr)
  const ps = r.json.truss.personas
  const fe = ps['frontend-ui-developer']
  assert.deepEqual({ ...fe, file: undefined }, { agentType: 'frontend-ui-developer', model: 'opus', effort: 'high', file: undefined, description: 'React design system', readOnly: false, loaded: true })
  assert.equal(fe.file, `${A}/frontend-ui-developer.md`)
  assert.equal(ps['product-owner'].readOnly, true)
  const ai = ps['ai-service-developer']
  assert.equal(ai.model, 'sonnet')
  assert.equal(ai.effort, 'medium')
  assert.equal(ai.readOnly, false, 'no tools line is an editing persona')
  assert.equal(ai.loaded, false, 'a file newer than the session start is not loaded')
  assert.equal(ai.body, '## Standards\n- one rule','an unloaded persona carries its body, frontmatter stripped')
  assert.equal(ps['long-one'].description.length, 400)
  assert.ok(!('broken' in ps), 'a malformed file is skipped')
  assert.ok(r.json.warnings.some((x) => x.includes('broken.md')), JSON.stringify(r.json.warnings))
  if (linked) {
    const pg = ps['postgres-db-architect']
    assert.ok(pg, 'a symlinked persona is read through the link')
    assert.equal(pg.file, `${A}/postgres-db-architect.md`)
    assert.equal(pg.readOnly, false)
    assert.equal(pg.loaded, true)
  }
})

t('persona 12: start with no .claude/agents directory has personas {}', async () => {
  const r = startOf(startWorld())
  assert.equal(r.status, 0, r.stdout.slice(0, 500))
  assert.deepEqual(r.json.truss.personas, {})
})

// ---------------------------------------------------------------- persona-install

const installWorld = (files) => {
  const repo = mkRepo({})
  const from = tmp('persona-from-')
  for (const [n, text] of Object.entries(files)) writeFileSync(`${from}/${n}`, text)
  return { repo, from }
}
const GOOD = (name, extra = {}) => fm({ name, description: `${name} does things`, ...extra })
const install = (w, ...more) => runCli(FACTORY, 'persona-install', ['--from', w.from, '--repo', w.repo, ...more], w.repo)

t('persona 13: persona-install copies the files, commits once on the current branch, and prints installed/skipped/commit', async () => {
  const w = installWorld({ 'ai-service-developer.md': GOOD('ai-service-developer', { model: 'opus', effort: 'high' }), 'postgres-db-architect.md': GOOD('postgres-db-architect'), 'notes.txt': 'ignored' })
  const r = install(w)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(r.json.installed.slice().sort(), ['ai-service-developer', 'postgres-db-architect'])
  assert.deepEqual(r.json.skipped, [])
  assert.match(r.json.commit, /^[0-9a-f]{40}$/)
  assert.equal(readFileSync(`${w.repo}/.claude/agents/ai-service-developer.md`, 'utf8'), readFileSync(`${w.from}/ai-service-developer.md`, 'utf8'))
  assert.ok(!existsSync(`${w.repo}/.claude/agents/notes.txt`))
  assert.equal(git(w.repo, ['log', '-1', '--format=%s']), 'chore(agents): add personas ai-service-developer, postgres-db-architect')
  assert.equal(git(w.repo, ['rev-parse', 'HEAD']), r.json.commit)
  assert.equal(git(w.repo, ['status', '--porcelain', '--', '.claude/agents']), '')
  // again: identical bytes are skipped silently, nothing to commit
  const again = install(w)
  assert.equal(again.status, 0, again.stdout + again.stderr)
  assert.deepEqual(again.json, { installed: [], skipped: [], commit: null })
})

t('persona 14: persona-install refuses bad names, mismatched or missing frontmatter, a bad model or effort, with one stderr line and nothing copied', async () => {
  const cases = {
    'a non-kebab file name': { 'Bad_Name.md': GOOD('Bad_Name') },
    'a name that differs from the file name': { 'one.md': GOOD('two') },
    'a missing description': { 'one.md': fm({ name: 'one' }) },
    'a model that is not opus or sonnet': { 'one.md': GOOD('one', { model: 'haiku' }) },
    'an effort that is not low, medium or high': { 'one.md': GOOD('one', { effort: 'max' }) },
    'no frontmatter': { 'one.md': 'just text\n' },
  }
  for (const [what, files] of Object.entries(cases)) {
    const w = installWorld({ ...files, 'fine.md': GOOD('fine') })
    const r = install(w)
    assert.notEqual(r.status, 0, `${what}: ${r.stdout}`)
    assert.equal(r.stderr.trim().split('\n').length, 1, `${what}: stderr ${JSON.stringify(r.stderr)}`)
    assert.ok(r.stderr.trim() !== '' && !r.stdout.includes('unknown command'), `${what}: stderr ${JSON.stringify(r.stderr)} stdout ${r.stdout}`)
    assert.ok(!existsSync(`${w.repo}/.claude/agents/fine.md`), `${what}: a refusal copies nothing`)
  }
})

t('persona 15: persona-install skips an existing file with different bytes unless --replace', async () => {
  const w = installWorld({ 'one.md': GOOD('one') })
  assert.equal(install(w).status, 0)
  writeFileSync(`${w.from}/one.md`, GOOD('one', { model: 'opus' }))
  const keep = install(w)
  assert.equal(keep.status, 0, keep.stdout + keep.stderr)
  assert.deepEqual(keep.json, { installed: [], skipped: ['one'], commit: null })
  assert.ok(!readFileSync(`${w.repo}/.claude/agents/one.md`, 'utf8').includes('model: opus'))
  const rep = install(w, '--replace')
  assert.equal(rep.status, 0, rep.stdout + rep.stderr)
  assert.deepEqual(rep.json.installed, ['one'])
  assert.match(rep.json.commit, /^[0-9a-f]{40}$/)
  assert.ok(readFileSync(`${w.repo}/.claude/agents/one.md`, 'utf8').includes('model: opus'))
})
